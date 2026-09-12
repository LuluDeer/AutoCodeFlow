# scheduler 模块 — Cron 调度器（BullMQ 入队大脑）

> 所属: docs/atlas/01-apps/admin-api/modules · 最后核对: 2026-09-13 · 对应代码: apps/admin-api/src/modules/scheduler

## 职责

把 `triggerType=cron / fixed_rate` 的 active 任务注册成本地定时器（node-cron / setInterval），按周期将执行入队到 BullMQ `task-queue`；承担 misfire 补偿、stale 执行回收（REC-01）、跨实例触发去重、调度可观测性指标。多实例部署下只有 Leader 注册定时器。

## 目录结构与关键文件

```
modules/scheduler/
├── scheduler.module.ts        ScheduleModule.forRoot() + BullMQ "task-queue" + forwardRef(TaskModule)
├── scheduler.service.ts       核心服务（Leader 选举 / reload / enqueue / misfire / stale sweep）
├── scheduler-metrics.service.ts  tick/trigger 计数与延迟分布（R4-§5.5）
└── __tests__/                 metrics 边界、service 行为单测
```

无 controller；对外的调度统计读面挂在 [task](task.md) 的 `GET /api/tasks/scheduler/stats`（`SchedulerService.getStats`）与 metrics 模块。

## 关键机制

### Leader 选举（TASK-006）

```
acquireLock("scheduler:leader", TTL 30s)      ← RedisLockService（key 实际为 lock:scheduler:leader）
  ├─ 成功 → isLeader=true，每 TTL/2(15s) extendLock 校验租约，失主即 demote
  ├─ 被他人持有 → follower，每 15s 重试竞选
  └─ Redis 抛错 → 降级按 Leader 运行（fail-open，保证单实例部署不停摆），
                    重复触发由 enqueue 的 DB 条件 claim 兜底
demote：清空本地全部 timers/cronTasks，仅保留竞选重试
```

扫描型 tick（`reload` / `checkMisfires` / `recoverStaleExecutions` / `scheduleOne`）均以 `isLeader` 为门；BullMQ worker（[task](task.md) 的 TaskProcessor）消费路径与 Leader 无关。

### 调度 tick 与入队

- `@Cron(CronExpression.EVERY_MINUTE) reload()`：扫描 `status=active` 任务，注册新增、停掉已失效的定时器（BUG-01 防泄漏），tick 计时进 metrics。
- cron 任务用 `node-cron.schedule`（先 `nodeCron.validate`，`timezone` 经 `Intl.DateTimeFormat` 校验后传入）；fixed_rate 用 `setInterval(fixedRate*1000)`，进程内 `runningTasks` Map 防重入（B-04）。
- `enqueue(task, triggerType, fireTime?)` 关键序列：
  1. **维护窗口**（FEAT-06）：`findActiveMaintenanceWindow(task.maintenanceWindows)` 命中即跳过——不 claim、不建行、不推进 `lastTriggerTime`（仅约束调度路径，手动/API 触发不受限）。
  2. **跨实例去重**：`acquireLock("task:trigger:<taskId>", computeTriggerDedupTtlMs(task), {renew:false})`——锁永不释放，TTL 即去重窗口（fixed_rate 取 `周期-500ms` 下限 1s；cron 取 1s；其余 5s，N6）。Redis 不可用时改用 DB 条件 UPDATE `claimTaskTrigger`（推进 `lastTriggerTime`，窗口外才允许领取）。
  3. 重查任务仍 active（N8）；`blockStrategy=DISCARD` 有 RUNNING 即跳过；`COVER_EARLY` 则把 RUNNING 行条件 UPDATE 成 `cancelled` 并按 RETURNING 释放执行器槽位（R4-P1）。
  4. 建 PENDING execution → `queue.add("execute", {executionId, task}, {attempts, backoff: exponential ±20% 抖动, priority})`；入队失败补偿该行为 FAILED（P1）。成功后写 `lastTriggerTime` 并记 `recordTriggerLatency(Date.now()-fireTime)`。

### misfire 与 stale 回收

- `checkMisfires()`（启动时）：`now - lastTriggerTime` 超阈值（fixed_rate `×2000`、cron/其他 2 分钟）按 `misfireStrategy` 补偿——`fire_once` 补跑一次（`enqueue(task,"misfire")`），`ignore` 只告警。
- `@Cron("0 */10 * * * *") recoverStaleExecutions()`：
  - RUNNING 行 stale 阈值 = `max(2×taskTimeout, 60s)`（N5），timeout=0 用 1h 兜底；扫描窗口取全部 active 任务最短阈值（上限 1h）。
  - CONSISTENCY-02 活性探测：执行器 ONLINE 且心跳 `runningExecutionIds` 含该 id 则本轮跳过；但超过 `max(6×timeout, 30min)` 绝对兜底仍强制恢复。
  - 单事务 + RETURNING 条件批量 UPDATE（`status IN (pending,running)` 终态保护，TASK-004）：超时桶写 `TIMEOUT`，worker 崩溃型写 `STALE_RECOVERED`；PENDING 超 10 分钟未派发的也置 FAILED。
  - 对恢复行兑现重试预算（P2）：`STALE_RECOVERY_RETRY_ENABLED`（默认 true）→ `hasRetryBudget` → 先 `notifyExecutorKill` 再 `scheduleRetryAfterRecovery`（复用 [executor](executor.md) 的 re-enqueue 模式）。
- **错峰（CORE-02）**：重试延迟经 `jitteredRetryDelayMs`（`retry-backoff.util.ts`）预乘指数基座并加 ±20% 抖动，摊开同周期失败任务的重试时刻（thundering herd）。

## 可观测性（SchedulerMetricsService）

- 计数器：tick 次数/耗时、`triggerClaimed`（claim 赢家且入队成功）、`triggerFailed`（PENDING 行已建但入队失败含补偿）、以及各跳过分支分类——`triggersSkippedMaintenance`（维护窗口）、`triggerSkippedLockHeld`（Redis 锁被他例持有）、`triggerSkippedDbClaim`（DB claim 失败）、`triggerSkippedInactive`（任务已非 active）、`triggerSkippedBlockStrategy`（DISCARD 撞 RUNNING）。
- 延迟：`recordTriggerLatency(fire→入队全链耗时)`（CORE-06，定时触发采样、手动触发不计）。
- 队列深度：`getQueueDepth()` 经 `queue.getJobCounts` 聚合 waiting/active/delayed/failed/completed；Redis 不可用返回 null 字段（让调用方区分「队列空」与「Redis 挂」）。
- 暴露面：metrics 模块的 Prometheus 端点与 Dashboard（快照 + derived 派生值），health 模块读调度器活性。

## 与其他模块的关系

- 依赖 [task](task.md)：Task/TaskExecution 实体 + `jitteredRetryDelayMs`/`maintenance-window.util`（`forwardRef` 双向环，task 侧 resume 需要本模块的 `scheduleOne`）。
- 依赖 [executor](executor.md)：stale sweep 的重试兑现 / kill 通知 / 槽位释放。
- 依赖 common：`RedisLockService`（Leader 锁 + 触发去重锁）、`TracingService`（入队 trace 根）。
- 被 metrics/health 消费：`getStats()`、`getSchedulerMetrics()`（tick/trigger 计数 + 队列深度 waiting/active/delayed/failed/completed）。

## 常量与环境变量速查

| 名称 | 值 / 默认 | 来源 |
|---|---|---|
| `SCHEDULER_LEADER_LOCK_KEY` | `scheduler:leader`（Redis 实际 key `lock:scheduler:leader`） | scheduler.service.ts 导出常量 |
| `SCHEDULER_LEADER_TTL_MS` | 30000 | 同上 |
| `SCHEDULER_LEADER_RETRY_MS` | 15000 | 同上 |
| `TRIGGER_DEDUP_MIN_TTL_MS` / `TRIGGER_DEDUP_JITTER_BUFFER_MS` | 1000 / 500 | 跨实例去重窗口下限 / fixed_rate 相位缓冲 |
| `STALE_SCAN_FALLBACK_MS` | 3600000（1h） | timeout=0 任务的回收兜底 |
| `STALE_LIVENESS_ABSOLUTE_FLOOR_MS` / `_MULTIPLIER` | 1800000（30min）/ 6 | 活性探测绝对兜底 |
| `STALE_RECOVERY_RETRY_ENABLED` | true（仅显式 false 关闭） | stale sweep 重试兑现开关 |
| `EXECUTOR_HEARTBEAT_*` | 见 [executor](executor.md) | 间接影响 markStaleOffline 之外的心跳语义 |

注意：cron 表达式 `0 */10 * * * *` 与 `@Cron(CronExpression.EVERY_MINUTE)` 是 @nestjs/schedule 六字段（含秒）形态，与任务级 `cronExpression` 的 node-cron 表达式分属两套，改动勿混淆。

## 常见改动场景

- 新增触发类型：`TaskTriggerType` 枚举 + `scheduleOne` 分支 + `computeTriggerDedupTtlMs` 窗口。
- 调整回收灵敏度：`staleThresholdMs` / `STALE_LIVENESS_ABSOLUTE_FLOOR_MS` / `PENDING_GRACE_MS` 常量，均需同步对应单测。
- 多实例行为排查：先看日志 `Scheduler leadership acquired/lost` 与 `trigger claimed by another instance`，确认 Leader 归属与去重窗口。

## 相关文档

- [task](task.md)（TaskProcessor 消费本模块入队的 job）
- [executor](executor.md)（重试预算与槽位语义同源）
- [Task 实体](../../../03-data/entities/task.md)（规划路径）
