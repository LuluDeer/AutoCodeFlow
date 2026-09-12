# 核心域 ER 详解（task 域四表）

> 所属: docs/atlas/03-data · 最后核对: 2026-09-13 · 对应代码: apps/admin-api/src/modules/task/entities/

核心执行链路由四张表承载：`tasks`（任务定义）→ `task_executions`（执行实例）→ `execution_log_lines`（日志明细，按日分区）；`task_versions` 挂在任务定义侧提供快照回滚。实体逐篇见 [task](entities/task.md) / [task-execution](entities/task-execution.md) / [task-version](entities/task-version.md) / [execution-log-line](entities/execution-log-line.md)。

## 关系图

```
                    ┌────────────────────┐
                    │  projects / users  │  (projectId FK SET NULL; ownerUserId 无 FK)
                    └─────────┬──────────┘
                              │
┌──────────────┐  projectId   │  applicationId (ManyToOne SET NULL, 无 DB FK 保障*)
│ applications │──────────────┼───────────────────────────┐
└──────────────┘              ▼                           │
                    ┌───────────────────┐                  │
                    │       tasks       │◄─────────────────┘
                    │  PK id (uuid)     │
                    │  status/trigger/… │
                    └───┬───────────┬───┘
        1               │           │              1
        │ FK CASCADE    │ currentVersion(字符串弱引用)│  无 FK，仅索引
        │ (1717473142679│                          │
        ▼               ▼                          ▼
┌──────────────────┐  ┌──────────────────┐  ┌──────────────────────────┐
│  task_executions │  │  task_versions   │  │      task_versions       │
│  PK id (uuid)    │  │  PK id (uuid)    │  │  idx (taskId, version)   │
│  taskId FK→tasks │  │  taskId 无 FK    │  │  snapshot jsonb 不可变   │
│  status 7 态     │  └──────────────────┘  └──────────────────────────┘
│  @Version 乐观锁 │
└────┬─────────────┘
     │ executionId (字符串, 无 FK)
     │ 1..N
     ▼
┌─────────────────────────────┐
│    execution_log_lines      │  PARTITION BY RANGE (createdAt)  ← 迁移 1789900000002
│    PK (id, createdAt) 联合  │  每日分区预建 today-1..+7
│    无 FK；logStorage='db'   │  's3' 时不写行（logObjectKey 指针）
└─────────────────────────────┘
```

\* `tasks.applicationId` 的 `@ManyToOne` 装饰器声明 `onDelete: SET NULL`，但 InitialSchema 未建 FK、后续迁移也未补——DB 层实际无该外键，关联由应用层维护。同理 `task_versions.taskId` 无 FK。

## 关键外键（全 task 域 DB 级 FK 仅 1 个）

| 外键 | 表.列 → 目标 | 行为 | 出处 |
|---|---|---|---|
| `FK_task_executions_taskId` | `task_executions.taskId` → `tasks.id` | **ON DELETE CASCADE** | 迁移 `1717473142679-TaskExecutionForeignKey.ts`（同迁移把 taskId 从 varchar 改 uuid） |
| `tasks.projectId` | → `projects.id` | ON DELETE SET NULL | 迁移 `1790000000008-AddTaskProjectId.ts`（AUTH-01） |

> ⚠️ `task-executions` 实体装饰器写 `onDelete: "SET NULL"`，与迁移 CASCADE 不一致；`synchronize` 恒关闭，DB 实际行为以迁移为准（任务物理删除 → 执行记录级联删除）。

## 关键索引（按读取路径）

| 读取场景 | 走的索引 | 所在表 |
|---|---|---|
| 任务列表按状态/应用/时间过滤 | `status`、`applicationId`、`createdAt`、`idx_tasks_deleted_at` | `tasks` |
| 执行详情/任务执行历史 | `taskId`、`(taskId, status)`、`createdAt` | `task_executions` |
| 执行器维度统计 | `idx_task_executions_executor_address_status (executorAddress, status)` | `task_executions` |
| stale 扫描在途行 | `idx_task_executions_running (executorAddress, startTime) WHERE status='running'` 部分索引 | `task_executions` |
| 日志分页 | `(executionId, lineNumber)` | `execution_log_lines` |
| 日志按级别过滤 | `(executionId, level, lineNumber)` | `execution_log_lines` |
| 日志保留期清理 | `(createdAt)`（分区 DETACH 主路径） | `execution_log_lines` |
| 版本列表 | `idx_task_versions_taskId_version (taskId, version)`（非唯一） | `task_versions` |

## 数据流转（生命周期视角）

```
创建任务 ──► tasks (+ task_versions 快照, currentVersion 指针)
   │ trigger: 手动(TaskService.trigger, triggerType='manual')
   │         计划(SchedulerService cron/fixed_rate) / API
   ▼
task_executions 落 PENDING 行 ──► BullMQ 入队('execute', attempts=maxRetry, priority 归一化)
   │ TaskProcessor 认领 ──► 派发(选执行器: group/tags/runtime→亲和→loadScore)
   ▼
RUNNING ──► 回调上报: 日志行→execution_log_lines(或 S3), 终态→status+result/artifacts/exitCode
   │        失败→retryableErrors 白名单判定重试(新 execution) / 终态 FAILED+failureReason
   ▼
终态 ──► execution_reports 按日聚合 / 告警路由(runbook/alarmChannels)
```

详细时序见 [任务生命周期](../04-flows/task-lifecycle.md)、[回调上报](../04-flows/execution-callback.md)。

## 易踩的坑

1. **priority 双形态**：DB 存 PG label 字符串（`normal`），TS 是数字枚举（1-4）；写库靠列 transformer、BullMQ 入队靠 `normalizeTaskPriority`（见 [task](entities/task.md)）。
2. **物理删除 tasks**：因 CASCADE 会连带删光执行历史；业务上删除任务实际走 `status='deleted'` + 软删列，物理删除慎用。
3. **execution_log_lines 是分区表**：加唯一约束必须含 `createdAt`；原生 SQL 注意分区裁剪条件。
4. **终态写保护**：`task_executions` 仅 `pending`/`running` 可写，跨服务用条件 UPDATE 实现，别用无守卫 save。
