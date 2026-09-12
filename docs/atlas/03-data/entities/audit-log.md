# AuditLog 实体（audit_logs 表）— 审计日志（append-only）

> 所属: docs/atlas/03-data · 最后核对: 2026-09-13 · 对应代码: apps/admin-api/src/modules/audit/entities/audit-log.entity.ts

## 所属模块与源文件

- 模块：[audit 模块](../../01-apps/admin-api/modules/audit.md)（`apps/admin-api/src/modules/audit/`）
- 源文件：`apps/admin-api/src/modules/audit/entities/audit-log.entity.ts`

## 表名

`audit_logs`（`@Entity("audit_logs")`）

## 字段表

主键 `id: int`（serial）。全字段：

| 列名 | 类型 | 说明 |
|---|---|---|
| `userId` | int nullable，有索引 | 操作者用户 id（系统触发可为 NULL） |
| `username` | varchar nullable | 操作者用户名冗余（防用户删除后无法溯源） |
| `action` | varchar NOT NULL | 动作标识（如 task.create、executor.rotate-token） |
| `resource` | varchar nullable | 资源类型 |
| `resourceId` | varchar nullable | 资源 id |
| `detail` | jsonb nullable | 变更明细（GIN 索引，支持 `@>` 包含查询） |
| `ip` | varchar nullable | 来源 IP |
| `result` | varchar，default `'success'` | 操作结果（success/failure 等） |
| `createdAt` | timestamptz，有索引 | 写入时间 |

## 索引与约束

| 索引/约束 | 定义处 | 说明 |
|---|---|---|
| `idx_audit_log_detail_gin` | 类级 `@Index("idx_audit_log_detail_gin", ["detail"])` | D-04：jsonb GIN 索引，加速 `detail @> …` 包含查询 |
| `userId` 单列索引 | 列级 `@Index()` | 按操作者过滤 |
| `createdAt` 单列索引 | 列级 `@Index()` | 时间范围/排序 |
| **append-only 触发器** | 迁移 `1790000000006-AuditLogsAppendOnlyGuard.ts` | 见下方 |

### append-only 防篡改（SEC-10）

DB 层触发器 `audit_logs_append_only_guard()`：`UPDATE`/`DELETE` 一律 `RAISE EXCEPTION`（SQLSTATE P0001, errcode=ACFAUDIT）。唯一放行口：会话显式 `SET LOCAL app.bypass_audit_guard = 'on'`——仅保留期清理任务（180 天，Q7）使用；直连 psql 默认仍被拦截。合法 UPDATE 场景经全仓核查为零。迁移幂等（`DROP TRIGGER IF EXISTS` + `CREATE TRIGGER`、函数 `CREATE OR REPLACE`）。

## 关系

- **引用**：`users.id`（无 FK，弱引用——`userId` 可悬垂）。
- **被引用**：无。审计行只写不改不删（触发器保证）。

## 生命周期与写入方

- **写入**：`AuditService.log(payload)`（唯一写入口，INSERT-only）。调用方遍布各控制器/服务：[task 模块](../../01-apps/admin-api/modules/task.md) 的 controller/processor/service/task-batch.controller、[users](../../01-apps/admin-api/modules/users.md)、[auth](../../01-apps/admin-api/modules/auth.md)、[executor](../../01-apps/admin-api/modules/executor.md)、[api-keys](../../01-apps/admin-api/modules/api-keys.md)、[app-deployment](../../01-apps/admin-api/modules/application.md)、执行事件 listener 等。
- **删除**：仅 `AuditService` 保留期清理（180 天）经 bypass GUC 执行。
- **读取**：`findAll` / `exportCsv`（只读 QueryBuilder），admin-web 审计页。

## 常见改动场景

1. **加列**（如 `userAgent`）：实体 `@Column` + 幂等迁移（`ADD COLUMN IF NOT EXISTS`，见 [migrations.md](../migrations.md)）+ `AuditLogPayload` 类型；注意**存量行不可 UPDATE 回填**（append-only 触发器），只能接受 NULL。
2. **改保留期**：AuditService 清理逻辑中的天数常量，无 schema 改动。
3. **新增审计埋点**：在对应 service/controller 调 `AuditService.log`，无需动表。
4. **测试**：`modules/audit/__tests__/audit-append-only.spec.ts` 覆盖触发器行为。
