import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  ServiceUnavailableException,
  Inject,
  Optional,
  forwardRef,
} from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { assertSafeGitRepoUrl } from "../../common/utils/safe-http.util";
import {
  DataSource,
  ILike,
  In,
  IsNull,
  Not,
  Or,
  QueryFailedError,
  Repository,
} from "typeorm";
import { InjectQueue } from "@nestjs/bullmq";
import { Queue } from "bullmq";
import { ConfigService } from "@nestjs/config";
import { createInterface } from "node:readline";
import type { Readable } from "node:stream";
import {
  Task,
  TaskStatus,
  ExecuteMode,
  normalizeTaskPriority,
} from "./entities/task.entity";
import { UserRole } from "../users/entities/user.entity";
import {
  TaskExecution,
  ExecutionStatus,
  ExecutionFailureReason,
} from "./entities/task-execution.entity";
import { ExecutionLogLine } from "./entities/execution-log-line.entity";
import { TaskVersion } from "./entities/task-version.entity";
import { CreateTaskDto } from "./dto/create-task.dto";
import { UpdateTaskDto } from "./dto/update-task.dto";
import { TriggerTaskDto } from "./dto/trigger-task.dto";
import { PaginationDto, paginate } from "../../common/dto/pagination.dto";
import { ListTasksQueryDto } from "./dto/list-tasks-query.dto";
import { SchedulerService } from "../scheduler/scheduler.service";
import { AiService } from "../ai/ai.service";
// ARCH-30: on-demand 分析同走服务化封装（重试 + autoflow_ai_analysis_total
// 指标 + fail-open），processor 直调点与手动分析点共用同一降级/观测策略。
import { AiAnalysisService } from "../ai/ai-analysis.service";
import { ExecutorService } from "../executor/executor.service";
// ARCH-21: 领域事件总线——终态事件（execution.completed/failed）发布入口。
// 主链由此与 NotificationService 彻底解耦（验收红线：本文件不再 import 它）。
import { DomainEventBus } from "../../common/services/domain-event-bus.service";
import {
  DOMAIN_EVENTS,
  ExecutionTerminalEventPayload,
} from "../../common/events/domain-events";
// ARCH-21: AuditService import 随注入移除（唯一消费方 notifyCallbackFailure 已迁监听器）。
import { S3LogStorage } from "./log-storage/s3-log-storage";
// SEC-02: 任务级 secrets 落库加密 / 读脱敏 / 派发解密的统一入口
import { SecretsCryptoService } from "../../common/utils/secret-crypto.util.service";
// AUTH-01: 默认项目 uuid（"default" 过滤映射目标，与迁移 1790000000008
// 回填值共享同一常量出处 project.entity.ts）。
import { DEFAULT_PROJECT_ID } from "../project/project.entity";
// AUTH-02: 项目级角色（写面/执行类写面归属判定）
import { ProjectAccessService } from "../project/project-access.service";
// CORE-04: 超时策略归一化（DTO 边界之外的运行态兜底——编程式/旧数据形态）
import {
  normalizeTimeoutAction,
  normalizeTimeoutWarnRatio,
} from "./timeout-policy.util";
// OBS-03: 日志行级别推断（纯函数）——写入落库 + S3 读取后过滤共用同一实现
import { levelOfLine } from "./log-level.util";
// CORE-02: 重试退避抖动——±20% 摊开同时刻重试，避免 thundering herd
import { jitteredRetryDelayMs } from "./retry-backoff.util";
// OBS-04: 执行时间线映射（纯函数）——report 端点与 mcp-server timeline 同语义
import { buildExecutionTimeline } from "./execution-timeline.util";
// OBS-04: execution_reports 当日聚合行读侧（写方为 MetricsService.generateReport）
import { ExecutionReport } from "../metrics/entities/execution-report.entity";
// 可观测性补齐轮：运行时计数器埋点入口（模块级纯内存自增，无模块环，
// 见 metrics/runtime-metrics-entry.ts 注释）。
import {
  recordRuntime,
  setRuntimeGauge,
} from "../metrics/runtime-metrics-entry";
// OBS-01: OpenTelemetry 追踪（@Global；OTEL_ENABLED=false 时全方法短路）
import { TracingService } from "../../common/tracing/tracing.service";

/**
 * Detects truncation markers inserted by executors when callback logs exceed
 * the payload limit.
 * Node:   "... [logs truncated, original length N chars] ..."
 * Python: "...[truncated, total N chars]..."
 */
const LOG_TRUNCATION_MARKER = /\[\s*(?:logs\s+)?truncated\b/i;

/**
 * TASK-007: 依赖环检测的深度/访问节点上限。数据库中若存在超长依赖链
 * （例如 100 层），无上限的逐层递归会触发串行 N+1 查询，构成 DoS 向量；
 * 超过上限直接抛 BadRequestException("dependency chain too deep")。
 */
export const MAX_DEPENDENCY_DEPTH = 64;

/**
 * R4-P3: checkDependencies 单次扫描的执行行数上限。原实现无 take，
 * 会把依赖任务的全量历史拉进内存；加上限后内存有界。
 * 权衡：DESC 排序下"每个依赖的最新一次执行"几乎总落在最近 N 行内；
 * 极端场景（某个高频依赖把其余依赖的最新行挤出窗口）由下方的按依赖
 * 定向兜底查询（findLatestExecutionPerDependency）补齐，判定语义不变。
 */
export const MAX_DEPENDENCY_EXECUTION_SCAN = 500;

/**
 * R4-P3: 依赖扇出短窗 DB claim 的窗口（毫秒）。只需覆盖"两个上游回调
 * 并发完成、双方 checkDependencies 都判满足"的竞态窗口；10s 足够，
 * 同时把对 tasks.lastTriggerTime 共享语义的影响压到最小（见
 * claimDependencyTrigger 的权衡注释）。
 */
export const DEPENDENCY_TRIGGER_CLAIM_WINDOW_MS = 10_000;

/**
 * R6: PG 唯一约束/主键冲突（SQLSTATE 23505 unique_violation）。客户端自带
 * 已存在的 id 时 insert 撞主键，驱动抛 QueryFailedError——若不拦截会经全局
 * 过滤器裸 500。识别后统一转 409 ConflictException。
 */
function isUniqueViolation(err: unknown): boolean {
  return (
    err instanceof QueryFailedError &&
    (err as QueryFailedError & { code?: string }).code === "23505"
  );
}

@Injectable()
export class TaskService {
  private readonly logger = new Logger(TaskService.name);
  /** Lazily-initialized optional S3/MinIO log backend (LOG_STORAGE_DRIVER=s3). */
  private s3LogStorage: S3LogStorage | null = null;
  private s3StorageResolved = false;

  /**
   * R7 (N17): pinning 与 broadcast 语义互斥——broadcast = "所有在线执行器"，
   * pinning = "仅此一个"，同时成立无法调和。抽成独立断言，供 create（请求体
   * 两键齐全）与 update（合并后的实体态）复用，保证消息一致。
   */
  private assertPinBroadcastExclusive(
    executorId?: string | null,
    executeMode?: ExecuteMode,
  ): void {
    if (executorId && executeMode === ExecuteMode.BROADCAST) {
      throw new BadRequestException(
        "executorId (pinned executor) is mutually exclusive with executeMode=broadcast",
      );
    }
  }

  private normalizeTaskDto<T extends CreateTaskDto | UpdateTaskDto>(dto: T): T {
    const normalized = { ...dto } as T & {
      timeout?: number;
      timeoutSeconds?: number;
      timeoutAction?: string | null;
      timeoutWarnRatio?: number | null;
    };
    if (normalized.timeoutSeconds !== undefined) {
      normalized.timeout = normalized.timeoutSeconds;
      delete normalized.timeoutSeconds;
    }
    // CORE-04: 超时策略字段在持久化边界归一化。timeoutAction 缺省 undefined
    // = PATCH 保留旧值（不写键）；显式 null = 回到缺省 kill（归一化为 null
    // 落库，读路径 normalizeTimeoutAction 再兜底）。timeoutWarnRatio 非
    // 0-90 整数一律归 null（未启用）——DTO @Min/@Max 之外的运行态防线。
    if (normalized.timeoutAction !== undefined) {
      normalized.timeoutAction =
        normalized.timeoutAction === null
          ? null
          : normalizeTimeoutAction(normalized.timeoutAction);
    }
    if (normalized.timeoutWarnRatio !== undefined) {
      normalized.timeoutWarnRatio = normalizeTimeoutWarnRatio(
        normalized.timeoutWarnRatio,
      );
    }
    // W-21: requirements reach `uv pip install` / `npm install` as argv on
    // the executor. Reject option-shaped specs (`--index-url http://evil`
    // would hijack the package index) and blank entries here, mirroring the
    // executors' own guards so a bad spec 400s at create instead of burning a
    // queued execution. Trim normalizes harmless surrounding whitespace.
    if (Array.isArray(normalized.requirements)) {
      normalized.requirements = normalized.requirements.map((raw) => {
        const spec = typeof raw === "string" ? raw.trim() : raw;
        if (typeof spec !== "string" || spec.length === 0) {
          throw new BadRequestException("Task requirement must be non-empty");
        }
        if (spec.startsWith("-")) {
          throw new BadRequestException(
            `Invalid task requirement (options are not allowed): ${spec}`,
          );
        }
        return spec;
      });
    }
    // R6: 请求体自身两键齐全时直接拒绝（create 路径覆盖此洞）。update 的
    // PATCH 合并路径由 assertPinBroadcastExclusive 在合并后实体态兜底（N17）。
    this.assertPinBroadcastExclusive(
      normalized.executorId,
      normalized.executeMode,
    );
    return normalized as T;
  }

  private inferFailureReason(
    errorMessage?: string | null,
    logs?: string | null,
    exitCode?: number,
  ): ExecutionFailureReason {
    const text = [errorMessage, logs].filter(Boolean).join("\n").toLowerCase();

    if (/timeout|timed out|etimedout|execution timed/.test(text)) {
      return ExecutionFailureReason.TIMEOUT;
    }
    if (
      /executor.*(offline|unavailable)|no available executor|econnrefused|enotfound|network error|socket hang up/.test(
        text,
      )
    ) {
      return ExecutionFailureReason.EXECUTOR_OFFLINE;
    }
    if (
      /git clone|package fetch|pull package|download package|npm install|pip install|requirements|dependency|module not found|cannot find module/.test(
        text,
      )
    ) {
      return ExecutionFailureReason.PACKAGE_FETCH_FAILED;
    }
    if (typeof exitCode === "number" && exitCode !== 0) {
      return ExecutionFailureReason.SCRIPT_ERROR;
    }
    if (
      /traceback|syntaxerror|referenceerror|typeerror|uncaught|exception|command failed|exit code/.test(
        text,
      )
    ) {
      return ExecutionFailureReason.SCRIPT_ERROR;
    }
    return ExecutionFailureReason.UNKNOWN;
  }

  constructor(
    @InjectRepository(Task) private taskRepo: Repository<Task>,
    @InjectRepository(TaskExecution)
    private execRepo: Repository<TaskExecution>,
    @InjectRepository(ExecutionLogLine)
    private logLineRepo: Repository<ExecutionLogLine>,
    @InjectRepository(TaskVersion) private versionRepo: Repository<TaskVersion>,
    @InjectQueue("task-queue") private taskQueue: Queue,
    private dataSource: DataSource,
    @Inject(forwardRef(() => SchedulerService))
    private schedulerService: SchedulerService,
    private aiService: AiService,
    // ARCH-30: AI 分析服务化封装（手动 analyzeExecution 路径消费）
    private aiAnalysisService: AiAnalysisService,
    private configService: ConfigService,
    // 跨 task↔executor 模块环的 provider 注入：模块级 forwardRef 配套
    // （executor.module 注释）。
    @Inject(forwardRef(() => ExecutorService))
    private executorService: ExecutorService,
    // ARCH-21: 事件总线（@Global 模块恒提供）。@Optional 仅为既有单测装配
    // 兼容（provider 缺失 → null → 终态事件静默不发，主链行为不变），
    // 先例同 001/OBS-04 的 reportRepo。
    @Optional()
    private readonly eventBus: DomainEventBus | null,
    // ARCH-21: AuditService 注入已随 notifyCallbackFailure 迁出删除——其在
    // 本服务的唯一消费方（NOTIFICATION_FAILED 审计兜底）现由
    // notification 模块 ExecutionEventsListener 持有。
    // SEC-02: secrets 落库加密/读脱敏（providers 由 TaskModule 提供）
    private secretsCrypto: SecretsCryptoService,
    // OBS-01: OpenTelemetry 追踪（@Global 恒提供）。@Optional 仅为既有单测
    // 装配兼容（provider 缺失 → null → 全方法短路，与 disabled 等价），
    // 先例同 eventBus/reportRepo。
    @Optional()
    private tracing: TracingService | null,
    // OBS-04: execution_reports 读侧（只读——写方在 MetricsService）。
    // @Optional：既有单测模块（task.service.spec / s3 integration spec）
    // 未提供该仓储时回退 null，零破坏——report 端点在缺失时返回 null 行。
    @Optional()
    @InjectRepository(ExecutionReport)
    private reportRepo: Repository<ExecutionReport> | null,
    // AUTH-02: 项目级角色（ProjectAccessService）。@Optional 同上述先例——
    // provider 缺失（单测装配）时整体旁路，写面判定逐字节保持既有行为。
    @Optional()
    private projectAccess: ProjectAccessService | null,
  ) {}

  /**
   * NF-03（任务级 RBAC 预研）：写面属主守卫。三态语义：
   * - ADMIN 全量放行；
   * - 行 ownerUserId 为 NULL（无主/存量行）→ 仅 ADMIN（保守默认，方向安全）；
   * - ownerUserId 非 NULL 且 ≠ 当前用户 → 403（悬垂 id 同样按非本人处理）。
   * 只拦 update/remove 等配置写面；trigger 等执行类写面不在预研范围
   * （见 NF-03 认领行缩水声明）。user 为 null（API-Key 主体等）按非 ADMIN。
   */
  assertCanWrite(
    row: { ownerUserId: number | null },
    user: { id: number; role: UserRole } | null | undefined,
  ): void {
    if (user?.role === UserRole.ADMIN) return;
    if (row.ownerUserId === null) {
      throw new ForbiddenException(
        "This task has no owner (legacy row); only admins can modify it",
      );
    }
    if (row.ownerUserId !== user?.id) {
      throw new ForbiddenException("You do not own this task");
    }
  }

  /**
   * AUTH-02: 在 NF-03 属主守卫之上叠加**项目角色放行**（只增放行、不收紧）。
   *
   * 项目 editor/admin 可写该项目内的任务——含他人创建的行与无主（存量）行，
   * 这是团队协作形态的真实缺口（此前只有 ADMIN 与属主本人能改）。viewer 与
   * 非成员维持「属主守卫」原判定，绝不因本方法新增任何拒绝。
   * ProjectAccessService 缺席（单测/未接线）时与 assertCanWrite 完全等价。
   */
  async assertCanWriteProjectAware(
    row: { ownerUserId: number | null; projectId?: string | null },
    user: { id: number; role: UserRole } | null | undefined,
  ): Promise<void> {
    try {
      this.assertCanWrite(row, user);
      return;
    } catch (e: unknown) {
      if (!(e instanceof ForbiddenException)) throw e;
      if (!this.projectAccess || !user?.id) throw e;
      const allowed = await this.projectAccess.hasProjectRole(
        user.id,
        row.projectId ?? null,
        "editor",
      );
      if (!allowed) throw e;
    }
  }

  /**
   * AUTH-02: 执行类写面（trigger/pause/resume）归属。
   *
   * 只做**显式只读**一种拒绝——项目 viewer 不得触发/暂停/恢复（viewer 的
   * 定义即只读，这是角色模型唯一的硬约束点）；其余主体（ADMIN / 属主 /
   * 非成员 / 未配置成员关系的场景）**维持既有行为**，不引入任何新的拒绝面
   * （既有「任何登录用户可 trigger」的宽松语义需产品拍板后才收紧，见
   * ADR-013 已知缺口）。
   */
  async assertCanOperate(
    row: { ownerUserId: number | null; projectId?: string | null },
    user: { id: number; role: UserRole } | null | undefined,
  ): Promise<void> {
    if (!this.projectAccess || !user?.id) return;
    if (user.role === UserRole.ADMIN) return;
    const role = await this.projectAccess.resolveRole(
      user.id,
      row.projectId ?? null,
    );
    if (role === "viewer") {
      throw new ForbiddenException(
        "Your role in this project is viewer (read-only); triggering or changing schedule state requires the editor role",
      );
    }
  }

  async create(dto: CreateTaskDto, user?: { id: number } | null) {
    if (dto.dependencies && Object.keys(dto.dependencies).length > 0) {
      await this.checkCircularDependency(dto.id, dto.dependencies);
    }
    const normalized = this.normalizeTaskDto(dto);
    // SEC-NEW-2 对齐（W-21 后续）：git 源在**任务写面**即校验。executor 派发时只放行
    // https?://|git@|ssh:// 且拒绝 loopback/私有网段（execute.ts:363-376，python 侧对等）
    // ——此前 admin 不做同类校验，导致「任务创建成功、派发才 400」的两端不一致。
    // 复用部署链同一实现（application.service 亦用 assertSafeGitRepoUrl）。
    if (normalized.gitRepo) {
      await assertSafeGitRepoUrl(normalized.gitRepo);
    }
    // NF-03: 创建即落 owner（含 ADMIN 创建——可追溯，也为 AUTH-02 读面预铺）。
    // normalized 是 CreateTaskDto 形态，ownerUserId 在实体列上——save 前并入。
    (normalized as unknown as Record<string, unknown>)["ownerUserId"] =
      user?.id ?? null;
    // SEC-02: secrets 在持久化边界统一加密（key 未配置时降级明文并 warn）
    normalized.secrets = this.secretsCrypto.encryptForStorage(
      normalized.secrets,
    ) as Record<string, unknown> | null | undefined;
    // R6: 客户端自带 id 时先查重——软删除行对普通 findOne 不可见但同样
    // 占用主键，必须 withDeleted；预检查之外，save 处仍兜底捕获 23505
    //（覆盖并发创建的 TOCTOU 窗口），两者都返回 409 而非裸 500。
    if (normalized.id) {
      const existing = await this.taskRepo.findOne({
        where: { id: normalized.id },
        withDeleted: true,
      });
      if (existing) {
        throw new ConflictException(
          `Task with id "${normalized.id}" already exists`,
        );
      }
    }
    try {
      const saved = await this.taskRepo.save(this.taskRepo.create(normalized));
      await this.saveVersion(saved.id, undefined, undefined, saved);
      return saved;
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new ConflictException(
          normalized.id
            ? `Task with id "${normalized.id}" already exists`
            : "Task conflicts with an existing record",
        );
      }
      throw err;
    }
  }

  private async checkCircularDependency(
    taskId: string,
    dependencies: Record<string, string>,
  ): Promise<void> {
    const visited = new Set<string>();
    const currentPath = new Set<string>();

    const dependencyIds = Object.values(dependencies);

    for (const depId of dependencyIds) {
      if (depId === taskId) {
        throw new BadRequestException(
          `Circular dependency detected: task ${taskId} depends on itself`,
        );
      }
    }

    await this.detectCycle(taskId, dependencyIds, visited, currentPath);
  }

  private async detectCycle(
    taskId: string,
    dependencyIds: string[],
    visited: Set<string>,
    currentPath: Set<string>,
    depth = 0,
  ): Promise<void> {
    // TASK-007: 递归深度上限——防止深层依赖链的串行 N+1 查询 DoS。
    if (depth > MAX_DEPENDENCY_DEPTH) {
      throw new BadRequestException("dependency chain too deep");
    }

    for (const depId of dependencyIds) {
      if (depId === taskId) {
        throw new BadRequestException(
          `Circular dependency detected: task ${taskId} has a cyclic dependency chain`,
        );
      }

      if (currentPath.has(depId)) {
        throw new BadRequestException(
          `Circular dependency detected: task ${taskId} -> ... -> ${depId} (cycle)`,
        );
      }

      if (visited.has(depId)) {
        continue;
      }

      // TASK-007: 已访问节点集合上限——超宽扇出的依赖图同样拒绝，
      // 上限保证单次校验的数据库查询次数有硬性边界。
      if (visited.size > MAX_DEPENDENCY_DEPTH) {
        throw new BadRequestException("dependency chain too deep");
      }

      visited.add(depId);
      currentPath.add(depId);

      try {
        const depTask = await this.taskRepo.findOne({ where: { id: depId } });
        if (
          depTask &&
          depTask.dependencies &&
          Object.keys(depTask.dependencies).length > 0
        ) {
          // Use Object.values to get the actual dependency task IDs (not the key names)
          const childDependencies = Object.values(depTask.dependencies);
          await this.detectCycle(
            taskId,
            childDependencies,
            visited,
            currentPath,
            depth + 1,
          );
        }
      } finally {
        currentPath.delete(depId);
      }
    }
  }

  async findAll(p: ListTasksQueryDto) {
    const where: Record<string, unknown> = { status: Not(TaskStatus.DELETED) };
    if (p.status) where.status = p.status as TaskStatus;
    if (p.name) where.name = ILike(`%${p.name}%`);
    if (p.runtime) where.runtime = p.runtime;
    if (p.applicationId) where.applicationId = p.applicationId;
    // AUTH-01: projectId 过滤——"default" 映射为默认项目（未分配 NULL 行
    // 一起归入默认项目视图，Or 处理）；具体 uuid 则精确匹配。
    if (p.projectId) {
      if (p.projectId === "default") {
        where.projectId = Or(IsNull(), In([DEFAULT_PROJECT_ID]));
      } else {
        where.projectId = p.projectId;
      }
    }
    const [list, total] = await this.taskRepo.findAndCount({
      where,
      skip: (p.page - 1) * p.pageSize,
      take: p.pageSize,
      order: { createdAt: "DESC" },
    });
    // SEC-02: 列表响应 secrets 永久脱敏（叶子值回 ******，密文不外泄）
    list.forEach((t) => {
      t.secrets = this.secretsCrypto.maskForResponse(t.secrets) as
        Record<string, unknown> | null | undefined;
    });
    return paginate(list, total, p.page, p.pageSize);
  }

  async findOne(id: string) {
    const t = await this.taskRepo.findOne({
      where: { id, status: Not(TaskStatus.DELETED) },
    });
    if (!t) throw new NotFoundException("Task not found");
    // SEC-02: 详情响应同样脱敏；写路径（update）走独立归一化，不受影响
    t.secrets = this.secretsCrypto.maskForResponse(t.secrets) as
      Record<string, unknown> | null | undefined;
    return t;
  }

  async update(
    id: string,
    dto: UpdateTaskDto,
    user?: { id: number; role: UserRole } | null,
  ) {
    const t = await this.findOne(id);
    // NF-03: 写面属主守卫（ADMIN 全量/属主自己/无主仅 ADMIN）
    await this.assertCanWriteProjectAware(t, user);
    const normalized = this.normalizeTaskDto(dto);
    // 同 create：PATCH 显式带 gitRepo 时即校验（缺省 = 保留旧值，不重复校验既有列）
    if (normalized.gitRepo) {
      await assertSafeGitRepoUrl(normalized.gitRepo);
    }
    // SEC-02: PATCH 语义——secrets 缺省 = 保留旧值（不触碰既有列）；
    // 显式 null / {} = 清空/替换。归一化在脱敏副本上做（findOne 已脱敏，
    // DTO 未带 secrets 时不能把脱敏值当新值再加密一层）。
    if (normalized.secrets !== undefined) {
      normalized.secrets = this.secretsCrypto.encryptForStorage(
        normalized.secrets,
      ) as Record<string, unknown> | null | undefined;
      t.secrets = normalized.secrets as Record<string, unknown> | null;
    }
    delete normalized.secrets;
    // NF-04: 亲和/反亲和为可空列，PATCH null 清除语义直接依赖 Object.assign
    // 的透传（显式 null 覆盖旧数组 → 列落 NULL = 无约束）——normalizeTaskDto
    // 不触碰这两个键；undefined（缺省）不会出现在合并结果上，旧值自然保留。
    const updated = Object.assign(t, normalized);
    // R7 (N17): PATCH 合并路径的互斥校验必须看合并后的实体态——请求体只带
    // executorId（已有任务 executeMode=broadcast）或只带 executeMode=broadcast
    // （已有任务已 pin）时，normalizeTaskDto 看不到另一半，会漏判产生
    // "broadcast+已 pin" 非法状态（dispatchBroadcast 不读 executorId，pinning
    // 被静默丢弃）。save 前兜底，消息与 create 路径一致。
    this.assertPinBroadcastExclusive(updated.executorId, updated.executeMode);
    const saved = await this.taskRepo.save(updated);
    await this.saveVersion(saved.id, undefined, undefined, saved);
    // Stop old schedule, then re-register based on new status without waiting for reload
    this.schedulerService.stop(id);
    if (saved.status === TaskStatus.ACTIVE) {
      await this.schedulerService.scheduleOne(saved);
    }
    return saved;
  }

  async updateGlue(id: string, source: string, language?: string) {
    const t = await this.findOne(id);
    t.glueSource = source;
    if (language) t.glueLanguage = language;
    const saved = await this.taskRepo.save(t);
    await this.saveVersion(saved.id, undefined, undefined, saved);
    return saved;
  }

  async remove(id: string, user?: { id: number; role: UserRole } | null) {
    const t = await this.findOne(id);
    // NF-03: 写面属主守卫（同 update）
    await this.assertCanWriteProjectAware(t, user);
    // Stop schedule immediately without waiting for reload
    this.schedulerService.stop(id);
    t.status = TaskStatus.DELETED;
    await this.taskRepo.save(t);
    // DB-001: 同步写入 TypeORM 软删除列，此后 Repository find/findOne
    // 自动排除该行；status='deleted' 保留以兼容 raw query 消费方。
    await this.taskRepo.softDelete(id);
    return { deleted: true };
  }

  async pause(id: string, user?: { id: number; role: UserRole } | null) {
    const t = await this.findOne(id);
    // AUTH-02: 执行类写面归属（viewer 只读；其余维持既有行为）
    await this.assertCanOperate(t, user);
    if (t.status === TaskStatus.PAUSED) {
      throw new BadRequestException("Task is already paused");
    }
    this.schedulerService.stop(id);
    t.status = TaskStatus.PAUSED;
    return this.taskRepo.save(t);
  }

  async resume(id: string, user?: { id: number; role: UserRole } | null) {
    const t = await this.findOne(id);
    // AUTH-02: 执行类写面归属（viewer 只读；其余维持既有行为）
    await this.assertCanOperate(t, user);
    if (t.status !== TaskStatus.PAUSED) {
      throw new BadRequestException("Task is not paused and cannot be resumed");
    }
    t.status = TaskStatus.ACTIVE;
    await this.taskRepo.save(t);
    await this.schedulerService.scheduleOne(t);
    return t;
  }

  async trigger(
    id: string,
    dto: TriggerTaskDto,
    user?: { id: number; role: UserRole } | null,
  ) {
    const task = await this.findOne(id);
    // AUTH-02: 执行类写面归属（viewer 只读；其余维持既有行为）
    await this.assertCanOperate(task, user);
    // OBS-01: 追踪开启时生成 trace 根，traceId 落库（null=追踪未开启）。
    const traceparent = this.tracing?.startTrace() ?? null;
    const traceId = this.tracing?.extractContext(traceparent) ?? null;
    const endSpan = this.tracing?.startSpan(traceId, "task.trigger", {
      taskId: task.id,
      taskName: task.name,
    });
    const exec = await this.dataSource.transaction(async (manager) => {
      return manager.save(
        manager.create(TaskExecution, {
          taskId: task.id,
          taskName: task.name,
          status: ExecutionStatus.PENDING,
          params: dto.params ?? task.params,
          triggerType: "manual",
          taskVersion: task.currentVersion,
          traceId: this.tracing?.isValidTraceId(traceId) ? traceId : null,
        }),
      );
    });
    try {
      await this.taskQueue.add(
        "execute",
        { executionId: exec.id },
        {
          // Bull requires attempts >= 1; guard against maxRetry=0
          attempts: Math.max(1, task.maxRetry ?? 1),
          // CORE-02: delay 预乘指数基座并加 ±20% 抖动（首次尝试 attempt=1）。
          // 返回 0（retryDelay<=0）保持既有 backoff: undefined 不延迟语义。
          backoff:
            task.retryDelay > 0
              ? {
                  type: "exponential",
                  delay: jitteredRetryDelayMs(task.retryDelay, 1),
                }
              : undefined,
          // N2: unify with scheduler.enqueue — always pass a normalized numeric
          // priority (DB stores the PG string enum; a raw label must never
          // reach BullMQ, which rejects non-integer priorities).
          priority: normalizeTaskPriority(task.priority),
        },
      );
      endSpan?.();
    } catch (err: unknown) {
      // P1: the PENDING row is already committed — without compensation it
      // would hang forever when Redis/the queue is down.
      const message = err instanceof Error ? err.message : String(err);
      endSpan?.(message);
      await this.execRepo.update(exec.id, {
        status: ExecutionStatus.FAILED,
        endTime: new Date(),
        errorMessage: `Failed to enqueue execution: ${message}`,
        failureReason: ExecutionFailureReason.UNKNOWN,
      });
      this.logger.error(`Failed to enqueue execution ${exec.id}: ${message}`);
      throw new Error(`Failed to enqueue execution: ${message}`);
    }
    endSpan?.();
    return exec;
  }

  async getExecutions(taskId: string, p: PaginationDto & { status?: string }) {
    const where: Record<string, unknown> = { taskId };
    if (p.status) where["status"] = p.status;

    const [list, total] = await this.execRepo.findAndCount({
      where,
      skip: (p.page - 1) * p.pageSize,
      take: p.pageSize,
      order: { createdAt: "DESC" },
    });
    return paginate(list, total, p.page, p.pageSize);
  }

  async getAllExecutions(
    p: PaginationDto & {
      status?: string;
      taskId?: string;
      taskName?: string;
      executorAddress?: string;
      startTime?: string;
      endTime?: string;
    },
  ) {
    // DB-003: 原 getRawAndEntities + getCount 会产生 3 条 SQL（raw 页查询、
    // entities 页查询、count），executions 被全表扫描两次。改为：
    // 1) getManyAndCount：页查询 + count 共 2 条（仅 executions 扫描）；
    // 2) 任务名回填只对缺 taskName 的行做一次 PK IN 批量查询（join 仅在
    //    taskName 过滤时保留用于匹配 t.name）。
    const qb = this.execRepo
      .createQueryBuilder("e")
      .orderBy("e.createdAt", "DESC")
      .skip((p.page - 1) * p.pageSize)
      .take(p.pageSize);

    if (p.status) qb.andWhere("e.status = :status", { status: p.status });
    if (p.taskId) qb.andWhere("e.taskId = :taskId", { taskId: p.taskId });
    if (p.taskName) {
      // taskName 过滤：命中执行行自身的 taskName，或命中 tasks 表名称
      //（保留 join 仅用于此过滤场景）
      qb.leftJoin("tasks", "t", "t.id = e.taskId");
      qb.andWhere("(e.taskName ILIKE :taskName OR t.name ILIKE :taskName)", {
        taskName: `%${p.taskName}%`,
      });
    }
    if (p.executorAddress)
      qb.andWhere("e.executorAddress ILIKE :executorAddress", {
        executorAddress: `%${p.executorAddress}%`,
      });
    if (p.startTime)
      qb.andWhere("e.createdAt >= :startTime", { startTime: p.startTime });
    if (p.endTime)
      qb.andWhere("e.createdAt <= :endTime", { endTime: p.endTime });

    const [list, total] = await qb.getManyAndCount();

    // 一次性批量补齐缺失的 taskName（替代原 leftJoin + raw Map 组装）
    const missingIds = [
      ...new Set(
        list
          .filter((e) => !e.taskName && e.taskId)
          .map((e) => e.taskId as string),
      ),
    ];
    const taskNameMap = new Map<string, string>();
    if (missingIds.length > 0) {
      const tasks = await this.taskRepo.find({
        where: { id: In(missingIds) },
        select: ["id", "name"],
      });
      for (const t of tasks) taskNameMap.set(t.id, t.name);
    }

    const items = list.map((e) => ({
      ...e,
      taskName: e.taskName || taskNameMap.get(e.taskId) || null,
    }));
    return paginate(items, total, p.page, p.pageSize);
  }

  /**
   * AI-powered schedule suggestion.
   * Reads the last 50 executions and asks the LLM to recommend an optimal cron expression.
   */
  async suggestSchedule(taskId: string): Promise<{
    taskId: string;
    currentCron: string | null;
    suggestedCron: string;
    reasoning: string;
    fallback?: boolean;
  }> {
    const task = await this.taskRepo.findOne({ where: { id: taskId } });
    if (!task) throw new NotFoundException(`Task ${taskId} not found`);

    const executions = await this.execRepo.find({
      where: { taskId },
      order: { createdAt: "DESC" },
      take: 50,
    });

    const successCount = executions.filter(
      (e) => e.status === ExecutionStatus.SUCCESS,
    ).length;
    const failCount = executions.filter(
      (e) =>
        e.status === ExecutionStatus.FAILED ||
        e.status === ExecutionStatus.TIMEOUT,
    ).length;
    const durations = executions
      .filter((e) => e.duration != null)
      .map((e) => e.duration!);
    const avgDuration =
      durations.length > 0
        ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length)
        : 0;
    const p95Duration =
      durations.length > 0
        ? durations.sort((a, b) => a - b)[Math.floor(durations.length * 0.95)]
        : 0;

    // Build time-of-day distribution for successes
    const hourCounts: number[] = new Array(24).fill(0);
    executions
      .filter((e) => e.status === ExecutionStatus.SUCCESS)
      .forEach((e) => {
        const h = new Date(e.createdAt).getUTCHours();
        hourCounts[h]++;
      });
    const bestHours = hourCounts
      .map((c, h) => ({ h, c }))
      .sort((a, b) => b.c - a.c)
      .slice(0, 3)
      .map(({ h }) => h);

    const summaryLog = [
      `Task: ${task.name} (${task.id})`,
      `Current cron: ${task.cronExpression || "none"}`,
      `Total executions sampled: ${executions.length}`,
      `Successes: ${successCount}, Failures/Timeouts: ${failCount}`,
      `Avg duration: ${avgDuration}ms, P95 duration: ${p95Duration}ms`,
      `Timeout setting: ${task.timeout || "default"}ms`,
      `Hours with most successes (UTC): ${bestHours.join(", ")}`,
    ].join("\n");
    this.logger.debug(`Schedule optimization sample:\n${summaryLog}`);

    const { suggestedCron, reasoning, fallback } =
      await this.aiService.suggestSchedule(
        task.name,
        task.cronExpression || null,
        {
          total: executions.length,
          successes: successCount,
          failures: failCount,
          avgDurationMs: avgDuration,
          p95DurationMs: p95Duration,
          bestHoursUtc: bestHours,
        },
      );

    return {
      taskId: task.id,
      currentCron: task.cronExpression || null,
      suggestedCron,
      reasoning,
      // AI-002: 透传 fallback 标记，调用方可区分「AI 建议」与「回退到当前值」
      fallback,
    };
  }

  async getExecutionStats(taskId: string) {
    const recent = await this.execRepo.find({
      where: { taskId },
      order: { createdAt: "DESC" },
      take: 20,
    });
    const total = await this.execRepo.count({ where: { taskId } });
    const succeeded = recent.filter(
      (e) => e.status === ExecutionStatus.SUCCESS,
    ).length;
    const successRate =
      recent.length > 0
        ? Math.round((succeeded / recent.length) * 1000) / 10
        : 0;
    const durations = recent
      .filter((e) => e.duration != null)
      .map((e) => e.duration!);
    const avgDuration =
      durations.length > 0
        ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length)
        : 0;
    return {
      recentExecutions: recent,
      successRate,
      avgDuration,
      totalRuns: total,
    };
  }

  async getExecution(id: string, taskId?: string) {
    const e = await this.execRepo.findOne({
      where: taskId ? { id, taskId } : { id },
    });
    if (!e) throw new NotFoundException("Execution not found");
    return e;
  }

  /**
   * OBS-04: 执行报告端点读侧——单次响应合并三类数据，供详情页
   * 「分析报告/时间线」Tab 一次拉取渲染：
   *
   * 1. execution：task_executions 行原样返回（含 createdAt/startTime/endTime/
   *    duration/status/triggerType/executorAddress/aiAnalysis 等时间线与 AI
   *    分析字段——时间线由前端从此行的时间戳列映射，保证与 DB 一致）；
   * 2. timeline：与 mcp-server buildExecutionTimeline 同一语义的三段时刻
   *    （created→started→finished；缺省时刻 at=null，前端显示「—」）；
   * 3. report：metrics.execution_reports 当日聚合行（triggerDay=execution
   *    createdAt 的本地日期）。该表由 MetricsService.generateReport 按"日"
   *    聚合写入，与单次执行无外键关系，故只按日期粗粒度关联；无行时返回
   *    report:null（前端降级渲染——本表写入方是手动触发的 today-report
   *    读取路径，环境里常为空表，缺报告属正常态而非错误）。
   */
  async getExecutionReport(id: string, taskId?: string) {
    const execution = await this.getExecution(id, taskId);
    // execution_reports.triggerDay 是 DATE 列（无时间成分）：把执行的
    // createdAt 截到本地零点做等值匹配，避免时区偏移导致查不到当日行。
    // 仓储未注册（@Optional 回退）时同样返回 null——前端按"无报告"降级。
    let report: ExecutionReport | null = null;
    if (this.reportRepo) {
      const day = new Date(execution.createdAt);
      day.setHours(0, 0, 0, 0);
      report = await this.reportRepo.findOne({
        where: { triggerDay: day },
      });
    }
    return {
      execution,
      timeline: buildExecutionTimeline(execution),
      report: report ?? null,
    };
  }

  /**
   * On-demand AI analysis for an execution.
   * Fetches the task by name, runs analyzeFailure with the execution logs,
   * persists the result, and returns the updated execution.
   */
  async analyzeExecution(execId: string): Promise<TaskExecution> {
    const exec = await this.execRepo.findOne({ where: { id: execId } });
    if (!exec) throw new NotFoundException("Execution not found");
    // Use errorMessage + logs as analysis input; fall back gracefully when logs are empty
    const logContent =
      [exec.errorMessage, exec.logs].filter(Boolean).join("\n") || "(no logs)";
    const task = { name: exec.taskName, runtime: "unknown" };
    // ARCH-30: 走服务化封装（重试 1 次 + 指标 + 永不抛错）；空串结果原样
    // 落库（前端按"无分析"降级渲染），与此前直调 AiService 的空串语义一致。
    exec.aiAnalysis = await this.aiAnalysisService.analyzeFailure(
      task,
      logContent,
    );
    await this.execRepo.save(exec);
    return exec;
  }

  /**
   * Paged execution log fetch.
   *
   * OBS-03: `level`（可选，ERROR/WARN/INFO/DEBUG）为等值过滤：
   * - DB 路径在 SQL 层下推（level = :level），与 fromLine/limit 同一语义；
   * - totalLines / hasMore 按"过滤后"的行集计算——分页元数据必须描述
   *   调用方实际能翻到的行，而不是全量行数（CODE-01 语义在过滤下的自然
   *   延伸）；
   * - level=null（未过滤）时行为与 OBS-03 之前完全一致；
   * - 过滤时 level IS NULL 的行（存量行/推断不到的行 = 未知级别）不返回。
   */
  async getExecutionLogs(
    execId: string,
    fromLine = 0,
    limit = 500,
    level?: string | null,
  ) {
    // Cap limit to prevent accidental memory exhaustion
    const safeLimit = Math.min(Math.max(1, limit), 2000);
    const exec = await this.execRepo.findOne({ where: { id: execId } });
    if (!exec) throw new NotFoundException("Execution not found");
    // LOG-02 + High-6.1: S3-stored logs are streamed line-by-line so we never
    // hold the full decompressed payload in memory; DB rows remain the
    // fallback (and the db-driver path).
    if (exec.logStorage === "s3" && exec.logObjectKey) {
      try {
        const s3 = this.resolveS3Storage();
        if (s3) {
          const stream = await s3.getStream(exec.logObjectKey);
          const result = await paginateLogStream(stream, fromLine, safeLimit, {
            level: level ?? null,
          });
          return result;
        }
      } catch (err: unknown) {
        this.logger.warn(
          `Failed to read S3 logs for execution ${execId} (${err instanceof Error ? err.message : String(err)}) — falling back to DB log lines`,
        );
      }
    }
    // N10: use typed logLineRepo instead of string-based getRepository
    // CODE-01: fetch true total in parallel so pagination metadata is accurate
    // OBS-03: level 过滤在 SQL 层下推（level = :level）；未传 level 时查询
    // 形态与 OBS-03 之前完全一致（行号游标 + 全量 count），存量行为不变。
    const qb = this.logLineRepo
      .createQueryBuilder("l")
      .where("l.executionId = :id", { id: execId });
    if (level) {
      qb.andWhere("l.level = :level", { level });
    } else {
      qb.andWhere("l.lineNumber >= :from", { from: fromLine });
    }
    // OBS-03: level 过滤后行集不再按 lineNumber 连续，行号游标
    // （lineNumber >= from）会让 fromLine += lines.length 的既有客户端翻页
    // 契约产生重复/漏行——过滤模式下 fromLine 语义切换为"过滤后序列的
    // 偏移量"（skip/OFFSET），与 S3 路径的读后过滤分页保持同一语义（见
    // api-reference.md）。未传 level 时绝不触碰 skip（行为不变）。
    const paged = qb
      .orderBy("l.lineNumber", "ASC")
      .select(["l.lineNumber", "l.content"])
      .take(safeLimit);
    const [lines, totalLines] = await Promise.all([
      (level ? paged.skip(fromLine) : paged).getMany(),
      // OBS-03: totalLines 与过滤语义一致——level 过滤时按 level 计数
      // （分页元数据描述的是调用方能翻到的行集），未过滤时保持全量计数。
      level
        ? this.logLineRepo.count({ where: { executionId: execId, level } })
        : this.logLineRepo.count({ where: { executionId: execId } }),
    ]);
    return {
      lines: lines.map((r) => r.content),
      // CODE-01: true total count, not (currentBatch + offset)
      totalLines,
      hasMore: fromLine + lines.length < totalLines,
    };
  }

  /**
   * TASK-008: SSE 日志流并发上限注册表。
   * 每个连接在开始轮询前必须持有槽位；连接结束（正常完成 / abort / 异常）
   * 时释放。两级限制防止大量客户端同时轮询把数据库打垮：
   * - 单 execution 最多 SSE_MAX_STREAMS_PER_EXECUTION 个连接；
   * - 全局最多 SSE_MAX_STREAMS_GLOBAL 个连接。
   */
  private sseStreamsPerExecution = new Map<string, number>();
  private sseStreamsGlobal = 0;

  private static readonly SSE_MAX_PER_EXECUTION_DEFAULT = 4;
  private static readonly SSE_MAX_GLOBAL_DEFAULT = 64;

  private get sseMaxPerExecution(): number {
    const raw = this.configService.get<number | string>(
      "sse.maxStreamsPerExecution",
    );
    const n = typeof raw === "string" ? parseInt(raw, 10) : raw;
    return Number.isFinite(n) && n > 0
      ? n
      : TaskService.SSE_MAX_PER_EXECUTION_DEFAULT;
  }

  private get sseMaxGlobal(): number {
    const raw = this.configService.get<number | string>("sse.maxStreamsGlobal");
    const n = typeof raw === "string" ? parseInt(raw, 10) : raw;
    return Number.isFinite(n) && n > 0 ? n : TaskService.SSE_MAX_GLOBAL_DEFAULT;
  }

  /** 尝试为 execId 占用一个 SSE 流槽位；超限抛 ServiceUnavailableException。 */
  acquireSseSlot(execId: string): () => void {
    const perExec = this.sseMaxPerExecution;
    const global = this.sseMaxGlobal;
    const currentForExec = this.sseStreamsPerExecution.get(execId) ?? 0;

    if (currentForExec >= perExec) {
      // 可观测性补齐：并发拒绝计数（autoflow_sse_streams_rejected_total）——
      // 只在超限抛错路径记录，成功占用不计数。
      recordRuntime("autoflow_sse_streams_rejected_total");
      throw new ServiceUnavailableException(
        `Too many concurrent log streams for execution ${execId} (max ${perExec})`,
      );
    }
    if (this.sseStreamsGlobal >= global) {
      recordRuntime("autoflow_sse_streams_rejected_total");
      throw new ServiceUnavailableException(
        `Too many concurrent log streams server-wide (max ${global})`,
      );
    }

    this.sseStreamsPerExecution.set(execId, currentForExec + 1);
    this.sseStreamsGlobal++;
    // BUG-05：活跃流 gauge（瞬时值）——占用/释放两点同步写，渲染侧
    // PrometheusMetricsService 读快照 set() 绝对值。limit 一并透出，
    // 抓取方可直接算占用率 active/limit。
    setRuntimeGauge("autoflow_sse_streams_active", this.sseStreamsGlobal);
    setRuntimeGauge("autoflow_sse_streams_limit", global);

    let released = false;
    return () => {
      if (released) return;
      released = true;
      const n = (this.sseStreamsPerExecution.get(execId) ?? 1) - 1;
      if (n <= 0) this.sseStreamsPerExecution.delete(execId);
      else this.sseStreamsPerExecution.set(execId, n);
      this.sseStreamsGlobal = Math.max(0, this.sseStreamsGlobal - 1);
      setRuntimeGauge("autoflow_sse_streams_active", this.sseStreamsGlobal);
    };
  }

  /**
   * SSE log streaming: polls DB for new log lines while execution is running,
   * then flushes remaining lines and sends [DONE] when execution finishes.
   * Caller is responsible for writing SSE headers and closing the response.
   *
   * TASK-008: 受 acquireSseSlot 两级并发上限保护；无论正常结束、abort
   * 还是抛异常，finally 都会释放槽位。
   */
  async streamExecutionLogs(
    execId: string,
    send: (line: string) => void,
    done: () => void,
    signal: AbortSignal,
    preAcquiredSlot?: () => void,
    // QA3: raw-socket sink for SSE comment frames. The controller's `send`
    // wraps content in `data:` frames; the idle heartbeat must bypass that
    // wrapper so EventSource clients ignore the frame per the SSE spec.
    ping?: () => void,
  ): Promise<void> {
    // TASK-008: 控制器通常会在写出 SSE 响应头之前预先占用槽位
    // （preAcquiredSlot），以便超限时能返回真正的 503；未传入时在此补占。
    const releaseSlot = preAcquiredSlot ?? this.acquireSseSlot(execId);
    let nextLine = 0;
    let s3FetchFailed = false;
    const POLL_INTERVAL = 1000; // ms
    const MAX_RUNTIME = 30 * 60 * 1000; // 30 min safety cap
    // QA3: nginx proxy_read_timeout（默认 60s）会掐断空闲的 SSE 流——S3 存储
    // 的执行在到达终态前可能整分钟无任何新行。空闲超过 15s 时写一条注释帧
    // （": ping\n\n"）：SSE 规范要求客户端忽略注释行，因此 admin-web 的
    // EventSource 解析不受影响，但反向代理会把连接视为活跃。
    const IDLE_PING_INTERVAL = 15_000; // ms
    let lastWriteAt = Date.now();
    const write = (line: string) => {
      lastWriteAt = Date.now();
      send(line);
    };
    const start = Date.now();
    const TERMINAL_STATUSES = [
      ExecutionStatus.SUCCESS,
      ExecutionStatus.FAILED,
      ExecutionStatus.TIMEOUT,
      "killed",
      "cancelled",
    ] as string[];

    const flush = async (): Promise<boolean> => {
      // Returns true when execution is terminal and no more lines pending
      const exec = await this.execRepo.findOne({ where: { id: execId } });
      if (!exec) return true;

      // LOG-02: S3 objects are uploaded once at callback time, so their lines
      // become readable only after the execution reaches a terminal state;
      // stream whatever has not been sent yet, then stop.
      if (exec.logStorage === "s3" && exec.logObjectKey) {
        const terminal = TERMINAL_STATUSES.includes(exec.status);
        if (terminal && !s3FetchFailed) {
          try {
            const s3 = this.resolveS3Storage();
            if (s3) {
              const all = (await s3.get(exec.logObjectKey)).split("\n");
              for (const line of all.slice(nextLine)) {
                write(line);
              }
              nextLine = all.length;
            }
          } catch (err: unknown) {
            s3FetchFailed = true;
            this.logger.warn(
              `Failed to stream S3 logs for execution ${execId} (${err instanceof Error ? err.message : String(err)}) — stopping S3 streaming`,
            );
          }
        }
        return terminal;
      }

      const lines = await this.logLineRepo
        .createQueryBuilder("l")
        .where("l.executionId = :id", { id: execId })
        .andWhere("l.lineNumber >= :from", { from: nextLine })
        .orderBy("l.lineNumber", "ASC")
        .select(["l.lineNumber", "l.content"])
        .getMany();

      for (const row of lines) {
        write(row.content);
        nextLine = row.lineNumber + 1;
      }

      const terminal = [
        ExecutionStatus.SUCCESS,
        ExecutionStatus.FAILED,
        ExecutionStatus.TIMEOUT,
        "killed",
        "cancelled",
      ] as string[];
      return terminal.includes(exec.status);
    };

    // Poll until done or aborted
    try {
      while (!signal.aborted && Date.now() - start < MAX_RUNTIME) {
        const finished = await flush();
        if (finished) break;
        // QA3: idle heartbeat — checked inline in the polling loop instead of
        // via a separate timer, so when the connection closes (signal aborts)
        // the existing loop-exit path below tears the whole thing down with
        // no extra handle left to clean up.
        if (ping && Date.now() - lastWriteAt >= IDLE_PING_INTERVAL) {
          ping();
          lastWriteAt = Date.now();
        }
        await new Promise<void>((resolve) => {
          const t = setTimeout(resolve, POLL_INTERVAL);
          signal.addEventListener(
            "abort",
            () => {
              clearTimeout(t);
              resolve();
            },
            { once: true },
          );
        });
      }

      // Final flush after terminal state
      if (!signal.aborted) {
        await flush();
      }
      done();
    } finally {
      // TASK-008: 连接关闭/异常时必须归还槽位，否则计数泄漏会逐渐耗尽上限
      releaseSlot();
    }
  }

  async rollback(
    id: string,
    dto: { gitCommit: string; params?: Record<string, any> },
  ) {
    const task = await this.findOne(id);
    const prevCommit = task.gitCommit;

    const exec = await this.dataSource.transaction(async (manager) => {
      // Update task gitCommit
      task.gitCommit = dto.gitCommit;
      await manager.save(Task, task);

      // Create execution record
      return manager.save(
        manager.create(TaskExecution, {
          taskId: task.id,
          taskName: task.name,
          status: ExecutionStatus.PENDING,
          params: dto.params ?? task.params,
          triggerType: "rollback",
          taskVersion: dto.gitCommit,
        }),
      );
    });

    try {
      await this.taskQueue.add(
        "execute",
        { executionId: exec.id },
        {
          // Bull requires attempts >= 1; guard against maxRetry=0
          attempts: Math.max(1, task.maxRetry ?? 1),
          // CORE-02: delay 预乘指数基座并加 ±20% 抖动（首次尝试 attempt=1）。
          backoff:
            task.retryDelay > 0
              ? {
                  type: "exponential",
                  delay: jitteredRetryDelayMs(task.retryDelay, 1),
                }
              : undefined,
          // N2: normalized numeric priority (see trigger()).
          priority: normalizeTaskPriority(task.priority),
        },
      );
    } catch (err: unknown) {
      // P1: compensate the committed PENDING row so it cannot hang forever
      const message = err instanceof Error ? err.message : String(err);
      await this.execRepo.update(exec.id, {
        status: ExecutionStatus.FAILED,
        endTime: new Date(),
        errorMessage: `Failed to enqueue execution: ${message}`,
        failureReason: ExecutionFailureReason.UNKNOWN,
      });
      this.logger.error(`Failed to enqueue execution ${exec.id}: ${message}`);
      throw new Error(`Failed to enqueue execution: ${message}`);
    }
    await this.saveVersion(task.id, undefined, undefined, task);
    // N11: re-schedule so active cron/fixed-rate tasks pick up the new commit immediately
    if (task.status === TaskStatus.ACTIVE) {
      await this.schedulerService.scheduleOne(task);
    }
    return {
      execution: exec,
      rolledBackFrom: prevCommit,
      rolledBackTo: dto.gitCommit,
    };
  }

  private async releaseExecutorSlot(address?: string | null): Promise<void> {
    if (!address) return;
    await this.dataSource
      .createQueryBuilder()
      .update("executors")
      .set({ runningTaskCount: () => 'GREATEST("runningTaskCount" - 1, 0)' })
      .where("address = :addr", { addr: address })
      .execute();
  }

  /**
   * R4-P0: check and trigger tasks that depend on the completed task.
   * Invoked from handleCallback on the unique SUCCESS-transition winner path
   * (moved from TaskProcessor, where the exec.status === SUCCESS condition
   * could never be true). Best-effort: failures are logged, never propagated
   * to the callback result — the execution itself is already terminal.
   *
   * R4-P3: 下游触发前先做短窗 DB claim——两个上游依赖几乎同时成功时，
   * 两个回调的 checkDependencies 都可能读到"全部依赖已满足"的快照并各自
   * 触发下游；条件 UPDATE 的行级锁串行化保证只有一个赢家真正 trigger。
   */
  private async triggerDependentTasks(completedTaskId: string) {
    try {
      // Find all tasks that have any dependencies set, then filter in-process.
      // Using application-layer filtering avoids JSONB-specific SQL that breaks
      // on non-PostgreSQL engines and is simpler to reason about.
      const allTasksWithDeps = await this.taskRepo
        .createQueryBuilder("t")
        .where("t.dependencies IS NOT NULL")
        .getMany();

      // Keep only tasks that list completedTaskId as one of their dependency values
      const dependentTasks = allTasksWithDeps.filter(
        (t) =>
          t.dependencies &&
          Object.values(t.dependencies).includes(completedTaskId),
      );

      for (const task of dependentTasks) {
        // Check if all dependencies are satisfied
        const canTrigger = await this.checkDependencies(task);
        if (!canTrigger) continue;

        // R4-P3: short-window DB claim — exactly one concurrent fan-out wins.
        const claimed = await this.claimDependencyTrigger(task.id);
        if (!claimed) {
          this.logger.log(
            `Dependency trigger for task ${task.id} claimed by a concurrent fan-out within the dedup window, skip`,
          );
          continue;
        }
        this.logger.log(
          `All dependencies satisfied for task ${task.id}, triggering`,
        );
        await this.trigger(task.id, {});
      }
    } catch (err) {
      this.logger.error(
        `Failed to trigger dependent tasks: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * R4-P3: 依赖扇出的短窗 DB claim（参考 scheduler.service claimTaskTrigger
   * 的条件 UPDATE 思路）：仅当 tasks.lastTriggerTime 在去重窗口之外（或为
   * NULL）时才允许本调用推进它并获得触发权；affected=0 表示窗口内已有
   * 并发赢家（另一个 fan-out、或紧邻的一次调度触发），本次跳过。
   *
   * 权衡（选 lastTriggerTime 而非新增列的最小侵入方案）：
   * - 免去新列 + 迁移；复用 scheduler 已在写的列。
   * - 副作用 1：调度成功触发也会写 lastTriggerTime（scheduler.enqueue），
   *   因此"依赖满足"前的 DEPENDENCY_TRIGGER_CLAIM_WINDOW_MS 内若有调度
   *   触发，本次依赖触发会被吸收（视作合并去重）。窗口只有 10s，且语义
   *   上等价于"下游刚跑过就不重复跑"，可接受。
   * - 副作用 2：依赖触发会推进 lastTriggerTime，使 checkMisfires 的缺口
   *   从最近一次依赖触发起算——方向安全（更不容易误报 misfire）。
   * - 不加 status 门：与既有行为一致（PAUSED 下游当前也会被依赖触发），
   *   本方法只负责去重，不改变可触发性。
   */
  private async claimDependencyTrigger(taskId: string): Promise<boolean> {
    const windowStart = new Date(
      Date.now() - DEPENDENCY_TRIGGER_CLAIM_WINDOW_MS,
    );
    const result = await this.taskRepo
      .createQueryBuilder()
      .update(Task)
      .set({ lastTriggerTime: new Date() })
      .where(
        '"id" = :id AND ("lastTriggerTime" IS NULL OR "lastTriggerTime" < :windowStart)',
        { id: taskId, windowStart },
      )
      .execute();
    return (result?.affected ?? 0) > 0;
  }

  /**
   * Check if all dependencies of a task have completed successfully.
   * R4-P3: 主查询补 take 上限（MAX_DEPENDENCY_EXECUTION_SCAN）避免把依赖
   * 任务的全量历史拉进内存；若某依赖的最新执行被截断挤出窗口，用按依赖
   * 的定向查询（隐式 LIMIT 1）兜底，保证判定不被截断破坏。
   */
  private async checkDependencies(task: Task): Promise<boolean> {
    if (!task.dependencies || Object.keys(task.dependencies).length === 0) {
      return true;
    }

    const dependencyIds = Object.values(task.dependencies);
    if (dependencyIds.length === 0) return true;

    const recentExecutions = await this.execRepo.find({
      where: { taskId: In(dependencyIds as string[]) },
      order: { createdAt: "DESC" },
      take: MAX_DEPENDENCY_EXECUTION_SCAN,
    });

    // Group by taskId and get the most recent execution for each
    const latestByTask = new Map<string, TaskExecution>();
    for (const exec of recentExecutions) {
      if (!latestByTask.has(exec.taskId)) {
        latestByTask.set(exec.taskId, exec);
      }
    }

    // Check if all dependencies have successful executions
    for (const depId of dependencyIds) {
      let latestExec = latestByTask.get(depId as string);
      if (!latestExec) {
        // take 截断兜底：该依赖有历史但未落在本窗口内（或从未运行过），
        // 定向补查一次；仍为空则视作依赖未满足（保持原语义）。
        latestExec = await this.execRepo.findOne({
          where: { taskId: depId as string },
          order: { createdAt: "DESC" },
        });
        if (latestExec) {
          latestByTask.set(depId as string, latestExec);
        }
      }
      if (!latestExec || latestExec.status !== ExecutionStatus.SUCCESS) {
        return false;
      }
    }

    return true;
  }

  /**
   * Persist detailed execution logs (idempotent on retry).
   * DB driver: delete stale lines then bulk-insert in chunks (replace), or
   * plain bulk-insert when `append` is set (multi-page backfill pages 2+).
   * R4-P2: the delete + chunked inserts run inside ONE transaction, for both
   * append and replace modes — previously a mid-insert failure (connection
   * blip, constraint violation) left the execution with its old rows already
   * deleted and only a partial page persisted. Any failure now rolls the
   * whole call back, so the pre-call rows survive untouched.
   * S3 driver (LOG_STORAGE_DRIVER=s3, optimization-notes 2.6): one gzip
   * object per execution; the DB keeps only the object reference, and any
   * upload failure falls back to DB rows so the log viewer keeps working.
   * NOTE (kept as-is by design): the S3 path spans two stores (object
   * storage + Postgres rows/pointer) and cannot share one transaction —
   * cross-storage consistency is out of scope here. The failure window is
   * bounded and benign: S3-put-then-DB-delete means the exec row already
   * points at the fresh object (viewers read S3, stale DB rows are inert);
   * the reverse order would risk a dangling pointer, hence delete-after-put.
   * R4-P1: append=true extends the existing store instead of replacing it —
   * backfill calls this once per page and a replace per page would leave
   * only the last page behind for any log longer than one page.
   */
  private async storeLogLines(
    executionId: string,
    logs: string | string[],
    startLineNumber = 0,
    opts: { append?: boolean } = {},
  ): Promise<void> {
    const lines = typeof logs === "string" ? logs.split("\n") : logs;
    const append = opts.append === true;
    const s3 = this.resolveS3Storage();
    // BUG-06 修复：S3 失败回退时的内容并集与指针收回。
    // existing 在 try 外声明——append 模式在 put 前读取的既有内容是回退
    // 路径唯一能拿到的"此前页面"，put 失败后必须并入 DB 回退，否则：
    // - append：本页落 DB 成孤儿行（exec 行仍指 S3，S3 优先读取面永远
    //   看不到它们）；
    // - replace：旧 DB 行 + 旧 S3 对象都在，事务重写 DB 后指针仍指旧
    //   对象，读取面永远看到 STALE 内容。
    // 两种场景都在回退事务成功后把 exec 行指针收回 db，使 DB 恢复自洽；
    // 残留的旧 S3 对象成为惰性垃圾（键按 executionId 确定性复用，后续
    // 一次成功的 storeLogLines 会覆盖它），跨存储一致性边界见方法头注。
    let existing: string | null = null;
    let s3Failed = false;
    if (s3) {
      try {
        let content = lines.join("\n");
        if (append) {
          existing = await this.s3GetExistingLog(s3, executionId);
          if (existing !== null && existing.length > 0) {
            content = `${existing}\n${content}`;
          }
        }
        const key = await s3.put(executionId, content);
        if (!append) {
          await this.logLineRepo.delete({ executionId });
        }
        await this.execRepo.update(executionId, {
          logStorage: "s3",
          logObjectKey: key,
        });
        return;
      } catch (err: unknown) {
        s3Failed = true;
        this.logger.warn(
          `S3 log upload failed for execution ${executionId} (${err instanceof Error ? err.message : String(err)}) — falling back to DB log lines`,
        );
      }
    }
    // append 回退且此前内容在 S3：全量改写（existing + 本页），行号归零
    const mergeExisting = append && s3Failed && existing !== null;
    const fallbackLines =
      mergeExisting && existing !== null
        ? [...existing.split("\n"), ...lines]
        : lines;
    const fallbackReplace = !append || mergeExisting;
    const fallbackStart = mergeExisting ? 0 : startLineNumber;
    const entities = fallbackLines.map((content, i) =>
      this.logLineRepo.create({
        executionId,
        lineNumber: fallbackStart + i,
        content,
        // OBS-03: 每行推断级别落库（levelOfLine 纯文本推断——执行器侧
        // stdout/stderr 已合流，回调不带流来源，无更强信号可用）；
        // 推断不到为 null = 未知级别，level 过滤查询不返回。
        level: levelOfLine(content),
      }),
    );
    const CHUNK = 500;
    await this.dataSource.transaction(async (manager) => {
      if (fallbackReplace) {
        await manager.delete(ExecutionLogLine, { executionId });
      }
      for (let i = 0; i < entities.length; i += CHUNK) {
        await manager.save(ExecutionLogLine, entities.slice(i, i + CHUNK));
      }
    });
    if (s3Failed) {
      // 事务成功后收回指针（顺序不可换：先改指针再写行会闪出"无行可读"窗口）
      await this.execRepo.update(executionId, {
        logStorage: "db",
        logObjectKey: null,
      });
    }
  }

  /**
   * Fetch the current S3 log object for an execution, or null when it does
   * not exist yet (first append page) / cannot be read. Used by the append
   * path of storeLogLines to concatenate multi-page backfills.
   */
  private async s3GetExistingLog(
    s3: S3LogStorage,
    executionId: string,
  ): Promise<string | null> {
    try {
      return await s3.get(s3.objectKey(executionId));
    } catch {
      return null;
    }
  }

  /** Lazily resolve the optional S3 log backend from config. */
  private resolveS3Storage(): S3LogStorage | null {
    if (!this.s3StorageResolved) {
      this.s3LogStorage = S3LogStorage.fromConfig(this.configService);
      this.s3StorageResolved = true;
    }
    return this.s3LogStorage;
  }

  /**
   * Fetch full logs from the executor (backed by its local log files) via
   * GET /api/logs/{executionId} and persist them as ExecutionLogLine rows.
   * Returns true on success; any failure is non-fatal (returns false).
   */
  private async backfillFullLogsFromExecutor(
    execution: TaskExecution,
    executorAddress: string,
  ): Promise<boolean> {
    if (!executorAddress) return false;
    try {
      // DB-first via ExecutorService so rotation propagates to log backfill
      // too — a raw env read would be rejected by the executor's own
      // DB-first verification (same consistency rule as push/dispatch).
      const token = await this.executorService.getSharedToken();
      const headers = token ? { Authorization: `Bearer ${token}` } : {};
      const { default: axios } = await import("axios");
      const url = this.executorService.getExecutorUrl(
        executorAddress,
        `api/logs/${execution.id}`,
      );
      // High-6.3: hard cap on what a single executor response may carry
      // (Node executor previously could return the entire log in one chunk —
      // we now refuse anything above 64 MB to protect admin-api memory).
      const MAX_DOWNLOAD_BYTES = 64 * 1024 * 1024;
      const PAGE_LIMIT = 2000;
      const MAX_PAGES = 200; // 400k-line backfill ceiling
      let fromLine = 0;
      let totalPersisted = 0;
      for (let page = 0; page < MAX_PAGES; page++) {
        const resp = await axios.get(url, {
          headers,
          timeout: 10_000,
          maxContentLength: MAX_DOWNLOAD_BYTES,
          maxBodyLength: MAX_DOWNLOAD_BYTES,
          params: { fromLine, limit: PAGE_LIMIT },
        });
        const chunk: string[] = Array.isArray(resp.data?.lines)
          ? resp.data.lines.filter((l: unknown) => typeof l === "string")
          : [];
        if (chunk.length === 0) break;
        // Persist each page as it arrives — never accumulate the entire log
        // in memory. R4-P1: page 0 replaces any stale rows; later pages must
        // APPEND (storeLogLines' replace semantics would delete the previous
        // pages, leaving only the final page for any log > PAGE_LIMIT lines).
        // storeLogLines re-numbers lineNumber to start at the global offset
        // so the DB row numbers reflect absolute positions.
        await this.storeLogLines(execution.id, chunk, fromLine, {
          append: page > 0,
        });
        totalPersisted += chunk.length;
        fromLine += chunk.length;
        const total: unknown = resp.data?.totalLines;
        if (typeof total !== "number" || total <= 0 || fromLine >= total) {
          break;
        }
      }
      if (totalPersisted === 0) return false;
      this.logger.log(
        `Backfilled ${totalPersisted} full log lines for execution ${execution.id}`,
      );
      return true;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `Failed to backfill full logs for execution ${execution.id} from ${executorAddress}: ${message} — keeping truncated callback logs`,
      );
      return false;
    }
  }

  /**
   * ARCH-21：终态落库（唯一 winner）之后发布领域事件，副作用与主链解耦。
   *
   * - SUCCESS → execution.completed；FAILED/TIMEOUT → execution.failed。
   *   迁移前的「改动1」失败告警（notifyCallbackFailure 直调）现由
   *   notification 模块 ExecutionEventsListener 订阅 execution.failed 复刻
   *   同款语义（含 taskRepo 回查告警配置与 NOTIFICATION_FAILED 审计兜底）。
   * - emit 时机 = 迁移前通知直调的时机（fan-out/日志持久化之前）：即便后续
   *   步骤抛错被 catch 成 success:false（执行器会重试整批），事件也已派发
   *   一次；重试回调走 affected=0 分支不再 emit——「每个失败执行一次告警」
   *   的旧不变量原样保持。
   * - fail-open：总线对监听器抛错只记日志（同步/异步都吞），绝不影响主链
   *   结果（测试断言）；payload 带全监听器所需 id 级信息，实体配置由监听器
   *   自行回查——common 层不反向依赖 task 实体（见 domain-events.ts）。
   * - eventBus 为 null（@Optional 兜底）时静默跳过：主链行为与迁移前一致，
   *   仅事件不发（既有旧单测装配兼容，先例 OBS-04 reportRepo）。
   */
  /**
   * BUG-21（由 nginx SSE 真机验证暴露）：**派发失败**终态的领域事件发布出口。
   *
   * 背景：execution.completed/failed 一直只由回调路径（handleCallback）发布。
   * 派发阶段就失败的执行（执行器离线 / 无匹配执行器 / 派发超时——即 executor
   * 根本没接单的场景）在 processor 里直接写终态 + 直调通知，**从不发领域
   * 事件**，导致三类消费者全部漏掉这类失败：
   *   - `GET /api/executions/stream`（Dashboard 终态加速流）
   *   - FEAT-07 出站 webhook（event_subscriptions 订阅 execution.failed）
   *   - ARCH-21 的 notification 订阅者（processor 的直调绕过了统一语义）
   *
   * 现在 processor 在**终态落库成功后**调用本方法，通知改由订阅者统一发出
   * （顺带修掉直调版本 taskId 传 undefined 的字段缺失）。payload 构造复用
   * emitTerminalEvent，避免两处实现漂移。
   *
   * 幂等边界：只在「最后一次尝试 + 终态落库成功」时调用（processor 侧把关）；
   * 与回调路径不会双发——派发失败的执行不可能再收到回调。
   */
  publishTerminalEventForDispatch(
    execution: TaskExecution,
    cb: { errorMessage?: string; logs?: string },
  ): void {
    const finishedAt = execution.endTime ?? new Date();
    const durationMs =
      execution.duration ??
      (execution.startTime
        ? finishedAt.getTime() - execution.startTime.getTime()
        : null);
    this.emitTerminalEvent(
      execution,
      execution.status,
      execution.failureReason ?? null,
      cb,
      durationMs,
      finishedAt,
    );
  }

  private emitTerminalEvent(
    execution: TaskExecution,
    status: ExecutionStatus,
    failureReason: ExecutionFailureReason | null,
    cb: { errorMessage?: string; logs?: string },
    durationMs: number | null,
    finishedAt: Date,
  ): void {
    if (!this.eventBus) return;
    const payload: ExecutionTerminalEventPayload = {
      executionId: execution.id,
      taskId: execution.taskId ?? null,
      taskName: execution.taskName ?? execution.taskId,
      // ExecutionStatus 枚举值即小写字面量（"success"/"failed"/"timeout"），
      // 载荷类型以字面量联合表达——common 层不 import task 实体（见上注）。
      status: status as ExecutionTerminalEventPayload["status"],
      failureReason: failureReason ?? null,
      errorMessage: cb.errorMessage,
      logs: cb.logs,
      aiAnalysis: execution.aiAnalysis ?? null,
      durationMs,
      finishedAt: finishedAt.toISOString(),
    };
    // 总线自身契约即 fail-open（emit 永不外抛）；此 try/catch 是第二道保险丝，
    // 保证「发布事件」这一新增步骤在任何意外实现下也绝不改变主链结果。
    try {
      this.eventBus.emit(
        status === ExecutionStatus.SUCCESS
          ? DOMAIN_EVENTS.EXECUTION_COMPLETED
          : DOMAIN_EVENTS.EXECUTION_FAILED,
        payload,
      );
    } catch {
      /* never reached with DomainEventBus's fail-open contract */
    }
  }

  /**
   * 改动3：重复回调日志补写闭环。
   *
   * 背景：winner 分支的日志持久化在终态 UPDATE 之后——若 storeLogLines 抛错，
   * item 返回 success:false → 执行器重试整批 → 重试落入 affected=0 分支并在此
   * 提前返回，跳过日志持久化 → 该执行日志永久丢失。
   *
   * 因此在 affected=0 分支：当回调带 logs 且该 execution 的 logStorage /
   * logObjectKey 仍为空（说明上一次 winner 未成功写入日志）时，补做一次持久化
   * 再返回。无需区分是否 winner——storeLogLines 的 replace 语义本身幂等；持久化
   * 失败仅 logger.warn，不改变重复回调既有的 success:true 幂等语义。
   */
  private async persistCallbackLogsIfMissing(
    execution: TaskExecution,
    cb: {
      executionId: string;
      logs?: string;
      executorAddress?: string;
    },
  ): Promise<void> {
    const logStoreMissing = !execution.logStorage && !execution.logObjectKey;
    if (!cb.logs || !logStoreMissing) return;
    try {
      let stored = false;
      if (LOG_TRUNCATION_MARKER.test(cb.logs)) {
        stored = await this.backfillFullLogsFromExecutor(
          execution,
          execution.executorAddress || cb.executorAddress || "",
        );
      }
      if (!stored) {
        await this.storeLogLines(cb.executionId, cb.logs);
      }
    } catch (err: unknown) {
      this.logger.warn(
        `Failed to backfill missing logs for execution ${cb.executionId} on duplicate callback (${err instanceof Error ? err.message : String(err)})`,
      );
    }
  }

  /**
   * 改动5：kill 命中后，best-effort 通知执行器真正终止进程。
   *
   * 地址来源为库中实际值（RETURNING 结果，快照作兜底）；拿不到地址则跳过。
   * 任何失败（离线 / 超时 / 404 / 网络错）一律吞掉并 logger.warn，绝不影响
   * kill 的结果返回——执行器侧 /kill 返回 200=已终止或已结束、404=不在运行，
   * 均无需回传给管理员。
   *
   * P2: HTTP 实现收敛至 ExecutorService.notifyExecutorKill（scheduler stale
   * sweep re-enqueue 前的 kill 通知共用，避免两份逻辑）。本包装保留调用点
   * 契约：空地址跳过、异常兜底吞掉。
   */
  private async notifyExecutorKill(
    executionId: string,
    executorAddress?: string | null,
  ): Promise<void> {
    if (!executorAddress) return;
    try {
      await this.executorService.notifyExecutorKill(
        executionId,
        executorAddress,
      );
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `Failed to notify executor ${executorAddress} to kill execution ${executionId}: ${message}`,
      );
    }
  }

  async handleCallback(
    callbacks: Array<{
      executionId: string;
      status: "success" | "failed";
      exitCode?: number;
      logs?: string;
      errorMessage?: string;
      failureReason?: ExecutionFailureReason;
      durationMs?: number;
      executorAddress?: string;
      /** FEAT-05: 执行产物清单（可选，best-effort，随终态回调上报）。 */
      artifacts?: Array<{ name: string; size: number; sha256: string }>;
    }>,
  ) {
    const results = [];
    for (const cb of callbacks) {
      try {
        const execution = await this.execRepo.findOne({
          where: { id: cb.executionId },
        });
        if (!execution) {
          // 可观测性补齐：callback 业务结果分类计数（not_found）
          recordRuntime("autoflow_callback_business_total", {
            result: "not_found",
          });
          results.push({
            executionId: cb.executionId,
            success: false,
            error: "Execution not found",
          });
          continue;
        }

        // P1: once an execution has been dispatched to a specific executor,
        // callbacks must come from that address — a missing or different
        // address is rejected (both executor runtimes always send it).
        if (
          execution.executorAddress &&
          cb.executorAddress !== execution.executorAddress
        ) {
          // 可观测性补齐：地址不符与缺地址分别归类计数
          recordRuntime("autoflow_callback_business_total", {
            result: cb.executorAddress
              ? "address_mismatch"
              : "address_mismatch_missing_address",
          });
          results.push({
            executionId: cb.executionId,
            success: false,
            error: cb.executorAddress
              ? "Executor address mismatch"
              : "executorAddress is required for this execution",
          });
          continue;
        }

        // P1: atomic terminal transition — the update only lands while the
        // execution is still pending/running, making duplicate callbacks and
        // races with the worker's finally-save harmless. Slot release and log
        // persistence below run exactly once, only for the winner.
        const finishedAt = new Date();
        const patch: Partial<TaskExecution> = {
          endTime: finishedAt,
          duration:
            cb.durationMs ??
            (execution.startTime
              ? finishedAt.getTime() - new Date(execution.startTime).getTime()
              : 0),
        };
        if (cb.status === "success") {
          patch.status = ExecutionStatus.SUCCESS;
          patch.failureReason = null;
        } else {
          const failureReason =
            cb.failureReason ??
            this.inferFailureReason(cb.errorMessage, cb.logs, cb.exitCode);
          patch.status =
            failureReason === ExecutionFailureReason.TIMEOUT
              ? ExecutionStatus.TIMEOUT
              : ExecutionStatus.FAILED;
          patch.failureReason = failureReason;
          if (cb.errorMessage !== undefined) {
            patch.errorMessage = cb.errorMessage;
          }
        }
        // 改动2（可观测性补齐）：回调上报的原始退出码入库溯源（终态成败均
        // 适用）。DTO 层已 @IsInt 校验，这里再运行态兜底（handleCallback 还有
        // 内部调用方）：非整数按缺省处理，不写入 patch——绝不把已有值覆盖成 null。
        if (typeof cb.exitCode === "number" && Number.isInteger(cb.exitCode)) {
          patch.exitCode = cb.exitCode;
        }
        if (cb.logs) {
          patch.logs = cb.logs;
        }
        // FEAT-05: 产物清单落库（best-effort）。仅在回调上报非空清单时写入，
        // 绝不在缺省时覆盖成 null——重复/兜底回调不会擦除先前已保存的清单。
        if (Array.isArray(cb.artifacts) && cb.artifacts.length > 0) {
          patch.artifacts = cb.artifacts;
        }

        // R-P0-007: Exclude KILLED status to prevent callback from overwriting user-initiated kill
        // 改动4: 携带 RETURNING——用库中实际 executorAddress 决定释放/回填目标。
        // executorAddress 在 dispatch HTTP 返回后才落库（task.processor.ts），
        // 秒级完成的执行其请求前快照 execution.executorAddress 仍为 null，用它
        // 释放会 no-op 使 runningTaskCount 永久虚高；RETURNING 覆盖该落库窗口，
        // 快照仅作 fallback（参照 scheduler.service 的 UPDATE ... RETURNING 模式）。
        const updated = await this.execRepo
          .createQueryBuilder()
          .update(TaskExecution)
          .set(patch)
          .where("id = :id", { id: cb.executionId })
          .andWhere("status IN (:...open)", {
            open: [ExecutionStatus.PENDING, ExecutionStatus.RUNNING],
          })
          .returning(["id", "executorAddress"])
          .execute();

        if (!updated.affected) {
          // Already terminal (duplicate callback): report success without
          // releasing the slot again — the first writer already did.
          // 改动3: 但若回调日志此前没落库（上一次 winner 在 storeLogLines 抛错、
          // 整批重试回到此分支），仍补写日志后再返回，闭合"落库失败→日志永久丢失"。
          const fresh = await this.execRepo.findOne({
            where: { id: cb.executionId },
          });
          if (fresh) await this.persistCallbackLogsIfMissing(fresh, cb);
          // 可观测性补齐：重复回调（已终态）业务分类计数；终态结果不计数——
          // 执行结果 series 只在唯一 winner 的 UPDATE 命中处记录。
          recordRuntime("autoflow_callback_business_total", {
            result: "duplicate",
          });
          results.push({ executionId: cb.executionId, success: true });
          continue;
        }

        // 可观测性补齐：终态条件 UPDATE 命中（winner）——业务受理计数 +
        // 按最终 status 记录执行结果（success/failed/timeout）。
        recordRuntime("autoflow_callback_business_total", {
          result: "accepted",
        });
        recordRuntime("autoflow_execution_result_total", {
          status: patch.status,
        });

        // winner 行（RETURNING 结果）为权威：地址/日志持久化都以此为准。
        const winnerRow = Array.isArray((updated as { raw?: unknown }).raw)
          ? ((updated as { raw?: Array<{ executorAddress?: string | null }> })
              .raw?.[0] ?? null)
          : null;
        const winnerAddress =
          winnerRow?.executorAddress ?? execution.executorAddress;

        // Decrement executor runningTaskCount on task completion (success or
        // failure); exactly once thanks to the conditional update above.
        // 改动4: 优先用 RETURNING 的库中实际地址，快照兜底。
        await this.releaseExecutorSlot(winnerAddress);

        // ARCH-21（原「改动1」解耦）：终态事件发布——旧的 FAILED/TIMEOUT
        // 直调告警改为 execution.failed（notification 模块监听器复刻等价
        // 语义），并在 SUCCESS 新增 execution.completed（本轮通知侧刻意不
        // 订阅——旧路径成功本就不发通知；事件为 FEAT-07 出站 webhook 铺路）。
        // 放在依赖 fan-out 与日志持久化之前，与旧直调时机点一致：确保即便
        // 后续步骤抛错被 catch 成 success:false（执行器随后会重试整批），
        // 事件也已发出一次；重试路径在 affected=0 分支不再 emit，恰好保持
        // "每个失败执行一次告警"，与终态条件 UPDATE 的 winner 语义一致。
        this.emitTerminalEvent(
          execution,
          patch.status as ExecutionStatus,
          patch.failureReason ?? null,
          cb,
          patch.duration ?? null,
          finishedAt,
        );

        // CORE-04: 超时终态落定后的动作兑现。执行器回调 failureReason=timeout
        // （自身硬超时树杀后上报）且任务配置了非缺省 timeoutAction 时：
        //  - notify_only：admin 不额外动作（告警已由上方改动1路径发出）——
        //    显式 no-op 分支只是让语义可读；
        //  - kill_retry：按任务既有重试预算 re-enqueue 一次新执行（与
        //    executor-restart / stale sweep 共用 hasRetryBudget +
        //    scheduleRetryAfterRecovery，fail-open：预算耗尽/入队失败仅记日志，
        //    终态已落定不受影响）。kill（缺省/null）走到这里即无追加动作。
        // 放在 winner 分支保证恰好一次（duplicate 回调在 affected=0 提前返回）。
        if (patch.status === ExecutionStatus.TIMEOUT) {
          const task = execution.taskId
            ? await this.taskRepo.findOne({ where: { id: execution.taskId } })
            : null;
          const action = normalizeTimeoutAction(task?.timeoutAction);
          if (action === "kill_retry" && task) {
            this.logger.warn(
              `CORE-04: timeout action kill_retry for execution ${execution.id} (task "${task.name}")`,
            );
            try {
              await this.executorService.scheduleRetryAfterRecovery(
                task,
                execution,
                "timeout_retry",
              );
            } catch (retryErr: unknown) {
              const retryMsg =
                retryErr instanceof Error ? retryErr.message : String(retryErr);
              this.logger.warn(
                `CORE-04: kill_retry re-enqueue failed for execution ${execution.id}: ${retryMsg} (terminal state preserved)`,
              );
            }
          }
          // notify_only：无追加 admin 动作——超时告警已发出（改动1 路径），
          // 执行器侧树杀照常发生。此分支显式留空以承载语义。
        }

        // R4-P0: dependency fan-out lives on the unique-winner path. The
        // worker's in-memory status can only be RUNNING/FAILED/TIMEOUT when
        // its finally block runs (SUCCESS is written exclusively by the
        // conditional UPDATE above), so the previous trigger point in
        // TaskProcessor.handle was dead code and dependency chains never
        // fired. Firing here — after affected > 0 and only for
        // status === SUCCESS — makes duplicate callbacks a no-op (they exit
        // at the affected gate above) and keeps the TASK-004 conditional
        // UPDATE semantics: exactly one caller observes the transition.
        if (patch.status === ExecutionStatus.SUCCESS) {
          await this.triggerDependentTasks(execution.taskId);
        }

        // LOG-01: persist structured log lines for pagination/SSE. When the
        // executor truncated the callback payload, pull the full logs from the
        // executor's /api/logs endpoint instead; on failure fall back to the
        // truncated lines so the log viewer keeps working.
        if (cb.logs) {
          let stored = false;
          if (LOG_TRUNCATION_MARKER.test(cb.logs)) {
            stored = await this.backfillFullLogsFromExecutor(
              { ...execution, executorAddress: winnerAddress ?? null },
              winnerAddress ?? "",
            );
          }
          if (!stored) {
            await this.storeLogLines(cb.executionId, cb.logs);
          }
        }

        results.push({ executionId: cb.executionId, success: true });
      } catch (error: unknown) {
        // 可观测性补齐：per-item 异常兜底分支（如日志持久化抛错）——业务
        // 分类计 error；执行结果不计数（终态可能已写入，由 winner 处计数）。
        recordRuntime("autoflow_callback_business_total", { result: "error" });
        results.push({
          executionId: cb.executionId,
          success: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return results;
  }

  async saveVersion(
    taskId: string,
    createdBy?: string,
    description?: string,
    taskSnapshot?: Task,
  ): Promise<TaskVersion> {
    const task =
      taskSnapshot ?? (await this.taskRepo.findOne({ where: { id: taskId } }));
    if (!task) {
      throw new NotFoundException("Task not found");
    }

    // Use MAX(version number) + 1 to avoid race condition from COUNT-based numbering
    const maxResult = await this.versionRepo
      .createQueryBuilder("v")
      .select("MAX(CAST(SUBSTR(v.version, 2) AS INTEGER))", "maxNum")
      .where("v.taskId = :taskId", { taskId })
      .getRawOne();
    const versionNum = (maxResult?.maxNum ?? 0) + 1;
    const version = `v${versionNum}`;

    const snapshot: Record<string, unknown> = {
      id: task.id,
      name: task.name,
      description: task.description,
      runtime: task.runtime,
      entrypoint: task.entrypoint,
      // W-21: requirements must ride the snapshot, or a version rollback
      // would silently drop the dependency set the rolled-back task needs.
      requirements: task.requirements,
      params: task.params,
      timeout: task.timeout,
      // CORE-04: 超时策略随快照——缺省时版本回滚不得静默重置为 null（否则
      // "回滚到旧版本"会悄悄改变超时动作/预警配置）。
      timeoutAction: task.timeoutAction,
      timeoutWarnRatio: task.timeoutWarnRatio,
      // CORE-05: 预估时长随快照——否则版本回滚会把已配置的预估静默重置
      // （与上方超时策略两字段同一理由）。
      estimatedDurationSec: task.estimatedDurationSec,
      maxRetry: task.maxRetry,
      retryDelay: task.retryDelay,
      retryableErrors: task.retryableErrors,
      triggerType: task.triggerType,
      cronExpression: task.cronExpression,
      timezone: task.timezone,
      fixedRate: task.fixedRate,
      blockStrategy: task.blockStrategy,
      misfireStrategy: task.misfireStrategy,
      priority: task.priority,
      executeMode: task.executeMode,
      currentVersion: task.currentVersion,
      gitRepo: task.gitRepo,
      gitBranch: task.gitBranch,
      gitCommit: task.gitCommit,
      glueSource: task.glueSource,
      glueLanguage: task.glueLanguage,
    };

    return this.versionRepo.save(
      this.versionRepo.create({
        taskId,
        version,
        gitCommit: task.gitCommit,
        snapshot,
        createdBy,
        description,
      }),
    );
  }

  async getVersions(taskId: string): Promise<TaskVersion[]> {
    return this.versionRepo.find({
      where: { taskId },
      order: { createdAt: "DESC" },
    });
  }

  async getVersion(taskId: string, versionId: string): Promise<TaskVersion> {
    const version = await this.versionRepo.findOne({
      where: { id: versionId, taskId },
    });
    if (!version) {
      throw new NotFoundException("Version not found");
    }
    return version;
  }

  async rollbackToVersion(taskId: string, versionId: string): Promise<Task> {
    const version = await this.getVersion(taskId, versionId);

    const task = await this.taskRepo.findOne({ where: { id: taskId } });
    if (!task) {
      throw new NotFoundException("Task not found");
    }

    Object.assign(task, version.snapshot);
    task.currentVersion = version.version;

    const saved = await this.taskRepo.save(task);
    await this.saveVersion(saved.id, undefined, undefined, saved);
    return saved;
  }

  async compareVersions(
    taskId: string,
    versionId1: string,
    versionId2: string,
  ): Promise<Record<string, { old: unknown; new: unknown }>> {
    const v1 = await this.getVersion(taskId, versionId1);
    const v2 = await this.getVersion(taskId, versionId2);

    const allKeys = new Set([
      ...Object.keys(v1.snapshot),
      ...Object.keys(v2.snapshot),
    ]);
    const diff: Record<string, { old: unknown; new: unknown }> = {};

    for (const key of allKeys) {
      if (
        JSON.stringify(v1.snapshot[key]) !== JSON.stringify(v2.snapshot[key])
      ) {
        diff[key] = {
          old: v1.snapshot[key],
          new: v2.snapshot[key],
        };
      }
    }

    return diff;
  }

  async deleteVersion(taskId: string, versionId: string): Promise<void> {
    const version = await this.getVersion(taskId, versionId);
    await this.versionRepo.delete(version.id);
  }

  /** Get scheduler running status statistics */
  getSchedulerStats() {
    return this.schedulerService.getStats();
  }

  /**
   * FEAT-18（ARCH-21 预留补发）：killExecution 的 KILLED 翻转落库后发布
   * `execution.killed` 领域事件。
   *
   * - 时机：条件 UPDATE（status IN (PENDING,RUNNING)）命中（affected>0）之后，
   *   即"已提交的既成事实"——与 ARCH-21 总线时序契约一致。
   * - 载荷形状对齐 emitTerminalEvent 的 ExecutionTerminalEventPayload
   *   （taskId/taskName/failureReason/durationMs/finishedAt），使 notification
   *   listener 与 FEAT-07 出站派发器可复用同一条失败类消费路径。
   * - fail-open：@Optional 注入的 eventBus 为 null 时静默跳过（既有单测装配
   *   兼容，先例同 emitTerminalEvent）；emit 本身被总线兜底 + try/catch 二道
   *   保险丝，绝不影响 kill 主链结果。
   */
  private emitKilledEvent(
    execution: TaskExecution,
    durationMs: number | null,
    finishedAt: Date,
  ): void {
    if (!this.eventBus) return;
    const payload: ExecutionTerminalEventPayload = {
      executionId: execution.id,
      taskId: execution.taskId ?? null,
      taskName: execution.taskName ?? execution.taskId,
      status: "killed",
      failureReason: ExecutionFailureReason.KILLED,
      errorMessage: "Manually terminated by administrator",
      aiAnalysis: execution.aiAnalysis ?? null,
      durationMs,
      finishedAt: finishedAt.toISOString(),
    };
    try {
      this.eventBus.emit(DOMAIN_EVENTS.EXECUTION_KILLED, payload);
    } catch {
      /* never reached with DomainEventBus's fail-open contract */
    }
  }

  /** Force-terminate a running execution */
  async killExecution(
    execId: string,
  ): Promise<{ success: boolean; message: string }> {
    const execution = await this.execRepo.findOne({ where: { id: execId } });
    if (!execution) {
      throw new NotFoundException(`Execution ${execId} not found`);
    }

    // R-P0-007: Use conditional update instead of save() to prevent race conditions
    // Only allow killing PENDING or RUNNING executions
    const now = new Date();
    const duration = execution.startTime
      ? Date.now() - new Date(execution.startTime).getTime()
      : null;

    const result = await this.execRepo
      .createQueryBuilder()
      .update(TaskExecution)
      .set({
        status: ExecutionStatus.KILLED,
        endTime: now,
        duration: duration,
        errorMessage: "Manually terminated by administrator",
        failureReason: ExecutionFailureReason.KILLED,
      })
      .where("id = :id", { id: execId })
      .andWhere("status IN (:...open)", {
        open: [ExecutionStatus.PENDING, ExecutionStatus.RUNNING],
      })
      // 改动4: RETURNING 取库中实际 executorAddress——快照 execution.executorAddress
      // 可能因 dispatch 尚未落库而为 null，用它决定释放/终止目标会 no-op（槽位虚高、
      // 执行器继续空跑）。参照 scheduler.service 既有 UPDATE ... RETURNING 模式。
      .returning(["id", "executorAddress"])
      .execute();

    if (!result.affected || result.affected === 0) {
      throw new BadRequestException(
        `Execution is in '${execution.status}' status (terminal state) and cannot be terminated`,
      );
    }

    // FEAT-18: KILLED 终态已落库（UPDATE 命中 winner），发布 execution.killed。
    // emit 在通知执行器/释放槽位之前——事件即既成事实，后续步骤全是 best-effort
    // 副作用，任何失败都不回头改库（与 ARCH-21「落库后即 emit」时序契约一致）。
    this.emitKilledEvent(execution, duration, now);

    // 改动4: 优先用 RETURNING 的库中实际地址，快照作 fallback。
    const killedRow = Array.isArray((result as { raw?: unknown }).raw)
      ? ((result as { raw?: Array<{ executorAddress?: string | null }> })
          .raw?.[0] ?? null)
      : null;
    const executorAddress =
      killedRow?.executorAddress ?? execution.executorAddress ?? null;

    await this.releaseExecutorSlot(executorAddress);
    // 改动5: 通知执行器真正终止进程（best-effort；地址为空则跳过，
    // 任何失败都在 notifyExecutorKill 内被吞掉）。
    await this.notifyExecutorKill(execId, executorAddress);
    this.logger.warn(`Execution ${execId} has been manually terminated`);
    return { success: true, message: "Execution marked as terminated" };
  }
}

/**
 * Stream a UTF-8 text log line by line, returning the page [fromLine,
 * fromLine+limit). The full document is read once but no full string or
 * full line-array is ever materialized — only the slice the caller asked
 * for plus the running total. Lines themselves are short-lived; the total
 * count is exposed as `totalLines` so the caller can paginate further.
 *
 * OBS-03: opts.level（可选）启用级别过滤。S3 对象是纯 gzip 文本，级别未
 * 随对象持久化，无法在存储层下推过滤——只能整流解码后逐行用 levelOfLine
 * 重推断。取舍：正确性优先于数据量——MAX_LOG_BYTES（见 s3-log-storage）
 * 已为解码体积兜底上限，重推断是 O(lines) 纯文本扫描，可接受；若未来
 * 日志对象带侧车索引（level→line ranges）可再优化。
 *
 * level 过滤下 fromLine 的语义是"过滤后序列的偏移量"（与 DB 路径的
 * OFFSET 模式一致）：被过滤掉的行不占用分页窗口，也不计入 totalLines——
 * totalLines 是"过滤后总行数"，hasMore 由过滤后行集计算。未传 level 时
 * 行为与 OBS-03 之前逐字节一致。
 */
async function paginateLogStream(
  stream: Readable,
  fromLine: number,
  limit: number,
  opts: { level?: string | null } = {},
): Promise<{ lines: string[]; totalLines: number; hasMore: boolean }> {
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  const out: string[] = [];
  let idx = 0; // physical line index (unfiltered)
  let matched = 0; // OBS-03: lines surviving the level filter
  for await (const line of rl) {
    if (opts.level) {
      if (levelOfLine(line) !== opts.level) continue;
      if (matched >= fromLine && out.length < limit) out.push(line);
      matched++;
    } else {
      if (idx >= fromLine && out.length < limit) out.push(line);
      idx++;
    }
  }
  const totalLines = opts.level ? matched : idx;
  return {
    lines: out,
    totalLines,
    hasMore: fromLine + out.length < totalLines,
  };
}
