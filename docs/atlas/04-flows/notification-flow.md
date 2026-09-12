# 通知链路：终态事件 → 扇出 → 静默 → 回执；脚本内主动上报

> 所属: docs/atlas/04-flows · 最后核对: 2026-09-13 · 对应代码: apps/admin-api/src/modules/notification、apps/admin-api/src/common/events/domain-events.ts、packages/autocodeflow-notify

## 链路 A：执行终态 → 告警（ARCH-21 订阅者）

```
 task.service.handleCallback (winner)                admin-api 同进程
 task.processor.handle (派发失败终态, BUG-21 单一出口)
 task.service.killExecution (KILLED, FEAT-18)
   │ emit（DomainEventBus，fail-open）
   ▼
 src/common/events/domain-events.ts: DOMAIN_EVENTS
   execution.failed ──────────┐
   execution.killed ──────────┤（复用 failed 监听路径，listener :46 onModuleInit 订阅）
   execution.completed ───────┘──▶ 通知侧刻意不订阅（成功本就不告警）；供出站 webhook/未来消费者
   │
   ▼
 ExecutionEventsListener.onExecutionFailed (execution-events.listener.ts:78)
   ├─ 按 event.taskId 回查 Task 告警配置：alarmEmail / alarmChannels / runbook
   ├─ 摘要 = failureReason + errorMessage（缺省回退回调日志头行），截 500 字符
   ▼
 NotificationService.notifyFailureWithConfig (notification.service.ts)
   ├─ isSilenced(taskId, level) (:506)：进程内 Map 同步热路径；命中即整体跳过
   ▼
 sendAll (:319) / sendToChannels (:336)
   ├─ 六渠道并发 send：email / dingtalk / wecom / slack / webhook / feishu（channels/ 目录各一 provider）
   ├─ BaseChannel.withRetry：3 次、1s 起指数退避；3xx/4xx 确定性拒绝不重试，仅 5xx/传输错误重试
   ├─ 出站前 assertSafeHttpUrl SSRF 守卫（fail-open 计 blocked，不抛错）
   ├─ 日志脱敏：buildContentDigest (:145) 只留长度+前 80 字符并剥离 token/密钥样式串（NOTIF-002）
   ▼
 恒 HTTP 2xx + 逐渠道回执 ChannelDeliveryStatus: sent | blocked | failed | skipped
   │  发送失败兜底：审计 NOTIFICATION_FAILED（listener catch，fail-open）
   ▼
 （并行、互不感知）event-subscriptions.OutboundEventDispatcher：同一总线投外部 webhook
   详见 [event-subscriptions 模块](../01-apps/admin-api/modules/event-subscriptions.md)
```

## 链路 B：任务脚本内主动通知（autocodeflow-notify）

```
 任务子进程（autoflow-sdk / 自写脚本）            admin-api
   │ NotifyClient.notify(...)                     │
   │ (packages/autocodeflow-notify/autocodeflow_notify/notify.py)
   │ POST {AUTOFLOW_ADMIN_API_URL}/api/notification/send
   │   {title, content, level, channels?, taskId?, webhookUrl?}
   │   Authorization: Bearer <调用方凭据>（可选）
   │─────────────────────────────────────────────▶ NotificationConfigController @Post("send")
   │                                              (notification-config.controller.ts:115)
   │                                              ├─ JwtAuthGuard 登录态（无 @Public；机器调用
   │                                              │  需有效凭据，N22 注释明确 guard 姿态）
   │                                              ├─ webhookUrl 自动补 webhook 渠道
   │                                              └─ → sendToChannels / sendAll（与链路 A 汇合）
   │◀─ 201 {success:true, results:[{channel,status}]}（恒 2xx，逐渠道回执）
   │ httpx 超时 10s；非 2xx 记 error 日志（R14：返回 False，绝不 raise）
```

- 客户端 `NotifyClient`（notify.py）方法：`notify` / `notify_failure` / `notify_success`；渠道枚举 `NotifyChannel`：email/dingtalk/wecom/slack/webhook（**无 feishu**，与 admin 侧六渠道不一致，属客户端子集）。
- Node 侧对等能力见 [autocodeflow-node-sdk](../02-packages/autocodeflow-node-sdk.md)（`http-client.ts`/`context.ts` 同走 `/api/notification/send`）。
- 凭据来源：任务内可用的用户 JWT 或 API Key（`manage` scope 可 POST；`task:trigger` 扩展域不含此路径）——见 [安全模型](security-model.md)。

## 链路 C：入站告警 webhook（Alertmanager 适配）

`POST /api/alerts/webhook`（`alerts.controller.ts`，`@Public()`）→ `alert-webhook.mapping.ts` 映射为标准 payload → `sendAll`。机器调用方不持 JWT，故该路由是唯一免鉴权入站发送面（限流由全局 throttler 兜底）。

## 静默期判定（NOTIF-003 → ARCH-31）

- **热路径**：进程内 `Map` 同步判定（`notification.service.ts:506` `isSilenced`），上限 `MAX_ALERT_SILENCES=1000`，每 60s 清理过期规则；scope=global/task/application，可按 channelType/level 收窄。
- **持久化**：`NotificationSilence` 实体写穿（写 DB + 回填 dbId）；跨实例一致性靠 15s TTL 读穿刷新（`SILENCE_REFRESH_MS`），无 Redis pub/sub。
- **降级**：DB 不可用时静默退化为内存态（重启即失效），可接受取舍。

## 失败分支与自愈

- **总线 fail-open**：`DomainEventBus.emit` 永不外抛；listener 内部还有第二层 try/catch + `NOTIFICATION_FAILED` 审计兜底——通知挂了绝不影响回调主链返回。
- **单渠道失败不扩散**：`sendToChannels` 逐渠道 catch，回执标 `failed`；SSRF 拦截标 `blocked`（不抛错）。
- **静默不生效排查**：实例间时钟差、`SILENCE_REFRESH_MS`、scope 是否精确命中（task 级静默需 taskId 精确匹配）、规则是否已被 1000 条上限挤出。
- **通知重复/缺失**：事件是"恰好在 winner 分支 emit 一次"的内存语义——进程在 emit 后崩溃不重放；排查缺失先查 `event_outbox`（出站 webhook 侧有 outbox 兜底，IM 侧没有）。

## 相关配置项（环境变量）

| 变量 | 作用 |
|---|---|
| `WECOM_WEBHOOK` / `DINGTALK_WEBHOOK` / `SLACK_WEBHOOK` | 渠道 env 兜底（DB `NotificationChannelConfig` 覆盖） |
| `EMAIL_HOST/PORT/SECURE/USER/PASS/FROM/TO` | SMTP 渠道兜底 |
| `SILENCE_REFRESH_MS` | 静默跨实例刷新周期（默认 15s） |
| `AUTOFLOW_ADMIN_API_URL`（任务 env，admin 注入） | 脚本内 `NotifyClient` 的 base URL |

## 常见改动场景

- **新增第七渠道**：继承 `BaseChannel`（实现 `name` + `send`）→ module providers 注册 → `sendAll` 扇出与 `testChannel` switch 各加一路 → `AlertChannel` 枚举加值（DTO/测试同步）；如需脚本内可用，同步 `autocodeflow-notify` 的 `NotifyChannel`。
- **让成功也通知**：给 `ExecutionEventsListener` 增订 `EXECUTION_COMPLETED`（载荷形状一致）；注意成功事件量级，先评估静默/限流。
- **改重试节奏**：`BaseChannel.withRetry` 默认 `{maxRetries:3, delayMs:1000, backoffMultiplier:2}`。
- **改告警摘要**：listener 的 500 字符截断与 `buildContentDigest` 的 80 字符脱敏摘要职责不同，勿混淆。

## 相关文档

- [notification 模块](../01-apps/admin-api/modules/notification.md) · [event-subscriptions 模块](../01-apps/admin-api/modules/event-subscriptions.md)
- [notify python 库](../02-packages/python-libs/notify.md) · [autocodeflow-notify 包](../02-packages/README.md)
- [notification-silence 实体](../03-data/entities/notification-silence.md) · [任务全生命周期](task-lifecycle.md)
