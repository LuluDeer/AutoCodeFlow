# ADR-013：项目级角色细化（AUTH-02）

- 状态：已接受（2026-09-12）
- 关联：AUTH-01（多租户 Project 第一批）、NF-03（属主守卫）、迁移 1790000000015、
  `apps/admin-api/src/modules/project/project-access.service.ts`

## 背景

AUTH-01 落地了 Project 实体与 `tasks/applications.projectId`，但**没有成员与角色
概念**：项目的可见性对所有人一致，写面只有 NF-03 的「ADMIN 全量 / 属主改自己的 /
无主行仅 ADMIN」三态。这带来两个真实缺口：

1. **团队协作不可表达**：同项目的同事既不能改他人创建的任务，也无法接管历史遗留的
   无主行——只能找管理员，管理员成了瓶颈。
2. **执行类写面归属未定义**（NF-03 明确遗留）：任何登录用户都能 trigger/pause/resume
   任意任务，包括自己完全无关的项目。

## 决策

### 1. 角色模型：三档，只作用于非 ADMIN 主体

`project_members(projectId, userId, role)`，(projectId,userId) 唯一。

| 角色 | 项目内能力 |
|---|---|
| `viewer` | 只读；**执行类写面（trigger/pause/resume）拒绝** |
| `editor` | 任务/应用的增删改（含他人创建行与无主存量行）+ 执行类写面 |
| `admin` | editor 的全部 + 成员管理外的项目内全权 |

全局 `UserRole.ADMIN` **恒全量放行**，不查项目成员——项目角色是「给普通用户的能力
增量」，不是第二套管理员体系。

### 2. 只增放行，不收紧（零破坏升级）

- 迁移 1790000000015 **不回填任何成员行**；
- 写面判定 = `NF-03 属主守卫` 或 `项目角色 ≥ editor`：未配置成员关系时逐字节等价于
  AUTH-02 之前的行为；
- 唯一的硬约束点是 **viewer 拒绝执行类写面**——而 viewer 只在管理员显式配置后才存在，
  因此存量部署行为零变化。

> 明确保留的已知缺口：**非成员用户仍可 trigger/pause/resume 任意任务**（既有宽松语义）。
> 收紧它属破坏性变更，需产品拍板（例如「仅成员可执行」开关），不在本 ADR 内单方面实施。

### 3. 未分配 projectId → 默认项目

`projectId IS NULL` 的资源按 `DEFAULT_PROJECT_ID` 判定，与 AUTH-01「未分配 = 默认项目
视图」一致。默认项目显式例外：**成员列表对任何登录用户可读**（它是未分配资源的归属
视图，读它不构成越权），且默认项目不可改名/删除（延续 AUTH-01 保护）。

### 4. 成员管理维持 ADMIN-only

不给「项目 admin」开放成员任免：项目 admin 若能任免成员，就形成了自我提权的授权链
（给自己加人 → 改他人角色），而 AUTH-02 尚无跨项目授权治理模型。成员管理留在平台
管理员手中，代价是项目扩容需要管理员操作，收益是不引入嵌套授权风险。

### 5. 失效与抖动语义

| 场景 | 行为 |
|---|---|
| `ProjectAccessService` 未接线（单测/模块缺失） | 整体旁路，等价于 AUTH-02 之前 |
| 用户主体缺失（API-Key 机器主体） | 旁路（机器面靠 scope 治理） |
| 角色查询 DB 抖动 | fail-open → 视为非成员并 `warn`（既有行为），不 500，也不误放行 |
| 角色列脏数据（非三档） | 视为非成员（不误放行） |

## 后果

- 团队协作：项目 editor/admin 可互改项目内资源，无主存量行可被项目成员接管。
- 权限可表达：viewer 提供真正的只读席位（如观察者/审计视角）。
- 新增 API：`GET/POST/PATCH/DELETE /projects/:id/members`、`GET /projects/me/roles`。
- 未做：项目列表按成员过滤（读面仍全员可见）、项目内 executor/package 的角色细分、
  「仅成员可执行」收紧开关——均登记为后续。

## 验证

- 单测：`project-access.service.spec`（角色/档位/抖动/CRUD）、
  `projects.controller.auth02.spec`（RBAC 姿态与默认项目例外）、
  `task-owner-guard.spec`（项目放行矩阵 + viewer 拒绝）、迁移结构断言。
- 真机：项目成员读写链路随 `apps/admin-api` 集成 e2e 覆盖（admin-api 2326 例全绿）。
