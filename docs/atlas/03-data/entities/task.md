# Task 实体（tasks 表）— 任务定义

> 所属: docs/atlas/03-data · 最后核对: 2026-09-13 · 对应代码: apps/admin-api/src/modules/task/entities/task.entity.ts

## 所属模块与源文件

- 模块：[task 模块](../../01-apps/admin-api/modules/task.md)（`apps/admin-api/src/modules/task/`）
- 源文件：`apps/admin-api/src/modules/task/entities/task.entity.ts`
- 同目录兄弟实体：[task-execution](task-execution.md)、[task-version](task-version.md)、[execution-log-line](execution-log-line.md)

## 表名

`tasks`（`@Entity("tasks")`）

## 字段表

主键 `id: uuid`（`@PrimaryGeneratedColumn("uuid")`）。以下按源码顺序列关键字段（列名经 TypeORM 默认命名策略为驼峰原样）：

| 列名 | 类型 | 说明 |
|---|---|---|
| `name` | varchar NOT NULL | 任务名 |
| `description` | varchar nullable | 描述 |
| `status` | PG enum `TaskStatus`，default `active` | 值域 `active` / `paused` / `deleted`（逻辑删除标记，与软删列并存） |
| `triggerType` | PG enum `TaskTriggerType` | `cron` / `fixed_rate` / `api` / `manual` |
| `cronExpression` / `timezone` / `fixedRate` | varchar / varchar / int，均可空 | 计划触发参数；cron 任务必填前两者，fixed_rate 任务填 `fixedRate` |
| `runtime` | PG enum `TaskRuntime`，default `python` | `python` / `node` / `shell` |
| `runtimeVersion` | varchar nullable | 运行时版本 |
| `dependencies` | jsonb nullable `Record<string,string>` | 依赖清单 |
| `entrypoint` | varchar nullable | 打包任务的入口文件 |
| `requirements` | jsonb nullable `string[]` | W-21：执行器运行前安装的依赖 spec（python 走 `uv pip install`、node 走 npm）；随派发 payload 原样下发 |
| `gitRepo` / `gitBranch` / `gitCommit` | varchar nullable | Git 源信息 |
| `currentVersion` | varchar nullable | 当前指向的 [task_versions](task-version.md) 版本号 |
| `timeout` | int，default 0 | 超时秒数（0=不限） |
| `maxRetry` | int，default 3 | 重试预算 |
| `retryDelay` | int，default 0 | 重试延迟秒数（BullMQ 指数退避基座） |
| `retryableErrors` | simple-array nullable | RETRY-01：可重试失败白名单（对 errorMessage/failureReason 做大小写不敏感子串匹配）；空/NULL=全部重试；`timeout` 永不重试 |
| `blockStrategy` | PG enum，default `serial` | `serial` / `discard` / `cover_early`（调度重叠策略） |
| `misfireStrategy` | PG enum，default `ignore` | `ignore` / `fire_once` |
| `priority` | PG enum `task_priority_enum`（label: low/normal/high/critical），default `normal`，**带列级 transformer** | 见下方"priority 双形态"说明 |
| `executeMode` | PG enum，default `single` | `single` / `broadcast`；与 `executorId` pinning 互斥（service 层校验） |
| `lastTriggerTime` | timestamptz nullable | 最近触发时间（SchedulerService 更新） |
| `alarmEmail` / `alarmChannels` | varchar / simple-array，可空 | 告警路由 |
| `params` | jsonb nullable | 普通运行参数（与 `secrets` 分离） |
| `executorAppName` | varchar nullable | 派发目标应用名（旧字段） |
| `applicationId` | varchar nullable | 弱引用 [applications](../../01-apps/admin-api/modules/application.md)，`@ManyToOne` `onDelete: SET NULL` |
| `projectId` | uuid nullable | AUTH-01：归属项目，FK → `projects.id` ON DELETE SET NULL；NULL=未分配，视图归默认项目（迁移 `1790000000008`） |
| `ownerUserId` | int nullable | NF-03：创建者用户 id，**故意不加 FK**（用户删除保留悬垂 id，守卫按"≠本人"处理） |
| `secrets` | jsonb nullable | SEC-02：任务级 secrets；配置 `SEC_SECRETS_KEY` 后叶子值为 `enc:v1:<iv>:<tag>:<ciphertext>`（AES-256-GCM），未配置降级明文；API 响应脱敏，派发时解密注入执行器 env，不落 TaskExecution.params |
| `executorGroup` | varchar nullable | 执行器分组过滤 |
| `executorTags` | simple-array nullable | AND 子集语义的硬性能力要求 |
| `executorAffinityTags` / `executorAntiAffinityTags` | simple-array nullable | NF-04：亲和（OR 语义软路由）/ 反亲和（排除）标签 |
| `executorId` | varchar nullable | R6 pinning：指定唯一目标执行器，**故意不加 FK**（执行器可硬删，pin 不阻塞） |
| `glueSource` / `glueLanguage` | text / varchar，可空 | GLUE 模式内联脚本及语言（python/javascript/shell） |
| `maintenanceWindows` | jsonb nullable | FEAT-06：维护窗口数组 `[{start, end, description?}]`（5 字段 cron，半开区间），计划触发命中即跳过（迁移 `1789200000000`） |
| `runbook` | text nullable | FEAT-11：markdown 运行手册（迁移 `1789400000000`） |
| `timeoutAction` | varchar nullable | CORE-04：`kill`（缺省）/ `kill_retry` / `notify_only`，逻辑在 `task/timeout-policy.util.ts` |
| `timeoutWarnRatio` | int nullable | CORE-04：超时预警阈值（timeout 的百分数 0-90），每次执行至多预警一次 |
| `estimatedDurationSec` | int nullable | CORE-05：预估时长（秒），仅参与调度负载评分加权 |
| `createdAt` / `updatedAt` | timestamptz | 自动维护 |
| `deletedAt` | timestamptz nullable | DB-001：TypeORM 软删除列（`@DeleteDateColumn`），与 `status='deleted'` 并存；原生 SQL/QueryBuilder 需自行过滤 |

**priority 双形态（N2 / CORE-01）**：DB 列是 PG 字符串枚举（label `low/normal/high/critical`），TS 侧 `TaskPriority` 是数字枚举（1-4）。列级 transformer 在写路径把数字转小写 label（`to`），读路径透传 label 字符串；`normalizeTaskPriority()` 在 BullMQ 入队边界把任意形态归一化为数字（BullMQ 只接受整数 priority，字符串会 100% 入队失败）。

## 索引与约束

来自实体装饰器 + 迁移：

| 索引/约束 | 定义处 | 说明 |
|---|---|---|
| `IDX_…` on `status` | 实体 `@Index(["status"])` | 状态过滤 |
| `IDX_…` on `applicationId` | 实体 `@Index(["applicationId"])` | 按应用查任务 |
| `IDX_…` on `createdAt` | 实体 `@Index(["createdAt"])` | 排序/范围 |
| `idx_tasks_deleted_at` | 实体 `@Index("idx_tasks_deleted_at", …)` | 软删列 |
| `projectId` 索引 + FK `ON DELETE SET NULL` | 迁移 `1790000000008-AddTaskProjectId.ts` | AUTH-01 |
| PG 枚举类型 | 迁移建 `task_priority_enum` 等 | priority 写入只接受 label 字符串 |

## 关系

- **被引用**：[task_executions](task-execution.md).`taskId` → `tasks.id`，DB 实际约束为 FK `FK_task_executions_taskId` **ON DELETE CASCADE**（迁移 `1717473142679`，注意实体装饰器写的是 `SET NULL`，以迁移为准）；[task_versions](task-version.md).`taskId` 仅字符串引用（无 FK）。
- **引用**：`projects`（FK SET NULL）、`applications`（`@ManyToOne` SET NULL，字符串引用避免循环导入）。

## 生命周期与写入方

- **创建/更新**：`TaskService.create/update`（[task 模块](../../01-apps/admin-api/modules/task.md)）；软删除走 `status='deleted'` + `deletedAt`。
- **更新**：`SchedulerService` 计划触发后写 `lastTriggerTime`；`TaskService.assertCanWrite` 做 NF-03 归属守卫。
- **只读消费方**：`SchedulerService`（cron 扫描/入队）、`TaskProcessor`（派发 payload）、`ExecutorService`（执行器选择：group/tags/runtime → affinity → loadScore）、MCP/SDK 触发面。

## 常见改动场景

给 tasks 加一个字段（以 `runbook` 为例）：

1. `task.entity.ts` 加 `@Column({ type: "text", nullable: true })` 字段（PG enum 列记得配 transformer）。
2. 新增迁移 `apps/admin-api/src/migrations/<13位时间戳>-AddTaskXxx.ts`（参考 `1789400000000-AddTaskRunbook.ts`，幂等 `ADD COLUMN IF NOT EXISTS`；timestamp 不得重复，见 [migrations.md](../migrations.md)）。
3. `CreateTaskDto` / `UpdateTaskDto`（`apps/admin-api/src/modules/task/dto/`）加字段与 class-validator 校验 + Swagger 注解。
4. 若参与派发，检查 `ExecutorService.dispatch` payload 与执行器契约（[executor-contract](../../01-apps/executor-contract.md)）。
5. 回归：`npm run test` / `test:e2e`（apps/admin-api 下），并更新本文档"最后核对"日期。

相关流程：[任务生命周期](../../04-flows/task-lifecycle.md)、[执行器注册](../../04-flows/executor-registration.md)。
