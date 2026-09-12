# ARCH-31：多 admin-api 实例兼容矩阵

> 状态：**部分实施（2026-09-12 本轮）**——通知静默（3.2）、渠道配置（3.3）、
> 灰度批次（3.4）三项 🔴 已改造为「DB 为共享真相 + TTL 读穿 / 条件 UPDATE claim /
> 活性租约」，等级降为 🟡（收敛窗口内仍有偏差，无写冲突）；outbox 行级 claim 仍
> pending，本地文件系统（3.5）属部署形态约束（需共享卷）。
> **真机双实例端到端验证尚未执行**，故整体仍不标 done。范围：`apps/admin-api/src`。
> 目的：盘点全部**进程内单例状态**，标注每一项在多实例（水平扩容 / 滚动重启 /
> 无会话粘滞负载均衡）下的兼容性、失效后果与风险等级，并给出 outbox / silence
> 两项的 Redis 化评估。
>
> 结论速览：调度链（Leader Election + DB claim）已多实例安全；**通知静默**、
> **渠道配置**、**灰度批次**、**本地文件系统**四类仍是单实例假设，是水平扩容的
> 主要约束。
>
> 本文保留已完成的盘点/评估事实，不代表多实例实现完成；后续按 silence、channel
> config、rollout、outbox 四项拆分实现，并逐项执行双实例验证。

---

## 1. 判定口径

| 等级 | 含义 |
| --- | --- |
| 🟢 低 | 多实例语义正确或已显式降级为「按实例聚合」，无正确性损失 |
| 🟡 中 | 多实例有可观测的偏差/重复/延迟，但有 DB 条件写或幂等兜底，不破坏数据正确性 |
| 🔴 高 | 多实例破坏功能正确性（状态不一致 / 单写者假设被打破 / 数据丢失） |

判定维度：① 状态是否跨进程共享；② 是否有 Redis/DB 兜底；③ 写入是否有原子
claim；④ 路由到任意实例是否等价。

---

## 2. 兼容矩阵（总表）

| # | 状态项 | 载体 | 跨进程共享 | 兜底 | 等级 |
| --- | --- | --- | --- | --- | --- |
| 1 | 调度定时器 `timers`/`cronTasks`/`runningTasks`/`schedulingTasks` | 进程内 Map/Set | 否 | Redis Leader + DB `claimTaskTrigger` | 🟢 低 |
| 2 | 调度 Leader 身份 `isLeader`/`leaderLock` | 进程内 + Redis 锁 | 锁共享 | fail-open + 15s 校验 | 🟢 低 |
| 3 | 通知静默 `NotificationService.silences` | 进程内 Map（热路径） | 否（DB 写穿 + **周期读穿**） | DB `notification_silences` 写穿 + 15s 读穿刷新 | 🟡 中（本轮改造） |
| 4 | 渠道配置 `ChannelConfigStore` / `NotificationConfigService.channelConfigs` | 进程内 Map | **是**（新表 `notification_channel_configs` + 15s 读穿） | env 回退 | 🟡 中（本轮改造） |
| 5 | 灰度批次 `rolloutBatches` / `rolloutTimers` | 进程内 Map/Set | 部分（行级状态 + 活性租约 + 失败 claim） | 行级 `rolloutState` + 条件 UPDATE claim + 租约 sweep | 🟡 中（本轮改造） |
| 6 | 产物/包本地磁盘 `uploads/`、artifacts root | 本地 FS | 否（除非共享卷） | 无 | 🔴 高 |
| 7 | FEAT-19 outbox 派发扫描 `OutboxDispatcher` | DB 表（共享） | 是 | DB 行状态 | 🟡 中 |
| 8 | FEAT-07 快速路径重试 `pendingTimers` | 进程内 Set | 否 | outbox 兜底 | 🟡 中 |
| 9 | 执行器令牌缓存（3 个 Map） | 进程内 Map | 否 | TTL 60s / rotate 逐实例清 | 🟡 中 |
| 10 | 无 Leader 门禁的 `@Cron`（8 个） | 各实例并行 | 否 | 条件 UPDATE / 幂等 | 🟡 中 |
| 11 | 运行时指标 `counters`/`gauges`、`SchedulerMetrics`、`ExecutionCallbackMetrics` | 进程内 / 模块级 | 否 | Prometheus per-target | 🟢 低 |
| 12 | SSE 槽位 `sseStreams*` / `MetricsStreamSlotService.activeStreams` | 进程内计数 | 否 | 按实例线性叠加（已文档化） | 🟢 低 |
| 13 | 领域事件总线 `DomainEventBus` | 进程内 EventEmitter | 否 | outbox 兜底跨进程 | 🟢 低 |
| 14 | 维护窗口解析缓存 `PARSE_CACHE` | 模块级 Map | 否 | 纯函数确定性 | 🟢 低 |
| 15 | `main.ts` `runningApp`/`shuttingDown`、`RedisLockService.client` | 进程内 | 否 | 无（本就 per-process） | 🟢 低 |

---

## 3. 逐项说明

### 3.1 🟢 调度链（已多实例安全）

**Leader Election**（`scheduler.service.ts:184-338`）：Redis 锁 `lock:scheduler:leader`，
TTL 30s，`RedisLockService` watchdog 以 TTL/3 续期，另设 TTL/2 校验定时器，
`extendLock` 失败即 demote 并清空本地全部 timer。非 Leader 节点不注册任何定时器
（`reload`/`scheduleOne`/`checkMisfires`/`recoverStaleExecutions` 均有 `isLeader` 门）。

**双保险**：跨进程去重退化为 `enqueue()` 内 Redis 触发锁（`renew:false`，TTL 即窗口）
+ DB 条件 claim `claimTaskTrigger`（`scheduler.service.ts:1046-1065`，`WHERE status=ACTIVE AND lastTriggerTime < windowStart`）——任一实例或旧 Leader 残余定时器重复触发都被第二道拦截。

**降级语义**：Redis 完全不可用时 fail-open 按 Leader 运行（保调度不停摆），此时唯一
保护是 DB claim。窗口期内可能出现旧 Leader 与新 Leader 并存的重复 tick，但 claim 兜底。
> 注：fail-open 期间**每个实例都会成为 Leader**（各自 `isLeader=true`），跨进程去重
> 完全依赖 DB claim；Redis 恢复后除首个持锁者外其余经 15s 重试 demote。

`getStats()` 暴露 `isLeader` 与 pid/hostname 供多实例区分（`/metrics/scheduler`）。

### 3.2 🔴 通知静默（主要缺口）

`NotificationService.silences`（`notification.service.ts:86`）是**同步热路径**
（`isSilenced` 在 `notify*` 各分支同步判定）。FEAT-01 引入了 DB 写穿
（`NotificationSilenceService`）与**启动回灌**（`restoreSilencesFromStore`，仅
`onModuleInit` 执行一次）。

**多实例失效路径**：
1. 静默规则经 API 打到实例 A → A 内存 Map + DB 各写一份；
2. 实例 B 的内存 Map **不含**该规则；
3. 后续告警若路由到 B，`isSilenced` 命中不到 → **告警不被静默**（B 只有在重启
   回灌时才看到该行）。

后果：静默失效（重复告警），不破坏数据正确性，但属于用户可见的功能不一致。
`addSilence` 还以进程内 `silences.size` 判 1000 上限，DB 侧另有独立上限——两侧
口径在多实例下不一致。

**本轮改造（2026-09-12，🔴→🟡）**：`onModuleInit` 之外新增**周期读穿刷新**
（`SILENCE_REFRESH_MS`，默认 15s），DB 为跨实例唯一真相，覆盖式重建内存 Map，
保留三类本地项：① 写穿在途（未拿到 DB id）；② 已落库但尚未被任一刷新读到
（覆盖主从复制延迟/读己之写窗口）；③ 本地临时键与 DB 同源行去重（内存键仍是
`addSilence` 返回给管理台的 id，DELETE 才可用）。只有「DB 确认存在过、如今
消失」才判为其他实例删除/已过期并丢弃。`removeSilence` 改按 `dbId` 删库（此前
用本地临时 id 删库必然落空，只留一条 warn）。DB 缺席或查询异常时逐字节降级回
NOTIF-003 纯内存语义。收敛窗口 ≤ 1 个刷新周期。

### 3.3 🔴 渠道配置（无持久化）

`ChannelConfigStore`（`channel-config.store.ts`）与
`NotificationConfigService.channelConfigs`（`notification-config.service.ts:75`）均为
**纯内存**，注释明确「In-memory by design for now … DB persistence is a follow-up」。
`PATCH /notification/channels/:key` 只改**接收该请求的实例**的内存；渠道发送侧
（`WebhookChannel.send` 等）按「saved config 优先、env 回退」解析，于是：

- 在 A 保存的 webhookUrl/密钥**不会**在 B 生效 → B 上的通知走 env 或直接 skipped；
- 多实例下配置面表现为「非确定性生效」，取决于请求落到哪台。

**本轮改造（2026-09-12，🔴→🟡）**：新增共享持久化表 `notification_channel_configs`
（迁移 `1790000000014`，`key` 主键 + `config` jsonb + `enabled` + `updatedAt`）。
PATCH 保存**写穿**（upsert），各实例按 `CHANNEL_CONFIG_REFRESH_MS`（默认 15s）
**读穿**并由 `NotificationConfigService.hydrateFromPersisted()` 同时刷新「读面
`channelConfigs`」与「发送面 store」两个内存面（只刷其一会出现「管理台看到旧值、
发送用新值」）。无仓储（DB 不可用/单测）时降级回纯内存语义。收敛窗口 ≤ 1 个
刷新周期；渠道配置只有管理员写，DB 行即唯一真相，无写冲突。

> 存储面说明：落库为 RAW 值（与 `system_config`、env 同姿态），脱敏只发生在
> 控制器读面（N11/N32）；本表不被任何读面端点直接透出。

### 3.4 🔴 灰度批次（单写者假设）

`AppDeploymentService.rolloutBatches`（`app-deployment.service.ts:132`）与
`rolloutTimers`（:134）是进程内批次状态；批次推进 tick（`scheduleRolloutTick`，:2028）
运行在**创建批次的实例**上，行级状态落 `rolloutState`/`rolloutMeta`。

**失效路径**：执行器心跳/确认（`notifyHeartbeatToRollout`）经负载均衡可能打到**非
属主实例**——该实例内存里没有 `batch`，无法推进 canary 确认；属主实例只能靠硬超时
（`ROLLOUT_BATCH_TIMEOUT_MS` 15min）收尾 → 灰度卡死/误判失败。`onModuleDestroy`
直接丢弃进程内批次，重启后 `onModuleInit` 把 pending/probing 行标记 failed（人工重发）。

**本轮改造（2026-09-12，🔴→🟡）**——四处：
1. **心跳侧 hydration**：`resolveRolloutBatch()` 在本实例无内存批次时，从 DB 行痕迹
   （`rolloutState IN (pending, probing)`）重建**只读上下文**，非属主实例也能把行
   推进到 probing；无批次痕迹的行不做任何额外 DB 往返（心跳是高频路径）。
2. **失败终结 claim**：`failBatch()` 先以条件 UPDATE（`WHERE rolloutState IN
   (pending, probing)`）认领在途行，只有赢家执行自动回滚，杜绝两台实例对同一批
   执行器重复回滚；未命中者只清本地批次并记 warn。
3. **并发批次互斥**：`upgradeAllWithRollout`（canary）启动前查同应用是否已有在途
   灰度行，命中则返回 `ok:false` + `blockedReason`（含持有者实例标识），不再出现
   「两实例同时对同一应用开灰度」。
4. **活性租约**：持有者每 tick 刷新行上 `rolloutMeta.leasedAt/leasedBy`；重启 sweep
   跳过租约新鲜（`ROLLOUT_LEASE_GRACE_MS` 60s）的行——**滚动重启不再把另一个实例
   正在推进的灰度直接标 failed**。探测与提升仍由持有者单点驱动（tick 补驱「心跳
   落在别处」的 probing 行），tick 另加「批次已被其他实例终结则立即收尾」的判据。

### 3.5 🔴 本地文件系统

- 执行器包：`executor-package.service.ts:38` `UPLOAD_DIR = process.cwd()/uploads/executor-packages`；
- 产物：`artifacts` 模块的 artifact root（`ArtifactsRetentionService` 扫描本地 root）；
- 产物清理 `@Cron("0 45 3 * * *")` 读本地目录。

多实例若无共享卷，A 写入的包/产物 B 读不到；跨实例下载 404。需共享卷（NFS/对象存储）
或在部署文档钉死。

### 3.6 🟡 outbox 派发（行级 claim + 租约已落地；剩快速路径收口）

> **状态校正（2026-09-12）**：本节原先描述「缺行级 claim」已不成立——claim/租约在
> 早前轮次（c01f477）已实现，本轮又补上快速路径收口。以下为**当前实际语义**。

FEAT-19 `OutboxDispatcher`（`outbox-dispatcher.service.ts`）把 outbox 落 **DB 表**，
OnModuleInit + 每 5s 扫描。claim **在数据库内完成**：单条
`WITH claimable AS (… FOR UPDATE SKIP LOCKED) UPDATE … SET leaseUntil, leaseToken`
原子选行 + 写租约——多实例各自扫描但**不会抢到同一行**；活动租约被跳过，过期租约
（`OUTBOX_LEASE_MS` 60s，且构造期断言必须大于单行最坏处理窗口）可由其它实例回收。
批次固定 1 行（`OUTBOX_BATCH_SIZE = 1`），避免批内行共享租约导致重复投递窗扩大。
终态 finalize 条件 UPDATE 带 `leaseToken`/`leaseUntil` 守卫（`affected≠1` 抛
`StaleOutboxOwnerError` 并整体回滚），死信落独立表后在**同一事务内**收口。

**快速路径收口（本轮）**：快速路径对全部匹配订阅投递成功时，用
`markFastPathDelivered(rowId)` 把兜底行直接标记已投递（条件 UPDATE，带「无活跃租约」
谓词——补投扫描已在处理这一行时不抢）。此前不收口 ⇒ **每个成功事件都必然被扫描再投
一遍**（不是"可能重复"），订阅方流量翻倍；现在重复投递仅在①部分订阅失败/死信
（那一行必须留给扫描重试，已成功的订阅会再收一次）②与扫描的租约竞态 时出现。

**残留多实例语义**：at-least-once 本身要求订阅方幂等（文档已声明）；重复度不再随
实例数线性放大（claim 排他），但**真机双实例「同一事件不重复投递」的边界验证仍
pending**（矩阵 §5 第 4 项）。

### 3.7 🟡 执行器令牌缓存（轮换延迟）

`ExecutorService` 三个正缓存（`tokenValidationCache` / `callbackSecretCache` /
`issuedTokenCache`，:63/:73/:110）均为进程内：

- `rotateToken` 只 evict **本实例**的 `callbackSecretCache`/`issuedTokenCache`
  （:1558-1559, :1670），其他实例的最长 60s 内仍以旧 hash 为 HMAC 候选 → 轮换窗口内
  旧令牌短暂仍被接受（与单实例 F-5/N26 的取舍同源，多实例放大为「部分实例仍认旧」）；
- `POST /executors/token` 的幂等复用（R9）也按实例命中：请求落到不同实例会再轮换一次
  （冷启动语义，注释已承认无害）。

### 3.8 🟡 未接 Leader 门禁的 `@Cron`

`scheduler.service.ts` 的 `reload`/`recoverStaleExecutions` 有 `isLeader` 门；下列
cron **没有**，每个实例并行执行（round4 复审已记 P2）：

| 服务 | cron | 多实例影响 | 等级 |
| --- | --- | --- | --- |
| `executor.markStaleOffline` | `*/30 * * * * *` | 条件 UPDATE `status=ONLINE` 仅一赢家；赢家 `notifyExecutorOffline` + emit `executor.offline`，故通知/事件基本不重复 | 🟡 |
| `executor.detectLostExecutions` | `0 */5 * * * *` | 条件 UPDATE `status=RUNNING` 仅一赢家，`:affected>0` 才 `releaseExecutorSlot`；并发仅增扫描负载 | 🟡 |
| `executor.cleanupOldRecords` | `0 0 2 * * *` | 单条无界 DELETE，并发抢锁（幂等）| 🟡 |
| `executor.cleanupOfflineExecutors` | `0 0 * * * *` | 幂等 DELETE | 🟢→🟡 |
| `app-deployment.detectStuckDeployments` | `0 */2 * * * *` | 并发 `save` 同一 stuck 行（幂等但非原子） | 🟡 |
| `log-retention.handleDailyCleanup` | `0 30 3 * * *` | DETACH/DROP + `CREATE … IF NOT EXISTS` 双保险；注释声明幂等 | 🟢→🟡 |
| `auth.cleanupExpiredTokens` | `EVERY_DAY_AT_3AM` | 幂等 DELETE | 🟢 |
| `audit.cleanupOldAuditLogs` | `0 5 2 * * *` | bypass 事务 DELETE，幂等 | 🟢 |

影响集中在：重复告警（已由条件写收敛）、并发删除抢锁/长事务（`cleanupOldRecords`/
`cleanupOldAuditLogs` 为**单条无界 DELETE**，多实例并发会放大 WAL 与锁竞争）。

### 3.9 🟢 已按实例聚合的观测/容量

- 运行时计数/仪表（`runtime-metrics-entry.ts` 模块级 `counters`/`gauges`，埋点
  TaskService/NotificationService）、`SchedulerMetricsService`、
  `ExecutionCallbackMetricsService`：per-process 单调计数，Prometheus per-target 抓取
  天然按 instance 区分；
- SSE 槽位 `TaskService.sseStreamsPerExecution/sseStreamsGlobal`（:969-970）与
  `MetricsStreamSlotService.activeStreams`：进程内计数，多实例总容量 = 实例数 ×
  上限（`SSE_MAX_STREAMS_GLOBAL` 默认 64 / `METRICS_STREAM_MAX_GLOBAL` 默认 32）——
  已在 `operations.md`、`api-reference.md` 显式文档化。

---

## 4. outbox / silence Redis 化评估

### 4.1 outbox 行级 claim（建议做，性价比高）

**问题**：8 个实例 → 同一待投行最多 8 次并发补投。

**方案 A（最小改动，推荐）**：扫描取行改为原子认领——
`UPDATE event_outbox SET nextAttemptAt = now + lease WHERE id IN (
   SELECT id FROM event_outbox WHERE dispatchedAt IS NULL AND deadLettered=false
     AND (nextAttemptAt IS NULL OR nextAttemptAt < now)
   ORDER BY createdAt LIMIT 50 FOR UPDATE SKIP LOCKED
) RETURNING *`
（注意 `nextAttemptAt` 当前语义是「退避指针」，需新增 `claimedAt`/`leaseUntil` 字段或
复用为短租约 + 心跳，避免与退避语义混淆）。PG 的 `SKIP LOCKED` 让各实例取到不相交
子集，天然分片。

**方案 B（Redis 化）**：把待投队列搬进 Redis（如 BullMQ 已有依赖）——投递即入队，
由 worker 消费，重试/退避交给队列。改动大（失去 DB 终态可查询性），需权衡。

**成本/收益**：A 约 1 个迁移（加 `leaseUntil`）+ 扫描器改造，即可把重复投递从
「×实例数」收敛到「DB 锁粒度允许的最小重复」；B 收益更大但需重做主链与可观测。
建议先做 A。

### 4.2 silence Redis 化（建议做，改善一致性）

**问题**：`isSilenced` 是同步热路径，内存 Map 无法跨实例；DB 只在启动回灌。

**方案 A（DB 读穿 + 短 TTL 缓存，推荐）**：保留内存 Map 作 L1，但 `isSilenced`
命中前对「本进程最近未回灌」的窗口做**周期性增量回灌**（如每 30s 拉 `listActive`
并 merge），或引入 `updatedAt` 游标做增量拉取。改动小、复用既有 `listActive`。

**方案 B（Redis 为准）**：每条静默一个 `silence:<id>` key（带 TTL = endTime），
`isSilenced` 走 Redis 读；`addSilence`/`removeSilence` 写 Redis + 发 pub/sub 通知
各实例清 L1。一致性最好，引入 pub/sub 复杂度与 Redis 依赖（Redis 不可用时
fail-open 回内存态，与 NOTIF-003 降级一致）。

**决策与落地**：本轮按方案 A 落地（周期读穿 + 本地 L1，见 3.2），Redis pub/sub
（方案 B）留作后续可选——静默/渠道配置均为低频人写、高频热读，TTL 收敛已消除
主缺口，引入 pub/sub 的收益不抵复杂度与 Redis 依赖。

`ChannelConfigStore` 同理按 A 落地，但**未复用 `system_config`**：渠道配置是
「按渠道键的对象 + enabled 开关 + RAW 机密」，塞进系统配置的 kv/掩码/历史面会
与既有脱敏与回滚语义纠缠，故建独立表（见 3.3）。

---

## 5. 水平扩容结论

- **可安全多实例**：调度链（Leader + claim）、BullMQ worker、无状态读写 API、
  观测端点（按 instance 聚合）。
- **需共享存储**：产物/执行器包本地 FS（共享卷或对象存储）。
- **已改造（本轮）**：通知静默（3.2）、渠道配置（3.3）、灰度批次（3.4）——三者
  原是「单实例内存态当共享态用」的典型，现统一为「DB 共享真相 + 读穿/claim/租约」，
  收敛窗口 ≤ 15s（灰度批次为事件驱动，无周期窗口）。
- **待真机双实例验证**：见文末清单（1/2/3 项现已具备验证条件）。
- **建议加固**：outbox 行级 claim（4.1）、`@Cron` 统一 Leader 门禁（3.8，可抽
  `@LeaderOnly()` 装饰器复用 scheduler 的 `isLeader`/Redis 锁，fail-open 语义一致）。

### 后续实现拆分

1. ~~**silence**：DB 读穿/短 TTL 回灌~~ ✅ 本轮完成（3.2）；Redis key + pub/sub 同步 L1 为可选增强，未做。
2. ~~**channel config**：补共享持久化~~ ✅ 本轮完成（独立表 1790000000014，见 3.3）。
3. ~~**rollout**：批次属主状态与心跳确认改为跨实例可协调的持久化/租约语义~~ ✅ 本轮完成（3.4，含非属主心跳 hydration、失败 claim、并发互斥、活性租约）。
4. ~~**outbox**：DB 行级 claim/lease~~ ✅ **claim/租约早前轮次已落地**（`FOR UPDATE SKIP LOCKED` + 60s 租约 + leaseToken 守卫，见 3.6），本轮补 **快速路径收口**（`markFastPathDelivered`，把「每个成功事件必然重复投递」收敛为「部分失败/租约竞态时才可能重复」）；**真机双实例的重复投递边界仍待验证**（§ 验证清单第 4 项）。

以上 1~4 为**代码实现完成 + 单测覆盖**；真机双实例端到端验证按清单逐项执行（1/2/5 已验证，3/4 待）。

### 真机双实例验证清单

> 验证执行：2026-09-12 本机真机双实例（`npm run test:arch31-multi-instance`，
> 两个真实 admin-api 进程共享同一 PG16 + Redis7 容器，空库迁移链真跑）。
> **15/15 通过**（脚本退出码 0），逐项结论如下。

1. ✅ **静默跨实例**：A 创建规则 → A 即时可见（adopt）、B 读面立即可见（DB 共享）、
   经多次读穿刷新后 B 仍持有（刷新不抖动）。
   *注：本项读面走 DB 层；内存热路径（`isSilenced` 翻转）由单测覆盖。*
2. ✅ **渠道配置跨实例**：A PATCH 保存 webhook 配置 → A 本实例即时生效，
   刷新前 B 仍是默认值（**实证了改造前多实例必然失效**），一个读穿周期后 B 读到
   A 保存的值（🔴→🟡 核心断言成立）。
3. ⏸ **canary 心跳落非属主实例**：本轮验证到「B 可跨实例接收 canary 升级请求、
   互斥判据走 DB」，但真实灰度推进需执行器 + 应用 + 可达 git 源，留部署轮。
4. ⏸ outbox 快速路径/补投重复边界（依赖 outbox 行级 claim，代码未实现）。
5. ✅ **调度 Leader 单点性**：两实例 `/api/metrics/scheduler` 中恰一个
   `scheduler.isLeader=true`（pid 可区分）。

---

## 6. 引用

- `docs/adr/adr-002-scheduler-dual-guard.md` — 调度双保险决策
- `docs/review_round4_concurrency.md` §P2 — 多实例 @Cron 无门禁（本矩阵重列并分级）
- `docs/operations.md` §多实例与 SSE 容量 / §滚动升级
- `docs/DEVELOPMENT-PLAN-2026-09H2.md` ARCH-31 条目
- 源码：`scheduler.service.ts`、`redis-lock.service.ts`、`notification.service.ts`、
  `notification-silence.service.ts`、`channel-config.store.ts`、`app-deployment.service.ts`、
  `outbox-dispatcher.service.ts`、`outbound-event-dispatcher.service.ts`、
  `executor.service.ts`、`task.service.ts`、`metrics-stream-slot.service.ts`、
  `runtime-metrics-entry.ts`
