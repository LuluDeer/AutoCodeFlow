# ProjectMember 实体（project_members 表）— 项目成员与角色（AUTH-02 / ADR-013）

> 所属: docs/atlas/03-data/entities · 最后核对: 2026-09-13 · 对应代码: apps/admin-api/src/modules/project/entities/project-member.entity.ts

## 所属模块与源文件

- 模块：[project 模块](../../01-apps/admin-api/modules/project.md)（`apps/admin-api/src/modules/project/`）
- 源文件：`apps/admin-api/src/modules/project/entities/project-member.entity.ts`
- 同文件导出：`PROJECT_ROLES = ["viewer", "editor", "admin"]`、`ProjectRole` 类型、`PROJECT_ROLE_RANK`（viewer=1 < editor=2 < admin=3，用于「至少某档」比较）、`isProjectRole()` 守卫

## 表名

`project_members`（`@Entity("project_members")`，迁移 `1790000000015-CreateProjectMembers` 建表）

## 字段表

主键 `id: uuid`（`@PrimaryGeneratedColumn("uuid")`）。

| 列名 | 类型 | 说明 |
|---|---|---|
| `projectId` | uuid NOT NULL | 所属项目（→ [project](project.md)，DB FK `fk_project_members_project` **ON DELETE CASCADE**） |
| `userId` | int NOT NULL | 成员用户（→ [user](user.md)，**无 DB FK**，仅索引） |
| `role` | varchar(16) NOT NULL | 项目级角色：`viewer`（只读，一切写面 403）/ `editor`（项目内任务/应用读写 + 执行类写面 trigger/pause/resume/kill）/ `admin`（项目内全权 + 成员管理，任免 ≤ 自己） |
| `createdAt` | timestamptz | `@CreateDateColumn` |

角色模型要点（源码注释）：**只在非 ADMIN 主体上生效**——全局 ADMIN 恒全量放行；项目角色是普通用户的「能力增量」不是收紧面。**零破坏约定：迁移不回填任何成员行**——无成员行时写面判定与 AUTH-02 之前逐字节一致。

## 索引与约束

| 索引/约束 | 定义 | 说明 |
|---|---|---|
| `UQ_project_members_project_user` | `(projectId, userId)` UNIQUE（实体 + 迁移 `uq_project_members_project_user` 一致） | 一人一项目一角色 |
| `IDX_project_members_userId` | `(userId)`（实体 + 迁移一致） | 按用户反查其项目 |
| `fk_project_members_project` | `projectId` → `projects.id` **ON DELETE CASCADE**（迁移 `1790000000015`） | 项目删除连坐成员行 |

## 关系

- **引用**：[project](project.md)（DB FK CASCADE）；[user](user.md)（int 弱引用，无 FK）。
- **被引用**：无表引用它；判定入口在 `ProjectAccessService`（`assertCanWrite` 等守卫方法），任务/应用等写面按 projectId 查成员角色。

## 生命周期与写入方

- **创建**：`ProjectAccessService.addMember`（[projects.controller](../../01-apps/admin-api/modules/project.md) `POST :id/members`，ADMIN 或项目 admin，且任免角色 ≤ 自己档位）。
- **更新**：`ProjectAccessService.updateMember`（`PATCH :id/members/:userId`，改角色）。
- **删除**：`ProjectAccessService.removeMember`（`DELETE :id/members/:userId`）。
- **只读消费方**：`listMembers`（`GET :id/members`，返回 `ProjectMemberView`）、各资源模块写面守卫（按 `(projectId, userId)` 查角色）。

## 常见改动场景

1. **加项目角色档位**：`PROJECT_ROLES` / `PROJECT_ROLE_RANK` 加值（varchar 列无需迁移）+ `ProjectAccessService` 能力矩阵 + 前端映射；注意「任免 ≤ 自己」的比较逻辑。
2. **加资源类型的成员判定**：在对应模块写面守卫接入 `ProjectAccessService`，遵循「未分配 projectId 资源按 `DEFAULT_PROJECT_ID` 判定」约定。
3. **加字段**：实体 + 幂等迁移（本表小，简单 `ADD COLUMN IF NOT EXISTS` 即可）。
4. 相关流程：[安全模型](../../04-flows/security-model.md)。
