# event-subscriptions 模块 — 领域事件出站订阅（webhook / outbox / dead-letter）

> 所属: docs/atlas/01-apps/admin-api/modules · 最后核对: 2026-09-13 · 对应代码: apps/admin-api/src/modules/event-subscriptions

## 职责

FEAT-07 + FEAT-19：把平台领域事件以带 HMAC 签名的 webhook 推送到外部订阅方。两级投递：进程内快速路径（首投 + 3 次退避 → 死信）+ `event_outbox` 跨进程兜底（at-least-once，重启不丢）；死信可查询、可重放。与 [notification](notification.md)（站内 IM/邮件）并行，互不感知。

## 目录结构与关键文件

```
modules/event-subscriptions/
├── event-subscription.module.ts           装配 + OUTBOUND/OUTBOX_DISPATCHER_TOKEN 两个别名
├── event-subscription.controller.ts       @Controller("event-subscriptions") CRUD + 死信
├── event-subscription.service.ts          订阅 CRUD / 属主校验 / secret 脱敏 / 死信存取
├── event-subscription.util.ts             可订阅事件目录 / 重试退避 / payload 信封（单一事实源）
├── outbound-event-dispatcher.service.ts   快速路径：订阅 DomainEventBus → HTTP 签名投递
├── outbox-dispatcher.service.ts           FEAT-19 兜底：5s 扫描补投 / 租约 / outbox 死信
├── dto/event-subscription.dto.ts
└── entities/
    ├── event-subscription.entity.ts             event_subscriptions 表
    ├── event-subscription-dead-letter.entity.ts event_subscription_dead_letters（FK CASCADE）
    ├── event-outbox.entity.ts                   event_outbox 表
    └── event-outbox-dead-letter.entity.ts       event_outbox_dead_letters（无 subscriptionId FK）
```

## 路由（controller 前缀 `event-subscriptions`，实际路径 `/api/event-subscriptions`）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/` | 列表（ADMIN 看全部；普通用户看自己的 + 系统级） |
| POST | `/` | 创建（**ADMIN-only**，见下方 SUB-SCOPE-01；上限 `MAX_EVENT_SUBSCRIPTIONS=200`） |
| PATCH / DELETE | `/:id` | ADMIN 或属主；删除级联清理订阅死信 |
| GET | `/:id/dead-letters` | 死信分页（limit 上限 100） |
| POST | `/:id/dead-letters/:dlId/replay` | 重放一条死信 |

## ⚠️ 投递面不做属主过滤（读面有、投递面没有）

**上表的「列表按属主过滤」只约束读面，投递面是全局广播** —— 这是本模块最容易误读的地方，
故单独说明（本轮审计补记：此前文档只写了列表过滤，读起来像存在租户隔离，实际并非如此）。

- 派发条件是 `where: { enabled: true }`（`outbound-event-dispatcher.service.ts` 的
  `dispatch`），**没有任何 owner/userId 过滤**；四条可订阅事件（`execution.completed` /
  `execution.failed` / `executor.offline` / `deployment.completed`）在平台上是**全局发布**的。
- 因此关键在于**谁能创建订阅**：这正是下一条收紧的原因。

## SUB-SCOPE-01：创建订阅已收紧为 ADMIN-only（本轮行为变更）

**变更**：`POST /event-subscriptions` 由「任何已登录用户」收紧为 `@Roles(ADMIN)`。

**为什么**：投递端不做属主过滤（见上），而可订阅事件全局发布，所以此前**任何已登录用户
建一条订阅，就能持续收到别人任务的终态 webhook**——载荷含 `taskName`、`errorMessage`、
`logs`（`ExecutionTerminalEventPayload`）。这既是跨租户信息泄露（日志里可能带内部地址、
业务数据、误打的密钥），也是一条绕开审批的隐蔽出站通道；而审计面上它只显示为
"某人创建了订阅"。webhook 是「把数据送出平台」的能力，与通知渠道配置、执行器共享
token 同级，本就属管理面（对照：`/notification/channels` 已是 ADMIN-only）。

**明确不收的部分**（避免误读为"功能被砍"）：
- 读面不变：非管理员仍可 `GET /` 看自己的 + 系统级订阅、仍可看死信；
- 已有订阅不变：`PATCH`/`DELETE` 维持「ADMIN 或属主」，故非管理员**此前创建的订阅
  依然有效、可启停、可编辑、可删除**，不会因本次收紧而失效；
- 前端相应处理：非管理员看到**禁用**的「新建订阅」按钮 + 说明性 Tooltip，
  而不是点了才吃 403。

**若要进一步做租户隔离**：需给投递加属主过滤（`where: { enabled, userId }`），但事件
本身未必有明确"归属者"，需先改事件载荷的数据模型——那是独立议题，不在本次范围。

## 关键机制

### 可订阅事件目录（稳定契约，只增不改）

`SUBSCRIBABLE_EVENTS`（event-subscription.util.ts）：

| 事件名 | 发布点 |
|---|---|
| `execution.completed` | task.service handleCallback winner 分支（终态落库后） |
| `execution.failed` | 同上 + processor 派发失败终态（`publishTerminalEventForDispatch`） |
| `executor.offline` | executor.service 三路 OFFLINE 翻转（心跳超时 sweep / 优雅停机 / 管理台下线） |
| `deployment.completed` | 应用部署 RUNNING 终态落库后 |

事件名常量同源于 `src/common/events/domain-events.ts`（`DOMAIN_EVENTS`）；`execution.killed` 在总线存在但**未开放订阅**（目录只含上面四个）。

### 投递与签名

```
DomainEventBus emit → OutboundEventDispatcher.deliverToSubscribers
  ├─ 同步落 event_outbox 行（写成功才算"已接收"，FEAT-19）
  ├─ 内存快照匹配订阅（eventTypes 含事件名即命中）
  └─ 每订阅：10s 超时（与 notification webhook 渠道对齐）× 3 次尝试
      退避 1s/2s/4s（封顶 30s）→ 终败落 event_subscription_dead_letters
请求头（与 applications 发版 webhook 入站校验逐字节一致）：
  X-AutoCodeFlow-Event: <事件名>
  X-AutoCodeFlow-Timestamp: <毫秒时间戳，订阅方应校验 ±5min 窗>
  X-Hub-Signature-256: "sha256=" + hex(HMAC-SHA256(secret, `${timestamp}.${rawBody}`))
payload 信封：{ event, occurredAt, data }（data 全原始类型）
```

- 快速路径全投成功 → `outbox.markFastPathDelivered(rowId)` 收口兜底行（条件 UPDATE：未被补投扫描 claim 才生效），避免每个成功事件被扫描重复投一遍。
- 订阅 secret：32 字节 hex（服务端代生成时创建响应**一次性**回显明文）；读面恒 `******` 脱敏。
- URL 建/改均过 `assertSafeHttpUrl`（DNS 解析逐地址拒内网）。

### Outbox 兜底（FEAT-19）

- `OutboxDispatcher` 每 5s（`OUTBOX_SCAN_INTERVAL_MS`）扫 `dispatchedAt IS NULL AND deadLettered=false AND nextAttemptAt 到期` 的行；单轮 claim **1 行**（`FOR UPDATE SKIP LOCKED` CTE 写租约，`OUTBOX_LEASE_MS=60s` > 单行最坏处理窗 33s）。
- 失败退避 5s × 2^(n-1) 封顶 5min；超过 `MAX_OUTBOX_ATTEMPTS=20` → 事务内先写 `event_outbox_dead_letters` 再置行 `deadLettered=true`（先死信后终态，持久化失败行保持可重试）。
- 无订阅可投的行直接回写 `dispatchedAt`（防冷订阅期无限积压）；`EVENT_OUTBOX_ENABLED=false` 整体旁路（回退 FEAT-07 原行为）。
- 与快速路径的 DI 环用 `ModuleRef` 懒取令牌（`OUTBOUND_DISPATCHER_TOKEN` / `OUTBOX_DISPATCHER_TOKEN`）解开——**不互相构造器注入**。

## 与其他模块的关系

- 依赖 common：`DomainEventModule`（@Global，事件源）、`assertSafeHttpUrl`（SSRF）。
- 事件生产方：[task](task.md)（execution.*）、[executor](executor.md)（executor.offline）、application（deployment.completed）——三者只 emit，不知晓订阅存在。
- 被 [notification](notification.md) 并行：两者都消费同一事件总线，通道不同（IM/邮件 vs 外部 webhook）。
- 订阅方契约：**必须幂等**（at-least-once，重复投递场景：部分失败收口失败 / 租约竞态 / 重放）。

## 常见改动场景

- 开放新事件：`DOMAIN_EVENTS` 加常量 + 发布点 emit + `SUBSCRIBABLE_EVENTS` 加名（只增不改）；如需 killed 语义直接解锁 `execution.killed` 进目录即可。
- 调整投递节奏：`OUTBOUND_TIMEOUT_MS` / `retryDelayMs` / `outboxRetryDelayMs` / `MAX_OUTBOX_ATTEMPTS` 全在 event-subscription.util.ts（单一事实源）。
- 排查订阅方没收到：看订阅行 `consecutiveFailures/lastFailureError` → 查 `event_subscription_dead_letters` → 用 replay 重放；怀疑进程窗口丢失则查 `event_outbox` 未派发行。
- 订阅方验签示例：按表头三元组本地重算 HMAC-SHA256 比对 `X-Hub-Signature-256`，并校验时间戳 ±5min。

## 相关文档

- [task](task.md)（execution.* 事件源）· [executor](executor.md)（executor.offline）· [notification](notification.md)
- [领域事件总线](../../../04-flows/notification-flow.md)（规划路径）
