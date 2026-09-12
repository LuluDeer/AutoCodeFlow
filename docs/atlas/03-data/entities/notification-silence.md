# NotificationSilence 实体（notification_silences 表）— 告警静默窗口（FEAT-01）

> 所属: docs/atlas/03-data/entities · 最后核对: 2026-09-13 · 对应代码: apps/admin-api/src/modules/notification/entities/notification-silence.entity.ts

## 所属模块与源文件

- 模块：[notification 模块](../../01-apps/admin-api/modules/notification.md)（`apps/admin-api/src/modules/notification/`）
- 源文件：`apps/admin-api/src/modules/notification/entities/notification-silence.entity.ts`
- 同文件导出：`SILENCE_SCOPES = ["global", "task", "application"]`、`SilenceScope` 类型
- 定位：FEAT-01——替代 NOTIF-003 内存 Map（重启易失）的持久化载体；DB 不可用时降级回纯内存语义

## 表名

`notification_silences`（`@Entity("notification_silences")`，迁移 `1789100000000-CreateNotificationSilences` 建表）

## 字段表

主键 `id: uuid`（`@PrimaryGeneratedColumn("uuid")`）。

| 列名 | 类型 | 说明 |
|---|---|---|
| `scope` | varchar(16) NOT NULL，default `'global'` | 静默范围：`global`（静默所有渠道所有通知）/ `task`（单任务，`taskId` 必填）/ `application`（某应用下任务，`applicationId` 必填） |
| `channelType` | varchar(32) nullable | 空 = 全渠道；指定 = 仅该渠道（`email`/`slack`/`dingtalk`/`wecom`/`webhook`） |
| `taskId` | varchar(64) nullable | scope=task 时的目标任务 id |
| `applicationId` | varchar(64) nullable | scope=application 时的目标应用 id |
| `level` | varchar(32) nullable | 空 = 所有级别；否则 `info`/`warning`/`critical` 等 AlertLevel |
| `reason` | varchar(255) nullable | 静默原因（运维留痕） |
| `startTime` | timestamptz nullable | 生效起点 |
| `endTime` | timestamptz nullable | **过期时刻**——空 = 永不过期；`durationMinutes` 写入时折算成此列 |
| `durationMinutes` | int nullable | 输入侧便捷字段（折算后仅展示用途，判定走 endTime） |
| `createdBy` | varchar(128) nullable | 创建人 |
| `createdAt` | timestamptz | `@CreateDateColumn` |

## 索引与约束

| 索引/约束 | 定义 | 说明 |
|---|---|---|
| `idx_notification_silences_endTime` | `(endTime)`（实体 + 迁移一致） | 过期清理/活跃窗口扫描 |
| `idx_notification_silences_scope_taskId` | `(scope, taskId)` | 按任务查静默 |
| FK | **无** | taskId/applicationId 是字符串弱引用，目标删除后静默行悬垂（无害，到期自动失效） |

## 关系

- **引用**：[task](task.md)、[application](application.md)（字符串弱引用，无 FK）。
- **被引用**：无表引用它；消费方是 `NotificationService`（发送前判定）与 `NotificationSilenceService`（[notification 模块](../../01-apps/admin-api/modules/notification.md)）。

## 生命周期与写入方

- **创建**：`NotificationSilenceService`（admin-web 静默管理页；`durationMinutes` 折算 `endTime`）——**写穿** DB。
- **读取（热路径）**：`NotificationService` 仍持**内存 Map** 做发送前判定；本表是**重启后的恢复源**（`onModuleInit` 回灌内存 Map）。
- **删除**：管理页手动解除；过期行（endTime 已过）判定时自然跳过。
- **注意**：DB 不可用时降级回纯内存语义（重启丢失），属可接受的降级路径。

## 常见改动场景

1. **加 scope 维度**：`SILENCE_SCOPES` 加值（varchar 无迁移）+ 对应目标列 + 内存 Map 匹配逻辑同步。
2. **加级别/渠道值**：无 DDL（varchar），同步校验 DTO 与前端选项。
3. **改判定优先级/组合语义**：改 `NotificationService` 热路径匹配 + 回灌逻辑，需同步 spec（重启恢复是关键用例）。
4. 相关流程：[通知链路](../../04-flows/notification-flow.md)。
