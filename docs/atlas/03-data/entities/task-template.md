# TaskTemplate 实体（task_templates 表）— 任务模板

> 所属: docs/atlas/03-data · 最后核对: 2026-09-13 · 对应代码: apps/admin-api/src/modules/task-template/entities/task-template.entity.ts

## 所属模块与源文件

- 模块：[task-template 模块](../../01-apps/admin-api/modules/task-template.md)（`apps/admin-api/src/modules/task-template/`）
- 源文件：`apps/admin-api/src/modules/task-template/entities/task-template.entity.ts`
- 配套工具：`task-template.util.ts`（config 合法性校验）

## 表名

`task_templates`（`@Entity("task_templates")`）

## 字段表

主键 `id: uuid`。全字段：

| 列名 | 类型 | 说明 |
|---|---|---|
| `key` | varchar(64) NOT NULL，**UNIQUE** | 稳定标识：官方模板用 `scheduled_backup` 等（与 packages/mcp-server `TASK_TEMPLATES` 五个 key 语义对齐）；自定义模板全局唯一 |
| `name` | varchar(128) NOT NULL | 模板显示名 |
| `description` | text nullable | 描述 |
| `category` | varchar(32) nullable | 粗分类标签（前端渲染 Tag）：备份/巡检/同步/清理/通知… |
| `config` | jsonb NOT NULL | **合法 CreateTaskDto 子集**（落库前经 CreateTaskDto 语义校验）；实例化为任务时作默认值，显式传入字段覆盖；不含 `name` |
| `isOfficial` | boolean，default `false` | 官方预置模板标记（迁移内幂等 seed）；官方模板不可删除（service 层拒 403） |
| `createdAt` / `updatedAt` | timestamptz | 自动维护 |

## 索引与约束

| 索引/约束 | 定义处 | 说明 |
|---|---|---|
| `uq_task_templates_key` | 迁移 `1789800000000-CreateTaskTemplates.ts`（`CREATE UNIQUE INDEX IF NOT EXISTS`） | `key` 全局唯一 |
| `idx_task_templates_isOfficial` | 实体 `@Index("idx_task_templates_isOfficial", ["isOfficial"])` | 官方/自定义分流查询 |
| 表与 seed | 迁移 `1789800000000-CreateTaskTemplates.ts` | 建表 + 官方模板幂等 seed |

## 关系

- **被引用 / 引用**：均无——模板是独立配置表，与 [tasks](task.md) 之间没有 FK；"一键克隆"在 `TaskTemplateService` 实例化时把 `config` 作为默认值创建新 Task 行，之后两者无关联。

## 生命周期与写入方

- **创建/更新/删除**：`TaskTemplateService`（自定义模板 CRUD；官方模板拒删）。
- **seed**：迁移 `1789800000000` 内幂等插入官方模板（`isOfficial=true`）。
- **读取**：模板列表/详情接口；MCP server 的模板枚举与 `TASK_TEMPLATES` key 对齐（[mcp-server](../../02-packages/mcp-server.md)）。

## 常见改动场景

1. **config 支持新任务字段**：先扩 [tasks](task.md)（实体+迁移+CreateTaskDto），模板侧自动兼容（config 是 CreateTaskDto 子集，校验逻辑复用）。
2. **新增官方模板**：改迁移 `1789800000000` 的 seed（保持幂等）或新增 seed 迁移；同步 mcp-server 的 `TASK_TEMPLATES`。
3. **加字段**（如 `icon`）：实体 `@Column` + 迁移（幂等 `ADD COLUMN IF NOT EXISTS`，见 [migrations.md](../migrations.md)）+ 模块 DTO。
