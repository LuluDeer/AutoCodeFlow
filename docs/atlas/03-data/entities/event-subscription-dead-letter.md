# EventSubscriptionDeadLetter 实体（event_subscription_dead_letters 表）— 订阅投递死信（FEAT-07）

> 所属: docs/atlas/03-data/entities · 最后核对: 2026-09-13 · 对应代码: apps/admin-api/src/modules/event-subscriptions/entities/event-subscription-dead-letter.entity.ts

## 所属模块与源文件

- 模块：[event-subscriptions 模块](../../01-apps/admin-api/modules/event-subscriptions.md)（`apps/admin-api/src/modules/event-subscriptions/`）
- 源文件：`apps/admin-api/src/modules/event-subscriptions/entities/event-subscription-dead-letter.entity.ts`
- 定位：FEAT-07——一次派发经最多 `MAX_DELIVERY_ATTEMPTS = 3` 次指数退避重试仍失败（网络错误/5xx/超时）后**整包落本表**

## 表名

`event_subscription_dead_letters`（`@Entity("event_subscription_dead_letters")`，迁移 `1789900000000-CreateEventSubscriptions` 同批建表）

## 字段表

主键 `id: uuid`（`@PrimaryGeneratedColumn("uuid")`）。

| 列名 | 类型 | 说明 |
|---|---|---|
| `subscriptionId` | uuid NOT NULL | 所属订阅（DB FK `fk_dead_letters_subscription` → `event_subscriptions.id` **ON DELETE CASCADE**） |
| `eventType` | varchar(64) NOT NULL | 事件名（`execution.failed` / `executor.offline` / `deployment.completed` …） |
| `payload` | jsonb NOT NULL | 发送时的**完整载荷原文**（含签名字段）——重放的数据源 |
| `error` | varchar(1024) NOT NULL | 最后一次失败原因摘要 |
| `attempts` | int NOT NULL，default `0` | 实际尝试次数（含首次与全部重试；正常终败 = 3） |
| `createdAt` | timestamptz | `@CreateDateColumn`（死信落库时刻） |

## 索引与约束

| 索引/约束 | 定义 | 说明 |
|---|---|---|
| `idx_event_subscription_dead_letters_sub` | `(subscriptionId, createdAt)`（实体 + 迁移一致） | 按订阅列死信 |
| `fk_dead_letters_subscription` | `subscriptionId` → `event_subscriptions.id` **CASCADE**（迁移 `1789900000000`） | 订阅删除连坐死信行 |

## 关系

- **引用**：[event-subscription](event-subscription.md)（FK CASCADE）。
- **被引用**：无表引用它；注意与本表区分——[event-outbox-dead-letter](event-outbox-dead-letter.md) 是 **outbox 源行**的终败记录（一次事件可发多个订阅、无单一订阅属主），两者故意分开。

## 生命周期与写入方

写入方在 `OutboundEventDispatcherService`（[event-subscriptions 模块](../../01-apps/admin-api/modules/event-subscriptions.md)）：

- **创建**：单订阅派发终败时落一行（attempts = `MAX_DELIVERY_ATTEMPTS`），同时给订阅行 `consecutiveFailures` +1。
- **重放**：`POST /event-subscriptions/:id/dead-letters/:dlId/replay`——以订阅**当前** url/secret 重新签名派发一次（不自动重试），**成功即删行**；属主/ADMIN 可操作。
- **查看**：`GET /event-subscriptions/:id/dead-letters`（属主/ADMIN）。
- **删除**：重放成功删除；订阅删除级联。

## 常见改动场景

1. **改重试策略**：`MAX_DELIVERY_ATTEMPTS` / `retryDelayMs` 在 `event-subscription.util.ts`，改动影响死信行 `attempts` 语义与订阅端 spec。
2. **加死信保留策略**（TTL 清理/上限）：当前无清理路径，需新增定时清理（参考 [refresh-token](refresh-token.md) 的过期清理模式）。
3. **加字段**：实体 + 幂等迁移；`payload` 已含完整原文，一般无需扩列。
4. 相关流程：[任务生命周期](../../04-flows/task-lifecycle.md)、[通知链路](../../04-flows/notification-flow.md)。
