# NotificationChannelConfig 实体（notification_channel_configs 表）— 通知渠道配置（ARCH-31）

> 所属: docs/atlas/03-data/entities · 最后核对: 2026-09-13 · 对应代码: apps/admin-api/src/modules/notification/entities/notification-channel-config.entity.ts

## 所属模块与源文件

- 模块：[notification 模块](../../01-apps/admin-api/modules/notification.md)（`apps/admin-api/src/modules/notification/`）
- 源文件：`apps/admin-api/src/modules/notification/entities/notification-channel-config.entity.ts`
- 定位：ARCH-31——渠道配置此前是 `ChannelConfigStore` 纯进程内 Map（多实例下「保存只在保存它的实例生效」），本实体让保存落 DB，其余实例按刷新周期读穿（矩阵 🔴→🟡，TTL 内收敛）

## 表名

`notification_channel_configs`（`@Entity("notification_channel_configs")`，迁移 `1790000000014-CreateNotificationChannelConfigs` 建表）

## 字段表

主键 `key: varchar(32)`（`@PrimaryColumn`——**业务键主键，非自增/uuid**）。

| 列名 | 类型 | 说明 |
|---|---|---|
| `key` | varchar(32) NOT NULL，PK | 渠道键：`email` / `slack` / `dingtalk` / `wecom` / `webhook` / `feishu` |
| `config` | jsonb NOT NULL，default `'{}'::jsonb` | **RAW（未脱敏）** 配置对象，形如 `{ webhookUrl, secret? }`——与 system_config / env 的存储面同姿态，脱敏只发生在控制器读面；**本表不得被任何读面端点直接透出** |
| `enabled` | boolean，default `false` | N37：渠道开关与配置**同行**存储，防止半状态（开了但没配置 / 配了但没开） |
| `updatedAt` | timestamptz | `@UpdateDateColumn`（也作为读穿缓存的失效判断） |

## 索引与约束

| 索引/约束 | 定义 | 说明 |
|---|---|---|
| `idx_notification_channel_configs_updatedAt` | `(updatedAt)`（实体 + 迁移一致） | 按更新时间排序/刷新判断 |
| PK | `(key)` | 渠道键唯一，天然 upsert 目标 |

## 关系

- **引用**：无（渠道配置独立表，不挂 user/project）。
- **被引用**：无表引用它；消费方是 `ChannelConfigStore`（[notification 模块](../../01-apps/admin-api/modules/notification.md)）与各渠道实现（`channels/*.channel.ts`：email/slack/dingtalk/wecom/webhook/feishu）。

## 生命周期与写入方

- **创建/更新**：`ChannelConfigStore.save`（notification-config 控制器保存动作**写穿**到 DB；RAW 值直存）。
- **读取**：`ChannelConfigStore` 内存缓存 + TTL 读穿（其他实例按刷新周期拉取）；DB 不可用时降级回纯进程内 Map 语义。
- **删除**：无业务删除路径（渠道行只有 enabled 开关）。
- **只读消费方**：告警发送热路径（`NotificationService` → 各 channel）。

## 常见改动场景

1. **加渠道**：`channels/` 新 channel 类 + `key` 约定值（varchar 无枚举约束，无迁移）+ admin-web 渠道配置页。
2. **加配置字段**：只改 config jsonb 的写入/读取结构（无迁移）；历史行旧结构需读取侧兼容。
3. **⚠️ 安全红线**：任何新读面端点都不得直接透出本表（`config` 是 RAW 明文），必须走控制器脱敏面。
4. 相关流程：[通知链路](../../04-flows/notification-flow.md)。
