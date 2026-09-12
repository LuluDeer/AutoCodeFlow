# project 模块 — 多租户项目与项目成员角色

> 所属: docs/atlas/01-apps/admin-api/modules · 最后核对: 2026-09-13 · 对应代码: apps/admin-api/src/modules/project

## 职责

AUTH-01/AUTH-02：项目（Project）作为任务/应用/执行器的**租户分组与授权边界**；项目成员（ProjectMember）与三档项目角色（viewer/editor/admin）为普通用户提供"项目内"能力增量。默认项目（DEFAULT_PROJECT_ID）承接一切未分配资源。

## 目录结构与关键文件

```
modules/project/
├── projects.module.ts         装配 + export ProjectsService、ProjectAccessService
├── projects.controller.ts     @Controller("projects")
├── projects.service.ts        项目 CRUD + Default 项目保护
├── project-access.service.ts  成员管理与角色判定（resolveRole/hasProjectRole）
├── project.entity.ts          Project 实体 + DEFAULT_PROJECT_ID/DEFAULT_PROJECT_NAME
├── project.dto.ts             Create/UpdateProjectDto、成员 Upsert/Update DTO
└── entities/project-member.entity.ts  ProjectMember 实体 + ProjectRole
```

- **默认项目**：`DEFAULT_PROJECT_ID = "00000000-0000-0000-0000-000000000001"`、name `Default`（迁移 `1790000000007` 种子；`1790000000008` 把存量 tasks 回填到该行）。update/remove 一律拒绝触碰 Default 行——它是"未分配 = 默认项目"语义的锚点。
- **ProjectMember**：`(projectId, userId)` 唯一；角色 `viewer(1) < editor(2) < admin(3)`（`PROJECT_ROLE_RANK`）。迁移不回填任何成员行——零破坏约定：无成员行时行为与 AUTH-02 之前一致（只放行、不收紧）。

## 路由（controller 前缀 `projects`）

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| GET | `/projects` | JWT | 全员可读（选项目上下文需要） |
| GET | `/projects/:id` | JWT | 详情 |
| POST / PATCH / DELETE | `/projects`、`/:id` | JWT + `@Roles(ADMIN)` | 项目是租户边界资源，写面收紧到管理员 |
| GET | `/projects/:id/members` | JWT | ADMIN 全量；非 ADMIN 须为成员（Default 项目恒可读） |
| POST / PATCH / DELETE | `/projects/:id/members[/:userId]` | JWT + `@Roles(ADMIN)` | 成员任免/改角色/移除（ADMIN-only，避免项目内自管提权链） |
| GET | `/projects/me/roles` | JWT | 当前用户在各项目的角色（admin-web 渲染可用项目） |

## 关键机制：角色判定（ADR-013）

```
resolveRole(userId, projectId?)   项目内角色；非成员 → null；查询失败 fail-open 记 warn（按非成员处理）
hasProjectRole(userId, pid, minRole)  PROJECT_ROLE_RANK[role] >= rank[minRole]
```

- **只在非 ADMIN 主体上生效**——全局 ADMIN 恒全量放行；项目角色是给普通用户的能力增量，不是收紧面。
- 未分配 `projectId` 的资源按默认项目判定。
- 角色语义：`viewer` 项目内只读；`editor` 任务/应用读写（含他人创建的）+ 执行类写面（trigger/pause/resume/kill）；`admin` 项目内全权 + 成员管理。
- 成员写入（`addMember`/`updateMember`）对非法角色抛 `BadRequestException`（提示 viewer/editor/admin 三选一）；`addMember` 对已有成员是 upsert（直接改角色）。

## 数据流：一条任务写请求如何过项目角色

```
PATCH /api/tasks/:id（下一批次，示意）
  → JwtAuthGuard（JWT 或 API Key）→ req.user
  → task.service 写面守卫：NF-03 属主判定（ownerUserId）
  → 属主不匹配时 → ProjectAccessService.resolveRole(userId, task.projectId)
       editor/admin → 放行（AUTH-02 的放行增量）
       非成员/null → 沿用原拒绝行为（403 方向）
```

`application.service.assertCanWriteProjectAware` 同构：先 `assertCanWrite`（属主），再查项目角色。

## 与其他模块的关系

- **被 [task.md](task.md) 消费（下一批次）**：`task.service` 注入 `ProjectAccessService` 做写面判定（NF-03 属主守卫之上的放行增量）；迁移 `1790000000008` 为 tasks 加 `projectId`。
- **被 [application.md](application.md) 消费**：应用列表按 `projectId` 过滤；`assertCanWriteProjectAware` 查项目角色；迁移 `1790000000009` 为 applications/executors 加列。
- **依赖 [users.md](users.md)**：成员 `userId` 逻辑关联用户（无 FK，悬垂 id 按非成员处理）。
- **被 [auth.md](auth.md) 预留**：JWT payload 已有 `projectId` claim 契约（X-Project-Id header 注入的承接位），当前 sign 侧不带、validate 不消费。

## 常见改动场景

- **给某资源接入项目过滤**：实体加可空 `projectId` 列（迁移 + FK ON DELETE SET NULL 惯例）→ 列表接口加可选 `projectId` query（`"default"` 映射 `Or(IsNull(), In([DEFAULT_PROJECT_ID]))`，参考 `application.service.findAll`）→ 写面经 `ProjectAccessService.hasProjectRole`。
- **加项目角色档位**：改 `PROJECT_ROLES`/`PROJECT_ROLE_RANK`（`project-member.entity.ts`）+ DTO 校验；注意 admin-web 角色选择器同步。
- **接入写面守卫**：用 `resolveRole`/`hasProjectRole`，保持"只放行、不收紧"与 fail-open（按非成员处理）约定，勿让权限服务抖动导致业务 500。
- **新增项目级接口**：读面可全员/成员，写面跟现有惯例挂 `@Roles(UserRole.ADMIN)`。
- **排查"某用户在项目里没权限"**：先查 `GET /projects/me/roles` 确认成员行与角色档位，再确认资源 `projectId` 是否为空（空 = 默认项目）；全局 ADMIN 不受项目角色约束。

## 相关文档

- 用户与全局角色：[users.md](users.md)；应用归属：[application.md](application.md)
- 任务模块（主要消费方）：[task.md](task.md)（下一批次）
- 核心概念：[../../00-overview/05-core-concepts.md](../../../00-overview/05-core-concepts.md)
