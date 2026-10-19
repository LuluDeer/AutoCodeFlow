import { Injectable, Logger, Optional } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Not, Repository } from "typeorm";
import {
  Project,
  DEFAULT_PROJECT_ID,
  DEFAULT_PROJECT_NAME,
} from "./project.entity";
import { CreateProjectDto, UpdateProjectDto } from "./project.dto";
// LANG-ERR-01（后端错误码化）：用户面抛出统一走 AppError（带稳定码，前端按
// 用户语言渲染）。AppError 按状态码挂到对应内置异常原型上，故既有按异常类
// 断言的 spec 不受影响。
import { AppError } from "../../common/errors/app-error";
import { ErrorCode } from "../../common/errors/error-codes";
// PROJECT-IMPACT-01（删除影响面预览）：数「该项目下有多少任务/成员」。
// 与 task.module 的 TASK-PROJ-01 同款**跨模块 forFeature**——只取连接与元数据，
// 无运行时依赖环（ProjectsModule 不 import TaskModule，反之亦然）。
import { Task, TaskStatus } from "../task/entities/task.entity";
import { ProjectMember } from "./entities/project-member.entity";

/** PROJECT-IMPACT-01：删除影响面（与 application/executor 的 removal-impact 同构）。 */
export interface ProjectRemovalImpact {
  /** 项目自身名称——确认框据此拼「确认删除「X」？」。 */
  projectName: string;
  /**
   * 该项目下**未被软删除**的任务数。
   *
   * 口径刻意排除 `status = 'deleted'`：软删任务对用户已不可见，把它计入会让
   * 确认框报出一个用户在界面上数不出来的数字（「说 12 个，列表只有 9 个」）。
   */
  taskCount: number;
  /** 其中**处于 active（会被 cron 触发）**的任务数——真正会造成持续故障的那部分。 */
  activeTaskCount: number;
  /** 项目成员关系行数（删除后由 FK ON DELETE CASCADE 一并清除）。 */
  memberCount: number;
}

/**
 * AUTH-01（多租户 Project，第一批后端）：Projects CRUD。
 *
 * 默认项目保护：remove/update 均拒绝触碰 Default 行（种子 uuid
 * DEFAULT_PROJECT_ID）——迁移回填与「未分配 = 默认项目」语义都锚定这行，
 * 删掉/改名会让存量数据的归属永久悬空。非默认项目 remove 不做占用清空
 * （FK ON DELETE SET NULL 已由 DB 兜底）。
 *
 * PROJECT-IMPACT-01（生产隐患）：上面这句「FK 已由 DB 兜底」在语义上是对的，
 * 在**用户体验**上是错的——`ON DELETE SET NULL` 把项目下的任务静默变成
 * 「未分配」，而任务列表/权限判定把 NULL 当默认项目处理
 * （`project-access.service.resolveRole` 的 `projectId ?? DEFAULT_PROJECT_ID`）。
 * 后果是：原本靠「项目 editor」身份才能改的任务，删项目后掉进默认项目，
 * 而多数人在默认项目上没有成员行 → 任务对非 ADMIN 变成「看得见但改不动」。
 * 任务**不会消失**、cron **照旧触发**，所以这既不是「安全地删掉了」也不是
 * 「误删了数据」，而是一个**界面上完全看不出来的权限静默收缩**。
 *
 * 因此 `remove` 现在只做删除本身，**影响面由 `describeRemovalImpact` 单独提供**，
 * 前端在确认框里如实列出（对齐 P0-3 应用删除 / DEEP-AUDIT B·1.1 执行器删除
 * 的既有约定：能删的人先在界面上看到后果，而不是删完才发现）。
 */
@Injectable()
export class ProjectsService {
  private readonly logger = new Logger(ProjectsService.name);

  constructor(
    @InjectRepository(Project)
    private readonly repo: Repository<Project>,
    // PROJECT-IMPACT-01：影响面统计的两条只读仓储。
    //
    // `@Optional()` 的理由与 task.service 的 TASK-PROJ-01 同款：既有单测装配
    // （projects.service.spec）只提供 Project 仓储，缺这两条时模块仍要能编译。
    // 缺失时 describeRemovalImpact 返回 0 并记 warn——**预览失败不该让删除
    // 整条路走不通**（与 application.service.describeRemovalImpact 的
    // 「任务数不可用则保守返回 0」同一姿态）。
    @Optional()
    @InjectRepository(Task)
    private readonly taskRepo: Repository<Task> | null,
    @Optional()
    @InjectRepository(ProjectMember)
    private readonly memberRepo: Repository<ProjectMember> | null,
  ) {}

  async create(dto: CreateProjectDto): Promise<Project> {
    const row = this.repo.create({
      name: dto.name,
      description: dto.description ?? null,
    });
    try {
      return await this.repo.save(row);
    } catch (err: unknown) {
      // PROJECT-DUPNAME-01：撞 `UQ_projects_name` 时给可读文案。
      //
      // 此前这条路径落到全局 filter 的 `23505 → 409 RESOURCE_EXISTS`
      // （"资源已存在"）——用户不知道**是什么**已存在。task 域早有同款分流
      // （`uniqueConstraintName(err) === 'idx_tasks_name_unique'` →
      // `TASK_NAME_EXISTS`），项目域缺这一条，而「新建项目」正是本轮新开的
      // 入口，撞重名是最常见的用户操作失败。
      if (isUniqueViolationOn(err, "UQ_projects_name")) {
        throw new AppError(ErrorCode.PROJECT_NAME_EXISTS, { name: dto.name });
      }
      throw err;
    }
  }

  // P3-1：项目表为小表（组织级通常 < 百行），服务层保持全表 find——**响应面**
  // 的分页收敛在 controller（可选 page/pageSize 信封，不传参数仍全量数组）。
  // 无界的是线上载荷而非这一次 DB 读；若未来项目数到达千级，再把切片下推
  // 到 QueryBuilder skip/take（届时 page@Max(10000) 纪律已在 controller 备好）。
  async findAll(): Promise<Project[]> {
    return this.repo.find({ order: { createdAt: "ASC" } });
  }

  async findOne(id: string): Promise<Project> {
    const row = await this.repo.findOne({ where: { id } });
    if (!row) throw new AppError(ErrorCode.PROJECT_NOT_FOUND, { id });
    return row;
  }

  async update(id: string, dto: UpdateProjectDto): Promise<Project> {
    if (
      id === DEFAULT_PROJECT_ID &&
      dto.name &&
      dto.name !== DEFAULT_PROJECT_NAME
    ) {
      throw new AppError(ErrorCode.PROJECT_DEFAULT_IMMUTABLE);
    }
    const row = await this.findOne(id);
    if (dto.name !== undefined) row.name = dto.name;
    if (dto.description !== undefined) row.description = dto.description;
    try {
      return await this.repo.save(row);
    } catch (err: unknown) {
      // 改名撞同一唯一索引：与 create 同款分流（否则用户拿到"资源已存在"，
      // 完全不知道撞的是另一个项目的名字）。
      if (isUniqueViolationOn(err, "UQ_projects_name")) {
        throw new AppError(ErrorCode.PROJECT_NAME_EXISTS, { name: row.name });
      }
      throw err;
    }
  }

  /**
   * PROJECT-IMPACT-01：删除影响面预览（GET /projects/:id/removal-impact）。
   *
   * 与 `application.service.describeRemovalImpact` / `executor.service` 同构：
   * 只读、不产生副作用，供前端确认框如实告知后果。
   *
   * 默认项目**照样返回**（不 404）：它是恒不可删的，但把它当成「删除被拒」
   * 提前拦下会让前端无法复用同一条确认链路；真正拦截仍在 remove 里。
   * 返回里 `deletable: false` 让前端可以据实渲染「此项目不可删除」。
   */
  async describeRemovalImpact(
    id: string,
  ): Promise<ProjectRemovalImpact & { deletable: boolean }> {
    // 先取行：项目不存在时给 404（与 remove 的失败面一致），而不是返回一堆 0。
    const project = await this.findOne(id);
    const [taskCount, activeTaskCount, memberCount] = await Promise.all([
      this.countTasks(id, false),
      this.countTasks(id, true),
      this.countMembers(id),
    ]);
    return {
      projectName: project.name,
      taskCount,
      activeTaskCount,
      memberCount,
      deletable: id !== DEFAULT_PROJECT_ID,
    };
  }

  /**
   * 任务计数。`activeOnly` 为真时只数 `status = active`（会被 cron 触发的那些）。
   *
   * 软删除行（`status = deleted`）两种口径都排除——见 `ProjectRemovalImpact`
   * 的字段注释。仓储缺席（单测装配/未接线）时返回 0 并 warn，不抛错。
   */
  private async countTasks(
    projectId: string,
    activeOnly: boolean,
  ): Promise<number> {
    if (!this.taskRepo) {
      this.logger.warn(
        `[project-impact] Task 仓储未注入，任务数按 0 返回（project ${projectId}）`,
      );
      return 0;
    }
    try {
      return await this.taskRepo.count({
        where: activeOnly
          ? { projectId, status: TaskStatus.ACTIVE }
          : { projectId, status: Not(TaskStatus.DELETED) },
      });
    } catch (err: unknown) {
      this.logger.warn(
        `[project-impact] 任务计数失败（按 0 返回）: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return 0;
    }
  }

  private async countMembers(projectId: string): Promise<number> {
    if (!this.memberRepo) {
      this.logger.warn(
        `[project-impact] ProjectMember 仓储未注入，成员数按 0 返回（project ${projectId}）`,
      );
      return 0;
    }
    try {
      return await this.memberRepo.count({ where: { projectId } });
    } catch (err: unknown) {
      this.logger.warn(
        `[project-impact] 成员计数失败（按 0 返回）: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return 0;
    }
  }

  async remove(id: string): Promise<{ deleted: boolean }> {
    if (id === DEFAULT_PROJECT_ID) {
      throw new AppError(ErrorCode.PROJECT_DEFAULT_IMMUTABLE);
    }
    const row = await this.findOne(id);
    await this.repo.delete(row.id);
    return { deleted: true };
  }
}

/**
 * PROJECT-DUPNAME-01：判定「这个唯一冲突是不是撞了指定的那个约束」。
 *
 * 为什么不用 `err.code === '23505'` 一刀切：项目表上未来可能新增别的唯一索引
 * （例如按 projectId+userId 的成员表同名约束），一刀切会把别处的冲突也报成
 * 「项目名已存在」，比笼统的「资源已存在」更误导。
 *
 * 约束名的读取路径与 `task.service.ts` 的 `uniqueConstraintName` 同款：
 * TypeORM 把 PG 原始错误挂在 `driverError` 上，但不同驱动/版本也会直接放在
 * 顶层——两处都看。`constraint` 缺失时**保守返回 false**（回落全局 409），
 * 宁可文案笼统，不可把错误归因到错的字段。
 */
function isUniqueViolationOn(err: unknown, constraint: string): boolean {
  if (err === null || typeof err !== "object") return false;
  const e = err as {
    code?: unknown;
    constraint?: unknown;
    driverError?: { code?: unknown; constraint?: unknown };
  };
  const code = e.code ?? e.driverError?.code;
  if (code !== "23505") return false;
  return (e.constraint ?? e.driverError?.constraint) === constraint;
}
