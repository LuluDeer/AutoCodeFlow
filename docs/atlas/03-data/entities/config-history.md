# ConfigHistory 实体（config_history 表）— 配置变更历史（append-only）

> 所属: docs/atlas/03-data/entities · 最后核对: 2026-09-13 · 对应代码: apps/admin-api/src/modules/config/entities/config-history.entity.ts

## 所属模块与源文件

- 模块：[config 模块](../../01-apps/admin-api/modules/config.md)（`apps/admin-api/src/modules/config/`）
- 源文件：`apps/admin-api/src/modules/config/entities/config-history.entity.ts`
- 定位：`SystemConfigService` 每次配置变更（create/update/delete/rollback）落一行的审计/回滚数据源

## 表名

`config_history`（`@Entity("config_history")`，InitialSchema 迁移 `1717473142678` 建表；`action` 扩值由迁移 `1789000000001` 承载；`valueType`/`isSecret` 两列由迁移 `1790000000018` 承载）

## 字段表

主键 `id: number`（SERIAL 自增）。

| 列名 | 类型 | 说明 |
|---|---|---|
| `configKey` | varchar NOT NULL | 变更的配置键（字符串关联 [system-config](system-config.md).`key`，无 FK——键删除后历史保留） |
| `oldValue` | text nullable | 变更前值（create 时 NULL） |
| `newValue` | text nullable | 变更后值（delete 时 NULL） |
| `description` | varchar nullable | 变更说明 |
| `valueType` | varchar nullable | WIKI-OPT-2（迁移 `1790000000016`）：变更时配置行的值类型快照（string/number/boolean/json）。**NULL = 元数据不可知**（迁移前的存量行只记录 value/description）——回滚与读面对 NULL 行沿用旧推断（回退默认值 `"string"`），不要把 NULL 当有值处理 |
| `isSecret` | boolean nullable | WIKI-OPT-2（迁移 `1790000000016`）：变更时配置行的敏感标记快照。NULL = 元数据不可知（存量行沿用「按当前配置行 isSecret」的键级掩码推断）；非 NULL 时历史读面**按行级掩码**新旧值，防配置被删除或取消 secret 后历史暴露旧机密值 |
| `action` | varchar NOT NULL | 动作：`'create' | 'update' | 'delete' | 'rollback'`。FEAT-08：`rollback` 标记由回滚端点写入的行（值恢复与删除建条各一行）；**DB 列是普通 VARCHAR 无 CHECK 约束**（迁移 `1789000000001`），因此加值无需 DDL |
| `userId` | varchar nullable | 操作人用户 id（**字符串**存储，弱关联 [user](user.md)） |
| `username` | varchar nullable | 操作人用户名快照（用户改名后仍可读） |
| `ipAddress` | varchar nullable | 操作来源 IP |
| `createdAt` | timestamptz | `@CreateDateColumn` |

## 索引与约束

| 索引/约束 | 定义 | 说明 |
|---|---|---|
| `configKey` | 实体 `@Index(["configKey"])` | 按键列历史 |
| `(configKey, createdAt)` | 实体复合 `@Index` | 按键 + 时间排序（回滚取「最近一次有效值」的查询路径） |
| FK | **无** | append-only 设计，不挂任何引用 |

## 关系

- **引用**：[system-config](system-config.md)（`configKey` 字符串弱引用）、[user](user.md)（`userId` 字符串弱引用）。
- **被引用**：无表引用它；消费方是 config 控制器的历史查询端点与回滚端点（[config 模块](../../01-apps/admin-api/modules/config.md)）。

## 生命周期与写入方

- **写入**：仅 `SystemConfigService`——create/update/delete/rollback 四类动作各落一行；**append-only，无更新/删除路径**（区别于 [audit-log](audit-log.md) 的 DB 触发器防篡改，本表靠「无写面」约定）。
- **读取**：历史列表（按 configKey 分页过滤，`config-history-query.dto.ts`；读面自 WIKI-OPT-2 起按行级 `isSecret` 掩码新旧值，存量 NULL 行沿用键级推断）、回滚端点（读 oldValue/newValue 还原；WIKI-OPT-2 起对已删除的配置行还从历史行恢复 `valueType`/`isSecret`，NULL 行回退默认 `"string"`/`false`；回滚动作本身再落 `action=rollback` 行）。
- **清理**：无自动清理；长期增长需人工归档。

## 常见改动场景

1. **加动作类型**：`action` 加值即可（varchar 无 CHECK、无迁移），同步回滚端点分支与前端筛选。
2. **加操作上下文**（如 UA）：实体 + 幂等迁移 + 写入方透传。
3. **加大文本值的截断策略**：oldValue/newValue 是 text，注意超长 JSON 的读面性能（考虑分页/懒加载）。
4. 相关流程：[安全模型](../../04-flows/security-model.md)（规划，操作留痕）。
