# ApiKey 实体（api_keys 表）— API 密钥（AUTH-03 / NF-01）

> 所属: docs/atlas/03-data/entities · 最后核对: 2026-09-13 · 对应代码: apps/admin-api/src/modules/api-keys/entities/api-key.entity.ts

## 所属模块与源文件

- 模块：[api-keys 模块](../../01-apps/admin-api/modules/api-keys.md)（`apps/admin-api/src/modules/api-keys/`）
- 源文件：`apps/admin-api/src/modules/api-keys/entities/api-key.entity.ts`
- 同文件导出：`ApiKeyScope` 类型（`readonly | trigger | manage`）、`API_KEY_EXTRA_SCOPES = ["task:trigger"]`、`parseApiKeyScopes()` 解析函数

## 表名

`api_keys`（`@Entity("api_keys")`，迁移 `1790000000000-CreateApiKeys` 建表）

## 字段表

主键 `id: number`（SERIAL 自增）。

| 列名 | 类型 | 说明 |
|---|---|---|
| `userId` | integer NOT NULL | 创建者（→ [user](user.md)，无 DB FK）；API Key 只能由属主经 JWT 管理 |
| `name` | varchar(100) NOT NULL | 人类可读标签，如 `ci-deploy` |
| `keyPrefix` | varchar(16) NOT NULL | 明文 key 前 8 字符（`acf_` + 4 hex），仅展示/识别用，无法反推完整 key |
| `keyHash` | varchar(64) NOT NULL | 明文 key 的 **sha256 hex**；查库键 + 唯一约束。明文只在创建响应出现一次，之后永不存储/返回 |
| `scope` | varchar(16) NOT NULL，default `'readonly'` | 三档权限：`readonly`（全部 GET）/ `trigger`（+任务触发）/ `manage`（非排除的全部写面） |
| `scopes` | varchar(128) nullable | NF-01（迁移 `1790000000005`）：空格分隔的窄域授权词表，目前仅 `task:trigger`（免 JWT 触发单个任务）；NULL/空 = 无 |
| `expiresAt` | timestamptz nullable | 可选过期时刻——过期 key 认证按 401 拒绝 |
| `revokedAt` | timestamptz nullable | **软吊销**时间戳——非空即立即拒绝（保留审计痕迹，不物理删） |
| `lastUsedAt` | timestamptz nullable | 最近成功认证时刻；**节流更新**（每 key ≤1 写/分钟） |
| `createdAt` | timestamptz | `@CreateDateColumn` |

安全不变量（源码注释明确）：`/api-keys` 管理端点**任何 scope 都不可达**（JWT-only），泄漏的 key 无法为自己再铸凭证。

## 索引与约束

| 索引/约束 | 定义 | 说明 |
|---|---|---|
| `idx_api_keys_key_hash` | `(keyHash)` **UNIQUE**（实体 + 迁移一致） | 认证时按 hash 精确查一行 |
| `idx_api_keys_user_id` | `(userId)` | 按用户列 key |
| FK | **无** | 用户删除后 key 行悬垂（`revokedAt` 语义上等价失效） |

## 关系

- **引用**：[user](user.md).`id`（应用层弱引用）。
- **被引用**：无表引用它；鉴权入口在 `api-key-auth.helper.ts`（守卫分支：先 legacy `scopeAllows` 矩阵，被拒且 `scopes` 含 `task:trigger` 且请求恰为单任务触发 POST → 放行；`task:trigger` 不扩大读/其他写面）。

## 生命周期与写入方

- **创建**：`ApiKeysService.create`（生成明文 `acf_<hex>`、落 `keyHash`/`keyPrefix`、明文仅本次响应返回）。
- **吊销**：`ApiKeysService.revoke`（写 `revokedAt`，软删）。
- **更新（运行面）**：`api-key-auth.helper` 认证成功后节流写 `lastUsedAt`。
- **只读消费方**：admin-web API Key 管理页（`keyPrefix` 识别）、审计排障。

## 常见改动场景

1. **加窄域 scope**：`API_KEY_EXTRA_SCOPES` 加值 + `api-key-auth.helper` 守卫分支加匹配规则 + spec（`api-key-task-trigger.spec.ts` 是现成范式）；varchar 列无需迁移。
2. **加 legacy 档位**：改 `ApiKeyScope` + `scopeAllows` 矩阵——影响面大，需全量排查写面守卫。
3. **加字段**：实体 + 迁移（幂等模板参考 `1790000000005-AddApiKeyTaskTriggerScope`）。
4. 相关流程：[安全模型](../../04-flows/security-model.md)、[任务生命周期](../../04-flows/task-lifecycle.md)（规划，CI 触发场景）。
