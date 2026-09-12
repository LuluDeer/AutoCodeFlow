# 任务全生命周期（创建 → 调度/触发 → 派发 → 执行 → 回调 → 终态 → 事件/通知）

> 所属: docs/atlas/04-flows · 最后核对: 2026-09-13 · 对应代码: apps/admin-api/src/modules/task、apps/admin-api/src/modules/scheduler、apps/admin-api/src/modules/executor、apps/executor-node/src

## 全链路时序图

```
 用户/CI          admin-api                       PostgreSQL         BullMQ/Redis       Executor            通知/订阅方
   │                 │                                │                  │                  │                   │
   │──POST /api/tasks────────────────▶ task.service.create ──────────▶ tasks + task_versions(快照)│                  │
   │                 │  (task.service.ts:373; saveVersion :2080)          │                  │                   │
   │  ├─ 触发源 A: POST /api/tasks/:id/trigger (task.controller.ts:520, NF-01 双凭据面)
   │  ├─ 触发源 B: cron/fixed_rate → scheduler.enqueue (scheduler.service.ts:819, Leader 独占)
   │  ├─ 触发源 C: 依赖扇出 triggerDependentTasks (task.service.ts:1337)
   │                 │──事务建 PENDING TaskExecution ─▶ task_executions │                  │                   │
   │                 │──queue.add("execute",{executionId},            ─▶ task-queue          │                   │
   │                 │   attempts/backoff±20%/priority) (task.service.ts:663)            │                   │
   │                 │        入队失败 → 补偿行置 FAILED (P1, task.service.ts:695)          │                   │
   │                 │                                │                  ▼                  │                   │
   │                 │  TaskProcessor.handle (task.processor.ts:59)       │ 原子 claim:                      │
   │                 │──UPDATE ... SET running WHERE status IN (pending,failed) (task.processor.ts:117)│
   │                 │──ExecutorService.dispatch (executor.service.ts:1014):过滤链→评分→条件 UPDATE 占坑│
   │                 │──POST http://<addr>/api/execute {executionId,task,params} ─▶ routes/execute.ts    │
   │                 │◀── 200 {status:'accepted',executionId}            │ 同步段校验+登记                 │
   │                 │                                │                  │  prepareExecution(task-worker.ts):
   │                 │                                │                  │  git clone → manifest → glue     │
   │                 │                                │                  │  → npm install → buildChildEnv   │
   │                 │                                │                  │  runProcess spawn（超时树杀）      │
   │                 │◀──POST /api/executions/callback (批量≤100, HMAC/执行器 token)──────────┤                 │
   │                 │  handleCallback (task.service.ts:1825)             │ winner 条件 UPDATE(status IN open)│
   │                 │──storeLogLines(DB/S3) + releaseExecutorSlot + triggerDependentTasks │                  │
   │                 │──emitTerminalEvent ──────────────────────────────────────────────────────────────▶ DomainEventBus
   │                 │                                │                  │                  │    ├─ notification.ExecutionEventsListener
   │                 │                                │                  │                  │    └─ event-subscriptions.OutboundEventDispatcher
```

## 分步代码锚点

| 步骤 | 代码锚点 | 要点 |
|---|---|---|
| 创建任务 | `apps/admin-api/src/modules/task/task.service.ts:373` `create()` | 任务初始 paused；secrets 经 `SecretsCryptoService` 加密（`enc:v1:`） |
| 版本快照 | `task.service.ts:2080` `saveVersion()`（create/update/rollback 均调，:409/:578） | `task_versions` 存 config 快照，回滚据此重建 |
| 手动触发 | `task.controller.ts:520` → `task.service.ts:635` `trigger()` | JWT 用户或 `task:trigger` API Key（`task.controller.ts:545` 起审计 `task.trigger_api`） |
| 调度触发 | `scheduler.service.ts:819` `enqueue()`；`reload()` :777、`checkMisfires()` :341 | Leader 门控；触发去重锁 `task:trigger:<taskId>`；维护窗口跳过 |
| 入队 | `task.service.ts:663` 与 `scheduler.enqueue`：`queue.add("execute", {executionId}, {attempts, backoff: exponential ±20% 抖动, priority})` | 队列 `task-queue` 双模块注册（`task.module.ts:37`、`scheduler.module.ts:17`） |
| 消费与 claim | `task.processor.ts:31` `@Processor("task-queue", {concurrency:5})`；claim :117 | 条件 UPDATE `status IN (pending,failed)`；RUNNING 不可 claim（CONSISTENCY-01 防双派发） |
| 派发选址 | `executor.service.ts:1014` `dispatch()`（pinning → appName → group → tags AND → affinity OR → antiAffinity → runtime） | 候选池 cap 500；评分 `executor-score.util.ts`（负载50%+CPU25%+内存25%+长任务惩罚10%） |
| 占坑 | `executor.service.ts:1014` 内条件 UPDATE `runningTaskCount+1 WHERE status='online' AND runningTaskCount < maxConcurrentTasks` | 失败回滚 `GREATEST(runningTaskCount-1,0)` 换下一候选；广播 `dispatchBroadcast` :1260 不占坑 |
| 执行器领取 | `apps/executor-node/src/routes/execute.ts`（同步段：容量 Atomics 预检 429 / 重复领取 400 / git SSRF 校验） | 2xx+`{status:'accepted'}` 才算派发成功 |
| 载体解析与依赖 | `apps/executor-node/src/task-worker.ts` `prepareExecution()` | git 裸仓缓存 → manifest 合并 → glue 落盘 → `npm install --prefix .node_modules/<taskId>`（300s 超时） |
| 执行 | `task-worker.ts` `runProcess()`；env 白名单 `env-whitelist.ts`（SEC-01） | 注入 `AUTOFLOW_CALLBACK_TOKEN`（v1 HMAC）、`AUTOFLOW_ADMIN_API_URL` 等；超时 `killProcessTree` |
| 回调 | `execution-callback.controller.ts` `callback()` → `task.service.ts:1825` `handleCallback()` | 详见 [execution-callback](execution-callback.md) |
| 终态落库 | `handleCallback` winner 条件 UPDATE（`status IN (pending,running)`，RETURNING executorAddress） | SUCCESS 只能由回调写入；worker finally 用同款守卫写派发失败终态 |
| 事件发布 | `task.service.ts:1698` `publishTerminalEventForDispatch` / `emitTerminalEvent` | 常量 `src/common/events/domain-events.ts`：`execution.completed` / `execution.failed` / `execution.killed` |
| 通知 | `notification/execution-events.listener.ts:46` 订阅 failed/killed | 详见 [notification-flow](notification-flow.md) |

## 失败分支与自愈

- **派发失败重试**：`task.processor.ts` 按消息正则分类 `timeout/executor_offline/package_fetch_failed/script_error/unknown` → 抛回 BullMQ 按 attempts 退避重试；`failureReason=timeout` 抛 `UnrecoverableError`（执行器可能仍在跑，禁止二次派发）；`task.retryableErrors` 非空时按 allow-list 过滤。
- **入队失败**：Redis 挂 → PENDING 行已提交，`trigger` 的 catch 补偿置 FAILED（P1，`task.service.ts:695`）。
- **worker 终态保存失败**：事务回滚后走 REPAIR-01 独立事务重放同款条件 UPDATE（`task.processor.ts` finally）。
- **kill**：`POST /api/tasks/:id/executions/:execId/kill`（`task.controller.ts:924`）→ `task.service.ts:2259` `killExecution` 条件 UPDATE + `emitKilledEvent`（:2234）→ `executor.service.ts:389` `notifyExecutorKill` best-effort 树杀；回调永远无法覆盖 KILLED（handleCallback open 状态守卫排除）。
- **stale 回收**：`scheduler.service.ts:386` `recoverStaleExecutions()`（每 10 分钟）——RUNNING 超 `max(2×timeout,60s)` 判 stale，活性探测（心跳 `runningExecutionIds` 含该 id 则跳过，绝对兜底 `max(6×timeout,30min)`）；超时桶置 TIMEOUT、worker 崩溃型置 STALE_RECOVERED，再按预算 `scheduleRetryAfterRecovery`（`executor.service.ts:330`）重入队。
- **回调迟到**：执行器在线且心跳声称仍在跑 → stale sweep 本轮跳过，等真实回调（winner 语义天然幂等）。

## 相关配置项（环境变量）

| 变量 | 默认 | 作用 | 出处 |
|---|---|---|---|
| `EXECUTOR_HEARTBEAT_INTERVAL` / `_TIMEOUT_MULTIPLIER` | 30000 / 3 | 心跳节奏与 stale-offline 判定 | `configuration.ts:167` |
| `THROTTLE_CALLBACK_LIMIT` / `_TTL` | 60 / 60000 | 回调限流（per IP） | `execution-callback.controller.ts:52` |
| `SSE_MAX_STREAMS_PER_EXECUTION` / `_GLOBAL` | 4 / 64 | 日志流并发闸门 | `configuration.ts:84` |
| `LOG_STORAGE_DRIVER` | `db` | `s3` 时日志写 gzip 对象 | `configuration.ts:219` |
| `LOG_RETENTION_DAYS` | 30 | 日志行保留期（每日 03:30 清理） | `configuration.ts:288` |
| `STALE_RECOVERY_RETRY_ENABLED` | true | stale sweep 重试兑现开关 | `scheduler.service.ts` 常量 |

## 常见改动场景

- **改 claim/终态守卫条件**：`task.processor.ts:117` 与 `handleCallback` 两处 `status IN (...)` 必须同步评估——放宽 RUNNING 可 claim 会复活双派发。
- **新增失败分类**：`ExecutionFailureReason` 枚举 + processor 分类正则 + 回调路径 `inferFailureReason` 两处。
- **改派发过滤链**：`dispatch` 与 `dispatchBroadcast` 是两份实现（executor.md 已标注），需同步修改。
- **调整重试语义**：BullMQ 侧（processor）与 stale sweep 侧（scheduler/executor 的 `scheduleRetryAfterRecovery`）是两条恢复路径。

## 相关文档

- [executors 实体](../03-data/entities/executor.md) · [task-execution 实体](../03-data/entities/task-execution.md) · [task 实体](../03-data/entities/task.md)
- [task 模块](../01-apps/admin-api/modules/task.md) · [scheduler 模块](../01-apps/admin-api/modules/scheduler.md) · [executor 模块](../01-apps/admin-api/modules/executor.md)
- [执行器协议契约](../01-apps/executor-contract.md) · [executor-node 执行管线](../01-apps/executor-node/execution-pipeline.md)
- [回调上报](execution-callback.md) · [通知链路](notification-flow.md) · [安全模型](security-model.md)
