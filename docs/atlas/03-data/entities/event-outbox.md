# EventOutbox 实体（event_outbox 表）— 事务性事件发件箱（FEAT-19）

> 所属: docs/atlas/03-data/entities · 最后核对: 2026-09-13 · 对应代码: apps/admin-api/src/modules/event-subscriptions/entities/event-outbox.entity.ts

## 所属模块与源文件

- 模块：[event-subscriptions 模块](../../01-apps/admin-api/modules/event-subscriptions.md)（`apps/admin-api/src/modules/event-subscriptions/`）
- 源文件：`apps/admin-api/src/modules/event-subscriptions/entities/event-outbox.entity.ts`
- 定位：FEAT-19——出站 webhook 的跨进程 **at-least-once** 落库层：内存派发（进程内快速路径）同时写一行 outbox，**写成功才返回**——进程重启不丢待投事件

## 表名

`event_outbox`（`@Entity("event_outbox")`，迁移 `1790000000003-CreateEventOutbox` 建表，`1790000000012-AddEventOutboxLeases` 加租约列）

## 字段表

主键 `id: uuid`（`@PrimaryGeneratedColumn("uuid")`）。

| 列名 | 类型 | 说明 |
|---|---|---|
| `eventId` | varchar(64) NOT NULL | 事件追踪键（事件名 + 生成 uuid），与 `X-AutoCodeFlow-Event` 头同源；**非唯一**——at-least-once 允许重投，仅作追踪键 |
| `eventType` | varchar(64) NOT NULL | 事件名 |
| `payload` | jsonb NOT NULL | 出站信封全文（`event` / `occurredAt` / `data`），重投时**原样签名发送** |
| `dispatchedAt` | timestamptz nullable | **状态判据**：NULL = 未派发（扫描对象）；非空 = 已投递终态 |
| `attempts` | int NOT NULL，default `0` | outbox 路径累计失败次数（退避基数） |
| `nextAttemptAt` | timestamptz nullable | 下次补投时刻——失败后 `now + 指数退避`（**封顶 5min**） |
| `leaseUntil` | timestamptz nullable | 跨进程 claim 的**租约截止时刻**（迁移 `1790000000012`）；NULL = 当前无租约 |
| `leaseToken` | varchar(64) nullable | 当前租约持有者的随机 token——防止过期持有者终结新租约（fencing token） |
| `deadLettered` | boolean NOT NULL，default `false` | 超过阈值写入 [event-outbox-dead-letter](event-outbox-dead-letter.md) 后置 `true`——**行终态，不再扫描** |
| `createdAt` | timestamptz | `@CreateDateColumn` |

行状态由列组合表达（无独立 status 枚举列）：未派发 = `dispatchedAt IS NULL AND deadLettered=false`；已投递 = `dispatchedAt` 非空；终败 = `deadLettered=true`。

## 索引与约束

| 索引/约束 | 定义 | 说明 |
|---|---|---|
| `idx_event_outbox_dispatchedAt` | `(dispatchedAt)`（实体 + 迁移一致） | 扫描器判未派发行 |
| `idx_event_outbox_nextAttemptAt` | `(nextAttemptAt)` | 补投时刻排序 |
| `idx_event_outbox_eventId` | `(eventId)` | 追踪查询 |
| `idx_event_outbox_leaseUntil` | `(leaseUntil)`（迁移 `1790000000012`） | 租约过期回收 |
| FK | **无** | 独立投递层 |

## 关系

- **引用**：无 FK。
- **被引用**：[event-outbox-dead-letter](event-outbox-dead-letter.md).`outboxId`（DB FK **CASCADE** + unique）；派发目标订阅见 [event-subscription](event-subscription.md)（应用层关联）。

## 生命周期与写入方

- **创建**：`OutboundEventDispatcherService` 派发入口——内存派发同时写一行（写成功才返回）。
- **消费/更新**：`OutboxDispatcherService`（启动 + **每 5s 扫描**，`OUTBOX_SCAN_INTERVAL_MS = 5_000`）——扫描 `dispatchedAt IS NULL AND deadLettered=false` 的行，先抢租约（`leaseUntil = now + OUTBOX_LEASE_MS = 60_000` + 随机 `leaseToken`），逐行按既有派发语义（签名 POST + 退避重试）补投：成功回写 `dispatchedAt`；失败 `attempts+1`、`nextAttemptAt` 指数退避（封顶 5min）。
- **终态**：超阈值 → 先可靠写入 [event-outbox-dead-letter](event-outbox-dead-letter.md) 再置 `deadLettered=true`（行终态不再扫描）。
- **语义红线**：同一行可能在成功回写 `dispatchedAt` 前被多次投递（并发扫描/重启窗口）——**订阅方必须幂等消费**；`eventId` 仅追踪不作唯一约束。

## 常见改动场景

1. **调扫描/租约参数**：`OUTBOX_SCAN_INTERVAL_MS` / `OUTBOX_LEASE_MS` 常量（后者必须 > 单行最坏处理窗口，源码有启动断言），无迁移。
2. **加事件类型**：只动 `DOMAIN_EVENTS` 与派发点；outbox 行无需感知（payload 全量落）。
3. **加状态列**：实体 + 幂等迁移；注意扫描谓词 `dispatchedAt IS NULL AND deadLettered=false` 在多处 SQL 硬编码，需同步。
4. 相关流程：[任务生命周期](../../04-flows/task-lifecycle.md)、[通知链路](../../04-flows/notification-flow.md)。
