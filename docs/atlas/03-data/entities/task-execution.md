# TaskExecution 实体（task_executions 表）— 执行实例

> 所属: docs/atlas/03-data · 最后核对: 2026-09-14 · 对应代码: apps/admin-api/src/modules/task/entities/task-execution.entity.ts

## 所属模块与源文件

- 模块：[task 模块](../../01-apps/admin-api/modules/task.md)（`apps/admin-api/src/modules/task/`）
- 源文件：`apps/admin-api/src/modules/task/entities/task-execution.entity.ts`
- 枚举/接口同文件导出：`ExecutionStatus`、`ExecutionFailureReason`、`ExecutionArtifact`

## 表名

`task_executions`（`@Entity("task_executions")`）

## 字段表

主键 `id: uuid`。关键字段：

| 列名 | 类型 | 说明 |
|---|---|---|
| `taskId` | uuid NOT NULL | FK → `tasks.id`（见"索引与约束"），任务删除时级联 |
| `taskName` | varchar NOT NULL | 冗余快照（任务改名/删除后执行记录仍可读） |
| `status` | PG enum `ExecutionStatus`，default `pending` | **值域 7 个**：`pending` / `running` / `success` / `failed` / `timeout` / `killed` / `cancelled`；`cancelled` 的 PG enum 值已由迁移 `1790000000020` 补齐（PK-01——InitialSchema 缺值，此前迁移构建库上写 `cancelled` 即 22P02，如 `cover_early` 重叠取消路径） |
| `executorAddress` | varchar nullable | 承接执行的执行器地址（按 address 关联，非 FK） |
| `logs` | text nullable | 旧版整段日志（日志分表后仅小体量/回填场景使用） |
| `logStorage` | varchar nullable，default `'db'` | 日志明细存放位置：`'db'`（[execution_log_lines](execution-log-line.md)）或 `'s3'` |
| `logObjectKey` | varchar nullable | `logStorage='s3'` 时的 gzip 对象 key；过期终态执行由 `S3LogObjectRetentionService` 每日 03:35 回收对象后守卫清空本指针（`WHERE id AND logObjectKey`） |
| `result` | jsonb nullable | 执行结果负载 |
| `params` | jsonb nullable | 本次执行的参数快照（task.params + 触发覆盖；secrets 不落库） |
| `startTime` / `endTime` | timestamptz nullable | 起止时间 |
| `duration` | int nullable | 执行时长 |
| `retryCount` | int，default 0 | 已重试次数 |
| `errorMessage` | varchar nullable | 失败信息（重试白名单匹配的输入之一） |
| `failureReason` | varchar nullable | 失败分类，值域 `ExecutionFailureReason`：`package_fetch_failed` / `script_error` / `timeout` / `executor_offline` / `executor_restart` / `stale_recovered` / `dependency_install_failed` / `git_fetch_failed` / `runtime_missing` / `killed` / `unknown` |
| `exitCode` | int nullable | 执行器回调上报的原始进程退出码（迁移 `1788800000000`） |
| `aiAnalysis` | text nullable | AI 失败分析（`TaskService.analyzeExecution` 落库） |
| `artifacts` | jsonb nullable | FEAT-05 产物清单 `[{name, size, sha256}]`，文件字节另行上传 MinIO/S3（迁移 `1789600000000`） |
| `triggerType` | varchar nullable | 触发来源（`manual` / cron 等） |
| `taskVersion` | varchar nullable | 触发时的任务版本号 |
| `traceId` | varchar nullable | OBS-01：W3C trace-id（32 hex），入队侧生成（迁移 `1789900000003`） |
| `createdAt` | timestamptz | `@CreateDateColumn` |
| `version` | int | `@VersionColumn` 乐观锁（R-P0-007，防并发更新竞态） |

注意：`failureReason` 在 DB 是 varchar（非 PG enum），值域由 TS 枚举约束；`taskId` 在 InitialSchema 是 varchar，迁移 `1717473142679` 改为 uuid。

## 索引与约束

| 索引/约束 | 定义 | 说明 |
|---|---|---|
| `taskId` | 实体 `@Index(["taskId"])` | 按任务查执行 |
| `status` | 实体 `@Index(["status"])` | 状态过滤 |
| `(taskId, status)` | 实体复合 `@Index` | 任务详情页过滤 |
| `createdAt` | 实体 `@Index(["createdAt"])` | 排序/日报聚合 |
| `idx_task_executions_executor_address_status` | `(executorAddress, status)` | 执行器维度统计 |
| `idx_task_executions_running` | `(executorAddress, startTime)` **部分索引** `WHERE "status" = 'running'` | 在途执行快速定位 |
| FK `FK_task_executions_taskId` | 迁移 `1717473142679-TaskExecutionForeignKey.ts`：`taskId` → `tasks.id` **ON DELETE CASCADE**（附带 taskId 列 varchar→uuid 转换与 `IDX_task_executions_taskId` 索引） | 防孤儿执行记录 |

> ⚠️ 实体装饰器 `@ManyToOne("Task", …, { onDelete: "SET NULL" })` 与迁移的 CASCADE 不一致——TypeORM `synchronize` 恒为 false（见 [migrations.md](../migrations.md)），DB 实际行为以迁移为准：任务物理删除时执行记录**级联删除**。

## 关系

- **引用**：`tasks`（FK CASCADE，唯一 DB 级 FK）。
- **被引用**：[execution_log_lines](execution-log-line.md).`executionId`（字符串引用，无 FK）；`artifacts` 文件对象在 MinIO 侧按 `<execId>/` 目录归档（[artifacts 模块](../../01-apps/admin-api/modules/artifacts.md)）。

## 生命周期与写入方

状态机：`pending → running → success/failed/timeout/killed/cancelled`（终态写保护，可写集合仅 `pending`/`running`）。

- **创建（status=pending）**：
  - `TaskService.trigger`（手动/API 触发，事务内 create + 入队，入队失败补偿置 FAILED）；
  - `SchedulerService`（cron/fixed_rate 计划触发，含 `cover_early` 取消旧在途行）；
  - `ExecutorService` 派发失败重试时 `execRepo.create` 新行。
- **更新**：`TaskProcessor`（认领/派发/重试/超时判定）、`ExecutorService`/`TaskService` 回调处理（终态/日志/产物）、`SchedulerService` stale sweep（RUNNING 超阈与 PENDING 未派发的条件 UPDATE 恢复，写 `stale_recovered`/`unknown`）、`TaskService.analyzeExecution`（aiAnalysis）。
- **只读消费方**：[metrics 模块](../../01-apps/admin-api/modules/metrics.md)（[execution_reports](execution-report.md) 聚合）、admin-web 执行详情页。

## 常见改动场景

1. **加字段**：实体 + 迁移（参考幂等模板 `1788800000000-AddExecutionExitCode.ts`：`ADD COLUMN IF NOT EXISTS` / `DROP COLUMN IF EXISTS`）+ 回调 DTO（executor 契约侧同步，[executor-contract](../../01-apps/executor-contract.md)）。
2. **加失败分类**：`ExecutionFailureReason` 枚举加值即可（varchar 列，无需迁移），同步失败分类工具与前端映射。
3. **改状态机**：终态写保护在 `TaskProcessor`/`SchedulerService` 的条件 UPDATE 中硬编码，需同步修改并跑 e2e。
4. 相关流程：[任务生命周期](../../04-flows/task-lifecycle.md)、[回调上报](../../04-flows/execution-callback.md)。
