import { client } from './client';

/**
 * AUTH-02 后续：项目与成员前端契约。
 * ProjectViewRow 与后端 projects.controller findAll 的行形状逐字段对齐
 * （读面过滤：ADMIN 全量，普通用户「默认项目 ∪ 成员项目」，myRole 如实标注）。
 */
export type ProjectRole = 'viewer' | 'editor' | 'admin';

export interface ProjectViewRow {
  id: string;
  name: string;
  description: string | null;
  createdAt: string;
  updatedAt: string;
  /** 当前登录主体在该项目的成员角色；非成员 null */
  myRole: ProjectRole | null;
}

/**
 * 项目实体行（`GET/POST/PATCH /projects/:id` 的返回形状）。
 *
 * 与 `ProjectViewRow` 的差别是**没有 `myRole`**——写面返回的是 `Project` 实体
 * （见后端 `dto/project-response.dto.ts` 的 `ProjectEntityDto` 头注）。前端写后
 * 一律走列表失效重取，不拿实体行硬拼视图行，故两者不互相赋值。
 */
export interface ProjectEntityRow {
  id: string;
  name: string;
  description: string | null;
  createdAt: string;
  updatedAt: string;
}

/** 新建/更新项目的请求体（与后端 CreateProjectDto 逐字段对齐）。 */
export interface CreateProjectDto {
  name: string;
  description?: string;
}

export type UpdateProjectDto = Partial<CreateProjectDto>;

/**
 * `GET /projects/:id/removal-impact` 的响应（PROJECT-IMPACT-01）。
 *
 * 字段与后端 `ProjectRemovalImpactResponseDto` 逐一对齐。
 *
 * ⚠️ **没有** applicationCount，别凭直觉补一个：applications / executors /
 * executor_packages 三张表虽然都有 `projectId` 列，但对应 DTO 里**都没有这个
 * 字段**，运行期没有任何写入口能把它们挂到项目下（列恒为 NULL）。给一个永远
 * 为 0 的字段，会让确认框写出「删除后 0 个应用回到未分配」这种看似精确、
 * 实则毫无信息量的废话——比不写更坏。
 */
export interface ProjectRemovalImpact {
  projectName: string;
  /** 该项目下未软删除的任务数（status != deleted） */
  taskCount: number;
  /** 其中 active（会被 cron 触发）的任务数——真正会持续产生副作用的那部分 */
  activeTaskCount: number;
  /** 成员关系行数（删除时随 FK ON DELETE CASCADE 清理） */
  memberCount: number;
  /** 默认项目恒为 false（后端 remove 会返回 404 PROJECT_DEFAULT_IMMUTABLE） */
  deletable: boolean;
}

export interface ProjectMemberRow {
  id: string;
  projectId: string;
  userId: number;
  role: ProjectRole;
  createdAt: string;
}

export interface MyProjectRoles {
  userId: number | null;
  isAdmin: boolean;
  memberships: ProjectMemberRow[];
}

/**
 * GET /projects 分页信封（仅 listPaged 使用）。
 * 形状与后端 `paginate()`（tasks/users 列表同款）逐字段对齐：
 * list/items 双键是后端 R-21 遗留，前端只消费 `list`。
 */
export interface ProjectListPage {
  list: ProjectViewRow[];
  items: ProjectViewRow[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export const projectsApi = {
  /** 全量数组（旧契约）：TaskFormPage 项目选择器等消费方，勿改。 */
  list: (signal?: AbortSignal) =>
    signal
      ? client.get('/projects', { signal }) as Promise<ProjectViewRow[]>
      : client.get('/projects') as Promise<ProjectViewRow[]>,
  /**
   * 服务端分页（仅 ProjectsPage 使用）：传 page/pageSize → 后端返回分页信封。
   * 后端钳制 page≥1、pageSize≤100（非法值回落缺省，不 400）。
   */
  listPaged: (page: number, pageSize: number, signal?: AbortSignal) =>
    signal
      ? client.get<ProjectListPage>('/projects', { params: { page, pageSize }, signal })
      : client.get<ProjectListPage>('/projects', { params: { page, pageSize } }),
  /**
   * 新建项目（ADMIN-only）。
   *
   * 后端 `CreateProjectDto` 走全局 ValidationPipe 的 `forbidNonWhitelisted`——
   * 多传一个未声明字段即 400，故这里显式声明形状而不复用 `Partial<ProjectViewRow>`
   * （视图行带的 `myRole`/`createdAt` 会被拒）。name 唯一性由 DB 唯一索引兜底，
   * 撞 `UQ_projects_name` 时后端已分流为 409 `PROJECT_NAME_EXISTS`（可读文案带
   * 用户填的名字），前端按 409 走冲突分支即可。
   */
  create: (dto: CreateProjectDto) =>
    client.post<ProjectEntityRow>('/projects', dto),
  /** 更新项目（ADMIN-only）：默认项目改名会被后端 404 PROJECT_DEFAULT_IMMUTABLE 拒绝。 */
  update: (projectId: string, dto: UpdateProjectDto) =>
    client.patch<ProjectEntityRow>(`/projects/${projectId}`, dto),
  /**
   * 删除影响面预览（PROJECT-IMPACT-01，ADMIN-only）。
   *
   * 为什么必须有这个调用而不是直接在确认框里写死文案：项目删除走
   * FK `ON DELETE SET NULL`——任务**不会消失**、cron **照旧触发**，但
   * `projectId` 被置空后会被权限层按默认项目判定（`resolveRole` 的
   * `projectId ?? DEFAULT_PROJECT_ID`），原本靠「项目 editor」才能改的任务对
   * 非 ADMIN 变成「看得见改不动」。这个后果在界面上完全看不出来，只能在
   * 删除前的确认框里报数（对齐 P0-3 应用删除、执行器删除的既有约定）。
   */
  removalImpact: (projectId: string, signal?: AbortSignal) =>
    signal
      ? client.get<ProjectRemovalImpact>(`/projects/${projectId}/removal-impact`, { signal })
      : client.get<ProjectRemovalImpact>(`/projects/${projectId}/removal-impact`),
  /**
   * 删除项目（ADMIN-only，返回 `{deleted}`）。
   *
   * 后果（调用方应在确认框里如实告知，见 `removalImpact`）：该项目下任务的
   * `projectId` 由 FK `ON DELETE SET NULL` 置空（回到「未分配」视图，**任务
   * 本身不会被删除、cron 也不会停**），成员行随 `ON DELETE CASCADE` 一并清理。
   * 默认项目恒拒绝（404 PROJECT_DEFAULT_IMMUTABLE）。
   *
   * ⚠️ applications / executors / executor_packages 的 `projectId` 列虽然也
   * 有同款 FK，但**没有任何写入口**能给它们赋值（DTO 里没这个字段），故删除
   * 项目实际上不会让任何应用「回到未分配」——文案别这么写，会误导人以为
   * 删项目会丢应用。
   */
  remove: (projectId: string) =>
    client.delete<{ deleted: boolean }>(`/projects/${projectId}`),
  getMembers: (projectId: string, signal?: AbortSignal) =>
    signal
      ? client.get(`/projects/${projectId}/members`, { signal }) as Promise<ProjectMemberRow[]>
      : client.get(`/projects/${projectId}/members`) as Promise<ProjectMemberRow[]>,
  /** ADMIN-only：新增或改角色（(projectId,userId) 唯一，重复即改角色） */
  addMember: (projectId: string, userId: number, role: ProjectRole) =>
    client.post(`/projects/${projectId}/members`, { userId, role }) as Promise<ProjectMemberRow>,
  /** ADMIN-only：仅改角色（成员不存在 404） */
  updateMember: (projectId: string, userId: number, role: ProjectRole) =>
    client.patch(`/projects/${projectId}/members/${userId}`, { role }) as Promise<ProjectMemberRow>,
  /** ADMIN-only：移除成员（返回 {deleted}；成员不存在 404 PROJECT_NOT_MEMBER） */
  removeMember: (projectId: string, userId: number) =>
    client.delete(`/projects/${projectId}/members/${userId}`) as Promise<{ deleted: boolean }>,
  /** 当前登录用户在各项目中的角色（渲染「我的项目」/徽标） */
  listMyRoles: () =>
    client.get('/projects/me/roles') as Promise<MyProjectRoles>,
};
