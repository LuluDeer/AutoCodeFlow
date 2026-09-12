import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
} from "typeorm";

/**
 * AUTH-02（项目级角色细化）：项目成员与角色。
 *
 * 角色模型（ADR-013）三档，**只在非 ADMIN 主体上生效**——全局 ADMIN 恒全量
 * 放行（跨项目、跨资源），项目角色是「给普通用户的能力增量」，不是收紧面：
 *
 * - `viewer`：项目内只读（列表/详情）；任何写面（含 trigger/pause）403；
 * - `editor`：项目内任务/应用的读写（含他人创建的资源）+ **执行类写面**
 *   （trigger/pause/resume/kill，NF-03 遗留归属在此闭合）；
 * - `admin`：项目内全权（删除、部署/执行器写面）+ 成员管理（任免 ≤ 自己）。
 *
 * 零破坏约定：**迁移不回填任何成员行**。没有成员行时，写面判定与 AUTH-02
 * 之前逐字节一致（放行面只增不减）；一旦为某项目配置了成员，其余非成员用户
 * 在该项目的写面不再获得**新增**放行（原本也不放行），不产生任何权限回退。
 *
 * 未分配 projectId 的资源（可空列）按默认项目（DEFAULT_PROJECT_ID）判定，
 * 与 AUTH-01「未分配 = 默认项目视图」语义一致。
 */
export const PROJECT_ROLES = ["viewer", "editor", "admin"] as const;
export type ProjectRole = (typeof PROJECT_ROLES)[number];

/** 角色强弱序（用于「至少某档」的比较）。 */
export const PROJECT_ROLE_RANK: Record<ProjectRole, number> = {
  viewer: 1,
  editor: 2,
  admin: 3,
};

export function isProjectRole(value: unknown): value is ProjectRole {
  return (
    typeof value === "string" &&
    (PROJECT_ROLES as readonly string[]).includes(value)
  );
}

@Entity("project_members")
@Index("UQ_project_members_project_user", ["projectId", "userId"], {
  unique: true,
})
@Index("IDX_project_members_userId", ["userId"])
export class ProjectMember {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Column({ type: "uuid" })
  projectId: string;

  @Column({ type: "int" })
  userId: number;

  @Column({ type: "varchar", length: 16 })
  role: ProjectRole;

  @CreateDateColumn()
  createdAt: Date;
}
