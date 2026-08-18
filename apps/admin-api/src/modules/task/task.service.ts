import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  Inject,
  forwardRef,
} from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { DataSource, ILike, Not, Repository } from "typeorm";
import { InjectQueue } from "@nestjs/bullmq";
import { Queue } from "bullmq";
import { ConfigService } from "@nestjs/config";
import { Task, TaskStatus } from "./entities/task.entity";
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

/**
 * Detects truncation markers inserted by executors when callback logs exceed
 * the payload limit.
 * Node:   "... [logs truncated, original length N chars] ..."
 * Python: "...[truncated, total N chars]..."
 */
const LOG_TRUNCATION_MARKER = /\[\s*(?:logs\s+)?truncated\b/i;

@Injectable()
export class TaskService {
  private readonly logger = new Logger(TaskService.name);

  private normalizeTaskDto<T extends CreateTaskDto | UpdateTaskDto>(dto: T): T {
    const normalized = { ...dto } as T & {
      timeout?: number;
      timeoutSeconds?: number;
    };
    if (normalized.timeoutSeconds !== undefined) {
      normalized.timeout = normalized.timeoutSeconds;
      delete normalized.timeoutSeconds;
    }
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
    return this.taskRepo.save(this.taskRepo.create(normalized));
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
  ): Promise<void> {
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
    const updated = await this.taskRepo.save(
      Object.assign(t, this.normalizeTaskDto(dto)),
    );
    // Stop old schedule, then re-register based on new status without waiting for reload
    this.schedulerService.stop(id);
    if (updated.status === TaskStatus.ACTIVE) {
      await this.schedulerService.scheduleOne(updated);
    }
    return updated;
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
      },
    );
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
    const qb = this.execRepo
      .createQueryBuilder("e")
      .leftJoin("tasks", "t", "t.id = e.taskId")
      .addSelect(["t.name AS task_name"])
      .orderBy("e.createdAt", "DESC")
      .skip((p.page - 1) * p.pageSize)
      .take(p.pageSize);

    if (p.status) qb.andWhere("e.status = :status", { status: p.status });
    if (p.taskId) qb.andWhere("e.taskId = :taskId", { taskId: p.taskId });
    if (p.taskName)
      qb.andWhere("(e.taskName ILIKE :taskName OR t.name ILIKE :taskName)", {
        taskName: `%${p.taskName}%`,
      });
    if (p.executorAddress)
      qb.andWhere("e.executorAddress ILIKE :executorAddress", {
        executorAddress: `%${p.executorAddress}%`,
      });
    if (p.startTime)
      qb.andWhere("e.createdAt >= :startTime", { startTime: p.startTime });
    if (p.endTime)
      qb.andWhere("e.createdAt <= :endTime", { endTime: p.endTime });

    const [rawList, total] = await Promise.all([
      qb.getRawAndEntities(),
      qb.getCount(),
    ]);

    const taskNameMap = new Map<string, string>();
    rawList.raw.forEach((r: Record<string, unknown>) => {
      if (typeof r.e_taskId === "string" && typeof r.task_name === "string") {
        taskNameMap.set(r.e_taskId, r.task_name);
      }
    });

    const list = rawList.entities.map((e) => ({
      ...e,
      taskName: e.taskName || taskNameMap.get(e.taskId) || null,
    }));
    return paginate(list, total, p.page, p.pageSize);
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

    const { suggestedCron, reasoning } = await this.aiService.suggestSchedule(
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
   * SSE log streaming: polls DB for new log lines while execution is running,
   * then flushes remaining lines and sends [DONE] when execution finishes.
   * Caller is responsible for writing SSE headers and closing the response.
   */
  async streamExecutionLogs(
    execId: string,
    send: (line: string) => void,
    done: () => void,
    signal: AbortSignal,
  ): Promise<void> {
    let nextLine = 0;
    const POLL_INTERVAL = 1000; // ms
    const MAX_RUNTIME = 30 * 60 * 1000; // 30 min safety cap
    const start = Date.now();

    const flush = async (): Promise<boolean> => {
      // Returns true when execution is terminal and no more lines pending
      const exec = await this.execRepo.findOne({ where: { id: execId } });
      if (!exec) return true;

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
      },
    );
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

  /** Delete stale lines then bulk-insert in chunks (idempotent on retry). */
  private async storeLogLines(
    executionId: string,
    logs: string | string[],
  ): Promise<void> {
    await this.logLineRepo.delete({ executionId });
    const lines = typeof logs === "string" ? logs.split("\n") : logs;
    const entities = lines.map((content, i) =>
      this.logLineRepo.create({ executionId, lineNumber: i, content }),
    );
    const CHUNK = 500;
    for (let i = 0; i < entities.length; i += CHUNK) {
      await this.logLineRepo.save(entities.slice(i, i + CHUNK));
    }
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
      // Page through the executor's log endpoint. Node executors return all
      // remaining lines in one shot (they ignore `limit`); Python executors
      // cap each response at `limit` (max 2000) and report totalLines/hasMore.
      const PAGE_LIMIT = 2000;
      const MAX_PAGES = 200; // hard cap: 400k-line backfill ceiling
      const lines: string[] = [];
      let fromLine = 0;
      for (let page = 0; page < MAX_PAGES; page++) {
        const resp = await axios.get(url, {
          headers,
          timeout: 10_000,
          params: { fromLine, limit: PAGE_LIMIT },
        });
        const chunk: string[] = Array.isArray(resp.data?.lines)
          ? resp.data.lines.filter(
              (l: unknown) => typeof l === "string",
            )
          : [];
        if (chunk.length === 0) break;
        // Batch pushes stay below the engine's spread-argument limit; a Node
        // executor may return the entire log in a single chunk.
        for (let i = 0; i < chunk.length; i += 10_000) {
          lines.push(...chunk.slice(i, i + 10_000));
        }
        fromLine += chunk.length;
        const total: unknown = resp.data?.totalLines;
        if (typeof total !== "number" || total <= 0 || fromLine >= total) {
          break;
        }
      }
      if (lines.length === 0) return false;
      // Pass the array directly — avoids a join+split round-trip of what
      // can be a multi-megabyte string.
      await this.storeLogLines(execution.id, lines);
      this.logger.log(
        `Backfilled ${lines.length} full log lines for execution ${execution.id}`,
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

        if (
          execution.executorAddress &&
          cb.executorAddress &&
          execution.executorAddress !== cb.executorAddress
        ) {
          results.push({
            executionId: cb.executionId,
            success: false,
            error: "Executor address mismatch",
          });
          continue;
        }

        // Idempotency: skip if already in a terminal state
        const terminalStatuses = [
          ExecutionStatus.SUCCESS,
          ExecutionStatus.FAILED,
          ExecutionStatus.TIMEOUT,
          ExecutionStatus.KILLED,
          ExecutionStatus.CANCELLED,
        ];
        if (terminalStatuses.includes(execution.status)) {
          results.push({ executionId: cb.executionId, success: true });
          continue;
        }

        if (cb.status === "success") {
          execution.status = ExecutionStatus.SUCCESS;
          execution.failureReason = null;
        } else {
          const failureReason =
            cb.failureReason ??
            this.inferFailureReason(cb.errorMessage, cb.logs, cb.exitCode);
          execution.status =
            failureReason === ExecutionFailureReason.TIMEOUT
              ? ExecutionStatus.TIMEOUT
              : ExecutionStatus.FAILED;
          execution.failureReason = failureReason;
          if (cb.errorMessage !== undefined) {
            execution.errorMessage = cb.errorMessage;
          }
        }
        execution.endTime = new Date();
        execution.duration = cb.durationMs;
        if (cb.logs) {
          execution.logs = cb.logs;
        }

        await this.execRepo.save(execution);

        // Decrement executor runningTaskCount on task completion (success or failure).
        // The counter was incremented at dispatch time; it must be decremented here
        // so executors are not permanently counted as busy after each task.
        await this.releaseExecutorSlot(execution.executorAddress);

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
    if (
      execution.status !== ExecutionStatus.RUNNING &&
      execution.status !== ExecutionStatus.PENDING
    ) {
      throw new BadRequestException(
        `Execution is in '${execution.status}' status and cannot be terminated`,
      );
    }
    execution.status = ExecutionStatus.KILLED;
    execution.endTime = new Date();
    if (execution.startTime) {
      execution.duration = Date.now() - new Date(execution.startTime).getTime();
    }
    execution.errorMessage = "Manually terminated by administrator";
    execution.failureReason = ExecutionFailureReason.KILLED;
    await this.execRepo.save(execution);
    await this.releaseExecutorSlot(execution.executorAddress);
    this.logger.warn(`Execution ${execId} has been manually terminated`);
    return { success: true, message: "Execution marked as terminated" };
  }
}
