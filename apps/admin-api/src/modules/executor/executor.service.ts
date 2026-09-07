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
import { ExecutorMetricsHistory } from "./entities/executor-metrics-history.entity";
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
// SEC-02: 任务级 secrets 派发解密（落库加密在 TaskService 写路径）
import { SecretsCryptoService } from "../../common/utils/secret-crypto.util.service";

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
    // FEAT-04: metrics-history read side (24h trend sampling). The writer is
    // external (executor-node heartbeat pipeline); the repository is read-only
    // from this service's perspective.
    @InjectRepository(ExecutorMetricsHistory)
    private metricsHistoryRepo: Repository<ExecutorMetricsHistory>,
    @InjectQueue("task-queue") private taskQueue: Queue,
    private readonly configService: ConfigService,
    private readonly notificationService: NotificationService,
    private readonly systemConfigService: SystemConfigService,
    // SEC-02: dispatch 时解密 task.secrets（与 params 合并注入执行器 env）
    private readonly secretsCrypto: SecretsCryptoService,
  ) {
    this.protocol = this.configService.get<string>("app.protocol") || "http";
  }

  public getExecutorUrl(address: string, path: string): string {
    if (address.startsWith("http://") || address.startsWith("https://")) {
      return `${address}/${path}`;
    }
    return `${this.protocol}://${address}/${path}`;
  }

  /**
   * Resolve the executor shared credential for outbound requests (DB-first,
   * env fallback). Every admin→executor call site must go through this
   * resolver so a DB rotation propagates everywhere at once — a raw env read
   * sends a stale credential the executor's DB-first verification rejects.
   */
  async getSharedToken(): Promise<string> {
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

  /**
   * SEC-02: build the executor-bound `params` payload = execution params
   * merged with decrypted task.secrets. Secrets WIN over params (a credential
   * set at task level must not be shadowable by a per-trigger param of the
   * same name — executors map every entry to AUTOFLOW_<KEY> env vars). The
   * merged map lives only on the dispatch HTTP payload: it is never persisted
   * back to TaskExecution.params, so plaintext never re-enters the database.
   * A decryption failure (e.g. key missing/rotated away) surfaces as a
   * dispatch error and the execution fails with a clear message instead of
   * silently running without its credentials.
   */
  private buildDispatchParams(
    task: Task,
    execution: TaskExecution,
  ): Record<string, unknown> {
    const params = (execution.params ?? task.params ?? {}) as Record<
      string,
      unknown
    >;
    let decrypted: Record<string, unknown> | null | undefined;
    try {
      decrypted = this.secretsCrypto.decryptForDispatch(task.secrets);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(
        `Task secrets could not be decrypted for dispatch: ${message}`,
      );
    }
    return { ...(params ?? {}), ...(decrypted ?? {}) };
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

  /**
   * P2: 重试预算语义的唯一来源（BullMQ attempts 语义：maxRetry 为总尝试预算，
   * retryCount 为已消耗的重试次数）。executor-restart 恢复路径与 scheduler
   * stale sweep 共用——sweep 此前只置 FAILED 不 re-enqueue，而 task.processor
   * 已将 RUNNING 移出 claimable，worker 崩溃型执行只能等 sweep 收敛，
   * task.maxRetry>0 的任务实际拿不到任何重试。
   */
  private static retryBudgetExhausted(
    task: Task,
    execution: TaskExecution,
  ): boolean {
    const maxAttempts = Math.max(1, task.maxRetry ?? 1);
    const nextRetryCount = (execution.retryCount ?? 0) + 1;
    return nextRetryCount >= maxAttempts;
  }

  /**
   * P2: 公开预算判定，供调用方把前置副作用（如 stale sweep 的 kill 通知）
   * 门控在"确实会安排重试"之上。scheduleRetryAfterRecovery 内部仍会复查，
   * 二者共享 retryBudgetExhausted，语义不会漂移。
   */
  hasRetryBudget(task: Task, execution: TaskExecution): boolean {
    return !ExecutorService.retryBudgetExhausted(task, execution);
  }

  /**
   * RUNNING→新 PENDING execution + 入队。executor-restart 恢复与 scheduler
   * stale sweep（P2）共用的重试兑现模式：预算耗尽则静默跳过（只保留 FAILED）。
   * fallbackTriggerType 仅在原执行未带 triggerType 时生效（restart 路径保持
   * 既有 "executor_restart"；sweep 传 "stale_recovery" 便于溯源）。
   */
  async scheduleRetryAfterRecovery(
    task: Task,
    execution: TaskExecution,
    fallbackTriggerType = "executor_restart",
  ): Promise<void> {
    const maxAttempts = Math.max(1, task.maxRetry ?? 1);
    const nextRetryCount = (execution.retryCount ?? 0) + 1;
    if (ExecutorService.retryBudgetExhausted(task, execution)) return;

    const retryExecution = this.execRepo.create({
      taskId: task.id,
      taskName: task.name,
      status: ExecutionStatus.PENDING,
      params: execution.params ?? task.params,
      triggerType: execution.triggerType ?? fallbackTriggerType,
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
        `Failed to enqueue recovery retry for execution ${execution.id}: ${message}`,
      );
    }
  }

  /**
   * P2: best-effort 通知执行器终止指定 execution（stale sweep re-enqueue 前
   * 调用，防"执行器谎报/进程僵死但仍存活"场景下原进程与新执行双跑）。
   * 实现自 task.service.notifyExecutorKill 收敛至此（kill 端点 node/python
   * 两端均已就绪），TaskService 现委托本方法，避免两份逻辑。
   * 契约：地址为空跳过；任何失败（离线/404/超时）仅 warn，绝不抛出。
   */
  async notifyExecutorKill(
    executionId: string,
    executorAddress?: string | null,
  ): Promise<void> {
    if (!executorAddress) return;
    try {
      const token = await this.getSharedToken();
      const headers = token ? { Authorization: `Bearer ${token}` } : {};
      const url = this.getExecutorUrl(
        executorAddress,
        `api/executions/${executionId}/kill`,
      );
      await axios.post(url, {}, { headers, timeout: 3_000 });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `Failed to notify executor ${executorAddress} to kill execution ${executionId}: ${message}`,
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
      if (task) await this.scheduleRetryAfterRecovery(task, execution);
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

  /**
   * E9: 心跳采纳 maxConcurrentTasks 的取值域——正整数 1..10000。
   * 越界/非整数/非数字一律视为未上报（不改 DB 值），防止执行器经心跳
   * 写入荒谬容量饿死派发闸门（selectLeastLoaded 以该列判满）。
   */
  private static isAdoptableMaxConcurrentTasks(
    value: unknown,
  ): value is number {
    return (
      typeof value === "number" &&
      Number.isInteger(value) &&
      value >= 1 &&
      value <= 10_000
    );
  }

  /**
   * U16: 心跳采纳 deadLetterCount 的取值域——非负整数 0..100000。
   * 越界/非整数/非数字一律视为未上报（不改 DB 值），与 maxConcurrentTasks
   * 采纳同模式：执行器上报面不可信，白名单字段必须先过范围校验再落列。
   */
  private static isAdoptableDeadLetterCount(value: unknown): value is number {
    return (
      typeof value === "number" &&
      Number.isInteger(value) &&
      value >= 0 &&
      value <= 100_000
    );
  }

  /**
   * CONSISTENCY-02: heartbeat ingest for executor-node 上报的 runningExecutionIds。
   * 输入为 executor 可控字段，须严格防御：非数组视为未上报（返回 null）；逐项仅
   * 保留匹配安全字符集 [A-Za-z0-9_-] 的字符串（其余丢弃）；最多裁剪至 200 项。
   * null 与 [] 语义不同——null = 旧版执行器未上报该字段（见实体注释），[] = 已
   * 上报且当前空闲。
   *
   * 注意：此处字符集 ^[A-Za-z0-9_-]+$ 比执行器侧（executor-node 的 id 生成/
   * 透传面）更窄，是刻意的防御面收窄——executionId 现为 UUID（仅十六进制 +
   * '-'，天然落在该集合内），收窄不损失合法输入，却把心跳可写入的字符串
   * 形态压到最小（防注入控制字符/超长垃圾项）。若未来 executionId 改用其他
   * 格式，须同步复核此集合而不是盲目放宽。
   */
  private sanitizeRunningExecutionIds(value: unknown): string[] | null {
    if (!Array.isArray(value)) return null;
    const safe: string[] = [];
    for (const item of value) {
      if (typeof item === "string" && /^[A-Za-z0-9_-]+$/.test(item)) {
        safe.push(item);
        if (safe.length >= 200) break;
      }
    }
    return safe;
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
      runningExecutionIds?: string[] | null;
      deadLetterCount?: number;
      // E9: 执行器热更新容量上报（可选，正整数 1..10000，非法/缺失不改 DB）
      maxConcurrentTasks?: number;
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
    const {
      restartedAt: _r,
      startupId: _s,
      runningExecutionIds,
      ...metricValues
    } = metrics;
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
    // token rotation), the optimistic-lock version or executorStartupId.
    // Only the known metric columns below are writable via heartbeat.
    // E9 exception: maxConcurrentTasks is deliberately whitelisted so an
    // executor that hot-updates its capacity is adopted without re-register;
    // it goes through the range check below first (invalid → treated as
    // not-reported, DB value untouched). U16 applies the same posture to
    // deadLetterCount (non-negative integer 0..100000).
    const metricsWhitelist: Array<
      | "cpuUsage"
      | "memUsage"
      | "diskUsage"
      | "networkLatency"
      | "runningTaskCount"
      | "totalTaskCount"
      | "failedTaskCount"
      | "maxConcurrentTasks"
      | "deadLetterCount"
    > = [
      "cpuUsage",
      "memUsage",
      "diskUsage",
      "networkLatency",
      "runningTaskCount",
      "totalTaskCount",
      "failedTaskCount",
      "maxConcurrentTasks",
      "deadLetterCount",
    ];
    if (
      metricValues.maxConcurrentTasks !== undefined &&
      !ExecutorService.isAdoptableMaxConcurrentTasks(
        metricValues.maxConcurrentTasks,
      )
    ) {
      this.logger.warn(
        `Executor ${address} reported invalid maxConcurrentTasks=${String(
          metricValues.maxConcurrentTasks,
        )} (expected integer in 1..10000); keeping stored value`,
      );
      delete metricValues.maxConcurrentTasks;
    }
    // U16: deadLetterCount 采纳（node ab4971f / python 001 起上报）。非法值
    // 视同未上报——从 metricValues 删除，DB 值不动，与上轮 maxConcurrentTasks
    // 采纳同模式。
    if (
      metricValues.deadLetterCount !== undefined &&
      !ExecutorService.isAdoptableDeadLetterCount(metricValues.deadLetterCount)
    ) {
      this.logger.warn(
        `Executor ${address} reported invalid deadLetterCount=${String(
          metricValues.deadLetterCount,
        )} (expected integer in 0..100000); keeping stored value`,
      );
      delete metricValues.deadLetterCount;
    }
    for (const key of metricsWhitelist) {
      if (metricValues[key] !== undefined) {
        (e as any)[key] = metricValues[key];
      }
    }
    e.status = ExecutorStatus.ONLINE;
    e.lastHeartbeat = new Date();
    if (incomingStartedAt) e.executorStartedAt = incomingStartedAt;
    if (incomingStartupId) e.executorStartupId = incomingStartupId;

    // CONSISTENCY-02: persist executor-node 的活性上报。缺省字段写 null
    // （= 旧版执行器未上报，区别于 [] 的"已上报且空闲"）；仅在字段上报时才
    // 覆盖，避免旧版心跳把新版已写入的活性集合擦回 null。deadLetterCount
    // 经上方白名单校验后采纳落列（U16），>0 时仍保留告警。
    if (runningExecutionIds !== undefined) {
      e.runningExecutionIds =
        this.sanitizeRunningExecutionIds(runningExecutionIds);
    }
    if (
      typeof metricValues.deadLetterCount === "number" &&
      Number.isFinite(metricValues.deadLetterCount) &&
      metricValues.deadLetterCount > 0
    ) {
      this.logger.warn(
        `Executor ${address} reported ${metricValues.deadLetterCount} dead-letter execution(s) awaiting callback retries`,
      );
    }

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
      // SEC-02: params + decrypted secrets（secrets 覆盖同名 params，仅进派发载荷不落库）
      const dispatchParams = this.buildDispatchParams(task, execution);
      const resp = await axios.post(
        url,
        { executionId: execution.id, task, params: dispatchParams },
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
    // SEC-02: params + decrypted secrets（secrets 覆盖同名 params，仅进派发载荷不落库）
    const dispatchParams = this.buildDispatchParams(task, execution);

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
          { executionId: execution.id, task, params: dispatchParams },
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
      // DR-03: only the terminal-transition winner may release the slot;
      // a callback or another scanner may have finished this stale candidate.
      const result = await this.execRepo
        .createQueryBuilder()
        .update(TaskExecution)
        .set({
          status: ExecutionStatus.FAILED,
          endTime: new Date(),
          errorMessage:
            "[System] Executor offline or task timed out, marked as failed by scheduler",
          logs:
            (exec.logs || "") +
            "\n[System] Execution timed out without callback, forcefully marked as FAILED",
        })
        .where("id = :id AND status = :status", {
          id: exec.id,
          status: ExecutionStatus.RUNNING,
        })
        .execute();
      if (result.affected && result.affected > 0) {
        await this.releaseExecutorSlot(exec.executorAddress);
        this.logger.warn(
          `Lost execution marked FAILED: execId=${exec.id}, taskId=${exec.taskId}`,
        );
      }
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
    // 真机冒烟（round-16）：无 Authorization 头的心跳（presented=undefined）
    // 曾在 Buffer.from 处抛 500——未携带凭据就是未通过，直接 false（fail-closed）
    if (!presented) return false;
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
   *
   * FEAT-04: the response now carries `history` — sampled resource-trend
   * points for the last 24h, read from executor_metrics_history (populated by
   * the executor-node heartbeat pipeline; see getExecutorMetricsHistory for
   * the sampling/downsampling contract). Empty array when the executor has no
   * history rows — the frontend renders an explicit empty state.
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
    history: Array<{
      timestamp: string;
      cpuUsage: number | null;
      memUsage: number | null;
      runningTaskCount: number;
    }>;
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
      history: await this.getExecutorMetricsHistory(executor.address),
    };
  }

  // ── FEAT-04: executor metrics history (24h trend) ────────────────────────
  // Sampling window: the most recent 24h of executor_metrics_history rows.
  public static readonly METRICS_HISTORY_WINDOW_MS = 24 * 60 * 60 * 1000;
  // Downsampling strategy: fixed 15-minute time buckets aggregated with AVG —
  // 24h / 900s = 96 buckets, structurally ≤ the 100-point cap, with full
  // 24h window coverage regardless of heartbeat cadence (whereas even-stride
  // point picking over a row-capped fetch would bias toward one window end).
  public static readonly METRICS_HISTORY_BUCKET_SECONDS = 900;
  // Hard LIMIT guard on the aggregate query as defense-in-depth; the bucket
  // design already caps output at 96 rows.
  public static readonly METRICS_HISTORY_QUERY_LIMIT = 500;

  /**
   * FEAT-04: read the last-24h resource trend samples (CPU / memory /
   * running-task count) for one executor, aggregated into fixed 15-minute AVG
   * buckets (≤96 points), ascending by timestamp.
   *
   * Data source: executor_metrics_history (written by the executor-node
   * heartbeat pipeline; compound index executorAddress + createdAt). AVG
   * ignores NULLs: a bucket whose heartbeats never reported cpuUsage/memUsage
   * yields null — the frontend draws a gap for those points (connectNulls).
   * Returns an EMPTY array when the executor has no history rows (fresh
   * executor or history pipeline not yet active) — the admin UI renders an
   * explicit "no samples" empty state for that case.
   *
   * SQL note: bucket expressions use TypeORM property references
   * (h.createdAt/h.cpuUsage → quoted physical columns, same pattern as the
   * AVG(CASE WHEN e.duration ...) aggregate in getExecutorMetrics); the
   * bucket divisor is a server-computed constant, never user input.
   */
  private async getExecutorMetricsHistory(address: string): Promise<
    Array<{
      timestamp: string;
      cpuUsage: number | null;
      memUsage: number | null;
      runningTaskCount: number;
    }>
  > {
    const bucketSeconds = ExecutorService.METRICS_HISTORY_BUCKET_SECONDS;
    const since = new Date(
      Date.now() - ExecutorService.METRICS_HISTORY_WINDOW_MS,
    );
    // Bucket start as epoch-seconds aligned to bucketSeconds; kept numeric
    // (no to_timestamp) so the raw driver value parses identically everywhere.
    const bucketExpr = `FLOOR(EXTRACT(EPOCH FROM h.createdAt) / ${bucketSeconds}) * ${bucketSeconds}`;
    const rows: Array<Record<string, unknown>> = await this.metricsHistoryRepo
      .createQueryBuilder("h")
      .select(bucketExpr, "bucket")
      .addSelect("AVG(h.cpuUsage)", "cpu")
      .addSelect("AVG(h.memUsage)", "mem")
      .addSelect("AVG(h.runningTaskCount)", "running")
      .where("h.executorAddress = :address", { address })
      .andWhere("h.createdAt > :since", { since })
      .groupBy("bucket")
      .orderBy("bucket", "ASC")
      .limit(ExecutorService.METRICS_HISTORY_QUERY_LIMIT)
      .getRawMany();

    const toNumber = (v: unknown): number | null =>
      v === null || v === undefined ? null : parseFloat(String(v));
    const points: Array<{
      timestamp: string;
      cpuUsage: number | null;
      memUsage: number | null;
      runningTaskCount: number;
    }> = [];
    for (const row of rows) {
      const bucketEpoch = parseFloat(String(row.bucket));
      if (!Number.isFinite(bucketEpoch)) continue; // defensive: skip bad rows
      const cpu = toNumber(row.cpu);
      const mem = toNumber(row.mem);
      const running = toNumber(row.running);
      points.push({
        timestamp: new Date(bucketEpoch * 1000).toISOString(),
        cpuUsage: cpu === null ? null : Math.round(cpu * 10) / 10,
        memUsage: mem === null ? null : Math.round(mem * 10) / 10,
        runningTaskCount: running === null ? 0 : Math.round(running),
      });
    }
    return points;
  }
}
