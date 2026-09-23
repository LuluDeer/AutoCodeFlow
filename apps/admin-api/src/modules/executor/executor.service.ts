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
  ExecutorOfflineReason,
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
  TERMINAL_EXECUTION_STATUSES,
} from "../task/execution-terminal";
import { Task, TaskCodeSource } from "../task/entities/task.entity";
// python_task_multiversion（WS2 · CONTRACT §2.4/§3.1）：zip 渠道任务的
// `packageUrl` 由 admin 在派发时解析后附加到下发 task 上（任务实体只有
// `applicationId` 弱引用，执行器无法自行查库）。只加列/只读，不建关系，
// 避免 executor↔application 的实体关系耦合（ApplicationModule 反向 import
// TaskModule+ExecutorModule，加关系会引入模块环）。
import { Application } from "../application/entities/application.entity";
// ARCH-35 P1（生产事故 2026-09-23）：派发时读取「该应用部署在哪台执行器」。
// 只加 Repository，不 import ApplicationModule（反向 import 会成环，同上方
// Application 的注释）。AppDeployment 的 @ManyToOne(Application) 是实体关系，
// 只需 Application 实体已注册，不构成模块依赖。
import {
  AppDeployment,
  DeploymentStatus,
} from "../application/entities/app-deployment.entity";
// ARCH-35 P1：部署归属**偏好**（稳定分区，非过滤）——判据与「为什么不能硬
// 过滤」的完整论证见 util 头注（执行器侧任务执行不依赖本地部署，硬过滤会
// 误伤全部未部署任务与 python 执行器）。
import { partitionByDeploymentAffinity } from "./executor-deployment-affinity.util";
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
  PROTOCOL_CONTROL_PLANE_MIN,
  isProtocolCompliant,
  supportsControlPlane,
} from "./protocol-compat.util";
// ARCH-32: pull 模式派发队列（ADR-015）——NAT 内执行器零入站回连
import { ExecutorPullService } from "./executor-pull.service";
// ARCH-34 P0（生产事故 2026-09-23）：address 冲突检测——`address` 是唯一键
// 但为执行器自报（NAT 下局域网 IP 可碰撞），两台机器共享同一行会导致注册
// 互相覆盖、pull 队列被抢、重启恢复互相误杀。本模块只做检测与可见性。
import {
  createAddressConflictTracker,
  type AddressConflictObservation,
} from "./executor-address-conflict.util";
// ARCH-36（ADR-017 阶段 2）：deviceFingerprint 校验 + 冲突/漂移观测。
// 与 P0 的 startupId 时序判据**并存**：P0 覆盖存量执行器（无新字段），本模块
// 给出跨重启稳定身份带来的**直接**判据（零误报），两者互不替代（见 util 头注）。
import {
  createDeviceFingerprintTracker,
  normalizeDeviceFingerprint,
  type FingerprintObservation,
} from "./executor-fingerprint.util";
// SEC-02: 任务级 secrets 派发解密（落库加密在 TaskService 写路径）
import { SecretsCryptoService } from "../../common/utils/secret-crypto.util.service";
// FEAT-07: executor.offline 出站事件（总线 @Global；Optional 注入先例 task.service）
import {
  DOMAIN_EVENTS,
  ExecutorOfflineEventPayload,
  ExecutorOnlineEventPayload,
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
const MAX_RUNNING_EXECUTION_IDS = 10_000; // NETOPT-C P2-1: 与 E9 maxConcurrentTasks 采纳上界一致

// NETOPT-D P3-3: 截断 warn 节流状态——模块级而非实例字段（sanitize 是实例
// 方法，节流跨心跳共享；多实例无状态部署下不重复刷日志）。
const lastTruncationWarn = new Map<string, { dropped: number; at: number }>();
/** 测试出口：清空 warn 节流状态——模块级 Map 跨测试残留会形成隐性顺序依赖
 *  （现测试靠换 address 规避；NETOPT-F P3 补 reset 消除依赖）。 */
export function __resetTruncationWarnStateForTest(): void {
  lastTruncationWarn.clear();
}
const TRUNCATION_WARN_THROTTLE_MS = 60_000;

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

  /**
   * ARCH-34 P0：address 冲突跟踪器（**实例字段**，register 与 heartbeat 共享）。
   *
   * 为什么是实例而非模块级单例：两个入口跑在同一 provider 实例上，实例字段
   * 已满足共享需求；模块级状态会跨测试文件泄漏（仓库既有前科见
   * `__resetTruncationWarnStateForTest` 头注）。
   *
   * 多副本部署语义：各副本独立观察，状态不跨实例共享——漏报由「任一副本命中
   * 即告警」而非状态同步承担，与 tokenValidationCache 等既有进程内缓存同款。
   */
  private readonly addressConflictTracker = createAddressConflictTracker();

  /**
   * ARCH-36（ADR-017 阶段 2）：`deviceFingerprint` 冲突/漂移观测器。
   *
   * 与 `addressConflictTracker` **并存**，判据正交：
   * - 本跟踪器：同一 address 出现两个**不同指纹** → 两台不同安装共用一行
   *   （直接证据，零误报）；同一指纹换 address → 地址漂移（正常，只记 info）。
   * - P0 跟踪器：被顶替的**进程生命**复活 → 同一 address 上两个活进程
   *   （时序推断，覆盖未上报指纹的存量执行器；也覆盖「同机同 kind 同 workDir
   *   的两个实例共享指纹」这种指纹判不出的形态）。
   *
   * 为什么是实例字段而非模块级单例：同 P0 跟踪器（跨测试文件泄漏的前科）。
   */
  private readonly deviceFingerprintTracker = createDeviceFingerprintTracker();

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
    // ARCH-35 P1（生产事故 2026-09-23）：部署归属偏好所需的 `app_deployments`
    // 只读仓库。@Optional 同先例——存量单测装配未提供时为 null，此时**整条
    // 偏好逻辑短路**（与开关关闭同路径），派发顺序逐字节不变。同样**必须是
    // 最后一个位置参数**（15 个位置参数装配的兼容性约束同上）。
    @Optional()
    @InjectRepository(AppDeployment)
    private readonly appDeploymentRepo: Repository<AppDeployment> | null = null,
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
    // ARCH-35 P1（R-26 同款纪律）：部署归属偏好**被期望生效**（开关非 false）
    // 却没有仓库时，偏好会静默不生效——用户会以为修复已上线，实际任务仍可能
    // 派到未部署该应用的执行器上（正是本次事故的现象）。故显式 warn。
    // 仅当开关**明确为 false**（主动关闭，见 configuration.ts）时不告警：
    // 那是运维的有意选择，不是装配缺失。
    if (
      !this.appDeploymentRepo &&
      this.configService.get("executor.preferDeployedExecutor") !== false
    ) {
      this.logger.warn(
        "R-26: AppDeployment 仓库未装配——ARCH-35 部署归属偏好将静默不生效" +
          "（任务可能被派到未部署该应用的执行器）",
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
   * ARCH-34 P0（生产事故 2026-09-23）：`address` 冲突的观测与告警。
   *
   * 背景与判据见 `executor-address-conflict.util.ts` 头注（「被顶替的进程生命
   * 复活」= 同一 address 上两个活进程并存）。此处只负责**可见性**：
   * 记 ERROR 日志 + 走既有通知渠道。级别取 error 而非 notifyExecutorOffline
   * 的 warning——掉线是可用性事件，而串台会让**任务与部署跑到错误的机器上**，
   * 属数据正确性问题。
   *
   * 为什么 P0 阶段**不**直接拒绝注册：拒绝会让被顶替的一方彻底失联（用户看到
   * 「执行器在线但收不到任务」），而当前两侧都无唯一标识时无法判定「谁才是
   * 合法持有者」。先让问题可见；拒绝语义与身份体系按 ADR-017 分阶段落地
   * （本文件目前**不含**任何拒绝开关，注册行为与引入前逐字节一致）。
   *
   * fail-open：观测与通知的任何失败都绝不影响 register/heartbeat 主链。
   */
  private observeAddressConflict(
    address: string,
    startupId: string | null | undefined,
    source: "register" | "heartbeat",
  ): AddressConflictObservation | null {
    let obs: AddressConflictObservation | null = null;
    try {
      obs = this.addressConflictTracker.observe(address, startupId);
    } catch (err) {
      // 纯内存跟踪器不应抛错；真抛了也绝不阻断注册/心跳。
      this.logger.warn(
        `address conflict tracking failed for ${address}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
    if (!obs?.conflict) return obs;

    // 节流命中：确实冲突但刚告警过 → 只留 debug 痕迹，不重复外发。
    if (obs.throttled) {
      this.logger.debug(
        `Address conflict still present for ${address} (startupId=${obs.startupId}, ${obs.otherStartupIds} other life(s)); alert throttled`,
      );
      return obs;
    }

    const detail =
      `Executor address conflict detected on "${address}" via ${source}: ` +
      `startupId=${obs.startupId} is still alive after being displaced by ` +
      `${obs.displacedStartupId ?? "(unknown)"} (${obs.otherStartupIds} process life(s) seen on this address). ` +
      `Two executors are sharing one executors row — their registrations overwrite each other, ` +
      `they compete for the same pull queue (acf:pull:/acf:cmd:), and each one's restart detection ` +
      `fails the other's running executions. Give each machine a distinct EXECUTOR_ADDRESS_PUBLIC ` +
      `(or enable pull mode with unique addresses) to separate them.`;
    this.logger.error(detail);
    // 通知是 best-effort：`notificationService` 在部分测试装配里可能缺席
    // （位置参数 `{} as never`），且 sendAll 可能同步抛错——两者都绝不能
    // 影响注册/心跳主链（与 auditHighRisk 的 fail-open 同款纪律）。
    try {
      void Promise.resolve(
        this.notificationService?.sendAll({
          title: `Executor address conflict: ${address}`,
          content:
            `${detail}\n\n` +
            `Displaced (now active): ${obs.displacedStartupId ?? "(unknown)"}\n` +
            `Revived (still alive): ${obs.startupId}\n` +
            `Time: ${new Date().toLocaleString()}`,
          level: "error",
        }),
      ).catch((err: unknown) =>
        this.logger.warn(
          `Failed to send address-conflict notification for ${address}: ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
    } catch (err) {
      this.logger.warn(
        `Failed to dispatch address-conflict notification for ${address}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return obs;
  }

  /**
   * ARCH-36（ADR-017 阶段 2）：`deviceFingerprint` 冲突/漂移的观测与告警。
   *
   * 判据与方向见 `executor-fingerprint.util.ts` 头注。此处只负责**可见性**：
   * - 硬冲突（同一 address 两个不同指纹）→ ERROR 日志 + 既有通知渠道，
   *   级别与 P0 冲突一致（会让任务与部署跑到错误的机器上，属数据正确性问题）。
   * - 地址漂移（同一指纹换了 address）→ **info 日志**，不告警。这是刻意的：
   *   机器换网/换 IP 是正常运维动作，把它升级成告警会让告警面失去信噪比
   *   （P0 头注里说的"狼来了"）。
   *
   * 与 P0 的关系：两个跟踪器**同时**接线，各自独立外发。一台机器同时具备两个
   * 信号特征（已上报指纹 + 进程生命交替）时会收到两条告警——刻意保留：两条
   * 判据的证据面不同（一条是身份冲突的直接证据，一条是进程并存的时序证据），
   * 合并会丢失"哪条通路成立"的区分度，而运营侧可用**同一条**处置动作收敛两者
   * （给每台机器唯一 EXECUTOR_ADDRESS_PUBLIC）。去重不做，节流各自独立。
   *
   * fail-open：观测与通知的任何失败都绝不影响 register/heartbeat 主链。
   */
  private observeDeviceFingerprint(
    address: string,
    fingerprint: string | null | undefined,
    source: "register" | "heartbeat",
  ): FingerprintObservation | null {
    let obs: FingerprintObservation | null = null;
    try {
      obs = this.deviceFingerprintTracker.observe(address, fingerprint);
    } catch (err) {
      // 纯内存跟踪器不应抛错；真抛了也绝不阻断注册/心跳。
      this.logger.warn(
        `deviceFingerprint tracking failed for ${address}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return null;
    }
    // 未上报/非法指纹（存量旧执行器）：零动作、零日志——兼容性红线。
    if (!obs) return obs;

    const shortFingerprint = `${obs.fingerprint.slice(0, 12)}…`;

    if (obs.addressSharedByMultipleInstalls) {
      if (obs.throttled) {
        this.logger.debug(
          `Address "${address}" still shared by multiple installs (fingerprint=${shortFingerprint}, ` +
            `${obs.fingerprintsOnAddress} distinct deviceFingerprint values seen); alert throttled`,
        );
        return obs;
      }
      // 列出**全部**并存指纹（不只本次那个）：运维要按清单给每台机器分配唯一
      // EXECUTOR_ADDRESS_PUBLIC，只报"有几个"而不报"是哪几个"等于没给出处置面。
      // 与 P0 冲突告警同时给出被顶替者/顶替者两个 startupId 对称。
      const fingerprintList = obs.distinctFingerprintsOnAddress
        .map((f) => `${f.slice(0, 12)}…`)
        .join(", ");
      const detail =
        `Executor address shared by multiple installs on "${address}" via ${source}: ` +
        `${obs.fingerprintsOnAddress} distinct deviceFingerprint values have been reported for this address ` +
        `(this report: ${shortFingerprint}; all: ${fingerprintList}). Two different machines/installations are sharing one executors row — ` +
        `their registrations overwrite each other, they compete for the same pull queue (acf:pull:/acf:cmd:), ` +
        `and each one's restart detection fails the other's running executions. Give each machine a distinct ` +
        `EXECUTOR_ADDRESS_PUBLIC. (deviceFingerprint-based detection: a stable fingerprint cannot change across ` +
        `a normal restart, so this is direct evidence rather than the startupId timing heuristic.)`;
      this.logger.error(detail);
      // 通知是 best-effort：`notificationService` 在部分测试装配里可能缺席，
      // 且 sendAll 可能同步抛错——两者都绝不能影响注册/心跳主链（与
      // observeAddressConflict 同款 fail-open 纪律）。
      try {
        void Promise.resolve(
          this.notificationService?.sendAll({
            title: `Executor address shared by multiple installs: ${address}`,
            content:
              `${detail}\n\n` +
              `Address: ${address}\n` +
              `Distinct fingerprints on this address: ${obs.fingerprintsOnAddress}\n` +
              `Fingerprints: ${fingerprintList}\n` +
              `This report: ${shortFingerprint}\n` +
              `Time: ${new Date().toLocaleString()}`,
            level: "error",
          }),
        ).catch((err: unknown) =>
          this.logger.warn(
            `Failed to send deviceFingerprint-conflict notification for ${address}: ${
              err instanceof Error ? err.message : String(err)
            }`,
          ),
        );
      } catch (err) {
        this.logger.warn(
          `Failed to dispatch deviceFingerprint-conflict notification for ${address}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
      return obs;
    }

    if (obs.addressDrifted) {
      // 正常现象，只留一条 log（不告警）：这是阶段 3 把 address 降级为可达性
      // 元数据之后「执行器换网不再产生幽灵行」的行为预览，此处先让运维看得见。
      // 用 logger.log（Nest 的 info 级）而非 warn/error——详见上方「为什么不告警」。
      this.logger.log(
        `Install ${shortFingerprint} reported from a new address "${address}" via ${source} ` +
          `(now seen at ${obs.addressesForFingerprint} address(es)) — address drift, not a conflict`,
      );
    }
    return obs;
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

  /**
   * NETOPT-G P1-6: 状态落库后发布 executor.online（与 emitExecutorOffline 对称：
   * fail-open、载荷同形）。
   *
   * 只在**真实跃迁**（prev !== ONLINE）时由调用方触发——心跳是 30s 高频路径，
   * 无条件 emit 会把 event_outbox 打爆并给订阅方造成无意义扇出。
   */
  private emitExecutorOnline(
    executor: Pick<Executor, "id" | "appName" | "address">,
  ): void {
    if (!this.eventBus) return;
    const payload: ExecutorOnlineEventPayload = {
      executorId: executor.id,
      appName: executor.appName,
      address: executor.address,
      occurredAt: new Date().toISOString(),
    };
    try {
      this.eventBus.emit(DOMAIN_EVENTS.EXECUTOR_ONLINE, payload);
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

  /**
   * SEC-02 续（生产故障）：把解密后的 secrets **单独**作为派发载荷的 `secrets`
   * 字段下发，供执行器按**原名**注入子进程 env。
   *
   * 为什么需要单独一份（而不是只走既有的 params 合并）：此前 secrets 与 params
   * 合并后统一加 `AUTOFLOW_` 前缀，于是"配置 FEISHU_APP_ID"实际注入的是
   * `AUTOFLOW_FEISHU_APP_ID`——脚本按提示读裸名永远取不到（生产实证），而
   * **第三方 SDK 认的就是规范名**（boto3 的 AWS_ACCESS_KEY_ID、openai 的
   * OPENAI_API_KEY），加前缀后脚本无法改写，凭据等于不可用。
   *
   * 兼容性（关键）：secrets **仍然**合并进 params（`buildDispatchParams`
   * 不动），所以：
   *   · 旧执行器（不认识 `secrets` 字段）行为与今日**逐字节一致**——它们照旧
   *     只读 params，照旧注入 `AUTOFLOW_<KEY>`；
   *   · 新执行器额外按原名注入一份，两种读法并存。
   * 因此本字段是**纯增量**，无需协议版本门禁（不 bump PROTOCOL_VERSION：没有
   * 任何行为依赖"对方是否认识它"）。这与 v2 `commands` 的情形不同——那里必须
   * 门禁，因为 v1 执行器会静默丢弃命令、中台却会误判投递成功。
   *
   * 解密失败与 `buildDispatchParams` 同策：抛错让派发失败，绝不静默裸跑。
   */
  private buildDispatchSecrets(task: Task): Record<string, unknown> | null {
    try {
      return this.secretsCrypto.decryptForDispatch(task.secrets) ?? null;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(
        `Task secrets could not be decrypted for dispatch: ${message}`,
      );
    }
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

  // NETOPT-F P3: releaseExecutorSlotBatch 已删除——批次 D 后重启恢复的计数
  // 权威改为"调用方 e.runningTaskCount=0 + save"（didRestart / missing-baseline
  // 两分支均清零），批量减槽不再有任何生产调用点。死代码若保留会诱导后人
  // 重新引入"恢复后再减槽"的双减 bug（恢复已清零、再减一次即虚低）。若未来
  // 确需批量减槽，须回到单计数权威语义重新设计。

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
   * NETOPT-F P2-F1: 重启恢复的时间基线。startupId-only 重启（换了 startupId 但
   * 未上报 restartedAt）时 incomingStartedAt 为 null，而 shouldFailAfterRestart
   * 对 null 基线放行**全部** RUNNING 行——异步恢复会误杀恢复窗口内闸门新派发
   * 的行（startTime >= 重启时刻）。不得静默退化。
   * 早期实现退回 DB 侧旧基线 executorStartedAt（T0）作 onlyStartedBefore，但该
   * 基线实际"零恢复"：T0 那轮已终态化 startTime<T0 的行，当前存活 RUNNING 行
   * startTime 必然 >= T0，严格 < 过滤下一条都不终态化，旧进程死掉的行只能靠
   * stale sweep 回收（不丢任务——计数已清零、闸门不超派——但恢复路径空转）。
   * 修法：基线改取**服务端本次心跳处理时刻 now**——startTime<now 的旧行被
   * 终态化、恢复后新派发（startTime>now）存活；DB 旧基线仅作 warn 展示
   * （日志可审计），不参与判定。
   */
  private resolveRestartBaseline(
    address: string,
    incomingStartedAt: Date | null,
    incomingStartupId: string | null,
    dbBaseline: Date | string | null | undefined,
  ): Date {
    if (incomingStartedAt) return incomingStartedAt;
    const db = this.parseExecutorStartedAt(dbBaseline);
    const now = new Date();
    this.logger.warn(
      `Executor ${address} restarted with a new startupId=${incomingStartupId} ` +
        `but no restartedAt; using server-side now=${now.toISOString()} as the ` +
        `recovery baseline (startupId-only restart, time baseline degraded; ` +
        `DB executorStartedAt=${
          db ? db.toISOString() : "(null)"
        } was stale). Rows started after this baseline are NOT failed.`,
    );
    return now;
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
   *
   * ARCH-33（ADR-016）：pull 执行器（NAT 内）改走命令队列入队——此前本方法
   * 对 NAT 地址必然超时，而它是 stale sweep 的「防双跑」关键路径。
   */
  async notifyExecutorKill(
    executionId: string,
    executorAddress?: string | null,
  ): Promise<void> {
    if (!executorAddress) return;
    try {
      // ARCH-33: pull 执行器入队即返回（best-effort 语义不变——入队失败回退
      // push，下方 catch 仍把任何异常收敛为 warn）。
      const routed = await this.deliverControlCommand({
        address: executorAddress,
        type: "kill-execution",
        payload: { executionId },
      });
      if (routed.delivered === "pull") return;

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
      // NETOPT-C P3: take 与 E9 采纳域（maxConcurrentTasks ≤10000）对齐——旧 1000
      // 在并发 >1000 时第 1001+ 行不立即标 EXECUTOR_RESTART，滞留 RUNNING 直到
      // stale 兜底（分类降级为 STALE_RECOVERED）。ORDER BY 让重启恢复按启动时间
      // 确定性执行（无排序时 DB 行序不定，同批重复恢复会漂移）。
      take: 10_000,
      order: { startTime: "ASC" },
    });
    const executionsToFail = runningExecutions.filter((execution) =>
      this.shouldFailAfterRestart(execution, onlyStartedBefore),
    );
    // Batch-fetch tasks once instead of one query per execution (avoids N+1)
    const taskIds = [...new Set(executionsToFail.map((e) => e.taskId))];
    const tasks =
      taskIds.length > 0 ? await this.taskRepo.findBy({ id: In(taskIds) }) : [];
    const taskMap = new Map(tasks.map((t) => [t.id, t]));
    // NETOPT-D P2-D1: 重启恢复从"逐行 UPDATE+RETURNING + 逐行减槽 + 逐行入队"
    // 改为"单条批量终态 UPDATE + 按 address 一次性减槽"——满载执行器重启时
    // 逐行写放大（≈2×N 次 DB 往返 + N 次行锁竞争 + N 次 Redis enqueue）会把
    // register/heartbeat 单条请求推到全局 30s 超时（timeout.interceptor.ts）
    // 之外，触发 408 重复恢复。批量版与 scheduler.service 的 stale sweep 同构
    // （transitionToTerminal 批量入口，status-IN 条件 + RETURNING winner 语义）；
    // 单行乐观锁冲突在批量 UPDATE 中不适用（无 version 条件，行锁由 DB 排队），
    // R-11 的"不击穿整批"本意由"单条 UPDATE...IN 原子 + 整体 catch 交 stale
    // sweep 收敛"等价承接。
    if (executionsToFail.length === 0) {
      return 0;
    }
    let failedCount = 0;
    let errorCount = 0;
    try {
      const addressSnapshot = new Map<string, string | null>(
        executionsToFail.map((e) => [e.id, e.executorAddress]),
      );
      const terminal = await transitionToTerminal(this.execRepo, {
        ids: executionsToFail.map((e) => e.id),
        patch: {
          status: ExecutionStatus.FAILED,
          endTime: new Date(),
          failureReason: ExecutionFailureReason.EXECUTOR_RESTART,
          errorMessage:
            "[System] Executor restarted before reporting completion",
          logs: () =>
            `CASE WHEN "logs" IS NULL THEN '' ELSE "logs"::text END || ` +
            `E'\n[System] Executor restarted; execution marked as FAILED'`,
        },
        from: [ExecutionStatus.RUNNING],
        addressSnapshot,
      });
      failedCount = terminal.rows.length;
      // NETOPT-E P2-1: 本函数**不再负责减槽**——计数权威交给调用方的
      // e.runningTaskCount = 0 + save（register/heartbeat 的 didRestart /
      // shouldRecoverMissingBaseline 分支均在同一请求内清零后落库；心跳带真实
      // 上报值时白名单覆盖优先）。此前异步路径（heartbeat 的 void 调用）在
      // save 之后按"旧 winner 数"对已含新派发的计数做 GREATEST 倒扣，会把
      // 新任务计数清零（如 save 写 N 后 GREATEST(N-8000,0)=0）——一个心跳窗
      // 内欠计超派。恢复完成前的计数归零语义不变：执行器重启后旧任务已全部
      // 终态化，runningTaskCount 本应归 0 或自报新值。
      // 重试入队仍逐行：每条需新建 PENDING 行（retryCount/params 各自不同）+
      // BullMQ add；预算检查在 scheduleRetryAfterRecovery 内部，逐行 try/catch
      // 保留异常隔离（入队失败不影响已完成的终态落库）。
      const winnerIds = new Set(terminal.rows.map((r) => r.id));
      for (const execution of executionsToFail) {
        if (!winnerIds.has(execution.id)) continue;
        const task = execution.taskId
          ? (taskMap.get(execution.taskId) ?? null)
          : null;
        if (!task) continue;
        try {
          await this.scheduleRetryAfterRecovery(task, execution);
        } catch (err: unknown) {
          errorCount++;
          this.logger.warn(
            `R-11: Failed to schedule retry for execution ${execution.id} after restart ` +
              `(executor=${executorAddress}): ${
                err instanceof Error ? err.message : String(err)
              }. Execution already marked FAILED; retry skipped.`,
          );
        }
      }
    } catch (err: unknown) {
      errorCount = executionsToFail.length;
      this.logger.warn(
        `R-11: Batch fail of ${executionsToFail.length} running execution(s) after restart ` +
          `(executor=${executorAddress}): ${
            err instanceof Error ? err.message : String(err)
          }. Stale sweep will pick them up.`,
      );
    }
    if (executionsToFail.length > 0) {
      this.logger.warn(
        `Marked ${failedCount}/${executionsToFail.length} running execution(s) as FAILED after executor restart: ${executorAddress}` +
          (errorCount > 0
            ? ` (${errorCount} row(s) had errors and will be retried by stale sweep)`
            : ""),
      );
    }
    // R-P0-009（NETOPT-F P3 注释更新）: 返回值曾供调用方按 winner 数倒扣
    // runningTaskCount——批次 D 后计数权威改为"调用方 e.runningTaskCount=0 +
    // save"（didRestart / missing-baseline 分支均清零），本函数返回值现仅用于
    // 日志/统计（failedCount），不再有减槽用途。
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

  /**
   * ARCH-33（ADR-016）：解析一次「中台→执行器」控制面调用的传输方式。
   *
   * 这是所有控制面调用点（deploy / app-stop / app-uninstall / config-reload /
   * kill / update-package）的**唯一分流出口**。判定顺序：
   *
   *   1. 能定位到执行器行（按 id 优先，回退 address）——定位不到就没有
   *      dispatchMode/protocolVersion 可判，回退 push（存量行为）；
   *   2. `dispatchMode === 'pull'`——push 执行器照旧走 HTTP；
   *   3. `supportsControlPlane(protocolVersion)`——协议 < 2 的 pull 执行器会
   *      忽略 commands 字段，回退 push（失败可见，优于静默丢操作）。
   *
   * 返回 `executor` 便于调用方复用（避免二次查库）。
   */
  async resolveExecutorTransport(opts: {
    executorId?: string | null;
    address?: string | null;
  }): Promise<{ mode: "push" | "pull"; executor: Executor | null }> {
    try {
      const executor = opts.executorId
        ? await this.repo.findOne({ where: { id: opts.executorId } })
        : opts.address
          ? await this.repo.findOne({ where: { address: opts.address } })
          : null;
      if (!executor) return { mode: "push", executor: null };
      if (executor.dispatchMode !== "pull") {
        return { mode: "push", executor };
      }
      if (!supportsControlPlane(executor.protocolVersion)) {
        // 可见的降级：pull 执行器但协议太旧。回退 push 后对 NAT 地址必然
        // 超时——但那是一条调用方**看得见**的失败，且与升级前行为一致；
        // 静默把命令丢进一个执行器不认识的字段才是真正的事故。
        this.logger.warn(
          `Executor ${executor.address} is pull-mode but reports protocolVersion=${executor.protocolVersion ?? "unset"} ` +
            `(< ${PROTOCOL_CONTROL_PLANE_MIN}); falling back to push for this control-plane call — ` +
            `upgrade the executor to enable the pull command channel`,
        );
        return { mode: "push", executor };
      }
      return { mode: "pull", executor };
    } catch (err) {
      this.logger.warn(
        `Transport resolution failed for executor ` +
          `${opts.executorId ?? opts.address ?? "(none)"}: ` +
          `${err instanceof Error ? err.message : String(err)} — falling back to push`,
      );
      return { mode: "push", executor: null };
    }
  }

  /**
   * ARCH-33（ADR-016）：把一条控制面命令投进执行器的 pull 命令队列。
   *
   * 返回 commandId（结果上报与排障的关联键）。抛错表示**未投递**——调用方
   * 据此决定回退 push 还是按既有失败路径处理（绝不静默吞掉）。
   */
  async enqueueExecutorCommand(
    executorId: string,
    type: string,
    payload: Record<string, unknown>,
  ): Promise<string> {
    if (!this.pullService) {
      throw new Error(
        "Pull command channel unavailable: ExecutorPullService not wired",
      );
    }
    const commandId = await this.pullService.enqueueCommand(
      executorId,
      type,
      payload,
    );
    this.logger.log(
      `Queued control command ${type} (${commandId}) for pull executor ${executorId}`,
    );
    return commandId;
  }

  /**
   * ARCH-33（ADR-016）：命令下发的**统一入口**——按传输方式分流。
   *
   * push：调用方自行发 HTTP（各调用点的 URL/超时/载荷各不相同，收敛到此
   *       只会造出一个巨型 switch）。
   * pull：入队并返回 commandId；入队失败**回退 push**（Redis 抖动时宁可
   *       试一次 HTTP，也不要把操作丢掉）。
   *
   * 返回 `delivered: 'pull'` 表示已入队（**不等于已执行**——执行器异步取件
   * 后本地执行，终态由各自的回调通道收敛，见 ADR-016「语义边界」）。
   */
  async deliverControlCommand(opts: {
    executorId?: string | null;
    address: string;
    type: string;
    payload: Record<string, unknown>;
  }): Promise<{ delivered: "push" | "pull"; commandId?: string }> {
    const { mode, executor } = await this.resolveExecutorTransport({
      executorId: opts.executorId,
      address: opts.address,
    });
    if (mode !== "pull" || !executor) return { delivered: "push" };
    try {
      const commandId = await this.enqueueExecutorCommand(
        executor.id,
        opts.type,
        opts.payload,
      );
      return { delivered: "pull", commandId };
    } catch (err) {
      this.logger.warn(
        `Failed to queue ${opts.type} for pull executor ${executor.address}: ` +
          `${err instanceof Error ? err.message : String(err)} — falling back to push`,
      );
      return { delivered: "push" };
    }
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
    // ARCH-36（ADR-017 阶段 2）：稳定设备指纹（可选；缺省/非法 → 不动 DB）。
    // 只采集与观测——**不参与任何定位**（本方法首行仍按 address findOne）。
    deviceFingerprint?: string | null;
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
    // ARCH-34 P0：address 冲突观测（register 入口）。必须在任何 DB 写入**之前**
    // 调用——register 会就地改写被共享行的 appName/capabilities/startupId，冲突
    // 的原始形态（两个进程生命并存）只有在此刻还能完整观察到。
    // fail-open：观测失败绝不影响注册（见 observeAddressConflict 头注）。
    this.observeAddressConflict(data.address, incomingStartupId, "register");
    // ARCH-36（ADR-017 阶段 2）：设备指纹冲突/漂移观测（register 入口）。
    // 与上一行同理必须在任何 DB 写入**之前**——冲突的原始形态（该地址上曾出现
    // 过哪些安装）与会话内已写入的 deviceFingerprint 无关，但"本次上报是否新增
    // 了一个指纹"这个事件只在本次上报时可见。
    // 规范化后再观测/落库：非法形态（长度/字符集不符）视同未上报。
    const incomingFingerprint = normalizeDeviceFingerprint(
      data.deviceFingerprint,
    );
    this.observeDeviceFingerprint(
      data.address,
      incomingFingerprint,
      "register",
    );
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
        // ARCH-36（ADR-017 阶段 2）：首注册即上报则落列；缺省/非法 → undefined
        // → 列保持 NULL（= 未上报；存量旧执行器与采集失败都用 protocolVersion
        // 区分：v3 却为 NULL = 采集失败需排查）。
        deviceFingerprint: incomingFingerprint ?? undefined,
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
    // ARCH-36（ADR-017 阶段 2）：重注册采纳设备指纹（仅在规范化成功时覆盖；
    // 缺省/非法均不动 DB——旧执行器或采集失败的执行器不得把已存值擦成 NULL，
    // 与 interpreters 的「缺省即保留」纪律同款）。
    if (incomingFingerprint !== null) {
      e.deviceFingerprint = incomingFingerprint;
    }
    if (didRestart) {
      // NETOPT-E P2-1: 同步恢复也传重启基准时刻（只终态化旧行），与心跳
      // didRestart 的异步恢复同语义；计数归零由下方 e.runningTaskCount=0 +
      // save 承担（本函数已不再减槽）。
      // NETOPT-F P2-1 / NETOPT-G P3: startupId-only 重启（无 restartedAt）时
      // resolveRestartBaseline 取**服务端本次心跳处理时刻 now**（DB 旧值只作
      // warn 展示、不参与判定）——旧注释"退回 DB 旧值"是已被否决的零恢复
      // 中间实现，勿改回。
      const baseline = this.resolveRestartBaseline(
        data.address,
        incomingStartedAt,
        incomingStartupId,
        e.executorStartedAt,
      );
      await this.failRunningExecutionsAfterRestart(data.address, baseline);
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
    // 遗留 P1-24：恢复在线即清除离线原因标注。
    e.offlineReason = null;
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
   * E-01-RPT: 心跳采纳 `reservedSlots` 的取值域——非负整数 0..MAX_RUNNING_EXECUTION_IDS。
   *
   * 上界与 runningTaskCount 同源（NETOPT-D P2-D2）：reservedSlots 是
   * runningTaskCount 的**子集**，任何超出该上界的值都不可能自洽，越界一律视为
   * 未上报（不改 DB 值），与 maxConcurrentTasks/deadLetterCount 同模式——
   * 执行器上报面不可信，白名单字段必须先过范围校验再落列。
   *
   * 真实上界其实是 maxConcurrentTasks（pull 循环是单飞的，恒为 0/1），但此处
   * 刻意**不**按 maxConcurrentTasks 钳制：该列随心跳热更、且本校验发生在容量
   * 采纳之前，用它做上界会让两个字段的采纳顺序互相影响。真正的自洽性由调用方
   * 的 `reservedSlots <= effectiveRunningCount` 配对校验兜住（那才是硬约束）。
   */
  private static isAdoptableReservedSlots(value: unknown): value is number {
    return (
      typeof value === "number" &&
      Number.isInteger(value) &&
      value >= 0 &&
      value <= MAX_RUNNING_EXECUTION_IDS
    );
  }

  /**
   * CONSISTENCY-02: heartbeat ingest for executor-node 上报的 runningExecutionIds。
   * 输入为 executor 可控字段，须严格防御：非数组视为未上报（返回 null）；逐项仅
   * 保留匹配安全字符集 [A-Za-z0-9_-] 的字符串（其余丢弃）；最多裁剪至 10000 项
   * （与 E9 采纳域 maxConcurrentTasks ≤10000 对齐——旧的 200 封顶在并发 >200 时
   * 让第 201+ 个在跑执行从 stale sweep 的 includes() 判据里消失，存活宽限静默
   * 失效，健康长任务被提前恢复成 FAILED）。
   * null 与 [] 语义不同——null = 旧版执行器未上报该字段（见实体注释），[] = 已
   * 上报且当前空闲。
   *
   * 注意：此处字符集 ^[A-Za-z0-9_-]+$ 比执行器侧（executor-node 的 id 生成/
   * 透传面）更窄，是刻意的防御面收窄——executionId 现为 UUID（仅十六进制 +
   * '-'，天然落在该集合内），收窄不损失合法输入，却把心跳可写入的字符串
   * 形态压到最小（防注入控制字符/超长垃圾项）。若未来 executionId 改用其他
   * 格式，须同步复核此集合而不是盲目放宽。
   */
  private sanitizeRunningExecutionIds(
    value: unknown,
    address?: string,
  ): string[] | null {
    if (!Array.isArray(value)) return null;
    // NETOPT-D P3-7: 防御超长垃圾数组的 CPU DoS 面。NETOPT-E P3-1 修订：不做
    // 前置 slice——>2× 上界时先截断会让窗口外合法 id 静默丢失，且 dropped 口径
    // 低估（25000 全合法时报丢 10000、实丢 15000）。改为全量线性遍历：数组在
    // JSON 解析时已物化进内存，正则 ^[A-Za-z0-9_-]+$ 是 O(1)/项，遍历成本由
    // 解析成本主导，不再显著放大 DoS 面；合法项 10000 封顶 + dropped 精确计数。
    const safe: string[] = [];
    let validCount = 0;
    for (const item of value) {
      if (typeof item === "string" && /^[A-Za-z0-9_-]+$/.test(item)) {
        validCount++;
        if (safe.length < MAX_RUNNING_EXECUTION_IDS) {
          safe.push(item);
        }
      }
    }
    // NETOPT-D P2-D2: warn 补 address 与丢弃条数——运维按执行器定位溢出源，
    // 而不是在全仓日志里猜是哪台机器超发。
    // NETOPT-D P3-3: warn 节流——执行器持续超发时每心跳一条会把日志刷成噪
    // 音；同 address 同丢弃量 60s 内只 warn 一次（丢弃量变化立即更新重计时）。
    if (validCount > MAX_RUNNING_EXECUTION_IDS) {
      const dropped = validCount - MAX_RUNNING_EXECUTION_IDS;
      const key = address ?? "?";
      const prev = lastTruncationWarn.get(key);
      const now = Date.now();
      if (
        !prev ||
        prev.dropped !== dropped ||
        now - prev.at > TRUNCATION_WARN_THROTTLE_MS
      ) {
        this.logger.warn(
          `runningExecutionIds exceeded ${MAX_RUNNING_EXECUTION_IDS} (executor=${key}, ${dropped} overflow id(s) dropped); ` +
            `overflow ids lose the stale-sweep survival grace (healthy long tasks may be recovered early)`,
        );
        lastTruncationWarn.set(key, { dropped, at: now });
        if (lastTruncationWarn.size > 100) {
          // 淘汰最旧一条，防 Map 无限膨胀（超发执行器是少数异常）
          let oldest: string | null = null;
          let oldestAt = Infinity;
          for (const [k, v] of lastTruncationWarn) {
            if (v.at < oldestAt) {
              oldestAt = v.at;
              oldest = k;
            }
          }
          if (oldest) lastTruncationWarn.delete(oldest);
        }
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
      // E-01-RPT（生产实证：RPA5「当前运行任务 1/10、活性上报 0 条」）：pull
      // 长轮询「已预留但尚未认领」的槽位数。只用于展示/告警换算（实际运行 =
      // runningTaskCount − reservedSlots），**不参与派发闸门**（见实体注释）。
      reservedSlots?: number | null;
      deadLetterCount?: number;
      // E9: 执行器热更新容量上报（可选，正整数 1..10000，非法/缺失不改 DB）
      maxConcurrentTasks?: number;
      // python_task_multiversion（WS2 · CONTRACT §2.3）：解释器缓存池清单。
      // 缺省 → 保留 DB 旧值；结构非法 → 拒绝采纳 + warn；合法（含 []）→ 覆盖。
      interpreters?: ExecutorInterpreter[] | null;
      // ARCH-36（ADR-017 阶段 2）：稳定设备指纹（可选；缺省/非法 → 保留 DB 旧值）。
      deviceFingerprint?: string | null;
    },
  ) {
    const e = await this.repo.findOne({ where: { address } });
    if (!e) throw new NotFoundException("Executor not found");
    const incomingStartedAt = this.parseExecutorStartedAt(metrics.restartedAt);
    const incomingStartupId = metrics.startupId?.trim() || null;
    // ARCH-34 P0：address 冲突观测（heartbeat 入口，30s 高频）。
    // 这里是冲突的**主要检出点**：两台机器并存时交替注册/心跳，被顶替者的
    // 心跳必然先于下一次注册到达。节流在跟踪器内按 (address, startupId) 收敛，
    // 高频路径不会刷日志/通知（见 CONFLICT_ALERT_THROTTLE_MS）。
    this.observeAddressConflict(address, incomingStartupId, "heartbeat");
    // ARCH-36（ADR-017 阶段 2）：设备指纹冲突/漂移观测（heartbeat 入口）。
    // 心跳是**主要**的重复观测点（register 只在启动与补注册时发生），也是
    // 「同一 address 上两个指纹」最容易先暴露的地方——两台机器并存时它们各自
    // 30s 一次的心跳都会走到这里。
    const incomingFingerprint = normalizeDeviceFingerprint(
      metrics.deviceFingerprint,
    );
    this.observeDeviceFingerprint(address, incomingFingerprint, "heartbeat");
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
      // E-01-RPT: reservedSlots 不是数值指标列，从 metricValues 中摘出单独走
      // 「与 runningTaskCount 的一致性」采纳（见下方 reservedSlots 段）——
      // 它必须与本次上报的 runningTaskCount 配对校验，不能落进通用白名单环。
      reservedSlots,
      // python_task_multiversion：interpreters 不是数值指标列，从 metricValues
      // 中摘出单独走结构校验（不进 metricsWhitelist 的数值写入环）。
      interpreters,
      // ARCH-36（ADR-017 阶段 2）：deviceFingerprint 不是数值指标列，同样摘出
      // （上方已单独观测过，此处只为不让它落进数值白名单写入环）。
      deviceFingerprint: _f,
      ...metricValues
    } = metrics;
    if (didRestart) {
      // NETOPT-D P2-3: 重启恢复不阻塞心跳线程——批量 FAILED 落库 + 批量减槽
      // 先行，逐行重试入队异步收敛；恢复中途失败的行由 stale sweep 兜底
      // （R-11 既有收敛路径）。E9 高容量下近万行逐行入队会让单次心跳拖到
      // 全局超时之外、触发 markStaleOffline 误判刚重启的执行器。
      // NETOPT-E P2-1: 异步恢复带 onlyStartedBefore（重启基准时刻）——恢复
      // find 谓词只有 address + RUNNING，无时间过滤时会把恢复期间闸门新派发
      // 的行（startTime >= 重启时刻）一并终态化误杀。传 incomingStartedAt 后
      // shouldFailAfterRestart 只放行 startTime < 重启时刻的旧行。
      // NETOPT-F P2-1 / NETOPT-G P3: startupId-only 重启（无 restartedAt）时
      // resolveRestartBaseline 取**服务端 now**（DB 旧基线仅 warn 展示）——对
      // startTime<now 的旧行终态化、恢复后新派发（startTime>now）存活。旧注释
      // "基线退回 DB 旧值"与实现矛盾，已改正，勿改回零恢复中间形态。
      const baseline = this.resolveRestartBaseline(
        address,
        incomingStartedAt,
        incomingStartupId,
        e.executorStartedAt,
      );
      void this.failRunningExecutionsAfterRestart(address, baseline).catch(
        (err: unknown) => {
          this.logger.warn(
            `Restart recovery for ${address} failed asynchronously: ${
              err instanceof Error ? err.message : String(err)
            }. Stale sweep will pick up remaining RUNNING rows.`,
          );
        },
      );
      // NETOPT-E P3-1: 重启分支同样清零内存 runningTaskCount（与 register
      // 分支 :870/:877 对齐）。异步恢复会批量减槽落库，但本心跳后续
      // save(e) 会把内存里的旧高值原样写回——用旧值覆盖恢复结果，派发
      // 闸门 runningTaskCount 虚高、欠派。清零后若本次心跳带真实上报值，
      // 白名单覆盖仍生效（见下方 metricValues 写入环）。
      e.runningTaskCount = 0;
      // E-01-RPT: 预留同样清零——重启后进程内的 pull 循环已消失，重启前的
      // 「预留中」槽位必然不复存在，留着会让 UI 把陈旧预留从新计数里减掉
      // （显示比真值少 1）。若本次心跳带真实上报值，下方采纳段仍会覆盖。
      e.reservedSlots = 0;
    } else if (shouldRecoverMissingBaseline) {
      await this.failRunningExecutionsAfterRestart(address, incomingStartedAt);
      // NETOPT-F P2-F2: missing-baseline 分支与 register 同型分支（:908）对称
      // ——异步恢复会批量减槽落库，但本心跳后续 save(e) 会把内存里的旧高值
      // 原样写回，用旧值覆盖恢复结果，闸门 runningTaskCount 虚高、欠派。
      // 清零后若本次心跳带真实上报值，白名单覆盖仍生效。
      e.runningTaskCount = 0;
      // E-01-RPT: 同 didRestart 分支——陈旧预留不得参与新计数的换算。
      e.reservedSlots = 0;
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
    // NETOPT-D P2-D2: runningTaskCount 是派发闸门的数字列（selectLeastLoaded/
    // 容量守卫直接读它判满）——执行器上报面不可信，必须与数组截顶共享同一
    // 上界（MAX_RUNNING_EXECUTION_IDS）。否则真实在跑 >10000 时闸门误判有空位
    // 而超发；且被数组截断丢弃的 id 在 stale includes() 判据里被判"不在跑"，
    // 健康长任务被提前恢复成 FAILED。非法值视同未上报（DB 值不动）。
    if (
      metricValues.runningTaskCount !== undefined &&
      (!Number.isInteger(metricValues.runningTaskCount) ||
        metricValues.runningTaskCount < 0 ||
        metricValues.runningTaskCount > MAX_RUNNING_EXECUTION_IDS)
    ) {
      this.logger.warn(
        `Executor ${address} reported invalid runningTaskCount=${String(
          metricValues.runningTaskCount,
        )} (expected integer in 0..${MAX_RUNNING_EXECUTION_IDS}); keeping stored value`,
      );
      // NETOPT-E P3-1: 越界只删字段、DB 值不动——持续越界上报期间派发闸门用
      // 陈旧计数判满（可能误判满/空），但下一次合法上报即自纠正；不为此引入
      // 半采纳状态（半采纳值同样不可信）。
      delete metricValues.runningTaskCount;
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
    // NETOPT-G P1-6：记录跃迁前的状态——executor.online 只在**真实恢复**
    // （非 ONLINE → ONLINE）时发布，避免每次 30s 心跳都刷一条事件。
    const wasOnline = e.status === ExecutorStatus.ONLINE;
    e.status = ExecutorStatus.ONLINE;
    // NETOPT-G P1-7：心跳到达即清零"连续超时"计数——这是迟滞判死能自愈的
    // 关键：一次成功心跳就把"疑似失联"状态彻底解除，下一轮 sweep 必须重新
    // 从 0 累计，因此"偶发失败 + 恢复"永远不会累积到判死阈值。
    e.consecutiveHeartbeatMisses = 0;
    // 遗留 P1-24：恢复在线即清除离线原因标注。
    e.offlineReason = null;
    e.lastHeartbeat = new Date();
    if (incomingStartedAt) e.executorStartedAt = incomingStartedAt;
    if (incomingStartupId) e.executorStartupId = incomingStartupId;

    // CONSISTENCY-02: persist executor-node 的活性上报。缺省字段写 null
    // （= 旧版执行器未上报，区别于 [] 的"已上报且空闲"）；仅在字段上报时才
    // 覆盖，避免旧版心跳把新版已写入的活性集合擦回 null。deadLetterCount
    // 经上方白名单校验后采纳落列（U16），>0 时仍保留告警。
    if (runningExecutionIds !== undefined) {
      e.runningExecutionIds = this.sanitizeRunningExecutionIds(
        runningExecutionIds,
        address,
      );
    }
    // E-01-RPT（生产实证：RPA5 恒显「当前运行任务 1/10」「活性上报 0 条，与运行
    // 计数 1 不一致」，而设备上无任务在跑）：采纳 pull 预留槽位数。
    //
    // 采纳时机刻意放在**这里**：此刻 e.runningTaskCount 已被上方白名单环写成
    // 本次上报的最终值（或重启分支清零值），配对校验才拿得到真值。
    //
    // 三态纪律（与 runningExecutionIds 同款，这是兼容性红线）：
    // - `undefined`（旧版执行器未上报）→ **保留 DB 旧值**，UI 回落「按已占槽位
    //   显示」的旧口径，行为与引入前逐字节一致；
    // - 非法（非整数/负数/超上界/与 runningTaskCount 不自洽）→ warn + 保留 DB
    //   旧值（不半采纳——半采纳值同样不可信，与 NETOPT-E P3-1 同调）；
    // - 合法（**含 0**）→ 覆盖。
    //
    // 自洽性硬约束 `reservedSlots <= runningTaskCount`：预留是「已占槽位」的
    // **子集**（E-01 让预留与正式占用共用同一账本），故预留数不可能超过总数。
    // 违反即说明该上报不可信（典型成因：本次 runningTaskCount 越界被删、留下
    // 陈旧低值），此时连 reservedSlots 一起拒绝，让 UI 走旧口径，下一次合法
    // 上报即自纠正。
    if (reservedSlots !== undefined) {
      if (!ExecutorService.isAdoptableReservedSlots(reservedSlots)) {
        this.logger.warn(
          `Executor ${address} reported invalid reservedSlots=${String(
            reservedSlots,
          )} (expected integer in 0..${MAX_RUNNING_EXECUTION_IDS}); keeping stored value`,
        );
      } else if (reservedSlots > e.runningTaskCount) {
        // 注意用 e.runningTaskCount（最终值）而非 metricValues.runningTaskCount
        // ——后者可能刚被越界校验删除，读它会是 undefined 而恒判不自洽。
        this.logger.warn(
          `Executor ${address} reported reservedSlots=${reservedSlots} exceeding ` +
            `runningTaskCount=${e.runningTaskCount} (reservations are a subset of ` +
            `occupied slots); keeping stored reservedSlots`,
        );
      } else {
        e.reservedSlots = reservedSlots;
      }
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
    // ARCH-36（ADR-017 阶段 2）：心跳采纳 `deviceFingerprint`。
    // 三态与 interpreters 同款，但**非法时只留 debug 不 warn**：指纹是机器
    // 自报的十六进制串，形态非法说明执行器侧采集/序列化有 bug，而这条路径
    // 每 30s 一次/台——warn 会给全部异常执行器刷屏，debug 已足够定位（真正的
    // 可观测价值在 `stats()` 的覆盖率口径：reportsWithFingerprint / reports）。
    // 关键：缺省/非法一律**不动 DB**——绝不让旧执行器或采集失败的心跳把已存的
    // 指纹擦成 NULL（那会让冲突观测失去历史，正是本阶段最需要的数据）。
    if (metrics.deviceFingerprint !== undefined) {
      if (incomingFingerprint === null) {
        this.logger.debug(
          `Executor ${address} reported a non-conformant deviceFingerprint ` +
            `(expected 64 hex chars); keeping stored value`,
        );
      } else {
        e.deviceFingerprint = incomingFingerprint;
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

    // NETOPT-F P3-3（读改写竞态，仅文档化）：heartbeat 的整实体 save 可覆盖
    // dispatch 的原子 +1 与 stale sweep 的原子 -1——每事件至多 1 槽偏差，且
    // 下一心跳（执行器如实上报 runningTaskCount）即自纠正。不加锁/版本校验
    // 是有意取舍（R-P0-006：心跳高频、乐观锁冲突会反噬吞吐）；偏差窗口内的
    // 闸门判满/判空是暂时的，不上报的旧版执行器才依赖该近似。
    const saved = await this.repo.save(e);
    // NETOPT-G P1-6（状态机对称性）：恢复在线的事件在**落库之后**发布，与
    // emitExecutorOffline 的三处调用点同口径（状态先落库，事件后发）。
    // 只在真实跃迁时发——心跳 30s 一次，无条件 emit 会把 outbox 打爆。
    if (!wasOnline) {
      this.emitExecutorOnline(saved);
    }
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
   * - NETOPT-G P1-7 起追加 `staleOfflineConfirmations` 与 `effectiveOfflineAfterMs`：
   *   迟滞上线后真实判死窗口不再是 `heartbeatTimeoutMs`，而是它 × 确认轮数
   *   （+ 至多一个扫描周期）。不暴露这两项会让 UI 展示的"多久判离线"与后端
   *   实际行为不符——正是本字段当初要消灭的那类前后端漂移。
   */
  async getRuntimeConfig(): Promise<{
    heartbeatIntervalMs: number;
    heartbeatTimeoutMultiplier: number;
    heartbeatTimeoutMs: number;
    staleOfflineConfirmations: number;
    effectiveOfflineAfterMs: number;
    listLimit: number;
    executorTotal: number;
  }> {
    const heartbeatIntervalMs =
      this.configService.get<number>("executor.heartbeatInterval") || 30000;
    const heartbeatTimeoutMultiplier =
      this.configService.get<number>("executor.heartbeatTimeoutMultiplier") ||
      3;
    const executorTotal = await this.repo.count();
    // NETOPT-G P1-7：只解析一次确认轮数（下方两处引用）——重复调用会让
    // configService.get 在同一请求里被读两次，既浪费也让"有效窗口"与"轮数"
    // 理论上可能取到不同值（配置热更竞态）。
    const staleOfflineConfirmations = this.resolveStaleConfirmations();
    return {
      heartbeatIntervalMs,
      heartbeatTimeoutMultiplier,
      heartbeatTimeoutMs: heartbeatIntervalMs * heartbeatTimeoutMultiplier,
      // NETOPT-G P1-7：判死迟滞的确认轮数，以及据此算出的**实际**判死窗口。
      // 前端此前只按 heartbeatTimeoutMs（90s）展示"多久判离线"，而迟滞上线后
      // 真实窗口 = heartbeatTimeoutMs × staleOfflineConfirmations（+ 一个扫描
      // 周期）。不暴露这两项会让 UI 显示与真实行为不符。
      staleOfflineConfirmations,
      effectiveOfflineAfterMs:
        heartbeatIntervalMs *
        heartbeatTimeoutMultiplier *
        staleOfflineConfirmations,
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
    /**
     * ARCH-35 P1：部署归属偏好命中面。null = 偏好未适用（开关关 / 任务无
     * applicationId / 仓库未装配 / 查询失败）。非 null 时 `preferred=0` 且
     * `runningDeployments=0` 表示该应用没有运行中的部署。
     */
    deploymentAffinity?: {
      preferred: number;
      matchedByExecutorId: number;
      matchedByAddressOnly: number;
      runningDeployments: number;
    } | null;
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
        // ARCH-35 P1：部署归属偏好命中面（见调用点与入参注释）。null 时
        // 显式输出 null 而非省略——「没这个字段」与「偏好未适用」必须可区分。
        deploymentAffinity: input.deploymentAffinity ?? null,
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

    // 3b. ARCH-35 P1（生产事故 2026-09-23）：**部署归属偏好**。
    //
    // 位置刻意选在「评分排序之后、原子占坑之前」：
    //   - 必须在排序**之后**：分区只调整分组、组内保序，故组内首选仍是评分
    //     最优者。若在排序前分区，紧接着的全量 sort 会把分组彻底打散（本文件
    //     上方 `withScores.sort` 是稳定排序但键是 score，分组信息不参与比较）。
    //   - 必须在占坑**之前**：占坑循环按 `sorted` 顺序逐个尝试，前置的部署
    //     执行器因此被优先占用；它满了/离线了，循环继续往下走 → **自动降级
    //     回全机队**，零新增失败面（`ordered` 与入参同元素集）。
    //
    // 语义是「偏好」而非「过滤」：执行器侧的任务执行**不依赖**本地是否部署过
    // 该应用（部署产物树 `<workDir>/apps/<appId>/` 与执行树
    // `<workDir>/<executionId>/` 互不相交；executor-python 甚至没有 deploy
    // 路由）。硬过滤会把全部未部署任务与 python 执行器踢出候选集 → 派发失败。
    // 完整论证见 executor-deployment-affinity.util.ts 头注。
    //
    // `scoredSnapshot`（上方）保持为**纯评分**前三名不变——决策日志里的 score
    // 必须始终是真实负载分，否则「为什么选这台」无法回溯。偏好命中面另记
    // `deploymentAffinity` 字段。
    const deployments = await this.resolveRunningDeployments(task);
    let deploymentAffinity: {
      preferred: number;
      matchedByExecutorId: number;
      matchedByAddressOnly: number;
      runningDeployments: number;
    } | null = null;
    let orderedCandidates = sorted;
    if (deployments) {
      const affinity = partitionByDeploymentAffinity(sorted, deployments);
      orderedCandidates = affinity.ordered;
      deploymentAffinity = {
        preferred: affinity.preferredCount,
        matchedByExecutorId: affinity.matchedByExecutorId,
        matchedByAddressOnly: affinity.matchedByAddressOnly,
        runningDeployments: affinity.runningDeployments,
      };
      if (affinity.preferredCount > 0) {
        this.logger.log(
          `ARCH-35: 任务 "${task.name}" 关联应用 ${task.applicationId} 的部署归属命中 ` +
            `${affinity.preferredCount} 台候选执行器（id 命中 ${affinity.matchedByExecutorId} / ` +
            `address 兜底 ${affinity.matchedByAddressOnly}），已前置优先占坑`,
        );
      }
    }

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
    for (const candidate of orderedCandidates) {
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
      // ARCH-35 P1：部署归属偏好命中面（null = 偏好未适用：开关关/无
      // applicationId/仓库未装配/读失败）。运维据此区分「没部署」与
      // 「部署了但没命中候选」——前者 preferred=0 且 runningDeployments=0，
      // 后者 runningDeployments>0 而 preferred=0（部署那台不在候选池里，
      // 例如被 group/tags/runtime 过滤掉或已离线）。
      deploymentAffinity,
    });

    this.logger.log(
      `Dispatching task "${task.name}" to executor ${matched.address} (runningTasks=${matched.runningTaskCount})`,
    );
    execution.executorAddress = matched.address;

    try {
      // SEC-02: params + decrypted secrets（secrets 覆盖同名 params，仅进派发载荷不落库）
      const dispatchParams = this.buildDispatchParams(task, execution);
      // SEC-02 续：secrets 另发一份，供执行器按**原名**注入（第三方 SDK 认规范名）。
      const dispatchSecrets = this.buildDispatchSecrets(task);
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
          // SEC-02 续：secrets 单独下发一份供执行器按原名注入（纯增量字段，
          // 旧执行器忽略它，见 buildDispatchSecrets 的注释）。
          secrets: dispatchSecrets,
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
          // SEC-02 续：secrets 单独下发一份供执行器按原名注入（纯增量字段）。
          secrets: dispatchSecrets,
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
   * ARCH-35 P1（生产事故 2026-09-23）：读取「该应用正跑在哪几台执行器上」。
   *
   * 事故主因：`app_deployments` 行记了 `executorId`/`executorAddress`，但
   * manifest 驱动的任务自动注册不写 `task.executorId` → 任务恒走全机队分支 →
   * 纯按负载挑一台 → 部署在执行器 A 的应用，任务跑到了 B。选执行器时**全仓库
   * 没有一处**查过部署归属，用户的部署意图在调度面被静默丢弃。
   *
   * 返回 `null` 表示「偏好不适用」（开关关 / 仓库未装配 / 任务无 applicationId）
   * ——调用方据此**完全跳过**分区，顺序不变。返回数组（可能为空）表示「偏好
   * 适用但无运行中部署」——分区同样退化为原序（util 的快速路径）。
   *
   * 查询失败**不抛**：偏好是 best-effort 的调度优化，绝不能因为一次读失败而
   * 让任务派发失败（那是把「可能派得不理想」升级成「派不出去」）。降级为
   * warn + 原序，与 `estimatedDurationsByExecutor` 的既有容错同款。
   *
   * 为什么不缓存：事故场景正是「刚部署完 A → 立刻下发任务」，任何 TTL 缓存都会
   * 让用户在最该生效的时刻看到旧结论（仍然派给 B），修复感为零。查询命中
   * `["applicationId","status"]` 复合索引，相对 dispatch 既有的多轮 DB 往返可忽略。
   */
  private async resolveRunningDeployments(
    task: Task,
  ): Promise<AppDeployment[] | null> {
    // 开关：默认开（见 configuration.ts 的论证——本特性不新增失败面）。
    // 显式 `=== false` 判定：configService 在测试装配里可能返回 "http" 等
    // 任意值，只有明确 false 才关，避免误关掉修复。
    if (this.configService.get("executor.preferDeployedExecutor") === false) {
      return null;
    }
    if (!this.appDeploymentRepo) return null;
    if (!task.applicationId) return null;
    try {
      return await this.appDeploymentRepo.find({
        where: {
          applicationId: task.applicationId,
          status: DeploymentStatus.RUNNING,
        },
        // 投影最小列：分区只需 id/address/status 三个判据，避免拉回
        // env/rolloutMeta 等 jsonb 大列（一次派发一次查询，热路径）。
        select: ["executorId", "executorAddress", "status"],
      });
    } catch (err) {
      // best-effort：读失败不阻断派发（偏好缺失 ≠ 无法调度）。
      this.logger.warn(
        `ARCH-35: 读取应用 ${task.applicationId} 的运行中部署失败，` +
          `本次派发按纯负载择优：${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
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
    // SEC-02 续：secrets 另发一份，供执行器按**原名**注入（第三方 SDK 认规范名）。
    const dispatchSecrets = this.buildDispatchSecrets(task);
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
            // SEC-02 续：secrets 单独下发一份供执行器按原名注入（纯增量字段）。
            secrets: dispatchSecrets,
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
            // SEC-02 续：secrets 单独下发一份供执行器按原名注入（纯增量字段）。
            secrets: dispatchSecrets,
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
    // NETOPT-E P3-3: 与主 stale sweep 同档——take 1000 无 order 无循环，在
    // 单执行器 10000 并发（E9 采纳域）下每 5 分钟只处理前 1000 行，第 1001+
    // 行滞留到下一轮（恢复吞吐 < 故障规模时永不自收敛）。分页循环 +
    // startTime/id 双键排序对齐 scheduler.service 的 STALE_SWEEP 同款约定。
    const lostExecs: TaskExecution[] = [];
    const LOST_SWEEP_PAGE = 1000;
    const LOST_SWEEP_MAX = 20_000;
    let pageOffset = 0;
    while (lostExecs.length < LOST_SWEEP_MAX) {
      const page = await this.execRepo
        .createQueryBuilder("exec")
        .where("exec.status = :status", { status: ExecutionStatus.RUNNING })
        .andWhere("exec.startTime < :threshold", { threshold: broadThreshold })
        .orderBy("exec.startTime", "ASC")
        .addOrderBy("exec.id", "ASC")
        .take(LOST_SWEEP_PAGE)
        .skip(pageOffset)
        .getMany();
      lostExecs.push(...page);
      if (page.length < LOST_SWEEP_PAGE) break;
      pageOffset += page.length;
    }
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

  /**
   * NETOPT-G P1-7：判死所需的**连续超时轮数**。
   *
   * 默认 2：一次 90s 超时只记为"错过一轮"，连续两轮（≈2×90s + 一个扫描周期）
   * 才判死。取值依据（生产实测）：
   *  - 单次心跳失败率约 4.5%，两次独立失败同时发生 ≈ 0.2%——已压到噪声级；
   *  - 长尾 RTT 最大 153s，单轮 90s 阈值本就会被长尾踩线，两轮确认给了链路
   *    一次恢复机会；
   *  - 代价：真实故障检出从 90s 延到 ~210s（多一个确认窗口）。这是**有意
   *    取舍**——误判的代价（离线通知风暴 + 执行器被移出派发候选 + 运行中
   *    任务被误标）高于多等 2 分钟；且派发本身有 TTL/sweep 兜底，不会因
   *    执行器判死晚 2 分钟而丢任务。
   *
   * 配置 `executor.staleOfflineConfirmations` 可调；非法值（<1 / 非数）回退
   * 默认，绝不因配置写错导致"永不判死"或"立即判死"。
   */
  private resolveStaleConfirmations(): number {
    const raw = this.configService.get<number>(
      "executor.staleOfflineConfirmations",
    );
    if (typeof raw === "number" && Number.isFinite(raw) && raw >= 1) {
      return Math.floor(raw);
    }
    return 2;
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
    // NETOPT-G P1-7（判死迟滞）：需要**连续**多少轮扫描命中超时才真正判死。
    const requiredMisses = this.resolveStaleConfirmations();

    // ── 第一步：对"本轮超时但仍标 ONLINE"的行递增计数 ──────────────────
    //
    // 这一步把"刚错过一次心跳"与"持续失联"区分开：单次墙钟命中只 +1，
    // 不改变 status——这正是修复跨境抖动误判的关键。计数在命中时累加、
    // 在 heartbeat() 到达时清零，因此"偶发失败 + 恢复"不会再判死。
    //
    // 用 SQL 表达式自增（而非先查后写）避免并发心跳与 sweep 的读改写竞态。
    // 同时可顺带记录"疑似失联"观测面（计数 >= 1 即说明已错过至少一轮）。
    await this.repo
      .createQueryBuilder()
      .update(Executor)
      .set({
        consecutiveHeartbeatMisses: () => '"consecutiveHeartbeatMisses" + 1',
      })
      .where('status = :status AND "lastHeartbeat" < :cutoff', {
        status: ExecutorStatus.ONLINE,
        cutoff,
      })
      .execute();

    // ── 第二步：只对"计数已达阈值"的行做 ONLINE→OFFLINE 跃迁 ────────────
    //
    // R-30（DEEP_REVIEW 0ef3bbe）: 消除查询/更新间隙的误发。旧实现先 find 快照
    // staleExecutors，再 repo.update（同条件重查，行级正确），最后事件/通知循环
    // 遍历的是**先查的快照**——间隙内补了心跳（lastHeartbeat 新于 cutoff）的
    // 执行器虽不被 UPDATE 命中，仍会收到 executor.offline 事件与通知。改为
    // 条件 UPDATE ... RETURNING：原子地拿到真正发生 ONLINE→OFFLINE 跃迁的行，
    // 事件/通知只对这部分扇出（与 scheduler COVER_EARLY 的条件 UPDATE+RETURNING
    // 同型），间隙误发从结构上消失。
    //
    // `consecutiveHeartbeatMisses >= :requiredMisses` 保证：即使两轮扫描之间
    // 执行器恢复过一次心跳（heartbeat() 已把计数清零、lastHeartbeat 刷新），
    // 它也不会被本条命中。
    const result = await this.repo
      .createQueryBuilder()
      .update(Executor)
      // 遗留 P1-24：心跳超时判死与优雅下线区分落值。
      .set({
        status: ExecutorStatus.OFFLINE,
        offlineReason: ExecutorOfflineReason.STALE_TIMEOUT,
      })
      .where(
        'status = :status AND "lastHeartbeat" < :cutoff AND "consecutiveHeartbeatMisses" >= :requiredMisses',
        {
          status: ExecutorStatus.ONLINE,
          cutoff,
          requiredMisses,
        },
      )
      .returning(["id", "appName", "address"])
      .execute();

    const transitioned = (result.raw ?? []) as Array<{
      id: string;
      appName: string;
      address: string;
    }>;
    if (transitioned.length === 0) return;

    this.logger.warn(
      `Marked ${transitioned.length} executor(s) as OFFLINE after ${requiredMisses} consecutive heartbeat misses (>${timeoutMs}ms each)`,
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
      // 遗留 P1-24：优雅下线。
      {
        status: ExecutorStatus.OFFLINE,
        offlineReason: ExecutorOfflineReason.MANUAL,
        lastHeartbeat: new Date(),
      },
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
    // 遗留 P1-24：管理员手动下线。
    executor.offlineReason = ExecutorOfflineReason.MANUAL;
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
      /**
       * E-01-RPT: pull 长轮询「已预留但尚未认领」的槽位数。
       * `null` = 该执行器未上报该字段（旧版执行器）→ 前端回落旧口径，
       * 不做「实际运行 = runningTaskCount − reservedSlots」换算。
       */
      reservedSlots: number | null;
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
        // E-01-RPT: 随详情一并下发，供前端把「已占槽位」换算成「实际运行数」
        // 并抑制 E-01 预留窗口造成的假「不一致」告警。
        reservedSlots: executor.reservedSlots ?? null,
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
