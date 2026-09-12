# Executor 实体（executors 表）— 执行器注册表

> 所属: docs/atlas/03-data · 最后核对: 2026-09-13 · 对应代码: apps/admin-api/src/modules/executor/entities/executor.entity.ts

## 所属模块与源文件

- 模块：[executor 模块](../../01-apps/admin-api/modules/executor.md)（`apps/admin-api/src/modules/executor/`）
- 源文件：`apps/admin-api/src/modules/executor/entities/executor.entity.ts`
- 兄弟实体：[executor-metrics-history](executor-metrics-history.md)

## 表名

`executors`（`@Entity("executors")`）

## 字段表

主键 `id: uuid`。关键字段：

| 列名 | 类型 | 说明 |
|---|---|---|
| `appName` | varchar NOT NULL | 执行器应用名（派发路由的传统键） |
| `address` | varchar NOT NULL，**UNIQUE** | 执行器地址（host:port），全库唯一 |
| `status` | PG enum `ExecutorStatus`，default `offline` | `online` / `offline` |
| `type` | PG enum `ExecutorType`，default `python` | `python` / `node` / `universal` |
| `executorVersion` | varchar nullable | 执行器版本（列经迁移 `1788274394054-RenameExecutorVersionColumn.ts` 重命名而来） |
| `capabilities` | simple-array nullable | 能力标签 |
| `lastHeartbeat` | timestamptz nullable | 最近心跳（离线判定依据） |
| `executorStartedAt` / `executorStartupId` | timestamptz / varchar，可空 | 启动追踪（迁移 `1717473142689`，用于重启识别） |
| `runningTaskCount` | int，default 0 | 在途任务数（心跳维护） |
| `cpuUsage` / `memUsage` / `diskUsage` / `networkLatency` | float nullable | 心跳上报的性能指标 |
| `totalTaskCount` / `failedTaskCount` | int，default 0 | 累计执行/失败计数 |
| `maxConcurrentTasks` | int nullable | 并发上限（NULL=不限） |
| `runningExecutionIds` | jsonb nullable | CONSISTENCY-02：心跳上报的在途 executionId 列表（≤200）；语义：NULL=旧版执行器未上报，`[]`=上报且空闲；stale 扫描据此避免误杀（迁移 `1788700000000`） |
| `deadLetterCount` | int nullable | U16：执行器回调死信积压数（0..100000 白名单采纳，非法/缺失不改 DB）（迁移 `1788900000000`） |
| `tokenHash` | varchar nullable，`select: false` | SEC-03：per-executor token 的 bcrypt hash，经 `POST /api/executors/:id/rotate-token` 轮换（迁移 `1717473142682`） |
| `groupName` | varchar nullable | 逻辑分组（任务 `executorGroup` 的匹配对象） |
| `tags` | simple-array nullable | 路由标签（任务 `executorTags` AND 子集 / 亲和反亲和） |
| `description` | text nullable | 描述 |
| `projectId` | uuid nullable | AUTH-01：归属项目；迁移 `1790000000009` 加列 + FK ON DELETE SET NULL + 索引；存量不回填 |
| `createdAt` / `updatedAt` | timestamptz | 自动维护 |
| `version` | int | `@VersionColumn` 乐观锁（R-P0-006，防派发竞态） |

## 索引与约束

| 索引/约束 | 定义处 | 说明 |
|---|---|---|
| `uq_executors_address` | 实体 `@Index(…, ["address"], { unique: true })` | 地址唯一（重复注册走更新） |
| `status` / `groupName` / `lastHeartbeat` | 实体 `@Index` | 调度过滤三件套 |
| `projectId` FK `ON DELETE SET NULL` + 索引 | 迁移 `1790000000009` | AUTH-01 |

## 关系

- **引用**：`projects`（FK SET NULL）。
- **被引用（均为弱引用/无 FK，按 address 或 id 字符串关联）**：[tasks](task.md).`executorId`（pinning，故意无 FK）；`task_executions.executorAddress`（执行记录）；[executor_metrics_history](executor-metrics-history.md).`executorAddress`；[executor_packages](executor-package.md).`pushHistory[].executorId`（jsonb 内）。

## 生命周期与写入方

- **创建/更新**：`ExecutorService`——注册（upsert by address）、心跳（status/指标/runningTaskCount/runningExecutionIds/deadLetterCount 全量刷新）、token 轮换。
- **状态维护**：`ExecutorService` 离线 sweep（心跳超时置 offline）；执行器进程重启经 `executorStartupId` 识别。
- **读取**：调度派发（group/tags/runtime 过滤 → 亲和/反亲和 → loadScore 择优，CORE-05 的 `estimatedDurationSec` 参与加权）、stale 扫描、admin-web 执行器页。

## 常见改动场景

1. **加心跳字段**：实体 + 迁移（幂等模板 `1788900000000-AddExecutorDeadLetterCount.ts`）+ 心跳回调 DTO 的白名单采纳逻辑（非法值不改 DB，与 `maxConcurrentTasks` 同模式）。
2. **改调度路由**：过滤/评分逻辑在 `ExecutorService`，注意与 [tasks](task.md) 的 group/tags/亲和字段语义配对。
3. **执行器侧契约**：心跳/注册 payload 见 [executor-contract](../../01-apps/executor-contract.md) 与 [executor-registration 流程](../../04-flows/executor-registration.md)。
