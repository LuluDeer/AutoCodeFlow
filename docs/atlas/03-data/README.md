# 数据层总览（03-data）

> 所属: docs/atlas/03-data · 最后核对: 2026-09-13 · 对应代码: apps/admin-api/src/data-source.ts · apps/admin-api/src/modules/*/entities/

## 一句话定位

AutoCodeFlow 的持久层是 **PostgreSQL + TypeORM 0.3**：26 个实体分散在 admin-api 各模块（`apps/admin-api/src/modules/*/entities/*.entity.ts`，两个例外在模块根），schema 全部由 `apps/admin-api/src/migrations/`（迁移数**以 `ls apps/admin-api/src/migrations` 为准**，当前 68 个）演进，`synchronize` 恒关闭。Redis 仅承载 BullMQ 队列与缓存，不在本文档范围。

## 数据库与连接配置（以代码为准）

**CLI 迁移路径**（`src/data-source.ts`，`npm run migration:*` 均走它）：

| 配置项 | 环境变量 | 默认值 |
|---|---|---|
| host | `DB_HOST` | `localhost` |
| port | `DB_PORT` | `5432` |
| username | `DB_USERNAME` | `autoflow` |
| password | `DB_PASSWORD` | （空） |
| database | `DB_DATABASE` | `autoflow` |
| 日志级别 | `NODE_ENV` | 非 production 打印 query+error |

实体 glob：`src/modules/**/*.entity{.ts,.js}`（覆盖模块根直放的 `project/project.entity.ts` 与 `executor-package/executor-package.entity.ts`）；迁移 glob：`src/migrations/*{.ts,.js}`；`synchronize: false`。

**运行面**（`app.module.ts` → `buildTypeOrmDataSourceOptions()`，`src/config/configuration.ts`）：`migrationsRun: NODE_ENV !== "development"`（非 dev 启动自动跑迁移）；`synchronize` 由显式开关 `DB_SYNCHRONIZE` 收口（默认关）；`DB_READ_REPLICA_URL` 非空时启用读写分离（SELECT 走 replica，迁移恒走 master）。运行时依赖还有 Redis/BullMQ（队列，见 [admin-api README](../01-apps/admin-api/README.md)）与 MinIO/S3（产物与日志对象，见 [execution-log-line](entities/execution-log-line.md)）。

## 实体索引（全部 26 个）

✍ = 本批次已写详解；其余为规划路径，由下一批次补充。

### 任务执行域（task / task-template）

| 表名 | 模块 | 实体文件 | 一句话 | 文档 |
|---|---|---|---|---|
| `tasks` | task | `task/entities/task.entity.ts` | 任务定义（触发/运行时/路由/重试/告警策略全集） | [task](entities/task.md) ✍ |
| `task_executions` | task | `task/entities/task-execution.entity.ts` | 执行实例（7 态状态机 + 结果/日志指针/产物清单） | [task-execution](entities/task-execution.md) ✍ |
| `task_versions` | task | `task/entities/task-version.entity.ts` | 任务配置版本快照（不可变） | [task-version](entities/task-version.md) ✍ |
| `execution_log_lines` | task | `task/entities/execution-log-line.entity.ts` | 执行日志明细行（**按日分区**） | [execution-log-line](entities/execution-log-line.md) ✍ |
| `task_templates` | task-template | `task-template/entities/task-template.entity.ts` | 任务模板（官方 seed + 自定义，一键克隆） | [task-template](entities/task-template.md) ✍ |

### 执行器域（executor / executor-package）

| 表名 | 模块 | 实体文件 | 一句话 | 文档 |
|---|---|---|---|---|
| `executors` | executor | `executor/entities/executor.entity.ts` | 执行器注册表（心跳/能力/标签/令牌/并发上限） | [executor](entities/executor.md) ✍ |
| `executor_metrics_history` | executor | `executor/entities/executor-metrics-history.entity.ts` | 执行器性能指标快照（时序） | [executor-metrics-history](entities/executor-metrics-history.md) ✍ |
| `executor_packages` | executor-package | `executor-package/executor-package.entity.ts` | 执行器分发包（上传/推送历史） | [executor-package](entities/executor-package.md) ✍ |

### 统计与审计

| 表名 | 模块 | 实体文件 | 一句话 | 文档 |
|---|---|---|---|---|
| `execution_reports` | metrics | `metrics/entities/execution-report.entity.ts` | 按日执行统计报表（task_executions 聚合） | [execution-report](entities/execution-report.md) ✍ |
| `audit_logs` | audit | `audit/entities/audit-log.entity.ts` | 审计日志（**append-only 触发器**防篡改） | [audit-log](entities/audit-log.md) ✍ |

### 应用与部署域（application）

| 表名 | 模块 | 实体文件 | 一句话 | 文档 |
|---|---|---|---|---|
| `applications` | application | `application/entities/application.entity.ts` | 应用注册 | [application](entities/application.md) |
| `application_versions` | application | `application/entities/application-version.entity.ts` | 应用版本 | [application-version](entities/application-version.md) |
| `app_deployments` | application | `application/entities/app-deployment.entity.ts` | 应用部署记录（含审批/灰度列） | [app-deployment](entities/app-deployment.md) |

### 认证与身份域（auth / users / api-keys）

| 表名 | 模块 | 实体文件 | 一句话 | 文档 |
|---|---|---|---|---|
| `users` | users | `users/entities/user.entity.ts` | 用户（含 TOTP/会话元数据列） | [user](entities/user.md) |
| `refresh_tokens` | auth | `auth/entities/refresh-token.entity.ts` | JWT 刷新令牌 | [refresh-token](entities/refresh-token.md) |
| `api_keys` | api-keys | `api-keys/entities/api-key.entity.ts` | API 密钥（含任务触发作用域） | [api-key](entities/api-key.md) |

### 配置与通知域（config / notification）

| 表名 | 模块 | 实体文件 | 一句话 | 文档 |
|---|---|---|---|---|
| `system_configs` | config | `config/entities/system-config.entity.ts` | 系统配置键值 | [system-config](entities/system-config.md) |
| `config_history` | config | `config/entities/config-history.entity.ts` | 配置变更历史 | [config-history](entities/config-history.md) |
| `notification_channel_configs` | notification | `notification/entities/notification-channel-config.entity.ts` | 通知渠道配置 | [notification-channel-config](entities/notification-channel-config.md) |
| `notification_silences` | notification | `notification/entities/notification-silence.entity.ts` | 告警静默窗口 | [notification-silence](entities/notification-silence.md) |

### 事件与项目域（event-subscriptions / project）

| 表名 | 模块 | 实体文件 | 一句话 | 文档 |
|---|---|---|---|---|
| `event_subscriptions` | event-subscriptions | `event-subscriptions/entities/event-subscription.entity.ts` | 事件订阅定义 | [event-subscription](entities/event-subscription.md) |
| `event_subscription_dead_letters` | event-subscriptions | `event-subscriptions/entities/event-subscription-dead-letter.entity.ts` | 订阅投递死信 | [event-subscription-dead-letter](entities/event-subscription-dead-letter.md) |
| `event_outbox` | event-subscriptions | `event-subscriptions/entities/event-outbox.entity.ts` | 事件发件箱（含租约列） | [event-outbox](entities/event-outbox.md) |
| `event_outbox_dead_letters` | event-subscriptions | `event-subscriptions/entities/event-outbox-dead-letter.entity.ts` | 发件箱死信 | [event-outbox-dead-letter](entities/event-outbox-dead-letter.md) |
| `projects` | project | `project/project.entity.ts` | 多租户项目（AUTH-01，**实体在模块根**） | [project](entities/project.md) |
| `project_members` | project | `project/entities/project-member.entity.ts` | 项目成员 | [project-member](entities/project-member.md) |

## 实体关系总览（ASCII 简图，只画核心关系）

```
users ─────────────┐ (弱引用 userId)
                   ▼
projects ◄─projectId─ [tasks] [executors] [executor_packages]   (FK ON DELETE SET NULL)
applications ◄─applicationId─ [tasks]      (ManyToOne SET NULL, 无 DB FK)
                   │
        ┌──────────┼──────────────────┐
        │ FK CASCADE                  │ (无 FK, 仅索引)
        ▼                             ▼
  [task_executions]            [task_versions]
        │ executionId (无 FK)
        ▼
  [execution_log_lines] (按日分区)
        ▲ 聚合
  [execution_reports]（按日一行, triggerDay 唯一）

[task_templates] ──实例化(应用层)──► tasks            （无 FK）
[executors] ◄─address 字符串─ [executor_metrics_history]（无 FK）
[tasks].executorId ──pinning──► executors            （故意无 FK）
[audit_logs] 独立 append-only，仅弱引用 userId
```

完整核心域详解（FK/索引/坑）见 [er-core.md](er-core.md)。

## 迁移机制

见 [migrations.md](migrations.md)：命名规范（13 位时间戳 + 类名后缀一致）、执行命令（`npm run migration:run|revert|generate -d src/data-source.ts`）、`migrations.spec.ts` 守护（无重复 timestamp/严格递增/幂等抽查）、迁移的分期节点（数量以 `ls` 为准）、加迁移的标准动作。

## 阅读路线

- 改某张表前：先读本页定位实体 → 读对应 `entities/*.md`（字段/索引/写入方/改动场景）→ 配合 [admin-api 模块文档](../01-apps/admin-api/README.md)（业务行为）→ 需要时序细节看 [04-flows](../04-flows/task-lifecycle.md)。
- 加字段/加表的标准动作：[migrations.md](migrations.md)「常见改动场景」。
