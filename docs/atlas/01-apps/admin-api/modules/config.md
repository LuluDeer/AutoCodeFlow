# config 模块 — 系统配置与配置历史

> 所属: docs/atlas/01-apps/admin-api/modules · 最后核对: 2026-09-13 · 对应代码: apps/admin-api/src/modules/config

## 职责

运行期**数据库态**键值配置（区别于 `.env` 静态配置）：键值 CRUD、批量写入、值类型校验、密文掩码、变更历史（config_history）与回滚。典型键如 `executor.sharedToken`（执行器共享 token）。模块导出名是 `SystemConfigModule`。

## 目录结构与关键文件

```
modules/config/
├── config.module.ts          装配；export SystemConfigService
├── config.controller.ts      @Controller("config")（类级 @ApiTags("System Config")）
├── config.service.ts         SystemConfigService：findAll/findOne/upsert/remove/
│                             batchUpsert/getHistory/rollback/validateConfig/getByPrefix/getByTag
├── entities/system-config.entity.ts  system_configs 表（key 唯一，value 为 text）
├── entities/config-history.entity.ts config_history 表（action: create/update/delete/rollback）
└── dto/                      upsert-config.dto.ts、config-history-query.dto.ts
```

## 路由（controller 前缀 `config`）

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| GET | `/config` | JWT | 全部条目；支持 `?prefix=`、`?tag=` 过滤；`isSecret` 条目 value 掩码为 `***` |
| GET | `/config/history` | JWT | 变更历史（分页；新旧值掩码：行级 `isSecret` 与 secret 键推断取并集，WIKI-OPT-2） |
| GET | `/config/history/:key` | JWT | 单键历史（同上行级掩码） |
| POST | `/config/history/:id/rollback` | `@Roles(ADMIN)` | 回滚到历史版本（`ParseIntPipe` 校验 id） |
| POST | `/config/executor-shared-token/generate` | `@Roles(ADMIN)` | 生成/轮换 64 hex 执行器共享 token（落库 `executor.sharedToken`，isSecret） |
| GET | `/config/executor-shared-token` | `@Roles(ADMIN)` | 明文返回当前共享 token（唯一明文出口） |
| GET | `/config/:key` | JWT | 单条（secret 掩码） |
| PUT | `/config` | `@Roles(ADMIN)` | upsert 单条 |
| POST | `/config/batch` | `@Roles(ADMIN)` | 批量 upsert |
| DELETE | `/config/:key` | `@Roles(ADMIN)` | 删除（先记历史再删） |

注意 controller 内**静态路由（history 系）必须声明在动态 `:key` 之前**，否则 `history` 会被当成 key（文件内 NOTE 注释）。

## 关键机制

### upsert 与历史（config.service）

```
upsert(dto, {userId, username, ipAddress})
  → isSecret 且 value === "***" 且已存在 → 保留库中原值
    （S3：admin-web 回显掩码后保存不能把真值覆盖成 "***"）
  → validateConfig：按 valueType（string/number/boolean/json）校验值合法
  → repo.upsert（conflictPaths: ["key"]，值未变则跳过更新）
  → recordHistory：写 config_history（action=create|update，新旧值 +
    valueType/isSecret 元数据快照 + 操作人 + IP，WIKI-OPT-2）
remove → 先记 action=delete 历史（含被删行 valueType/isSecret）→ repo.remove
rollback(historyId) → 按 action 分派：update/create 恢复旧值；delete 恢复被删条目
  （行已删除时 valueType/isSecret 优先取历史行持久化的元数据，存量 NULL 行
  回退默认 "string"/false，WIKI-OPT-2）；回滚本身再写一条 action=rollback 的
  历史（FEAT-08）
batchUpsert(items) → **单数据库事务**承载整批（每条的配置写入 + 历史写入，
  事务内一律走事务级 manager 仓储），任一项失败整体回滚不留部分写入
  （WIKI-OPT-2；单条 upsert 保持原语义不强制事务）
```

### 掩码规则

读面（findAll/findOne）对 `isSecret` 条目统一 `***`；写面靠上面的 sentinel 语义保留真值。历史读面（history 两路由）自 WIKI-OPT-2 起**按行级保密掩码**：历史行持久化的 `isSecret=true`（迁移 `1790000000016`）逐行掩码，与 `getSecretKeys()` 的键级推断取并集——防配置被删除或取消 secret 标记后历史暴露旧机密值；存量旧行（isSecret 为 NULL=元数据不可知）沿用键级推断，行为不回归。

## 与其他模块的关系

- **被广泛依赖（被依赖方）**：`SystemConfigService` 消费方（代码 grep 核实）：
  - `main.ts` + `common/middleware/upload-auth.middleware.ts`：`/uploads` 静态面鉴权（执行器共享 token 校验）
  - `common/utils/verify-executor-token.util.ts`：执行器 token 校验回退
  - [executor.md](executor.md)（下一批次）：executor.controller/service
  - [ai.md](ai.md)（规划中）、artifacts（产物）、executor-package、task/execution-callback.controller
- **依赖 [audit.md](audit.md) 不成立**：配置变更走自己的 `config_history`，不写审计表（两套记录线语义不同，见 [audit.md](audit.md)）。
- **与 `.env`/configuration.ts 的分工**：进程引导必需项（DB/JWT/Redis 等）在 `src/config/configuration.ts` + Joi，改它们要重启；本模块是业务运行期可热改的键值。env 变量清单见 [../../06-infra/README.md](../../../06-infra/README.md)（规划中）。

## 常见改动场景

- **新增一个业务配置键**：直接 `PUT /config`（无需改代码）；若代码要消费，注入 `SystemConfigService.findOne("your.key")`；敏感值记得 `isSecret: true`。
- **加值类型**：改 `validateConfig` 的类型分支 + `UpsertConfigDto.valueType` 校验。
- **排查"secret 被改成 \*\*\*"**：新版已防（sentinel 语义），老数据被污染时用 `rollback` 或重新生成（如 `executor.sharedToken` 有专用 generate 端点）。
- **新增静态路由**：必须放在 `@Get(":key")` 之前（NestJS 路由匹配顺序）。

## 相关文档

- 执行器共享 token 的消费方：[executor.md](executor.md)（下一批次）、[api-keys.md](api-keys.md)
- 审计（另一条记录线）：[audit.md](audit.md)
- env 配置面：[../../06-infra/README.md](../../../06-infra/README.md)（规划中）
