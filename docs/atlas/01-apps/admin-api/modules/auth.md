# auth 模块 — 认证（登录 / JWT / refresh token / TOTP）

> 所属: docs/atlas/01-apps/admin-api/modules · 最后核对: 2026-09-13 · 对应代码: apps/admin-api/src/modules/auth

## 职责

用户名密码登录、JWT access/refresh 双 token 签发与轮换、refresh token 持久化与吊销、TOTP 两步验证（2FA）、登录会话（session）管理。是全平台唯一签发用户凭证的模块。

## 目录结构与关键文件

```
modules/auth/
├── auth.module.ts            装配：PassportModule + JwtModule + UsersModule + AuditModule
├── auth.controller.ts        @Controller("auth") 全部路由
├── auth.service.ts           登录/刷新/TOTP/会话核心逻辑
├── strategies/jwt.strategy.ts  passport-jwt 策略（全局 JwtAuthGuard 的底层）
├── totp.util.ts              generateTotpSecret / totpVerify / buildOtpauthUrl
├── entities/refresh-token.entity.ts  refresh_tokens 表（jti 唯一索引）
└── dto/                      login / refresh-token / totp / revoke-session DTO
```

## 路由（controller 前缀 `auth`，实际路径带全局前缀 `/api/auth`）

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| POST | `/login` | `@Public()`，限流 `LOGIN_THROTTLE_LIMIT`（默认 20/min） | 返回 `{accessToken, refreshToken}`；TOTP 用户返回 `{totpRequired: true}` |
| POST | `/refresh` | `@Public()`，严格档 AUTH_THROTTLE（默认 10/min） | token 轮换：旧 refresh token 先吊销再签发新对 |
| POST | `/logout` | JWT | 吊销该用户全部 refresh token |
| GET | `/profile` | JWT | 当前用户信息 |
| POST | `/totp/setup` `/totp/enable` `/totp/disable` | JWT | 2FA 暂存/激活/关闭 |
| POST | `/totp/verify` | `@Public()` | 2FA 第二因子登录（重新验密码 + 验码） |
| GET | `/sessions` | JWT | 我的活跃会话列表（当前会话标记 `current`） |
| DELETE | `/sessions/:id` | JWT | 吊销单个会话 |
| POST | `/sessions/revoke-others` | JWT | 吊销除当前外的全部会话 |

## 关键机制

### token 模型（auth.service.generateTokens）

```
access token   : {sub, username, type:"access", sid:<jti>, ver:<sessionVersion>} 签名密钥 JWT_SECRET，
                 有效期 JWT_EXPIRES_IN（默认 15m）
refresh token  : {sub, username, type:"refresh", jti:<uuid>, ver:<sessionVersion>} 独立密钥 JWT_REFRESH_SECRET，
                 有效期固定 30d；同一 jti 落库 refresh_tokens 表（revoked=false）
轮换（refreshToken）: 用 JWT_REFRESH_SECRET 验签 → 要求 type=refresh 且必须有 jti
                 → UPDATE refresh_tokens SET revoked=true（受影响 0 行 = 已吊销，401）
                 → 校验用户仍 active → 签发新 token 对（DR-07：先消费后签发，fail-closed）
```

- access token 的 `sid` claim 就是本次登录的 refresh token jti，会话接口据此标记当前会话（SEC-03）。
- `JwtStrategy.validate()` 强制 `type` ∈ {`access`, `sse_ticket`}，refresh token 无法冒充；SSE 路由（`/logs/stream`、`/metrics/stream`、`/executions/stream`）允许 `?ticket=` 短效票据兜底（EventSource 无法带 Header；票据由 `POST /auth/sse-ticket` 签发，30s TTL。A5 起旧的 `?access_token=` 通道已撤销）。
- 每日 03:00 `@Cron` 清理过期 refresh token 行（`cleanupExpiredTokens`）。

### 会话撤销·用户级会话版本（WIKI-AUTH-REVOC）

access JWT 在有效期内本无法撤销（logout 只吊销 refresh token，在途 access token 活到自然过期）。引入 `users.sessionVersion`（迁移 `1790000000017`）后实现即时失效：

- **签发**：`generateTokens`（登录 / TOTP 二阶段 / refresh 轮换的唯一单点）把 `user.sessionVersion` 快照进 `ver` claim，access/refresh 同点携带。
- **校验**：`jwt.strategy.validate()` 每请求本就 `findById` 加载用户（检查 isActive），顺手比对 `payload.ver` 与库中 `sessionVersion`——不一致即 401 `"Session has been revoked"`，近零增量查询成本。
- **bump 点（原子自增，无读改写）**：① logout → `AuthService.revokeAllForUser`（先 `UsersService.bumpSessionVersion` 再吊销 refresh，先断 access 面）；② 改密 → `UsersService.update` 携带 password 时（save 成功后 bump，含自改与管理员重置；失败不误伤在途会话）。注意 `revokeOtherSessions` 保留当前会话的路径**不** bump（会误杀当前 access token），只有全量吊销语义才 bump。
- **向后兼容**：部署前签发的存量令牌无 `ver` claim（undefined）→ 跳过比对，维持「到期自然失效」，零破坏升级。重新登录后新令牌带新 ver 正常使用。
- **不在范围**：管理员停用（`isActive=false` 已有 isActive 校验兜底）、TOTP 变更、单会话级联撤销（刷新令牌族）。

### 登录防爆破（与 users 模块联动）

1. 锁定检查：`lockedUntil > now` 直接 401（不付 bcrypt 成本）。
2. 未知用户也比对预计算的 `DUMMY_BCRYPT_HASH`（F-4，防用户名枚举的时序侧信道）。
3. 失败计数：`UsersService.recordLoginFailure`（原子 UPDATE + RETURNING），5 次失败锁 15 分钟；成功登录 `resetLoginFailure`；锁过期后 `clearExpiredLock` 单条条件 UPDATE 清零（R10，防止"过期后一次失败即永久再锁"）。

### TOTP（totp.util + user 实体字段）

`setup` 只暂存 secret（`totpEnabled=false`）→ `enable` 验证一次有效码激活 → 登录返回 `{totpRequired:true}` 后调 `/totp/verify`（重新验证密码 + 验码，不能绕过锁定）→ `disable` 需要密码或有效 TOTP 码，仅凭 access token 不能关 2FA。

## 与其他模块的关系

- **依赖 [users.md](users.md)**：`UsersModule`（查用户、锁定计数、`saveUser` 持久化 TOTP 字段、`bumpSessionVersion` 会话版本原子自增）。
- **依赖 [audit.md](audit.md)**：login/logout/会话吊销写审计（fail-open）。
- **被全局 guard 依赖**：`JwtStrategy` 是全局 `JwtAuthGuard`（common/guards）的 passport 底层；本模块 `exports: [AuthService, JwtModule]`。
- **被 [admin-web](../../..) 前端消费**：登录页/令牌刷新/会话管理页面的后端。

## 常见改动场景

- **加一个新的登录后动作（如最后登录时间）**：改 `auth.service.login()` 成功路径；不要在 controller 里加——审计与锁定逻辑都在 service。
- **调整 token 有效期**：access 走 `JWT_EXPIRES_IN`（env，Joi 默认 15m）；refresh 的 30d 硬编码在 `generateTokens`（两处：JWT `expiresIn` 与 `expiresAt` 落库），改时两处同步。
- **加新的 auth 路由**：敏感写面挂 `@Throttle({ default: AUTH_THROTTLE })`（`src/config/throttle-profiles.ts`），新 scope/档位先看该文件分域矩阵；同时更新 [../../05-interfaces/README.md](../../../05-interfaces/README.md)（规划中）。
- **给 user 实体加字段**：注意 [users.md](users.md) 的 User 实体 + 迁移（`npm run migration:generate`），`@Exclude()` 字段不会出现在任何响应。

## 相关文档

- 用户管理：[users.md](users.md)；API Key（另一条凭证线）：[api-keys.md](api-keys.md)
- 审计：[audit.md](audit.md)；全局 guard 机制见 [../README.md](../README.md)
- 安全模型全图：[../../04-flows/security-model.md](../../../04-flows/security-model.md)
- 接口地图：[../../05-interfaces/README.md](../../../05-interfaces/README.md)（规划中）
