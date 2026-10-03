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
  /** ADMIN-only：移除成员（返回 {deleted}） */
  removeMember: (projectId: string, userId: number) =>
    client.delete(`/projects/${projectId}/members/${userId}`) as Promise<{ deleted: boolean }>,
  /** 当前登录用户在各项目中的角色（渲染「我的项目」/徽标） */
  listMyRoles: () =>
    client.get('/projects/me/roles') as Promise<MyProjectRoles>,
};
