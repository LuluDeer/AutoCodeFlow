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
| `deviceFingerprint` | varchar(80) NOT NULL（迁移 `1790000000054` 前为 varchar(64) 可空） | **ADR-017 阶段 2/3：注册/心跳定位键** `sha256(deviceId + ":" + installSalt)`（64 位小写十六进制），执行器经 register/heartbeat 上报。阶段 3 起 register/heartbeat **先按本列定位行**、命中即复用并更新 `address`（换 IP = 同机换地址，不产生幽灵行）；未上报指纹的存量执行器由中台落 **legacy 兜底键**（`legacy:{address}`，超长退化为 `legacy-h:` + sha256，`legacyExecutorIdentity`）——legacy 行仍按 `address` 定位，行为与引入前逐字节一致。同地址不同指纹按派发模式分叉（push 409 / pull 各自成行）。字段缺省/非法 → 保留 DB 旧值（阶段 2 三态纪律的残留，见下）。采集组成见 [ADR-017](../../../adr/adr-017-executor-unique-identity.md)（迁移 `1790000000038` 加列、`1790000000054` 提升为定位键） |
| `projectId` | uuid nullable | AUTH-01：归属项目；迁移 `1790000000009` 加列 + FK ON DELETE SET NULL + 索引；存量不回填 |
| `createdAt` / `updatedAt` | timestamptz | 自动维护 |
| `version` | int | `@VersionColumn` 乐观锁（R-P0-006，防派发竞态） |

## 索引与约束

| 索引/约束 | 定义处 | 说明 |
|---|---|---|
| `uq_executors_address` | 实体 `@Index(…, ["address"], { unique: true, where: … })` | **ADR-017 阶段 3 起为 partial 唯一**：仅约束 push 模式行（`WHERE "dispatchMode" = 'push'`）。push 的 `address` 是路由面必须唯一（冲突 409 处置）；pull 零入站、`address` 只是自报标签，**允许同地址各自成行**（两家不同内网同网段同 IP 的常态，ADR-017 §5）。迁移 `1790000000054` 由全局唯一收窄 |
| `status` / `groupName` / `lastHeartbeat` | 实体 `@Index` | 调度过滤三件套 |
| `projectId` FK `ON DELETE SET NULL` + 索引 | 迁移 `1790000000009` | AUTH-01 |
| `idx_executors_device_fingerprint` | 实体 `@Index("idx_executors_device_fingerprint", ["deviceFingerprint"])` | **刻意非唯一**：阶段 2 存量行全 NULL、过渡期允许「同一安装短时间内出现两行」；阶段 3 后 register 的按指纹定位在稳态保证一行一指纹，唯一索引留待机队全部上报指纹后单独加（ADR-017「相关轨道」） |

## 关系

- **引用**：`projects`（FK SET NULL）。
- **被引用（均为弱引用/无 FK，按 address 或 id 字符串关联）**：[tasks](task.md).`executorId`（pinning，故意无 FK）；`task_executions.executorAddress`（执行记录）；[executor_metrics_history](executor-metrics-history.md).`executorAddress`；[executor_packages](executor-package.md).`pushHistory[].executorId`（jsonb 内）。

## 生命周期与写入方

- **创建/更新**：`ExecutorService`——注册（**ADR-017 阶段 3：先按 `deviceFingerprint` 定位行、address 兜底**；命中复用 + 更新 address；push 同址异指纹 409 / pull 各自成行）、心跳（status/指标/runningTaskCount/runningExecutionIds/deadLetterCount 全量刷新，同指纹定位 + 地址漂移采纳）、token 轮换。ARCH-36 起 register/heartbeat 还在写入**之前**做冲突/漂移观测（`executor-fingerprint.util.ts`）——观测必须在 DB 写入前，否则「本次上报是否新增了一个指纹」这个事件会被自己的写入掩盖。
- **状态维护**：`ExecutorService` 离线 sweep（心跳超时置 offline）；执行器进程重启经 `executorStartupId` 识别。
- **读取**：调度派发（group/tags/runtime 过滤 → 亲和/反亲和 → loadScore 择优，CORE-05 的 `estimatedDurationSec` 参与加权）、stale 扫描、admin-web 执行器页。

## 常见改动场景

1. **加心跳字段**：实体 + 迁移（幂等模板 `1788900000000-AddExecutorDeadLetterCount.ts`）+ 心跳回调 DTO 的白名单采纳逻辑（非法值不改 DB，与 `maxConcurrentTasks` 同模式）。
2. **改调度路由**：过滤/评分逻辑在 `ExecutorService`，注意与 [tasks](task.md) 的 group/tags/亲和字段语义配对。
3. **执行器侧契约**：心跳/注册 payload 见 [executor-contract](../../01-apps/executor-contract.md) 与 [executor-registration 流程](../../04-flows/executor-registration.md)。
