# audit 模块 — 审计日志

> 所属: docs/atlas/01-apps/admin-api/modules · 最后核对: 2026-10-20 · 对应代码: apps/admin-api/src/modules/audit

## 职责

平台级操作留痕：`AuditService.log()` 是全应用唯一的审计写入口；查询与 CSV 导出仅限 ADMIN。表级 append-only 保护（PG 触发器）保证审计行不可改删，仅保留一个受控的保留期清理通道。

## 目录结构与关键文件

```
modules/audit/
├── audit.module.ts        装配；export AuditService（被 8+ 个模块 import）
├── audit.controller.ts    @Controller("audit") 查询/导出（ADMIN-only）
├── audit.service.ts       log() / findAll / exportCsv / retention 清理
├── entities/audit-log.entity.ts  AuditLog 实体（audit_logs 表）
└── dto/audit-query.dto.ts 分页 + 过滤 DTO
```

`AuditLog` 字段：`userId`、`username`、`action`（如 `auth.login`、`user.create`、`apikey.create`）、`resource`、`resourceId`、`detail`（jsonb，GIN 索引 `idx_audit_log_detail_gin`）、`ip`、`result`（默认 `success`）、`createdAt`（索引）。

## 路由（controller 前缀 `audit`，均 JWT + `@Roles(ADMIN)`）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/audit` | 分页查询；过滤：`action` / `resource` / `resourceId` / `username` / `userId` / `startTime` / `endTime`（AUTH-05：`(resource, resourceId)` 对是收敛后的过滤维度） |
| GET | `/audit/export` | CSV 导出（同过滤条件，上限 10000 行，`Content-Disposition: attachment; filename="audit-logs.csv"`） |

## 关键机制

### 写入（log）

`log(payload: AuditLogPayload)` 只做一条 INSERT，`result` 缺省 `success`。payload 契约：

```ts
interface AuditLogPayload {
  userId?: number;        // 机器面（如 webhook）可省
  username?: string;
  action: string;         // 必填，<域>.<动作> 风格
  resource?: string;
  resourceId?: string;
  detail?: Record<string, any>;  // jsonb，GIN 索引支持 @> 包含查询（D-04）
  ip?: string;
  result?: "success" | "failure";
}
```

调用方普遍采用 **fail-open** 模式——审计写失败只 warn，不阻断主流程（auth/api-keys 的 `.catch` 与 `safeAudit` 包装都是此惯例）。

### append-only 保护（SEC-10，迁移 `1790000000006`）

```
audit_logs 上有 BEFORE UPDATE OR DELETE 触发器 → RAISE EXCEPTION
唯一放行点：audit.service.retentionDelete()
  事务内 SET LOCAL app.bypass_audit_guard = 'on'   ← 会话 GUC，提交即失效
  → DELETE ... WHERE createdAt < now()-180d
```

绕过面收敛为"能直连 DB 且显式开该 GUC 的进程"；应用代码里**不要**对 audit_logs 做 UPDATE/DELETE，会被触发器拒绝。

### 保留期清理

每日 02:05 `@Cron("0 5 2 * * *")` 执行 `cleanupOldAuditLogs`：删除 180 天前的行（走上面的 bypass 事务），清理动作本身只写服务日志，避免审计递归。

## 谁在写审计（**由代码生成，勿手改**）

下表由 `scripts/check-audit-actions-doc.mjs` 从 `apps/admin-api/src/**/*.ts` 里抽 `action: "<域>.<动作>"`
字面量生成并校验：**代码里新增一个 action 而文档没同步，守卫会红**（反向不校验——文档可以记录历史动作）。

共 **61** 个 action / **15** 个域。

| 域 | action |
|---|---|
| `apikey` | `apikey.auth_failure` · `apikey.create` · `apikey.revoke` · `apikey.used` |
| `application` | `application.create` · `application.delete` · `application.deploy` · `application.remove.fanout` · `application.update` |
| `artifact` | `artifact.download` |
| `auth` | `auth.login` · `auth.logout` · `auth.session.revoke` · `auth.session.revoke_others` |
| `deployment` | `deployment.approve` · `deployment.stop` |
| `executor` | `executor.cleanup_skipped` · `executor.rotate_token` |
| `member` | `member.grant` · `member.revoke` · `member.update` |
| `notification` | `notification.channel.update` · `notification.silence.create` · `notification.silence.delete` |
| `project` | `project.create` · `project.delete` · `project.update` |
| `registry` | `registry.pypi.upload` |
| `sop` | `sop.assign` · `sop.clarification.escalated` · `sop.clarify` · `sop.complete` · `sop.draft` · `sop.publish` · `sop.reply` · `sop.timeout.stalled` · `sop.timeout.unclaimed` · `sop.update` |
| `subscription` | `subscription.create` · `subscription.delete` · `subscription.update` |
| `task` | `task.batch_delete` · `task.batch_pause` · `task.batch_resume` · `task.batch_trigger` · `task.create` · `task.delete` · `task.import` · `task.pause` · `task.resume` · `task.rollback` · `task.trigger` · `task.trigger_api` · `task.trigger_dependency` · `task.trigger_webhook` · `task.update` · `task.webhook_disable` |
| `task_template` | `task_template.delete` |
| `user` | `user.create` · `user.delete` · `user.update` |

补充约定：

- `result: "failure"` 用于鉴权失败类事件（如 `apikey.auth_failure`）；其余缺省 `success`。
- 机器面（webhook / cron / 执行器）没有 `userId`，主体记在 `detail.actor`：执行器面是
  `executor:<id>`，系统扫描是 `system:sweep`。
- `detail` 只放 id、状态迁移两端、长度这类**事实**，**不放正文**（澄清问题/答复/交付结果/密钥）。
## 与其他模块的关系

- **被广泛依赖（被依赖方）**：auth、users、api-keys、application、executor、notification、task 各 controller/service/processor 均注入 `AuditService`（`AuditModule` 仅依赖 TypeORM，无反向依赖，不会成环）。
- **依赖数据层**：`TypeOrmModule.forFeature([AuditLog])` + `DataSource`（bypass 事务用）；实体细节见 [../../03-data/README.md](../../../03-data/README.md)（规划中）。
- **与 [config.md](config.md) 的区别**：config 模块有自己的 `config_history`（配置值变更史），不是本表；审计表面向"操作动作"，不存值前后镜像以外的配置语义。

## 常见改动场景

- **给新模块加审计**：import `AuditModule` → 注入 `AuditService` → 业务点调用 `log({...})`；遵循 fail-open（`.catch(warn)` 或自包 try/catch），`action` 命名沿既有 `<域>.<动作>` 风格（`auth.login`、`apikey.create`）。
- **加查询过滤条件**：改 `dto/audit-query.dto.ts` + `audit.service.findAll`；注意全局 ValidationPipe `forbidNonWhitelisted`——未声明的 query 参数会 400（R4 P1-2 的教训：过滤参数必须声明在同一个 DTO 上）。
- **调整保留期**：目前 180 天硬编码在 `cleanupOldAuditLogs`；改时同步确认触发器 bypass 通道仍覆盖新删除路径。
- **排查"审计没落库"**：先看调用方是否 fail-open 吞错，再确认表上触发器与 `app.bypass_audit_guard` 只影响清理任务。

## 相关文档

- 认证/用户/API Key 三个主要写入方：[auth.md](auth.md) / [users.md](users.md) / [api-keys.md](api-keys.md)
- 系统配置历史（另一条记录线）：[config.md](config.md)
- 安全模型：[../../04-flows/security-model.md](../../../04-flows/security-model.md)
