import {
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
  ForbiddenException,
  Inject,
  forwardRef,
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
import {
  Executor,
  ExecutorStatus,
  ExecutorType,
} from "./entities/executor.entity";
import { ExecutorMetricsHistory } from "./entities/executor-metrics-history.entity";
import {
  TaskExecution,
  ExecutionFailureReason,
  ExecutionStatus,
} from "../task/entities/task-execution.entity";
// A1: 终态跃迁的单一入口（纯函数，零 DI，不引入 task↔executor 模块耦合）。
// A6: 同文件再取终态集合常量——对账端点必须与跃迁门用同一份定义，否则「门里
// 认的终态」和「对账回的终态」会各自漂移。
import {
  transitionToTerminal,
  transitionOneToTerminal,
  TERMINAL_EXECUTION_STATUSES,
} from "../task/execution-terminal";
import { Task, TaskCodeSource } from "../task/entities/task.entity";
// python_task_multiversion（WS2 · CONTRACT §2.4/§3.1）：zip 渠道任务的
// `packageUrl` 由 admin 在派发时解析后附加到下发 task 上（任务实体只有
// `applicationId` 弱引用，执行器无法自行查库）。只加列/只读，不建关系，
// 避免 executor↔application 的实体关系耦合（ApplicationModule 反向 import
// TaskModule+ExecutorModule，加关系会引入模块环）。
import { Application } from "../application/entities/application.entity";
// python_task_multiversion（WS2 · CONTRACT §1.2/§2.2/§3.1）：解释器缓存池
// 匹配的唯一事实源（纯函数）。三处调度站点 + pinning 守卫 + 上报采纳共用，
// 杜绝三份漂移（对齐 executor-score.util.ts 的抽取先例）。
import {
  buildInterpreterMismatchMessage,
  hasRequestedVersion,
  interpreterSatisfies,
  normalizeInterpreters,
} from "./interpreter-match.util";
import type { ExecutorInterpreter } from "./interpreter-match.util";
import { PaginationDto } from "../../common/dto/pagination.dto";
import { NotificationService } from "../notification/notification.service";
import { SystemConfigService } from "../config/config.service";
import {
  assertAndPinExecutorUrl,
  pinnedAxiosConfig,
} from "../../common/utils/safe-http.util";
// EXE-VER-1: 最低版本门禁（register 403）——比较与合规语义见 util 头注
import { isVersionCompliant } from "./version-compare.util";
// PROTOCOL-VER（B-3/U-2）：协议版本兼容矩阵（与实现版本门禁解耦）。
import {
  PROTOCOL_SUPPORTED_MIN,
  isProtocolCompliant,
} from "./protocol-compat.util";
// ARCH-32: pull 模式派发队列（ADR-015）——NAT 内执行器零入站回连
import { ExecutorPullService } from "./executor-pull.service";
// SEC-02: 任务级 secrets 派发解密（落库加密在 TaskService 写路径）
import { SecretsCryptoService } from "../../common/utils/secret-crypto.util.service";
// FEAT-07: executor.offline 出站事件（总线 @Global；Optional 注入先例 task.service）
import {
  DOMAIN_EVENTS,
  ExecutorOfflineEventPayload,
} from "../../common/events/domain-events";
import { DomainEventBus } from "../../common/services/domain-event-bus.service";
import { Optional } from "@nestjs/common";
// ARCH-31 §5: cron 维护任务统一 Leader 门禁（@Optional 同 eventBus 先例——
// 既有单测直接 new 装配时 gate 缺席 → null → 门禁不生效）。
import { LeaderGateService } from "../../common/leader-gate/leader-gate.service";
// CORE-02: 重试退避抖动——±20% 摊开同刻重试（recovery re-enqueue 路径）
import { jitteredRetryDelayMs } from "../task/retry-backoff.util";
// CORE-05: 评分公式抽出（selectLeastLoaded / dispatch 双站点共享同一实现）
import { computeExecutorLoadScore } from "./executor-score.util";
import type { EstimatedDurations } from "./executor-score.util";
// OBS-01: 派发链路追踪——dispatch span + traceparent 头透传执行器
import { TracingService } from "../../common/tracing/tracing.service";
// AUTH-05: 高危操作（rotate-token / 删除执行器）审计留痕
import { AuditService } from "../audit/audit.service";
// NETOPT-8①: task_executions retention 删行前回收 S3 日志对象——S3 GC 候选
// 只能来自存活行，行删指针消失即成永久孤儿（详见 deleteExpiredExecutionRowsBatch）
import { S3LogStorage } from "../task/log-storage/s3-log-storage";
// NETOPT-8④: 分批 DELETE 循环的轮数/墙钟双闸（LOG-RETENTION-01 回移植）
import { cappedBatchedDelete } from "../../common/utils/capped-batched-delete.util";
// A6: 对账端点响应契约（三端共载，见 DTO 头注）
import type { TerminalStatesResponseDto } from "./dto/executor-terminal-states.dto";

/**
 * A6（DEEP_REVIEW §七）：死信对账窗口的上界。
 *
 * 对账是**执行器主动拉**的：一台执行器在死信堆积时会反复来问。若不设上界，
 * 一个写坏的 since（或一台时钟错乱的执行器）就能让 admin 去扫整张
 * task_executions。30 天足够覆盖最长场景——死信文件本身会被执行器侧 TTL
 * 清理（node: removeOlderThan；python: _cleanup_dead_letter_files），活不过
 * 30 天。超过上界的 since 被**钳到**上界（不是报错）：对账是尽力而为的
 * 后台动作，因为参数写错就让整个对账停摆比多扫一点更糟。
 */
export const TERMINAL_STATES_MAX_LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000;
/** 单页默认/最大条数。hasMore=true 时执行器下一轮继续取。 */
export const TERMINAL_STATES_DEFAULT_LIMIT = 500;
export const TERMINAL_STATES_MAX_LIMIT = 2000;
/**
 * since 缺省/非法时的回退窗口。取 24h 是为了与 E-05 的重发预算同量级：比一个
 * 预算期更早终态的执行，其死信文件在执行器侧早已被 TTL 清理（node
 * removeOlderThan / python _cleanup_dead_letter_files），对账它没有意义。
 */
export const TERMINAL_STATES_DEFAULT_LOOKBACK_MS = 24 * 60 * 60 * 1000;

/**
 * Executor lifecycle audit（P3-9）：findAll() 的硬上限。管理台列表的筛选/
 * 搜索/计数全部在客户端对返回数组做，超过该上限的行会被**静默截断**——
 * 因此该值同时经 GET /executors/runtime-config 暴露给前端，让 UI 能给出
 * "仅显示前 N / 共 M 台"的提示，而不是把子集说成全量。需要更多行时应做
 * 服务端分页（见 findAll 注释）。
 */
export const EXECUTOR_LIST_LIMIT = 500;

@Injectable()
export class ExecutorService {
  private readonly logger = new Logger(ExecutorService.name);
  private readonly protocol: string;

  // F-5: short-lived in-process cache of SUCCESSFUL per-address token
  // validations. Each validation otherwise runs bcrypt (cost 12, ~100-300ms
  // of pure CPU), which made unauthenticated executor endpoints (callback,
  // heartbeat) a CPU-DoS vector. Only positive results are cached (bounded by
  // the fleet size), keyed by sha256(address|token) so raw tokens never sit in
  // memory. 值里额外存 address：键是单向哈希，无法按地址前缀删除，而
  // rotateToken()/removeById() 必须让该地址的全部旧凭据正结果立刻失效——
  // 否则「撤销」会有最长 TOKEN_CACHE_TTL_MS 的失效窗口（evictTokenValidationsFor
  // 按值扫描）。正缓存只是省 bcrypt，驱逐不会削弱 DoS 防护（轮换/删除是低频
  // 管理动作，旧凭据本就该重新走一次 bcrypt 并被拒）。
  private static readonly TOKEN_CACHE_TTL_MS = 60_000;
  private static readonly TOKEN_CACHE_MAX = 1000;
  private readonly tokenValidationCache = new Map<
    string,
    { address: string; cachedAt: number }
  >();

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

  // F-08（本轮审计）: applications.packageUrl 的短 TTL **正缓存**（30s）。
  // 背景：每次 dispatch/dispatchBroadcast 的 zip 分支都 applicationRepo.findOne
  // 查一次 packageUrl，对高频 zip 任务（如 cron 每分钟）每次派发多一次 DB 往返。
  // packageUrl 只在应用版本上传/回滚时变化（低频），30s 内短暂陈旧可接受。
  //
  // 只缓存**成功**结果（positive-only，对齐 tokenValidationCache 的既有先例）：
  // 应用不存在 / 未配置 packageUrl 的失败恒重新查库——失败态缓存会掩盖"管理员
  // 刚补上 packageUrl 就能恢复"的场景。条目数上界 = applications 行数（每应用
  // 一条），TTL 到期的条目在下次命中时惰性淘汰，不引入定时器。
  private static readonly PACKAGE_URL_CACHE_TTL_MS = 30_000;
  private readonly packageUrlCache = new Map<
    string,
    { packageUrl: string; cachedAt: number }
  >();

  // F-07（本轮审计）: 调度候选执行器池上限（EXECUTOR_CANDIDATE_POOL_SIZE，
  // 默认 500，与既有硬编码逐字节一致）。容错解析：非法/非数字（如测试装配里
  // configService.get 的兜底返回值）一律回退 500——**绝不**把 0/NaN 传给
  // take（take:0 会查空集，take:NaN 会抛错）。
  private get candidatePoolSize(): number {
    const raw = this.configService.get("executor.candidatePoolSize");
    const n = typeof raw === "number" ? raw : Number(raw);
    return Number.isInteger(n) && n > 0 ? n : 500;
  }

  constructor(
    @InjectRepository(Executor) private repo: Repository<Executor>,
    @InjectRepository(TaskExecution)
    private execRepo: Repository<TaskExecution>,
    @InjectRepository(Task) private taskRepo: Repository<Task>,
    // FEAT-04: metrics-history pipeline. Heartbeat keeps the current executor
    // row fresh and appends a best-effort snapshot for the 24h trend read side.
    @InjectRepository(ExecutorMetricsHistory)
    private metricsHistoryRepo: Repository<ExecutorMetricsHistory>,
    @InjectQueue("task-queue") private taskQueue: Queue,
    private readonly configService: ConfigService,
    private readonly notificationService: NotificationService,
    private readonly systemConfigService: SystemConfigService,
    // SEC-02: dispatch 时解密 task.secrets（与 params 合并注入执行器 env）。
    // 跨 task↔executor 模块环的 provider 注入：模块级 forwardRef 配套
    // （executor.module 同位置注释）。
    @Inject(forwardRef(() => SecretsCryptoService))
    private readonly secretsCrypto: SecretsCryptoService,
    // FEAT-07: executor.offline 出站事件发布（@Global 总线；@Optional 仅为
    // 既有单测装配兼容——provider 缺失 → null → 事件静默不发，主链行为不变，
    // 先例同 task.service 的 eventBus 注入）。
    @Optional()
    private readonly eventBus: DomainEventBus | null = null,
    // OBS-01: 派发追踪（@Global 恒提供；disabled 时全短路零开销）。
    // @Optional 仅为既有单测装配兼容（先例 eventBus）。
    @Optional()
    private readonly tracing: TracingService | null = null,
    // AUTH-05: 高危操作审计（rotate-token / 删除执行器）。@Optional 与
    // eventBus 同先例——存量单测未提供 AuditService 时降级为仅日志，主链
    // 不变（审计 best-effort，log() 抛错也绝不影响业务结果）。
    @Optional()
    private readonly audit: AuditService | null = null,
    // ARCH-31 §5: 多实例下 @Cron 维护任务仅 cron Leader 执行（@Global 恒提供；
    // @Optional 仅为既有单测装配兼容，先例 eventBus/tracing）。
    @Optional()
    private readonly leaderGate: LeaderGateService | null = null,
    // ARCH-32: pull 模式派发队列（ADR-015）。@Optional 同先例——存量单测
    // 装配未提供时为 null；pull 分支显式守卫抛错（不静默丢任务）。
    @Optional()
    private readonly pullService: ExecutorPullService | null = null,
    // python_task_multiversion（WS2 · CONTRACT §2.4/§3.1）：派发时解析
    // `applications.packageUrl`。@Optional 同先例——存量单测装配未提供时为
    // null；仅当任务确为 zip 渠道时才需要它，缺失即明确失败（不静默降级成
    // "下发无 packageUrl 的任务"，那会让执行器在运行时才炸）。**必须是最后
    // 一个位置参数**：既有 spec 以 14 个位置参数 `new ExecutorService(...)`
    // 直接装配，追加带默认值的尾参不破坏它们。
    @Optional()
    @InjectRepository(Application)
    private readonly applicationRepo: Repository<Application> | null = null,
  ) {
    this.protocol = this.configService.get<string>("app.protocol") || "http";
    // R-26（DEEP_REVIEW 0ef3bbe）: 关键 @Optional（事件总线 / 高危审计）缺失时
    // 一次性 warn，使静默降级在日志面可见——eventBus 缺失则 executor.offline
    // 事件静默不发；audit 缺失则 rotate-token 等高危操作审计静默不写。
    if (!this.eventBus) {
      this.logger.warn(
        "R-26: DomainEventBus 未装配——executor.offline 事件将静默不发",
      );
    }
    if (!this.audit) {
      this.logger.warn(
        "R-26: AuditService 未装配——executor 高危操作审计将静默不写",
      );
    }
  }

  /**
   * AUTH-05: best-effort audit write for high-risk executor operations.
   * Never throws — an audit failure must not fail the operation itself
   * (the operation already succeeded at this point). No operator identity is
   * captured here on purpose: the admin surface (JWT principal) lives in the
   * controller layer; the reason (when the caller supplied one) is recorded
   * in detail.
   */
  private async auditHighRisk(
    action: "executor.rotate_token" | "executor.delete",
    executor: Pick<Executor, "id" | "address" | "appName">,
    reason?: string,
  ): Promise<void> {
    if (!this.audit) return;
    try {
      await this.audit.log({
        action,
        resource: "executor",
        resourceId: executor.id,
        detail: {
          address: executor.address,
          appName: executor.appName,
          ...(reason ? { reason } : {}),
        },
      });
    } catch (e) {
      this.logger.warn(
        `audit write failed for ${action} on executor ${executor.id}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  /**
   * FEAT-07: 状态落库后发布 executor.offline（fail-open——emit 抛错绝不改变
   * 调用方结果；eventBus 为 null 时静默跳过）。载荷全为原始类型，与
   * domain-events.ts 设计约束一致。
   */
  private emitExecutorOffline(
    executor: Pick<Executor, "id" | "appName" | "address">,
  ): void {
    if (!this.eventBus) return;
    const payload: ExecutorOfflineEventPayload = {
      executorId: executor.id,
      appName: executor.appName,
      address: executor.address,
      occurredAt: new Date().toISOString(),
    };
    try {
      this.eventBus.emit(DOMAIN_EVENTS.EXECUTOR_OFFLINE, payload);
    } catch {
      /* bus contract is fail-open; second fuse */
    }
  }

  public getExecutorUrl(address: string, path: string): string {
    // SEC-SSRF-03：地址来自执行器自报的 register/heartbeat 字段，未做归一。
    // 若地址里含 '#'，URL 解析会把其后内容当作 fragment，导致我们拼出的
    // 路径被整体丢进 fragment —— 实测 `http://10.0.0.5#` + 'api/executions/x'
    // 解析出的 pathname 是 "/"（而非预期的 /api/executions/x），于是请求打到
    // 目标主机的根路径。这既会让调用错端点，也会在未守卫的调用点把
    // admin 的带 token 请求引到攻击者选定的路径上。
    // '?' 同理会把路径变成查询串的一部分。两者都不是合法执行器地址的一部分，
    // 一律先剥离，保证拼出的 URL 路径就是我们传入的 path。
    const sanitized = address.split(/[?#]/, 1)[0];
    if (address.startsWith("http://") || address.startsWith("https://")) {
      return `${sanitized.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
    }
    return `${this.protocol}://${sanitized.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
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
          // CORE-02: recovery 重试的 attempt 序号 = retryCount+1（该执行行
          // 本身就是第 nextRetryCount 次重试的载体），delay 预乘指数基座并加
          // ±20% 抖动；返回 0（retryDelay<=0）保持 backoff: undefined 语义。
          backoff:
            task.retryDelay > 0
              ? {
                  type: "exponential",
                  delay: jitteredRetryDelayMs(task.retryDelay, nextRetryCount),
                }
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
      // SEC-SSRF-02：与其他执行器出站调用保持一致——此前本处漏掉守卫，会把
      // 共享 token 作为 Bearer 发给 executorAddress 指定的任意主机（含
      // link-local 云元数据与 loopback）。守卫抛错由下方 catch 收敛为 warn，
      // 符合本方法「绝不抛出」的既有契约（调用方为调度器清扫与手动 kill，
      // 不应因一个可疑地址而中断）。
      // F-3（SEC-NEW）: 同时 pin 到校验通过的 IP（Host/SNI 保留）。
      const pinned = await assertAndPinExecutorUrl(url);
      const pinCfg = pinnedAxiosConfig(pinned);
      await axios.post(
        url,
        {},
        {
          headers,
          timeout: 3_000,
          maxRedirects: 0,
          ...pinCfg,
        },
      );
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
    let failedCount = 0;
    let errorCount = 0;
    for (const execution of executionsToFail) {
      const task = execution.taskId
        ? (taskMap.get(execution.taskId) ?? null)
        : null;
      // R-11（DEEP_REVIEW 0ef3bbe）：逐行 try/catch 异常隔离——单行乐观锁冲突
      // （OptimisticLockVersionMismatchError）或其他 DB 异常不得击穿整个
      // register/heartbeat 流程（否则心跳 500 → 执行器被连锁判离线）。
      // 失败行留给 stale sweep 收敛；异常计数超阈值时整体 warn。
      try {
        execution.status = ExecutionStatus.FAILED;
        execution.endTime = new Date();
        execution.failureReason = ExecutionFailureReason.EXECUTOR_RESTART;
        execution.errorMessage =
          "[System] Executor restarted before reporting completion";
        execution.logs = `${execution.logs || ""}\n[System] Executor restarted; execution marked as FAILED`;
        // A1: 走统一终态门（带 open-status 谓词 + RETURNING），替代裸 save。
        // 已终态的行不会被覆盖，避免双重释放槽位/双重调度重试。
        const result = await transitionOneToTerminal(this.execRepo, {
          id: execution.id,
          patch: {
            status: ExecutionStatus.FAILED,
            endTime: execution.endTime,
            failureReason: ExecutionFailureReason.EXECUTOR_RESTART,
            errorMessage: execution.errorMessage,
            logs: execution.logs,
          },
        });
        if (result.transitioned) {
          const addr =
            result.rows[0]?.executorAddress ?? execution.executorAddress;
          await this.releaseExecutorSlot(addr);
          if (task) await this.scheduleRetryAfterRecovery(task, execution);
          failedCount++;
        }
      } catch (err: unknown) {
        errorCount++;
        this.logger.warn(
          `R-11: Failed to mark execution ${execution.id} as FAILED after restart ` +
            `(executor=${executorAddress}): ${err instanceof Error ? err.message : String(err)}. ` +
            `Stale sweep will pick it up.`,
        );
      }
    }
    if (executionsToFail.length > 0) {
      this.logger.warn(
        `Marked ${failedCount}/${executionsToFail.length} running execution(s) as FAILED after executor restart: ${executorAddress}` +
          (errorCount > 0
            ? ` (${errorCount} row(s) had errors and will be retried by stale sweep)`
            : ""),
      );
    }
    // R-P0-009: Return the count of failed executions for caller to adjust runningTaskCount
    return failedCount;
  }

  /**
   * ARCH-32: 按地址取执行器行（pull 端点解析队列归属 executorId 用）。
   * 地址是 register/heartbeat 的身份键（与 validateTokenByAddress 同源），
   * id 才是稳定的队列键——地址可漂移（重注册换网），id 不变。
   */
  async findByAddress(address: string): Promise<Executor | null> {
    return this.repo.findOne({ where: { address } });
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
    dispatchMode?: string;
    // PROTOCOL-VER（B-3/U-2）：协议版本（可选整数；缺省 → 不动 DB）。
    protocolVersion?: number | null;
    // python_task_multiversion（WS2 · CONTRACT §2.3）：解释器缓存池清单。
    // 缺省 → 不动 DB；结构非法 → 拒绝采纳 + warn；合法（含 []）→ 覆盖。
    interpreters?: ExecutorInterpreter[] | null;
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
    // python_task_multiversion（WS2 · CONTRACT §2.2/§2.3）：注册面采纳
    // `interpreters`，规则与 heartbeat 的 deadLetterCount 完全一致——
    // 字段缺省（未发送）→ 不动 DB 值（**关键**：旧执行器的重注册不得把已
    // 上报的清单擦掉）；存在但结构非法 → 整字段拒绝采纳 + warn，DB 保留旧值；
    // 合法（**含 []**，"已上报且池空"）→ 覆盖。
    const interpretersReported = data.interpreters !== undefined;
    const normalizedInterpreters = interpretersReported
      ? normalizeInterpreters(data.interpreters)
      : null;
    if (interpretersReported && normalizedInterpreters === null) {
      this.logger.warn(
        `Executor ${data.address} reported an invalid interpreters payload ` +
          `(expected an array of { version: "X.Y" | "X.Y.Z" }); keeping stored value`,
      );
    }
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
        type: data.type as ExecutorType,
        executorVersion: data.version,
        capabilities: capabilities,
        maxConcurrentTasks: maxConcurrentTasks,
        groupName: data.groupName,
        tags: data.tags,
        description: data.description,
        executorStartedAt: incomingStartedAt ?? undefined,
        executorStartupId: incomingStartupId ?? undefined,
        // ARCH-32: 派发模式（ADR-015）——仅接受 'pull'；缺省/非法 → undefined
        // → 列默认 'push'。执行器自报面不可信，枚举外值一律落回 push。
        dispatchMode: data.dispatchMode === "pull" ? "pull" : undefined,
        // PROTOCOL-VER（B-3/U-2）：首注册即上报则落列；缺省/非法 → undefined
        // → 列保持 NULL（= 未上报，按 protocolVersion=1 兜底）。
        protocolVersion:
          typeof data.protocolVersion === "number" &&
          Number.isInteger(data.protocolVersion)
            ? data.protocolVersion
            : undefined,
        // python_task_multiversion：首注册即上报则落列；缺省/非法 → undefined
        // → 列保持 NULL（= 未上报，调度按 ["3.12"] 兜底）。
        interpreters: normalizedInterpreters ?? undefined,
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
    if (data.type) e.type = data.type as ExecutorType;
    if (data.appName) e.appName = data.appName;
    if (data.version) e.executorVersion = data.version;
    if (capabilities) e.capabilities = capabilities;
    if (maxConcurrentTasks !== undefined)
      e.maxConcurrentTasks = maxConcurrentTasks;
    if (data.groupName !== undefined) e.groupName = data.groupName;
    if (data.tags !== undefined) e.tags = data.tags;
    if (data.description !== undefined) e.description = data.description;
    // ARCH-32: pull↔push 切换随重注册生效（执行器改 EXECUTOR_PULL_MODE 后
    // 重启即触发 didRestart 路径）。
    if (data.dispatchMode === "push" || data.dispatchMode === "pull") {
      e.dispatchMode = data.dispatchMode;
    }
    // python_task_multiversion：重注册采纳（仅在合法上报时覆盖；非法/缺省
    // 均不动 DB —— 非法情形上方已 warn）。
    if (normalizedInterpreters !== null) {
      e.interpreters = normalizedInterpreters;
    }
    // PROTOCOL-VER（B-3/U-2）：重注册采纳协议版本（仅整数合法值覆盖；
    // 缺省/非法不动 DB，保持未上报/NULL 语义）。
    if (
      typeof data.protocolVersion === "number" &&
      Number.isInteger(data.protocolVersion)
    ) {
      e.protocolVersion = data.protocolVersion;
    }
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
    // PROTOCOL-VER（B-3/U-2）：协议版本（可选整数；低于下限 warn + 兜底）。
    protocolVersion?: number | null;
    capabilities?: string[];
    runtime?: string[];
    maxConcurrentTasks?: number;
    maxConcurrent?: number;
    groupName?: string | null;
    tags?: string[] | null;
    description?: string | null;
    restartedAt?: string | Date | null;
    startupId?: string | null;
    dispatchMode?: string;
    interpreters?: ExecutorInterpreter[] | null;
  }): Promise<{ executor: Executor; perExecutorToken: string | null }> {
    // EXE-VER-1: 最低版本门禁。EXECUTOR_MIN_VERSION 非空时，执行器上报的
    // version 低于下限 → 403（报文含下限与升级指引），且发生在任何落库/
    // 发 token 副作用之前。未上报 version 的存量旧执行器放行 + warn（不
    // 锁死存量）；isVersionCompliant 对畸形版本号也放行（NaN 语义）。
    // 门禁关（默认空串）时此块整体短路，行为逐字节不变。
    const minVersion =
      this.configService.get<string>("executor.minVersion") || "";
    if (
      minVersion &&
      data.version &&
      !isVersionCompliant(data.version, minVersion)
    ) {
      throw new ForbiddenException(
        `Executor version ${data.version} is below the required minimum ${minVersion} (EXECUTOR_MIN_VERSION). ` +
          `Upgrade the executor: re-run the install wizard / install-cmd, or download the latest executor artifact.`,
      );
    }
    if (minVersion && !data.version) {
      this.logger.warn(
        `Register from ${data.address} did not report a version; EXECUTOR_MIN_VERSION=${minVersion} cannot be enforced for it (legacy executor allowed)`,
      );
    }
    // PROTOCOL-VER（B-3/U-2）：协议版本兼容矩阵分支——低于下限**不拒绝注册**，
    // 只 warn + 按旧协议兜底（与 EXECUTOR_MIN_VERSION 实现版本门禁是两套闸；
    // 兼容性红线见 protocol.json `versioning` 段）。未上报（null/undefined）
    // 的存量旧执行器按基线协议 1 兜底，同样放行。
    if (
      typeof data.protocolVersion === "number" &&
      !isProtocolCompliant(data.protocolVersion, PROTOCOL_SUPPORTED_MIN)
    ) {
      this.logger.warn(
        `Register from ${data.address} reports protocolVersion=${data.protocolVersion}, below the supported minimum ${PROTOCOL_SUPPORTED_MIN}; ` +
          `treating it as the legacy baseline protocol (fields added after it will be omitted/ignored, not rejected)`,
      );
    }
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

  /**
   * python_task_multiversion（WS2 · CONTRACT §3.1）：解释器缓存池过滤——三处
   * 调度站点（`selectLeastLoaded` / `dispatch` / `dispatchBroadcast`）共享同一
   * 实现，杜绝三份漂移（对齐 `executor-score.util` 的抽取先例）。
   *
   * 语义全部由 `interpreter-match.util` 承载（NFR-08：纯内存、O(清单长度)、
   * **零** DB/网络往返）；本方法只做「过滤 + 失败时构造含快照的消息」。
   *
   * 返回 `{ kept, message }`：`message` 非 null 表示过滤后无候选，调用方按各自
   * 既有异常类型抛出（`ServiceUnavailableException` vs `Error` 的语义不变）。
   * `message` 里含**过滤前**每个候选执行器的已缓存解释器快照（AC-09b）。
   *
   * 未声明 `runtimeVersion` 时零过滤（`hasRequestedVersion` 判定）——存量任务
   * 的调度路径逐字节不变（兼容性红线 1）。
   */
  private applyInterpreterFilter(
    executors: Executor[],
    requested: string | null | undefined,
  ): { kept: Executor[]; message: string | null } {
    if (!hasRequestedVersion(requested)) {
      return { kept: executors, message: null };
    }
    const requestedVersion = (requested as string).trim();
    const kept = executors.filter((e) =>
      interpreterSatisfies(e.interpreters, requestedVersion),
    );
    if (kept.length > 0) return { kept, message: null };
    return {
      kept,
      message: buildInterpreterMismatchMessage(
        requestedVersion,
        executors.map((e) => ({
          appName: e.appName,
          interpreters: e.interpreters,
        })),
      ),
    };
  }

  /**
   * 调度期解释器不可获取的统一落日志 + 抛出。
   *
   * 分因经 `ExecutionFailureReason.INTERPRETER_UNAVAILABLE` 落日志（与消息里的
   * token 同源，CONTRACT §2.5 的"三处同步"之一）：调度阶段只抛错不落库，终态由
   * `task.processor` 的失败路径写，故日志是派发期唯一可检索的留痕。
   */
  private failInterpreterUnavailable(message: string): never {
    this.logger.warn(
      `Dispatch blocked: failureReason=${ExecutionFailureReason.INTERPRETER_UNAVAILABLE} ${message}`,
    );
    throw new Error(message);
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
      // python_task_multiversion（WS2 · CONTRACT §2.3）：解释器缓存池清单。
      // 缺省 → 保留 DB 旧值；结构非法 → 拒绝采纳 + warn；合法（含 []）→ 覆盖。
      interpreters?: ExecutorInterpreter[] | null;
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
      // python_task_multiversion：interpreters 不是数值指标列，从 metricValues
      // 中摘出单独走结构校验（不进 metricsWhitelist 的数值写入环）。
      interpreters,
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
    // metricsWhitelist 的键全部对应 Executor 的数值指标列（Pick<Executor, …>
    // 为纯上转型断言）——写入经由该视图而非 `(e as any)`，保持类型面精确；
    // 运行时行为与原逐键直写完全一致。
    const writableMetrics = e as Pick<
      Executor,
      (typeof metricsWhitelist)[number]
    >;
    for (const key of metricsWhitelist) {
      if (metricValues[key] !== undefined) {
        writableMetrics[key] = metricValues[key];
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
    // python_task_multiversion（WS2 · CONTRACT §2.2/§2.3 · 兼容性红线 3）：
    // 心跳采纳 `interpreters`——三态必须精确区分，任一态混淆都会造成调度错判：
    // - 字段 `undefined`（旧执行器心跳 / 新版未变化时不上报）→ **保留 DB 旧值**。
    //   这是红线 3 的字面要求：旧心跳绝不能把已上报的清单清空（清空后该执行器
    //   会被当成"池空"而彻底接不到带版本声明的任务）。
    // - 存在但结构非法（非数组 / 项缺 version / version 非 X.Y|X.Y.Z）→ 整字段
    //   拒绝采纳 + warn，DB 保留旧值（脏上报不得污染调度判据）。
    // - 合法（**含 `[]`**，"已上报且缓存池为空"）→ 覆盖。
    if (interpreters !== undefined) {
      const normalizedInterpreters = normalizeInterpreters(interpreters);
      if (normalizedInterpreters === null) {
        this.logger.warn(
          `Executor ${address} reported an invalid interpreters payload ` +
            `(expected an array of { version: "X.Y" | "X.Y.Z" }); keeping stored value`,
        );
      } else {
        e.interpreters = normalizedInterpreters;
      }
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
    try {
      await this.metricsHistoryRepo.save(
        this.metricsHistoryRepo.create({
          executorAddress: saved.address,
          cpuUsage: saved.cpuUsage ?? null,
          memUsage: saved.memUsage ?? null,
          diskUsage: saved.diskUsage ?? null,
          runningTaskCount: saved.runningTaskCount ?? 0,
          totalTaskCount: saved.totalTaskCount ?? 0,
          failedTaskCount: saved.failedTaskCount ?? 0,
          avgExecutionTime: null,
          uptimeSeconds: 0,
        }),
      );
    } catch (err) {
      this.logger.warn(
        `metrics history write failed for executor ${address}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return saved;
  }

  findAll() {
    // Cap the result set: an admin UI listing does not need every historical executor.
    // Use pagination if the UI needs more — the ExecutorListPage supports filters/search.
    // 上限值经 EXECUTOR_LIST_LIMIT 导出并由 getRuntimeConfig() 回传前端，
    // 超限时 UI 显示 "仅显示前 N / 共 M 台"（P3-9，不再静默截断）。
    //
    // UI-17: 逐行计算 versionCompliant（EXE-VER-1 门禁 EXECUTOR_MIN_VERSION 的
    // 读面投影）——执行器版本存于 register/心跳，下限在中心端配置，合规态是
    // 两者的派生值，不落库（列不加、心跳响应已有回显，此处供列表 UI 展示）。
    // 门禁关 / 执行器未上报版本 → true（isVersionCompliant 宽松语义）。
    const minVersion =
      this.configService.get<string>("executor.minVersion") || "";
    return this.repo
      .find({ order: { createdAt: "DESC" }, take: EXECUTOR_LIST_LIMIT })
      .then((rows) =>
        rows.map((e) => ({
          ...e,
          versionCompliant: isVersionCompliant(e.executorVersion, minVersion),
        })),
      );
  }

  /**
   * Executor lifecycle audit（P2-5 / P3-9）：回传执行器面的**有效运行时参数**，
   * 供管理台与后端判定保持同源，消灭前端硬编码常量与后端配置漂移：
   *
   * - `heartbeatTimeoutMs` = heartbeatInterval（默认 30000ms）×
   *   heartbeatTimeoutMultiplier（默认 3）= 默认 90s。这正是
   *   markStaleOffline() 把 ONLINE 判成 OFFLINE 的截止阈值；前端此前硬编码
   *   5 分钟，于是后端判死后的约 3.5 分钟里 UI 仍把心跳画成"刚刚（绿）"。
   * - `listLimit` / `executorTotal`：findAll() 的截断上限与全量行数，
   *   total > limit 时 UI 必须提示只展示了子集（P3-9）。
   */
  async getRuntimeConfig(): Promise<{
    heartbeatIntervalMs: number;
    heartbeatTimeoutMultiplier: number;
    heartbeatTimeoutMs: number;
    listLimit: number;
    executorTotal: number;
  }> {
    const heartbeatIntervalMs =
      this.configService.get<number>("executor.heartbeatInterval") || 30000;
    const heartbeatTimeoutMultiplier =
      this.configService.get<number>("executor.heartbeatTimeoutMultiplier") ||
      3;
    const executorTotal = await this.repo.count();
    return {
      heartbeatIntervalMs,
      heartbeatTimeoutMultiplier,
      heartbeatTimeoutMs: heartbeatIntervalMs * heartbeatTimeoutMultiplier,
      listLimit: EXECUTOR_LIST_LIMIT,
      executorTotal,
    };
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
    // python_task_multiversion（WS2 · CONTRACT §3.1）：可选版本声明——传入时
    // 追加解释器缓存池过滤。**可选尾参**：既有唯一生产调用方
    // （app-deployment.service 的 `selectLeastLoaded()`）零参数调用，行为不变。
    runtimeVersion?: string | null;
  }): Promise<Executor> {
    const all = await this.repo.find({
      where: { status: ExecutorStatus.ONLINE },
      // O-1（中台↔执行器深度审查）：候选池由「随机取 N 行再内存排序」改为
      // **SQL 级 Top-K**（ORDER BY runningTaskCount ASC LIMIT K）。旧实现
      // take 截断是**静默的**：超过 K 台在线时，排名 K+1 的负载最小执行器
      // 永远不被考虑——"generous cap" 在万级机队下是容量盲区。按 runningTaskCount
      // 升序取前 K 保证**最空闲的一批**必入池，内存评分公式在其上择优（评分是
      // 复合指标，SQL 只做负载维度的下界保证，二者不冲突）。
      order: { runningTaskCount: "ASC" },
      // F-07（本轮审计）: 上限提为可配（EXECUTOR_CANDIDATE_POOL_SIZE，默认 500）。
      take: this.candidatePoolSize,
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

    // python_task_multiversion（WS2 · CONTRACT §3.1）：解释器缓存池过滤——
    // 与 dispatch / dispatchBroadcast 同一位置（runtime 之后）与同一共享实现。
    // NFR-08：纯内存过滤，**不**引入候选级 DB/网络往返。
    const interpreterFiltered = this.applyInterpreterFilter(
      candidates,
      opts?.runtimeVersion,
    );
    if (interpreterFiltered.message) {
      // 既有错误类型保持不变（ServiceUnavailableException = 调度面"无可用
      // 执行器"，与下方两条 no-eligible-executor 分支同类）。
      this.logger.warn(
        `selectLeastLoaded blocked: failureReason=${ExecutionFailureReason.INTERPRETER_UNAVAILABLE} ${interpreterFiltered.message}`,
      );
      throw new ServiceUnavailableException(interpreterFiltered.message);
    }
    candidates = interpreterFiltered.kept;

    if (candidates.length === 0) {
      throw new ServiceUnavailableException(
        "No online executors match the requested group/tags/runtime",
      );
    }

    // Weighted scoring (see executor-score.util.ts for the formula and units):
    // 50% task load ratio + 25% CPU + 25% memory + 10% long-task penalty
    // (CORE-05: executors currently running long-estimated tasks score worse,
    // so a long task is preferentially steered to the emptier executor).
    // Executors at or above max capacity are excluded before scoring.
    const available = candidates.filter((e) => {
      const max = e.maxConcurrentTasks ?? Infinity;
      return e.runningTaskCount < max;
    });
    const estimatedDurations =
      await this.estimatedDurationsByExecutor(available);
    const scored = available
      .map((e) => ({
        executor: e,
        score: computeExecutorLoadScore(e, {
          estimatedDurations: estimatedDurations.get(e.address) ?? [],
        }),
      }))
      .sort((a, b) => a.score - b.score);

    if (scored.length === 0) {
      throw new ServiceUnavailableException(
        "No available executor — all online executors are at maximum capacity",
      );
    }
    // E-2（中台↔执行器深度审查）：与 dispatch 同款结构化决策日志——「为什么选
    // 这台、过滤掉多少、评分面多大、落选者差多少」可回溯。opts 恒为可选尾参，
    // 零参数调用（app-deployment）也正常输出。
    this.logger.log(
      JSON.stringify({
        event: "selectLeastLoaded.decision",
        poolSize: all.length,
        afterFilters: candidates.length,
        scoredCount: scored.length,
        selected: {
          address: scored[0].executor.address,
          score: Number(scored[0].score.toFixed(3)),
          runningTaskCount: scored[0].executor.runningTaskCount,
          maxConcurrentTasks: scored[0].executor.maxConcurrentTasks,
        },
        topRunners: scored.slice(1, 4).map((s) => ({
          address: s.executor.address,
          score: Number(s.score.toFixed(3)),
          runningTaskCount: s.executor.runningTaskCount,
          maxConcurrentTasks: s.executor.maxConcurrentTasks,
        })),
      }),
    );
    return scored[0].executor;
  }

  /**
   * CORE-05: 批量读取候选执行器当前 RUNNING 任务的预估时长集合（秒）。
   * 任何失败（查询异常/行丢失）按"无估时"降级 → longTaskPenalty=0，
   * 评分退化为旧公式，调度永不因可观测性辅助面中断。
   */
  private async estimatedDurationsByExecutor(
    executors: Executor[],
  ): Promise<Map<string, EstimatedDurations>> {
    const active = executors.filter((e) => e.runningTaskCount > 0);
    if (active.length === 0) return new Map();

    try {
      const addresses = [...new Set(active.map((e) => e.address))];
      const running = await this.execRepo.find({
        where: {
          executorAddress: In(addresses),
          status: ExecutionStatus.RUNNING,
        },
        select: ["executorAddress", "taskId"],
      });
      if (running.length === 0) return new Map();

      const ids = [...new Set(running.map((r) => r.taskId))];
      const rows = await this.taskRepo.find({
        where: { id: In(ids) },
        select: ["id", "estimatedDurationSec"],
      });
      const byId = new Map(rows.map((r) => [r.id, r.estimatedDurationSec]));
      const byAddress = new Map<string, EstimatedDurations>();
      for (const row of running) {
        const durations = byAddress.get(row.executorAddress) ?? [];
        durations.push(byId.get(row.taskId) ?? null);
        byAddress.set(row.executorAddress, durations);
      }
      return byAddress;
    } catch {
      return new Map();
    }
  }

  /**
   * E-2（中台↔执行器深度审查）：调度决策的结构化日志出口。
   *
   * 输出 JSON 面（单行，便于 grep/日志系统索引）：
   * - poolSize：SQL Top-K 后的候选池基数（pinned=1）；
   * - afterFilters：group/tags/runtime/interpreters 过滤后的剩余候选；
   * - scoredCount：参与计分的候选数（== afterFilters）；
   * - selected：选中执行器地址 + 评分 + 负载；
   * - topRunners：占坑前评分前三名（地址+评分+负载）——「为什么没派到某台」
   *   凭此可回溯（评分差距 / 落选者的负载）。过滤的逐项原因仍由
   *   applyInterpreterFilter 的失败快照日志兜底。
   */
  private logExecutionDispatchDecision(input: {
    taskName: string;
    executionId: string;
    poolSize: number;
    afterFilters: number;
    scoredCount: number;
    selected: Executor;
    scoredSnapshot: Array<{
      address: string;
      score: number;
      runningTaskCount: number;
      maxConcurrentTasks: number | null;
    }>;
  }): void {
    const selectedScore =
      input.scoredSnapshot.find((s) => s.address === input.selected.address)
        ?.score ?? null;
    this.logger.log(
      JSON.stringify({
        event: "dispatch.decision",
        task: input.taskName,
        executionId: input.executionId,
        poolSize: input.poolSize,
        afterFilters: input.afterFilters,
        scoredCount: input.scoredCount,
        selected: {
          address: input.selected.address,
          score: selectedScore,
          runningTaskCount: input.selected.runningTaskCount,
          maxConcurrentTasks: input.selected.maxConcurrentTasks,
        },
        topRunners: input.scoredSnapshot,
      }),
    );
  }

  async dispatch(task: Task, execution: TaskExecution) {
    let candidates: Executor[];
    // E-2: 决策日志的候选池基数（pinned=1；fleet 查询=SQL Top-K 后的行数）。
    let dispatchPoolSize = 0;

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
      dispatchPoolSize = 1;
      // python_task_multiversion（WS2 · CONTRACT §3.1 pinning 分支 / AC-08b /
      // D2③）：pinning **绕过** group/tags/runtime 过滤（pinning 的语义就是
      // "我指定这一台"），因此必须在此**单独补一道**解释器检查，且必须发生在
      // 下方原子占坑（runningTaskCount + 1）**之前**——占坑后才失败会把坑位
      // 白白占用到 TTL/回调超时，而 pinned 执行器永远不会回调。
      //
      // 消息含**声明版本**与 **pinned 执行器已缓存清单**（AC-08b 要求的
      // "至少一处明确报错"，此处即运行前报错）。
      if (
        hasRequestedVersion(task.runtimeVersion) &&
        !interpreterSatisfies(pinned.interpreters, task.runtimeVersion)
      ) {
        this.failInterpreterUnavailable(
          `[pinned] ${buildInterpreterMismatchMessage(
            (task.runtimeVersion as string).trim(),
            [{ appName: pinned.appName, interpreters: pinned.interpreters }],
          )}`,
        );
      }
    } else {
      const all = await this.repo.find({
        where: { status: ExecutorStatus.ONLINE },
        // O-1（中台↔执行器深度审查）：SQL 级 Top-K——按 runningTaskCount 升序
        // 取前 K，保证最空闲的一批必入候选池（旧 take 截断会静默漏掉排名 K+1
        // 的负载最小执行器，万级机队下是容量盲区）。选优仍走下方复合评分。
        order: { runningTaskCount: "ASC" },
        // Bound the candidate pool for the weighted-score selection below.
        // Score-and-pick-first needs only the top candidates, so a generous cap
        // is enough. See selectLeastLoaded() for the matching rationale.
        // F-07（本轮审计）: 上限提为可配（EXECUTOR_CANDIDATE_POOL_SIZE，默认 500）。
        take: this.candidatePoolSize,
      });
      dispatchPoolSize = all.length;

      candidates = all;

      // 1. Exact match by appName (manually specified by user)
      if (task.executorAppName) {
        candidates = all.filter((e) => e.appName === task.executorAppName);
        if (candidates.length === 0) {
          throw new Error(
            `No available executor with appName "${task.executorAppName}"`,
          );
        }
        // python_task_multiversion（WS2 · CONTRACT §3.1）：appName 精确匹配是
        // **用户显式点名**（语义接近 pinning，与 executorId 的差别只是按名字
        // 而非 id 定位），故不静默换机器——不满足即失败，且**保留上方
        // appName 未命中时的既有消息形态**（该分支语义是"这台不存在"，
        // 与本分支的"这台存在但跑不了该版本"必须可区分）。
        const byName = this.applyInterpreterFilter(
          candidates,
          task.runtimeVersion,
        );
        if (byName.message) {
          this.failInterpreterUnavailable(byName.message);
        }
        candidates = byName.kept;
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

        // 2.2b NF-04: affinity / anti-affinity tag constraints — applied
        // BEFORE loadScore ordering (filter first, then pick by load; see the
        // scoring step below). Both are nullable: null/[] = unconstrained, so
        // legacy tasks take none of these branches and behavior is unchanged.
        //   affinity = OR semantics: an executor holding ANY of the tags
        //   qualifies (soft routing intent — loadScore still optimizes inside
        //   the matched set); orthogonal to executorTags (2.2, hard AND
        //   subset), both may be set on the same task.
        if (task.executorAffinityTags && task.executorAffinityTags.length > 0) {
          filtered = filtered.filter((e) => {
            if (!e.tags) return false;
            return task.executorAffinityTags!.some((tag) =>
              e.tags!.includes(tag),
            );
          });
        }
        //   anti-affinity = exclusion semantics: an executor holding ANY of
        //   the tags is dropped. Combined with affinity this yields the
        //   intersection (affinity matches minus anti-affinity matches); with
        //   no affinity it simply prunes the fleet.
        if (
          task.executorAntiAffinityTags &&
          task.executorAntiAffinityTags.length > 0
        ) {
          filtered = filtered.filter((e) => {
            if (!e.tags) return true;
            return !task.executorAntiAffinityTags!.some((tag) =>
              e.tags!.includes(tag),
            );
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

        // 2.4 python_task_multiversion（WS2 · CONTRACT §3.1）：解释器缓存池
        // 过滤——追加在既有 runtime/capabilities 过滤**之后**（过滤顺序：
        // group → tags → affinity/anti-affinity → runtime → interpreter →
        // loadScore）。失败消息含每个候选的已缓存解释器快照（AC-09b）。
        const interpreterFiltered = this.applyInterpreterFilter(
          filtered,
          task.runtimeVersion,
        );
        if (interpreterFiltered.message) {
          this.failInterpreterUnavailable(interpreterFiltered.message);
        }
        filtered = interpreterFiltered.kept;

        if (filtered.length === 0) {
          throw new Error(
            "No online executors match the requested group/tags/runtime",
          );
        }
        candidates = filtered;
      }
    }

    // 3. Weighted scoring via the shared CORE-05 formula (load 50% + CPU 25% +
    // mem 25% + long-task penalty 10%, see executor-score.util.ts), try
    // optimistic lock in order.
    const estimatedDurations =
      await this.estimatedDurationsByExecutor(candidates);
    const withScores = candidates.map((c) => ({
      executor: c,
      score: computeExecutorLoadScore(c, {
        estimatedDurations: estimatedDurations.get(c.address) ?? [],
      }),
    }));
    // E-2（中台↔执行器深度审查）：占坑前的**评分快照**（occupation 会原地
    // 改 runningTaskCount/version，必须在 mutate 之前截取，供决策日志回溯）。
    const scoredSnapshot = withScores
      .slice()
      .sort((a, b) => a.score - b.score)
      .slice(0, 3)
      .map((s) => ({
        address: s.executor.address,
        score: Number(s.score.toFixed(3)),
        runningTaskCount: s.executor.runningTaskCount,
        maxConcurrentTasks: s.executor.maxConcurrentTasks,
      }));
    const sorted = withScores
      .sort((a, b) => a.score - b.score)
      .map((s) => s.executor);

    // QA-05/BUG-22：这里原先是「版本 CAS 占坑」——`.andWhere("version = :version")`
    // 用读取时的 version 做乐观锁。它把**良性并发**误判成失败：worker 并发 5 +
    // 单执行器时，第一个占坑成功就把 version +1，其余并发请求的 CAS 全部 affected=0；
    // 候选人只有一个 → 直接抛 "No available executor (all at capacity or
    // concurrency conflict)" → 执行 FAILED（maxRetry=0 时没有任何重试兜底）。
    // QA-05 本机实测：100 并发下成功率被此冲突主导（调大 MAX_CONCURRENT 只能
    // 40%→65%，因为失败根因不是容量而是 CAS）。
    //
    // 关键事实：占坑的两个不变量**本来就由同一条 UPDATE 的 WHERE 原子保证**——
    // ① 容量不超卖：`runningTaskCount < max` 与 `runningTaskCount + 1` 在同一条
    //    SQL 里求值（行锁串行化）；
    // ② 目标仍在线：`status = ONLINE` 同样在同一条 UPDATE 内复查（读取与写入之间
    //    被置 OFFLINE 的行会被这条 UPDATE 挡掉）。
    // 因此 version 谓词是**冗余**的，代价却是把并发占坑变成硬失败 —— 移除它，
    // 不变量不变，失败面收敛为「真的没容量/真的离线」。
    let matched: Executor | null = null;
    for (const candidate of sorted) {
      const maxConcurrent = candidate.maxConcurrentTasks ?? Infinity;

      // 原子占坑：容量与在线状态在同一条 UPDATE 内复查（无需版本谓词，见上注）
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
        // Update successful, synchronize local state
        candidate.runningTaskCount += 1;
        candidate.version += 1;
        matched = candidate;
        break;
      }
      // 该候选已满 / 已离线（并发占坑不再是失败来源）：试下一个候选
    }

    if (!matched)
      throw new Error(
        "No available executor (all candidates are offline or at capacity)",
      );

    // E-2（中台↔执行器深度审查）：调度决策**结构化日志**——之前只有一行
    // `Dispatching task ... to executor ...`，运维无法回溯「为什么选这台、过滤
    // 掉多少、评分多少、落选者差在哪」。现输出 JSON 面：候选池数（SQL Top-K 后）、
    // 过滤后数、评分/容量后的计分面、选中者评分、前三名落选者（地址+评分+负载）
    // ——「为何没派到某台」凭此可查（group/tags/interpreters 过滤的逐项原因仍由
    // applyInterpreterFilter 的失败快照日志兜底）。
    this.logExecutionDispatchDecision({
      taskName: task.name,
      executionId: execution.id,
      poolSize: dispatchPoolSize,
      afterFilters: candidates.length,
      scoredCount: withScores.length,
      selected: matched,
      scoredSnapshot,
    });

    this.logger.log(
      `Dispatching task "${task.name}" to executor ${matched.address} (runningTasks=${matched.runningTaskCount})`,
    );
    execution.executorAddress = matched.address;

    try {
      // SEC-02: params + decrypted secrets（secrets 覆盖同名 params，仅进派发载荷不落库）
      const dispatchParams = this.buildDispatchParams(task, execution);
      // python_task_multiversion（WS2 · CONTRACT §2.4/§3.1）：zip 渠道任务的
      // `packageUrl` 由 admin 解析后附加到**下发 task 对象**上（push/pull 两条
      // 传输分支共用同一份；解析失败在此抛出 → 走下方同一 catch 回滚占坑）。
      // 注意 `task` 本体是托管实体，故附加发生在**副本**上，绝不改持久化实体。
      const dispatchTask = await this.resolveDispatchTask(task);
      // OBS-01: W3C traceparent（disabled 时零注入，语义为无 trace）。
      const traceHeaders: Record<string, string> = {};
      this.tracing?.injectContext(
        traceHeaders,
        this.buildExecutionTraceparent(execution),
      );

      // ARCH-32（ADR-015）: pull 模式传输分支——占坑/选择语义与 push 完全
      // 一致（上方同一条 UPDATE），仅把「入站 POST」换成「Redis 队列入队 +
      // 执行器长轮询取件」。入队失败走下方同一 catch（回滚占坑 + 重试语义）。
      if (matched.dispatchMode === "pull") {
        if (!this.pullService) {
          throw new Error(
            "Pull dispatch unavailable: ExecutorPullService not wired",
          );
        }
        const endPullSpan = this.tracing?.startSpan(
          execution.traceId,
          "dispatch.pull",
          { executor: matched.id, executionId: execution.id },
        );
        await this.pullService.enqueue(matched.id, {
          executionId: execution.id,
          task: dispatchTask,
          params: dispatchParams,
          // push 经 HTTP 头携带 traceparent；pull 只能并入载荷本体，
          // 执行器侧 pull 循环以同语义注入 AUTOFLOW_TRACE_ID。
          traceparent: traceHeaders["traceparent"],
        });
        endPullSpan?.();
        this.logger.log(
          `Dispatching task "${task.name}" to pull executor ${matched.id} (${matched.address}) via pull queue`,
        );
        return {
          status: "queued",
          executionId: execution.id,
          dispatchMode: "pull",
        };
      }

      // F-3: SSRF guard — the address is executor-controlled (register/heartbeat),
      // so block metadata/loopback/link-local targets before sending the
      // authenticated request. A blocked address rolls back the slot below.
      // F-3 (SEC-NEW): pin the connection to the validated IP (Host/SNI kept).
      const url = this.getExecutorUrl(matched.address, "api/execute");
      const pinned = await assertAndPinExecutorUrl(url);
      const sharedToken = await this.getSharedToken();
      const pinCfg = pinnedAxiosConfig(pinned);
      const headers: Record<string, string> = {};
      if (sharedToken) headers["Authorization"] = `Bearer ${sharedToken}`;
      if (traceHeaders["traceparent"]) {
        headers["traceparent"] = traceHeaders["traceparent"];
      }
      const endSpan = this.tracing?.startSpan(
        execution.traceId,
        "dispatch.http",
        { executor: matched.address, executionId: execution.id },
      );
      const resp = await axios.post(
        url,
        {
          executionId: execution.id,
          task: dispatchTask,
          params: dispatchParams,
        },
        {
          timeout: ((task.timeout || 300) + 10) * 1000,
          headers,
          maxRedirects: 0, // R3 parity: 首跳是唯一经 SSRF 校验的地址
          ...pinCfg,
        },
      );
      endSpan?.();
      return resp.data;
    } catch (err: unknown) {
      // Rollback counter on dispatch failure to avoid leaks
      await this.repo
        .createQueryBuilder()
        .update(Executor)
        .set({ runningTaskCount: () => 'GREATEST("runningTaskCount" - 1, 0)' })
        .where("id = :id", { id: matched.id })
        .execute();
      this.tracing
        ?.startSpan(execution.traceId, "dispatch.http", {
          executor: matched.address,
          executionId: execution.id,
        })
        ?.call(this, err instanceof Error ? err.message : String(err));
      throw err;
    }
  }

  /**
   * OBS-01: 由执行行上的 traceId 构造回传/透传 traceparent 头值。
   * traceId 为 null（追踪未开启）或非法时返回 null——injectContext 不注入。
   */
  private buildExecutionTraceparent(
    execution: Pick<TaskExecution, "traceId">,
  ): string | null {
    return this.tracing?.buildTraceparentFromTraceId(execution.traceId) ?? null;
  }

  /**
   * python_task_multiversion（WS2 · CONTRACT §2.4/§3.1）：解析 zip 渠道任务的
   * `packageUrl` 并**附加到下发 task 对象**上。
   *
   * 为什么必须由 admin 解析：任务实体只持 `applicationId` **弱引用**（无关系
   * 属性），执行器拿到 `task` 后无法自行查库；`packageUrl` 又只在
   * `applications` 表上。
   *
   * 触发条件（契约字面）：`task.codeSource === 'application_zip'` **或**
   * `applicationId` 非空（**并集**——存量 zip 任务在 WS1 回填 codeSource 之前
   * 就已存在，只认 codeSource 会让它们静默下发无 packageUrl 的任务）。
   *
   * 返回值语义：
   * - 非 zip 渠道 → 原对象**同一引用**返回（零拷贝、零行为变化）；
   * - zip 渠道 → 返回 `{...task, packageUrl}` **新对象**（绝不改持久化实体：
   *   `task` 是 TypeORM 托管行，写入非列字段会污染实体并可能被 save() 误判）；
   * - 解析不到（repo 未装配 / 应用不存在 / `packageUrl` 为空）→ 抛错，派发失败，
   *   消息明确。**不静默降级**：下发无 packageUrl 的 zip 任务会让执行器在运行时
   *   才炸，且分因落在执行器侧（PACKAGE_FETCH_FAILED），与真实原因不符。
   */
  private async resolveDispatchTask<T extends Task>(task: T): Promise<T> {
    // 并集语义（NFR-05）：codeSource 明确为 application_zip → zip 渠道；
    // codeSource 为 NULL（存量未回填）且 applicationId 非空 → zip 渠道兜底；
    // codeSource 明确为 git/glue → 非 zip 渠道，**即使 applicationId 残留也不进 zip**
    // （存量 git/glue 行的 applicationId 弱引用可能未清，若 application 已删除，
    //  误进 zip 路径会让 git 任务派发失败且消息指向 application，误导排查）。
    // F-02（本轮审计）: 并集判定用 `== null` 同时覆盖 null 与 undefined——任务
    // 对象经 BullMQ 队列载荷序列化/反序列化或部分 select 投影后 codeSource 可能
    // 为 undefined，`undefined === null` 为 false 会让存量 zip 任务误出 zip 渠道，
    // packageUrl 不被解析，执行器运行时才炸。
    const isZipChannel =
      task.codeSource === TaskCodeSource.APPLICATION_ZIP ||
      (task.codeSource == null && Boolean(task.applicationId));
    if (!isZipChannel) return task;
    if (!task.applicationId) {
      // codeSource=application_zip 但无 applicationId：WS1 写面已互斥校验
      // （CONTRACT §2.1「codeSource=application_zip 时 applicationId 必填」），
      // 走到这里说明是迁移前的存量脏行或外部直写——派发失败，消息明确。
      throw new Error(
        `Task "${task.name}" (${task.id}) is codeSource=application_zip but has no applicationId; ` +
          `cannot resolve packageUrl for dispatch`,
      );
    }
    if (!this.applicationRepo) {
      throw new Error(
        `Cannot resolve packageUrl for task "${task.name}" (${task.id}): ` +
          `Application repository is not wired into ExecutorService`,
      );
    }
    // F-08（本轮审计）: 命中未过期的正缓存 → 直接附加，跳过 DB 往返。
    const cached = this.packageUrlCache.get(task.applicationId);
    if (cached) {
      if (
        Date.now() - cached.cachedAt <
        ExecutorService.PACKAGE_URL_CACHE_TTL_MS
      ) {
        return { ...task, packageUrl: cached.packageUrl };
      }
      // 惰性淘汰过期条目（positive-only：失败态从不入缓存，无需清理）。
      this.packageUrlCache.delete(task.applicationId);
    }
    const app = await this.applicationRepo.findOne({
      where: { id: task.applicationId },
      select: ["id", "name", "packageUrl"],
    });
    if (!app) {
      throw new Error(
        `Cannot resolve packageUrl for task "${task.name}" (${task.id}): ` +
          `application ${task.applicationId} not found`,
      );
    }
    if (typeof app.packageUrl !== "string" || app.packageUrl.length === 0) {
      throw new Error(
        `Cannot resolve packageUrl for task "${task.name}" (${task.id}): ` +
          `application "${app.name}" (${app.id}) has no packageUrl configured`,
      );
    }
    this.packageUrlCache.set(task.applicationId, {
      packageUrl: app.packageUrl,
      cachedAt: Date.now(),
    });
    return { ...task, packageUrl: app.packageUrl };
  }

  /**
   * Broadcast dispatch: send the task to ALL online executors simultaneously.
   * Used when task.executeMode === ExecuteMode.BROADCAST.
   * Returns a list of results for each executor.
   *
   * NOTE: Broadcast must reach every eligible online executor. The
   * `{status: ONLINE}` where clause keeps this scoped to the active fleet;
   * offline/stale rows are excluded. A take:5000 safety cap (O-3) bounds a
   * pathological/fleet-blowup row count without affecting normal deployments.
   */
  async dispatchBroadcast(
    task: Task,
    execution: TaskExecution,
  ): Promise<any[]> {
    const all = await this.repo.find({
      where: { status: ExecutorStatus.ONLINE },
      // O-1（中台↔执行器深度审查）：广播同样按 runningTaskCount 升序取 Top-K。
      // 正常机队（< 5000）下排序不影响扇出面（全部在线都入池）；只有病态
      // 机队（> 5000）触发截断时，**保留最空闲的一批**是最不坏的取舍——
      // 旧实现随机截断可能把最空闲的执行器漏在池外。
      order: { runningTaskCount: "ASC" },
      // O-3: safety cap (compare dispatch's take:500).
      take: 5000,
    });
    let candidates = all;

    // Apply same filters as dispatch
    if (task.executorAppName) {
      candidates = all.filter((e) => e.appName === task.executorAppName);
      // python_task_multiversion（WS2 · CONTRACT §3.1）：广播的 appName 分支
      // 同样按"用户显式点名"处理——不满足声明版本即失败（与单播 dispatch
      // 的 appName 分支同语义），不静默缩小扇出面。
      const byName = this.applyInterpreterFilter(
        candidates,
        task.runtimeVersion,
      );
      if (byName.message) {
        this.failInterpreterUnavailable(byName.message);
      }
      candidates = byName.kept;
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
      // NF-04: affinity / anti-affinity constraints on the broadcast path.
      // Ruling (documented in docs/api-reference.md): broadcast + affinity
      // NARROWS the fan-out to the executors holding any affinity tag — that
      // is the whole point of the third dispatch state (pinning = exactly one,
      // plain broadcast = everyone, broadcast+affinity = the matching subset,
      // loadScore not consulted on this path). Broadcast + anti-affinity
      // excludes matching executors as usual. Both no-ops when the columns are
      // null/empty (default unchanged). An empty final candidate set throws
      // the same "No online executors match..." error as the other filters.
      if (task.executorAffinityTags && task.executorAffinityTags.length > 0) {
        filtered = filtered.filter((e) => {
          if (!e.tags) return false;
          return task.executorAffinityTags!.some((tag) =>
            e.tags!.includes(tag),
          );
        });
      }
      if (
        task.executorAntiAffinityTags &&
        task.executorAntiAffinityTags.length > 0
      ) {
        filtered = filtered.filter((e) => {
          if (!e.tags) return true;
          return !task.executorAntiAffinityTags!.some((tag) =>
            e.tags!.includes(tag),
          );
        });
      }
      if (task.runtime) {
        filtered = filtered.filter((e) =>
          !e.capabilities || e.capabilities.length === 0
            ? true
            : e.capabilities.includes(task.runtime),
        );
      }
      // python_task_multiversion（WS2 · CONTRACT §3.1）：解释器缓存池过滤——
      // 与单播 dispatch 同一位置（runtime 之后）与同一共享实现。
      const interpreterFiltered = this.applyInterpreterFilter(
        filtered,
        task.runtimeVersion,
      );
      if (interpreterFiltered.message) {
        this.failInterpreterUnavailable(interpreterFiltered.message);
      }
      filtered = interpreterFiltered.kept;
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
    // OBS-01: 广播路径同样透传 traceparent（disabled 时零头注入）。
    this.tracing?.injectContext(
      broadcastHeaders,
      this.buildExecutionTraceparent(execution),
    );
    // SEC-02: params + decrypted secrets（secrets 覆盖同名 params，仅进派发载荷不落库）
    const dispatchParams = this.buildDispatchParams(task, execution);
    // python_task_multiversion（WS2 · CONTRACT §2.4/§3.1）：广播路径同样解析
    // `packageUrl`。**在扇出之前**解析（一次查询服务全部目标，且解析失败时
    // 整个广播直接失败——`packageUrl` 是任务级属性，解析不到就没有任何一个
    // 目标能跑，部分成功只会留下"半数执行器白跑"的脏结果）。
    const dispatchTask = await this.resolveDispatchTask(task);

    const results = await Promise.allSettled(
      candidates.map(async (executor) => {
        // ARCH-32（ADR-015）: pull 执行器入队（不拨入站连接），其余走 push。
        if (executor.dispatchMode === "pull") {
          if (!this.pullService) {
            throw new Error(
              "Pull dispatch unavailable: ExecutorPullService not wired",
            );
          }
          await this.pullService.enqueue(executor.id, {
            executionId: execution.id,
            task: dispatchTask,
            params: dispatchParams,
            traceparent: broadcastHeaders["traceparent"],
          });
          return {
            executor: executor.address,
            result: { status: "queued", dispatchMode: "pull" },
          };
        }
        const dispatchUrl = this.getExecutorUrl(
          executor.address,
          "api/execute",
        );
        // F-3: SSRF guard per target — a poisoned address (metadata/loopback)
        // fails its own dispatch without affecting the rest of the broadcast.
        // F-3 (SEC-NEW): pin the connection to the validated IP.
        const pinned = await assertAndPinExecutorUrl(dispatchUrl);
        const pinCfg = pinnedAxiosConfig(pinned);
        const resp = await axios.post(
          dispatchUrl,
          {
            executionId: execution.id,
            task: dispatchTask,
            params: dispatchParams,
          },
          {
            timeout: ((task.timeout || 300) + 10) * 1000,
            headers: broadcastHeaders,
            maxRedirects: 0,
            ...pinCfg,
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

    // R-06（DEEP_REVIEW 0ef3bbe）: 广播占坑——此前广播派发对每个目标执行器
    // 的 runningTaskCount 从不 +1，广播负载对单播容量闸门/负载打分不可见（欠计）。
    // 此处对每个成功接单（Promise.allSettled fulfilled）的目标执行器原子 +1，
    // UPDATE 形态与单播 dispatch 占坑同构。广播按定义必须扇出到全部在线执行器，
    // 因此不复用「runningTaskCount < max」容量闸（不主动拒绝目标），仅把负载计入。
    // 释放侧：handleCallback 按回调上报地址逐执行器 -1（每个被接受执行器回调
    // 恰好一次），并有执行器心跳 30s 覆写兜底。
    //
    // O-2（中台↔执行器深度审查）：占坑改走**容量闸门的原子 UPDATE**——
    // `WHERE runningTaskCount < maxConcurrentTasks`，超限目标**跳过占坑并 warn**
    // （按审查报告给出的方案落地）。旧实现无条件 +1 会让广播把单执行器
    // runningTaskCount 顶过 maxConcurrentTasks：与单播混跑时，单播按
    // count >= max 拒派 → 广播挤占单播的容量保证。跳过占坑的副作用（计数少计）
    // 由 releaseExecutorSlot 的 GREATEST(...,0) 下限保护 + 执行器心跳 30s 覆写
    // 兜底，不产生负计数；广播扇出面不受影响（仍全部收到任务）。
    const acceptedExecutors = results
      .map((r, i) => ({ settled: r, executor: candidates[i] }))
      .filter(({ settled }) => settled.status === "fulfilled");
    await Promise.all(
      acceptedExecutors.map(async ({ executor }) => {
        const qb = this.repo
          .createQueryBuilder()
          .update(Executor)
          .set({ runningTaskCount: () => '"runningTaskCount" + 1' })
          .where("id = :id", { id: executor.id });
        // maxConcurrentTasks 为 NULL（未配置/无上限）→ 不加容量条件；
        // 数值（含 0）视为真实上限（与单播 dispatch 的 `?? Infinity` 语义一致）。
        if (executor.maxConcurrentTasks != null) {
          qb.andWhere('"runningTaskCount" < :max', {
            max: executor.maxConcurrentTasks,
          });
        }
        const res = await qb.execute();
        if (res.affected === 0) {
          this.logger.warn(
            `Broadcast occupy skipped for ${executor.address} ` +
              `(runningTaskCount >= ${executor.maxConcurrentTasks ?? "unbounded"}): ` +
              `task "${task.name}" was dispatched but its load is not counted against capacity`,
          );
        }
        return res.affected === 1;
      }),
    );

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
    // ARCH-31 §5: 多实例下仅 cron Leader 执行（下同，详见 LeaderGateService）
    if (this.leaderGate && !this.leaderGate.isLeader) return;
    // N12: use a 5-min broad threshold so any task older than the minimum buffer
    // is considered for per-execution checks (real timeout logic is applied per-row below).
    // A 24-hour threshold was too large — tasks with short timeouts were left as zombie
    // for up to 24h even when their executor went offline.
    const broadThreshold = new Date(Date.now() - 5 * 60 * 1000);
    // NETOPT-1⑧: 补 take 上限（对齐 scheduler O-2 的 1000）——无界 getMany
    // 在执行器长时间离线/回调通道故障时会一次物化全部僵尸行，随后逐行终态
    // 写放大为长事务风暴；截断后下一轮 5 分钟 tick 自收敛（余量行仍满足
    // RUNNING + 阈值谓词）。逐行写保留：终态必须走 transitionToTerminal
    //（A1 收口）并按 RETURNING 地址逐台释放槽位，不能改批量 UPDATE。
    const lostExecs = await this.execRepo
      .createQueryBuilder("exec")
      .where("exec.status = :status", { status: ExecutionStatus.RUNNING })
      .andWhere("exec.startTime < :threshold", { threshold: broadThreshold })
      .take(1000)
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
      //
      // A1: 走统一入口。顺带修掉一个此前存在的隐患——旧实现没有 RETURNING，
      // 释放用的是请求前快照 exec.executorAddress；而该地址在 dispatch HTTP
      // 返回后才落库，秒级完成的执行其快照仍为 null，用它释放会 no-op 使
      // runningTaskCount 永久虚高（task.service 回调路径的注释早已自证这个坑，
      // 但扫描路径一直在踩）。现在取 RETURNING 的库中实际值，快照仅作兜底。
      const { rows } = await transitionToTerminal(this.execRepo, {
        ids: [exec.id],
        patch: {
          status: ExecutionStatus.FAILED,
          endTime: new Date(),
          errorMessage:
            "[System] Executor offline or task timed out, marked as failed by scheduler",
          logs:
            (exec.logs || "") +
            "\n[System] Execution timed out without callback, forcefully marked as FAILED",
        },
        // 扫描入口只处理 RUNNING 行（与旧实现的 `status = :status` 同门槛）。
        from: [ExecutionStatus.RUNNING],
        addressSnapshot: { [exec.id]: exec.executorAddress ?? null },
      });
      for (const row of rows) {
        await this.releaseExecutorSlot(row.executorAddress);
        this.logger.warn(
          `Lost execution marked FAILED: execId=${row.id}, taskId=${exec.taskId}`,
        );
      }
    }
  }

  /** Q7: Daily at 2am, clean up old execution records (90d) and audit logs (180d) to prevent DB bloat */
  @Cron("0 0 2 * * *")
  async cleanupOldRecords(): Promise<void> {
    if (this.leaderGate && !this.leaderGate.isLeader) return;
    const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
    // NETOPT-1②: 单条无界 DELETE 在峰值行数下是长事务（锁表 + WAL 风暴），
    // 改分批 DELETE（对齐下方 cleanupExpiredMetricsHistory 的 R-09 模式）。
    const deleted = await this.cleanupOldTaskExecutions(ninetyDaysAgo);
    if (deleted > 0) {
      this.logger.log(
        `Q7 Cleanup: removed ${deleted} old task executions (>90 days)`,
      );
    }
  }

  /** NETOPT-1②: task_executions retention 分批大小（对齐 R-09 metrics 模式） */
  private static readonly EXECUTION_RETENTION_BATCH_SIZE = 5000;

  /**
   * NETOPT-1②: task_executions 90 天 retention，返回清理总行数。cutoff 可
   * 注入以便测试。分批 DELETE（id IN (SELECT ... LIMIT 批大小)）循环直至
   * 单批不足批大小，避免长事务锁表；多实例下仅 cron Leader 执行（入口已门禁）。
   *
   * NETOPT-8④: 循环收口改走公共 cappedBatchedDelete——补 LOG-RETENTION-01
   * 轮数/墙钟双闸（affected 恒返满批时旧 `do..while` 永不终止，已实测 OOM）。
   * NETOPT-8①: S3 驱动下每批先回收行上的日志对象再删行（防 S3 永久孤儿），
   * 见 deleteExpiredExecutionRowsBatch。
   */
  async cleanupOldTaskExecutions(cutoff: Date): Promise<number> {
    const s3 = this.resolveS3LogStorage();
    return cappedBatchedDelete({
      batchSize: ExecutorService.EXECUTION_RETENTION_BATCH_SIZE,
      logLabel: "Q7",
      logger: this.logger,
      executeBatch: () => this.deleteExpiredExecutionRowsBatch(cutoff, s3),
    });
  }

  /**
   * NETOPT-8①: 单批 task_executions 清理，返回本批实际删除行数（0 = 收口）。
   *
   * s3 为 null（非 S3 部署：driver=db，或 s3 但 endpoint 未配）→ 单条分批
   * 子查询 DELETE，行为=既往（直删行）。
   * s3 非空 → 先 SELECT victims（id + logObjectKey 两列，createdAt<cutoff，
   * ORDER BY id，take 批大小），对带指针的行先 remove S3 日志对象再删行：
   * S3 GC（s3-log-object-retention.service 的 selectExpiredBatch）候选只能
   * 来自存活行（logStorage='s3' AND logObjectKey IS NOT NULL），行一删指针
   * 消失，execution-logs/<execId>.log.gz 就永无人回收成永久孤儿。remove
   * 失败的行从本批 DELETE 集合剔除（指针留待下轮 cron 重试），只 warn 不
   * 中断；全部失败时本批返回 0（循环收口，等下一 cron 周期）。
   */
  private async deleteExpiredExecutionRowsBatch(
    cutoff: Date,
    s3: S3LogStorage | null,
  ): Promise<number> {
    if (!s3) {
      const result = await this.execRepo
        .createQueryBuilder()
        .delete()
        .where(
          `"id" IN (
            SELECT "victim"."id" FROM "task_executions" "victim"
            WHERE "victim"."createdAt" < :cutoff
            ORDER BY "victim"."id"
            LIMIT :batchSize
          )`,
          { cutoff, batchSize: ExecutorService.EXECUTION_RETENTION_BATCH_SIZE },
        )
        .execute();
      return result.affected ?? 0;
    }
    const victims = await this.execRepo.find({
      select: ["id", "logObjectKey"],
      where: { createdAt: LessThan(cutoff) },
      order: { id: "ASC" },
      take: ExecutorService.EXECUTION_RETENTION_BATCH_SIZE,
    });
    if (victims.length === 0) return 0;
    const deletableIds: string[] = [];
    for (const victim of victims) {
      const key = victim.logObjectKey;
      if (!key) {
        // 无外置日志对象（db 驱动行 / 指针已被 S3 GC 清空）：直接删行
        deletableIds.push(victim.id);
        continue;
      }
      try {
        await s3.remove(key);
      } catch (err: unknown) {
        // fail-open：对象删不掉就跳过——行保留 = 指针保留 = 下轮 cron 仍能
        // 定位该对象（S3 GC / 本清理重试），绝不因单对象失败中断整批。
        this.logger.warn(
          `NETOPT-8①: S3 日志对象删除失败，跳过 execution ${victim.id}（${key}）: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        continue;
      }
      deletableIds.push(victim.id);
    }
    if (deletableIds.length === 0) return 0;
    const result = await this.execRepo.delete({ id: In(deletableIds) });
    return result.affected ?? 0;
  }

  /**
   * NETOPT-8①: 惰性解析可选 S3 日志后端（S3LogObjectRetentionService /
   * TaskService.resolveS3Storage 同款：fromConfig 是进程内单例语义，缓存于
   * 本实例）。非 s3 驱动返回 null，retention 走既有直删路径。
   */
  private s3LogStorage: S3LogStorage | null = null;
  private s3LogStorageResolved = false;
  private resolveS3LogStorage(): S3LogStorage | null {
    if (!this.s3LogStorageResolved) {
      this.s3LogStorage = S3LogStorage.fromConfig(this.configService);
      this.s3LogStorageResolved = true;
    }
    return this.s3LogStorage;
  }

  // R-09（DEEP_REVIEW 0ef3bbe）: executor_metrics_history 无 retention——每执行器
  // 每 30s 心跳写一行（2,880 行/天/执行器），全仓此前无任何清理机制，同类表
  // （audit_logs / execution_log_lines / artifacts）均有 retention。对齐既有
  // 模式（log-retention-cleanup / artifacts-retention）：每日 cron + LeaderGate，
  // 保留期复用 logRetention.days（默认 30 天，可经 LOG_RETENTION_DAYS 配置）。
  // 分批 DELETE（id IN (SELECT ... LIMIT 批大小)）循环直至单批不足批大小，
  // 避免长事务锁表；多实例并发删除幂等。
  private static readonly METRICS_RETENTION_BATCH_SIZE = 5000;

  /** R-09: 每日 03:15 清理超期 executor_metrics_history 行（保留期同日志） */
  @Cron("0 15 3 * * *")
  async cleanupMetricsHistory(): Promise<void> {
    // ARCH-31 §5: 多实例下仅 cron Leader 执行
    if (this.leaderGate && !this.leaderGate.isLeader) return;
    try {
      const deleted = await this.cleanupExpiredMetricsHistory();
      if (deleted > 0) {
        this.logger.log(`R-09: 清理 ${deleted} 行过期执行器指标历史`);
      }
    } catch (err) {
      this.logger.error(
        `R-09: 执行器指标历史 retention 清理失败: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /**
   * R-09: 删除 createdAt 早于保留期截止的指标历史行，返回清理总行数。
   * now 可注入以便测试。分批 DELETE 对齐 log-retention-cleanup 的
   * cleanupExpiredLinesByDelete 模式。
   * NETOPT-8④: 循环收口改走公共 cappedBatchedDelete（LOG-RETENTION-01
   * 轮数/墙钟双闸，防 affected 恒满批时无界循环 OOM）。
   */
  async cleanupExpiredMetricsHistory(now: Date = new Date()): Promise<number> {
    const retentionDays = this.resolveMetricsRetentionDays();
    const cutoff = new Date(now.getTime() - retentionDays * 86_400_000);
    return cappedBatchedDelete({
      batchSize: ExecutorService.METRICS_RETENTION_BATCH_SIZE,
      logLabel: "R-09",
      logger: this.logger,
      executeBatch: async () => {
        const result = await this.metricsHistoryRepo
          .createQueryBuilder()
          .delete()
          .where(
            `"id" IN (
              SELECT "victim"."id" FROM "executor_metrics_history" "victim"
              WHERE "victim"."createdAt" < :cutoff
              ORDER BY "victim"."id"
              LIMIT :batchSize
            )`,
            { cutoff, batchSize: ExecutorService.METRICS_RETENTION_BATCH_SIZE },
          )
          .execute();
        return result.affected ?? 0;
      },
    });
  }

  /** R-09: 解析保留期（复用 logRetention.days，对齐 artifacts-retention 口径） */
  private resolveMetricsRetentionDays(): number {
    const parsed = this.configService.get<number>("logRetention.days");
    if (typeof parsed === "number" && Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
    return 30;
  }

  /** Auto-scan every 30s, mark executors with expired heartbeat as OFFLINE */
  @Cron("*/30 * * * * *")
  async markStaleOffline() {
    if (this.leaderGate && !this.leaderGate.isLeader) return;
    // Calculate timeout using configured heartbeat interval and timeout multiplier
    const heartbeatInterval =
      this.configService.get<number>("executor.heartbeatInterval") || 30000;
    const timeoutMultiplier =
      this.configService.get<number>("executor.heartbeatTimeoutMultiplier") ||
      3;
    const timeoutMs = heartbeatInterval * timeoutMultiplier;
    const cutoff = new Date(Date.now() - timeoutMs);

    // R-30（DEEP_REVIEW 0ef3bbe）: 消除查询/更新间隙的误发。旧实现先 find 快照
    // staleExecutors，再 repo.update（同条件重查，行级正确），最后事件/通知循环
    // 遍历的是**先查的快照**——间隙内补了心跳（lastHeartbeat 新于 cutoff）的
    // 执行器虽不被 UPDATE 命中，仍会收到 executor.offline 事件与通知。改为
    // 条件 UPDATE ... RETURNING：原子地拿到真正发生 ONLINE→OFFLINE 跃迁的行，
    // 事件/通知只对这部分扇出（与 scheduler COVER_EARLY 的条件 UPDATE+RETURNING
    // 同型），间隙误发从结构上消失。
    const result = await this.repo
      .createQueryBuilder()
      .update(Executor)
      .set({ status: ExecutorStatus.OFFLINE })
      .where('status = :status AND "lastHeartbeat" < :cutoff', {
        status: ExecutorStatus.ONLINE,
        cutoff,
      })
      .returning(["id", "appName", "address"])
      .execute();

    const transitioned = (result.raw ?? []) as Array<{
      id: string;
      appName: string;
      address: string;
    }>;
    if (transitioned.length === 0) return;

    this.logger.warn(
      `Marked ${transitioned.length} executor(s) as OFFLINE due to heartbeat timeout (${timeoutMs}ms)`,
    );
    // FEAT-07: 状态落库后发布 executor.offline（每台恰一次，与下方通知同扇出位）。
    for (const exec of transitioned) {
      this.emitExecutorOffline(exec);
    }
    // Fire offline notifications — fire-and-forget, errors must not break the cron job
    for (const exec of transitioned) {
      this.notificationService
        .notifyExecutorOffline(exec.appName, exec.address)
        .catch((e: Error) =>
          this.logger.error(
            `Failed to send offline notification for ${exec.address}: ${e.message}`,
          ),
        );
    }
  }

  /** Run hourly, clean up executor records offline for more than 7 days */
  @Cron("0 0 * * * *")
  async cleanupOfflineExecutors() {
    if (this.leaderGate && !this.leaderGate.isLeader) return;
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
   * AUTH-05: accepts an optional admin-supplied `reason` (≤200 chars, capped)
   * that lands in the audit detail — the rotation itself is unchanged.
   */
  async rotateToken(id: string, reason?: string): Promise<{ token: string }> {
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
    // F-5：正缓存里的旧凭据条目同样必须立刻失效，否则「撤销」在 60s 内不生效
    // （旧 token 心跳/回调仍被接受）。见 evictTokenValidationsFor。
    this.evictTokenValidationsFor(executor.address);
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
    // AUTH-05: rotate-token is a high-risk operation — audit it (with the
    // admin-supplied reason when present). Best-effort, after the mutation.
    await this.auditHighRisk("executor.rotate_token", executor, reason);
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
  async removeById(id: string, reason?: string): Promise<void> {
    const executor = await this.repo.findOne({ where: { id } });
    if (!executor) throw new NotFoundException("Executor not found");
    await this.repo.remove(executor);
    // R9: drop the idempotent-issuance plaintext cache entry with the row —
    // a re-registered address must get a fresh token, never the removed one.
    this.issuedTokenCache.delete(executor.address);
    // 同理清掉该地址的 callback 密钥候选与 F-5 正缓存：行都没了，旧 token
    // 更不能继续被接受（否则删除执行器后旧凭据还有 60s 可用窗口）。
    this.callbackSecretCache.delete(executor.address);
    this.evictTokenValidationsFor(executor.address);
    this.logger.log(`Executor ${id} (${executor.address}) removed by admin`);
    // AUTH-05: executor deletion is destructive — audit it (with the
    // admin-supplied reason when present). Best-effort, after the mutation.
    await this.auditHighRisk("executor.delete", executor, reason);
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
    const entry = this.tokenValidationCache.get(cacheKey);
    const now = Date.now();
    if (
      entry !== undefined &&
      now - entry.cachedAt < ExecutorService.TOKEN_CACHE_TTL_MS
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
        this.rememberTokenValidation(cacheKey, address, now);
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
      this.rememberTokenValidation(cacheKey, address, now);
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
  private rememberTokenValidation(
    cacheKey: string,
    address: string,
    now: number,
  ): void {
    if (this.tokenValidationCache.size >= ExecutorService.TOKEN_CACHE_MAX) {
      for (const [k, entry] of this.tokenValidationCache) {
        if (now - entry.cachedAt >= ExecutorService.TOKEN_CACHE_TTL_MS) {
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
    this.tokenValidationCache.set(cacheKey, { address, cachedAt: now });
  }

  /**
   * 逐出某 address 在 F-5 正缓存里的全部条目。
   *
   * 为什么必须存在：正缓存的键是 sha256(address|token)，同一地址可能同时挂着
   * 多条（历史 token 各自的成功结果），且键是单向哈希——无法按地址做前缀删除，
   * 只能按值里的 address 扫描。上限 TOKEN_CACHE_MAX=1000，轮换/删除又都是低频
   * 管理动作，O(n) 扫描没有成本。
   *
   * 不驱逐会怎样：rotateToken() 之后旧 token 仍命中正缓存，校验直接 return true，
   * 「撤销凭据」出现最长 TOKEN_CACHE_TTL_MS（60s）的失效窗口——e2e 用例 46 断言
   * 旧 token 必须立即 401，正是这条语义。
   */
  private evictTokenValidationsFor(address: string): void {
    for (const [k, entry] of this.tokenValidationCache) {
      if (entry.address === address) this.tokenValidationCache.delete(k);
    }
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
    // R-12（DEEP_REVIEW 0ef3bbe）: 改读映射节 app.adminApiUrl（此前裸读
    // configService.get("ADMIN_API_URL") 绕过配置中心）。
    const adminApiUrl = this.configService.get<string>("app.adminApiUrl") || "";
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
    // FEAT-07: 状态落库后发布 executor.offline（优雅停机路径）。
    const exec = await this.repo.findOne({
      where: { address },
      select: ["id", "appName", "address"],
    });
    if (exec) this.emitExecutorOffline(exec);
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
    // FEAT-07: 状态落库后发布 executor.offline（管理台置离线路径）。
    this.emitExecutorOffline(saved);
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
   * A6（DEEP_REVIEW §七）：回调可靠性分层——死信对账的**只读**视图。
   *
   * 为什么需要它：执行器本地死信目录里躺着两类文件，在磁盘上长得一模一样，
   * 但处置方式完全相反——
   *
   *   ① 重发预算耗尽（E-05：约 24h 时长预算 / 150 轮）。典型成因是 admin
   *      长时间不可达（滚动升级、网络分区）。admin 恢复后这类**很可能仍值得
   *      重发**：如果 admin 还没把该执行终态化（它的 stale sweep 只在执行器
   *      心跳超时后才跑），回调是 admin 唯一能得知结果、释放执行器槽位的通道。
   *   ② 载荷本身是毒丸（> 64MB / 坏 JSON）。重发永远失败，只等人来看。
   *
   * 区分二者必须问 admin：这条执行到底终态了没有。执行器据此分三层处置——
   *   命中本清单 → 回调已无意义（admin 早有终态），删死信；
   *   未命中 且 死信原因是① → 重新入队重发；
   *   未命中 且 死信原因是② → 保留待人工（重发是纯浪费）。
   *
   * 端点形态刻意只读：它不改任何执行行、不释放槽位、不写审计。真正的状态
   * 变更仍然只经由既有的回调/终态路径发生——对账只是让执行器**不再做无用功**，
   * 不是新增一条写状态的路（多一条写路径就多一处分叉的状态机，A1 收口白做）。
   *
   * @param address 执行器地址（路由参数，已过令牌校验）
   * @param since   水印：只回终态时间 >= since 的行
   * @param limit   单页条数（钳到 [1, TERMINAL_STATES_MAX_LIMIT]）
   */
  async getTerminalStates(
    address: string,
    opts: { since: Date; limit?: number },
  ): Promise<TerminalStatesResponseDto> {
    const limit = Math.min(
      Math.max(1, Math.floor(opts.limit ?? TERMINAL_STATES_DEFAULT_LIMIT)),
      TERMINAL_STATES_MAX_LIMIT,
    );
    // 多取一条用于判定 hasMore，不返回给调用方。
    const rows = await this.execRepo
      .createQueryBuilder("e")
      .select(["e.id", "e.status", "e.endTime", "e.createdAt"])
      .where("e.executorAddress = :address", { address })
      .andWhere("e.status IN (:...statuses)", {
        statuses: TERMINAL_EXECUTION_STATUSES as readonly ExecutionStatus[],
      })
      // 水印列用 COALESCE(endTime, createdAt)：endTime 是终态落库时间，但部分
      // 终态路径下可能为 NULL（如未启动即被取消），此时行仍应被对账看见——
      // 否则执行器会永远等一条不会到来的终态记录。判据与
      // s3-log-object-retention 的保留扫描一致。
      .andWhere("COALESCE(e.endTime, e.createdAt) >= :since", {
        since: opts.since,
      })
      .orderBy("COALESCE(e.endTime, e.createdAt)", "ASC")
      .take(limit + 1)
      .getMany();

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    return {
      items: page.map((r) => ({
        executionId: r.id,
        status: r.status,
        endedAt: (r.endTime ?? r.createdAt)?.toISOString(),
      })),
      hasMore,
      serverTime: new Date().toISOString(),
    };
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
   * Data source: executor_metrics_history (best-effort snapshots appended by
   * heartbeat after the current executor row is saved; compound index
   * executorAddress + createdAt). AVG
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
