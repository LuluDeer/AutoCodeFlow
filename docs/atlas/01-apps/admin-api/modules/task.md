# task 模块 — 任务与执行核心

> 所属: docs/atlas/01-apps/admin-api/modules · 最后核对: 2026-09-13 · 对应代码: apps/admin-api/src/modules/task

## 职责

任务全生命周期的中枢：任务 CRUD/版本/回滚、手动与 API 触发、BullMQ 派发消费（`TaskProcessor`）、执行回调接收（`/api/executions/callback`）、日志落库（DB 行 / S3 对象双通道）、SSE 日志流、执行干预（kill/暂停/恢复）、依赖扇出、日志保留期清理。是 platform 中被 scheduler/executor/ai/notification/event-subscriptions 交叉依赖的核心模块。

## 目录结构与关键文件

```
modules/task/
├── task.module.ts                  装配：BullMQ "task-queue" + forwardRef 双环
├── task.controller.ts              @Controller("tasks") 任务 CRUD/触发/干预/版本/SSE
├── task-batch.controller.ts        @Controller("tasks-batch") 批量 trigger/pause/resume/delete
├── execution-callback.controller.ts @Controller("executions") POST /callback 机器回调入口
├── task.service.ts                 核心业务（约 2400 行：trigger/handleCallback/日志/依赖扇出）
├── task.processor.ts               @Processor("task-queue", concurrency 5) 派发消费
├── execution-callback-metrics.service.ts  回调 401 分类 / autoflow_callback_business_total
├── execution-callback-token.util.ts  "v1." per-execution HMAC 回调令牌（N23）
├── retry-backoff.util.ts           jitteredRetryDelayMs（±20% 抖动指数退避，CORE-02）
├── timeout-policy.util.ts          kill / kill_retry / notify_only + 预警比例（CORE-04）
├── maintenance-window.util.ts      任务级维护窗口半开区间判定（FEAT-06）
├── log-level.util.ts               levelOfLine 文本推断 ERROR/WARN/INFO/DEBUG（OBS-03）
├── entities/
│   ├── task.entity.ts              tasks 表（triggerType/runtime/blockStrategy/secrets/亲和标签…）
│   ├── task-execution.entity.ts    task_executions 表（状态机/failureReason/artifacts/traceId）
│   ├── execution-log-line.entity.ts execution_log_lines 表（lineNumber + level 复合索引）
│   └── task-version.entity.ts      task_versions 表（config 快照）
├── log-storage/s3-log-storage.ts   MinIO/S3 gzip 日志对象（LOG_STORAGE_DRIVER=s3 时启用）
└── log-retention/                  保留期清理：03:30 DB 行（分区 DETACH 主/DELETE 兜底）
                                    + 03:35 S3 日志对象回收（LOG_RETENTION_DAYS，默认 30）
```

## 关键机制

### 派发链路（触发 → 回调）

```
POST /api/tasks/:id/trigger ──┐
scheduler.enqueue (cron)  ────┤  事务建 PENDING TaskExecution
                              │  queue.add("execute", {executionId},
                              │    {attempts: max(1,maxRetry), backoff: exponential±20%,
                              │     priority: normalizeTaskPriority(...)})   → BullMQ "task-queue"
                              ▼
TaskProcessor.handle（并发 5）
  ① 原子 claim：UPDATE task_executions SET running
     WHERE id=? AND status IN ('pending','failed')   ← RUNNING 不可 claim（防双派发）
  ② ExecutorService.dispatch / dispatchBroadcast
  ③ 派发异常 → 失败分类（timeout/executor_offline/package_fetch_failed/
     script_error/unknown）→ 最后一次尝试时 AiAnalysisService.analyzeFailure
  ④ finally：事务 + 条件 UPDATE（writable IN ('pending','running')）落终态，
     成功后 publishTerminalEventForDispatch() → DomainEventBus
                              ▼
executor → POST /api/executions/callback（批量 ≤100，执行器 token 或 "v1." HMAC）
TaskService.handleCallback：地址比对 → winner 条件 UPDATE（open 状态守卫）
  → storeLogLines（S3 优先/DB 回退）→ artifacts 清单 → triggerDependentTasks
```

- **终态事件**：`TaskService.publishTerminalEventForDispatch`（task.service.ts:1698）只在「最后一次尝试 + 终态落库成功」后 emit `execution.completed` / `execution.failed`（常量见 `src/common/events/domain-events.ts`）；KILLED 走 `emitKilledEvent` → `execution.killed`。
- **双派发护栏**：`failureReason=timeout` 时 processor 抛 `UnrecoverableError`（BullMQ 不再重试，执行器可能仍在跑）；`task.retryableErrors` 非空时按 allow-list 过滤重试。
- **回调鉴权**：per-address bcrypt token（60s 正缓存）→ 共享 token 兜底（单执行器批次）→ 或 `v1.<executionId>.<expiresAt>.<hmac>` 一次性令牌（任务进程持有 `AUTOFLOW_CALLBACK_TOKEN`，绝不接触共享 token）。限流 `THROTTLE_CALLBACK_LIMIT`（默认 60/min/IP）。
- **日志双通道**：`LOG_STORAGE_DRIVER=s3` 时写 gzip 对象 `execution-logs/<execId>.log.gz`（上限 100MB 解压）；S3 失败回退 DB 行并把 `logStorage` 指针收回 `db`（BUG-06）。读取按行流式分页（`fromLine`/`limit`≤2000/`level` SQL 下推）。
- **S3 日志对象保留回收（WIKI-LOG-S3GC）**：`S3LogObjectRetentionService` 每日 03:35（与 03:30 DB 行清理、03:45 产物清理错峰）按 task_executions 的过期 s3 指针（`logStorage='s3'` + `logObjectKey` 非空 + 终态 + `COALESCE(endTime, createdAt)` 早于保留期截止）keyset 分页批量 `S3LogStorage.remove`，成功后**带守卫**清空 `logObjectKey`（`WHERE id AND logObjectKey`，防并发误清）；单行失败 fail-open 跳过等下轮 cron，非 s3 驱动整段 no-op。S3 成功路径不落 DB 行（对象回收的过期信号只能来自 task_executions），本服务兜住对象存储无限累积风险，bucket lifecycle 策略仍可作运维侧补充兜底。
- **SSE 并发闸门**：`acquireSseSlot` 两级上限（`SSE_MAX_STREAMS_PER_EXECUTION` 默认 4、`SSE_MAX_STREAMS_GLOBAL` 默认 64），超限 503；SSE 路由 `@SkipThrottle()` + `@SkipTimeout()`。
- **任务级 secrets**：`SEC_SECRETS_KEY` 配置后 AES-256-GCM 加密落库（`enc:v1:...`），API 脱敏回传，派发时解密注入执行器 env（`AUTOFLOW_<KEY>`），明文不二次入库（SEC-02）。
- **执行类写面归属口径（TASK-SCOPE-01）**：`POST /tasks/:id/{trigger,pause,resume}` 由
  `TASK_OPERATE_SCOPE` 控制 —— `any`（**默认**，既有宽松语义：任何已登录用户可操作任意
  任务，老部署升级零变化）/ `owner`（仅 ADMIN、任务属主、或该项目内 editor 及以上）。
  **项目 viewer 在任一档下始终被拒**（AUTH-02 硬约束）。注意这三个端点是历史上唯一不做
  归属校验的写面（`update`/`delete` 早已要求属主或 ADMIN），此前登记为 ADR-013 已知缺口。

- **归属项目（TASK-PROJ-01）**：`CreateTaskDto.projectId`（`@IsUUID` 可选）。省略/null =
  未分配 → 读面按 `IS NULL OR = DEFAULT_PROJECT_ID` 归入默认项目视图。写面经
  `assertCanAssignProject` 校验：项目须真实存在（否则 400，不让 FK 违例冒成 500），
  且调用方须为 ADMIN 或该项目 editor/admin（否则任何人都能把任务塞进/捞出别人的项目）。
  `update` 同样校验（缺省 = 保留旧归属）。**背景**：该列由迁移 1790000000008 建立并
  回填了存量任务，但 DTO 字段一直没做（迁移注释即写明此遗留），导致新任务永远 NULL、
  「项目隔离」对所有新任务塌缩到默认项目。

## 与其他模块的关系

- 依赖 [executor](executor.md)：派发/kill/日志回填/重试预算（`forwardRef` 双向环）。
- 依赖 [scheduler](scheduler.md)：`resume()` 调 `scheduleOne` 重注册；scheduler 也调 `TaskService.trigger` 类似逻辑入队（双向 `forwardRef`）。
- 依赖 [ai](ai.md)：`analyzeExecution`、`suggestSchedule`、processor 末次尝试失败分析。
- 依赖 [notification](notification.md) / [event-subscriptions](event-subscriptions.md)：终态事件由后两者的 listener 消费。
- 依赖 [artifacts](artifacts.md)（被其反向依赖）：回调携带 `artifacts` 清单写入 `task_executions.artifacts`。
- 被 [task-template](task-template.md) 依赖：`instantiate` 复用 `TaskService.create`。
- 被依赖：metrics 读 `ExecutionReport`/执行行；health 检查队列与调度状态。

## 常见改动场景

- 新增任务配置字段：`task.entity.ts` + `CreateTaskDto`/`UpdateTaskDto` + 迁移；如需进版本快照检查 `saveVersion`。
- 新增失败分类：`ExecutionFailureReason` 枚举 + processor 分类正则 + 回调路径 `inferFailureReason` 两处同步。
- 改派发重试语义：processor 的 `retryableErrors`/`UnrecoverableError` 逻辑与 [scheduler](scheduler.md) 的 stale sweep 预算兑现是两条恢复路径，改动需同时评估。
- 日志存储换后端：实现 `S3LogStorage` 同接口（put/get/getStream/remove/objectKey），`storeLogLines` 回退语义（指针收回）必须保留。

## 相关文档

- [scheduler](scheduler.md) · [executor](executor.md) · [ai](ai.md) · [artifacts](artifacts.md) · [task-template](task-template.md)
- [Task 实体](../../../03-data/entities/task.md) · [task-execution 实体](../../../03-data/entities/task-execution.md)（规划路径）
- [任务全链路](../../../04-flows/task-lifecycle.md) · [执行回调](../../../04-flows/execution-callback.md)
