# 认证与信任链全景

> 所属: docs/atlas/04-flows · 最后核对: 2026-09-13 · 对应代码: apps/admin-api/src/common/guards/jwt-auth.guard.ts、modules/auth、modules/api-keys、modules/executor/executor.service.ts、common/utils/（secret-crypto、verify-executor-token）、modules/audit

## 凭据矩阵（谁在调谁，用什么凭证）

```
 ┌──────────────┬──────────────────────────────┬──────────────────────────────────────┐
 │ 调用方        │ 凭证                          │ 校验锚点                              │
 ├──────────────┼──────────────────────────────┼──────────────────────────────────────┤
 │ 用户/浏览器   │ JWT access token（15m）        │ jwt.strategy.ts（type==="access" 强制）│
 │              │ + refresh token（30d，jti 落库）│ auth.service.generateTokens          │
 │ CI/脚本      │ API Key "acf_..."（三档 scope） │ jwt-auth.guard.ts:25 前缀分派 +       │
 │              │                               │ api-key-auth.helper.ts sha256 查表    │
 │ 执行器(机器)  │ 共享 token EXECUTOR_SECRET     │ verify-executor-token.util.ts        │
 │              │ per-executor token（bcrypt 持久）│ executor.service.ts:1715             │
 │              │   validateTokenByAddress      │                                      │
 │ 任务子进程    │ AUTOFLOW_CALLBACK_TOKEN        │ execution-callback-token.util.ts      │
 │              │ （v1.<id>.<exp>.<hmac>，一次性）│ （无 DB 往返的无状态验签）             │
 │ 外部订阅方    │ HMAC 签名头三元组               │ event-subscription.util.ts           │
 └──────────────┴──────────────────────────────┴──────────────────────────────────────┘
```

## 用户 JWT 双 token（auth 模块）

- access：`{sub, username, type:"access", sid:<jti>}`，密钥 `JWT_SECRET`，`JWT_EXPIRES_IN` 默认 15m；refresh：`{..., type:"refresh", jti:<uuid>}`，独立密钥 `JWT_REFRESH_SECRET`，30d 且逐 jti 落 `refresh_tokens` 表。
- 轮换 fail-closed：先 `UPDATE refresh_tokens SET revoked=true`（0 行 = 已吊销 → 401）再签发新对（`auth.service.ts` refreshToken）。
- `JwtStrategy.validate` 强制 `type==="access"`——refresh token 冒充不了 access；SSE 路由允许 `?access_token=` 查询参数兜底（EventSource 无法带 Header）。
- 防爆破：锁定检查 → 未知用户比对 `DUMMY_BCRYPT_HASH`（F-4 防时序枚举）→ 5 次失败锁 15 分钟（R10 过期清零防永久再锁）；TOTP 2FA 走 `/totp/*`。

## API Key 三档 scope（AUTH-03 / NF-01）

- 三档：`readonly`（全 GET）/ `trigger`（readonly + 任务触发 POST）/ `manage`（非排除写全量）——`api-key.entity.ts:17` `ApiKeyScope`。
- 判定纯函数：`api-key-scope.util.ts` `scopeAllows` + `isTaskTriggerPath`（`tasks/<id>/trigger` 正则；batch trigger 显式白名单）；`task:trigger` 扩展域（`API_KEY_EXTRA_SCOPES`）叠加在 legacy 三档之上，只开单任务触发，永不放宽读写。
- JWT-only 硬排除：`jwt-auth.guard.ts:35` `JWT_ONLY_API_KEY_PATHS = ["api-keys","auth","users"]`——泄露的 Key 永远碰不到凭据管理面。
- Key 形态：`acf_` 前缀；`keyHash = sha256(明文)` 唯一索引；`keyPrefix` 前 8 字符仅展示；明文只在创建响应出现一次；吊销是软删（`revokedAt`），审计留痕。

## 机器间信任边界（执行器三段链）

```
 引导(安装/注册)            常驻(心跳/领取)                 每执行(回调/产物)
 EXECUTOR_SECRET 共享token  per-executor token             v1 HMAC per-execution token
 ─────────────────▶ 注册 ─────────────────▶ 心跳/执行 ─────────────────▶ 任务子进程回调
 verifyExecutorToken       rotateToken → bcrypt tokenHash  AUTOFLOW_CALLBACK_TOKEN
 (timingSafeEqual)         validateTokenByAddress          HMAC(secret, "v1.<id>.<exp>")
                           60s 正缓存 F-5                   secret 候选三层（见回调篇）
```

- 共享 token 来源顺序：DB 轮转值（`system_configs` key `executor.sharedToken`）→ env `EXECUTOR_SECRET`（`verify-executor-token.util.ts` `getExecutorSharedToken`）——DB 轮换无需重启。
- 隔离原则：任务子进程只见一次性 `v1.` token，永不接触共享/per-executor token（SEC-01 env 白名单 `SECRET_ENV_DENYLIST` 恒剥离 `EXECUTOR_SHARED_TOKEN`/`EXECUTOR_SECRET`/`EXECUTION_CALLBACK_SECRET`）。
- 回调面纵深：per-address 校验 + 地址与执行行比对（`task.service.ts:1825` handleCallback）+ 批内多执行器禁用共享 token 兜底（TASK-001）+ v1 token 绑定单一 executionId。
- 双向出站防伪：admin → 执行器走共享 token Bearer + `assertSafeExecutorUrl` SSRF 守卫（F-3）；admin → 订阅方走 HMAC 三元组（`X-AutoCodeFlow-Event/Timestamp` + `X-Hub-Signature-256`，±5min 时间窗）。

## 敏感数据处理

| 主题 | 机制 | 锚点 |
|---|---|---|
| 任务 secrets 静态加密 | `SEC_SECRETS_KEY`（32 字节 hex/base64）→ AES-256-GCM，密文 `enc:v1:` 前缀；未配置 = 降级明文（每进程 warn 一次）；API 脱敏回传，派发时解密注入 `AUTOFLOW_<KEY>` | `common/utils/secret-crypto.util.service.ts`（SEC-02） |
| 日志脱敏 | `buildContentDigest` 只留长度+前 80 字符并剥离 token/密钥样式串 | `notification.service.ts:145`（NOTIF-002） |
| 审计 append-only | DB 触发器（迁移 1790000000006）拒绝 UPDATE/DELETE；唯一放行点 = 180 天保留清理的事务内 GUC `app.bypass_audit_guard='on'` | `audit.service.ts`（SEC-10） |
| 凭据哈希存储 | 执行器 tokenHash bcrypt cost 12；API Key sha256；refresh token 存 jti 不存原文 | 各 entity/service |
| 注入防御 | register/heartbeat 均字段白名单（F-7/F-2），caller 永远写不了 `tokenHash/status/runningTaskCount` 等服务方列 | `executor.service.ts:488`/:746 |
| 限流分域 | 登录 20/min（`LOGIN_THROTTLE_LIMIT`）、auth 严格档 10/min（AUTH_THROTTLE）、回调 60/min（`THROTTLE_CALLBACK_LIMIT`）——分域矩阵 `src/config/throttle-profiles.ts` | throttle-profiles |

## 失败分支与自愈

- **token 泄露**：共享 token 走 DB 轮转（system-config API，热生效）；单执行器走 `POST /api/executors/:id/rotate-token`（ADMIN）；执行器 401 后 30s 退避经 `/api/executors/token` 重签自愈——见 [executor-registration](executor-registration.md)。
- **JWT 泄露**：`/logout` 吊销该用户全部 refresh token；`/sessions/revoke-others` 精确吊销其他会话；access token 只能等 15m 过期（无黑名单）。
- **secrets key 轮换**：换 `SEC_SECRETS_KEY` 后旧密文按惰性策略在下一次更新时重加密；两把 key 期间读取需旧 key——操作前先备份数据。
- **审计绕过审计面**：任何路径的 UPDATE/DELETE 会被触发器拒绝（防篡改）；清理只能走 `cleanupOldAuditLogs` 的 bypass 事务（SEC-10）。

## 常见改动场景

- **新增公开路由**：`@Public()` 只跳过 JwtAuthGuard——机器面（register/heartbeat/callback/artifact）还必须保留自己的 token 校验，勿裸奔。
- **新增 scope**：`ApiKeyScope`/`API_KEY_EXTRA_SCOPES` + `scopeAllows` 矩阵 + 迁移 + 前端展示；先读 `api-key.entity.ts` 头注的判定顺序。
- **调整 access 有效期**：`JWT_EXPIRES_IN`（env）；refresh 的 30d 硬编码在 `generateTokens` 两处（JWT expiresIn 与 expiresAt 落库），改时同步。
- **加新机器端点**：选凭证档位（共享引导 / per-executor / per-execution HMAC），对齐 `throttle-profiles.ts` 机器回调档与 SSRF 守卫。

## 相关文档

- [auth 模块](../01-apps/admin-api/modules/auth.md) · [api-keys 模块](../01-apps/admin-api/modules/api-keys.md) · [executor 模块](../01-apps/admin-api/modules/executor.md) · [audit 模块](../01-apps/admin-api/modules/audit.md)
- [执行回调](execution-callback.md) · [执行器注册](executor-registration.md) · [审批流](approval-flow.md)
- [audit-log 实体](../03-data/entities/audit-log.md) · [api-key 实体](../03-data/entities/api-key.md) · [refresh-token 实体](../03-data/entities/refresh-token.md)
