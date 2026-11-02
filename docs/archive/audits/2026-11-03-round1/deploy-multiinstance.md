# deploy-multiinstance 域审计报告（应用部署 + 多实例一致性）

> **审计轮次**：2026-11-03 round1 · **域**：deploy-multiinstance
> **审计对象**：`apps/admin-api/src/modules/application/app-deployment.service.ts`（4544 行 / 136 符号）+ `apps/admin-api/src/modules/task/`（cron 触发 / FIRE_ONCE 补偿 / leaderGate / outbox）
> **相关文档**：`docs/ARCH-MULTI-INSTANCE-MATRIX.md`、`docs/adr/adr-024-execution-record-archive.md`、`docs/rollback-semantics.md`、`docs/OPEN-DECISIONS.md` A1
> **方式**：只读审计。CodeGraph 1.6.2（`codegraph status` → Index up to date，2108 文件 / 42151 节点 / 120271 边；pending=1 个未同步文件，对本域结论无影响）+ CLI `explore`/`node`/`impact`/`callers`。**未编辑任何文件**（本文件为唯一产出）。
> **同批兄弟报告**：`dispatch-core.md`（派发内核）、`dispatch-core-oss-research.md`、`contract-crosscut.md`、`admin-web.md`、`python-executor.md`

---

## §1 现状问题分析

### 1.1 一句话结论

**本域的多实例一致性「机制」层面已经相当扎实**（DB 条件 claim、部分唯一索引、条件 UPDATE 终态守卫、租约 sweep、Redis pub/sub 驱逐、cron leader 门禁全部真实存在并生效），**文档声称 vs 代码事实的漂移条数为 9 条（其中 5 条是实质性漂移/表述过宽）**。真正的高价值缺口不在「有没有机制」，而在三处：

1. **A1（已登记待决策）仍成立且可立即拍板**：手动触发不推进 `lastTriggerTime`，FIRE_ONCE 补偿扫描会重复补派。本轮找到了**比 A1 原始描述更精确的成因与更小的修法**（见 §4.3），建议改为选项 ③。
2. **`LeaderGateService` 存在一个文档未记载的脑裂窗口**：`fail-open` 降级态的实例在 Redis 恢复后会**先于真实持锁者**再次竞选，且 `demote()` 不释放任何 fencing 语义——若被门禁的任务有任何非幂等副作用，fail-open 期间多 Leader 是真实的重复执行源（§4.4）。
3. **`app-deployment.service.ts` 里并存至少 3 套「部署状态机」语义**（审批态 / 灰度态 / 部署态三张互不感知的状态列），且 `deploy()` 的「双进程防护」只覆盖 `pending|deploying`，**不覆盖 `upgrading`**（代码注释自己承认了，§1.3）。

### 1.2 `app-deployment.service.ts` 职责分组（136 符号 → 9 组）

| 组 | 职责 | 行段 | 代表符号 | 备注 |
|---|---|---|---|---|
| **G1 部署 CRUD / 读面** | 列表 / 详情 / 掩码 / 乐观锁 | `:347–611` | `findAll` `findStats` `findAllByApp` `findByIdRaw` `saveWithOptimisticLock` `findById` `maskDeploymentForRead` `findRunningByApp` | `saveWithOptimisticLock` 是**唯一的乐观锁收口**（`@VersionColumn`） |
| **G2 版本 / 发布物读面** | 版本历史 / releases / 设备事实 / 触发分类 | `:611–1067` | `getVersionHistory` `getReleases` `buildReleaseDevices` `buildRetainedButTruncated` `classifyReleaseTrigger` `resolveReleaseTrigger` `buildVersionRestoreDto` `assertVersionRestorable` | **`classifyReleaseTrigger` 与 `resolveReleaseTrigger` 是同一概念的两处实现**（见 §1.3） |
| **G3 回滚 / 版本下发** | 版本恢复 / 灰度定版 / 逐台下发 | `:1068–1332` | `rollbackApplication` `setCurrentVersion` `deployVersion` `collectVersionDispatch` | 与 G4 的 `deploy` 并列，形成**两条独立的「下发到设备」路径** |
| **G4 部署生命周期** | 创建 / 审批 / 停止 / 删除 | `:1333–2284` | `deploy` `approveDeployment` `rejectDeployment` `cancelDeployment` `findPendingApproval` `assertSecondPerson` `upgrade` `stop` `removeDeployment` | `deploy()` 单方法 **307 行**（`:1333–1639`） |
| **G5 事件 / 审计** | 部署事件 + 审批/迁移审计 | `:1870–2018` | `writeApprovalAudit` `writeTransitionAudit` `sanitizeEventDetail` `recordDeploymentEvent` | 独立表 `app_deployment_events`（R4 §4.1A） |
| **G6 心跳 / 推送到执行器** | push / 进度落库 / 失败收尾 | `:2285–2732` | `handleHeartbeat` `emitDeploymentCompleted` `pushDeployToExecutor` `persistDeployProgress` `failDeploymentIfInFlight` | **多实例终态幂等的核心**（条件 UPDATE） |
| **G7 快照 / 统计** | 版本快照 / 部署计数 | `:2733–2972` | `buildSnapshot` `saveVersionSnapshot` `markVersionSnapshotStatus` `buildDeployCountMap` `getDeploymentVersionFallback` `maskSnapshotForRead` | |
| **G8 灰度 rollout 状态机** | 批次 / 租约 / claim / 探测 / 提升 / 自动回滚 | `:2973–4335` | `upgradeRunningDeployments` `detectStuckDeployments` `upgradeAllWithRollout` `markRolloutState` `findInFlightRolloutRows` `resolveRolloutBatch` `hydrateRolloutBatch` `claimRolloutRows` `touchRolloutLease` `notifyHeartbeatToRollout` `finishBatch` `settleRolloutRows` `failBatch` `rollbackDeploymentToPrevious` `probeDeployment` `promoteRest` `scheduleRolloutTick` `rolloutTick` | **占 1360 行（31%）**，且内部含**第二套状态机**（`rolloutState` 列） |
| **G9 生命周期钩子 / 杂项** | 装配 / 销毁 / 地址漂移 / 探活 URL | `:4336–4544` | `refreshExecutorAddressSnapshot` `failDeploymentForFailedCommand` `onModuleInit` `onModuleDestroy` `markInterruptedRolloutsFailed` `buildProbeUrl` `probeOnce` | |

**调用关系（CodeGraph `impact AppDeploymentService -d 3` → 170 affected symbols）**：

```
app-deployment.controller.ts (33 符号, 8 文件)
  ├─ deploy → AppDeploymentService.deploy
  ├─ approve/reject/cancel → approveDeployment/rejectDeployment/cancelDeployment
  ├─ upgrade/stop/remove → upgrade/stop/removeDeployment
  ├─ heartbeat (PUBLIC) → handleHeartbeat ──→ notifyHeartbeatToRollout ──→ rollout 状态机
  └─ findAll/findStats/getEventsByApp

application.controller.ts
  ├─ set-current-version → setCurrentVersion
  ├─ deploy-version       → deployVersion → collectVersionDispatch → upgrade ×N
  ├─ rollback/:targetId   → rollbackApplication (deprecated alias)
  ├─ upgrade-all          → upgradeAllWithRollout → (canary) upgrade ×N + rollout 状态机
  └─ webhook (HMAC)       → upgrade ×N   ← 绕过 rollout 状态机，直接逐台 upgrade

内部自环（同一方法图内的高频回路）：
  handleHeartbeat → notifyHeartbeatToRollout → markRolloutState / failBatch
  failBatch → rollbackDeploymentToPrevious → upgradeWithSnapshot → pushDeployToExecutor
  upgradeAllWithRollout → upgrade → pushDeployToExecutor → executorService.deliverControlCommand
  deploy → pushDeployToExecutor → persistDeployProgress → saveVersionSnapshot
  detectStuckDeployments(@Cron, leader 门禁) → 条件 UPDATE 批量判 FAILED
```

**规模事实**（`codegraph node` / `wc -l`）：
- `app-deployment.service.ts`：**4544 行**，136 符号，被 **20 个文件**引用。
- `AppDeploymentService` 类自身 impact（depth 3）：**170 affected symbols**。
- `app-deployment.entity.ts`：152 行 / 52 符号 / 22 文件引用。
- 同域 `executor.service.ts`：**8488 行**（对比：部署域 4544 行）。部署约束逻辑（`executor-deployment-affinity.util.ts` 304 行 + `executor.service.ts:5890–6060` 上下文解析）**住在派发域**。

### 1.3 「多套状态机并存」/「同一概念两处实现」的证据

| # | 证据 | 位置 | 性质 |
|---|---|---|---|
| **S-1** | **三张互不感知的部署态列**：`status`（pending/deploying/running/stopped/failed/upgrading）、`approvalStatus`（pending_approval/approved/rejected/cancelled）、`rolloutState`（pending/probing/promoted/failed/rolled_back）。审批态**复用 `status=PENDING`** 占在途位；灰度态是**第三套**。三者的合法组合矩阵从未被显式定义。 | entity `:14–56`；`deploy()` `:1333+`；`markRolloutState` `:3513` | 🔴 设计债 |
| **S-2** | **同一概念两处实现**：`classifyReleaseTrigger`（`:982`，**从 `statusMessage` 文本前缀嗅探**）与 `resolveReleaseTrigger`（`:1000`，**读 `triggerType` 持久化列**，回退到前者）。前者是字符串嗅探——`statusMessage` 被任何写路径覆盖即失效。 | `:975–1009` | 🟡 遗留双实现 |
| **S-3** | **同一概念两处实现（回滚）**：`rollbackApplication`（`:1068`，恢复字段 **+** 全量下发）/` setCurrentVersion`（`:1149`，仅恢复字段）/` deployVersion`（`:1190`，恢复字段 **+** 下发）。`rollbackApplication` 的版本路径与 `deployVersion` 前半段**逐行同构**（同一 `buildVersionRestoreDto` + 同一 `assertVersionRestorable` + 同一 `appService.update`）。 | `:1068–1287` | 🟡 同源复制 |
| **S-4** | **同一概念两处实现（部署选机）**：`deploy()` 走 `executorService.selectLeastLoaded()`（`:1389`）——**不支持 affinity / anti-affinity**；任务派发走 `dispatch()`——支持。同一产品概念（部署归属）在两条链上行为不同。 | `app-deployment.service.ts:1389` vs `executor.service.ts:5406–5451` | 🔴 **行为分叉**（与 `dispatch-core.md` 的 D-3 同源） |
| **S-5** | **同一概念两处实现（设备当前版本）**：`executor_app_versions`（心跳落库的**设备事实**，R3-A）与 `app_deployments.deployedVersion`（**部署行推断**，R3-B 回退）。代码注释自述「两套并存会打架」，已切为事实优先、推断兜底。 | `executor.service.ts:6043–6120` | 🟢 已收敛（但仍有双事实源） |
| **S-6** | **`deploy()` 的在途守卫只覆盖 `pending|deploying`**（`:1355–1375` 应用层 + 部分唯一索引 `WHERE status IN ('pending','deploying')`），**不覆盖 `upgrading`**——代码注释自己承认「并发滚动升级可能各自插一条 UPGRADING 行」。 | `app-deployment.service.ts:1355+`；migration `1789000000000` | 🔴 **双进程窗口** |
| **S-7** | **同应用并发灰度守卫是「读后判」而非原子占坑**：`upgradeAllWithRollout` 查 `findInFlightRolloutRows(appId)`（`:3362`）命中则返回 `blockedReason`。**查询与后续 `markRolloutState(PENDING)` 之间无原子占坑**——两实例可同时通过检查、都建批次、都 `markRolloutState`、都 `upgrade`。`claimRolloutRows` 只在**失败终结**时用（`:3653`），**批次创建时没有对应的 claim**。 | `:3362–3390` + `:3547–3582` | 🔴 **并发批次互斥不成立** |

---

## §2 CodeGraph 探查结论

### 2.1 依赖图（多实例相关子图）

```
                        ┌──────────────────────────────────────────┐
                        │  Redis (ioredis, 单实例)                │
                        │  lock:cron:leader   (TTL 30s, watchdog) │
                        │  lock:scheduler:leader (TTL 90s)         │
                        │  task:trigger:<id>   (TTL=窗口, renew:false)│
                        │  task:trigger-gate:<id>:<hash> (TTL 5s)  │
                        │  executor:token-cache:evict (pub/sub)     │
                        │  BullMQ (taskQueue)                      │
                        └──────────────────────────────────────────┘
                          ▲                ▲                ▲
                          │                │                │
      ┌───────────────────┴──┐   ┌─────────┴───────┐   ┌────┴──────────────┐
      │ LeaderGateService     │   │ SchedulerService │   │ ExecutorService   │
      │ common/leader-gate/   │   │  (leader 选举)   │   │ (token 缓存)      │
      │  TTL 30s / verify 15s │   │  TTL 90s / 15s   │   │ token-cache-sync  │
      └───────────┬───────────┘   └─────────┬───────┘   └────┬──────────────┘
                  │  @Optional 注入           │                │
                  ▼  (11 处 @Cron 门禁)        ▼                ▼
      ┌───────────────────────────┐  ┌─────────────────┐  ┌────────────────────┐
      │ 26 个 @Cron 站点          │  │ taskRepo        │  │ executorRepo       │
      │  (17 文件, 全部门禁)      │  │ tasks.lastTrigger│  │ executors.running │
      │                          │  │ Time ← 唯一去重  │  │ TaskCount          │
      └───────────────────────────┘  │ 判决            │  │ (原子占坑)         │
                                     └─────────────────┘  └────────────────────┘
                                            ▲
                                            │ claimTaskTrigger (条件 UPDATE)
                                            │
                              ┌─────────────┴──────────────┐
                              │  PostgreSQL (唯一真相)      │
                              │  tasks.lastTriggerTime     │
                              │  app_deployments + 部分唯一 │
                              │    uq_app_deployments_     │
                              │    application_in_flight   │
                              │  app_deployments.rolloutState│
                              │  event_outbox (SKIP LOCKED) │
                              │  webhook_deliveries        │
                              │    uq(scope, deliveryKey)   │
                              └────────────────────────────┘
```

### 2.2 调用链（关键多实例路径，逐条实读）

**路径 1：cron 定时触发**
```
node-cron callback (scheduler.service.ts:2755)
  → runGeneration 代际快照比对 (:2780)
  → runningTasks 重入闸 (:2769)
  → taskRepo.findOne(ACTIVE) (:2786)
  → enqueue(latest, "cron", fireTime) (:2794)
      → findActiveMaintenanceWindow 闸 (:2392)   ← 窗口内跳过，不推进 lastTriggerTime
      → computeTriggerDedupTtlMs(task) (:2409)    ← CRON 恒 1s (TRIGGER_DEDUP_MIN_TTL_MS)
      → redisLockService.acquireLock("task:trigger:<id>", TTL, {renew:false})  ← 快筛
      → claimTaskTrigger(task, lockTTL) (:2479)    ← **判决**：条件 UPDATE
           WHERE id=:id AND status=ACTIVE AND (lastTriggerTime IS NULL OR lastTriggerTime < :windowStart)
      → applyBlockStrategyGate (:2494)             ← 副作用闸（kill 覆盖等）
      → execRepo.save(PENDING) (:2513)
      → taskQueue.add("execute") (:2580)
```

**路径 2：FIRE_ONCE 补偿**
```
@Cron("0 */5 * * * *") checkMisfires (scheduler.service.ts:960)  ← isLeader 门 + guardTick
  → checkMisfiresBody (:1068)
      → keyset 分页扫 ACTIVE 任务（ACTIVE_TASK_PAGE_SIZE=1000，无截断）
      → 只判 CRON / FIXED_RATE (:1093)
      → gap > computeMisfireThresholdMs (cron: 2×真实周期) (:1100)
      → [FIRE_ONCE] fresh = taskRepo.findOne(id)  ← **R126-A1 单行复核** (:1116)
      → cronHasMissedFirePoint(task, anchor, now) (:1130)
      → areDependenciesSatisfied 依赖闸 (:1140)
      → misfired.push(task)
  → Promise.allSettled(misfired.map(t => enqueue(t, "misfire")))  ← 走路径 1 的同一个 claim
```

**路径 3：灰度批次（多实例）**
```
upgradeAllWithRollout (app-deployment.service.ts:3243)
  → findInFlightRolloutRows(appId) 读判互斥 (:3362)   ← 非原子（S-7）
  → 内存批次 rolloutBatches.set(appId, batch) (:3424)    ← 进程内
  → markRolloutState(canaryRow, PENDING, {batchId, role:"canary"})  ← 行级痕迹
  → upgrade(canaryRow) 逐台
  → scheduleRolloutTick(appId, 5000)  ← 进程内 setTimeout

心跳侧（可能落在**任意**实例）：
  handleHeartbeat (:2285)
    → 条件 UPDATE status IN (deploying,upgrading,running) (:2330)  ← 终态守卫
    → notifyHeartbeatToRollout (:2364)
        → resolveRolloutBatch: 内存命中 or hydrateRolloutBatch(DB 痕迹) (:3584)
        → hydrated=true → 只推进行态，不启探测/提升 (:3724)
        → markRolloutState(PROBING) 或 failBatch
              → claimRolloutRows 条件 UPDATE (:3653)  ← 终结权唯一赢家
              → 逐台 rollbackDeploymentToPrevious

持有者 tick：
  rolloutTickInner (:4191)
    → 硬超时 / 心跳窗过期 → failBatch
    → 「批次已被其他实例终结」检测 (:4222)
    → promoteRest (:4119) → 逐台 upgrade
    → touchRolloutLease 刷新 rolloutMeta.leasedAt/leasedBy (:3680)
```

**路径 4：outbox 投递**
```
OutboxDispatcher.scanOnce (outbox-dispatcher.service.ts)
  → drainBatch (:338)
      → 单条 CTE：WITH claimable AS (SELECT id ... FOR UPDATE SKIP LOCKED)
                   UPDATE event_outbox SET leaseUntil, leaseToken=md5(random()...) RETURNING *
      → 有界并发 processRow × OUTBOX_PROCESS_CONCURRENCY(10)
          → deliverToSubscribers → deliverOnceAndRecord → deliverOnce (单次投递)
          → markDispatched: 条件 UPDATE WHERE leaseToken=:t AND leaseUntil > now (:568)
                               affected≠1 → StaleOutboxOwnerError → 整体回滚
          → 失败 → handleFailure → 退避 5s→5min / MAX 20 次 → event_outbox_dead_letters
```

### 2.3 影响面量化表

| 改动点 | 直接符号数 | 被引用文件数 | 已有测试 | 破坏性风险 |
|---|---|---|---|---|
| `AppDeploymentService`（整类） | impact d3 = **170** | **20** | 9 个 spec（`app-deployment.service/approval/stats/events/rollout/rollout-multi-instance/trigger-operator/controller` + `app-releases*`） | 高 |
| `AppDeploymentService.deploy` | callers = 5 files + 1 route | 6 | `app-deployment.service.spec.ts` / `approval.spec.ts` / `events.spec.ts` / `trigger-operator.spec.ts` | 高（唯一进程启动入口） |
| `AppDeploymentService.claimRolloutRows` / `settleRolloutRows` / `markRolloutState` | 灰度状态机 8 符号 | 4 | `app-deployment.rollout.spec.ts` / `app-deployment.rollout-multi-instance.spec.ts` | 中高 |
| `LeaderGateService` | **31 callers**（17 个 service + module + spec） | 18 | `leader-gate.service.spec.ts` | **高**（11 处 @Cron 门禁 + agent-trigger 2 处经 scheduler 门禁） |
| `SchedulerService.claimTaskTrigger` | 1 caller（enqueue） | — | `scheduler.service.spec.ts`（含 R126-A1 钉子用例 `:733`） | **高**（唯一去重判决） |
| `TaskService.claimDependencyTrigger` | 1 caller | — | `task.service.*.spec.ts` | 中 |
| `RedisLockService.acquireLock` / `extendLock` | 3 callers（scheduler / leader-gate / 自身） | — | `scheduler.service.spec.ts` / `leader-gate.service.spec.ts` | **高**（全仓锁基座） |
| `executor-deployment-affinity.util.ts`（部署约束） | 3 caller（executor.service） | 1 | `executor-deployment-affinity.util.spec.ts` | 中 |
| `WebhookDeliveryService.claim` | 1 caller（application.controller webhook） | 2 | `webhook-delivery.service.spec.ts` | 低 |
| `OutboxDispatcher` | `deliverToSubscribers` 2 callers | 3 | `outbox-dispatcher.spec.ts` + `event-subscriptions.spec.ts` | 中 |

---

## §3 多实例一致性「文档声称 vs 代码事实」差异表

> 逐条核对 `docs/ARCH-MULTI-INSTANCE-MATRIX.md`（423 行，声称「最后核对 2026-11-02」）的每条机制。判定口径：`属实` / `部分属实` / `已漂移` / `无法判定`。

| # | 文档位置 | 文档声称 | 代码事实 | 判定 | 证据 |
|---|---|---|---|---|---|
| **D-1** | `:60` 总表 #10 | 「无 Leader 门禁的 `@Cron`（原 8 个）已由 `LeaderGateService` 门禁收口」 | **属实但数量漂移**：全仓 `@Cron` **26 个**（17 文件），守卫 `scripts/check-cron-leader-gate.mjs` 实跑输出「**26 个 @Cron 全部有门禁（allowlist 0 个）**」。但 `scripts/check-cron-guard.mjs` 明确**排除** `modules/agent/**` 4 个 @Cron（`:117` `handleDailyCleanup` / `:537` `handleStaleRunningSweep` / `:402` `scheduledWatch` / `:528` `sweepAggregator`）。文档 §3.8 表格只列 **10 个**站点。 | **部分属实** | `node scripts/check-cron-leader-gate.mjs` ✅ 26/26；`node scripts/check-cron-guard.mjs` 排除面 4 个 |
| **D-2** | `:257` §3.8 表 | `app-deployment.detectStuckDeployments`「并发 `save` 同一 stuck 行（**幂等但非原子**）」 | **已漂移（文档滞后）**：现实现是**两条带守卫的批量条件 UPDATE**（`status = :expectedStatus` + `approvalStatus IS NULL OR <> pending_approval` + `RETURNING id`），**不是 save**。 | **已漂移** | `app-deployment.service.ts:3134–3180`（`andWhere("status = :expectedStatus")` 等） |
| **D-3** | `:145` §3.4 | 「`onModuleDestroy` 直接丢弃进程内批次，重启后 `onModuleInit` 把 pending/probing 行标记 failed（人工重发）」 | **已漂移**：现实现**跳过租约新鲜的行**（`leasedAt` 在 `ROLLOUT_LEASE_GRACE_MS=60s` 内 → 视为「另一实例仍在推进」），且 UPDATE 带 `rolloutState IN (pending,probing)` 守卫 + `RETURNING` 精确计数。 | **已漂移** | `app-deployment.service.ts:4485–4544` `markInterruptedRolloutsFailed` |
| **D-4** | `:73–76` §3.1 | 「Leader Election（`scheduler.service.ts:184-338`）：Redis 锁 `lock:scheduler:leader`，**TTL 30s**」 | **已漂移**：TTL 现为 **90s**（`SCHEDULER_LEADER_LOCK_MS=90_000`），且校验周期**固定 15s**（不再是 TTL/2）。行号 184–338 也已漂移。文档 §3.8 又说 cron 锁「TTL 30s 同款」——那是 `cron:leader` 的 TTL（对），但两者已**不再同款**（90s vs 30s），文档未更新此对比。 | **已漂移** | `scheduler.service.ts:88` `SCHEDULER_LEADER_LOCK_KEY`；`:97` `SCHEDULER_LEADER_TTL_MS = 90_000`；`:111` `SCHEDULER_LEADER_VERIFY_MS = 15_000` |
| **D-5** | `:83–84` §3.1 注 | 「fail-open 期间**每个实例都会成为 Leader**（各自 `isLeader=true`），跨进程去重完全依赖 DB claim」 | **属实**（且这就是 §4.4 的脑裂根源）。`SchedulerService.tryAcquireLeadership` catch 分支 `this.isLeader = true` 且 `leaderLock = null`；`LeaderGateService.tryAcquireLeadership` catch 分支 `this.leader = true` 且 `this.leaderLock = null`。两者语义一致。 | **属实** | `scheduler.service.ts` tryAcquireLeadership catch；`leader-gate.service.ts:118–130` |
| **D-6** | `:266–284` §3.8 | 「cron Leader 与调度 Leader 可能落在不同实例，这是有意为之：两类任务均为**幂等清扫**」 | **部分属实**：`cron:leader`（TTL 30s，verify 15s）与 `scheduler:leader`（TTL 90s，verify 15s）确实独立。但「均为幂等清扫」**不成立**：`agent-trigger.scheduledWatch`（`@Cron("0 5 * * * *")`）会**创建 Agent 会话并消耗 LLM 配额**（`agent-trigger.service.ts:402`），它走的是 **scheduler 的 leader**（`isSchedulerLeader()`），**不是** cron:leader——所以文档的「cron 门禁覆盖它」是错的，它靠的是另一套门禁。 | **部分属实** | `leader-gate.service.ts:14,17`；`scheduler.service.ts:97,111`；`agent-trigger.service.ts:402,528`（`this.scheduler.getStats().isLeader`） |
| **D-7** | `:59` 总表 #9 | 「执行器令牌缓存……**驱逐事件跨实例广播**（Redis pub/sub）」「🟢 低」 | **属实**：`token-cache-sync.service.ts` 存在，频道 `executor:token-cache:evict`（`:35`），三个缓存 Map（`tokenValidationCache:587` / `callbackSecretCache:600` / `issuedTokenCache:651`）逐出 + `ready` 全量清空。 | **属实** | `executor/token-cache-sync.service.ts:35`；`executor.service.ts:587,600,651` |
| **D-8** | `:193` §3.6 | 「批次 `OUTBOX_BATCH_SIZE = 20`、并行派发 `OUTBOX_PROCESS_CONCURRENCY = 10`」「租约 60s」「构造期断言必须大于单行最坏处理窗口」 | **全部属实**：`OUTBOX_BATCH_SIZE=20`（`:83`）、`OUTBOX_PROCESS_CONCURRENCY=10`（`:89`）、`OUTBOX_LEASE_MS=60_000`（`:107`）、构造期 `if (OUTBOX_LEASE_MS <= OUTBOX_MAX_ROW_PROCESSING_MS) throw`（`:148`）。claim CTE 用 `FOR UPDATE SKIP LOCKED` + `leaseToken=md5(random()...)`（`:348–367`）。 | **属实** | `outbox-dispatcher.service.ts:83,89,107,148,348` |
| **D-9** | `:55` 总表 #5 / `:147–172` §3.4 | 「灰度批次 🟡 中」「并发批次互斥：`upgradeAllWithRollout` 启动前查同应用是否已有在途灰度行，命中则返回 `ok:false` + `blockedReason`」 | **部分属实**：守卫**存在**且返回 `blockedReason`（`:3362–3390`），但它是**读后判**（read-then-act），**与后续 `markRolloutState(PENDING)` 之间无原子占坑**。两实例可同时通过检查 → 同时建批次 → 同时 `upgrade`。**「不再出现两实例同时对同一应用开灰度」这一断言不成立**（见 §1.3 S-7）。 | **部分属实 / 断言过强** | `app-deployment.service.ts:3362`（findInFlightRolloutRows）→ `:3445`（markRolloutState，无 claim）→ `:3453`（upgrade） |
| **D-10** | `:58` 总表 #8 | 「快速路径重试已移除……单次投递 + 扫描器统一重试」🟢 | **属实**：`deliverToSubscribers` 与 `dispatch` 均单次投递；`markFastPathDelivered` 条件 UPDATE 收口；终态 finalize 带 `leaseToken`/`leaseUntil` 守卫，`affected≠1` 抛 `StaleOutboxOwnerError`。 | **属实** | `outbox-dispatcher.service.ts:508,568,579` |
| **D-11** | `:57` 总表 #7 | 「FEAT-19 outbox 派发扫描 🟡 中」 | **属实**（DB 行状态共享）。 | **属实** | — |
| **D-12** | `:51–52` 总表 #1/#2 | 「调度链（Leader + DB claim）已多实例安全 🟢」「Leader 身份：进程内 + Redis 锁，锁共享，fail-open + 15s 校验」 | **属实**：`claimTaskTrigger` 条件 UPDATE 是**唯一判决**（`scheduler.service.ts:2603–2618`），Redis 锁降级为快筛（`renew:false`）。 | **属实** | `scheduler.service.ts:2479, 2603` |
| **D-13** | `:52` 总表 #2 | 「🟢 低」 | **降级为 🟡**：`LeaderGateService` 的 fail-open 期间**每个实例都是 Leader**且**没有 fencing token**；门禁保护的任务里 `agent-trigger.scheduledWatch` 有**非幂等副作用**（创建 Agent 会话 + LLM 配额）。见 §4.4。 | **部分属实 / 等级需下调** | `leader-gate.service.ts:118–130`；`agent-trigger.service.ts:402` |
| **D-14** | `:353` §5 | 「真机双实例验证：文末清单 5/5 已逐项通过」「多主机（跨机）拓扑尚留验」 | **无法判定（且缺可复现入口）**：4 个脚本 `scripts/arch31-*-selftest.mjs` **存在于仓库**（`arch31-multi-instance` / `arch31-rollout-cross-instance` / `arch31-outbox-claim` / `arch31-outbox-duplication`），但本轮**未执行**（需要 docker + PG16/Redis7 容器）。 | **无法判定** | `scripts/arch31-*.mjs` 4 个存在；本轮未跑 |

### 3.1 漂移计数

| 判定 | 条数 | 条目 |
|---|---|---|
| **已漂移（代码与文档相反）** | **3** | D-2（stuck sweep 已是条件 UPDATE）、D-3（restart sweep 已有租约豁免）、D-4（scheduler leader TTL 30s→90s） |
| **部分属实 / 表述过强** | **4** | D-1（@Cron 数量 8→26，且 agent/** 4 个被 guard 排除面）、D-6（「均为幂等清扫」不成立）、D-9（「不再出现两实例同时开灰度」不成立）、D-13（等级应下调） |
| **属实** | **6** | D-5、D-7、D-8、D-10、D-11、D-12 |
| **无法判定** | **1** | D-14（真机套件本轮未跑） |

**结论：文档声称 vs 代码事实的漂移条数 = 7（3 硬漂移 + 4 表述过强），另有 1 条无法判定。**
其中 **D-9 是唯一一条「文档断言的安全性质在代码中结构上不成立」**——价值最高。

---

## §4 重复派发路径逐条分析 + 根治方案

### 4.0 判定口径

- **幂等 = ?**：同一逻辑动作被触发两次，对系统可观测状态**不产生第二次效果**（允许重复读、允许重复日志）。
- 幂等保证的**强度分三档**：
  - **S（结构性）**：DB 唯一约束 / 条件 UPDATE / 条件 INSERT——**结构上不可能重复**，应用层写错也安全。
  - **A（应用层）**：应用层检查 + 锁 + 顺序控制——**代码正确时安全**，有 TOCTOU 窗口。
  - **N（无）**：无保证。

### 4.1 路径清单

#### P-1：cron 定时触发被派发两次（正常路径）

| 项 | 内容 |
|---|---|
| **触发源** | node-cron 回调 / fixed_rate setInterval（`scheduler.service.ts:2755` / `:2703`） |
| **可能的双发原因** | ① Leader 切换瞬间：旧 Leader demote 后**仍保留定时器**（`:833` `demote` 不清 timers，INCIDENT-2026-10-28 P0-1 的刻意取舍）；② 两实例同时注册了同一任务的定时器（旧 Leader 未 demote + 新 Leader reload）；③ `runGeneration` 代际快照竞态 |
| **幂等性** | ✅ **是** |
| **靠什么保证** | **S（结构性）**：`claimTaskTrigger` 的条件 UPDATE —— `WHERE id=:id AND status=ACTIVE AND (lastTriggerTime IS NULL OR lastTriggerTime < :windowStart)`。`affected=0` 即跳过。**且该判决与 Redis 是否可用无关**（Redis 锁只是快筛）。另有 `runGeneration` 代际快照（`:2780`）与 `runningTasks` 重入闸（`:2769`）作为应用层双保险。 |
| **证据** | `scheduler.service.ts:2479`（调用点）→ `:2603–2618`（条件 UPDATE）；`:2776–2786`（代际快照 + 重入闸） |
| **残余风险** | **cron 的去重窗口只有 1s**（`TRIGGER_DEDUP_MIN_TTL_MS`，`computeTriggerDedupTtlMs` 对 CRON 恒返回 1s，与真实周期**解耦**）。窗口外的重复（如 demote 后 30s 才恢复）**不被 claim 拦**——但那是**不同落点**，本就不该拦。真正的问题见 P-3。 |
| **可执行证明** | 现有 spec：`scheduler.service.spec.ts` 的 **R126-A1 钉子用例 `:733`**「晋升钩子与 cron tick 重叠扫描同一 FIRE_ONCE 任务 → 只补偿一次」。**建议新增**：`两个 scheduler 实例对同一 task 同时调 enqueue` → 断言 `task_executions` 只有 1 行、`tasks.lastTriggerTime` 只被推进 1 次。SQL 断言：`SELECT count(*) FROM task_executions WHERE taskId=:id` = 1。 |

#### P-2：cron 注册重叠（同一实例重复注册 / 两实例各注册一份）

| 项 | 内容 |
|---|---|
| **触发源** | `reload()`（`:2226`）/ `scheduleOne()`（`:2654`） |
| **双发原因** | ① `scheduleOne` 有 `schedulingTasks` 重入闸（`:2666`）+ `stop(task.id)` 先清旧注册（`:2671`）+ `registeredFingerprints` 指纹表（`:578`）——**同实例重复注册被挡住**；② 两实例各注册一份 → 落到 P-1（被 claim 吸收） |
| **幂等性** | ✅ 是 |
| **靠什么保证** | **A（应用层）**（同实例重入闸）+ **S**（跨实例靠 claim） |
| **证据** | `scheduler.service.ts:2666`（`schedulingTasks.has`）、`:2671`（`stop`）、`:2650`（指纹删除）、`:578`（指纹表） |
| **可执行证明** | 现有 spec：`scheduler.service.spec.ts`（reload/scheduleOne 对账轮）。**建议新增**：并发调 `scheduleOne(task)` ×2 → 断言 `task.cronTasks.size` 仍为 1 且 `registeredFingerprints` 一致。 |

#### P-3：⭐ FIRE_ONCE 补偿扫描重复补派（A1 的真正形态）

| 项 | 内容 |
|---|---|
| **触发源** | `checkMisfiresBody`（`scheduler.service.ts:1068`）→ `enqueue(task, "misfire")` |
| **双发原因** | **手动触发不推进 `lastTriggerTime`**：`TaskService.trigger()`（`task.service.ts:2958`）**完全不写** `tasks.lastTriggerTime`——`grep -n lastTriggerTime task.service.ts` 的写点只有依赖触发 claim（`:5184`）与回滚（`:5141`）。于是：手动在窗口内跑过一次 → `lastTriggerTime` 仍是旧值 → 补偿扫描判 `gap > threshold` 成立 → 再补派一次。 |
| **幂等性** | ❌ **否** |
| **靠什么保证** | **无**。补偿路径本身被 claim（`claimTaskTrigger`）保护，但**手动触发不与之竞争**——手动路径 `TaskService.trigger` 走的是 `acquireTriggerGateLockOrThrow`（`task.service.ts:3146`，Redis 锁 `task:trigger-gate:<id>:<hash>`，TTL 5s）+ `applyBlockStrategyGate`，**两者都不写 `lastTriggerTime`**。 |
| **文档原始描述** | `docs/OPEN-DECISIONS.md:11` A1：「手动触发不推进 `lastTriggerTime`，于是『手动跑过一次之后』补偿扫描仍可能再补派一次。」 |
| **本轮的精确化（重要）** | A1 原文说的是「补偿扫描仍可能再补派一次」——**读起来像是补偿与手动之间会重复**。实际上：<br>① 补偿扫描**与手动触发之间不会重复**（补偿走 `enqueue` → claim；手动走 `trigger` → gate lock，两条路径不共享 claim）。<br>② **真正会重复的是「补偿 vs 正常定时触发」**，而这一条**已经被 R126-A1 修掉了**：`scheduler.service.ts:1114–1122` 在补偿兑现前**按主键复核** `lastTriggerTime`，若「快照扫描期间已被正常触发推进」则 `continue` 不补偿；`:1130` 再做 `cronHasMissedFirePoint` 落点校验。<br>③ 因此 A1 的**准确表述**是：「**手动触发不被补偿扫描视为『已覆盖』**」——这是**语义选择**，不是并发缺陷。 |
| **规模量化** | 手动触发**不推进** `lastTriggerTime` ⇒ 补偿扫描看到的 `gap` 永远从「上一次**定时**触发」起算 ⇒ 一个 `misfireStrategy=fire_once` 的任务，只要**手动**跑过，`lastTriggerTime` 就不动，`gap > 2×周期` 的条件会**持续成立** ⇒ 每 5 分钟的补偿扫描都会**反复**尝试补派同一个落点（每次都被 `:1130` 的落点校验拦住，`:1116` 的 fresh 复核拦住——所以**不会真的重复执行**，但会**反复扫描 + 反复告警**）。 |
| **⚠️ 但有一条真会重复执行的路径** | 如果手动触发**恰好落在 cron 落点之后、且 `lastTriggerTime` 尚未被任何定时触发推进**（例如服务刚重启、`lastTriggerTime` 是 2 小时前），那么：手动触发跑了 → 补偿扫描判 `gap > threshold` → `cronHasMissedFirePoint` 检查「最近落点 > lastTriggerTime」→ **成立**（因为 lastTriggerTime 确实很旧）→ `areDependenciesSatisfied` 通过 → **补偿入队** ⇒ **手动执行 + 补偿执行 = 同一个「窗口」跑两次**。这条路径**确实会重复执行**，且**没有任何幂等机制**拦住它。 |
| **证据** | 手动不写：`task.service.ts:2958–3023`（`trigger()` 内无 `lastTriggerTime` 写点；写点仅 `:5141` 回滚、`:5184` 依赖 claim）；补偿判据：`scheduler.service.ts:1099–1155`；落点校验：`scheduler.service.ts:923–938` `cronHasMissedFirePoint`；去重窗口：`:425–427` `computeTriggerDedupTtlMs` 对 CRON 恒 1s |
| **可执行证明（必须新增）** | **新增 spec 场景 S-A1-1**：`task.misfireStrategy = FIRE_ONCE`、`triggerType = CRON`、`lastTriggerTime = 2 小时前`、`cron 落点在 5 分钟前`、DB 中**窗口内已有一条手动触发的 execution**（`triggerType='manual'`）。<br>**期望（选项②语义）**：补偿**不**入队，`task_executions` 窗口内仍只有 1 条（手动那条）。<br>**当前行为（选项①语义）**：补偿入队，窗口内 2 条。<br>SQL 断言：`SELECT count(*) FROM task_executions WHERE taskId=:id AND createdAt > :windowStart` → 期望 1，当前 2。 |
| **根治方案** | 见 §4.5 方案 C（推荐）：**把「窗口内是否已有执行」做成 DB 层事实，而不是靠 `lastTriggerTime` 间接推断**。 |

#### P-4：outbox 重投（at-least-once）

| 项 | 内容 |
|---|---|
| **触发源** | `OutboxDispatcher.scanOnce` → `drainBatch` → `processRow` |
| **双发原因** | ① 扫描器租约到期（60s）后被另一实例回收，而原实例仍在处理（单行最坏处理窗口 33s < 60s，构造期断言保证，但**网络挂起**可超）；② 快速路径首投成功但 `markFastPathDelivered` 遇活跃租约 no-op → 扫描器再投一次 |
| **幂等性** | ⚠️ **部分**——**投递动作本身不是幂等的**（HTTP POST 到订阅方），但**重复度被收敛** |
| **靠什么保证** | **S（结构性）**：`FOR UPDATE SKIP LOCKED` 保证 claim 排他；`leaseToken` + `leaseUntil` 守卫的 finalize 条件 UPDATE（`affected≠1` → `StaleOutboxOwnerError` → 整体回滚）；`markFastPathDelivered` 带「无活跃租约」谓词。**订阅方必须自身幂等**（文档已声明 at-least-once 语义）。 |
| **证据** | `outbox-dispatcher.service.ts:348–367`（claim CTE）、`:508`（markDispatched 条件）、`:568`（失败路径 finalize 条件）、`:579`（`affected !== 1` 抛错） |
| **可执行证明** | 现有脚本：`scripts/arch31-outbox-claim-selftest.mjs`（7/7，文档称 2026-09-26 复跑）、`scripts/arch31-outbox-duplication-selftest.mjs`（13/13）。本轮**未跑**（需 docker）。 |
| **结论** | ✅ 机制成立。**残余**：投递的 at-least-once 需订阅方幂等——本仓已有 `WebhookDeliveryService` 的 `INSERT ... ON CONFLICT (scope, deliveryKey) DO UPDATE ... WHERE expiresAt < now()`（`webhook-delivery.service.ts:99`）+ 唯一索引 `uq_webhook_deliveries_scope_delivery_key`（entity `:39`）——**但那是 CI→admin-api 的入向幂等，不是出向**。出向订阅方是外部系统，无法保证。 |

#### P-5：⭐ 部署触发与定时触发竞态（webhook 滚动升级 × upgrade-all）

| 项 | 内容 |
|---|---|
| **触发源** | ① `application.controller.ts:749` webhook → `running.map(d => deploymentSvc.upgrade(d.id))`；② `upgradeAllWithRollout` → `upgrade(d.id)`；③ `deployVersion` → `collectVersionDispatch` → `upgrade` |
| **双发原因** | 三条路径**都调同一个 `upgrade()`，而 `upgrade()` 没有任何「该行是否已在 upgrading」的守卫**——它直接 `deployment.status = UPGRADING; saveWithOptimisticLock(deployment)`。`@VersionColumn` 乐观锁只保证**不互相覆盖**，不保证**不重复执行**。 |
| **幂等性** | ❌ **否**（在「同一行被两次 upgrade」的语义上） |
| **靠什么保证** | **N / A**。`upgrade()` 的 `saveWithOptimisticLock` 抛 409 只在**并发同写**时生效：<br>· 路径 ① 与 ② 若**同时**对同一行 upgrade → 乐观锁冲突 → 其中一个 409 ⇒ **互斥成立**（但对 webhook 路径是 `Promise.allSettled` + catch 吞掉 ⇒ 静默失败一半）。<br>· 路径 ① 与 ③ **串行**（人工先 webhook 后点 deploy-version）→ 两次 upgrade 都成功 → **执行器收到两次 deploy 命令**。执行器侧 `deploy.ts:1421` `if (upgrade && runningApps.has(deploymentId))` 会先停旧进程再启新的 ⇒ **不是双进程**，但会**多一次停机+启动**。 |
| **证据** | `app-deployment.service.ts:2019–2084`（`upgrade()` 无状态守卫）；`application.controller.ts:749–763`（webhook 路径 `Promise.allSettled` + `.catch` 吞错）；`executor-node/src/routes/deploy.ts:1421`（执行器侧 upgrade 时先停旧进程） |
| **可执行证明** | **新增 spec 场景 S-P5-1**：对同一 `deploymentId` 连续调两次 `upgrade()`（不并发）→ 断言 `pushDeployToExecutor` 被调用 **2 次**（当前行为）。修复后应断言 1 次，或断言第 2 次返回 409/幂等成功。 |
| **根治方案** | 部署域加**行级条件 UPDATE 占坑**：`UPDATE app_deployments SET status='upgrading' WHERE id=:id AND status='running'` —— `affected=0` 即「已在 upgrading / 不可升级」，直接 409。这把「重复 upgrade」变成**结构上不可能**（S 档）。与 §4.5 方案 D 合并。 |

#### P-6：手动 trigger 与窗口边界

| 项 | 内容 |
|---|---|
| **触发源** | `TaskService.trigger()`（手动/API/webhook/依赖） |
| **双发原因** | 手动触发**不受维护窗口约束**（`scheduler.service.ts:2380` 头注：「手动/API 触发与依赖扇出走 `TaskService.trigger`，不受窗口约束」） |
| **幂等性** | ✅ 是（就「同一手动动作被提交两次」而言）——`acquireTriggerGateLockOrThrow`（Redis 锁 + 参数摘要）+ `applyBlockStrategyGate`（同参在跑/排队 ⇒ cover/discard） |
| **靠什么保证** | **A（应用层）**：`task.service.ts:3146–3176`（Redis 锁，fail-open）+ `block-strategy-gate.ts` |
| **残余** | 锁是 Redis 的、TTL 5s、**fail-open**（`:3164`）⇒ Redis 抖动时无互斥；`blockStrategy` 闸只对 `SERIAL` 之外的策略有约束力；**且锁释放后闸门窗口即失效**（`finally` 里 release，行已落库）。这与 P-3 叠加：手动触发既不推进 `lastTriggerTime`，也不参与 claim。 |
| **可执行证明** | 现有 spec：`task.service.spec.ts`（blockStrategy 闸）。**建议新增**：Redis 不可用时并发两次 `trigger()` → 断言落库 2 行（当前行为，暴露 fail-open 窗口）。 |

#### P-7：⭐ 同应用并发灰度批次（S-7 的展开）

| 项 | 内容 |
|---|---|
| **触发源** | `upgradeAllWithRollout`（canary） |
| **双发原因** | `findInFlightRolloutRows`（`:3362`）读判 → `markRolloutState(PENDING)`（`:3445`）写之间**无原子占坑** |
| **幂等性** | ❌ **否** |
| **靠什么保证** | **N**——`claimRolloutRows`（`:3653`）只在**失败终结**时用，**批次创建时没有对应 claim** |
| **实证判据** | 若两实例同时开灰度：两批次各自 `batchId` 不同；`markRolloutState` **覆盖**同一行的 `rolloutMeta.batchId`（`:3513` 是无条件 `update({id}, {rolloutState, rolloutMeta})`，只写痕迹列、**无状态守卫**）⇒ **先写者的 batchId 被后写者覆盖** ⇒ 先写者的 `finishBatch`/`failBatch` 用自己的 `batchId` 结算，但行上的 `rolloutMeta.batchId` 已是另一个 ⇒ 读面显示错乱；且**两批次各自对全部 canary 行调 `upgrade()`** ⇒ 同一行被两次 upgrade（P-5） |
| **可执行证明** | **新增 spec 场景 S-P7-1**：mock 仓储使 `findInFlightRolloutRows` 对实例 A、B **都返回空**（模拟竞态窗口）→ 并发调两次 `upgradeAllWithRollout(appId, {strategy:'canary'})` → 断言（当前）两次都返回 `ok:true` 且 `upgrade` 被调 2 次。**修复后**断言第二次返回 `ok:false` + `blockedReason`。<br>**SQL 断言**：`SELECT count(DISTINCT "rolloutMeta"->>'batchId') FROM app_deployments WHERE "applicationId"=:appId AND "rolloutState" IN ('pending','probing')` = 1。 |
| **根治方案** | **新增 DB 层「批次占坑」唯一约束**（见 §4.5 方案 E）。这是**结构性**修法：把「同应用至多一个在途批次」从应用层读判变成 DB 部分唯一索引。 |

#### P-8：部署 `deploy()` 双开进程（S-6 的展开）

| 项 | 内容 |
|---|---|
| **触发源** | `deploy()`（`:1333`） |
| **双发原因** | 部分唯一索引 `uq_app_deployments_application_in_flight` **只约束 `status IN ('pending','deploying')`**（migration `1789000000000`），**不约束 `upgrading`**。应用层守卫（`:1352`）也只查 `PENDING/DEPLOYING/UPGRADING`——但那是**读后判**（findOne 然后 insert），**TOCTOU 窗口存在**：两个并发 deploy 请求可同时通过 findOne，各自 insert 一条 `pending` 行 ⇒ 唯一索引会拦下**第二条** ⇒ ✅ 这一段是安全的（唯一索引兜底）。<br>但 **`upgrade()` 路径**（P-5/P-7）：`upgrade` 不新建行（复用行），所以唯一索引不参与 ⇒ 同应用多行 `upgrading` 是**允许的**（这是 R5 的刻意设计：「并发滚动升级不相互触发唯一冲突」）⇒ 两个实例各自 `upgradeAll`（all 策略，**绕过 P-7 的 canary 互斥**）⇒ **两台真实进程同时被要求升级**。 |
| **幂等性** | ❌ 对「同应用同时只有一个升级在途」这个性质：否（设计如此） |
| **靠什么保证** | **无**——`upgradeAllWithRollout` 的 `strategy='all'` 分支（`:3394`）**没有批次互斥**（只有 canary 分支有），且 `upgrade()` 无行级占坑 |
| **证据** | `app-deployment.service.ts:3394–3411`（all 分支直接 `Promise.allSettled(targets.map(d => this.upgrade(d.id)))`）；migration `1789000000000` 的 `WHERE "status" IN ('pending', 'deploying')` |
| **可执行证明** | **新增 spec 场景 S-P8-1**：同应用两行 `running`，并发调两次 `upgradeAllWithRollout(appId, {strategy:'all'})` → 断言 `upgrade` 被调 4 次（2 行 × 2 次），当前无守卫。 |

#### P-9：leader 切换瞬间的双 Leader（门禁保护的任务重复执行）

| 项 | 内容 |
|---|---|
| **触发源** | `LeaderGateService` / `SchedulerService` 的 leader 切换 |
| **双发原因** | ① **fail-open 期间每个实例都是 Leader**（`leader-gate.service.ts:118–130` catch 分支 `this.leader = true`）；② `verifyLeadership` catch 分支**保留租约**（`:159–163` 只记 debug）⇒ 一次 Redis 抖动不会 demote，但若 Redis 真挂，watchdog 连失 3 次（`REDIS_LOCK_WATCHDOG_MAX_CONSECUTIVE_FAILURES=3`）停表 ⇒ 锁 30s 后自然过期 ⇒ 另一实例拿锁 ⇒ **两个实例同时认为自己是 Leader**（前者仍 `leader=true` 直到下次 verify 失败） |
| **幂等性** | ❌ 对非幂等任务：否 |
| **靠什么保证** | **A**——门禁保护的任务大多是幂等清扫（幂等 DELETE / 条件 UPDATE）。**但 `agent-trigger.scheduledWatch` 创建 Agent 会话 + 消耗 LLM 配额**（非幂等副作用） |
| **证据** | `leader-gate.service.ts:118–130`（fail-open）、`:149–164`（verify catch 保留租约）、`redis-lock.service.ts:25`（watchdog 3 次）、`agent-trigger.service.ts:402–430` |
| **可执行证明** | **新增 spec 场景 S-P9-1**：`leader-gate.service.spec.ts` 里 mock `acquireLock` 抛错 → 断言 `isLeader === true`（当前行为，fail-open 文档已声明）。**新增 S-P9-2**：mock `extendLock` 连抛 → 断言 `isLeader` 在 ≤TTL 内**仍为 true**（当前行为）。<br>**SQL 断言**（多实例）：`SELECT count(*) FROM agent_sessions WHERE "createdAt" > :windowStart AND "triggerSource"='cron'` —— N 个实例 ⇒ 应为 1。 |
| **根治方案** | 见 §4.5 方案 F（引入 **fencing token** 或把非幂等任务从门禁迁出到「DB 唯一占坑」）。 |

#### P-10：cron 定时器「注册即从注册时刻起算」的落点漂移

| 项 | 内容 |
|---|---|
| **触发源** | `node-cron.createTask`（`:2755`）——`getNextMatch` 从**注册时刻**起算 |
| **双发原因** | Leader 切换后新实例 reload 注册 → 注册时刻偏移 ⇒ 某些落点被跳过（**漏发**，不是重发）；某些实例旧注册仍在 ⇒ 与新注册**相位不同** ⇒ 同一落点附近两次 fire（间隔 > 1s 去重窗口 ⇒ **claim 拦不住**） |
| **幂等性** | ❌ |
| **靠什么保证** | **无**——`claimTaskTrigger` 的窗口对 CRON 只有 1s |
| **证据** | `scheduler.service.ts:2755`（createTask）+ `computeTriggerDedupTtlMs` 对 CRON 恒 1s（`:425–427`） |
| **可执行证明** | **新增 spec**：把 cron 表达式设为每分钟，mock `claimTaskTrigger` 恒返回 true（模拟去重窗口过期），并发调两次 `enqueue`（间隔 2s）→ 断言落库 2 行（当前行为）。 |
| **根治方案** | 把 CRON 的去重窗口从「1s 固定」改为「**按 cron 真实周期的一小段**」（与 FIXED_RATE 分支对齐）。⚠️ 风险：周期 < 1s 的 cron 不存在，但分钟级 cron 用 1s 窗口意味着「同一分钟内两次 fire」（如注册相位差）会双派。**这是本域最值得修的一处**，且是纯结构性改动（改 `computeTriggerDedupTtlMs` 的 CRON 分支 + claim 窗口同源）。 |

### 4.2 汇总表

| 路径 | 幂等 | 强度 | 靠什么 | 证据位置 | 重复会否真发生 |
|---|---|---|---|---|---|
| P-1 cron 定时触发 | ✅ | **S** | `claimTaskTrigger` 条件 UPDATE | `scheduler.service.ts:2603` | 否 |
| P-2 cron 注册重叠 | ✅ | A + S | `schedulingTasks` + 指纹表 + claim | `:2666, :2671, :578` | 否 |
| **P-3 FIRE_ONCE 补偿** | ❌ | **N** | 无 | `task.service.ts:2958`（不写 lastTriggerTime）+ `scheduler.service.ts:1130` | **会**（手动跑过 + 窗口内无定时触发） |
| P-4 outbox 重投 | ⚠️ | S（投递次数）| SKIP LOCKED + leaseToken | `outbox-dispatcher.service.ts:348, 568` | 部分（at-least-once） |
| **P-5 部署触发竞态** | ❌ | **N/A** | 乐观锁只防覆盖不防重复执行 | `app-deployment.service.ts:2019` | **会**（串行两次 upgrade） |
| P-6 手动 trigger 窗口 | ✅ | A | gate lock + blockStrategy 闸 | `task.service.ts:3146` | 偶发（Redis 抖动 fail-open） |
| **P-7 并发灰度批次** | ❌ | **N** | 无（读后判） | `app-deployment.service.ts:3362` | **会** |
| **P-8 deploy 双开进程** | ⚠️ | S（deploy 路径）/ **N**（upgrade 路径）| 部分唯一索引（不含 upgrading） | migration `1789000000000` | **会**（all 策略并发 upgrade-all） |
| **P-9 leader 切换双 Leader** | ❌ | A | fail-open + 幂等清扫假设 | `leader-gate.service.ts:118` | **会**（非幂等任务） |
| **P-10 cron 去重窗口 1s** | ❌ | **N** | 无 | `scheduler.service.ts:425` | **会**（相位差 > 1s） |

### 4.3 A1 的可拍板结论（给父 agent / 决策人）

**A1 的选项**：① 保持现状（严格 cron 语义）；② 补偿前查「窗口内有无执行」（运维语义）；**③（本轮新增，建议）**：**补偿前查「窗口内有无执行」，但只查「非手动执行」或「任意执行」由产品定**——并**同时**把手动触发也纳入 claim 体系。

**本轮给出的证据**：
- A1 的**原始表述不准确**：「手动跑过一次之后补偿扫描仍可能再补派一次」——实际是「手动跑过**不推进 `lastTriggerTime`** ⇒ 补偿判据 `gap > 2×周期` 持续成立 ⇒ 补偿**反复尝试**（被 `:1116` fresh 复核 + `:1130` 落点校验拦住，**多数情况不真的重复执行**）」。
- **真正会重复执行的那一条**：手动触发发生在 cron 落点之后、且 `lastTriggerTime` 尚未被任何定时触发推进（服务刚重启 / 长期无定时触发）⇒ 补偿判据与落点校验**双双成立** ⇒ **补偿入队 ⇒ 手动 + 补偿 = 同一窗口跑两次**。这条**无任何幂等机制**。
- 补偿路径**已不查窗口内有无执行**——确认 `checkMisfiresBody` 内**没有** `task_executions` 查询。

**建议拍板**：**选项 ② 的精确版**——补偿前查「窗口内是否存在**任意来源**的执行（含手动）」；命中即视为已覆盖、不补偿。代价 = 每候选多一条索引查询（`task_executions` 上有 `taskId` 索引）。
**理由**：
1. 「运维语义」在本域更重要——用户手动跑过一次后再被系统补跑一次，用户会认为是 bug（且对日报类任务会造成数据时序错乱，这正是 `auditMissedFirePoints` 不补偿的理由，`scheduler.service.ts:975–995`）。
2. 代价可控：一次索引查询，远小于重复执行的业务代价。
3. 与 `auditMissedFirePoints` 的既定口径一致（「默认只告警、不自动补跑；补偿仅对显式 opt-in 生效」）——把「人已经跑过了」也算作已覆盖，是同一条逻辑的延伸。

**替代修法（更结构化，推荐作为阶段 2 的落地形态）**：把「窗口内有无执行」做成**DB 层事实**，而不是靠 `lastTriggerTime` 间接推断——新增 `tasks.lastExecutionAt` 列，由 `TaskService.trigger()` 与 `claimTaskTrigger()` **都**推进；补偿判据改为 `gap = now - lastExecutionAt`。这样：
- 手动触发**也推进** claim 序列 ⇒ 手动与定时**共用同一条去重权威** ⇒ P-3 与 P-6 的 fail-open 窗口一并收敛。
- 需注意副作用：`lastTriggerTime` 目前还被 `claimDependencyTrigger`（`task.service.ts:5184`）复用（副作用 2 已在其注释中登记），改列会影响依赖扇出的去重窗口（10s）——**必须一并评估**。

### 4.4 `LeaderGateService` 实现质量评估

**实现摘要**（`apps/admin-api/src/common/leader-gate/leader-gate.service.ts`，197 行）：
- 锁 key：`lock:cron:leader`（`CRON_LEADER_LOCK_KEY = "cron:leader"`，`:14`），**与 `lock:scheduler:leader` 独立**（刻意，见 §3 D-6）。
- TTL：**30s**（`CRON_LEADER_TTL_MS`，`:17`）——**注意与 scheduler 的 90s 不同款**（文档 §3.8 说「同款」是过时的）。
- 续租：`RedisLockService` 内建 watchdog，TTL/3 周期续期，**连续 3 次失败停表**（`REDIS_LOCK_WATCHDOG_MAX_CONSECUTIVE_FAILURES = 3`，`redis-lock.service.ts:25`）。
- 归属校验：`verifyLeadership` 每 **TTL/2 = 15s** 调 `extendLock`（同一 lockId 才成功）——**成功即续期**（探针兼续期）。
- 竞选失败重试：**15s**（`CRON_LEADER_RETRY_MS`，`:20`）。
- 释放：`onModuleDestroy` best-effort `lock.release()`（`:81`）。

**正确性评估**

| 维度 | 判定 | 依据 |
|---|---|---|
| **锁续租** | ⚠️ **可失效** | watchdog 连续 3 次失败即停表（`redis-lock.service.ts:246`）；续期失败 3 次 ≈ 30s（TTL/3 × 3）≈ TTL。**锁自然过期后，本实例仍 `leader=true`**（直到 `verifyLeadership` 的 `extendLock` 返回 false → `demote`，最多再等 15s）。⇒ **最长 ~45s 的双 Leader 窗口** |
| **fail-open 脑裂** | 🔴 **确认存在** | `tryAcquireLeadership` 的 catch 分支（`:118–130`）`this.leader = true; this.leaderLock = null`——**Redis 挂 ⇒ 每个实例都是 Leader**。文档已声明此为「有意为之」，代价是「重复执行幂等清扫」。**但门禁保护的任务里并非全是幂等清扫**：`agent-trigger.scheduledWatch` 创建 Agent 会话（`agent-trigger.service.ts:402`）——虽然它走 scheduler 门禁而非 cron 门禁，但**同款 fail-open 逻辑**在 `SchedulerService` 里同样存在 |
| **fail-open 恢复后的让位** | ✅ **有** | `:110–112`：「fail-open 期间其他实例已真正拿到锁——让位，避免双 Leader」。但**只在 `this.leader && !this.leaderLock` 时**触发；若本实例已持有真实锁（`leaderLock != null`）而 Redis 恢复后另一实例抢到锁，**本实例不会主动让位**——要等 `verifyLeadership` 的 `extendLock` 返回 false（lockId 不匹配 ⇒ 0）⇒ `demote`。**这条路径是对的**（lockId 校验） |
| **时钟漂移** | ⚠️ **存在但有界** | Redis 用 `gettimeofday`（非单调钟）判 TTL（Redis 官方文档明确列为已知风险）；NTP 回拨会让锁**提前过期** ⇒ 双 Leader。Kleppmann 的经典论证（§6 表 #6）。**缓解**：锁 TTL 30s + verify 15s ⇒ 漂移需 >15s 才致命 |
| **网络分区** | 🔴 **无 fencing** | 持有者被隔离时锁在 30s 后过期、另一实例接管；原持有者恢复后**仍认为自己是 Leader**（直到 verify 失败）⇒ 两条路径同时写。**Redis 锁本身没有 fencing token**（Kleppmann 明确指出 Redlock 不产生单调递增 token）⇒ **必须由下游 DB 条件写兜底** |
| **崩溃后永久卡死** | ✅ **不会** | 锁有 TTL，30s 后自动释放；`onModuleDestroy` 主动 release 加速 failover。**无「永久卡死」** |
| **门禁缺失** | ⚠️ **可选注入** | `leaderGate` 是 `@Optional()`（`app-deployment.service.ts:330`）⇒ **单测/裁剪装配下门禁静默失效**。生产装配 `@Global LeaderGateModule` 恒提供。**`scripts/check-cron-leader-gate.mjs` 用文本判据强制所有 @Cron 有门禁**（26/26 ✅）——这是很强的守卫 |
| **门禁 idiom 不统一** | ⚠️ | 三种写法并存：`this.leaderGate.isLeader` / `this.isLeader` / `this.isSchedulerLeader()`。守卫脚本已按三选并集判定，但**语义不同**：① cron 门禁（`cron:leader`）；② scheduler 门禁（`scheduler:leader`）；③ `sop.service.ts:1527` 用 `isSchedulerLeader()`。**「哪些 @Cron 受哪把锁保护」无统一台账** |

**改进方案**

| 方案 | 内容 | 影响面 |
|---|---|---|
| **L-1（推荐，P1）** | **把 `cron:leader` 的 TTL 从 30s 提到 90s**，与 `scheduler:leader` 对齐（2026-10-28 事故的教训：事件循环冻结 28–40s 会打穿 30s TTL）。`leader-gate.service.ts:17` 一行 | **极小**（1 常量 + 单测断言）。但会**同时**拉长 fail-open 恢复时间与双 Leader 窗口 ⇒ 需与 L-2 同批 |
| **L-2（推荐，P1）** | **verify 失败计数化**：把 `verifyLeadership` 的「一次失败即 demote」改为「连续 N 次（建议 2，与 `SCHEDULER_LEADER_VERIFY_MAX_FAILURES=2` 同款）才 demote」，并把 `extendLock` 的 catch 分支**计入失败数**（当前 catch 只记 debug 并保留租约 ⇒ Redis 抖动期最长 30s 双 Leader） | 小（`leader-gate.service.ts:149–164`，与 `scheduler.service.ts:766–795` 同款写法可直接对齐） |
| **L-3（推荐，P2）** | **引入 fencing token**：锁值从随机 `lockId` 改为「单调递增 epoch」（Redis `INCR lock:cron:leader:epoch`）。下游写面（DB 条件 UPDATE）带 `WHERE epoch < :myEpoch` 或把 epoch 写入行。⚠️ **成本高**：本仓的 DB 写面没有 epoch 列 ⇒ 要改所有门禁任务的写路径 ⇒ **不建议现在做**，应改为 §4.5 方案 F（把非幂等任务迁出锁的保护范围） |
| **L-4（推荐，P2，零风险）** | **把非幂等副作用的任务从 leader 门禁迁到「DB 唯一占坑」**：`agent-trigger.scheduledWatch` 改为「先 `INSERT INTO agent_watch_slots (slot, day) ... ON CONFLICT DO NOTHING` 成功才开会话」⇒ 结构上不可能重复，**与 leader 无关** | 中（新增 1 表 + 1 迁移 + `agent-trigger.service.ts` 改 5 行） |
| **L-5（P3）** | 统一门禁 idiom 为 `this.leaderGate.isLeader`（cron 锁），把 `isSchedulerLeader()` 的 2 处也纳入统一台账；`check-cron-leader-gate.mjs` 增加「锁类型」断言 | 小 |
| **L-6（文档）** | 修正 `ARCH-MULTI-INSTANCE-MATRIX.md` §3.8 的「TTL 30s 同款」（已不同款）与「两类任务均为幂等清扫」（`agent-trigger` 不成立） | 文档 |

---

## §5 补丁 vs 重构对比（五维评分表）

> 评分 1（差）~ 5（好）。「长期收益」= 未来 12 个月减少的缺陷/返工；「短期成本与风险」= **分数越高表示成本越高/风险越大**（注意方向）。

### 方案 A：纯补丁（文档修正 + 局部条件写 + 幂等键）

| 维度 | 评分 | 说明 |
|---|---|---|
| 长期收益 | **3** | 只修已发现的 7 条漂移 + 3 条路径（P-3/P-7/P-8），不改变「状态机三套并存」的结构债 |
| 维护成本 | **4** | 每次修都加条件写/幂等键，**方法越来越长**（`app-deployment.service.ts` 已 4544 行） |
| 扩展潜力 | **2** | 新约束（幂等键表、批次占坑表）继续以「补丁」形态堆叠，无统一抽象 |
| 技术债风险 | **3** | 不新增债，但**不降债**；`app-deployment.service.ts` 继续膨胀（dispatch-core 域已在拆 `executor.service.ts` 的 8488 行） |
| 短期成本与风险 | **2**（低） | 改动面小、可灰度；但**不解决根因** |

**结论**：短期成本低，但**长期收益 < 短期成本不成立**（3 vs 2 只是勉强），且**遗留 P-5/P-8/P-9/P-10 四条路径未解**。

### 方案 B：重构（拆分部署域 + 结构化幂等原语）

| 维度 | 评分 | 说明 |
|---|---|---|
| 长期收益 | **5** | 把「幂等」从散落条件写升级为**统一原语**（幂等键表 + 条件 UPDATE 占坑 + 唯一索引）；把三套状态机收敛为一套；把部署约束从派发内核剥离（配合 dispatch-core 域） |
| 维护成本 | **2** | 需要把 4544 行按 9 组（G1–G9）拆到 5–6 个 service；回归面 9 个 spec + 20 个引用文件 |
| 扩展潜力 | **5** | 新部署形态（多租户 / 分区 / 版本跟随）有明确扩展点；派发内核不再被部署逻辑绑住 |
| 技术债风险 | **4** | 拆错边界的风险；但**有 guard**：现有 9 个 spec + 4 个 arch31 真机脚本可作 golden |
| 短期成本与风险 | **5**（高） | 大；且需与 dispatch-core 域协同排期 |

**结论**：长期收益 5 ≫ 短期成本（反向计分），**明确推荐重构**——但**不应一次性做**。

### 推荐：混合路径（**B 的骨架 + A 的止血**，分三阶段）

| 阶段 | 内容 | 依据 |
|---|---|---|
| **阶段 1（止血，1–2 周）** | P0 结构性修复：① `upgrade()` 加行级条件 UPDATE 占坑（`WHERE status='running'`）；② canary 批次创建加 DB 部分唯一索引（`uq_app_deployments_rollout_in_flight`）；③ A1 按选项②实施；④ CRON 去重窗口从 1s 改为按周期；⑤ L-1/L-2（leader TTL 90s + verify 计数） | 每项都是**结构性**修法（S 档），改动面 < 100 行 |
| **阶段 2（域内重构，3–4 周）** | 拆 `app-deployment.service.ts` → `DeploymentLifecycleService`（G4/G6）/ `DeploymentRolloutService`（G8）/ `DeploymentVersionService`（G2/G3）/ `DeploymentQueryService`（G1/G7）；三套状态机收敛为**一张 `deployment_state` 枚举 + 一张状态迁移表** | 与 dispatch-core 域的 `executor.service.ts` 拆分**并行但不互相阻塞** |
| **阶段 3（边界重划，与 dispatch-core 协同，2–3 周）** | 部署约束从 `executor.service.ts` 剥离成 `DeploymentConstraintProvider`（见 §6）；派发内核只消费一个**纯数据**契约 | 见 §6 |

**【临时补丁，后续排期重构】标注**：
- **P-5（重复 upgrade）** 在阶段 1 之前可用「应用层 `upgrade()` 开头查 `status === UPGRADING` 则 409」的**临时补丁**兜住——但这是 TOCTOU（A 档），**必须标注【临时补丁，后续排期重构】**，且不得作为长期方案。
- **P-9（leader 脑裂）** 的 **L-3（fencing token）** 判定为**成本过高**，本轮**不做**；改用 **L-4（DB 唯一占坑）** ——**【临时补丁，后续排期重构】**标注适用于 `agent-trigger.scheduledWatch` 这类**非幂等**任务在其被迁出前。

---

## §6 开源参考清单

> License 均**亲自核对**（本地副本 `LICENSE` 文件或 `raw.githubusercontent.com` 拉取）。**本仓 AGPL-3.0-only** ⇒ **严禁照搬协议不兼容代码**；下表「可复用点」一律为**模式/思路**，不是代码。
> 特别说明：Redlock 争议**如实记录双方**（Kleppmann 批评 vs antirez 反驳），不做单方裁决。

| # | 项目 | 仓库地址 | License | 核心亮点 | 可复用点（对本仓） | 缺陷 / 已知争议 | 适配成本 |
|---|---|---|---|---|---|---|---|
| 1 | **Temporal** | https://github.com/temporalio/temporal | **MIT**（本地副本 `temporal-main/LICENSE` 首行 "The MIT License / Copyright (c) 2025 Temporal Technologies Inc."） | ① **Workflow ID 即去重键**（同 ID 的 Start 复用同一 Execution）；② **Event History = 唯一完备载体**，重放靠重演历史而非重跑副作用；③ **确定性要求**（workflow 代码必须无副作用，activity 必须幂等）；④ **Task Queue 抢占 + Worker 抢占超时** | **①「执行 ID = 幂等键」**：本仓 `task_executions.id` 已是事实上的执行身份，但**调度去重复用 `tasks.lastTriggerTime`（一列多义）**——Temporal 的做法是**独立的 execution key 唯一索引**，把「去重」与「上次触发时间」彻底分开（正是 §4.3 建议的 `lastExecutionAt` 独立列的强版本）。**②「重放而非重跑」**：本仓补偿扫描是「检测缺口 → 重新入队」，Temporal 是「按事件历史重演到目标状态」——语义更强但成本高，本仓不必照搬 | **重量级**：需要持久化工作流引擎 + 额外基础设施（Temporal Server / Cassandra / ES）；本仓已有 PG + BullMQ + Redis，**引入 Temporal 是重写而非增强**。且 Temporal 的价值主要在「长流程编排」，本仓的 cron + 部署是**分钟级短流程** | **L**（**不建议引入整套**）。**只借 2 点思想**：① 独立幂等键列 + 唯一索引；② 「重放优先于重跑」的补偿心智 |
| 2 | **Hatchet** | https://github.com/hatchet-dev/hatchet | **MIT**（本地副本 `hatchet-main/LICENSE` 首行 "MIT License / Copyright (c) 2023-present Hatchet Technologies Inc."） | ① DAG 编排 + **节点级幂等键**（`node_id`/`branch_id` 世代，**旧世代写入被拒**）；② 失败原因**透传给下游节点**（`task errors` 传给 on-failure task）；③ Worker 抢占 + 心跳租约 | **①「世代（generation）拒绝旧写入」**：本仓 `scheduler.service.ts` 的 `runGeneration`（`:2780`/`:834`）已经是同款思想，但**只在进程内**——Hatchet 把世代**落库**并让**写入面**拒绝旧世代。→ 对应本仓 §4.5 方案 F 的「fencing」轻量版：**把 epoch 落库**（如 `app_deployments.rolloutMeta.epoch`），旧世代的 `markRolloutState` 条件写被拒 | ① **本仓的 agent 编排对标结论**（本地 `hatchet-main.review.md` §2.5 / M10）已判定 Hatchet 在若干处**不如本仓**（失败原因传递已是本仓领先项）；② 引入需要其 Server + 引擎 | **M**（只借「世代落库 + 旧世代写入被拒」这一个点） |
| 3 | **Celery Beat** | https://github.com/celery/celery | **BSD-3-Clause**（`raw.githubusercontent.com/celery/celery/main/LICENSE` 核实："Celery is licensed under The BSD License (3 Clause)"；注：**文档部分为 CC BY-SA 4.0**，代码才是 BSD-3） | ① **持久化调度条目**（beat schedule 存 DB / shelve，不是进程内 timer）；② **`last_run_at` 推进语义**（每个条目自带上次执行时刻）；③ misfire 由 `max_loop_interval` + `PersistentScheduler` 的 `sync()` 收敛 | **⭐ 最贴合本仓的一条**：Celery Beat 的条目模型 = **「调度条目自带 `last_run_at`」**。本仓 A1 的根因正是 `lastTriggerTime` **一列承担三义**（定时触发 / 依赖扇出 / 手动）。Celery Beat 的形态是**每条目独立字段 + 持久化**，天然避免「手动触发污染调度进度」。→ 直接支撑 §4.3 建议的 `tasks.lastExecutionAt` 独立列 | ① **Celery Beat 的 `last_run_at` 也有同样问题**（手动触发不推进它 ⇒ misfire 补跑）——**Celery 并不解决这个问题**，所以「直接抄 Celery」不解决问题；② Celery 的 persistent scheduler 是**单进程**的，多实例需额外分布式 beat 锁 | **S**（只借**数据模型**，不引依赖） |
| 4 | **Quartz** | https://github.com/quartz-scheduler/quartz | **Apache-2.0**（`raw.githubusercontent.com/quartz-scheduler/quartz/main/LICENSE.txt` 核实） | ① **集群调度**（JDBC JobStore 的 `SELECT ... FOR UPDATE` 行锁 + `LOCK_STATE`）；② **misfire 策略显式枚举**：`MISFIRE_INSTRUCTION_DO_NOTHING` / `FIRE_NOW` / `FIRE_ONCE_NOW`；③ Trigger 持久化 + 恢复 | **⭐「misfire 策略作为显式枚举」**：本仓 `MisfireStrategy` 只有 `IGNORE` / `FIRE_ONCE`（`task.entity.ts:82`）——**没有「告警但不补跑」这一档**（而 `auditMissedFirePoints` 事实上就在做这件事！`:975–995`）。**Quartz 的三档模型能解释本仓的分裂**：`checkMisfires`（FIRE_ONCE 补偿）与 `auditMissedFirePoints`（只告警）是**两条独立 cron**，语义重叠。→ 建议把 `auditMissedFirePoints` 的行为并入 `MisfireStrategy` 的第三档 `NOTIFY` | ① Quartz 的 misfire 语义**绑定于 trigger 的持久化状态**，与「窗口内有无执行」无关——**同样不解决 A1**；② JDBC JobStore 与本仓 TypeORM/PG 集成成本高 | **M**（借**枚举模型**：把 `auditMissedFirePoints` 并入 `MisfireStrategy.NOTIFY`，消除两条 cron 的语义重叠） |
| 5 | **DBOS Transact** | https://github.com/dbos-inc/dbos-transact-py | **MIT**（`raw.githubusercontent.com/dbos-inc/dbos-transact-py/main/LICENSE` 核实："MIT License / Copyright (c) 2024 DBOS, Inc."） | ① **工作流步骤与业务写同事务**（step 的 DB 写与 workflow 状态写**同一事务**提交 ⇒ 结构上不可能「状态写了但副作用没做」）；② **幂等键 = workflow ID**；③ 中断后**从 DB 恢复**而非重跑 | **⭐⭐ 最贴合本仓「根治方案」的一条**：DBOS 的核心纪律是「**状态迁移与副作用同事务**」。本仓的 `deploy()` 是「`repo.save()` 落行 → 异步 `pushDeployToExecutor`」——**两者不在同一事务**（`:1455+` 异步 fire-and-forget），崩在中间就是「行在 PENDING、命令未发」（这正是 `DEPLOYMENT_PENDING_TIMEOUT_MS` 5min 卡死扫描要处理的现象，`app-deployment.service.ts:3058`）。DBOS 的形态能**结构上消除**这个窗口：要么「行 + 命令入队」同事务，要么「都不发生」 | ① 需要 DBOS 的 workflow 运行时（本仓是 NestJS + BullMQ）；② 只借**纪律**不引框架 | **S**（借**纪律**：「行状态迁移 + 出站命令入队同事务」——本仓已有 `WebhookDelivery` 的 `INSERT ... ON CONFLICT` 与 outbox 表，**基础设施齐备**，只是部署链没用） |
| 6 | **Redis Redlock** | https://github.com/redis/redis-doc（算法文档）<br>实现示例清单见 https://redis.io/docs/latest/develop/clients/patterns/distributed-locks/ | **BSD-3-Clause**（redis-doc 仓库）/ 各实现各异 | ① 单实例正确形态：`SET resource_name <random> NX PX 30000` + **Lua 条件删**（`GET == my_random_value` 才 `DEL`）；② Redlock：N=5 独立 master，**多数派 + 时限内**才算拿到锁；③ 锁扩展（extend） | ① **「释放必须校验归属」**：本仓 `redis-lock.service.ts:296` 的 `releaseLock` 用 Lua `GET == lockId` 才 `DEL`——**已符合**。② **`DELEX ... IFEQ`（Redis 8.4）** 是新原语（文档提到）——本仓 ioredis 版本未知，暂不适用 | **⚠️ 争议（如实记录双方）**：<br>**Kleppmann 批评**（https://martin.kleppmann.com/2016/02/08/how-to-do-distributed-locking.html，2016-02-08）：① Redlock **不产生 fencing token** ⇒ 进程暂停/网络延迟后「旧持有者复活写入」无法被拒；② 依赖**有界网络延迟 / 有界进程暂停 / 有界时钟误差**的**同步系统模型**；③ Redis 用 `gettimeofday`（非单调钟）⇒ 时钟跳变会破坏 TTL 语义；④ 结论：「若正确性依赖锁，请用 ZooKeeper/共识系统；若只求效率，单 Redis 实例足够」。<br>**antirez 反驳**（https://antirez.com/news/101，2016-02-09）：① 「失去互斥」是**所有**自动释放锁的通病，Redlock 也不例外，但可用 **CAS/唯一 token** 而非单调 token 解决（更实用）；② Redlock 只要求「各进程**相对计时速率**大致相同」（如 10 秒算成 9.5~11.2），**不要求绝对时间同步**；③ 进程暂停只影响「能否在 TTL 内完成工作」，**不影响算法正确性**（步骤 1/3 会重新检查时间）；④ 承认「Redis 应改用单调钟 API」是合理建议。<br>**Kleppmann 回应**（同上篇 Update 2016-02-09）：「Salvatore 提出了一些好观点，但我坚持我的结论」。<br>**对本仓的结论**：**本仓的用法属于「效率型锁 + DB 兜底」**（Redis 锁是快筛，`claimTaskTrigger` 条件 UPDATE 是判决）——**这正是 Kleppmann 建议的正确用法**，故**争议对本仓不构成阻塞**。但**不可**把 `cron:leader` 提升为「正确性依赖的唯一保护」 | **S**（无需引入 Redlock；本仓单实例 `SET NX PX` + Lua 条件删已符合正确形态。**不要**为「更安全」而引入 5 节点 Redlock——那会让 Kleppmann 的批评全部适用） |
| 7 | **Kubernetes CronJob** | https://github.com/kubernetes/kubernetes | **Apache-2.0**（`raw.githubusercontent.com/kubernetes/kubernetes/master/LICENSE` 核实） | ① **`concurrencyPolicy`**：`Allow` / `Forbid` / `Replace`——**并发策略是显式声明的一等公民**；② **`startingDeadlineSeconds`**——错过窗口后**直接放弃**（不补跑）；③ **`successfulJobsHistoryLimit` / `failedJobsHistoryLimit`** | **⭐ `concurrencyPolicy: Forbid` 的直接对标**：K8s 的「同一 CronJob 同时至多一个运行中 Job」= 本仓应做的「同应用至多一个在途灰度批次」（§4.5 方案 E）与「同应用至多一个 upgrading 行」（§4.5 方案 D）。**⭐ `startingDeadlineSeconds` = 本仓 `MisfireStrategy` 应有的第三档「超窗放弃」**（现在 `auditMissedFirePoints` 只告警，等于 `startingDeadlineSeconds` 的观测面）。**⭐ `historyLimit` = 本仓 `app_deployment_events` 的保留期**（本仓无限增长，是 §7 阶段 2 的隐性成本） | ① K8s 的 CronJob **依赖 kube-controller-manager 单点 + etcd**，其一致性模型是「controller 是唯一写者」——本仓是**多实例对等**（每个实例都能跑 cron），模型不同，**不能直接照抄**；② K8s 的「补跑」语义（`startingDeadlineSeconds` 之外）依赖 Job 的历史，语义比本仓复杂 | **S**（借**三个枚举/参数的语义**，零依赖） |
| 8 | **etcd / Chubao / Dragonboat**（leader election 家族） | https://github.com/etcd-io/etcd<br>https://github.com/eric8810/chubao<br>https://github.com/lni/dragonboat | etcd: **Apache-2.0**<br>chubao: Apache-2.0<br>dragonboat: Apache-2.0 | ① etcd：**lease + revision**（`CreateRevision` 单调递增，**天然的 fencing token**）；② Chubao：Go 框架，leader election + 分布式锁 + 任务队列；③ Dragonboat：Raft 复制，支持强一致的 leader 与线性一致读 | **⭐ etcd 的 `CreateRevision` = fencing token 的标准答案**（本仓若将来真要做 fencing，不必自造 epoch 生成器）。但**引入 etcd = 引入一套共识系统**，代价远超收益 | ① etcd 运维成本高（本仓已有 PG + Redis）；② Chubao/Dragonboat 是 Go 生态，与 NestJS/TS 不匹配 | **L**（**不引入**）。只记「fencing token 的标准形态 = 单调递增的存储 revision」 |
| 9 | **幂等键 / Hedging 模式** | Stripe: https://docs.stripe.com/api/idempotent_requests<br>Hohpe: "Exactly-Once Semantics are Possible, Here is How" | Stripe API 文档（**非开源代码**，仅模式参考）<br>Hohpe 文章（**非开源代码**，仅概念） | ① **幂等键 = 客户端生成的稳定 ID**（Stripe：`Idempotency-Key` header，服务端存键→响应的映射，重复请求返回**首次响应**）；② **键的作用域**（Stripe 按 endpoint 作用域）；③ **保留期**（键过期后不再去重）；④ Hohpe 的核心论点：**端到端 exactly-once 不可保证，只能靠「消费者幂等 + 至少一次投递」** | **⭐⭐ 本仓已有一处高质量实现**：`WebhookDeliveryService.claim`（`webhook-delivery.service.ts:131`）——`INSERT ... ON CONFLICT (scope, deliveryKey) DO UPDATE ... WHERE expiresAt < now() RETURNING`，配套唯一索引 `uq_webhook_deliveries_scope_delivery_key`（entity `:39`），**原子仲裁**、**有 scope**、**有保留期**、**fail-open 姿态明确**（`:151`）。**这是本仓最值得推广到其它幂等面的范式**：<br>→ §4.5 方案 D（upgrade 占坑）/ 方案 E（批次占坑）/ §4.3 的 `lastExecutionAt` 都应采用**同一范式**（唯一索引 + `ON CONFLICT` 仲裁 + 保留期），而非条件 UPDATE 的变体 | ① 幂等键要求**调用方提供稳定 ID**——本仓的 cron 触发**没有调用方**，必须**服务端生成**（如「taskId + 落点时刻」）；② Stripe 的键存储是**响应缓存**，本仓多数场景不需要重放响应，只需「不重复副作用」⇒ 更轻 | **S**（**推广现有范式**，零新依赖） |

### 6.1 推荐给本项目的模式组合

**(a) cron 在 N 个实例间「每窗口恰好一次」**
- **主**：**服务端生成幂等键**（`taskId` + 计划落点时刻，跨实例**可推导**——同一落点必然同键）+ **唯一索引**（`CREATE UNIQUE INDEX uq_task_fire_slot ON task_executions (taskId, fire_slot)`）+ `INSERT ... ON CONFLICT DO NOTHING`。⇒ **结构上不可能重复**，与 leader 谁在跑无关。
- **辅**：`cron:leader` 只作为**性能优化**（避免 N 实例都去撞唯一索引），**不作为正确性依据**。
- **参考**：Kubernetes `concurrencyPolicy: Forbid` + Stripe 幂等键 + 本仓 `WebhookDeliveryService` 范式。

**(b) 补偿重派而不双派**
- **判据从「时间戳间接推断」改为「事实直接查询」**：补偿前查「窗口内有无执行」（`task_executions` 索引查询），命中即视为已覆盖。
- **更结构化**：新增 `tasks.lastExecutionAt` 独立列，**手动 / 定时 / 依赖**三条路径**都**推进它；补偿判据改为 `now - lastExecutionAt > threshold`。
- **参考**：Celery Beat 的 `last_run_at` **独立于条目**（不是全局一列）+ Quartz 的 misfire 策略显式枚举。

**(c) leader gate 带租约续期且无脑裂**
- **接受「效率型锁 + 结构化兜底」的定位**（本仓已是这个形态，且**与 Kleppmann 的建议一致**）：**Redis 锁只做快筛，正确性由 DB 唯一约束 / 条件写保证**。
- **补三件小事**：① TTL 对齐 scheduler（90s）；② verify 失败计数化（N=2）；③ **非幂等任务迁出锁的保护范围**（改用 DB 唯一占坑）。
- **若将来真需要 fencing**：用 etcd 的 `CreateRevision` 式单调 token + 下游写入拒绝旧 token（Kleppmann 的标准解法）。
- **参考**：Kleppmann（必须配 fencing token）+ antirez（唯一 token 亦可 CAS）+ 本仓 `redis-lock.service.ts` 已合规的「Lua 条件删」。

---

## §7 分阶段路线图

### 阶段 1：止血（1–2 周，全部为结构性修法）

| 编号 | 任务 | 改动 | 影响面 | 验收判据 |
|---|---|---|---|---|
| **1-A** | `upgrade()` 加**行级条件 UPDATE 占坑**：`UPDATE app_deployments SET status='upgrading' WHERE id=:id AND status='running'`（affected=0 ⇒ 409 `APP_DEPLOYMENT_ALREADY_IN_FLIGHT`） | `app-deployment.service.ts:2019` | 1 方法 + 1 错误码 | **新增 spec S-P5-1**：连续两次 `upgrade()` ⇒ 第二次 409，`pushDeployToExecutor` 只被调 1 次。**SQL 断言**：`SELECT count(*) FROM app_deployments WHERE id=:id AND status='upgrading'` = 1 |
| **1-B** | **canary 批次创建加 DB 部分唯一索引**：`CREATE UNIQUE INDEX uq_app_deployments_rollout_in_flight ON app_deployments ("applicationId") WHERE "rolloutState" IN ('pending','probing')` + `markRolloutState` 改**条件写**（`WHERE rolloutState IS NULL OR rolloutState NOT IN ('pending','probing')`） | migration + `app-deployment.service.ts:3362, 3445, 3513` | 1 迁移 + 3 方法 | **新增 spec S-P7-1**：并发两次 `upgradeAllWithRollout(canary)` ⇒ 第二次 `ok:false` + `blockedReason`。**SQL 断言**：`SELECT count(DISTINCT "rolloutMeta"->>'batchId') ... WHERE "applicationId"=:appId AND "rolloutState" IN ('pending','probing')` = 1 |
| **1-C** | **A1 按选项②实施**：补偿前查窗口内有无执行（含手动） | `scheduler.service.ts:1099–1155` | 1 扫描体 + 1 索引查询 | **新增 spec S-A1-1**：窗口内已有手动执行 ⇒ 不补偿。**SQL 断言**：`SELECT count(*) FROM task_executions WHERE "taskId"=:id AND "createdAt" > :windowStart` = 1（修复后） |
| **1-D** | **CRON 去重窗口按真实周期**：`computeTriggerDedupTtlMs` 的 CRON 分支从恒 1s 改为 `clamp(period - 500ms, 1s, period*0.9)`（与 FIXED_RATE 分支同构） | `scheduler.service.ts:425–427` + `estimateCronPeriodMs` | 1 函数 | **新增 spec**：两个实例对同一 cron 任务间隔 2s 各调一次 `enqueue` ⇒ 只 1 行执行。**SQL**：`SELECT count(*) FROM task_executions WHERE "taskId"=:id` = 1 |
| **1-E** | **Leader gate 加固**：TTL 30s→90s；verify 连续 2 次失败才 demote；catch 分支计入失败数 | `leader-gate.service.ts:17, 149–164` | 1 文件 | `leader-gate.service.spec.ts` 补：单次 extendLock 抛错 ⇒ `isLeader` 仍 true；连续 2 次失败 ⇒ demote |
| **1-F** | **文档修正**：更新 `ARCH-MULTI-INSTANCE-MATRIX.md` 的 7 条漂移（§3 D-1…D-13）；更新 `docs/OPEN-DECISIONS.md` A1 为「已决（选项②）」 | 文档 | 2 文件 | `check-cron-leader-gate.mjs` 仍 26/26 ✅ |
| **1-G** | **回滚语义文档对齐**：`docs/rollback-semantics.md` 补「回滚是否回滚数据」的明确说明（见 §8.3） | 文档 | 1 文件 | — |

**阶段 1 验收（整体）**：
```bash
node scripts/check-cron-leader-gate.mjs        # 26/26
node scripts/check-cron-guard.mjs              # 22/22 + 排除面说明
npm test -- app-deployment scheduler task       # 现有 9 + N 个 spec 全绿
npm run test:arch31-multi-instance             # 17/17（需 docker）
npm run test:arch31-rollout                    # 20/20
npm run test:arch31-outbox                     # 7/7
npm run test:arch31-outbox-dup                 # 13/13
```

### 阶段 2：部署域内重构（3–4 周）

| 编号 | 任务 | 说明 |
|---|---|---|
| **2-A** | 拆 `app-deployment.service.ts`（4544 行）→ 4 个 service | `DeploymentQueryService`（G1+G7）/ `DeploymentLifecycleService`（G4+G6）/ `DeploymentRolloutService`（G8）/ `DeploymentVersionService`（G2+G3）。**保留 `AppDeploymentService` 作为 facade**（20 个引用文件零改动）——这是**降低风险的关键**：facade 转发，spec 不用改 |
| **2-B** | **三套状态机收敛**：`status` / `approvalStatus` / `rolloutState` → 一张**状态迁移表**（`deployment_state` 枚举 + 允许的 `(from, to)` 集合），迁移全部走**一条**条件 UPDATE | 消除 §1.3 S-1。需要迁移（数据回填 + 新列），**必须**先写「当前三列组合 → 新状态」的回填脚本并对 15 种组合逐一断言 |
| **2-C** | **`classifyReleaseTrigger` / `resolveReleaseTrigger` 双实现合并**（S-2）：删除文本嗅探版，仅留 `triggerType` 列 + 一次性回填 | `app-deployment.service.ts:982–1009` |
| **2-D** | **`rollbackApplication` / `deployVersion` 同源复制收敛**（S-3） | `:1068–1287` |
| **2-E** | **部署事件表保留期**（对齐 K8s `historyLimit`）：`app_deployment_events` 加保留期 + 清理任务（LeaderGate 门禁 + 分批删除） | 防止无限增长 |
| **2-F** | **幂等原语统一**：把 `WebhookDeliveryService.claim` 的范式（唯一索引 + `ON CONFLICT` + 保留期 + 明确 fail-open）提炼为 `common/idempotency/` 公共件，部署域的 upgrade 占坑 / 批次占坑 / 任务 fire-slot 占坑**全部改用它** | 一处实现，三处使用 |

**阶段 2 验收判据**：
- `app-deployment.service.ts` ≤ **1200 行**（facade + 少量编排）。
- 状态迁移表有**穷举测试**：15 种旧组合 × 目标状态，断言迁移结果唯一。
- `codegraph impact AppDeploymentService -d 3` 从 **170** 降到 **< 60**。
- 现有 9 个 spec **零修改**通过（facade 转发保证）。

### 阶段 3：与 dispatch-core 域的边界重划（2–3 周，协同）

| 编号 | 任务 | 说明 |
|---|---|---|
| **3-A** | **部署约束从派发内核剥离**（见 §8.2）：`executor-deployment-affinity.util.ts`（304 行）+ `executor.service.ts:5890–6060` 的上下文解析 → `application` 域的 `DeploymentConstraintProvider` | 派发内核只消费**纯数据**契约 |
| **3-B** | **`selectLeastLoaded` 补齐 affinity/anti-affinity**（消除 S-4 行为分叉），带 feature flag `executor.selection.affinityEnabled`（默认关） | 与 dispatch-core 域的 D-3 同题，需协同排期 |
| **3-C** | **版本跟随的单一事实源收口**（S-5）：`executor_app_versions`（设备事实）为主，`app_deployments.deployedVersion` 为**显式标注的降级**（读面标 `versionSource: "inferred"`） | 消除「两套并存会打架」的残余 |

---

## §8 风险 + 回滚方案

### 8.1 各阶段风险

| 编号 | 风险 | 概率 | 影响 | 缓解 |
|---|---|---|---|---|
| R-01 | **1-B 的部分唯一索引在存量脏数据上建不起来**（同应用多行 `rolloutState IN (pending,probing)`） | **高**（与 migration `1789000000000` 遇到完全同类问题——那次的注释明确记载过「存量脏数据处理」） | 迁移失败 → 发布卡死 | **照抄 `1789000000000` 的去重前置**（`ROW_NUMBER() OVER (PARTITION BY applicationId ORDER BY createdAt, id)`，保留最早一条，其余置 failed + 说明性 statusMessage）。**必须**在写迁移前先跑一次只读盘点 SQL |
| R-02 | **1-D 改 CRON 去重窗口后，「同一分钟内的合法两拍」被误吞**（如 `0,30 * * * * *` 这类 30s 级 cron） | 中 | 漏触发 | 用 `estimateCronPeriodMs` 算真实周期而非固定值；**对周期 < 10s 的表达式保留短窗口**；新增 spec 覆盖「30s 级 cron 两拍都触发」 |
| R-03 | **1-A 的条件 UPDATE 让「合法的连续 upgrade」也 409**（如运维手动连点两次升级） | 中 | 用户困惑 | 错误文案显式区分「已在升级中（行 id=X, status=upgrading）」；提供 `--force` 逃生（走 `stop` → `deploy`） |
| R-04 | **1-C 让「手动跑过」的 cron 任务**不再**被补偿**——若用户原本依赖补偿来「补跑漏掉的落点」，会感知为漏跑 | 中 | 用户困惑 | ① 补偿日志明确区分「已有人工执行故跳过补偿」；② `auditMissedFirePoints` 的告警面继续提供「这个落点确实没被**定时**触发过」的可见性；③ 观察 2 周再决定是否加 `MisfireStrategy` 新档 |
| R-05 | **2-B 状态机收敛的迁移丢数据**（三列组合映射错误） | 中 | 高 | 迁移**只加列不删列**（新列与旧列并存 ≥ 1 个版本）；回填脚本**幂等 + 可重跑**；对 15 种组合逐一写断言；双写期读新列、写双列 |
| R-06 | **2-A 拆分时 facade 转发引入额外调用层开销**（部署是低频路径，可忽略） | 低 | 低 | 无需处理 |
| R-07 | **3-B `selectLeastLoaded` 补 affinity 后部署选机结果变化** | 中 | 中 | feature flag 默认关；单独 PR；灰度期比对决策日志（与 `dispatch-core.md` R-02 同） |
| R-08 | **阶段 3 的边界重划与 dispatch-core 域的排期冲突** | 中 | 中 | 阶段 1/2 **完全不依赖** dispatch-core 域 ⇒ 可独立推进；只有 3-A/3-B/3-C 需协同 |

### 8.2 回滚方案

| 变更 | 回滚方式 | 耗时 |
|---|---|---|
| **1-A**（upgrade 条件占坑） | revert 单个 commit；**无数据迁移** ⇒ 零风险 | < 5 min |
| **1-B**（批次唯一索引） | `DROP INDEX uq_app_deployments_rollout_in_flight`（migration 的 `down`）+ revert service 代码。**注意**：down 会丢失「同应用至多一个在途批次」的保护 ⇒ 回滚后并发灰度保护退化为**当前**状态（读后判），**不比现在差** | < 5 min |
| **1-C**（A1 补偿查窗口） | revert 单个 commit；**无数据迁移** | < 5 min |
| **1-D**（CRON 去重窗口） | revert 单个 commit；**无数据迁移**。⚠️ 回滚后回到 1s 窗口 ⇒ 重新暴露 P-10 | < 5 min |
| **1-E**（leader TTL/verify） | revert 单个 commit | < 5 min |
| **2-B**（状态机收敛） | **双写期**：读新列 → 改读旧列（配置开关）；**单写期**：停写新列。旧列全程保留 ⇒ **数据零丢失** | 读开关即时；写开关需排期 |
| **2-A**（拆分） | facade 转发层保持 API 不变 ⇒ revert 拆分 commit 即回到单体 | < 30 min（revert 多 commit） |
| **3-A**（边界重划） | 新增 provider 是**增量**；`executor.service.ts` 保留旧调用路径一个版本 ⇒ revert 即可 | < 30 min |

**通用回滚纪律**：阶段 1 全部为「**代码行为变更，零数据迁移**」⇒ 回滚 = revert commit。阶段 2 的迁移全部设计为**只加列不删列** ⇒ 数据侧零风险。

### 8.3 部署回滚语义的实际行为（§5 问题 5 的答案）

**核查 `docs/rollback-semantics.md` 与 `app-deployment.service.ts` 实际行为**：

| 文档声称 | 代码事实 | 判定 |
|---|---|---|
| 应用回滚三端点已拆为「设为当前版本」/「下发到设备」/ deprecated alias | ✅ 属实。`application.controller.ts:873` `set-current-version` / `:899` `deploy-version` / `:930` `rollback/:deploymentId`（deprecated） | 属实 |
| `set-current-version`「**只按版本快照恢复应用当前字段**……**绝不读写部署行**」（响应 `dispatched:false`） | ✅ 属实。`setCurrentVersion`（`:1149`）只调 `appService.update(appId, buildVersionRestoreDto(...))`，返回 `{ok:true, dispatched:false, ...}`；**不碰 repo**（AppDeployment 仓储） | 属实 |
| `deploy-version`「先做与 set-current-version **完全相同**的字段恢复，再对部署行逐台 upgrade」 | ✅ 属实。`deployVersion`（`:1190`）→ `buildVersionRestoreDto` + `appService.update` → `collectVersionDispatch`（`:1288`）→ 逐台 `upgrade` | 属实 |
| deprecated alias「行为**逐字节不变**」 | ✅ 基本属实。`rollbackApplication`（`:1068`）版本路径 = `buildVersionRestoreDto` + `appService.update` + `upgradeRunningDeployments`；`deployVersion` 缺省 executorIds 路径 = 同构造。⚠️ **但有一处差异**：alias 的 legacy 部署行路径（`:1120–1145`）**只能恢复 version/commit**（`packageUrlRestored:false`），而 `deployVersion` **只收 versionId**（无 legacy 路径）⇒ 二者**不等价**，文档表格里「legacy 行路径另有『部署行不存在 400 / 无 deployedVersion 400』」一栏已披露，但「逐字节不变」的措辞与实际不完全一致 | **部分属实** |
| 「**回滚是否真的回滚数据**」 | ❌ **文档未回答此问题，且实际行为是「只切版本指针，不回滚数据」** | **🔴 缺口** |

**实际行为详解（三层语义）**：

| 层 | `set-current-version` / `deploy-version` | `rollbackApplication` 版本路径 | `rollbackDeploymentToPrevious`（灰度自动回滚） |
|---|---|---|---|
| **① 中台记录面（`applications` 表）** | ✅ **真恢复**：按 `application_versions.snapshot` 回写 `version`/`gitCommit`/`gitBranch`/`packageUrl`/`env`/`entrypoint`/`manifest`/`runtime`（`buildVersionRestoreDto`，`:1014–1041`） | ✅ 同左 | ❌ **不写** `applications` 表（`upgradeWithSnapshot` 头注明写：「**不写 applications 表**——应用当前版本是否随之回退属批次外决策」） |
| **② 设备上的代码/进程** | ❌ **不回滚**（`set-current-version` 根本不下发）；`deploy-version` 是**下发新版本**（不是回滚数据，是切到旧版本包） | ⚠️ **下发旧版本**（`upgradeRunningDeployments` → `upgrade` → push 旧快照字段） | ⚠️ **下发旧版本**（`upgradeWithSnapshot` → `pushDeployToExecutor(deployment, pushApp, true)`） |
| **③ 设备上的业务数据（DB/文件/状态）** | ❌ **完全不碰** | ❌ **完全不碰** | ❌ **完全不碰** |

**结论（必须写进文档）**：
> **本仓的「回滚」= 切版本指针（记录面 + 下发包），不是数据回滚。** 设备上的业务数据、数据库内容、文件状态**一律不还原**。
> `rollbackDeploymentToPrevious`（灰度失败自动回滚）尤其要注意：它**只回滚本台部署行的版本指针**，**不写 `applications` 表**——即**中台记录的「当前版本」与设备上的实际版本可能不一致**（这是刻意设计，注释明写「全量回退请走既有 rollback 端点」）。

**建议**：
1. `docs/rollback-semantics.md` 增加一节「**回滚的三层语义与不做什么**」，明确写「**本仓无数据回滚能力**」。
2. 端点描述（`application.controller.ts:873/899/930` 的 `@ApiOperation`）补同一句，避免用户误以为回滚会还原数据。
3. 若产品需要**真数据回滚**，那是**新能力**（需要应用侧自带回滚脚本/迁移），本仓当前**不提供** —— 应作为**新决策项**（§10 D-3）。

---

## §9 测试计划（含并发 / 多实例测试场景）

### 9.1 需要**新增**的 spec 场景（本报告 §4 全部标注）

| 编号 | 场景 | 目标方法 | 断言 | 对应路径 |
|---|---|---|---|---|
| **S-A1-1** | FIRE_ONCE 补偿 + 窗口内已有手动执行 | `scheduler.service.spec.ts` | 补偿**不入队**；`task_executions` 窗口内仍 1 条 | P-3 |
| **S-A1-2** | FIRE_ONCE 补偿 + 窗口内无任何执行 + 落点在窗口内 | 同上 | 补偿入队 1 条（**对照组**，防止过度抑制） | P-3 |
| **S-A1-3** | 补偿前 fresh 复核命中（快照陈旧场景） | 同上 | 不补偿（**已有 R126-A1 钉子用例 `:733` 可复用**） | P-3 |
| **S-P5-1** | 同一 deployment 连续两次 `upgrade()` | `app-deployment.service.spec.ts` | 第 2 次 409；`pushDeployToExecutor` 只调 1 次 | P-5 |
| **S-P5-2** | webhook 触发 upgrade 与 upgrade-all 并发 | `application.controller.spec.ts` + `app-deployment.service.spec.ts` | 不产生双 deploy 命令 | P-5 |
| **S-P7-1** | 两实例并发 `upgradeAllWithRollout(canary)` | `app-deployment.rollout-multi-instance.spec.ts` | 第二次 `ok:false` + `blockedReason`；`batchId` 唯一 | P-7 |
| **S-P7-2** | `markRolloutState` 不覆盖他人 `batchId` | 同上 | 条件写生效 | P-7 |
| **S-P8-1** | 同应用两行 running，并发两次 `upgradeAllWithRollout(all)` | `app-deployment.service.spec.ts` | 第二次的 `upgrade` 被拒（行级占坑） | P-8 |
| **S-P9-1** | `LeaderGateService` fail-open ⇒ `isLeader=true` | `leader-gate.service.spec.ts` | **已有**（文档已声明）——补「文档化断言」 | P-9 |
| **S-P9-2** | `extendLock` 连抛 ⇒ demote 延迟 | 同上 | 连续 2 次失败才 demote（**1-E 修复后**） | P-9 |
| **S-P10-1** | 两实例间隔 2s 调同一 cron 的 `enqueue` | `scheduler.service.spec.ts` | 只 1 行执行（**1-D 修复后**） | P-10 |
| **S-DEP-1** | `selectLeastLoaded` 补 affinity 后选机结果 | `executor.dispatch-estimated.spec.ts` | 部署归属命中时优先（**3-B**，带 flag） | S-4 |

### 9.2 需要**新增**的 SQL 断言（可直接贴进 spec 或手工跑）

```sql
-- ① 同应用至多一个在途部署行（部分唯一索引已存在）
SELECT "applicationId", count(*) FROM "app_deployments"
WHERE "status" IN ('pending','deploying') GROUP BY 1 HAVING count(*) > 1;
-- 期望：0 行

-- ② 同应用至多一个在途灰度批次（1-B 修复后新增的索引）
SELECT "applicationId", count(DISTINCT "rolloutMeta"->>'batchId') FROM "app_deployments"
WHERE "rolloutState" IN ('pending','probing') GROUP BY 1 HAVING count(*) > 1;
-- 期望：0 行

-- ③ 同窗口至多一次任务触发（1-D 修复后：fire_slot 唯一索引）
--    （1-D 只改窗口，未加索引时用时间近似）
SELECT "taskId", count(*) FROM "task_executions"
WHERE "triggerType" IN ('cron','misfire')
  AND "createdAt" > now() - interval '1 minute'
GROUP BY 1 HAVING count(*) > 1;
-- 期望：0 行

-- ④ 窗口内已有执行 ⇒ 补偿不应再产生一条
SELECT count(*) FROM "task_executions"
WHERE "taskId" = :taskId AND "createdAt" > :windowStart;
-- S-A1-1 期望 1（S-A1-2 期望 2，因为对照组没有人工执行）

-- ⑤ outbox 行终态唯一（已存在机制，防回归）
SELECT count(*) FROM "event_outbox" WHERE "dispatchedAt" IS NULL AND "deadLettered" = false;
-- 稳定态：随扫描下降，不应持续增长

-- ⑥ 双 Leader 观测（多实例）
--    cron leader：/api/metrics/scheduler 的 isLeader 应恰有 1 个 true
--    agent 会话（若 L-4 落地）：
SELECT count(*) FROM "agent_sessions"
WHERE "createdAt" > now() - interval '1 hour' AND "triggerSource" = 'cron';
-- 期望：1（当前多实例下可能为 N）
```

### 9.3 需要**新增**的多实例真机场景（docker）

> 现有 4 个脚本：`scripts/arch31-multi-instance-selftest.mjs` / `arch31-rollout-cross-instance-selftest.mjs` / `arch31-outbox-claim-selftest.mjs` / `arch31-outbox-duplication-selftest.mjs`（文档称 57/57 通过）。**本轮未跑**（需 docker + PG16/Redis7）。

| 编号 | 场景 | 脚本 | 断言 |
|---|---|---|---|
| **M-1** | **两实例并发 canary 灰度** | 新增 `scripts/arch31-rollout-concurrent-selftest.mjs` | 同应用同时发两个 canary ⇒ 恰一个成功、另一个 `blockedReason`；`rolloutMeta.batchId` 唯一；canary 台只被 upgrade 一次 |
| **M-2** | **两实例并发 upgrade 同一部署行** | 新增（可并入 M-1 脚本） | 只 1 次 deploy 命令到达执行器（执行器侧 `deploy.ts` 的 upgrade 路径会先停旧进程 ⇒ 双命令 = 多一次停机启动） |
| **M-3** | **FIRE_ONCE 补偿跨实例** | 新增（并入 `arch31-multi-instance`） | 两实例的 `checkMisfires` 同时命中同一任务 ⇒ 只 1 次执行（现有 Redis 锁 + claim 应已保证，但需在**Redis 锁被刻意禁用**的条件下复测 DB claim 单独兜底） |
| **M-4** | **leader 切换瞬间** | 新增（并入 `arch31-multi-instance`） | 杀掉 cron Leader ⇒ ≤ TTL+verify 内另一实例接管；期间维护 cron **不重复执行**（幂等任务）或 **重复执行次数 ≤ 1**（非幂等任务，如 `agent-trigger.scheduledWatch`） |

### 9.4 回归要求

- 现有 **9 个** `app-deployment.*.spec.ts` + `scheduler.service.spec.ts`（含 R126-A1 钉子 `:733`）+ `leader-gate.service.spec.ts` + `outbox-dispatcher.spec.ts` + `event-subscriptions.spec.ts` + `webhook-delivery.service.spec.ts` + `executor-deployment-affinity.util.spec.ts` **全部零修改通过**。
- `node scripts/check-cron-leader-gate.mjs` → 26/26 ✅
- `node scripts/check-cron-guard.mjs` → 22/22 ✅（排除面仍 4 个 agent @Cron，需在 §10 D-2 拍板）
- `node scripts/check-enum-drift`（若存在）——`DeploymentStatus` / `RolloutState` / `DeploymentApprovalStatus` 改动后必须仍绿。

---

## §10 待决策项

> 每条给出**可拍板的证据**与**两个选项的代价**（对齐 `docs/OPEN-DECISIONS.md` 的格式约定）。

### D-1（继承 A1，已可拍板）：FIRE_ONCE 补偿是否把「窗口内存在任何执行」当成已覆盖

- **现象**：手动触发不推进 `tasks.lastTriggerTime` ⇒ 补偿扫描判据持续成立。
- **本轮精确化**：补偿扫描**与手动触发之间不存在并发重复**；真正会**重复执行**的是「手动触发后、cron 落点已过、且 `lastTriggerTime` 尚未被任何定时触发推进」这一组合——补偿的 fresh 复核（`scheduler.service.ts:1116`）与落点校验（`:1130`）**双双放行** ⇒ 手动 + 补偿 = 同一窗口跑两次。
- **证据**：`task.service.ts:2958–3023`（`trigger()` 无 `lastTriggerTime` 写点；全文件写点仅 `:5141` 回滚、`:5184` 依赖 claim）+ `scheduler.service.ts:1099–1155`（补偿判据链）+ `:425–427`（CRON 去重窗口恒 1s）。
- **选项**：
  - **① 保持现状**（严格 cron 语义：手动跑 ≠ 服务该计划点）——代价：偶发一次多余执行；对日报类任务造成数据时序错乱。
  - **② 补偿前查「窗口内有无执行（含手动）」**（**推荐**）——代价：每候选多一条 `task_executions` 索引查询。
  - **③（新增）** 引入 `tasks.lastExecutionAt` 独立列，手动/定时/依赖三条路径都推进它——代价：需新迁移 + 评估 `claimDependencyTrigger`（10s 窗口）的连带影响；**长期最干净**。
- **建议**：**拍板 ②**（阶段 1-C），阶段 2 演进到 ③（2-F）。

### D-2：`modules/agent/**` 的 4 个 @Cron 是否纳入 cron 门禁强制面

- **现象**：`scripts/check-cron-guard.mjs` 明确**排除** `modules/agent/**`（理由：「该目录正由并发 agent 修改，暂不覆盖」）。这 4 个 @Cron 中：`agent-trigger.scheduledWatch`（`:402`）与 `sweepAggregator`（`:528`）**已经**用 `this.isSchedulerLeader()` 门禁；`agent-session-retention.handleDailyCleanup`（`:117`）与 `agent-session.handleStaleRunningSweep`（`:537`）用 `leaderGate.isLeader` 门禁。⇒ **实际上 4 个都有门禁**，只是被守卫脚本排除、不受 CI 保护。
- **证据**：`node scripts/check-cron-guard.mjs` 输出（排除面 4 个 + 逐条列名）+ `agent-trigger.service.ts:402, 528` + `agent-session-retention.service.ts:117` + `agent-session.service.ts:537`。
- **选项**：① 解除排除，把 4 个纳入强制面（**推荐**——它们的门禁已经存在，解除排除只是让 CI 守住）；② 保持排除（若确有并发 agent 修改该目录的实情）。
- **代价**：① 需确认该目录已无并发 agent 修改；② 该目录的门禁回归无 CI 保护（未来新增 @Cron 可能漏门禁）。

### D-3：是否需要「真数据回滚」能力（应用部署域新决策）

- **现象**：`docs/rollback-semantics.md` 未回答「回滚是否真的回滚数据」。实际行为：**只切版本指针（记录面 + 下发包），设备上的业务数据/DB/文件一律不还原**。`rollbackDeploymentToPrevious`（灰度自动回滚）甚至**不写 `applications` 表**。
- **证据**：`app-deployment.service.ts:1014–1041`（`buildVersionRestoreDto` 只映射版本字段）/ `:3913–3968`（`upgradeWithSnapshot` 头注「不写 applications 表」）/ `:1190–1287`（`deployVersion` 只下发包）。
- **选项**：① 明确文档化「本仓无数据回滚」（**推荐，本轮做**）；② 新增「应用自带回滚脚本/迁移」能力（新工作量，需产品定义）。
- **代价**：① 一次性文档 + 端点描述；② 需每个应用定义回滚契约，工作量大且无法通用。

### D-4：部署约束（affinity / 版本跟随）归属 deployment 域还是派发内核

- **现象**：约束逻辑现在住在 `executor.service.ts`（`resolveDeploymentConstraintContext` `:5890–6000` + `executor-deployment-affinity.util.ts` 304 行）。dispatch-core 域正在拆 `executor.service.ts`（8488 行）——**部署逻辑会成为拆分的主要阻塞**。
- **选项**：① 契约留在派发内核（现状）；② **部署约束归 deployment 域**（**推荐**），派发内核只消费纯数据契约（见 §8.3/§7-3）。
- **代价**：② 需新增 `DeploymentConstraintProvider` 接口 + 迁移 304 行 util + 一个契约 spec；dispatch-core 域的拆分可**立即解除阻塞**。
- **本报告的契约建议**（供 dispatch-core 域评审）：

```ts
// 建议契约（草案，放在 packages/ 或 application 域的对外类型面）
export interface DeploymentConstraintQuery {
  applicationId: string;
  /** 策略来源：任务级覆盖优先，其次全局配置 */
  policy: "strict" | "prefer" | null;
}

export interface DeploymentConstraintRow {
  executorId: string | null;
  executorAddress: string;
  status: "running" | "stopped" | "upgrading";
  deployedVersion: string | null;
  deployedAt: Date | null;
}

export interface DeploymentConstraintResult {
  mode: "strict" | "prefer";
  source: "task" | "global";
  rows: DeploymentConstraintRow[];
  /** 版本事实（设备上报优先，推断兜底） */
  versionFact?: { version: string; source: "device-fact" | "inferred" } | null;
}

/** 由 deployment 域实现；派发内核只调用它并消费结果。 */
export interface DeploymentConstraintProvider {
  resolve(q: DeploymentConstraintQuery): Promise<DeploymentConstraintResult | null>;
}
```
**边界原则**：部署域负责「**这个应用部署在哪、跑什么版本、约束是什么**」；派发内核负责「**在给定约束下选哪台、怎么占坑、怎么派**」。派发内核**不得**直接查 `app_deployments` 表。

### D-5：`cron:leader` 与 `scheduler:leader` 的锁 TTL 是否统一到 90s

- **现象**：`cron:leader` TTL **30s**（`leader-gate.service.ts:17`），`scheduler:leader` TTL **90s**（`scheduler.service.ts:97`）。2026-10-28 事故实测事件循环冻结 **28–40s** ⇒ 30s TTL **会被打穿**。`ARCH-MULTI-INSTANCE-MATRIX.md` §3.8 仍写「TTL 30s 同款」——**文档已过时**。
- **选项**：① 统一到 90s（**推荐**）；② 保持 30s（cron 任务都是幂等清扫，重复执行代价小）。
- **代价**：① 单常量 + 单测断言；**代价是双 Leader 窗口从 ~45s 拉长到 ~105s** ⇒ 必须与 L-2（verify 计数化）同批；② 接受事件循环冻结时维护 cron 重复执行。

### D-6：是否把 `agent-trigger.scheduledWatch` 迁出 leader 门禁（改 DB 唯一占坑）

- **现象**：`scheduledWatch` 每小时创建 Agent 会话 + **消耗 LLM 配额**——**非幂等**。它在 fail-open 期间（每实例都是 Leader）会被执行 N 次 ⇒ **N 倍 LLM 配额消耗**。
- **证据**：`agent-trigger.service.ts:402–430`（`@Cron("0 5 * * * *")` + `this.isLeader()` 门禁）；`scheduler.service.ts` tryAcquireLeadership catch → `isLeader=true`（fail-open）。
- **选项**：① 迁到 DB 唯一占坑（`INSERT ... ON CONFLICT DO NOTHING` 按小时槽）（**推荐**，= §6 L-4）；② 保持现状（接受偶发 N 倍配额）。
- **代价**：① 1 表 + 1 迁移 + 5 行改动；② 偶发成本浪费。

---

## 附：本轮核查清单（可复现命令）

```bash
cd /home/yongsheng/project/AutoCodeFlow
codegraph status                                   # Index is up to date（2108 文件 / 42151 节点）
codegraph node apps/admin-api/src/modules/application/app-deployment.service.ts --symbols-only
codegraph node apps/admin-api/src/modules/application/app-deployment.service.ts --offset 1333 --limit 120
codegraph impact AppDeploymentService -d 3          # → 170 affected symbols
codegraph callers deploy
codegraph explore "LeaderGateService leader election cron:leader isLeader acquireLock extendLock demote"
codegraph explore "misfire compensation scan FIRE_ONCE lastTriggerTime window schedule scan"
codegraph explore "OutboxDispatcher claim FOR UPDATE SKIP LOCKED leaseToken deliverToSubscribers markFastPathDelivered"
codegraph node computeTriggerDedupTtlMs
codegraph node computeMisfireThresholdMs
codegraph node acquireTriggerGateLockOrThrow
node scripts/check-cron-leader-gate.mjs             # 26/26 ✅
node scripts/check-cron-guard.mjs                   # 22/22 ✅ + agent 排除面 4 个
```

**只读承诺**：本轮**未编辑任何 AutoCodeFlow 文件**（`git status --porcelain` 保持本轮开始时的状态），唯一产出为本报告文件。
