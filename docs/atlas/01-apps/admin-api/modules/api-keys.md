# api-keys 模块 — 限权 API Key（机器凭证）

> 所属: docs/atlas/01-apps/admin-api/modules · 最后核对: 2026-09-13 · 对应代码: apps/admin-api/src/modules/api-keys

## 职责

AUTH-03：为 CI/CD 与脚本提供**非交互凭证**。管理面（创建/吊销/列表）仅限用户 JWT；鉴权面是全局 `JwtAuthGuard` 的一个分支——`Authorization: Bearer acf_...` 请求不进 passport-jwt，而进入本模块的 `ApiKeyAuth` 做 sha256 查表 + scope 判定。执行器/MCP/CI 侧的"用户级机器鉴权"都走这里（执行器自身的 token 是另一条线，见 [executor.md](executor.md)，规划中）。

## 目录结构与关键文件

```
modules/api-keys/
├── api-keys.module.ts       关键：{ provide: API_KEY_AUTH_FACADE, useExisting: ApiKeyAuth }
│                            把鉴权分支注入全局 guard（guard 在 common/guards）
├── api-keys.controller.ts   @Controller("api-keys") 管理面（JWT-only）
├── api-keys.service.ts      create/list/revoke + authenticate（sha256 查表）
├── api-key-auth.helper.ts   ApiKeyAuth —— 实现 ApiKeyAuthFacade，guard 分支入口
├── api-key.util.ts          generateApiKey / hashApiKey / looksLikeApiKey / "acf_" 前缀
├── api-key-scope.util.ts    scopeAllows —— method × path × scope 纯判定矩阵
└── entities/api-key.entity.ts  ApiKey 实体（api_keys 表）+ ApiKeyScope
```

## 凭证格式与存储

- 明文 = `acf_` + 64 位 hex（32 随机字节），**仅在 create 响应中出现一次**。
- 库里只存 `keyHash`（sha256 hex，唯一索引）与 `keyPrefix`（前 8 字符，展示/审计用）。
- 吊销是软删（`revokedAt`），审计痕迹保留；`expiresAt` 可选（`expiresInDays` 1–3650）。
- `lastUsedAt` 节流刷新（≤1 写/分钟/键），首次使用写 `apikey.used` 审计。

## scope 模型

| 层级 | 能力 |
|---|---|
| `readonly` | 全部 GET/HEAD/OPTIONS |
| `trigger` | readonly + POST `tasks/batch/trigger` 与 `tasks/<id>/trigger`（CI 派发） |
| `manage` | 其余全部非排除写面 |
| 扩展域 `scopes`（NF-01） | 空格分隔词表，当前仅支持 `task:trigger`——只放行单任务触发 POST，不放宽读与其他写 |

**JWT-only 排除面**（`JWT_ONLY_API_KEY_PATHS`，任何 scope 都不可达）：`api-keys`、`auth`、`users`、`config`——泄露的 key 不能铸造/替换凭证，也不能改写系统配置。

> `config` 于本轮审计补入（SEC-KEY-CFG）：`manage` 的 scope 矩阵是 method×path 的、直接放行所有写，且 RolesGuard 无法补偿（`ApiKeyUser` 没有 `role` 字段，`requiredRoles.includes(undefined)` 恒为 false）。因此在补入之前，一把泄露的 `manage` key 可以 `PUT /api/config` 改写 `ai.openaiBaseUrl`（把出站 AI 调用重定向到攻击者主机）、生成执行器共享凭据、回滚配置。配置存储与凭据管理层同级敏感，故并入。

## 关键机制：guard 分支鉴权链

```
请求 Authorization: Bearer acf_xxx
  └→ 全局 JwtAuthGuard（common/guards/jwt-auth.guard.ts）
       前缀 acf_ → ApiKeyAuth.authenticate()（api-key-auth.helper.ts）
            1. JWT-only 面检查（api-keys/auth/users/config）→ 401（不进查表）
            2. sha256 查表（unknown → 失败）
            3. revokedAt 非空 → 失败（吊销立即生效）
            4. expiresAt 已过 → 失败
            5. scopeAllows(scope, {method, path}) → 不允许则 403（中文 reason，可区分）
            6. 通过 → req.user = { type:"apiKey", userId, keyPrefix, apiKeyId, scope }
       其余凭证 → 原 passport-jwt 流程（见 [auth.md](auth.md)）
```

对线协议：2/3/4 的失败统一 401 同文案（不区分"key 不存在/已吊销/已过期"，精确原因只进审计 `apikey.auth_failure`）；403 是唯一可区分信号（凭证本身有效、只是权限不足）。`req.user` 的 `type:"apiKey"` 用 `isApiKeyUser()` 类型守卫区分于 JWT 会话。

## 路由（controller 前缀 `api-keys`，全部 JWT）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api-keys` | 我的 key 列表（掩码，hash 永不出服务） |
| POST | `/api-keys` | 创建；body：`name`、`scope`（readonly/trigger/manage）、可选 `scopes`（须含 `task:trigger`）、可选 `expiresInDays`；响应含一次性 `plaintext` |
| DELETE | `/api-keys/:id` | 软吊销（仅 owner） |
| POST | `/api-keys/:id/revoke` | 显式吊销别名（幂等） |

## 与其他模块的关系

- **依赖 [audit.md](audit.md)**：create/revoke/首次使用/鉴权失败全落审计（fail-open）。
- **被全局 guard 消费**：`ApiKeysModule` 把 `ApiKeyAuth` 以 `API_KEY_AUTH_FACADE` token 导出，`JwtAuthGuard` `@Optional()` 注入；guard 本体在 common/guards，注册见 [../README.md](../README.md)。
- **与 [auth.md](auth.md) 互补**：同一 Bearer 头、两条凭证线；auth 路由对本 key 直接 401。
- **消费方**：acf CLI、MCP Server、CI 脚本（trigger scope）——见 [../../../02-packages/acf-cli.md](../../../02-packages/acf-cli.md)（规划中）、[../../../02-packages/mcp-server.md](../../../02-packages/mcp-server.md)（规划中）。

## 常见改动场景

- **新增扩展 scope（如 `app:deploy`）**：改 `API_KEY_EXTRA_SCOPES` + `scopeAllows()` 判定 + controller DTO 的 `@Contains` 校验 + 迁移 `1790000000005` 后续；保持"只放行特定 method×path"原则。
- **新增 JWT-only 排除面**：改 common/guards/jwt-auth.guard.ts 的 `JWT_ONLY_API_KEY_PATHS`（不要在模块内绕过）。
- **换哈希/前缀**：`api-key.util.ts` 是唯一实现点；换哈希需要兼容期双查，老 key 无重发明文，只能走吊销+重发。
- **排查"key 失效"**：按顺序查 `revokedAt` → `expiresAt` → scope（403 文案会点名所需 scope），精确原因在审计日志 `apikey.auth_failure`（见 [audit.md](audit.md)）。

## 相关文档

- 认证（JWT 线）：[auth.md](auth.md)；审计：[audit.md](audit.md)
- 任务触发面：[task.md](task.md)（下一批次）
- 安全模型：[../../04-flows/security-model.md](../../../04-flows/security-model.md)
