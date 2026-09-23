# Executor 实体（executors 表）— 执行器注册表

> 所属: docs/atlas/03-data · 最后核对: 2026-09-23 · 对应代码: apps/admin-api/src/modules/executor/entities/executor.entity.ts

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
| `runningTaskCount` | int，default 0 | **已占槽位**数（心跳维护）——含 E-01 取件预留。派发闸门（`selectLeastLoaded` / 容量守卫）只读它 |
| `cpuUsage` / `memUsage` / `diskUsage` / `networkLatency` | float nullable | 心跳上报的性能指标 |
| `totalTaskCount` / `failedTaskCount` | int，default 0 | 累计执行/失败计数 |
| `maxConcurrentTasks` | int nullable | 并发上限（NULL=不限） |
| `runningExecutionIds` | jsonb nullable | CONSISTENCY-02：心跳上报的**在跑执行** executionId 列表（≤10000）；语义：NULL=旧版执行器未上报，`[]`=上报且空闲；stale 扫描据此避免误杀（迁移 `1788700000000`）。注意与 `runningTaskCount` 来自**两个不同账本**，空闲 pull 执行器稳态为「计数 1 + 本列 `[]`」 |
| `reservedSlots` | int nullable | E-01-RPT：心跳上报的 pull 长轮询**预留槽位数**。E-01 让 pull 循环在长轮询前先原子预留槽位并计入同一并发账本，故 `runningTaskCount` 含它而 `runningExecutionIds` 不含；详情页据此显示「实际运行 = `runningTaskCount` − `reservedSlots`」。语义：NULL=旧版执行器未上报（回落旧口径），`0`=已上报且无预留；采纳域非负整数且必须 `≤ runningTaskCount`（子集约束，越界拒绝采纳）。**派发闸门绝不读本列**（迁移 `1790000000039`） |
| `deadLetterCount` | int nullable | U16：执行器回调死信积压数（0..100000 白名单采纳，非法/缺失不改 DB）（迁移 `1788900000000`） |
| `tokenHash` | varchar nullable，`select: false` | SEC-03：per-executor token 的 bcrypt hash，经 `POST /api/executors/:id/rotate-token` 轮换（迁移 `1717473142682`） |
| `groupName` | varchar nullable | 逻辑分组（任务 `executorGroup` 的匹配对象） |
| `tags` | simple-array nullable | 路由标签（任务 `executorTags` AND 子集 / 亲和反亲和） |
| `description` | text nullable | 描述 |
| `deviceFingerprint` | varchar(64) nullable | ARCH-36（ADR-017 阶段 2）：稳定设备唯一身份 `sha256(deviceId + ":" + installSalt)`（64 位小写十六进制），执行器经 register/heartbeat 上报。**只采集与观测，不参与任何定位**（注册仍按 `address` 定位行）。NULL = 未上报（存量旧执行器，或协议 v3 却采集失败——两者用 `protocolVersion` 区分）；字段缺省或形态非法一律**保留 DB 旧值**（不得把已存历史擦成 NULL）。采集组成见 [ADR-017](../../../adr/adr-017-executor-unique-identity.md)（迁移 `1790000000038`） |
| `projectId` | uuid nullable | AUTH-01：归属项目；迁移 `1790000000009` 加列 + FK ON DELETE SET NULL + 索引；存量不回填 |
| `createdAt` / `updatedAt` | timestamptz | 自动维护 |
| `version` | int | `@VersionColumn` 乐观锁（R-P0-006，防派发竞态） |

## 索引与约束

| 索引/约束 | 定义处 | 说明 |
|---|---|---|
| `uq_executors_address` | 实体 `@Index(…, ["address"], { unique: true })` | 地址唯一（重复注册走更新） |
| `status` / `groupName` / `lastHeartbeat` | 实体 `@Index` | 调度过滤三件套 |
| `projectId` FK `ON DELETE SET NULL` + 索引 | 迁移 `1790000000009` | AUTH-01 |
| `idx_executors_device_fingerprint` | 实体 `@Index("idx_executors_device_fingerprint", ["deviceFingerprint"])` | ARCH-36：**故意非唯一**——阶段 2 只按指纹做冲突/漂移观测（「同址多指纹」= 硬冲突），唯一性约束留 ADR-017 阶段 3 回填 `legacy:${address}` 后单独加 |

## 关系

- **引用**：`projects`（FK SET NULL）。
- **被引用（均为弱引用/无 FK，按 address 或 id 字符串关联）**：[tasks](task.md).`executorId`（pinning，故意无 FK）；`task_executions.executorAddress`（执行记录）；[executor_metrics_history](executor-metrics-history.md).`executorAddress`；[executor_packages](executor-package.md).`pushHistory[].executorId`（jsonb 内）。

## 生命周期与写入方

- **创建/更新**：`ExecutorService`——注册（upsert by address）、心跳（status/指标/runningTaskCount/runningExecutionIds/deadLetterCount 全量刷新）、token 轮换。ARCH-36 起 register/heartbeat 还双向写入 `deviceFingerprint`（三态采纳：缺省/非法不动 DB），并在写入**之前**做冲突/漂移观测（`executor-fingerprint.util.ts`）——观测必须在 DB 写入前，否则「本次上报是否新增了一个指纹」这个事件会被自己的写入掩盖。
- **状态维护**：`ExecutorService` 离线 sweep（心跳超时置 offline）；执行器进程重启经 `executorStartupId` 识别。
- **读取**：调度派发（group/tags/runtime 过滤 → 亲和/反亲和 → loadScore 择优，CORE-05 的 `estimatedDurationSec` 参与加权）、stale 扫描、admin-web 执行器页。

## 常见改动场景

1. **加心跳字段**：实体 + 迁移（幂等模板 `1788900000000-AddExecutorDeadLetterCount.ts`）+ 心跳回调 DTO 的白名单采纳逻辑（非法值不改 DB，与 `maxConcurrentTasks` 同模式）。
2. **改调度路由**：过滤/评分逻辑在 `ExecutorService`，注意与 [tasks](task.md) 的 group/tags/亲和字段语义配对。
3. **执行器侧契约**：心跳/注册 payload 见 [executor-contract](../../01-apps/executor-contract.md) 与 [executor-registration 流程](../../04-flows/executor-registration.md)。
