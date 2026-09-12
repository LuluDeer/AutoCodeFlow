# RefreshToken 实体（refresh_tokens 表）— JWT 刷新令牌（SEC-02）

> 所属: docs/atlas/03-data/entities · 最后核对: 2026-09-13 · 对应代码: apps/admin-api/src/modules/auth/entities/refresh-token.entity.ts

## 所属模块与源文件

- 模块：[auth 模块](../../01-apps/admin-api/modules/auth.md)（`apps/admin-api/src/modules/auth/`）
- 源文件：`apps/admin-api/src/modules/auth/entities/refresh-token.entity.ts`
- 定位：SEC-02——每个签发的 refresh token 落一行，用于**吊销支持**（logout / 轮换置 `revoked`）

## 表名

`refresh_tokens`（`@Entity("refresh_tokens")`，迁移 `1717473142680-RefreshTokenTable` 建表）

## 字段表

主键 `id: number`（SERIAL 自增）。

| 列名 | 类型 | 说明 |
|---|---|---|
| `jti` | varchar NOT NULL，**unique** | JWT ID claim，与签发 JWT 的 `jti` 字段一一对应（签发侧 `randomUUID()`）；唯一索引 + 普通索引 `idx_refresh_tokens_jti` 双保险 |
| `userId` | int NOT NULL | 所属用户（→ [user](user.md)，**无 DB FK**） |
| `revoked` | boolean，default `false` | 吊销标记：logout / 刷新轮换 / 全端登出置 `true` |
| `expiresAt` | timestamp NOT NULL | JWT `exp` claim 的镜像——签发时 `now + 30 天`；供周期清理判断 |
| `userAgent` | varchar(256) nullable | SEC-03 会话管理展示元数据：签发时客户端 UA（截断到 256） |
| `ip` | varchar(64) nullable | SEC-03：签发时客户端 IP |
| `createdAt` | timestamp | `@CreateDateColumn` |

## 索引与约束

| 索引/约束 | 定义 | 说明 |
|---|---|---|
| `jti` | 列级 `unique` + 实体 `@Index({ unique: true })` + 迁移 `idx_refresh_tokens_jti` | 按 jti 精确查吊销状态（每 token 一行） |
| `idx_refresh_tokens_userId` | `(userId)`（迁移 `1717473142680`） | 会话列表 / 全端登出按用户扫 |
| FK | **无** | 用户删除后令牌行悬垂；`expiresAt` 过期清理自然回收 |

## 关系

- **引用**：[user](user.md).`id`（应用层 int 弱引用，无 FK）。
- **被引用**：无表引用它；access token 通过 `sid = jti` claim 与之关联（签发 access 时带 `sid`，会话列表用当前 `sid` 标记 `current` 会话）。

## 生命周期与写入方

写入方全部在 `AuthService`（[auth 模块](../../01-apps/admin-api/modules/auth.md)）：

- **创建（签发）**：`login` / `refresh` 成功路径——`refreshTokenRepo.save`，`jti = randomUUID()`，`expiresAt = now + 30 天`，同时捕获 `userAgent` / `ip`。
- **轮换（rotation）**：`refresh` 端点先 `update({ jti, revoked: false }, { revoked: true })` 吊销旧令牌（原子条件更新），再签发新令牌对（access + refresh 各带新 jti；access 的 `sid` 指向新 jti）。
- **吊销**：`logout`（单令牌）、`revokeAll`（全端登出：`userId + revoked=false` 全部置 revoked）、会话管理 `revokeOtherSessions`（排除当前 `sid`）。
- **清理**：`refreshTokenRepo.delete({ expiresAt: LessThan(now) })` 周期删除过期行。
- **只读消费方**：`GET /auth/sessions` 会话列表（含 `current` 标记）、admin-web 会话管理面板。

## 常见改动场景

1. **改 refresh 有效期**：签发处 `expiresAt.setDate(+N)` 常量 + JWT 签名选项两处需同步（`expiresAt` 只是镜像，真正校验在 JWT 层）。
2. **加会话元数据**：实体 + 迁移（幂等模板参考 `1789800000001`）+ 签发时 meta 透传 + 会话列表 DTO。
3. **加"单用户最多 N 会话"策略**：在 `AuthService.issueTokens` 签发后按 `userId` 清理最旧行；注意与 `revokeOtherSessions` 的条件 UPDATE 语义区分。
4. 相关流程：[安全模型](../../04-flows/security-model.md)。
