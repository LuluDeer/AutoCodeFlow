# Project 实体（projects 表）— 多租户项目（AUTH-01）

> 所属: docs/atlas/03-data/entities · 最后核对: 2026-09-13 · 对应代码: apps/admin-api/src/modules/project/project.entity.ts

## 所属模块与源文件

- 模块：[project 模块](../../01-apps/admin-api/modules/project.md)（`apps/admin-api/src/modules/project/`）
- 源文件：`apps/admin-api/src/modules/project/project.entity.ts`（**实体在模块根**，不在 `entities/` 子目录——data-source 的实体 glob 特意覆盖 `src/modules/**/*.entity{.ts,.js}` 才扫到它）
- 同文件导出：`DEFAULT_PROJECT_ID = "00000000-0000-0000-0000-000000000001"`、`DEFAULT_PROJECT_NAME = "Default"`

## 表名

`projects`（`@Entity("projects")`，迁移 `1790000000007-CreateProjects` 建表）

## 字段表

主键 `id: uuid`（`@PrimaryGeneratedColumn("uuid")`）。

| 列名 | 类型 | 说明 |
|---|---|---|
| `name` | varchar NOT NULL，**unique** | 项目名（`UQ_projects_name` 唯一索引）——重名会破坏前端选择面 |
| `description` | varchar nullable | 描述 |
| `createdAt` / `updatedAt` | timestamptz | `@CreateDateColumn` / `@UpdateDateColumn` |

## 索引与约束

| 索引/约束 | 定义 | 说明 |
|---|---|---|
| `UQ_projects_name` | `(name)` UNIQUE（实体 + 迁移 `1790000000007` 一致） | 名称唯一 |

**单默认项目起步**（用户已拍板，源码注释）：迁移 `1790000000007` 幂等种子一行 `name='Default'`、id=`DEFAULT_PROJECT_ID`（`ON CONFLICT DO NOTHING`）。`ProjectStatus`（active/archived）第一批未做，留给 Wave2（AUTH-02）。

## 关系

- **被引用（DB 级 FK，全部 ON DELETE SET NULL）**：
  - `tasks.projectId`（迁移 `1790000000008`，存量任务已回填到默认项目）；
  - `applications.projectId` / `executors.projectId` / `executor_packages.projectId`（迁移 `1790000000009`，存量行**不回填**——可空 = 未分配，语义上归默认项目视图，见各 `findAll` 过滤面）。
- **被引用（DB 级 FK，ON DELETE CASCADE）**：[project-member](project-member.md).`projectId`（迁移 `1790000000015`，项目删除连坐成员行）。
- **自身不引用**任何表。

## 生命周期与写入方

- **创建/改/删**：`ProjectsService`（CRUD + 列表过滤面；[project 模块](../../01-apps/admin-api/modules/project.md)）。
- **种子**：迁移 `1790000000007`（非运行时写入）。
- **删除语义**：项目删除 → tasks/applications/executors/executor_packages 的 `projectId` 置 NULL（归默认项目视图），成员行级联删除。
- **只读消费方**：各资源模块的 `findAll` 过滤（未分配按「IS NULL OR = 默认项目」归入默认项目视图）、`ProjectAccessService` 成员判定。

## 常见改动场景

1. **加状态机（ProjectStatus）**：实体 + 迁移加列/枚举——注意源码注释明确计划与 AUTH-02 项目级角色一起演进，先读 [project 模块](../../01-apps/admin-api/modules/project.md)文档。
2. **把「未分配=默认项目」改为显式回填**：需要一次性数据迁移（UPDATE 各表 NULL 行），影响四张表的过滤面语义。
3. **加字段**：实体 + 幂等迁移；项目是四张资源表的 FK 挂点，加列无级联影响。
4. 相关流程：[安全模型](../../04-flows/security-model.md)。
