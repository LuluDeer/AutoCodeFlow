# notification 模块 — 通知渠道与静默期

> 所属: docs/atlas/01-apps/admin-api/modules · 最后核对: 2026-09-13 · 对应代码: apps/admin-api/src/modules/notification

## 职责

告警通知的扇出中枢：六个渠道（企微/钉钉/Slack/飞书/SMTP 邮件/通用 webhook）的配置存储、连通性测试、消息发送与逐渠道投递结果回报；告警静默规则（scope/channel/level）；执行终态事件的统一通知订阅者（ARCH-21）；Alertmanager 等 webhook 入站适配。

## 目录结构与关键文件

```
modules/notification/
├── notification.module.ts            装配：六个 Channel provider + listener + 两个 controller
├── notification.service.ts           sendAll / sendToChannels / notifyXxx 家族 / 静默热路径
├── notification-config.controller.ts @Controller("notification") 渠道配置与静默 CRUD
├── alerts.controller.ts              @Controller("alerts") POST /webhook（@Public，Alertmanager 入站）
├── notification-config.service.ts    渠道配置读写（DB system_configs 持久层）
├── notification-silence.service.ts   静默规则 DB 写穿层（FEAT-01/ARCH-31）
├── channel-config.store.ts           渠道配置共享载体（env 兜底 + DB 覆盖）
├── alert-webhook.mapping.ts          入站 webhook → 告警 payload 映射
├── execution-events.listener.ts      订阅 execution.failed / execution.killed → 按任务告警配置发送
├── channels/                         base.channel.ts + wecom/dingtalk/email/slack/webhook/feishu
└── entities/                         notification-silence / notification-channel-config 实体
```

## 路由

| 控制器 | 方法 路径 | 鉴权 | 说明 |
|---|---|---|---|
| `notification` | GET `/channels` | JWT | 渠道配置读面（敏感值脱敏） |
| | PATCH `/channels/:key` | JWT | 保存单渠道配置 |
| | POST `/channels/:key/test`、`/test` | JWT | 连通性测试（per-call override 不落全局，R2） |
| | POST `/send` | JWT | 手动发一条通知（`SendNotificationDto`，返回逐渠道结果） |
| | GET/POST/DELETE `/silences` | JWT | 静默规则管理 |
| `alerts` | POST `/api/alerts/webhook` | `@Public()` | 通用入站告警 webhook（机器调用方不持 JWT） |

## 关键机制

### 渠道扇出（sendAll / sendToChannels）

```
payload {title, content, level, vars?}
  → 静默判定（isSilenced：内存 Map 同步热路径；scope=global/task/application，
     可按 channelType/level 收窄；命中即整体跳过）
  → 逐渠道并发 send()：BaseChannel.withRetry（3 次，1s 起指数退避；
     3xx/4xx 视为确定性拒绝不再重试，仅 5xx/传输错误重试）
  → 每渠道返回 ChannelDeliveryStatus: "sent" | "blocked"(SSRF) | "failed" | "skipped"(未配置)
  → HTTP 恒 2xx（通知失败绝不 500 任务回调），body 逐渠道回执（V2 round-7）
```

- 渠道枚举 `AlertChannel`：`email` / `dingtalk` / `wecom` / `slack` / `webhook` / `feishu`（第六类，NF-05）。env 兜底：`WECOM_WEBHOOK`、`DINGTALK_WEBHOOK`、`SLACK_WEBHOOK`、`EMAIL_HOST/PORT/SECURE/USER/PASS/FROM/TO`；DB 配置（`NotificationChannelConfig`）覆盖 env。
- 所有渠道出站过 `assertSafeHttpUrl` SSRF 守卫（fail-open 计 `blocked`，不抛错）。
- 渠道级模板（FEAT-10）：渠道配置可存 `titleTemplate`/`contentTemplate`，`renderTemplate` 单 pass 替换、8KB 上限、未知变量保留原文。
- 日志脱敏：`buildContentDigest` 只留长度 + 前 80 字符并剥离 token/密钥样式串（NOTIF-002）。

### 执行失败通知（ARCH-21 订阅者）

`ExecutionEventsListener` 订阅 `DOMAIN_EVENTS.EXECUTION_FAILED` 与 `EXECUTION_KILLED`（**不含** success）：按 `taskId` 回查任务的 `alarmEmail/alarmChannels/runbook` 告警配置 → `notifyFailureWithConfig` 定向发送（无配置任务走默认渠道集）；发送失败写 `NOTIFICATION_FAILED` 审计兜底。派发阶段失败（executor 未接单）由 processor 落库后发布的同一事件覆盖（BUG-21 修复，单一语义出口）。

### 静默期（NOTIF-003 → ARCH-31）

- 热路径：进程内 `Map`（同步判定），上限 `MAX_ALERT_SILENCES=1000`，每 60s 清理过期规则。
- 持久化：`NotificationSilence` 实体写穿（写 DB + 回填 `dbId`）；跨实例一致性用 15s TTL 读穿刷新（`SILENCE_REFRESH_MS` 可调，无 Redis pub/sub），防误删有 `observedInDb` 观察标记。纯内存降级：DB 不可用时静默退化为重启即失效（可接受取舍）。

## 与其他模块的关系

- 依赖 [task](task.md)：读 Task 实体（告警配置回查）——由 [task](task.md) 的终态事件驱动，被 [task](task.md) import。
- 依赖 [audit](audit.md)：`NOTIFICATION_FAILED` 兜底审计。
- 被 [executor](executor.md) 依赖：`notifyExecutorOnline/Offline`（注册/心跳超时）。
- 消费领域事件：`execution.failed` / `execution.killed`；[event-subscriptions](event-subscriptions.md) 是并行的出站 webhook 订阅者（两者互不感知）。

## 常见改动场景

- 新增渠道：继承 `BaseChannel`（实现 `name` + `send(payload, override?)`），module providers 注册，`sendAll` 扇出与 `testChannel` switch 各加一路，`AlertChannel` 枚举加值（注意保持测试与 DTO 同步）。
- 调整重试节奏：`BaseChannel.withRetry` 默认 `{maxRetries: 3, delayMs: 1000, backoffMultiplier: 2}`。
- 静默不生效排查：确认实例间时钟、`SILENCE_REFRESH_MS`、以及规则 scope 是否命中（task 级静默需要 taskId 精确匹配）。

## 相关文档

- [task](task.md)（终态事件源）· [event-subscriptions](event-subscriptions.md)（并行出站通道）· [executor](executor.md)（上下线通知）
- [通知链路](../../../04-flows/notification-flow.md)（规划路径）
- [Task 实体](../../../03-data/entities/task.md)（alarmEmail/alarmChannels/runbook 字段，规划路径）
