# EventOutboxDeadLetter 实体（event_outbox_dead_letters 表）— 发件箱终败死信（FEAT-19）

> 所属: docs/atlas/03-data/entities · 最后核对: 2026-09-13 · 对应代码: apps/admin-api/src/modules/event-subscriptions/entities/event-outbox-dead-letter.entity.ts

## 所属模块与源文件

- 模块：[event-subscriptions 模块](../../01-apps/admin-api/modules/event-subscriptions.md)（`apps/admin-api/src/modules/event-subscriptions/`）
- 源文件：`apps/admin-api/src/modules/event-subscriptions/entities/event-outbox-dead-letter.entity.ts`
- 定位：FEAT-19 reliability——outbox 源行的终败记录；**故意与订阅死信分开**：一行 outbox 代表一个可能发给多个订阅的事件，没有单一订阅属主

## 表名

`event_outbox_dead_letters`（`@Entity("event_outbox_dead_letters")`，迁移 `1790000000013-CreateEventOutboxDeadLetters` 建表）

## 字段表

主键 `id: uuid`（`@PrimaryGeneratedColumn("uuid")`）。

| 列名 | 类型 | 说明 |
|---|---|---|
| `outboxId` | uuid NOT NULL，**unique** | 源 [event-outbox](event-outbox.md) 行（DB FK → `event_outbox.id` **ON DELETE CASCADE**；unique 约束保证一行源行至多一条终败记录） |
| `eventType` | varchar(64) NOT NULL | 事件名（从源行复制） |
| `payload` | jsonb NOT NULL | 完整出站信封——运维排查/重放依据 |
| `attempts` | int NOT NULL | outbox 路径累计尝试次数（**含最后一次终败尝试**，与订阅死信的语义一致化命名不同） |
| `lastError` | varchar(1024) NOT NULL | 最后一次投递失败摘要（dispatcher 截断） |
| `deadLetteredAt` | timestamptz NOT NULL | 源行被可靠置为死信态的时刻 |
| `createdAt` | timestamptz | `@CreateDateColumn` |

## 索引与约束

| 索引/约束 | 定义 | 说明 |
|---|---|---|
| `uq_event_outbox_dead_letters_outboxId` | `(outboxId)` **UNIQUE**（实体 + 迁移一致） | 一行 outbox 至多一条终败记录（幂等写保证） |
| `idx_event_outbox_dead_letters_createdAt` | `(createdAt)` | 死信列表按时间 |
| `fk → event_outbox.id` | **ON DELETE CASCADE**（迁移 `1790000000013`） | 源行删除连坐终败记录（源码注释：「deleting the source removes its terminal record」） |

## 关系

- **引用**：[event-outbox](event-outbox.md)（FK CASCADE，唯一挂点）。
- **被引用**：无表引用它；与 [event-subscription-dead-letter](event-subscription-dead-letter.md) 职责互补——本表记「事件源行终败」（无订阅属主），订阅死信记「单订阅投递终败」。

## 生命周期与写入方

写入方仅 `OutboxDispatcherService`（[event-subscriptions 模块](../../01-apps/admin-api/modules/event-subscriptions.md)）：

- **创建**：outbox 行补投超阈值时——**先**写本表（可靠落终败证据），**再** guardedly 置源行 `deadLettered=true`（顺序保证不丢证据；聚合指标里有 `deadLetterPersistenceFailures` 专记本表写失败的异常路径）。
- **更新**：无（append-only 终态记录）。
- **删除**：仅随源 outbox 行级联；无业务删除/重放端点（重放需求走订阅死信的 replay）。

## 常见改动场景

1. **加运维端点**（死信列表/重放）：payload 已含完整信封，直接消费本表；重放需重建 outbox 行而非改本表。
2. **加字段**：实体 + 幂等迁移；unique(outboxId) 约束与「先写死信再标源行」的写入顺序是可靠性核心，改动需同步 spec。
3. **加保留策略**：当前无清理；注意与源行的 CASCADE 关系——删本表行不影响源行，删源行会连坐本表。
4. 相关流程：[通知链路](../../04-flows/notification-flow.md)、[任务生命周期](../../04-flows/task-lifecycle.md)。
