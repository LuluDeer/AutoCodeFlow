import { Injectable, Logger, Optional } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import {
  ProjectMember,
  ProjectRole,
  PROJECT_ROLE_RANK,
  isProjectRole,
} from "./entities/project-member.entity";
import { DEFAULT_PROJECT_ID } from "./project.entity";
// R32-A5（轴1/轴3）：成员授予前校验目标用户存在（project_members.userId 无 FK）。
import { UsersService } from "../users/users.service";
// LANG-ERR-01（后端错误码化）：用户面抛出统一走 AppError（带稳定码，前端按
// 用户语言渲染）。AppError 按状态码挂到对应内置异常原型上，故既有按异常类
// 断言的 spec 不受影响。
import { AppError } from "../../common/errors/app-error";
import { ErrorCode } from "../../common/errors/error-codes";

/**
 * AUTH-02（项目级角色细化）：项目成员管理与角色判定。
 *
 * 关键约定（ADR-013）：
 * - **只放行、不收紧**：本服务只在既有守卫（NF-03 属主守卫 / 执行类写面）
 *   的「拒绝分支」上追加一次项目角色判定。没有成员行或本服务未被注入时，
 *   行为与 AUTH-02 之前逐字节一致。
 * - 未分配 projectId 的资源按默认项目判定（AUTH-01「未分配 = 默认项目」）。
 * - 查询失败**按调用方姿态分流**（R32-B1 修正，旧版是"一律 fail-open"）：
 *   · 读面（`hasProjectRole` / `listRolesForUser` / 项目元信息）：仍然 fail-open
 *     记 warn、「按无成员处理」——权限表抖动不该让列表接口 500；
 *   · 执行类写面（trigger / pause / resume / rollback）：判定不可用是一个**故障**
 *     而不是"没有权限"，由 `TaskService.assertCanOperate` 消费
 *     `resolveRoleState` 的 `unavailable` 分支后 fail-closed（503
 *     `PROJECT_ROLE_UNAVAILABLE`）。
 *   旧版把两者都折成「非成员」，于是故障窗口里执行类写面的 viewer 拒绝**不会触发**，
 *   权限检查退化成"谁都能做"（R32-A5 登记）。两种语义从此在类型上分开：
 *   `resolveRole`（`ProjectRole | null`，二态，读面）/ `resolveRoleState`
 *   （`ProjectRoleResolution`，三态，写面）。
 */
/**
 * R32-B1：**角色判定的三态**（不是二态）。
 *
 * 缺陷成因就是「两种语义共用一个 null」：`resolveRole` 的返回类型
 * `ProjectRole | null` 里，null 同时表示「查到了，确实没有成员行」与「查询失败，
 * 判定没做完」。执行类写面（`TaskService.assertCanOperate`）只识别前者代表的
 * 「宽松放行」语义，于是把后者也一并放行了——数据库抖动的那十几秒里，权限检查
 * 变成「谁都能做」。把两种语义**在类型上分开**，任何调用点都必须显式回答
 * 「`unavailable` 怎么办」，这个 bug 才无法在下一个调用点复现。
 *
 * - `role`：判定成功且存在成员行；
 * - `none`：判定成功，但该用户在这个项目里没有成员行（"非成员"，合法答案）；
 * - `unavailable`：判定**没做完**（查询抛错）。这不是一个授权结论，而是一个故障，
 *   调用方必须自己决定降级姿态——读面宽容、执行类写面 fail-closed（503）。
 */
export type ProjectRoleResolution =
  | { readonly status: "role"; readonly role: ProjectRole }
  | { readonly status: "none" }
  | { readonly status: "unavailable" };

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
    // R32-A5（轴1/轴3）：成员授予前的目标用户存在性校验。@Optional + 置尾——
    // 既有单测/极简装配（new ProjectAccessService(repo)）不破，缺席时跳过校验
    // （与 AUTH-02 之前逐字节一致）。
    @Optional()
    private readonly usersService?: UsersService | null,
  ) {}

  /**
   * R32-B1：判定三态的唯一实现（`resolveRole` 是它的二态折叠，见下）。
   *
   * 与旧 `resolveRole` 的差异**只有一处**：catch 分支不再把故障折成「非成员」，
   * 而是原样标成 `unavailable` 交还调用方。日志文案逐字保留（既有
   * `project-access.service.spec.ts` 以子串 `resolveRole failed` 钉住它，
   * 且该 warn 是判定不可用时的唯一现场证据——不能因为「上层会 503」就不记）。
   */
  async resolveRoleState(
    userId: number | null | undefined,
    projectId?: string | null,
  ): Promise<ProjectRoleResolution> {
    if (userId == null) return { status: "none" };
    const pid = projectId ?? DEFAULT_PROJECT_ID;
    try {
      const row = await this.repo.findOne({
        where: { projectId: pid, userId },
      });
      // 保留 `row?.role ?? null` 的逐字节语义：脏数据（如 "superuser"）仍以
      // `role` 形态交出去，由 hasProjectRole 的 isProjectRole 校验拒绝，
      // 不在这里替调用方把它悄悄折成"非成员"。
      const role = row?.role;
      if (role === null || role === undefined) return { status: "none" };
      return { status: "role", role };
    } catch (e: unknown) {
      this.logger.warn(
        `[project-access] resolveRole failed (treated as non-member): ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
      return { status: "unavailable" };
    }
  }

  /**
   * 项目内角色；非成员返回 null（ADMIN 主体由调用方先行短路）。
   *
   * R32-B1：**签名与语义逐字节不变**——读面（`hasProjectRole` /
   * `listRolesForUser` / `projects.controller` 的项目元信息）依赖这条
   * 「判定失败 → null → 上层按非成员处理」的宽容姿态：权限表抖动不应该让
   * 列表接口 500。写面的 fail-closed 由 `resolveRoleState` 的
   * `unavailable` 分支承担，不在这里改。
   */
  async resolveRole(
    userId: number | null | undefined,
    projectId?: string | null,
  ): Promise<ProjectRole | null> {
    const state = await this.resolveRoleState(userId, projectId);
    return state.status === "role" ? state.role : null;
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
    // R32-A5（轴1 幽灵成员 / 轴3 成员管理）：授予对象必须在场。
    await this.assertTargetUserExists(userId);
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
      throw new AppError(ErrorCode.PROJECT_NOT_MEMBER, { userId, projectId });
    }
    row.role = role;
    return this.toView(await this.repo.save(row));
  }

  /**
   * 移除成员。
   *
   * PROJECT-MEMBER-404：目标没有成员行时抛 404 `PROJECT_NOT_MEMBER`，与
   * `updateMember` 同口径——此前是「删 0 行也返回 `{deleted:false}` + 200」，
   * 而前端 `MembersDrawer` 的成功回调**不看返回值**，直接弹「已移除」：并发
   * 场景下（另一管理员刚移除同一人）用户会拿到一条假成功提示，回列表才发现
   * 人早就不在了。同一个服务里两个写方法对「行不存在」给出相反结论，是缺陷
   * 而不是风格差异。
   *
   * 为什么不做成幂等 200：本端点的语义是「移除这条成员关系」，寻址失败与
   * 「已经是你想要的状态」在审计面上是两件事（`D3-B-P1-1` 对成员移除落了
   * 审计证，假成功会让审计表记下一次从未发生的授权变更）。
   */
  async removeMember(
    projectId: string,
    userId: number,
  ): Promise<{ deleted: boolean }> {
    const row = await this.repo.findOne({ where: { projectId, userId } });
    if (!row) {
      throw new AppError(ErrorCode.PROJECT_NOT_MEMBER, { userId, projectId });
    }
    await this.repo.delete({ projectId, userId });
    return { deleted: true };
  }

  /**
   * R32-A5：成员授予的目标用户存在性闸。
   *
   * 缺陷现场：A-8 只补了「删除用户 → 清 project_members」这一侧，创建侧对
   * userId 零校验。project_members.userId 无 FK，于是
   * `POST /projects/:id/members {userId: 987654}` 能 201 一条指向**没有人**的
   * 成员行：成员面板展示一个无对应用户的成员，而 `resolveRole(987654, pid)`
   * 对该 id 是**既成授权**——id 复用、跨环境/备份导入时立刻变成真实访问权。
   * 授予是授权动作，故 fail-closed（与 hasProjectRole 判定侧的 fail-open 姿态相反）。
   *
   * 三条回落，都刻意如此：
   * - usersService 缺席（单测/极简装配）→ 跳过校验，行为与 AUTH-02 之前一致；
   * - 查询失败 → warn 后跳过（本文件既定姿态：权限表抖动不该让业务写面 500，
   *   也不该在已通过 ADMIN-only 守卫的授予动作上制造假失败）；
   * - 不存在 → 404 USER_ID_NOT_FOUND（复用 users 域的既有点名码，不新增码）。
   */
  private async assertTargetUserExists(userId: number): Promise<void> {
    if (!this.usersService) return;
    let target: { id: number } | null | undefined;
    try {
      target = await this.usersService.findByIdOrNull(userId);
    } catch (e: unknown) {
      this.logger.warn(
        `[project-access] target user lookup failed (grant allowed): ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
      return;
    }
    if (!target) {
      throw new AppError(ErrorCode.USER_ID_NOT_FOUND, { id: userId });
    }
  }

  private assertRole(role: unknown): asserts role is ProjectRole {
    if (!isProjectRole(role)) {
      throw new AppError(ErrorCode.PROJECT_INVALID_ROLE, {
        role: String(role),
      });
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
