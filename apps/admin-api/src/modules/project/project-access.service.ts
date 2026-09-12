import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import {
  ProjectMember,
  ProjectRole,
  PROJECT_ROLE_RANK,
  isProjectRole,
} from "./entities/project-member.entity";
import { DEFAULT_PROJECT_ID } from "./project.entity";

/**
 * AUTH-02（项目级角色细化）：项目成员管理与角色判定。
 *
 * 关键约定（ADR-013）：
 * - **只放行、不收紧**：本服务只在既有守卫（NF-03 属主守卫 / 执行类写面）
 *   的「拒绝分支」上追加一次项目角色判定。没有成员行或本服务未被注入时，
 *   行为与 AUTH-02 之前逐字节一致。
 * - 未分配 projectId 的资源按默认项目判定（AUTH-01「未分配 = 默认项目」）。
 * - 查询失败一律 fail-open 记 warn：权限服务抖动不应该让业务写面 500，
 *   也不应该偷偷放行——这里选择「按无成员处理」（等价于既有行为）并留日志。
 */
export interface ProjectMemberView {
  id: string;
  projectId: string;
  userId: number;
  role: ProjectRole;
  createdAt: Date;
}

@Injectable()
export class ProjectAccessService {
  private readonly logger = new Logger(ProjectAccessService.name);

  constructor(
    @InjectRepository(ProjectMember)
    private readonly repo: Repository<ProjectMember>,
  ) {}

  /** 项目内角色；非成员返回 null（ADMIN 主体由调用方先行短路）。 */
  async resolveRole(
    userId: number | null | undefined,
    projectId?: string | null,
  ): Promise<ProjectRole | null> {
    if (userId == null) return null;
    const pid = projectId ?? DEFAULT_PROJECT_ID;
    try {
      const row = await this.repo.findOne({
        where: { projectId: pid, userId },
      });
      return row?.role ?? null;
    } catch (e: unknown) {
      this.logger.warn(
        `[project-access] resolveRole failed (treated as non-member): ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
      return null;
    }
  }

  /**
   * 是否达到 `minRole` 档位（viewer < editor < admin）。
   * 非成员 / 非法角色 / 查询失败 → false。
   */
  async hasProjectRole(
    userId: number | null | undefined,
    projectId: string | null | undefined,
    minRole: ProjectRole,
  ): Promise<boolean> {
    const role = await this.resolveRole(userId, projectId);
    if (!role || !isProjectRole(role)) return false;
    return PROJECT_ROLE_RANK[role] >= PROJECT_ROLE_RANK[minRole];
  }

  /** 该用户在哪些项目上具备角色（供列表过滤/「我的项目」）。 */
  async listRolesForUser(userId: number): Promise<ProjectMemberView[]> {
    try {
      const rows = await this.repo.find({ where: { userId } });
      return rows.map((r) => this.toView(r));
    } catch (e: unknown) {
      this.logger.warn(
        `[project-access] listRolesForUser failed: ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
      return [];
    }
  }

  async listMembers(projectId: string): Promise<ProjectMemberView[]> {
    const rows = await this.repo.find({
      where: { projectId },
      order: { createdAt: "ASC" },
    });
    return rows.map((r) => this.toView(r));
  }

  async addMember(
    projectId: string,
    userId: number,
    role: ProjectRole,
  ): Promise<ProjectMemberView> {
    this.assertRole(role);
    const existing = await this.repo.findOne({ where: { projectId, userId } });
    if (existing) {
      existing.role = role;
      return this.toView(await this.repo.save(existing));
    }
    const row = this.repo.create({ projectId, userId, role });
    return this.toView(await this.repo.save(row));
  }

  async updateMember(
    projectId: string,
    userId: number,
    role: ProjectRole,
  ): Promise<ProjectMemberView> {
    this.assertRole(role);
    const row = await this.repo.findOne({ where: { projectId, userId } });
    if (!row) {
      throw new NotFoundException(
        `User ${userId} is not a member of project ${projectId}`,
      );
    }
    row.role = role;
    return this.toView(await this.repo.save(row));
  }

  async removeMember(
    projectId: string,
    userId: number,
  ): Promise<{ deleted: boolean }> {
    const res = await this.repo.delete({ projectId, userId });
    return { deleted: (res.affected ?? 0) > 0 };
  }

  private assertRole(role: unknown): asserts role is ProjectRole {
    if (!isProjectRole(role)) {
      throw new BadRequestException(
        `invalid project role ${String(role)}; expected one of viewer, editor, admin`,
      );
    }
  }

  private toView(row: ProjectMember): ProjectMemberView {
    return {
      id: row.id,
      projectId: row.projectId,
      userId: row.userId,
      role: row.role,
      createdAt: row.createdAt,
    };
  }
}
