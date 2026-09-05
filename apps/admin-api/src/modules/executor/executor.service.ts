import {
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectQueue } from "@nestjs/bullmq";
import type { Queue } from "bullmq";
import { randomBytes, timingSafeEqual, createHash } from "crypto";
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
import { assertSafeExecutorUrl } from "../../common/utils/safe-http.util";

@Injectable()
export class ExecutorService {
  private readonly logger = new Logger(ExecutorService.name);
  private readonly protocol: string;

  // F-5: short-lived in-process cache of SUCCESSFUL per-address token
  // validations. Each validation otherwise runs bcrypt (cost 12, ~100-300ms
  // of pure CPU), which made unauthenticated executor endpoints (callback,
  // heartbeat) a CPU-DoS vector. Only positive results are cached (bounded by
  // the fleet size), keyed by sha256(address|token) so raw tokens never sit in
  // memory. Trade-off: after a token rotation the previous token stays valid
  // for at most TOKEN_CACHE_TTL_MS.
  private static readonly TOKEN_CACHE_TTL_MS = 60_000;
  private static readonly TOKEN_CACHE_MAX = 1000;
  private readonly tokenValidationCache = new Map<string, number>();

  // N26 (round-8): short-lived positive cache of per-address tokenHash
  // lookups, used as the per-executor HMAC candidate when verifying
  // `v1.` execution-callback tokens. Same 60s TTL / positive-only pattern
  // as tokenValidationCache above: misses are never cached (a freshly
  // registered executor must be usable immediately), and rotateToken()
  // evicts the address so a rotation is picked up without waiting for the
  // TTL. Trade-off mirrors F-5: a rotated-away hash stays a valid HMAC
  // candidate for at most TOKEN_CACHE_TTL_MS.
  private readonly callbackSecretCache = new Map<
    string,
    { hash: string; cachedAt: number }
  >();

  // R9 (round-8 P1 closure, W2): idempotency state for POST /executors/token.
  // The endpoint used to rotateToken() on EVERY call, so any client that
  // re-fetched on a loop (executor-node's envelope-parse bug made every fetch
  // "fail" and retry every 30s; executor-python still re-fetches per request)
  // put the stored tokenHash on a rotation cycle that broke the N26
  // per-execution callback-token invariant (docs/VERIFY-round8-e2e.md §1.5).
  // issueToken() now returns the CURRENT token while the caller proves it is
  // the same process life (same startupId — N4 register semantics), and only
  // rotates on a new/changed startupId, on a legacy (startupId-less) fetch
  // outside the short reuse window, or when the cached plaintext no longer
  // verifies against the stored hash (e.g. an admin-UI rotation).
  //
  // Plaintext-token constraint: rotateToken() persists only a bcrypt hash, so
  // the raw token cannot be recovered from the DB. Reuse therefore needs the
  // plaintext kept in-process (issuedTokenCache below) — bounded by fleet
  // size, evicted on rotation/removal, and never readable by anyone who
  // doesn't already pass verifyExecutorToken (shared token) for that address.
  // An admin-api restart simply cold-starts the cache: the next /token call
  // rotates once (harmless — the executor adopts the new hash from the same
  // response, see executor-node admin-envelope.ts).
  private static readonly TOKEN_ISSUE_REUSE_WINDOW_MS = 60_000;
  // N34 (round-9): defensive bounds for the plaintext issuance cache, same
  // MAX+TTL pattern as tokenValidationCache (F-5). Without them, a caller
  // holding the shared token could grow the Map unbounded by hitting
  // POST /executors/token with fresh addresses. The TTL is deliberately NOT
  // the 60s TOKEN_CACHE_TTL_MS: idempotent same-startupId reuse must survive
  // the executors' ~30min token-refresh cycle (docs/VERIFY-round9-e2e.md §1.3
  // observed reuse at 25.5min). An executor living past the TTL just rotates
  // once on its next fetch — the same harmless cold-start behavior as an
  // admin-api restart.
  private static readonly TOKEN_ISSUE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
  private static readonly TOKEN_ISSUE_CACHE_MAX = 1000;
  private readonly issuedTokenCache = new Map<
    string,
    { token: string; startupId: string | null; issuedAt: number }
  >();

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
      // Defensive cap: a single executor can only run a finite number of tasks
      // (bounded by maxConcurrentTasks). 1000 leaves headroom without scanning unboundedly.
      take: 1000,
    });
    const executionsToFail = runningExecutions.filter((execution) =>
      this.shouldFailAfterRestart(execution, onlyStartedBefore),
    );
    // Batch-fetch tasks once instead of one query per execution (avoids N+1)
    const taskIds = [...new Set(executionsToFail.map((e) => e.taskId))];
    const tasks =
      taskIds.length > 0 ? await this.taskRepo.findBy({ id: In(taskIds) }) : [];
    const taskMap = new Map(tasks.map((t) => [t.id, t]));
    for (const execution of executionsToFail) {
      const task = execution.taskId
        ? (taskMap.get(execution.taskId) ?? null)
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
    // R-P0-009: Return the count of failed executions for caller to adjust runningTaskCount
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
    const hasStartupBaseline = Boolean(
      e?.executorStartupId || e?.executorStartedAt,
    );
    const didRestart = e
      ? this.hasExecutorRestarted(e, incomingStartedAt, incomingStartupId)
      : false;
    const shouldRecoverMissingBaseline = Boolean(
      e && !didRestart && !hasStartupBaseline && incomingStartedAt,
    );
    if (!e) {
      // F-7: create the entity from an explicit field whitelist — never pass
      // caller-controlled data through repo.create(). A raw spread would let
      // a client supply `id` (hijacking an existing row via save()'s
      // update-on-pk semantics), `tokenHash` (auth backdoor), `status`,
      // `runningTaskCount` (scheduling manipulation) or the optimistic-lock
      // `version`. Server-owned columns are only ever written by
      // rotateToken()/the service itself.
      e = this.repo.create({
        appName: data.appName,
        address: data.address,
        type: data.type as any,
        executorVersion: data.version,
        capabilities: capabilities,
        maxConcurrentTasks: maxConcurrentTasks,
        groupName: data.groupName,
        tags: data.tags,
        description: data.description,
        executorStartedAt: incomingStartedAt ?? undefined,
        executorStartupId: incomingStartupId ?? undefined,
        status: ExecutorStatus.ONLINE,
        lastHeartbeat: new Date(),
      } as Partial<Executor>);
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
    // Update mutable fields on re-registration (whitelisted per-field only)
    if (data.type) e.type = data.type as any;
    if (data.appName) e.appName = data.appName;
    if (data.version) e.executorVersion = data.version;
    if (capabilities) e.capabilities = capabilities;
    if (maxConcurrentTasks !== undefined)
      e.maxConcurrentTasks = maxConcurrentTasks;
    if (data.groupName !== undefined) e.groupName = data.groupName;
    if (data.tags !== undefined) e.tags = data.tags;
    if (data.description !== undefined) e.description = data.description;
    if (didRestart) {
      await this.failRunningExecutionsAfterRestart(data.address);
      // R-P0-008: Reset runningTaskCount to 0 after executor restart
      e.runningTaskCount = 0;
    } else if (shouldRecoverMissingBaseline) {
      await this.failRunningExecutionsAfterRestart(
        data.address,
        incomingStartedAt,
      );
      // R-P0-008: Reset runningTaskCount to 0 after recovery
      e.runningTaskCount = 0;
    }
    if (incomingStartedAt) e.executorStartedAt = incomingStartedAt;
    if (incomingStartupId) e.executorStartupId = incomingStartupId;
    e.status = ExecutorStatus.ONLINE;
    e.lastHeartbeat = new Date();
    return this.repo.save(e);
  }

  /**
   * N4: register + per-executor token issuance in one step, idempotent per
   * (address, startupId). The previous flow rotated the token on EVERY
   * register call — under shared-token auth any duplicate register (e.g. a
   * residual executor process retrying every 30s) invalidated the live
   * executor's per-executor token, producing a rotation storm that made the
   * per-executor token mechanism useless. Rotation now happens only when:
   * - the address has no per-executor token yet (first issuance), or
   * - the registration is NOT provably from the same process life (missing
   *   startupId, a changed startupId, or a newer restartedAt — i.e. a
   *   restart), which includes legacy executors that never report startupId.
   * A same-process re-register returns perExecutorToken=null: the executor
   * keeps the token it already holds (heartbeats still fall back to the
   * shared token if it was lost). Explicit rotation endpoints are unchanged.
   */
  async registerExecutor(data: {
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
  }): Promise<{ executor: Executor; perExecutorToken: string | null }> {
    // Capture the pre-register row: register() overwrites executorStartupId
    // and the row's tokenHash is select:false, so read it explicitly here.
    const prior = await this.repo
      .createQueryBuilder("e")
      .addSelect("e.tokenHash")
      .where("e.address = :address", { address: data.address })
      .getOne();
    const executor = await this.register(data);
    const incomingStartedAt = this.parseExecutorStartedAt(data.restartedAt);
    const incomingStartupId = data.startupId?.trim() || null;
    const didRestart = prior
      ? this.hasExecutorRestarted(prior, incomingStartedAt, incomingStartupId)
      : false;
    const sameProcess =
      !didRestart &&
      Boolean(prior?.tokenHash) &&
      Boolean(incomingStartupId) &&
      prior?.executorStartupId === incomingStartupId;

    const perExecutorToken =
      prior?.tokenHash && sameProcess
        ? null
        : (await this.rotateToken(executor.id)).token;
    if (perExecutorToken === null) {
      this.logger.debug(
        `Idempotent re-register for executor ${executor.id} (${data.address}); keeping existing per-executor token`,
      );
    }
    return { executor, perExecutorToken };
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
    const hasStartupBaseline = Boolean(
      e.executorStartupId || e.executorStartedAt,
    );
    const didRestart = this.hasExecutorRestarted(
      e,
      incomingStartedAt,
      incomingStartupId,
    );
    const shouldRecoverMissingBaseline = Boolean(
      !didRestart && !hasStartupBaseline && incomingStartedAt,
    );
    const { restartedAt: _r, startupId: _s, ...metricValues } = metrics;
    if (didRestart) {
      await this.failRunningExecutionsAfterRestart(address);
    } else if (shouldRecoverMissingBaseline) {
      await this.failRunningExecutionsAfterRestart(address, incomingStartedAt);
    }

    // R-P0-006: Use save() without version check for heartbeat to avoid frequent conflicts
    // Heartbeat updates are mostly metrics and don't need strict concurrency control
    //
    // F-2: assign metrics EXPLICITLY — never spread untrusted request fields
    // onto the entity. A spread would let a caller overwrite server-owned
    // columns such as tokenHash (persistent auth backdoor surviving shared-
    // token rotation), the optimistic-lock version, maxConcurrentTasks or
    // executorStartupId. Only the known metric columns below are writable via
    // heartbeat.
    const metricsWhitelist: Array<
      | "cpuUsage"
      | "memUsage"
      | "diskUsage"
      | "networkLatency"
      | "runningTaskCount"
      | "totalTaskCount"
      | "failedTaskCount"
    > = [
      "cpuUsage",
      "memUsage",
      "diskUsage",
      "networkLatency",
      "runningTaskCount",
      "totalTaskCount",
      "failedTaskCount",
    ];
    for (const key of metricsWhitelist) {
      if (metricValues[key] !== undefined) {
        (e as any)[key] = metricValues[key];
      }
    }
    e.status = ExecutorStatus.ONLINE;
    e.lastHeartbeat = new Date();
    if (incomingStartedAt) e.executorStartedAt = incomingStartedAt;
    if (incomingStartupId) e.executorStartupId = incomingStartupId;
    const saved = await this.repo.save(e);
    return saved;
  }

  findAll() {
    // Cap the result set: an admin UI listing does not need every historical executor.
    // Use pagination if the UI needs more — the ExecutorListPage supports filters/search.
    return this.repo.find({ order: { createdAt: "DESC" }, take: 500 });
  }

  async findOne(id: string): Promise<Executor> {
    const executor = await this.repo.findOne({ where: { id } });
    if (!executor) throw new NotFoundException("Executor not found");
    return executor;
  }

  /**
   * Update executor metadata (group, tags, description, maxConcurrentTasks).
   * F-2 family: assign only the four allowed fields — the controller has
   * already whitelisted, but the service stays self-contained so any other
   * caller cannot smuggle entity columns (tokenHash, version, ...) through.
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
    if (data.groupName !== undefined) executor.groupName = data.groupName;
    if (data.tags !== undefined) executor.tags = data.tags;
    if (data.description !== undefined) executor.description = data.description;
    if (data.maxConcurrentTasks !== undefined)
      executor.maxConcurrentTasks = data.maxConcurrentTasks;
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
   * `tags` is a simple-array (comma-separated string) column, so we still need to
   * load the rows and split in TS — but we cap the read with `take` to bound the
   * scan. Set is generous because tags are user-defined and rarely change.
   */
  async getTags(): Promise<string[]> {
    const execs = await this.repo.find({
      select: ["tags"],
      // Bound the scan; tag set converges quickly even with thousands of executors.
      take: 5000,
    });
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
      // Cap the candidate pool: scoring + capacity checks operate on full rows,
      // and we only need the least-loaded one. A generous cap (500) still avoids
      // unbounded scans for installations with thousands of edge executors.
      take: 500,
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
    let candidates: Executor[];

    if (task.executorId) {
      // R6: executor pinning — dispatch targets ONLY the pinned executor,
      // bypassing the fleet query and appName/group/tags/runtime filters.
      // The optimistic-lock slot increment below is still applied, so the
      // executor's maxConcurrentTasks cap and runningTaskCount bookkeeping
      // are respected; a pinned executor at capacity fails the dispatch
      // (no fallback to another executor — that is the point of pinning).
      const pinned = await this.repo.findOne({
        where: { id: task.executorId },
      });
      if (!pinned) {
        // No matching failureReason enum for "pinned target deleted/missing"
        // (EXECUTOR_OFFLINE would be a lie — it never registered here), so
        // the worker's message classifier leaves it UNKNOWN by design.
        throw new Error(`Pinned executor ${task.executorId} not found`);
      }
      if (pinned.status !== ExecutorStatus.ONLINE) {
        // Message shape matches the worker's EXECUTOR_OFFLINE classifier
        // (task.processor.ts: /executor.*(offline|unavailable)/).
        throw new Error(
          `Pinned executor "${pinned.appName}" (${pinned.id}) is offline`,
        );
      }
      candidates = [pinned];
    } else {
      const all = await this.repo.find({
        where: { status: ExecutorStatus.ONLINE },
        // Bound the candidate pool for the weighted-score selection below.
        // Score-and-pick-first needs only the top candidates, so a generous cap
        // is enough. See selectLeastLoaded() for the matching rationale.
        take: 500,
      });

      candidates = all;

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

    // R-P0-006: Use optimistic locking with version to prevent TOCTOU race conditions
    let matched: Executor | null = null;
    for (const candidate of sorted) {
      const maxConcurrent = candidate.maxConcurrentTasks ?? Infinity;

      // Attempt atomic increment with version check
      const result = await this.repo
        .createQueryBuilder()
        .update(Executor)
        .set({ runningTaskCount: () => '"runningTaskCount" + 1' })
        .where("id = :id", { id: candidate.id })
        .andWhere("status = :status", { status: ExecutorStatus.ONLINE })
        .andWhere("version = :version", { version: candidate.version })
        .andWhere(
          maxConcurrent === Infinity ? "1=1" : '"runningTaskCount" < :max',
          maxConcurrent === Infinity ? {} : { max: maxConcurrent },
        )
        .execute();

      if (result.affected && result.affected > 0) {
        // Update successful, synchronize local state
        candidate.runningTaskCount += 1;
        candidate.version += 1;
        matched = candidate;
        break;
      }
      // Version conflict or capacity full, try next candidate
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
      // F-3: SSRF guard — the address is executor-controlled (register/heartbeat),
      // so block metadata/loopback/link-local targets before sending the
      // authenticated request. A blocked address rolls back the slot below.
      const url = this.getExecutorUrl(matched.address, "api/execute");
      await assertSafeExecutorUrl(url);
      const sharedToken = await this.getSharedToken();
      const headers: Record<string, string> = {};
      if (sharedToken) headers["Authorization"] = `Bearer ${sharedToken}`;
      const resp = await axios.post(
        url,
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
   *
   * NOTE: Broadcast is intentionally unbounded — by definition we must dispatch
   * to every eligible online executor. The `{status: ONLINE}` where clause keeps
   * this scoped to the active fleet; offline/stale rows are excluded.
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
        // F-3: SSRF guard per target — a poisoned address (metadata/loopback)
        // fails its own dispatch without affecting the rest of the broadcast.
        await assertSafeExecutorUrl(dispatchUrl);
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
    // N26: a rotation invalidates the per-address callback-secret cache so
    // the new hash is visible immediately (and the stale one stops being
    // offered as an HMAC candidate). R9 (round-8 P1 closure): the executor
    // now picks the new hash up on its next /token fetch or heartbeat (both
    // responses carry tokenHash — see issueToken() and the heartbeat
    // controller), not only at register; until that pickup per-execution
    // callback tokens signed with the old hash fail verification —
    // documented constraint in docs/sdk-guide.md. R10 (round-10 gap #3):
    // executor-node self-heals a stale bearer within one request round-trip
    // (401 → forceTokenRefresh → POST /token → adopt token+hash → retry),
    // so a manual rotation converges in ≤ one heartbeat interval.
    this.callbackSecretCache.delete(executor.address);
    // R10: seed the idempotent-issuance cache with the fresh plaintext under
    // the executor's CURRENT startupId. Without this, the self-healing
    // POST /token (same startupId) would find the cache still holding the
    // pre-rotation plaintext, fail its bcrypt re-verification and rotate a
    // SECOND time — killing the very token this response just showed the
    // admin UI within seconds. With it, the same-startupId re-fetch returns
    // exactly this token (issueToken's possession re-verification still
    // guards against resurrecting a later rotated-away plaintext), making
    // "rotate in the UI" mean "the online executor adopts THIS token".
    this.rememberIssuedToken(executor.address, {
      token: rawToken,
      startupId: executor.executorStartupId ?? null,
      issuedAt: Date.now(),
    });
    this.logger.log(`Rotated token for executor ${id} (${executor.address})`);
    return { token: rawToken };
  }

  /**
   * R9 (round-8 P1 closure, W2): idempotent token issuance for
   * POST /executors/token — the same (address, startupId) re-fetch returns
   * the CURRENT token instead of rotating. Rotation still happens when:
   * - the address has no issued token in this process yet (first issuance,
   *   or the admin-api restarted and lost the in-memory plaintext cache),
   * - the request carries a DIFFERENT startupId (a restarted executor —
   *   N4 register semantics), or
   * - a legacy request without startupId arrives outside the short reuse
   *   window (can't prove same process life; the window bounds any
   *   poll-on-loop client to at most one rotation per window), or
   * - the cached plaintext no longer verifies against the stored tokenHash
   *   (an admin-UI rotate-token invalidated it).
   *
   * Returns the raw token (shown once per rotation — reuse hands it back
   * only to the authenticated executor that already holds it) plus the
   * CURRENT stored tokenHash, so the executor can keep its N26 callback
   * HMAC secret in sync with whatever this response authorized.
   */
  async issueToken(data: {
    address: string;
    appName: string;
    startupId?: string | null;
  }): Promise<{ token: string; tokenHash: string | null }> {
    // Keep the existing register-on-token semantics (creates the row for
    // unknown addresses, refreshes ONLINE/lastHeartbeat). Deliberately NOT
    // forwarding startupId/restartedAt here: restart detection via /token
    // would let a stale residual process fail live executions — that stays
    // the register/heartbeat endpoints' job.
    const executor = await this.register({
      address: data.address,
      appName: data.appName,
    });
    const incomingStartupId = data.startupId?.trim() || null;
    const now = Date.now();
    const cached = this.issuedTokenCache.get(data.address);
    // N34: an entry past the TTL is treated as stale (rotate fresh) even if
    // the startupId still matches — same fail-safe as a cold cache.
    if (
      cached &&
      now - cached.issuedAt < ExecutorService.TOKEN_ISSUE_CACHE_TTL_MS
    ) {
      const sameProcess =
        incomingStartupId !== null && cached.startupId === incomingStartupId;
      const legacyInWindow =
        incomingStartupId === null &&
        cached.startupId === null &&
        now - cached.issuedAt < ExecutorService.TOKEN_ISSUE_REUSE_WINDOW_MS;
      if (sameProcess || legacyInWindow) {
        // Verify the cached plaintext is STILL the token behind the stored
        // hash before handing it out again (an admin-UI rotation must not
        // be resurrected by this endpoint).
        const stored = await this.repo
          .createQueryBuilder("e")
          .addSelect("e.tokenHash")
          .where("e.address = :address", { address: data.address })
          .getOne();
        if (
          stored?.tokenHash &&
          (await bcrypt.compare(cached.token, stored.tokenHash))
        ) {
          this.logger.debug(
            `Idempotent token reuse for executor ${data.address} (${incomingStartupId !== null ? "same startupId" : "legacy fetch in reuse window"}); no rotation`,
          );
          return { token: cached.token, tokenHash: stored.tokenHash };
        }
      }
    }
    const { token } = await this.rotateToken(executor.id);
    // rotateToken() evicted the N26 cache, so this reads the FRESH hash.
    const tokenHash = await this.getCallbackSecretByAddress(data.address);
    this.rememberIssuedToken(data.address, {
      token,
      startupId: incomingStartupId,
      issuedAt: now,
    });
    return { token, tokenHash };
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
    // R9: drop the idempotent-issuance plaintext cache entry with the row —
    // a re-registered address must get a fresh token, never the removed one.
    this.issuedTokenCache.delete(executor.address);
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
    // F-5: positive-result cache — a repeated (address, token) pair within the
    // TTL skips the bcrypt compare entirely. Negative results are never cached
    // (a legitimate executor rotating its token must immediately succeed).
    const cacheKey = createHash("sha256")
      .update(`${address}|${presented}`)
      .digest("hex");
    const cachedAt = this.tokenValidationCache.get(cacheKey);
    const now = Date.now();
    if (
      cachedAt !== undefined &&
      now - cachedAt < ExecutorService.TOKEN_CACHE_TTL_MS
    ) {
      return true;
    }

    // First try to validate against per-executor token
    const executor = await this.repo
      .createQueryBuilder("e")
      .addSelect("e.tokenHash")
      .where("e.address = :address", { address })
      .getOne();

    if (executor && executor.tokenHash) {
      const isValid = await bcrypt.compare(presented, executor.tokenHash);
      if (isValid) {
        this.rememberTokenValidation(cacheKey, now);
        return true;
      }
    }

    // Fall back to shared token — use timing-safe comparison to prevent timing attacks
    const shared = await this.getSharedToken();
    if (shared.length === 0) return false;
    const sharedBuf = Buffer.from(shared, "utf8");
    const presentedBuf = Buffer.from(presented, "utf8");
    if (sharedBuf.length !== presentedBuf.length) return false;
    const sharedOk = timingSafeEqual(sharedBuf, presentedBuf);
    if (sharedOk) {
      this.rememberTokenValidation(cacheKey, now);
    }
    return sharedOk;
  }

  /**
   * N26 (round-8): the per-executor callback secret candidate.
   *
   * Returns the executor row's bcrypt `tokenHash` string for `address`
   * (or null when the executor is unknown / has no token). The hash is
   * used as an HMAC *key material* by the per-execution callback token
   * verification fallback (execution-callback.controller) — the raw
   * per-executor token never leaves the executor side and the hash itself
   * is not a preimage leak (bcrypt is one-way; the registrant already
   * holds the raw token, so returning the hash grants nothing new).
   *
   * Positive results are cached for TOKEN_CACHE_TTL_MS (same pattern as
   * validateTokenByAddress); rotateToken() evicts the entry.
   */
  async getCallbackSecretByAddress(address: string): Promise<string | null> {
    const now = Date.now();
    const cached = this.callbackSecretCache.get(address);
    if (cached && now - cached.cachedAt < ExecutorService.TOKEN_CACHE_TTL_MS) {
      return cached.hash;
    }
    const executor = await this.repo
      .createQueryBuilder("e")
      .addSelect("e.tokenHash")
      .where("e.address = :address", { address })
      .getOne();
    const hash = executor?.tokenHash ?? null;
    if (hash) {
      this.callbackSecretCache.set(address, { hash, cachedAt: now });
    } else {
      this.callbackSecretCache.delete(address);
    }
    return hash;
  }

  /** F-5: store a successful validation, evicting expired/oldest entries. */
  private rememberTokenValidation(cacheKey: string, now: number): void {
    if (this.tokenValidationCache.size >= ExecutorService.TOKEN_CACHE_MAX) {
      for (const [k, t] of this.tokenValidationCache) {
        if (now - t >= ExecutorService.TOKEN_CACHE_TTL_MS) {
          this.tokenValidationCache.delete(k);
        }
      }
      while (
        this.tokenValidationCache.size >= ExecutorService.TOKEN_CACHE_MAX
      ) {
        const oldest = this.tokenValidationCache.keys().next().value;
        if (oldest === undefined) break;
        this.tokenValidationCache.delete(oldest);
      }
    }
    this.tokenValidationCache.set(cacheKey, now);
  }

  /**
   * N34 (round-9): store an issued plaintext token, evicting expired/oldest
   * entries past the cap — same bounded-growth defense as
   * rememberTokenValidation (F-5). An OVERWRITE of an existing address skips
   * eviction entirely (the map does not grow): R10's rotateToken seeding and
   * issueToken's startupId refinement both write the same key, and the
   * second write must not evict an unrelated executor's entry.
   */
  private rememberIssuedToken(
    address: string,
    entry: { token: string; startupId: string | null; issuedAt: number },
  ): void {
    if (
      !this.issuedTokenCache.has(address) &&
      this.issuedTokenCache.size >= ExecutorService.TOKEN_ISSUE_CACHE_MAX
    ) {
      for (const [k, v] of this.issuedTokenCache) {
        if (
          entry.issuedAt - v.issuedAt >=
          ExecutorService.TOKEN_ISSUE_CACHE_TTL_MS
        ) {
          this.issuedTokenCache.delete(k);
        }
      }
      while (
        this.issuedTokenCache.size >= ExecutorService.TOKEN_ISSUE_CACHE_MAX
      ) {
        const oldest = this.issuedTokenCache.keys().next().value;
        if (oldest === undefined) break;
        this.issuedTokenCache.delete(oldest);
      }
    }
    this.issuedTokenCache.set(address, entry);
  }

  /**
   * Generate install command for executor-node.
   * Returns a shell command the user can run on the target machine to install and start the executor.
   * URL comes from ConfigService; the shared token uses DB-first resolution.
   *
   * Note: this is the single handler for GET /executors/install-cmd. The former
   * install-cmd.controller.ts duplicated this route (unreachable — ExecutorController
   * registers first) and was removed; its shell-quoting protection was merged here.
   */
  async getInstallCmd(): Promise<{
    cmd: string;
    token: string;
    adminApiUrl: string;
  }> {
    const adminApiUrl = this.configService.get<string>("ADMIN_API_URL") || "";
    // R7 真机遗留观察①：ADMIN_API_URL 缺失时旧实现会生成
    // `curl -fsSL '/api/executors/install.sh' | bash -s -- --api-url ''`
    // ——相对路径 + 空 api-url 的裸机不可用命令。宁可 503 也不返回废命令。
    if (!adminApiUrl) {
      throw new ServiceUnavailableException(
        "ADMIN_API_URL is not configured; cannot generate install command",
      );
    }
    // DR-01: honor DB rotations rather than handing out a stale env credential.
    const sharedToken = await this.getSharedToken();
    // Shell-quote values to prevent word-splitting / injection when the user
    // copies the generated command into a shell (merged from install-cmd.controller).
    const q = (v: string) => `'${v.replace(/'/g, "'\\''")}'`;
    // R4-D P1-3 闭环：后端现已承载 GET /api/executors/install.sh
    // （install-script.content.ts，@Public 纯文本），安装命令从旧的
    // `npx autoflow-executor` 形式切回 curl|bash 形式。--api-url 传
    // ADMIN_API_URL 原值（不含 /api 前缀，与 executor .env 语义一致），
    // --secret 传共享 token；两者继续经 q() 转义防注入。
    const scriptUrl = `${adminApiUrl.replace(/\/+$/, "")}/api/executors/install.sh`;
    const cmd = `curl -fsSL ${q(scriptUrl)} | bash -s -- --api-url ${q(adminApiUrl)} --secret ${q(sharedToken)}`;
    return { cmd, token: sharedToken, adminApiUrl };
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
   * Admin marks a specific executor offline by ID (stale record cleanup).
   */
  async setOfflineById(id: string): Promise<Executor> {
    const executor = await this.findOne(id);
    executor.status = ExecutorStatus.OFFLINE;
    executor.lastHeartbeat = new Date();
    const saved = await this.repo.save(executor);
    this.logger.log(
      `Executor ${executor.address} set offline by admin (id=${id})`,
    );
    return saved;
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
