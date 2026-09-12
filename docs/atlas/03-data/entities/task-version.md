# TaskVersion 实体（task_versions 表）— 任务版本快照

> 所属: docs/atlas/03-data · 最后核对: 2026-09-13 · 对应代码: apps/admin-api/src/modules/task/entities/task-version.entity.ts

## 所属模块与源文件

- 模块：[task 模块](../../01-apps/admin-api/modules/task.md)（`apps/admin-api/src/modules/task/`）
- 源文件：`apps/admin-api/src/modules/task/entities/task-version.entity.ts`

## 表名

`task_versions`（`@Entity("task_versions")`）

## 字段表

主键 `id: uuid`。全字段（本实体较小，逐列列出）：

| 列名 | 类型 | 说明 |
|---|---|---|
| `taskId` | varchar NOT NULL | 所属任务 id；**字符串引用，无 FK**（仅索引） |
| `version` | varchar NOT NULL | 版本号字符串 |
| `gitCommit` | varchar nullable | 该版本对应的 Git commit |
| `snapshot` | jsonb NOT NULL | 任务配置完整快照（可回滚/回看的任务定义） |
| `createdBy` | varchar nullable | 创建人 |
| `description` | varchar nullable | 版本说明 |
| `createdAt` | timestamptz | `@CreateDateColumn` |

无 `updatedAt`、无软删列——版本行视为不可变历史（append-only）。

## 索引与约束

| 索引/约束 | 定义处 | 说明 |
|---|---|---|
| `idx_task_versions_taskId_version` | 实体 `@Index("idx_task_versions_taskId_version", ["taskId", "version"])`；迁移 `1717473142684-AddApplicationAndTaskFields.ts` 幂等补建（`CREATE INDEX IF NOT EXISTS`，表存在时才建） | **非唯一**索引，加速"按任务取版本列表/单版本查询" |
| 表创建 | 迁移 `1789000000001-AddMissingTablesAndColumns.ts` `CREATE TABLE IF NOT EXISTS "task_versions"` | 存量库补表 |

> ⚠️ `(taskId, version)` 组合当前没有 DB 唯一约束，防重复依赖应用层。

## 关系

- **引用**：`tasks.id`（无 FK，应用层维护）。`tasks.currentVersion` 指向本表某行的 `version` 字符串（同为弱引用）。
- **被引用**：无表引用它；`task_executions.taskVersion` 仅记录触发时的版本号字符串，不指向本表行。

## 生命周期与写入方

- **创建**：`TaskService`（任务定义变更/发布新版本时写入 snapshot；是全仓库唯一注入 `Repository(TaskVersion)` 的 service）。
- **更新/删除**：无业务更新路径（不可变快照）；无清理任务。
- **读取**：任务版本列表/回滚（[task 模块](../../01-apps/admin-api/modules/task.md)）；执行记录通过 `task_executions.taskVersion` 字符串展示对应版本。

## 常见改动场景

1. **snapshot 结构变更**：`snapshot` 是 `Record<string, any>`，DB 无 schema 约束；改动任务可回滚字段的集合时，注意存量快照按旧形态回读的兼容处理（读取侧防御性判空）。
2. **加字段**（如 `size`）：实体加 `@Column` + 新迁移（幂等 `ADD COLUMN IF NOT EXISTS`，见 [migrations.md](../migrations.md)），DTO 不直接暴露本表（版本写入由 service 内部完成）。
3. **收紧唯一性**：若需要 `(taskId, version)` 唯一，先在迁移里去重存量再建唯一索引，并同步 `migrations.spec.ts` 相关注记。
