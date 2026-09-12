# EventSubscription 实体（event_subscriptions 表）— 出站事件订阅（FEAT-07）

> 所属: docs/atlas/03-data/entities · 最后核对: 2026-09-13 · 对应代码: apps/admin-api/src/modules/event-subscriptions/entities/event-subscription.entity.ts

## 所属模块与源文件

- 模块：[event-subscriptions 模块](../../01-apps/admin-api/modules/event-subscriptions.md)（`apps/admin-api/src/modules/event-subscriptions/`）
- 源文件：`apps/admin-api/src/modules/event-subscriptions/entities/event-subscription.entity.ts`
- 定位：FEAT-07——一个订阅 = 一个回调 URL + 一组订阅事件名 + 一个 HMAC 签名密钥

## 表名

`event_subscriptions`（`@Entity("event_subscriptions")`，迁移 `1789900000000-CreateEventSubscriptions` 建表）

## 字段表

主键 `id: uuid`（`@PrimaryGeneratedColumn("uuid")`）。

| 列名 | 类型 | 说明 |
|---|---|---|
| `userId` | int nullable | 创建者（→ [user](user.md)，无 FK）；**NULL = 系统级订阅（仅 ADMIN 可建）** |
| `eventTypes` | jsonb NOT NULL | 订阅的事件名**字符串数组**，如 `["execution.failed"]`；与 `DOMAIN_EVENTS` 常量对齐（`execution.completed` / `execution.failed` / `executor.offline` / `deployment.completed`），匹配语义在 `event-subscription.util.ts` |
| `url` | varchar(2048) NOT NULL | 回调 URL——写入前经 `assertSafeHttpUrl` SSRF 校验，**出站派发时二次校验** |
| `secret` | varchar(256) NOT NULL | HMAC-SHA256 签名密钥——create 未提供则服务端随机 32 字节 hex；**任何读端点都不回显**（列表/详情固定占位） |
| `enabled` | boolean，default `true` | 启用开关 |
| `consecutiveFailures` | int NOT NULL，default `0` | 连续失败次数（成功派发即清零；终败死信落库时 +1）——自动禁用等策略的输入 |
| `lastFailureAt` | timestamptz nullable | 最近失败时刻 |
| `lastFailureError` | varchar(512) nullable | 最近失败摘要（截 512，排障用；**不含 secret/payload 原文**） |
| `createdAt` / `updatedAt` | timestamptz | `@CreateDateColumn` / `@UpdateDateColumn` |

## 索引与约束

| 索引/约束 | 定义 | 说明 |
|---|---|---|
| `idx_event_subscriptions_userId` | `(userId)`（实体 + 迁移一致） | 按用户列订阅 |
| `idx_event_subscriptions_enabled` | `(enabled)` | 派发时筛启用行 |
| FK | **无** | 用户删除后订阅悬垂（属主判定按 id 比对） |

## 关系

- **引用**：[user](user.md)（int 弱引用）。
- **被引用**：
  - [event-subscription-dead-letter](event-subscription-dead-letter.md).`subscriptionId`（DB FK **CASCADE**）；
  - [event-outbox](event-outbox.md) 派发时按本表 enabled 行分发（应用层，无 FK）。

## 生命周期与写入方

写入方在 `EventSubscriptionService` / `OutboundEventDispatcherService`（[event-subscriptions 模块](../../01-apps/admin-api/modules/event-subscriptions.md)）：

- **创建**：订阅 CRUD（属主或 ADMIN；URL 过 SSRF 校验；secret 未提供则生成）。
- **更新**：CRUD 编辑（url/secret/eventTypes/enabled）；派发路径更新失败统计（`consecutiveFailures` / `lastFailureAt` / `lastFailureError`，成功清零）。
- **删除**：CRUD 删除 → 死信行级联删除。
- **只读消费方**：`OutboundEventDispatcher`（内存派发热路径）、`OutboxDispatcher`（补投时读 url/secret/eventTypes/consecutiveFailures）。

## 常见改动场景

1. **加事件名**：`DOMAIN_EVENTS` 常量加值 + 各业务模块派发点调用；本表无需迁移（jsonb 数组）。
2. **加失败熔断策略**（连续 N 次自动禁用）：消费 `consecutiveFailures` 字段即可，注意与 `enabled` 手动开关的互斥语义。
3. **加字段**：实体 + 幂等迁移（模板参考 `1790000000000`/`1789900000000`）。
4. 相关流程：[任务生命周期](../../04-flows/task-lifecycle.md)、[安全模型](../../04-flows/security-model.md)（规划，HMAC 签名约定）。
