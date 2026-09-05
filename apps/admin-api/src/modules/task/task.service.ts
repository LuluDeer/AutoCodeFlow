import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  ConflictException,
  ServiceUnavailableException,
  Inject,
  forwardRef,
} from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import {
  DataSource,
  ILike,
  In,
  Not,
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
import { ExecutorService } from "../executor/executor.service";
import { S3LogStorage } from "./log-storage/s3-log-storage";

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
    };
    if (normalized.timeoutSeconds !== undefined) {
      normalized.timeout = normalized.timeoutSeconds;
      delete normalized.timeoutSeconds;
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
    private configService: ConfigService,
    private executorService: ExecutorService,
  ) {}

  async create(dto: CreateTaskDto) {
    if (dto.dependencies && Object.keys(dto.dependencies).length > 0) {
      await this.checkCircularDependency(dto.id, dto.dependencies);
    }
    const normalized = this.normalizeTaskDto(dto);
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
      return await this.taskRepo.save(this.taskRepo.create(normalized));
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
    const [list, total] = await this.taskRepo.findAndCount({
      where,
      skip: (p.page - 1) * p.pageSize,
      take: p.pageSize,
      order: { createdAt: "DESC" },
    });
    return paginate(list, total, p.page, p.pageSize);
  }

  async findOne(id: string) {
    const t = await this.taskRepo.findOne({
      where: { id, status: Not(TaskStatus.DELETED) },
    });
    if (!t) throw new NotFoundException("Task not found");
    return t;
  }

  async update(id: string, dto: UpdateTaskDto) {
    const t = await this.findOne(id);
    const updated = Object.assign(t, this.normalizeTaskDto(dto));
    // R7 (N17): PATCH 合并路径的互斥校验必须看合并后的实体态——请求体只带
    // executorId（已有任务 executeMode=broadcast）或只带 executeMode=broadcast
    // （已有任务已 pin）时，normalizeTaskDto 看不到另一半，会漏判产生
    // "broadcast+已 pin" 非法状态（dispatchBroadcast 不读 executorId，pinning
    // 被静默丢弃）。save 前兜底，消息与 create 路径一致。
    this.assertPinBroadcastExclusive(updated.executorId, updated.executeMode);
    const saved = await this.taskRepo.save(updated);
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
    return this.taskRepo.save(t);
  }

  async remove(id: string) {
    const t = await this.findOne(id);
    // Stop schedule immediately without waiting for reload
    this.schedulerService.stop(id);
    t.status = TaskStatus.DELETED;
    await this.taskRepo.save(t);
    // DB-001: 同步写入 TypeORM 软删除列，此后 Repository find/findOne
    // 自动排除该行；status='deleted' 保留以兼容 raw query 消费方。
    await this.taskRepo.softDelete(id);
    return { deleted: true };
  }

  async pause(id: string) {
    const t = await this.findOne(id);
    if (t.status === TaskStatus.PAUSED) {
      throw new BadRequestException("Task is already paused");
    }
    this.schedulerService.stop(id);
    t.status = TaskStatus.PAUSED;
    return this.taskRepo.save(t);
  }

  async resume(id: string) {
    const t = await this.findOne(id);
    if (t.status !== TaskStatus.PAUSED) {
      throw new BadRequestException("Task is not paused and cannot be resumed");
    }
    t.status = TaskStatus.ACTIVE;
    await this.taskRepo.save(t);
    await this.schedulerService.scheduleOne(t);
    return t;
  }

  async trigger(id: string, dto: TriggerTaskDto) {
    const task = await this.findOne(id);
    const exec = await this.dataSource.transaction(async (manager) => {
      return manager.save(
        manager.create(TaskExecution, {
          taskId: task.id,
          taskName: task.name,
          status: ExecutionStatus.PENDING,
          params: dto.params ?? task.params,
          triggerType: "manual",
          taskVersion: task.currentVersion,
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
          backoff:
            task.retryDelay > 0
              ? { type: "exponential", delay: task.retryDelay * 1000 }
              : undefined,
          // N2: unify with scheduler.enqueue — always pass a normalized numeric
          // priority (DB stores the PG string enum; a raw label must never
          // reach BullMQ, which rejects non-integer priorities).
          priority: normalizeTaskPriority(task.priority),
        },
      );
    } catch (err: unknown) {
      // P1: the PENDING row is already committed — without compensation it
      // would hang forever when Redis/the queue is down.
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

  async getExecution(id: string) {
    const e = await this.execRepo.findOne({ where: { id } });
    if (!e) throw new NotFoundException("Execution not found");
    return e;
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
    exec.aiAnalysis = await this.aiService.analyzeFailure(task, logContent);
    await this.execRepo.save(exec);
    return exec;
  }

  async getExecutionLogs(execId: string, fromLine = 0, limit = 500) {
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
          const result = await paginateLogStream(stream, fromLine, safeLimit);
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
    const [lines, totalLines] = await Promise.all([
      this.logLineRepo
        .createQueryBuilder("l")
        .where("l.executionId = :id", { id: execId })
        .andWhere("l.lineNumber >= :from", { from: fromLine })
        .orderBy("l.lineNumber", "ASC")
        .select(["l.lineNumber", "l.content"])
        .take(safeLimit)
        .getMany(),
      this.logLineRepo.count({ where: { executionId: execId } }),
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
      throw new ServiceUnavailableException(
        `Too many concurrent log streams for execution ${execId} (max ${perExec})`,
      );
    }
    if (this.sseStreamsGlobal >= global) {
      throw new ServiceUnavailableException(
        `Too many concurrent log streams server-wide (max ${global})`,
      );
    }

    this.sseStreamsPerExecution.set(execId, currentForExec + 1);
    this.sseStreamsGlobal++;

    let released = false;
    return () => {
      if (released) return;
      released = true;
      const n = (this.sseStreamsPerExecution.get(execId) ?? 1) - 1;
      if (n <= 0) this.sseStreamsPerExecution.delete(execId);
      else this.sseStreamsPerExecution.set(execId, n);
      this.sseStreamsGlobal = Math.max(0, this.sseStreamsGlobal - 1);
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
  ): Promise<void> {
    // TASK-008: 控制器通常会在写出 SSE 响应头之前预先占用槽位
    // （preAcquiredSlot），以便超限时能返回真正的 503；未传入时在此补占。
    const releaseSlot = preAcquiredSlot ?? this.acquireSseSlot(execId);
    let nextLine = 0;
    let s3FetchFailed = false;
    const POLL_INTERVAL = 1000; // ms
    const MAX_RUNTIME = 30 * 60 * 1000; // 30 min safety cap
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
                send(line);
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
        send(row.content);
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
          backoff:
            task.retryDelay > 0
              ? { type: "exponential", delay: task.retryDelay * 1000 }
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
    if (s3) {
      try {
        let content = lines.join("\n");
        if (append) {
          const existing = await this.s3GetExistingLog(s3, executionId);
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
        this.logger.warn(
          `S3 log upload failed for execution ${executionId} (${err instanceof Error ? err.message : String(err)}) — falling back to DB log lines`,
        );
      }
    }
    // R4-P2: single transaction — the replace-delete and every chunk insert
    // either all land or none do (append mode skips the delete but still
    // needs the chunk inserts to be atomic against mid-flight failures).
    const entities = lines.map((content, i) =>
      this.logLineRepo.create({
        executionId,
        lineNumber: startLineNumber + i,
        content,
      }),
    );
    const CHUNK = 500;
    await this.dataSource.transaction(async (manager) => {
      if (!append) {
        await manager.delete(ExecutionLogLine, { executionId });
      }
      for (let i = 0; i < entities.length; i += CHUNK) {
        await manager.save(ExecutionLogLine, entities.slice(i, i + CHUNK));
      }
    });
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
      const token =
        this.configService.get<string>("executor.sharedToken") ?? "";
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
    }>,
  ) {
    const results = [];
    for (const cb of callbacks) {
      try {
        const execution = await this.execRepo.findOne({
          where: { id: cb.executionId },
        });
        if (!execution) {
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
        if (cb.logs) {
          patch.logs = cb.logs;
        }

        // R-P0-007: Exclude KILLED status to prevent callback from overwriting user-initiated kill
        const updated = await this.execRepo
          .createQueryBuilder()
          .update(TaskExecution)
          .set(patch)
          .where("id = :id", { id: cb.executionId })
          .andWhere("status IN (:...open)", {
            open: [ExecutionStatus.PENDING, ExecutionStatus.RUNNING],
          })
          .execute();

        if (!updated.affected) {
          // Already terminal (duplicate callback): report success without
          // releasing the slot again — the first writer already did.
          results.push({ executionId: cb.executionId, success: true });
          continue;
        }

        // Decrement executor runningTaskCount on task completion (success or
        // failure); exactly once thanks to the conditional update above.
        await this.releaseExecutorSlot(execution.executorAddress);

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
              execution,
              execution.executorAddress || cb.executorAddress,
            );
          }
          if (!stored) {
            await this.storeLogLines(cb.executionId, cb.logs);
          }
        }

        results.push({ executionId: cb.executionId, success: true });
      } catch (error: unknown) {
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
  ): Promise<TaskVersion> {
    const task = await this.taskRepo.findOne({ where: { id: taskId } });
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

    return this.taskRepo.save(task);
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
      .execute();

    if (!result.affected || result.affected === 0) {
      throw new BadRequestException(
        `Execution is in '${execution.status}' status (terminal state) and cannot be terminated`,
      );
    }

    await this.releaseExecutorSlot(execution.executorAddress);
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
 */
async function paginateLogStream(
  stream: Readable,
  fromLine: number,
  limit: number,
): Promise<{ lines: string[]; totalLines: number; hasMore: boolean }> {
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  const out: string[] = [];
  let idx = 0;
  for await (const line of rl) {
    if (idx >= fromLine && out.length < limit) out.push(line);
    idx++;
  }
  return {
    lines: out,
    totalLines: idx,
    hasMore: fromLine + out.length < idx,
  };
}
