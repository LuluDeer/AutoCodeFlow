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
import { InjectQueue } from "@nestjs/bull";
import { Queue } from "bull";
import { Task, TaskStatus } from "./entities/task.entity";
import {
  TaskExecution,
  ExecutionStatus,
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

@Injectable()
export class TaskService {
  private readonly logger = new Logger(TaskService.name);

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
  ) {}

  async create(dto: CreateTaskDto) {
    if (dto.dependencies && Object.keys(dto.dependencies).length > 0) {
      await this.checkCircularDependency(dto.id, dto.dependencies);
    }
    return this.taskRepo.save(this.taskRepo.create(dto));
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
    const updated = await this.taskRepo.save(Object.assign(t, dto));
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
        backoff: task.maxRetry && task.maxRetry > 1
          ? { type: 'exponential', delay: 10_000 }
          : undefined,
      },
    );
    return exec;
  }

  async getExecutions(
    taskId: string,
    p: PaginationDto & { status?: string },
  ) {
    const where: Record<string, unknown> = { taskId };
    if (p.status) where['status'] = p.status;

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
      if (typeof r.e_taskId === 'string' && typeof r.task_name === 'string') {
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
      order: { createdAt: 'DESC' },
      take: 50,
    });

    const successCount = executions.filter((e) => e.status === ExecutionStatus.SUCCESS).length;
    const failCount = executions.filter((e) => e.status === ExecutionStatus.FAILED || e.status === ExecutionStatus.TIMEOUT).length;
    const durations = executions.filter((e) => e.duration != null).map((e) => e.duration!);
    const avgDuration = durations.length > 0 ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : 0;
    const p95Duration = durations.length > 0 ? durations.sort((a, b) => a - b)[Math.floor(durations.length * 0.95)] : 0;

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
      `Current cron: ${task.cronExpression || 'none'}`,
      `Total executions sampled: ${executions.length}`,
      `Successes: ${successCount}, Failures/Timeouts: ${failCount}`,
      `Avg duration: ${avgDuration}ms, P95 duration: ${p95Duration}ms`,
      `Timeout setting: ${task.timeout || 'default'}ms`,
      `Hours with most successes (UTC): ${bestHours.join(', ')}`,
    ].join('\n');

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
    const succeeded = recent.filter((e) => e.status === ExecutionStatus.SUCCESS).length;
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
    return { recentExecutions: recent, successRate, avgDuration, totalRuns: total };
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
    const logContent = [exec.errorMessage, exec.logs].filter(Boolean).join("\n") || "(no logs)";
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
        signal.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true });
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
        backoff: task.maxRetry && task.maxRetry > 1
          ? { type: 'exponential', delay: 10_000 }
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

  async handleCallback(
    callbacks: Array<{
      executionId: string;
      status: "success" | "failed";
      exitCode?: number;
      logs?: string;
      errorMessage?: string;
      durationMs?: number;
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

        // Idempotency: skip if already in a terminal state
        if (
          execution.status === ExecutionStatus.SUCCESS ||
          execution.status === ExecutionStatus.FAILED
        ) {
          results.push({ executionId: cb.executionId, success: true });
          continue;
        }

        execution.status =
          cb.status === "success"
            ? ExecutionStatus.SUCCESS
            : ExecutionStatus.FAILED;
        execution.endTime = new Date();
        execution.duration = cb.durationMs;

        if (cb.status === "failed") {
          execution.errorMessage = cb.errorMessage;
        }

        if (cb.logs) {
          execution.logs = cb.logs;
          // Delete stale lines first (idempotent on retry), then bulk-insert new ones
          await this.logLineRepo.delete({ executionId: cb.executionId });
          const logLines = cb.logs.split("\n");
          const entities = logLines.map((content, i) =>
            this.logLineRepo.create({
              executionId: cb.executionId,
              lineNumber: i,
              content,
            }),
          );
          if (entities.length > 0) {
            await this.logLineRepo.save(entities);
          }
        }

        await this.execRepo.save(execution);

        // Decrement executor runningTaskCount on task completion (success or failure).
        // The counter was incremented at dispatch time; it must be decremented here
        // so executors are not permanently counted as busy after each task.
        // Uses GREATEST to guard against races / double-decrement.
        if (execution.executorAddress) {
          await this.dataSource
            .createQueryBuilder()
            .update('executors')
            .set({ runningTaskCount: () => 'GREATEST("runningTaskCount" - 1, 0)' })
            .where('address = :addr', { addr: execution.executorAddress })
            .execute();
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
      .createQueryBuilder('v')
      .select('MAX(CAST(SUBSTR(v.version, 2) AS INTEGER))', 'maxNum')
      .where('v.taskId = :taskId', { taskId })
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
  async killExecution(execId: string): Promise<{ success: boolean; message: string }> {
    const execution = await this.execRepo.findOne({ where: { id: execId } });
    if (!execution) {
      throw new NotFoundException(`Execution ${execId} not found`);
    }
    if (execution.status !== ExecutionStatus.RUNNING && execution.status !== ExecutionStatus.PENDING) {
      throw new BadRequestException(`Execution is in '${execution.status}' status and cannot be terminated`);
    }
    execution.status = ExecutionStatus.KILLED;
    execution.endTime = new Date();
    if (execution.startTime) {
      execution.duration = Date.now() - new Date(execution.startTime).getTime();
    }
    execution.errorMessage = 'Manually terminated by administrator';
    await this.execRepo.save(execution);
    this.logger.warn(`Execution ${execId} has been manually terminated`);
    return { success: true, message: 'Execution marked as terminated' };
  }
}
