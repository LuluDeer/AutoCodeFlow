# AutoFlow 问题记录与修复追踪

> 参考项目：[xxl-job](../xxl-job)，对照分析后整理的问题清单。
> 每修复一项，在状态栏更新。

---

## 优先级说明

- 🔴 高优先级 — 功能 bug 或运行时错误，影响核心流程
- 🟡 中优先级 — 逻辑缺陷，不立即崩溃但行为不正确
- 🟢 低优先级 — 改进项，可按需安排

---

## 问题清单

### [FIX-01] 🔴 Slack 告警渠道未注入 NotificationService

- **文件**：`apps/admin-api/src/modules/notification/notification.service.ts`
- **问题**：`SlackChannel` 已实现但未在 `NotificationService` 构造函数中注入，`sendAll()` 不会发送 Slack 消息。
- **修复**：注入 `SlackChannel` 并在 `sendAll()` 中调用。
- **状态**：✅ 已修复

---

### [FIX-02] 🔴 任务更新/删除/暂停后旧调度器未精确停止

- **文件**：`apps/admin-api/src/modules/task/task.service.ts`
- **问题**：`TaskService.update()` 直接 `save` 数据库，不通知 `SchedulerService`；`remove()` 将状态改为 DELETED 但不停止调度器。依赖 `SchedulerService` 每分钟 reload 才能感知变化，最长有 60s 的调度漂移窗口。
- **影响**：暂停/删除的任务在下一次 reload 前仍会继续执行。
- **修复**：`TaskService` 注入 `SchedulerService`，在 `update()`/`remove()` 后立即调用 `schedulerService.stop(id)` 并按新状态重新注册。
- **状态**：✅ 已修复

---

### [FIX-03] 🔴 执行器离线检测定时任务未挂载

- **文件**：`apps/admin-api/src/modules/executor/executor.service.ts`
- **问题**：`markStaleOffline()` 方法存在但没有 `@Cron` 装饰器，执行器下线后状态永远显示 ONLINE，导致 `dispatch()` 可能把任务路由到不可用节点。
- **修复**：在 `markStaleOffline()` 加 `@Cron('*/30 * * * * *')`，每 30s 扫描一次，超时阈值从 60s 调整为 90s（执行器心跳 30s，给 3 次容错）。
- **状态**：✅ 已修复

---

### [FIX-04] 🔴 dispatch 未按 runtime/capabilities 过滤执行器

- **文件**：`apps/admin-api/src/modules/executor/executor.service.ts`
- **问题**：`dispatch()` 只按 `runningTaskCount` 最小值选执行器，没有过滤 capabilities。Python 任务可能被路由到只支持 Node.js 的执行器，导致执行失败。
- **修复**：在 dispatch 中先过滤 `capabilities.includes(task.runtime)`，再按负载排序。
- **状态**：✅ 已修复

---

### [FIX-05] 🟡 丢失任务检测缺失（僵尸 execution）

- **文件**：`apps/admin-api/src/modules/executor/executor.service.ts`
- **问题**：执行器突然宕机时，RUNNING 状态的 execution 永远不会收到回调，状态卡在 RUNNING。没有定时清理机制。
- **参考**：xxl-job `JobCompleteHelper` 每 60s 扫描运行超过 10min 且执行器离线的任务，主动标记 FAILED。
- **修复**：新增 `@Cron('0 */5 * * * *')` 定时任务，扫描 RUNNING 超过 `timeout+5min` 且执行器 OFFLINE 的 execution，标记为 FAILED 并追加系统日志。
- **状态**：✅ 已修复

---

### [FIX-06] 🟡 阻塞处理策略缺失（并发执行保护）

- **文件**：`apps/admin-api/src/modules/task/entities/task.entity.ts`、`task.processor.ts`
- **问题**：上次执行尚未完成时，新触发会直接并发执行，可能造成资源争用或数据重复处理。
- **参考**：xxl-job `ExecutorBlockStrategyEnum`：SERIAL（排队）、DISCARD（丢弃新触发）、COVER（中断旧的）。
- **修复**：Task 实体增加 `blockStrategy` 字段（SERIAL/DISCARD），在 `SchedulerService.enqueue()` 前检查是否有 RUNNING execution。
- **状态**：✅ 已修复

---

### [TODO-07] 🟢 调度分布式锁（多实例部署保护）

- **文件**：`apps/admin-api/src/modules/scheduler/scheduler.service.ts`
- **问题**：多实例部署时，每个实例都有独立的内存调度器，同一任务会被重复触发。
- **建议**：使用 Redis SET NX + TTL 在 `enqueue()` 前获取分布式锁，key 为 `lock:task:{taskId}:{triggerTime}`。
- **状态**：✅ 已修复（scheduler.service enqueue 前用 Redis SET NX 分布式锁，key=lock:schedule:{taskId}:{10s时间窗}，TTL=70s）

---

### [TODO-08] 🟢 调度 next_trigger_time 持久化（misfire 补偿）

- **文件**：`apps/admin-api/src/modules/task/entities/task.entity.ts`
- **问题**：重启后内存调度器丢失，期间应触发的任务被静默跳过，无补偿机制。
- **参考**：xxl-job 在 DB 持久化 `trigger_next_time`，重启后补偿过期触发。
- **建议**：Task 增加 `nextTriggerTime` 字段，重启时扫描过期任务执行 misfire 策略。
- **状态**：✅ 已修复（Task 增加 lastTriggerTime/misfireStrategy 字段；enqueue 后异步记录触发时间；onModuleInit 调用 checkMisfires 补偿检测）

---

### [TODO-09] 🟢 执行日志流式存储

- **文件**：`apps/admin-api/src/modules/task/entities/task-execution.entity.ts`
- **问题**：日志以 `text` 列存数据库，大任务日志膨胀，不支持实时查看。
- **参考**：xxl-job 执行器将日志写本地文件，通过 `/log?fromLine=N` 分页拉取，前端 Rolling 实时显示。
- **建议**：执行器写本地文件，admin-api 通过轮询拉取，前端 SSE 推送。
- **状态**：📋 待实现

---

### [TODO-10] 🟢 任务级告警配置

- **文件**：`apps/admin-api/src/modules/task/entities/task.entity.ts`
- **问题**：告警渠道全局统一，无法按任务配置。
- **建议**：Task 增加 `alarmEmail`、`alarmChannels` 字段，失败时按任务配置选择渠道。
- **状态**：✅ 已修复（Task 增加 alarmEmail/alarmChannels 字段；notification.service 新增 notifyFailureWithConfig；task.processor 失败时按任务配置发送告警）
