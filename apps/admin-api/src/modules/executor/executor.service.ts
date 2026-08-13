import {
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectQueue } from "@nestjs/bullmq";
import type { Queue } from "bullmq";
import { randomBytes, timingSafeEqual } from "crypto";
import * as bcrypt from "bcrypt";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository, LessThan, In } from "typeorm";
import { Cron } from "@nestjs/schedule";
import axios from "axios";
import { Executor, ExecutorStatus } from "./entities/executor.entity";
import {
  TaskExecution,
  ExecutionFailureReason,
  ExecutionStatus,
} from "../task/entities/task-execution.entity";
import { Task } from "../task/entities/task.entity";
import { PaginationDto } from "../../common/dto/pagination.dto";
import { NotificationService } from "../notification/notification.service";
import { SystemConfigService } from "../config/config.service";

@Injectable()
export class ExecutorService {
  private readonly logger = new Logger(ExecutorService.name);
  private readonly protocol: string;

  constructor(
    @InjectRepository(Executor) private repo: Repository<Executor>,
    @InjectRepository(TaskExecution)
    private execRepo: Repository<TaskExecution>,
    @InjectRepository(Task) private taskRepo: Repository<Task>,
    @InjectQueue("task-queue") private taskQueue: Queue,
    private readonly configService: ConfigService,
    private readonly notificationService: NotificationService,
    private readonly systemConfigService: SystemConfigService,
  ) {
    this.protocol = this.configService.get<string>("app.protocol") || "http";
  }

  public getExecutorUrl(address: string, path: string): string {
    if (address.startsWith("http://") || address.startsWith("https://")) {
      return `${address}/${path}`;
    }
    return `${this.protocol}://${address}/${path}`;
  }

  private async getSharedToken(): Promise<string> {
    try {
      const cfg = await this.systemConfigService.findOne(
        "executor.sharedToken",
      );
      if (cfg?.value) return cfg.value;
    } catch {
      // DB token is optional; fall back to environment/config-file value.
    }
    return this.configService.get<string>("executor.sharedToken") ?? "";
  }

  private async releaseExecutorSlot(address?: string | null): Promise<void> {
    if (!address) return;
    await this.repo
      .createQueryBuilder()
      .update(Executor)
      .set({ runningTaskCount: () => 'GREATEST("runningTaskCount" - 1, 0)' })
      .where("address = :address", { address })
      .execute();
  }

  private parseExecutorStartedAt(value?: string | Date | null): Date | null {
    if (!value) return null;
    const date = value instanceof Date ? value : new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  private hasExecutorRestarted(
    executor: Executor,
    incomingStartedAt: Date | null,
    incomingStartupId: string | null,
  ): boolean {
    if (
      incomingStartupId &&
      executor.executorStartupId &&
      incomingStartupId !== executor.executorStartupId
    ) {
      return true;
    }
    if (
      incomingStartedAt &&
      executor.executorStartedAt &&
      incomingStartedAt.getTime() > executor.executorStartedAt.getTime()
    ) {
      return true;
    }
    return false;
  }

  private async scheduleRetryAfterRestart(
    task: Task,
    execution: TaskExecution,
  ): Promise<void> {
    const maxAttempts = Math.max(1, task.maxRetry ?? 1);
    const nextRetryCount = (execution.retryCount ?? 0) + 1;
    if (nextRetryCount >= maxAttempts) return;

    const retryExecution = this.execRepo.create({
      taskId: task.id,
      taskName: task.name,
      status: ExecutionStatus.PENDING,
      params: execution.params ?? task.params,
      triggerType: execution.triggerType ?? "executor_restart",
      taskVersion: execution.taskVersion ?? task.currentVersion,
      retryCount: nextRetryCount,
    });
    const saved = await this.execRepo.save(retryExecution);
    try {
      await this.taskQueue.add(
        "execute",
        { executionId: saved.id },
        {
          attempts: Math.max(1, maxAttempts - nextRetryCount),
          backoff:
            task.retryDelay > 0
              ? { type: "exponential", delay: task.retryDelay * 1000 }
              : undefined,
        },
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.execRepo.delete(saved.id).catch((deleteErr) => {
        const deleteMessage =
          deleteErr instanceof Error ? deleteErr.message : String(deleteErr);
        this.logger.warn(
          `Failed to delete unscheduled retry execution ${saved.id}: ${deleteMessage}`,
        );
      });
      this.logger.warn(
        `Failed to enqueue restart retry for execution ${execution.id}: ${message}`,
      );
    }
  }

  private shouldFailAfterRestart(
    execution: TaskExecution,
    onlyStartedBefore?: Date | null,
  ): boolean {
    if (!onlyStartedBefore) return true;
    if (!execution.startTime) return true;
    return execution.startTime.getTime() < onlyStartedBefore.getTime();
  }

  private async failRunningExecutionsAfterRestart(
    executorAddress: string,
    onlyStartedBefore?: Date | null,
  ): Promise<number> {
    const runningExecutions = await this.execRepo.find({
      where: {
        executorAddress,
        status: ExecutionStatus.RUNNING,
      },
    });
    const executionsToFail = runningExecutions.filter((execution) =>
      this.shouldFailAfterRestart(execution, onlyStartedBefore),
    );
    for (const execution of executionsToFail) {
      const task = execution.taskId
        ? await this.taskRepo.findOne({ where: { id: execution.taskId } })
        : null;
      execution.status = ExecutionStatus.FAILED;
      execution.endTime = new Date();
      execution.failureReason = ExecutionFailureReason.EXECUTOR_RESTART;
      execution.errorMessage =
        "[System] Executor restarted before reporting completion";
      execution.logs = `${execution.logs || ""}\n[System] Executor restarted; execution marked as FAILED`;
      await this.execRepo.save(execution);
      await this.releaseExecutorSlot(execution.executorAddress);
      if (task) await this.scheduleRetryAfterRestart(task, execution);
    }
    if (executionsToFail.length > 0) {
      this.logger.warn(
        `Marked ${executionsToFail.length} running execution(s) as FAILED after executor restart: ${executorAddress}`,
      );
    }
    return executionsToFail.length;
  }

  async register(data: {
    appName: string;
    address: string;
    type?: string;
    version?: string;
    capabilities?: string[];
    runtime?: string[];
    maxConcurrentTasks?: number;
    maxConcurrent?: number;
    groupName?: string | null;
    tags?: string[] | null;
    description?: string | null;
    restartedAt?: string | Date | null;
    startupId?: string | null;
  }) {
    let e: Executor | null = await this.repo.findOne({
      where: { address: data.address },
    });
    const isFirstTime = !e;
    const capabilities = data.capabilities ?? data.runtime;
    const maxConcurrentTasks = data.maxConcurrentTasks ?? data.maxConcurrent;
    const incomingStartedAt = this.parseExecutorStartedAt(data.restartedAt);
    const incomingStartupId = data.startupId?.trim() || null;
    const hasStartupBaseline = Boolean(e?.executorStartupId || e?.executorStartedAt);
    const didRestart = e
      ? this.hasExecutorRestarted(e, incomingStartedAt, incomingStartupId)
      : false;
    const shouldRecoverMissingBaseline = Boolean(
      e && !didRestart && !hasStartupBaseline && incomingStartedAt,
    );
    if (!e) e = this.repo.create(data as Partial<Executor>);
    // Update mutable fields on registration/re-registration
    if (data.type) e.type = data.type as any;
    if (data.appName) e.appName = data.appName;
    if (data.version) e.version = data.version;
    if (capabilities) e.capabilities = capabilities;
    if (maxConcurrentTasks !== undefined)
      e.maxConcurrentTasks = maxConcurrentTasks;
    if (data.groupName !== undefined) e.groupName = data.groupName;
    if (data.tags !== undefined) e.tags = data.tags;
    if (data.description !== undefined) e.description = data.description;
    if (didRestart) {
      await this.failRunningExecutionsAfterRestart(data.address);
    } else if (shouldRecoverMissingBaseline) {
      await this.failRunningExecutionsAfterRestart(data.address, incomingStartedAt);
    }
    if (incomingStartedAt) e.executorStartedAt = incomingStartedAt;
    if (incomingStartupId) e.executorStartupId = incomingStartupId;
    e.status = ExecutorStatus.ONLINE;
    e.lastHeartbeat = new Date();
    const saved = await this.repo.save(e);
    // E-03: send notification on first registration
    if (isFirstTime) {
      this.notificationService
        .notifyExecutorOnline(data.appName, data.address)
        .catch((err) =>
          this.logger.warn(
            `Failed to send executor online notification: ${err?.message}`,
          ),
        );
    }
    return saved;
  }

  async heartbeat(
    address: string,
    metrics: {
      cpuUsage?: number;
      memUsage?: number;
      diskUsage?: number;
      networkLatency?: number;
      runningTaskCount?: number;
      totalTaskCount?: number;
      failedTaskCount?: number;
      restartedAt?: string | Date | null;
      startupId?: string | null;
    },
  ) {
    const e = await this.repo.findOne({ where: { address } });
    if (!e) throw new NotFoundException("Executor not found");
    const incomingStartedAt = this.parseExecutorStartedAt(metrics.restartedAt);
    const incomingStartupId = metrics.startupId?.trim() || null;
    const hasStartupBaseline = Boolean(e.executorStartupId || e.executorStartedAt);
    const didRestart = this.hasExecutorRestarted(
      e,
      incomingStartedAt,
      incomingStartupId,
    );
    const shouldRecoverMissingBaseline = Boolean(
      !didRestart && !hasStartupBaseline && incomingStartedAt,
    );
    const { restartedAt, startupId, ...metricValues } = metrics;
    if (didRestart) {
      await this.failRunningExecutionsAfterRestart(address);
    } else if (shouldRecoverMissingBaseline) {
      await this.failRunningExecutionsAfterRestart(address, incomingStartedAt);
    }
    Object.assign(e, metricValues, {
      status: ExecutorStatus.ONLINE,
      lastHeartbeat: new Date(),
    });
    if (incomingStartedAt) e.executorStartedAt = incomingStartedAt;
    if (incomingStartupId) e.executorStartupId = incomingStartupId;
    const saved = await this.repo.save(e);
    return saved;
  }

  findAll() {
    return this.repo.find({ order: { createdAt: "DESC" } });
  }

  async findOne(id: string): Promise<Executor> {
    const executor = await this.repo.findOne({ where: { id } });
    if (!executor) throw new NotFoundException("Executor not found");
    return executor;
  }

  /**
   * Update executor metadata (group, tags, description, maxConcurrentTasks).
   */
  async update(
    id: string,
    data: {
      groupName?: string | null;
      tags?: string[] | null;
      description?: string | null;
      maxConcurrentTasks?: number | null;
    },
  ): Promise<Executor> {
    const executor = await this.findOne(id);
    Object.assign(executor, data);
    return this.repo.save(executor);
  }

  /**
   * Get all unique executor groups.
   */
  async getGroups(): Promise<string[]> {
    const execs = await this.repo
      .createQueryBuilder("e")
      .select("DISTINCT e.groupName", "groupName")
      .where("e.groupName IS NOT NULL")
      .getRawMany();
    return execs.map((x) => x.groupName).filter(Boolean);
  }

  /**
   * Get all unique executor tags.
   */
  async getTags(): Promise<string[]> {
    const execs = await this.repo.find();
    const tagSet = new Set<string>();
    execs.forEach((e) => {
      if (e.tags) e.tags.forEach((tag) => tagSet.add(tag));
    });
    return Array.from(tagSet).sort();
  }

  /**
   * Select the least-loaded online executor.
   * Filters to the given group/tags/runtime when provided.
   * Throws if no eligible executor is available or all are at capacity.
   */
  async selectLeastLoaded(opts?: {
    group?: string | null;
    tags?: string[] | null;
    runtime?: string | null;
  }): Promise<Executor> {
    const all = await this.repo.find({
      where: { status: ExecutorStatus.ONLINE },
    });
    if (all.length === 0) {
      throw new ServiceUnavailableException("No online executors available");
    }

    let candidates = all;

    if (opts?.group) {
      candidates = candidates.filter((e) => e.groupName === opts.group);
    }
    if (opts?.tags && opts.tags.length > 0) {
      candidates = candidates.filter((e) => {
        if (!e.tags) return false;
        return opts.tags!.every((tag) => e.tags!.includes(tag));
      });
    }
    if (opts?.runtime) {
      candidates = candidates.filter((e) =>
        !e.capabilities || e.capabilities.length === 0
          ? true
          : e.capabilities.includes(opts.runtime!),
      );
    }

    if (candidates.length === 0) {
      throw new ServiceUnavailableException(
        "No online executors match the requested group/tags/runtime",
      );
    }

    // Weighted scoring: 50% task load ratio, 25% CPU, 25% memory.
    // Executors at or above max capacity are excluded before scoring.
    const scored = candidates
      .filter((e) => {
        const max = e.maxConcurrentTasks ?? Infinity;
        return e.runningTaskCount < max;
      })
      .map((e) => {
        const max = e.maxConcurrentTasks ?? 10;
        const loadScore = e.runningTaskCount / max;
        const cpuScore = (e.cpuUsage ?? 0) / 100;
        const memScore = (e.memUsage ?? 0) / 100;
        const score = loadScore * 0.5 + cpuScore * 0.25 + memScore * 0.25;
        return { executor: e, score };
      })
      .sort((a, b) => a.score - b.score);

    if (scored.length === 0) {
      throw new ServiceUnavailableException(
        "No available executor — all online executors are at maximum capacity",
      );
    }
    return scored[0].executor;
  }

  async dispatch(task: Task, execution: TaskExecution) {
    const all = await this.repo.find({
      where: { status: ExecutorStatus.ONLINE },
    });

    let candidates = all;

    // 1. Exact match by appName (manually specified by user)
    if (task.executorAppName) {
      candidates = all.filter((e) => e.appName === task.executorAppName);
      if (candidates.length === 0) {
        throw new Error(
          `No available executor with appName "${task.executorAppName}"`,
        );
      }
    } else {
      // 2. Filter by group/tag/runtime
      let filtered = all;

      // 2.1 Filter by group
      if (task.executorGroup) {
        filtered = filtered.filter((e) => e.groupName === task.executorGroup);
      }

      // 2.2 Filter by tag (task required tags must be a subset of executor tags)
      if (task.executorTags && task.executorTags.length > 0) {
        filtered = filtered.filter((e) => {
          if (!e.tags) return false;
          return task.executorTags!.every((tag) => e.tags!.includes(tag));
        });
      }

      // 2.3 Filter by runtime/capabilities
      if (task.runtime) {
        filtered = filtered.filter((e) =>
          !e.capabilities || e.capabilities.length === 0
            ? true
            : e.capabilities.includes(task.runtime),
        );
      }

      if (filtered.length === 0) {
        throw new Error(
          "No online executors match the requested group/tags/runtime",
        );
      }
      candidates = filtered;
    }

    // 3. Weighted scoring (load 50%+CPU 25%+mem 25%), try optimistic lock in order
    const sorted = [...candidates].sort((a, b) => {
      const maxA = a.maxConcurrentTasks ?? 10;
      const maxB = b.maxConcurrentTasks ?? 10;
      const scoreA =
        (a.runningTaskCount / maxA) * 0.5 +
        ((a.cpuUsage ?? 0) / 100) * 0.25 +
        ((a.memUsage ?? 0) / 100) * 0.25;
      const scoreB =
        (b.runningTaskCount / maxB) * 0.5 +
        ((b.cpuUsage ?? 0) / 100) * 0.25 +
        ((b.memUsage ?? 0) / 100) * 0.25;
      return scoreA - scoreB;
    });

    let matched: Executor | null = null;
    for (const candidate of sorted) {
      const maxConcurrent = candidate.maxConcurrentTasks ?? Infinity;
      // Optimistic lock: only increment when runningTaskCount < maxConcurrentTasks
      const result = await this.repo
        .createQueryBuilder()
        .update(Executor)
        .set({ runningTaskCount: () => '"runningTaskCount" + 1' })
        .where("id = :id", { id: candidate.id })
        .andWhere("status = :status", { status: ExecutorStatus.ONLINE })
        .andWhere(
          maxConcurrent === Infinity ? "1=1" : '"runningTaskCount" < :max',
          maxConcurrent === Infinity ? {} : { max: maxConcurrent },
        )
        .execute();
      if (result.affected && result.affected > 0) {
        matched = candidate;
        candidate.runningTaskCount += 1; // sync local state after DB increment
        break;
      }
    }

    if (!matched)
      throw new Error(
        "No available executor (all at capacity or concurrency conflict)",
      );

    this.logger.log(
      `Dispatching task "${task.name}" to executor ${matched.address} (runningTasks=${matched.runningTaskCount})`,
    );
    execution.executorAddress = matched.address;

    try {
      const sharedToken = await this.getSharedToken();
      const headers: Record<string, string> = {};
      if (sharedToken) headers["Authorization"] = `Bearer ${sharedToken}`;
      const resp = await axios.post(
        this.getExecutorUrl(matched.address, "api/execute"),
        { executionId: execution.id, task, params: execution.params },
        { timeout: ((task.timeout || 300) + 10) * 1000, headers },
      );
      return resp.data;
    } catch (err: unknown) {
      // Rollback counter on dispatch failure to avoid leaks
      await this.repo
        .createQueryBuilder()
        .update(Executor)
        .set({ runningTaskCount: () => 'GREATEST("runningTaskCount" - 1, 0)' })
        .where("id = :id", { id: matched.id })
        .execute();
      throw err;
    }
  }

  /**
   * Broadcast dispatch: send the task to ALL online executors simultaneously.
   * Used when task.executeMode === ExecuteMode.BROADCAST.
   * Returns a list of results for each executor.
   */
  async dispatchBroadcast(
    task: Task,
    execution: TaskExecution,
  ): Promise<any[]> {
    const all = await this.repo.find({
      where: { status: ExecutorStatus.ONLINE },
    });
    let candidates = all;

    // Apply same filters as dispatch
    if (task.executorAppName) {
      candidates = all.filter((e) => e.appName === task.executorAppName);
    } else {
      let filtered = all;
      if (task.executorGroup) {
        filtered = filtered.filter((e) => e.groupName === task.executorGroup);
      }
      if (task.executorTags && task.executorTags.length > 0) {
        filtered = filtered.filter((e) => {
          if (!e.tags) return false;
          return task.executorTags!.every((tag) => e.tags!.includes(tag));
        });
      }
      if (task.runtime) {
        filtered = filtered.filter((e) =>
          !e.capabilities || e.capabilities.length === 0
            ? true
            : e.capabilities.includes(task.runtime),
        );
      }
      if (filtered.length === 0) {
        throw new Error(
          "No online executors match the requested group/tags/runtime",
        );
      }
      candidates = filtered;
    }

    if (candidates.length === 0) {
      throw new Error("No available executor for broadcast dispatch");
    }

    this.logger.log(
      `Broadcasting task "${task.name}" to ${candidates.length} executors`,
    );

    // Fire all dispatches in parallel and collect results
    const sharedToken = await this.getSharedToken();
    const broadcastHeaders: Record<string, string> = {};
    if (sharedToken)
      broadcastHeaders["Authorization"] = `Bearer ${sharedToken}`;

    const results = await Promise.allSettled(
      candidates.map(async (executor) => {
        const dispatchUrl = this.getExecutorUrl(
          executor.address,
          "api/execute",
        );
        const resp = await axios.post(
          dispatchUrl,
          { executionId: execution.id, task, params: execution.params },
          {
            timeout: ((task.timeout || 300) + 10) * 1000,
            headers: broadcastHeaders,
          },
        );
        return { executor: executor.address, result: resp.data };
      }),
    );

    const successes: { executor: string; result: unknown }[] = [];
    const failures: string[] = [];
    results.forEach((r, i) => {
      if (r.status === "fulfilled") {
        successes.push(r.value);
      } else {
        const errMsg =
          r.reason instanceof Error ? r.reason.message : String(r.reason);
        failures.push(`${candidates[i].address}: ${errMsg}`);
      }
    });

    if (failures.length > 0) {
      this.logger.warn(
        `Broadcast partially failed for task "${task.name}": ${failures.join("; ")}`,
      );
    }

    if (successes.length === 0) {
      throw new Error(
        `Broadcast failed on all ${candidates.length} executors: ${failures.join("; ")}`,
      );
    }

    return successes;
  }

  /** Scan every 5 min for RUNNING executions that timed out with offline executor to prevent zombie tasks */
  @Cron("0 */5 * * * *")
  async detectLostExecutions() {
    // N12: use a 5-min broad threshold so any task older than the minimum buffer
    // is considered for per-execution checks (real timeout logic is applied per-row below).
    // A 24-hour threshold was too large — tasks with short timeouts were left as zombie
    // for up to 24h even when their executor went offline.
    const broadThreshold = new Date(Date.now() - 5 * 60 * 1000);
    const lostExecs = await this.execRepo
      .createQueryBuilder("exec")
      .where("exec.status = :status", { status: ExecutionStatus.RUNNING })
      .andWhere("exec.startTime < :threshold", { threshold: broadThreshold })
      .getMany();
    if (lostExecs.length === 0) return;

    // Batch-fetch tasks and executors to avoid N+1 queries
    const taskIds = [
      ...new Set(lostExecs.map((e) => e.taskId).filter(Boolean)),
    ] as string[];
    const taskMap = new Map(
      taskIds.length > 0
        ? (await this.taskRepo.findBy({ id: In(taskIds) })).map((t) => [
            t.id,
            t,
          ])
        : [],
    );
    const addresses = [
      ...new Set(lostExecs.map((e) => e.executorAddress).filter(Boolean)),
    ] as string[];
    const executorMap = new Map(
      addresses.length > 0
        ? (await this.repo.findBy({ address: In(addresses) })).map((ex) => [
            ex.address,
            ex,
          ])
        : [],
    );

    for (const exec of lostExecs) {
      const task = exec.taskId ? (taskMap.get(exec.taskId) ?? null) : null;
      const taskTimeoutMs = task?.timeout ? task.timeout * 1000 : 5 * 60 * 1000;
      const perExecThreshold = new Date(
        Date.now() - (taskTimeoutMs + 5 * 60 * 1000),
      );
      if (exec.startTime && exec.startTime > perExecThreshold) {
        // Not yet past this task's timeout+buffer — skip
        continue;
      }
      if (exec.executorAddress) {
        const executor = executorMap.get(exec.executorAddress);
        if (executor && executor.status === ExecutorStatus.ONLINE) continue;
      }
      exec.status = ExecutionStatus.FAILED;
      exec.endTime = new Date();
      exec.errorMessage =
        "[System] Executor offline or task timed out, marked as failed by scheduler";
      exec.logs =
        (exec.logs || "") +
        "\n[System] Execution timed out without callback, forcefully marked as FAILED";
      await this.execRepo.save(exec);
      await this.releaseExecutorSlot(exec.executorAddress);
      this.logger.warn(
        `Lost execution marked FAILED: execId=${exec.id}, taskId=${exec.taskId}`,
      );
    }
  }

  /** Q7: Daily at 2am, clean up old execution records (90d) and audit logs (180d) to prevent DB bloat */
  @Cron("0 0 2 * * *")
  async cleanupOldRecords(): Promise<void> {
    const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
    const execResult = await this.execRepo.delete({
      createdAt: LessThan(ninetyDaysAgo),
    });
    if (execResult.affected && execResult.affected > 0) {
      this.logger.log(
        `Q7 Cleanup: removed ${execResult.affected} old task executions (>90 days)`,
      );
    }
  }

  /** Auto-scan every 30s, mark executors with expired heartbeat as OFFLINE */
  @Cron("*/30 * * * * *")
  async markStaleOffline() {
    // Calculate timeout using configured heartbeat interval and timeout multiplier
    const heartbeatInterval =
      this.configService.get<number>("executor.heartbeatInterval") || 30000;
    const timeoutMultiplier =
      this.configService.get<number>("executor.heartbeatTimeoutMultiplier") ||
      3;
    const timeoutMs = heartbeatInterval * timeoutMultiplier;
    const cutoff = new Date(Date.now() - timeoutMs);

    // Query before update to capture names/addresses for offline notifications
    const staleExecutors = await this.repo.find({
      where: { status: ExecutorStatus.ONLINE, lastHeartbeat: LessThan(cutoff) },
      select: ["id", "appName", "address"],
    });

    if (staleExecutors.length === 0) return;

    const result = await this.repo.update(
      { status: ExecutorStatus.ONLINE, lastHeartbeat: LessThan(cutoff) },
      { status: ExecutorStatus.OFFLINE },
    );
    if (result.affected && result.affected > 0) {
      this.logger.warn(
        `Marked ${result.affected} executor(s) as OFFLINE due to heartbeat timeout (${timeoutMs}ms)`,
      );
      // Fire offline notifications — fire-and-forget, errors must not break the cron job
      for (const exec of staleExecutors) {
        this.notificationService
          .notifyExecutorOffline(exec.appName, exec.address)
          .catch((e: Error) =>
            this.logger.error(
              `Failed to send offline notification for ${exec.address}: ${e.message}`,
            ),
          );
      }
    }
  }

  /** Run hourly, clean up executor records offline for more than 7 days */
  @Cron("0 0 * * * *")
  async cleanupOfflineExecutors() {
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const result = await this.repo.delete({
      status: ExecutorStatus.OFFLINE,
      lastHeartbeat: LessThan(sevenDaysAgo),
    });
    if (result.affected && result.affected > 0) {
      this.logger.log(
        `Cleaned up ${result.affected} offline executor(s) (>7 days)`,
      );
    }
  }

  /**
   * SEC-03: Issue a fresh per-executor token.
   * Returns the raw token once (caller must store it); only the bcrypt hash is persisted.
   */
  async rotateToken(id: string): Promise<{ token: string }> {
    const executor = await this.repo.findOne({ where: { id } });
    if (!executor) throw new NotFoundException("Executor not found");
    const rawToken = randomBytes(32).toString("hex");
    executor.tokenHash = await bcrypt.hash(rawToken, 12);
    await this.repo.save(executor);
    this.logger.log(`Rotated token for executor ${id} (${executor.address})`);
    return { token: rawToken };
  }

  /**
   * SEC-03: Validate a per-executor token.
   * Falls back to the legacy shared token for backward compatibility.
   */
  /** Admin: manually remove an executor record by ID */
  async removeById(id: string): Promise<void> {
    const executor = await this.repo.findOne({ where: { id } });
    if (!executor) throw new NotFoundException("Executor not found");
    await this.repo.remove(executor);
    this.logger.log(`Executor ${id} (${executor.address}) removed by admin`);
  }

  async validateExecutorToken(id: string, presented: string): Promise<boolean> {
    const executor = await this.repo
      .createQueryBuilder("e")
      .addSelect("e.tokenHash")
      .where("e.id = :id", { id })
      .getOne();
    if (!executor) return false;
    if (executor.tokenHash) {
      return bcrypt.compare(presented, executor.tokenHash);
    }
    const shared = await this.getSharedToken();
    if (shared.length === 0) return false;
    // SEC-FIX: use timingSafeEqual to prevent timing attacks on shared token comparison
    const sharedBuf = Buffer.from(shared, "utf8");
    const presentedBuf = Buffer.from(presented, "utf8");
    if (sharedBuf.length !== presentedBuf.length) return false;
    return timingSafeEqual(sharedBuf, presentedBuf);
  }

  /**
   * SEC-03: Validate executor token by address (used for heartbeat/register validation).
   * Supports both per-executor dynamic tokens and the legacy shared token.
   */
  async validateTokenByAddress(
    address: string,
    presented: string,
  ): Promise<boolean> {
    // First try to validate against per-executor token
    const executor = await this.repo
      .createQueryBuilder("e")
      .addSelect("e.tokenHash")
      .where("e.address = :address", { address })
      .getOne();

    if (executor && executor.tokenHash) {
      const isValid = await bcrypt.compare(presented, executor.tokenHash);
      if (isValid) return true;
    }

    // Fall back to shared token — use timing-safe comparison to prevent timing attacks
    const shared = await this.getSharedToken();
    if (shared.length === 0) return false;
    const sharedBuf = Buffer.from(shared, "utf8");
    const presentedBuf = Buffer.from(presented, "utf8");
    if (sharedBuf.length !== presentedBuf.length) return false;
    return timingSafeEqual(sharedBuf, presentedBuf);
  }

  /**
   * Generate install command for executor-node.
   * Returns a shell command the user can run on the target machine to install and start the executor.
   * Values are read from the NestJS ConfigService (environment variables).
   */
  getInstallCmd(): {
    cmd: string;
    curlCmd: string;
    token: string;
    adminApiUrl: string;
  } {
    const adminApiUrl = this.configService.get<string>("ADMIN_API_URL") || "";
    const sharedToken =
      this.configService.get<string>("executor.sharedToken") || "";
    const cmd = `npx autoflow-executor --admin-url "${adminApiUrl}" --token "${sharedToken}"`;
    const curlCmd = `curl -fsSL "${adminApiUrl}/executors/install.sh" | bash -s -- --admin-url "${adminApiUrl}" --token "${sharedToken}"`;
    return { cmd, curlCmd, token: sharedToken, adminApiUrl };
  }

  /**
   * Mark an executor as offline (graceful shutdown).
   */
  async markOffline(address: string): Promise<void> {
    await this.repo.update(
      { address },
      { status: ExecutorStatus.OFFLINE, lastHeartbeat: new Date() },
    );
    this.logger.log(`Executor ${address} marked as offline`);
  }

  /**
   * Get task executions for a specific executor.
   */
  async getExecutorExecutions(
    id: string,
    pagination: PaginationDto,
  ): Promise<{ total: number; items: TaskExecution[] }> {
    const executor = await this.findOne(id);
    const [items, total] = await this.execRepo.findAndCount({
      where: { executorAddress: executor.address },
      order: { createdAt: "DESC" },
      take: pagination.pageSize,
      skip: (pagination.page - 1) * pagination.pageSize,
    });
    return { total, items };
  }

  /**
   * Get performance metrics for a specific executor.
   */
  async getExecutorMetrics(id: string): Promise<{
    executor: { id: string; address: string; status: string };
    sevenDayStats: {
      totalExecutions: number;
      successful: number;
      failed: number;
      successRate: number;
      averageDurationMs: number;
    };
    current: {
      runningTaskCount: number;
      cpuUsage: number | null;
      memUsage: number | null;
    };
  }> {
    const executor = await this.findOne(id);
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

    // Merge 4 serial queries into 1 for performance
    const statsQuery = await this.execRepo
      .createQueryBuilder("e")
      .select("COUNT(*)", "total")
      .addSelect(
        `SUM(CASE WHEN e.status = '${ExecutionStatus.SUCCESS}' THEN 1 ELSE 0 END)`,
        "successful",
      )
      .addSelect(
        `SUM(CASE WHEN e.status = '${ExecutionStatus.FAILED}' THEN 1 ELSE 0 END)`,
        "failed",
      )
      .addSelect(
        "AVG(CASE WHEN e.duration IS NOT NULL THEN e.duration END)",
        "avgDuration",
      )
      .where("e.executorAddress = :address", { address: executor.address })
      .andWhere("e.createdAt >= :date", { date: sevenDaysAgo })
      .getRawOne();

    const totalExecutions = parseInt(statsQuery?.total ?? "0", 10);
    const successful = parseInt(statsQuery?.successful ?? "0", 10);
    const failed = parseInt(statsQuery?.failed ?? "0", 10);
    const avgDurationQuery = { avg: statsQuery?.avgDuration };

    return {
      executor: {
        id: executor.id,
        address: executor.address,
        status: executor.status,
      },
      sevenDayStats: {
        totalExecutions,
        successful,
        failed,
        successRate:
          totalExecutions > 0
            ? Math.round((successful / totalExecutions) * 10000) / 100
            : 0,
        averageDurationMs: avgDurationQuery?.avg
          ? Math.round(parseFloat(avgDurationQuery.avg))
          : 0,
      },
      current: {
        runningTaskCount: executor.runningTaskCount,
        cpuUsage: executor.cpuUsage,
        memUsage: executor.memUsage,
      },
    };
  }
}
