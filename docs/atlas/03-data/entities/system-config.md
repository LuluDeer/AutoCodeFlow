# SystemConfig 实体（system_configs 表）— 系统配置键值

> 所属: docs/atlas/03-data/entities · 最后核对: 2026-09-13 · 对应代码: apps/admin-api/src/modules/config/entities/system-config.entity.ts

## 所属模块与源文件

- 模块：[config 模块](../../01-apps/admin-api/modules/config.md)（`apps/admin-api/src/modules/config/`）
- 源文件：`apps/admin-api/src/modules/config/entities/system-config.entity.ts`
- 服务类：`SystemConfigService`（`config.service.ts`）

## 表名

`system_configs`（`@Entity("system_configs")`，InitialSchema 迁移 `1717473142678` 建表）

## 字段表

主键 `id: number`（SERIAL 自增）。

| 列名 | 类型 | 说明 |
|---|---|---|
| `key` | varchar NOT NULL，**unique** | 配置键（业务标识，upsert 目标） |
| `value` | text nullable | 配置值；**DB-007：必须保持显式 text（无长度上限）**——可能存 JSON（`valueType=json`）、AI 提示词等长文本，勿改回 varchar 以免静默截断 |
| `description` | varchar nullable | 键说明 |
| `valueType` | varchar NOT NULL，default `'string'` | 值类型标注：`'string' | 'number' | 'boolean' | 'json'`（读取侧按此反序列化） |
| `isSecret` | boolean，default `false` | 敏感标记——读面（列表/详情）按此脱敏；存储面为 RAW |
| `createdAt` / `updatedAt` | timestamp | `@CreateDateColumn` / `@UpdateDateColumn` |

## 索引与约束

| 索引/约束 | 定义 | 说明 |
|---|---|---|
| `key` | 列级 `unique` | 配置键唯一 |

实体无 `@Index`（key 唯一约束即查询路径）。

## 关系

- **引用/被引用**：均无 FK。逻辑关联：[config-history](config-history.md).`configKey` 记录本表每次变更（字符串关联，键删除后历史保留）。
- **消费方（模块级，读此表取配置）**：[ai 模块](../../01-apps/admin-api/modules/ai.md)（AI 提示词/密钥）、[executor 模块](../../01-apps/admin-api/modules/executor.md)、[executor-package 模块](../../01-apps/admin-api/modules/executor-package.md)、[artifacts 模块](../../01-apps/admin-api/modules/artifacts.md)、[task 模块](../../01-apps/admin-api/modules/task.md)、[notification 模块](../../01-apps/admin-api/modules/notification.md)（旧渠道配置键）。

## 生命周期与写入方

- **创建/更新**：`SystemConfigService`（config 控制器写面，ADMIN-only）；写路径与 [config-history](config-history.md) 记录在**同一 service** 内联动（先写 history 再落值，见 config-history 文档）。
- **删除**：config 控制器 delete 端点（同样落 history `action=delete`）。
- **读取**：各模块启动/请求时按 key 取值；`isSecret=true` 的键在读面脱敏。
- **只读消费方**：admin-web 系统配置页。

## 常见改动场景

1. **加配置键**：无需迁移（行级数据），直接插入；确定 `valueType` 与 `isSecret` 标记。
2. **改 value 列类型**：⚠️ DB-007 明确禁止改回 varchar（静默截断风险）；扩容保持 text。
3. **加值类型**：`valueType` 约定值加项（varchar 无 DDL）+ 读取侧反序列化分支。
4. 相关流程：[安全模型](../../04-flows/security-model.md)（规划，secret 脱敏面）。
