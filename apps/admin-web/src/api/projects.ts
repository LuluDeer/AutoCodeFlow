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

export const projectsApi = {
  list: () => client.get('/projects') as Promise<ProjectViewRow[]>,
  getMembers: (projectId: string) =>
    client.get(`/projects/${projectId}/members`) as Promise<ProjectMemberRow[]>,
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
