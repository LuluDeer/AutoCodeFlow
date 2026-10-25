import {
  Injectable,
  Logger,
  Optional,
  OnModuleDestroy,
  OnModuleInit,
} from "@nestjs/common";
// ARCH-31: 批次活性租约的持有者标识（hostname:pid）
import { hostname } from "os";
import { InjectRepository } from "@nestjs/typeorm";
import {
  Repository,
  LessThan,
  MoreThanOrEqual,
  And,
  In,
  IsNull,
  Like,
  Raw,
  OptimisticLockVersionMismatchError,
  FindOptionsWhere,
} from "typeorm";
import axios from "axios";
import { ConfigService } from "@nestjs/config";
import { Cron } from "@nestjs/schedule";
import {
  AppDeployment,
  DeploymentStatus,
  DeploymentApprovalStatus,
  DeploymentTriggerType,
  RunMode,
} from "./entities/app-deployment.entity";
import { ApplicationVersion } from "./entities/application-version.entity";
// R4（§4.1A）：不可变部署事件表（部署域动作追溯，纯旁路记录）。
import {
  AppDeploymentEvent,
  AppDeploymentEventType,
} from "./entities/app-deployment-event.entity";
import { Application } from "./entities/application.entity";
import { ApplicationService } from "./application.service";
// P0-1（2026-10-25 审计）：版本恢复链写 applications 表经 ApplicationService.update，
// 其属主守卫需要 actor（id+role）——controller 从 @CurrentUser 取（AuthUser 含 role）。
import { UserRole } from "../users/entities/user.entity";
import { ExecutorService } from "../executor/executor.service";
import type { Executor } from "../executor/entities/executor.entity";
// ARCH-31 §5: cron 维护任务统一 Leader 门禁（@Optional 同 eventBus/audit 先例——
// 既有单测直接 new 装配时 gate 缺席 → null → 门禁不生效）。
import { LeaderGateService } from "../../common/leader-gate/leader-gate.service";
import {
  assertAndPinExecutorUrl,
  PinnedHttpTarget,
  pinnedAxiosConfig,
} from "../../common/utils/safe-http.util";
import {
  CreateDeploymentDto,
  DeploymentHeartbeatDto,
} from "./dto/app-deployment.dto";
import {
  AppReleaseRow,
  AppReleaseDevice,
  ReleaseTriggerType,
  RELEASE_OPERATOR_MISSING_REASON,
} from "./dto/app-release.dto";
// DEP-02/DEP-03: 灰度（canary）批次 + manifest 健康探针 + 自动回滚
import { RolloutState } from "./entities/app-deployment.entity";
import { canaryBatchSize, parseManifestHealthCheck } from "./dto/rollout.dto";
// 应用列表页部署统计（GET /app-deployments/stats）的响应契约
import { AppDeploymentStatsDto } from "./dto/app-deployment-response.dto";

// FEAT-07: deployment.completed 出站事件（总线 @Global；Optional 注入先例 task.service）
import {
  DOMAIN_EVENTS,
  DeploymentCompletedEventPayload,
  ExecutorAddressDriftedEventPayload,
  ExecutorCommandFailedEventPayload,
} from "../../common/events/domain-events";
import { DomainEventBus } from "../../common/services/domain-event-bus.service";

// DEP-04: 审批留痕（AuditService @Optional 注入，先例 executor.service——
// 存量单测未提供 AuditModule 时降级为仅日志，主链不因审计故障中断）。
import { AuditService } from "../audit/audit.service";
// LANG-ERR-01: 用户可见报错改为稳定错误码（文案由前端按用户语言渲染）。
import { AppError } from "../../common/errors/app-error";
import { ErrorCode } from "../../common/errors/error-codes";

/** DEP-02：upgrade-all canary 缺省百分比（首批台数 = ceil(N×pct%)，至少 1 台）。 */
const ROLLOUT_DEFAULT_PERCENTAGE = 50;
/** DEP-02：canary 首批（pending）心跳确认宽限窗（毫秒）——超窗视为该台失败。 */
const ROLLOUT_HEARTBEAT_WINDOW_MS = 120_000;
/** DEP-02：批次推进轮询间隔（毫秒）——canary pending 心跳窗检查节奏。 */
const ROLLOUT_TICK_MS = 5_000;
/** DEP-02：批次生命周期硬上限（毫秒）——防 pending/probing 死循环挂批次。 */
const ROLLOUT_BATCH_TIMEOUT_MS = 15 * 60_000;

/**
 * ARCH-31：批次活性租约宽限（毫秒）。批次持有实例每个 tick 刷新行上
 * `rolloutMeta.leasedAt`；重启 sweep（onModuleInit）跳过租约仍新鲜的批次，
 * 否则**滚动重启时新起的实例会把另一个实例正在推进的灰度直接标 failed**
 * （DEP-02 的单实例假设在多实例下会主动破坏在途批次）。
 */
const ROLLOUT_LEASE_GRACE_MS = 60_000;

/** ARCH-31：本实例标识（写入租约，便于日志与运维定位批次持有者）。 */
const ROLLOUT_INSTANCE_ID = `${hostname()}:${process.pid}`;

/** DEP-02/DEP-03：单个部署行在批次内的健康探测 + 自动回滚（进程内）。
 *  结构化批次状态（最低正确形态，复用 FEAT-07 dispatcher 的进程内
 *  setTimeout 队列模式）：批次本体在内存，行级状态落 rolloutState/
 *  rolloutMeta；服务重启时 pending/probing 批次标记 failed（不自动恢复）。 */
interface RolloutBatch {
  batchId: string;
  applicationId: string;
  strategy: "canary" | "all";
  percentage: number;
  healthCheck: ReturnType<typeof parseManifestHealthCheck>;
  /** 本轮（canary 首批或 promotion 轮）待确认的部署行 id。 */
  upgradedIds: string[];
  /** 后续待提升的部署行 id（canary 通过后逐台升级）。 */
  promotedIds: string[];
  startedAt: number;
  timer: NodeJS.Timeout | null;
  tickTimer: NodeJS.Timeout | null;
  /**
   * ARCH-31: 已从 DB 痕迹重建的「只读上下文」——本实例不是批次持有者
   * （心跳/回调落到了别的实例）。此类上下文不启定时器、不驱动探测与提升，
   * 只做行级状态推进（probing）与带 claim 的失败终结。
   */
  hydrated?: boolean;
  /** ARCH-31: 该批次中已启动过健康探测的部署行（探测由持有实例单点驱动）。 */
  probedIds?: Set<string>;
}

/** R5: name of the partial unique index created by migration
 *  1789000000000-AddAppDeploymentsInFlightUniqueIndex (applicationId is
 *  unique among rows with status pending/deploying). */
const IN_FLIGHT_UNIQUE_INDEX = "uq_app_deployments_application_in_flight";

/** DEP-01：/releases 分页参数（默认 50，上限 200，防全表拖库）。 */
export const RELEASES_DEFAULT_PAGE_SIZE = 50;
export const RELEASES_MAX_PAGE_SIZE = 200;

/** A-6：/releases 第 1 页 synthetic 聚合的部署行扫描限幅。此前整表 find
 *  （无 take）——部署行随时间无限增长会把第一页 releases 拖成全表读。
 *  分页流式聚合：页大小 1000，总扫描上限 5000 行（与 findAllByApp 的 O-6
 *  读取面 cap 同一口径）；到达上限即停，聚合行以已扫描部分为准。 */
export const RELEASES_SYNTHETIC_SCAN_PAGE_SIZE = 1000;
export const RELEASES_SYNTHETIC_SCAN_MAX_ROWS = 5000;

/**
 * R4（§4.1A）：计入「该版本累计部署次数」的事件类型——deploy 新建行、复用行
 * 重推、叠加升级各是一次真实下发动作。approval_approved **不**计入：审批 gated
 * 应用的 deploy_created 已计一次，审批只是让那次动作真正发生（再计即双计）。
 * stop/remove/stuck_failed 不是部署动作，不参与计数。
 */
const DEPLOY_COUNTED_EVENT_TYPES: string[] = [
  AppDeploymentEventType.DEPLOY_CREATED,
  AppDeploymentEventType.REDEPLOY_REUSED,
  AppDeploymentEventType.UPGRADE,
];

/** R4（§4.1A）：/events 分页参数（默认 50、上限 200，对齐 /releases 口径）。 */
export const DEPLOYMENT_EVENTS_DEFAULT_PAGE_SIZE = 50;
export const DEPLOYMENT_EVENTS_MAX_PAGE_SIZE = 200;

/**
 * stop() 未能把停机信号送达执行器时，写进 statusMessage 的前缀。
 *
 * **跨端契约**：admin-web 按这个前缀判断该用 warning 还是 success 提示
 * （见 AppDeploymentPage 的 handleStop）。改这里必须同步改前端，否则
 * 「已标记停止但未联系上执行器」会退回被当成成功——那正是本次要修的缺陷。
 *
 * 为什么用前缀而不是新增一个响应字段：stop() 的返回体是部署实体（前端各处
 * 复用同一类型），加字段要动 DTO/掩码/类型三处；而 statusMessage 本就是
 * 「这条部署当前状况」的既有通道，且会随列表轮询一起回传给用户。
 */
export const STOP_NOT_DELIVERED_PREFIX = "[Stop not delivered] ";

/**
 * A-2①：部署命令入队 pull 执行器时写入 statusMessage 的前缀（后缀带
 * commandId）。这条 statusMessage 是行上**已有的**命令痕迹——卡死扫描据此
 * 识别「命令仍在 pull 队列未决」的行，把它们扫死阈值从 10min 放宽到命令 TTL：
 * 执行器离线 >10min 时行不再被提前判 FAILED（in-flight 槽位不被释放），旧命令
 * 也就不会在 TTL 内被重连的执行器消费出「同一执行器两个真实进程」。命令 TTL
 * 过后执行器侧本就会按 issuedAt 丢弃载荷，此时再扫死是安全的。
 * 改这里必须同步改 detectStuckDeployments 的豁免判定（跨端同文件契约）。
 */
export const PULL_QUEUED_MESSAGE_PREFIX =
  "Deploy command queued for pull executor";

/** A-2①：detectStuckDeployments 读取的命令 TTL（与 ExecutorPullService
 *  commandTtlMs 同键同缺省——30min。两处读同一 ConfigService 键，调参一处生效）。 */
export const DEPLOYMENT_CMD_TTL_MS_DEFAULT = 1_800_000;
export const EXECUTOR_CMD_TTL_CONFIG_KEY = "executor.cmdTtlMs";

/** DEP-01：统一列表的排序键（毫秒时间戳）：有部署取该版本最近一次部署完成时刻
 *  （deployedAt，缺则行 createdAt），无部署取版本行 createdAt。纯函数便于测试。 */
export function releaseSortTimestampMs(input: {
  deployedAt?: Date | string | null;
  latestDeploymentCreatedAt?: Date | string | null;
  versionCreatedAt?: Date | string | null;
}): number {
  const t =
    input.deployedAt ??
    input.latestDeploymentCreatedAt ??
    input.versionCreatedAt ??
    null;
  if (!t) return 0;
  const ms = new Date(t).getTime();
  return Number.isNaN(ms) ? 0 : ms;
}

/** DEP-04：审批动作人身份（controller 从 @CurrentUser 提取；API-key 主体的
 *  userId 与 JWT 用户 id 同域，名字带前缀便于审计区分）。 */
export interface DeploymentApprovalActor {
  id: number | null;
  name: string | null;
}

/**
 * FEAT-20（迁移 1790000000004）：部署行落库触发来源（triggerType/operator）。
 * controller 各写面把 JWT user.username 传进来（无认证主体——心跳等机器
 * 路径——不落）；operator=操作人用户名，triggerType 按动作语义取
 * DeploymentTriggerType。写入一次后不再被状态迁移覆盖。
 */
export interface DeploymentTriggerContext {
  operator: string | null;
  triggerType: DeploymentTriggerType;
}

@Injectable()
export class AppDeploymentService implements OnModuleDestroy, OnModuleInit {
  private readonly logger = new Logger(AppDeploymentService.name);

  /** DEP-02：进程内活动批次（同一时刻每应用至多一个——复用部署 in-flight
   *  互斥；key=applicationId）。服务重启即清空，重启收尾由 onModuleInit 侧
   *  sweep 把遗留 pending/probing 行标记 failed。 */
  private readonly rolloutBatches = new Map<string, RolloutBatch>();
  /** 优雅关闭：全部 timer 句柄（先例 outbound-event-dispatcher）。 */
  private readonly rolloutTimers = new Set<NodeJS.Timeout>();

  constructor(
    @InjectRepository(AppDeployment)
    private readonly repo: Repository<AppDeployment>,
    @InjectRepository(ApplicationVersion)
    private readonly versionRepo: Repository<ApplicationVersion>,
    private readonly appService: ApplicationService,
    private readonly executorService: ExecutorService,
    private readonly configService: ConfigService,
    // FEAT-07: deployment.completed 出站事件发布（@Global 总线；@Optional 仅为
    // 既有单测装配兼容——provider 缺失 → null → 事件静默不发，先例 task.service）。
    @Optional()
    private readonly eventBus: DomainEventBus | null = null,
    // DEP-04: 审批留痕（@Optional 同上——存量 spec 未提供 AuditService 兼容）。
    @Optional()
    private readonly audit: AuditService | null = null,
    // ARCH-31 §5: 多实例下 @Cron 维护任务仅 cron Leader 执行（@Global 恒提供；
    // @Optional 仅为既有单测装配兼容，先例 eventBus/audit）。
    @Optional()
    private readonly leaderGate: LeaderGateService | null = null,
    // R4（§4.1A）：部署事件写入面（@Optional 同上——存量 spec 未 provide 该
    // token 时 → null → 事件静默不写、读面走 legacy 回退，主动作不受影响；
    // 生产装配恒有：application.module forFeature 已注册）。
    @Optional()
    @InjectRepository(AppDeploymentEvent)
    private readonly deploymentEventRepo: Repository<AppDeploymentEvent> | null = null,
  ) {}

  /** Build auth headers for executor requests. Must resolve through
   *  ExecutorService.getSharedToken (DB-first) — a raw env read would send a
   *  stale credential after DB rotation and be rejected by the executor. */
  private async getExecutorHeaders(): Promise<Record<string, string>> {
    const token = await this.executorService.getSharedToken();
    return token ? { Authorization: `Bearer ${token}` } : {};
  }

  async findAll(
    applicationId?: string,
    page = 1,
    limit = 20,
    approvalStatus?: string,
  ): Promise<{ data: AppDeployment[]; total: number }> {
    const where: import("typeorm").FindOptionsWhere<AppDeployment> = {};
    if (applicationId) where.applicationId = applicationId;
    // DEP-04: 审批待办列表过滤（值域由 controller DTO IsEnum 把关）。
    if (approvalStatus) where.approvalStatus = approvalStatus;
    const [data, total] = await this.repo.findAndCount({
      where,
      order: { createdAt: "DESC" },
      relations: { application: true },
      skip: (page - 1) * limit,
      take: limit,
    });
    return { data: data.map((d) => this.maskDeploymentForRead(d)), total };
  }

  /**
   * 应用列表页的部署统计（每应用一行，DB 侧 GROUP BY 聚合）。
   *
   * 为什么需要它：应用列表页此前对**每个应用各发一个** `GET /app-deployments`
   * 来现算「运行 X/Y 台」——26 个应用 = 26 个请求，而全局限流按「路由 handler +
   * IP」计桶（ThrottlerGuard 默认 generateKey = 类名-方法名-IP），这 26 个请求
   * 共享同一个 60/min 预算：进页面 + 返回页面 + 部署后自动刷新，三次就把桶打满，
   * 之后整页部署列全 429（生产实证 2026-10-13，详见 docs）。
   *
   * 语义与前端原「拉全量再 filter」逐项对齐（口径不能漂——列表页那列是
   * 「我的应用在跑吗」的答案）：
   *  - `total`  = 该应用全部部署行数（含 stopped/failed，即原分母）；
   *  - `running` = status='running' 行数；
   *  - `failed`  = status='failed' 行数；
   *  - `lastDeployedAt` = MAX(COALESCE(deployedAt, createdAt))，即最近一次部署
   *    活动时间（deployedAt 未回填的行回落 createdAt，与原实现同口径）。
   *    注：原实现取「createdAt 最新那一行的 deployedAt ?? createdAt」，本实现取
   *    全行最大值——两者仅在「更早创建的行反而更晚完成部署」时分叉，此时
   *    MAX 给出的才是真正的"最后部署时间"（原值会偏早）。
   *
   * 只返回**至少有一条部署行**的应用；无部署的应用不出现在结果里，由调用方
   * 按 0 处理（避免为 26 个应用里的空应用各造一行）。
   */
  async findStats(): Promise<AppDeploymentStatsDto[]> {
    const rows: Array<Record<string, unknown>> = await this.repo
      .createQueryBuilder("d")
      .select("d.applicationId", "applicationId")
      .addSelect("COUNT(*)", "total")
      .addSelect(
        "SUM(CASE WHEN d.status = :running THEN 1 ELSE 0 END)",
        "running",
      )
      .addSelect(
        "SUM(CASE WHEN d.status = :failed THEN 1 ELSE 0 END)",
        "failed",
      )
      // COALESCE 而非裸 MAX(deployedAt)：pending/deploying 行 deployedAt 仍为
      // NULL，裸 MAX 会让「刚创建、还没部署完」的应用显示成"从未部署"。
      .addSelect("MAX(COALESCE(d.deployedAt, d.createdAt))", "lastDeployedAt")
      .setParameters({
        running: DeploymentStatus.RUNNING,
        failed: DeploymentStatus.FAILED,
      })
      .groupBy("d.applicationId")
      .getRawMany();

    return rows.map((row) => {
      // COUNT/SUM 在 pg 驱动下回来的是 bigint 字符串（metrics.service 同款
      // parseInt 收口），直接透传会让前端拿到 "33" 这种字符串做算术。
      const num = (v: unknown): number => {
        const n = Number(v);
        return Number.isFinite(n) ? n : 0;
      };
      const raw = row.lastDeployedAt;
      // MAX 的时间列可能是 Date（pg 驱动）或字符串（部分驱动/测试替身），
      // 统一成 ISO 串——响应契约里是 string|null，前端 formatDateTime 直接吃。
      const lastDeployedAt =
        raw instanceof Date
          ? raw.toISOString()
          : typeof raw === "string" && raw
            ? new Date(raw).toISOString()
            : null;
      return {
        applicationId: String(row.applicationId),
        total: num(row.total),
        running: num(row.running),
        failed: num(row.failed),
        lastDeployedAt,
      };
    });
  }

  /** Internal: get all deployment records for an app without pagination */
  async findAllByApp(applicationId: string): Promise<AppDeployment[]> {
    return this.repo.find({
      where: { applicationId },
      order: { createdAt: "DESC" },
      relations: { application: true },
      // O-6: safety cap — a single app should never legitimately have thousands
      // of deployment rows; bounds memory on internal list consumers.
      take: 5000,
    });
  }

  /**
   * R4（§4.1A）：应用的部署事件流读面（GET /app-deployments/applications/
   * :appId/events）——不可变动作追溯，分页默认 50、上限 200（对齐 /releases）。
   * 裸四键信封 {data,total,page,pageSize}。事件行只含短事实（写入侧已保证
   * detail 不带 env），无需掩码。
   *
   * 过滤参数（上轮遗留：事件量极大时深翻页代价高——把结果集缩到调用方关心
   * 的切片再分页，深 OFFSET 不再作用于全量）：
   *   · eventType 直等——完整命中 idx_app_deployment_events_application_type
   *     的 (applicationId, eventType) 前缀；
   *   · since/until 为**半开区间 [since, until)**：since 含头（createdAt >=
   *     since）、until 不含尾（createdAt < until）。两侧同为闭区间的「按天
   *     滚窗」会让边界时刻的事件在相邻两窗各出现一次；同为开区间则会漏。
   *     时间列过滤叠加在 idx_app_deployment_events_application_created
   *     (applicationId, createdAt) 上。
   */
  async getEventsByApp(
    applicationId: string,
    page = 1,
    pageSize = DEPLOYMENT_EVENTS_DEFAULT_PAGE_SIZE,
    filters?: {
      eventType?: AppDeploymentEventType;
      since?: string;
      until?: string;
    },
  ): Promise<{
    data: AppDeploymentEvent[];
    total: number;
    page: number;
    pageSize: number;
  }> {
    // fail-honest：生产装配恒有该 repo（application.module forFeature）；
    // 缺席是装配错误——静默回空页会把「没接线」伪装成「无事件」。
    if (!this.deploymentEventRepo) {
      // LANG-ZH-01：装配错误是面向运维的报错文案——中文（技术标识
      // AppDeploymentEvent/TypeOrmModule.forFeature 保留原文）。
      throw new Error(
        "AppDeploymentEvent 仓储未接线（应为 application.module 的 " +
          "TypeOrmModule.forFeature 注册；缺席属装配错误，静默回空页会把「没接线」" +
          "伪装成「无事件」，fail-honest 直接抛出）",
      );
    }
    const safePageSize = Math.min(
      Math.max(
        1,
        Math.trunc(Number(pageSize)) || DEPLOYMENT_EVENTS_DEFAULT_PAGE_SIZE,
      ),
      DEPLOYMENT_EVENTS_MAX_PAGE_SIZE,
    );
    const safePage = Math.max(1, Math.trunc(Number(page)) || 1);
    // 过滤键只在「有值」时进 where：缺省（不带参数）走与此前逐字节相同的
    // where: { applicationId }——加性变更，既有调用方行为不变。
    const where: FindOptionsWhere<AppDeploymentEvent> = { applicationId };
    if (filters?.eventType) {
      where.eventType = filters.eventType;
    }
    // since/until 解析成 Date 一次：非法串在 DTO 层已被 @IsISO8601 拦下，
    // 这里的新 Date(since) 对已验证的 ISO 串是确定性的；即便绕过 DTO 直调
    // service（内部调用方），Invalid Date 会让 TypeORM 查询抛错——fail-fast
    // 优于静默忽略。
    if (filters?.since && filters.until) {
      where.createdAt = And(
        MoreThanOrEqual(new Date(filters.since)),
        LessThan(new Date(filters.until)),
      );
    } else if (filters?.since) {
      where.createdAt = MoreThanOrEqual(new Date(filters.since));
    } else if (filters?.until) {
      where.createdAt = LessThan(new Date(filters.until));
    }
    const [data, total] = await this.deploymentEventRepo.findAndCount({
      where,
      // id 兜底排序：同秒多事件（如批量扫死）下保证翻页顺序稳定。
      order: { createdAt: "DESC", id: "DESC" },
      skip: (safePage - 1) * safePageSize,
      take: safePageSize,
    });
    return { data, total, page: safePage, pageSize: safePageSize };
  }

  /** Internal: raw lookup (unmasked env) for deploy/upgrade send paths —
   *  masking is a read-surface concern and must never leak into what gets
   *  pushed to the executor (round-7 lesson: masking must not reach the
   *  send path). */
  async findByIdRaw(id: string): Promise<AppDeployment> {
    const d = await this.repo.findOne({
      where: { id },
      relations: { application: true },
    });
    if (!d)
      throw new AppError(ErrorCode.APP_DEPLOYMENT_NOT_FOUND, {
        deploymentId: id,
      });
    return d;
  }

  /** E-P1-R2：用户动作（stop/upgrade/回滚）read-modify-write save 的乐观锁收口。
   *  @VersionColumn 让 save 自动追加 AND version = :expected；并发后写撞版本时
   *  TypeORM 抛 OptimisticLockVersionMismatchError，这里转 409 让客户端重载重试。
   *  背景 trace / 心跳写不经过这里（心跳走条件 UPDATE，trace 自带 fail-open）。 */
  private async saveWithOptimisticLock(
    deployment: AppDeployment,
  ): Promise<AppDeployment> {
    try {
      return await this.repo.save(deployment);
    } catch (err: unknown) {
      if (
        err instanceof OptimisticLockVersionMismatchError ||
        (err instanceof Error &&
          err.name === "OptimisticLockVersionMismatchError")
      ) {
        throw new AppError(ErrorCode.APP_DEPLOYMENT_CONCURRENT_MODIFICATION, {
          deploymentId: deployment.id,
        });
      }
      throw err;
    }
  }

  async findById(id: string): Promise<AppDeployment> {
    const d = await this.repo.findOne({
      where: { id },
      relations: { application: true },
    });
    if (!d)
      throw new AppError(ErrorCode.APP_DEPLOYMENT_NOT_FOUND, {
        deploymentId: id,
      });
    return this.maskDeploymentForRead(d);
  }

  /** QA1: deployment rows carry their own env snapshot plus the parent
   *  application relation — both hold the same raw secrets the application
   *  read surface masks. Mask every env occurrence (row env, nested
   *  application env) so a sibling GET cannot bypass application masking. */
  private maskDeploymentForRead(d: AppDeployment): AppDeployment {
    const masked: AppDeployment = {
      ...d,
      env: (this.appService.maskEnvForRead(d.env) ?? d.env) as Record<
        string,
        string
      > | null,
    };
    if (masked.application) {
      masked.application = this.appService.maskReadSurface(masked.application);
    }
    return masked;
  }

  /**
   * Find all RUNNING deployments for a given application.
   * Used by webhook to trigger rolling upgrades.
   */
  async findRunningByApp(applicationId: string): Promise<AppDeployment[]> {
    return this.repo.find({
      where: { applicationId, status: DeploymentStatus.RUNNING },
      order: { createdAt: "DESC" },
    });
  }

  async getVersionHistory(applicationId: string) {
    const versions = await this.versionRepo.find({
      where: { applicationId },
      order: { createdAt: "DESC" },
    });
    const legacyVersions =
      await this.getDeploymentVersionFallback(applicationId);

    if (versions.length === 0) {
      return legacyVersions;
    }

    const deployCount = await this.buildDeployCountMap(applicationId);
    const snapshotKeys = new Set(versions.map((v) => v.version));
    const snapshotHistory = versions.map((v) => ({
      id: v.id,
      deploymentId: v.sourceDeploymentId,
      sourceDeploymentId: v.sourceDeploymentId,
      version: v.version,
      commit: v.gitCommit,
      status: v.status,
      deployedAt: v.createdAt,
      createdAt: v.createdAt,
      executorAddress: null,
      deployCount: deployCount.get(v.version) ?? 1,
      // QA1: buildSnapshot stores the raw application env — mask the env
      // key (shallow clone) so the version read surface cannot serve the
      // secrets the application surface hides.
      snapshot: this.maskSnapshotForRead(v.snapshot),
    }));

    return [
      ...snapshotHistory,
      ...legacyVersions.filter((v) => !snapshotKeys.has(v.version)),
    ].sort((a, b) => {
      const at = a.createdAt ?? a.deployedAt;
      const bt = b.createdAt ?? b.deployedAt;
      return (
        (bt ? new Date(bt).getTime() : 0) - (at ? new Date(at).getTime() : 0)
      );
    });
  }

  // -----------------------------------------------------------------------
  // DEP-01: /applications/:id/releases —— 版本 × 部署统一只读追溯视图
  // -----------------------------------------------------------------------

  /**
   * 合并 application_versions（版本号/包地址/操作人列）与 app_deployments
   * （部署时间/状态/所在执行器）两个语义面：**一行 = 一个版本发布**，聚合出
   * 「这次部署用了哪个包」的一屏追溯。零 schema 变更，纯读视图；旧端点
   * GET /applications/:id/versions 与 GET /app-deployments 原样保留为过渡期
   * alias（/versions 面向快照/回滚消费且携带 deployCount 合成行，本端点面向
   * 部署追溯，两者数据同源）。
   *
   * 行来源：
   *  - 版本行（application_versions，分页主体）：packageUrl 取快照内当次部署
   *    值（历史语义，不回退应用当前 packageUrl）；deploymentStatus/deployedAt
   *    取该版本 deployedVersion 匹配的**最近一次**部署（createdAt DESC 首行，
   *    同版本多实例/多次部署各计入 deploymentCount）；**无部署的版本行也出现**
   *    （部署字段为 null）。
   *  - 合成行（synthetic=true）：有部署记录但从未保存版本快照（心跳竞态等历史
   *    数据），按 deployedVersion 聚合出最近一次部署一行，对齐 /versions 的
   *    legacy fallback 语义。仅两表皆空的应用整表为空（应用刚创建未部署，
   *    无追溯对象——不回退应用当前 packageUrl 造一行，理由同上）。
   *  - synthetic 行只参与第 1 页（聚合行天然很少，不额外分页）。
   *
   * 已知来源缺失（详见 docs/api-reference.md）：
   *  - operator：FEAT-20（迁移 1790000000004）起取最近一次部署行 operator
   *    持久化列；存量行回退 application_versions.createdBy（历史恒 null），
   *    仍无值时行上带 operatorMissingReason 标注；
   *  - triggerType：FEAT-20 起部署行持久化列优先（manual/upgrade/rollback/
   *    approval），存量行（列为 null）回退持久化信号推导（classifyRelease
   *    Trigger），无法判定时 unknown。
   */
  async getReleases(
    applicationId: string,
    page = 1,
    pageSize = RELEASES_DEFAULT_PAGE_SIZE,
  ): Promise<{
    data: AppReleaseRow[];
    total: number;
    page: number;
    pageSize: number;
    /** R4（§4.7）：synthetic 扫描到达 RELEASES_SYNTHETIC_SCAN_MAX_ROWS 上限
     *  （聚合以已扫描部分为准）时 true——去静默截断。只增不改的响应字段。 */
    truncated: boolean;
    /** P8-R（部署模型评审遗留）：truncated=true 吞掉被截版本的 devices 徽标时，
     *  列出「有设备保留（currentVersion 命中或 ∈ retainedVersions）但不在
     *  本页返回行中」的版本号——「设备还留着这版」的事实不因分页截断而消失。
     *  恒为数组和 truncated=false 时空数组；版本号按本页版本行同序（createdAt
     *  DESC）回退字母序。只增不改的响应字段。 */
    retainedButTruncated: string[];
  }> {
    const safePageSize = Math.min(
      Math.max(1, Math.trunc(Number(pageSize)) || RELEASES_DEFAULT_PAGE_SIZE),
      RELEASES_MAX_PAGE_SIZE,
    );
    const safePage = Math.max(1, Math.trunc(Number(page)) || 1);
    // R4（§4.7）：synthetic 扫描只在第 1 页跑——第 2+ 页无扫描即无截断，false。
    let truncated = false;

    const [versions, total] = await this.versionRepo.findAndCount({
      where: { applicationId },
      order: { createdAt: "DESC", id: "DESC" },
      skip: (safePage - 1) * safePageSize,
      take: safePageSize,
    });

    // 一次取回本分页版本关联的全部部署行（createdAt DESC → 每版本首见即最新）。
    // 行数受该应用部署总量约束，与既有 buildDeployCountMap/findAllByApp 同一
    // 读取面量级；聚合在内存完成（count + 最新行 + 触发方式推导）。
    const versionStrings = versions.map((v) => v.version);
    const deploymentsForVersions = versionStrings.length
      ? await this.repo.find({
          where: { applicationId, deployedVersion: In(versionStrings) },
          order: { createdAt: "DESC" },
        })
      : [];
    const latestByDeployment = new Map<string, AppDeployment>();
    const deployCountByDeployment = new Map<string, number>();
    for (const d of deploymentsForVersions) {
      if (!d.deployedVersion) continue;
      if (!latestByDeployment.has(d.deployedVersion)) {
        latestByDeployment.set(d.deployedVersion, d);
      }
      deployCountByDeployment.set(
        d.deployedVersion,
        (deployCountByDeployment.get(d.deployedVersion) ?? 0) + 1,
      );
    }

    // 版本行的触发方式来自其 source 部署行（快照诞生时那次 push 的载体）。
    const sourceIds = [
      ...new Set(
        versions
          .map((v) => v.sourceDeploymentId)
          .filter((x): x is string => Boolean(x)),
      ),
    ];
    const sourceDeployments = sourceIds.length
      ? await this.repo.find({ where: { id: In(sourceIds) } })
      : [];
    const sourceById = new Map(sourceDeployments.map((d) => [d.id, d]));

    // R3-A（§4.3）：设备级版本事实（心跳上报，executor_app_versions）——
    // 每版本行聚合 devices 徽标（正在运行/本地保留该版本的设备）。一次取全
    // 应用事实、行内内存匹配；无任何设备上报（旧执行器混合窗口期）时为
    // 空数组，行上 devices 恒存在（只增不改），部署行推断字段原样保留。
    const deviceFacts =
      await this.executorService.getAppVersionFacts(applicationId);

    const data: AppReleaseRow[] = versions.map((v) => {
      const latest = latestByDeployment.get(v.version) ?? null;
      const snapshot =
        v.snapshot && typeof v.snapshot === "object"
          ? (v.snapshot as Record<string, any>)
          : {};
      const packageUrl =
        typeof snapshot.packageUrl === "string" && snapshot.packageUrl
          ? snapshot.packageUrl
          : null;
      const triggerSource =
        latest ?? sourceById.get(v.sourceDeploymentId ?? "");
      const deployedAt = latest?.deployedAt ?? latest?.createdAt ?? null;
      // FEAT-20: operator 取最近一次部署行持久化列（JWT 用户名）；
      // 存量行回退版本快照 createdBy（历史恒 null）。来源随命中面标注。
      const operator = latest?.operator ?? v.createdBy ?? null;
      return {
        id: v.id,
        version: v.version,
        packageUrl,
        gitCommit: v.gitCommit ?? null,
        deployedAt: deployedAt ? new Date(deployedAt).toISOString() : null,
        latestDeploymentId: latest?.id ?? null,
        deploymentStatus: latest?.status ?? null,
        deploymentCount: deployCountByDeployment.get(v.version) ?? 0,
        executorAddress: latest?.executorAddress ?? null,
        runMode: latest?.runMode ?? null,
        triggerType: this.resolveReleaseTrigger(triggerSource),
        operator,
        operatorSource: latest?.operator
          ? "deployments.operator"
          : "application_versions.createdBy",
        operatorMissingReason: operator ? "" : RELEASE_OPERATOR_MISSING_REASON,
        sourceDeploymentId: v.sourceDeploymentId ?? null,
        status: v.status,
        createdAt: v.createdAt ? new Date(v.createdAt).toISOString() : null,
        synthetic: false,
        devices: this.buildReleaseDevices(v.version, deviceFacts),
      };
    });

    // synthetic 聚合行（仅第 1 页）：优先覆盖无快照行的应用（整表回退，与
    // /versions 的 legacy fallback 同语义），否则补「有部署但版本不在快照表」
    // 的孤儿 deployedVersion。
    if (safePage === 1) {
      // A-6: 整表 find 改为分页流式聚合——createdAt DESC 保证「每版本首见
      // 即最新行」在流式累计下不变（后续页只给已有 key 加计数/补新 key），
      // 响应形状与语义完全不变；页大小与总行数双限幅防全表拖库。
      const seen = new Map<string, { latest: AppDeployment; count: number }>();
      for (
        let skip = 0;
        skip < RELEASES_SYNTHETIC_SCAN_MAX_ROWS;
        skip += RELEASES_SYNTHETIC_SCAN_PAGE_SIZE
      ) {
        const rows = await this.repo.find({
          where: { applicationId },
          order: { createdAt: "DESC" },
          skip,
          take: RELEASES_SYNTHETIC_SCAN_PAGE_SIZE,
        });
        for (const d of rows) {
          const key = d.deployedVersion ?? "__unknown__";
          const cur = seen.get(key);
          if (cur) cur.count += 1;
          else seen.set(key, { latest: d, count: 1 });
        }
        if (rows.length < RELEASES_SYNTHETIC_SCAN_PAGE_SIZE) break;
        // R4（§4.7）：本页扫满且已到总扫描上限——此前这里静默截断（§P8），
        // 现在显式上报 truncated=true（响应字段只增）。
        if (
          skip + RELEASES_SYNTHETIC_SCAN_PAGE_SIZE >=
          RELEASES_SYNTHETIC_SCAN_MAX_ROWS
        ) {
          truncated = true;
        }
      }
      const snapshotVersions = new Set(
        versions.length === 0
          ? [] // 整表回退分支：无快照行可比对，全部部署聚合都出 synthetic 行
          : (
              await this.versionRepo.find({
                where: { applicationId },
                select: { version: true } as never,
              })
            ).map((v) => v.version),
      );
      for (const [key, { latest, count }] of seen) {
        if (versions.length > 0) {
          if (key === "__unknown__") continue;
          if (snapshotVersions.has(key)) continue;
        }
        const deployedAt = latest.deployedAt ?? latest.createdAt ?? null;
        data.push({
          id: null,
          version: key === "__unknown__" ? null : key,
          packageUrl: null,
          gitCommit: latest.deployedCommit ?? null,
          deployedAt: deployedAt ? new Date(deployedAt).toISOString() : null,
          latestDeploymentId: latest.id,
          deploymentStatus: latest.status,
          deploymentCount: count,
          executorAddress: latest.executorAddress ?? null,
          runMode: latest.runMode ?? null,
          triggerType: this.resolveReleaseTrigger(latest),
          operator: latest.operator ?? null,
          operatorSource: latest.operator
            ? "deployments.operator"
            : "application_versions.createdBy",
          operatorMissingReason: latest.operator
            ? ""
            : RELEASE_OPERATOR_MISSING_REASON,
          sourceDeploymentId: latest.id,
          status: latest.status,
          createdAt: deployedAt ? new Date(deployedAt).toISOString() : null,
          synthetic: true,
          // R3-A：synthetic 行同享设备徽标（key 是真实版本串时；__unknown__
          // 无版本可比对 → devices 恒空）。
          devices: this.buildReleaseDevices(
            key === "__unknown__" ? null : key,
            deviceFacts,
          ),
        });
      }
    }

    // 统一视图时间序：最近部署在前，无部署的版本行按快照时刻落位。
    data.sort(
      (a, b) =>
        releaseSortTimestampMs({
          deployedAt: b.deployedAt,
          versionCreatedAt: b.createdAt,
        }) -
        releaseSortTimestampMs({
          deployedAt: a.deployedAt,
          versionCreatedAt: a.createdAt,
        }),
    );

    return {
      data,
      total,
      page: safePage,
      pageSize: safePageSize,
      truncated,
      // P8-R：truncated=true 时被截版本的 devices 徽标整行不可见——用同一份
      // 全应用设备事实（getAppVersionFacts 本就与页无关地全量拉回）求差集，
      // 把「有设备保留但不在本页行中」的版本号显式带回，零额外查询。
      retainedButTruncated: truncated
        ? this.buildRetainedButTruncated(data, deviceFacts)
        : [],
    };
  }

  /**
   * R3-A（§4.3）：版本行的设备徽标聚合——只列「currentVersion === 该版本
   * （正在运行）或 该版本 ∈ retainedVersions（本地保留）」的设备。
   *
   * `retained` 如实表达「本行版本 ∈ 设备 retainedVersions」（设备磁盘上仍
   * 持有该版本，可本地切回）；「运行中/保留」的展示区分由消费方按
   * `currentVersion === 行版本` 判定（设备 current 正指向该版本时通常
   * 同时 retained=true，两者不互斥）。
   */
  private buildReleaseDevices(
    version: string | null,
    facts: Awaited<ReturnType<ExecutorService["getAppVersionFacts"]>>,
  ): AppReleaseDevice[] {
    if (!version) return [];
    return facts
      .filter(
        (f) =>
          f.currentVersion === version || f.retainedVersions.includes(version),
      )
      .map((f) => ({
        executorId: f.executorId,
        executorName: f.executorName,
        currentVersion: f.currentVersion,
        retained: f.retainedVersions.includes(version),
        online: f.online,
        lastHeartbeat: f.lastHeartbeat,
      }));
  }

  /**
   * P8-R（部署模型评审遗留）：「有设备保留但被 truncated 吞掉」的版本号差集。
   *  口径与 buildReleaseDevices 完全一致：currentVersion 命中或 ∈ retainedVersions
   *  即「设备还留着这版」；与本页已返回行的版本集合（含 synthetic 行）求差，
   *  剩下的就是只在被截部分出现的事实版本号。纯内存计算（facts 本就全量在
   *  手），字母序排序保证响应确定性。
   */
  private buildRetainedButTruncated(
    rows: AppReleaseRow[],
    facts: Awaited<ReturnType<ExecutorService["getAppVersionFacts"]>>,
  ): string[] {
    const present = new Set<string>();
    for (const r of rows) {
      if (r.version) present.add(r.version);
    }
    const missing = new Set<string>();
    for (const f of facts) {
      if (f.currentVersion && !present.has(f.currentVersion)) {
        missing.add(f.currentVersion);
      }
      for (const v of f.retainedVersions) {
        if (!present.has(v)) missing.add(v);
      }
    }
    return [...missing].sort();
  }

  /** DEP-01：从部署行的持久化信号推导触发方式（无 trigger 列，零 schema 变更）。
   *  规则（按优先级）：
   *   1. statusMessage 含升级指纹（"Upgrade triggered"/"Pulling latest
   *      commit…"，upgrade() 与升级 push 路径写入）→ upgrade；
   *   2. deployedAt 已置位（pushDeployToExecutor 成功分支写入；upgrade() 复用
   *      既有行也会置位，故已被规则 1 的指纹先行拦截）→ manual；
   *   3. 其余（PENDING 未推送/失败超时/system 文案/竞态后心跳覆盖）→ unknown。
   *  已知限制：行复用升级且 push 成功后 statusMessage 被覆盖为部署文案、指纹
   *  丢失时可能误判 manual —— FEAT-20（迁移 1790000000004）起部署行落
   *  triggerType 持久化列，本推导仅作存量行（列为 null）的回退。 */
  private classifyReleaseTrigger(
    deployment: AppDeployment | null | undefined,
  ): ReleaseTriggerType | null {
    if (!deployment) return null;
    const msg = deployment.statusMessage ?? "";
    if (
      msg.startsWith("Upgrade triggered") ||
      msg.startsWith("Pulling latest commit")
    ) {
      return "upgrade";
    }
    if (deployment.deployedAt) return "manual";
    return "unknown";
  }

  /** FEAT-20：release 行触发方式解析——部署行 triggerType 持久化列优先
   *  （manual/upgrade/rollback/approval 直读），存量行（null）回退既有
   *  classifyReleaseTrigger 信号推导。 */
  private resolveReleaseTrigger(
    deployment: AppDeployment | null | undefined,
  ): ReleaseTriggerType | null {
    if (!deployment) return null;
    if (deployment.triggerType) {
      return deployment.triggerType as ReleaseTriggerType;
    }
    return this.classifyReleaseTrigger(deployment);
  }

  /**
   * 版本快照 → 应用字段恢复映射（rollbackApplication 与版本定向灰度共用）。
   * 恒返回至少含 version/runtime 两键的对象（调用方直接 update）。
   */
  private buildVersionRestoreDto(
    app: { runtime: string },
    version: {
      version: string;
      gitCommit?: string | null;
      snapshot?: Record<string, any> | null;
    },
  ): Record<string, any> | null {
    const snapshot = version.snapshot ?? {};
    const updateDto: Record<string, any> = {
      version: version.version,
      runtime: app.runtime,
    };
    if (typeof version.gitCommit === "string")
      updateDto.gitCommit = version.gitCommit;
    if (typeof snapshot.gitBranch === "string")
      updateDto.gitBranch = snapshot.gitBranch;
    if (typeof snapshot.packageUrl === "string")
      updateDto.packageUrl = snapshot.packageUrl;
    if (typeof snapshot.runtime === "string")
      updateDto.runtime = snapshot.runtime;
    if (snapshot.env && typeof snapshot.env === "object")
      updateDto.env = snapshot.env as Record<string, string>;
    if (typeof snapshot.entrypoint === "string")
      updateDto.entrypoint = snapshot.entrypoint;
    if (snapshot.manifest && typeof snapshot.manifest === "object")
      updateDto.manifest = snapshot.manifest as Record<string, any>;
    return updateDto;
  }

  /**
   * R1（2026-10-24 部署模型评审 §4.2）：rollbackApplication 快照路径的三重守卫
   * 抽段——setCurrentVersion / deployVersion 与 rollbackApplication 共用同一份
   * 校验与错误码（属本应用 → 有版本号 → released），三个写面口径永不漂移。
   */
  private assertVersionRestorable(
    appId: string,
    version: {
      applicationId: string;
      version: string | null;
      status: string | null;
    },
  ): void {
    if (version.applicationId !== appId) {
      throw new AppError(ErrorCode.APP_ROLLBACK_VERSION_OTHER_APP);
    }
    if (!version.version) {
      throw new AppError(ErrorCode.APP_ROLLBACK_VERSION_NO_NUMBER);
    }
    if (version.status !== "released") {
      throw new AppError(ErrorCode.APP_ROLLBACK_VERSION_NOT_RELEASED);
    }
  }

  async rollbackApplication(
    appId: string,
    targetId: string,
    trigger?: DeploymentTriggerContext,
    // P0-1（2026-10-25 审计）：版本恢复链要写 applications 表——actor 透传给
    // ApplicationService.update 的属主守卫（NF-03）。HTTP 面恒有 @CurrentUser
    //（@Roles(ADMIN)）；缺省 undefined 只存在于直调 service 的存量单测。
    actor?: { id: number; role: UserRole } | null,
  ) {
    // R1: deployment-mutating paths must read the raw env (the snapshot
    // carries the env that gets written back); bypass the read-surface
    // masking applied by appService.findById.
    const app = await this.appService.findByIdRaw(appId);
    const version = await this.versionRepo.findOne({ where: { id: targetId } });
    if (version) {
      this.assertVersionRestorable(appId, version);

      const updatedApp = await this.appService.update(
        appId,
        this.buildVersionRestoreDto(app, version)!,
        actor,
      );
      const result = await this.upgradeRunningDeployments(
        appId,
        trigger ?? {
          operator: null,
          triggerType: DeploymentTriggerType.ROLLBACK,
        },
      );
      return {
        ...result,
        rolledBackTo: version.version,
        versionId: version.id,
        updatedApp,
      };
    }

    const deployments = await this.findAllByApp(appId);
    const target = deployments.find((d) => d.id === targetId);
    if (!target) {
      throw new AppError(ErrorCode.APP_ROLLBACK_DEPLOYMENT_OTHER_APP);
    }
    if (!target.deployedVersion) {
      throw new AppError(ErrorCode.APP_ROLLBACK_DEPLOYMENT_NO_VERSION);
    }

    const updateDto: Record<string, any> = { version: target.deployedVersion };
    if (typeof target.deployedCommit === "string")
      updateDto.gitCommit = target.deployedCommit;
    // R16: legacy deployments predate version snapshots and carry no
    // packageUrl column of their own; the only related value is the parent
    // application's CURRENT packageUrl, which is not a historical artifact —
    // "restoring" it would be a no-op dressed up as a rollback. So the
    // legacy path restores version/commit only and explicitly declines the
    // packageUrl restore (exposed as packageUrlRestored=false in the
    // response below). Rollbacks that must pin a package file should target
    // a version snapshot (which stores packageUrl in its snapshot payload).
    const updatedApp = await this.appService.update(appId, updateDto, actor);
    const result = await this.upgradeRunningDeployments(
      appId,
      trigger ?? {
        operator: null,
        triggerType: DeploymentTriggerType.ROLLBACK,
      },
    );
    return {
      ...result,
      rolledBackTo: target.deployedVersion,
      versionId: null,
      // R16: explicit marker — legacy rollback cannot restore packageUrl.
      packageUrlRestored: false,
      updatedApp,
    };
  }

  /**
   * R1（2026-10-24 部署模型评审 §4.2）：「设为当前版本」——只按版本快照恢复
   * 应用当前字段（与 rollbackApplication 前半段同一映射/校验/错误码），**绝不
   * 触碰部署行/设备**。旧 rollback 把「恢复字段」与「全量下发」捆绑成一个动作，
   * 用户只想改回记录面时也被迫重启全部实例；本端点是拆出的安全半边。
   */
  async setCurrentVersion(
    appId: string,
    versionId: string,
    // P0-1：同 rollbackApplication——actor 透传属主守卫（NF-03），ADMIN 可改
    // 自己/有权限项目的应用，与手动 update 同语义。
    actor?: { id: number; role: UserRole } | null,
  ) {
    // R1: 与 rollbackApplication 同源——快照恢复写回的 env 必须是原始值，
    // 绕过 appService.findById 的读面掩码。
    const app = await this.appService.findByIdRaw(appId);
    const version = await this.versionRepo.findOne({
      where: { id: versionId },
    });
    if (!version) {
      // 旧 rollback 对查无版本走 legacy 部署行回退；本端点只收 versionId
      // （版本快照主键），查无即 404，不再隐式落到部署行语义。
      throw new AppError(ErrorCode.APP_VERSION_NOT_FOUND, { versionId });
    }
    this.assertVersionRestorable(appId, version);

    const updatedApp = await this.appService.update(
      appId,
      this.buildVersionRestoreDto(app, version)!,
      actor,
    );
    return {
      ok: true,
      dispatched: false,
      version: version.version,
      versionId: version.id,
      updatedApp,
    };
  }

  /**
   * R1（2026-10-24 部署模型评审 §4.2）：「下发到设备」——先执行与
   * setCurrentVersion 完全相同的字段恢复，再下发：
   *   · executorIds 缺省 = 该应用全部 RUNNING 部署行（与旧 rollback 行为一致）；
   *   · 显式 executorIds = 仅对这些执行器对应的 RUNNING 部署行逐台走既有
   *     upgrade 链；无部署行/行状态不可下发的执行器不抛错，进 skipped 明细。
   */
  async deployVersion(
    appId: string,
    versionId: string,
    executorIds?: string[],
    trigger?: DeploymentTriggerContext,
    // P0-1：同 setCurrentVersion——字段恢复写 applications 表经属主守卫。
    actor?: { id: number; role: UserRole } | null,
  ) {
    const app = await this.appService.findByIdRaw(appId);
    const version = await this.versionRepo.findOne({
      where: { id: versionId },
    });
    if (!version) {
      throw new AppError(ErrorCode.APP_VERSION_NOT_FOUND, { versionId });
    }
    this.assertVersionRestorable(appId, version);

    const updatedApp = await this.appService.update(
      appId,
      this.buildVersionRestoreDto(app, version)!,
      actor,
    );
    // 沿用旧 rollback 的触发痕迹语义（本端点即其拆出的下发半边）。
    const effectiveTrigger = trigger ?? {
      operator: null,
      triggerType: DeploymentTriggerType.ROLLBACK,
    };

    const upgraded: Array<{
      deploymentId: string;
      executorId: string | null;
      executorAddress: string | null;
    }> = [];
    const skipped: Array<{
      executorId: string | null;
      deploymentId: string | null;
      reason: string;
      detail?: string;
    }> = [];

    if (!executorIds || executorIds.length === 0) {
      // 缺省 = 旧 rollback 语义：全部 RUNNING 行逐台 upgrade（allSettled 容错）。
      const running = await this.findRunningByApp(appId);
      await this.collectVersionDispatch(running, effectiveTrigger, {
        upgraded,
        skipped,
      });
    } else {
      // 显式点名：按执行器分组核对部署行，无行/不可下发的进 skipped 而非报错。
      const rows = await this.findAllByApp(appId);
      const seen = new Set<string>();
      for (const executorId of executorIds) {
        if (seen.has(executorId)) continue; // 重复 id 幂等去重
        seen.add(executorId);
        const matching = rows.filter((d) => d.executorId === executorId);
        if (matching.length === 0) {
          skipped.push({
            executorId,
            deploymentId: null,
            reason: "no_deployment",
          });
          continue;
        }
        const runnable = matching.filter(
          (d) => d.status === DeploymentStatus.RUNNING,
        );
        if (runnable.length === 0) {
          // findAllByApp 按 createdAt DESC——用最新一行说明不可下发的原因。
          const latest = matching[0];
          skipped.push({
            executorId,
            deploymentId: latest.id,
            reason: "not_running",
            detail: `status=${latest.status}`,
          });
          continue;
        }
        await this.collectVersionDispatch(runnable, effectiveTrigger, {
          upgraded,
          skipped,
        });
      }
    }

    return {
      ok: true,
      dispatched: true,
      version: version.version,
      versionId: version.id,
      upgraded,
      skipped,
      updatedApp,
    };
  }

  /** deployVersion 的逐台下发收集器：fulfilled → upgraded；rejected → skipped
   *  （reason=upgrade_rejected，detail 带原始 message）。缺省/显式两路径共用，
   *  保证两路径的 upgrade 链语义逐字节一致。 */
  private async collectVersionDispatch(
    rows: AppDeployment[],
    trigger: DeploymentTriggerContext,
    out: {
      upgraded: Array<{
        deploymentId: string;
        executorId: string | null;
        executorAddress: string | null;
      }>;
      skipped: Array<{
        executorId: string | null;
        deploymentId: string | null;
        reason: string;
        detail?: string;
      }>;
    },
  ): Promise<void> {
    const results = await Promise.allSettled(
      rows.map((d) => this.upgrade(d.id, trigger)),
    );
    results.forEach((r, i) => {
      const d = rows[i];
      if (r.status === "fulfilled") {
        out.upgraded.push({
          deploymentId: d.id,
          executorId: d.executorId ?? null,
          executorAddress: d.executorAddress ?? null,
        });
      } else {
        const msg =
          r.reason instanceof Error ? r.reason.message : String(r.reason);
        out.skipped.push({
          executorId: d.executorId ?? null,
          deploymentId: d.id,
          reason: "upgrade_rejected",
          detail: msg,
        });
      }
    });
  }

  /**
   * Create a new deployment: record it in DB then push deploy command to executor.
   * Guards against duplicate in-flight deployments for the same application.
   */
  async deploy(
    applicationId: string,
    dto: CreateDeploymentDto,
    actor?: DeploymentApprovalActor,
    trigger?: DeploymentTriggerContext,
  ): Promise<AppDeployment> {
    // R1: deploy pushes the app env to the executor — must be the raw
    // value (read-surface masking would deliver "***" to the runner).
    const app = await this.appService.findByIdRaw(applicationId);

    // Duplicate-deployment guard: reject if a PENDING, DEPLOYING or UPGRADING
    // record already exists for this application (regardless of executor).
    // This prevents double-clicking the deploy button or concurrent webhook
    // retries from spawning two real processes.
    // QA4: UPGRADING must be covered too — upgrade() keeps the row in
    // UPGRADING for the whole push (R5), and the partial unique index below
    // intentionally does NOT constrain UPGRADING rows (concurrent rolling
    // upgrades of one application must not collide on it). A deploy issued
    // while an upgrade is in flight would therefore pass the index and start
    // a second real process on the executor; the application-layer guard is
    // the only interception point for that case.
    const inFlight = await this.repo.findOne({
      where: [
        { applicationId, status: DeploymentStatus.PENDING },
        { applicationId, status: DeploymentStatus.DEPLOYING },
        { applicationId, status: DeploymentStatus.UPGRADING },
      ],
    });
    if (inFlight) {
      // QA4: 409 (not 400) — same conflict semantics and same message as the
      // unique-violation branch below, so both interception surfaces answer
      // identically.
      throw new AppError(ErrorCode.APP_DEPLOYMENT_ALREADY_IN_FLIGHT, {
        name: app.name,
        detail: ` (id=${inFlight.id}, status=${inFlight.status})`,
      });
    }

    // Auto-select the least-loaded executor when none is specified.
    //
    // P0-3（生产实证 2026-10-22）：`dto.executorId` 可能是**悬空引用** —— 前端
    // 「重新部署」会把上一条部署行的 executorId 原样回填，而那条执行器行可能
    // 早已被删除/自动清理（app_deployments.executorId 无外键）。旧实现在这里
    // 直接抛 EXECUTOR_NOT_FOUND：用户既装不上、也无从修复（界面上根本选不到
    // 一条已删除的行），只能反复点「重新部署」。改为重新选机（与「未指定
    // 执行器」同一条路径），并留下显式告警——新行会记录本次实际选中的
    // executorId/executorAddress，归属仍可追溯。
    let executor: Executor;
    if (dto.executorId) {
      try {
        executor = await this.executorService.findOne(dto.executorId);
      } catch (err) {
        // 注意：**不要**用 `err instanceof AppError` 判型——AppError 在构造时把
        // 原型链改挂到对应的 NestJS 内置异常类上（见 app-error.ts 的长注释），
        // 因此 `instanceof AppError` 恒为 false。按 errorCode 鸭子类型判定。
        const errorCode = (err as { errorCode?: string } | null)?.errorCode;
        if (errorCode !== ErrorCode.EXECUTOR_NOT_FOUND) {
          throw err;
        }
        this.logger.warn(
          `Deploy requested for executor ${dto.executorId} which no longer exists — ` +
            `re-selecting the least-loaded executor instead of failing (stale id from a ` +
            `previous deployment row)`,
        );
        executor = await this.executorService.selectLeastLoaded();
      }
    } else {
      executor = await this.executorService.selectLeastLoaded();
    }

    // DEP-04: approval-gated application — freeze the request as a
    // pending-approval row (status=pending keeps holding the in-flight
    // slot, so concurrent deploys stay blocked by the guard above and the
    // partial unique index alike) and return WITHOUT dispatching.
    // pushDeployToExecutor runs only from approve(); rejection/cancel
    // marks the row FAILED so the slot frees.
    if (app.approvalRequired) {
      // DEEP-AUDIT B·4.2：缺省 runMode 改为 ONCE（三处同口径）。旧缺省
      // DAEMON 意味着"调用方没说怎么跑"时后端替你启动一个**常驻进程**——
      // 脚本/一次性任务形态的应用会被静默常驻（占内存、永不退出、重试
      // 无限堆积）；ONCE 是"跑完即止"的保守缺省，显式想要常驻的调用方
      // 一定会传 runMode。前端 18130d66 起按应用形态显式默认，该缺省只
      // 兜住 API 直调/旧客户端路径。
      const request = this.repo.create({
        applicationId,
        executorId: executor.id,
        executorAddress: executor.address,
        runMode: dto.runMode ?? RunMode.ONCE,
        env: dto.env ?? app.env,
        startCommand: dto.startCommand ?? app.entrypoint ?? null,
        status: DeploymentStatus.PENDING,
        approvalStatus: DeploymentApprovalStatus.PENDING_APPROVAL,
        approvalMeta: {
          requestedBy: actor?.id ?? null,
          requestedByName: actor?.name ?? null,
          requestedAt: new Date().toISOString(),
        },
        // FEAT-20: 提交动作来源落列（审批行与其派发行同源，approve 接力时
        // 覆写为 approval 语义）。
        triggerType: trigger?.triggerType ?? null,
        operator: trigger?.operator ?? null,
        statusMessage: "Awaiting deployment approval",
      });
      let savedRequest: AppDeployment;
      try {
        savedRequest = await this.repo.save(request);
      } catch (err: unknown) {
        if (this.isInFlightUniqueViolation(err)) {
          throw new AppError(ErrorCode.APP_DEPLOYMENT_ALREADY_IN_FLIGHT, {
            name: app.name,
            detail: "",
          });
        }
        throw err;
      }
      // R4（§4.1A）：审批请求行也是一次「部署动作的发起」——此刻落 deploy_created
      // 事件（approvalRequired=true 进 detail）；approve 时不另计部署事件（避免
      // 双计，见 DEPLOY_COUNTED_EVENT_TYPES）。版本事实 = 动作时的 app.version。
      await this.recordDeploymentEvent({
        applicationId,
        deploymentId: savedRequest.id,
        eventType: AppDeploymentEventType.DEPLOY_CREATED,
        executorId: executor.id,
        executorAddress: executor.address,
        deployedVersion: app.version ?? null,
        triggerType: trigger?.triggerType ?? null,
        operator: trigger?.operator ?? null,
        detail: { approvalRequired: true, runMode: savedRequest.runMode },
      });
      // QA1: HTTP response is a read surface — return masked.
      return this.maskDeploymentForRead(savedRequest);
    }

    // 复用同设备既有记录（生产反馈：每失败一次就多一条记录）。
    //
    // 背景：控制台「重新部署」按钮调的就是本方法（POST
    // /applications/:appId/deploy），而在途守卫只拦 PENDING/DEPLOYING/UPGRADING
    // ——失败行不拦。于是"失败→重试"每点一次插一条新行，同一台设备堆出 N 条
    // 记录，而用户期望的是"一台设备一条记录"。
    //
    // 语义：同一 (applicationId, executorId) 已有**终态**行（failed/stopped）
    // 时复用该行原地重推，而不是新建。这样：
    //   · 列表天然收敛为"每设备一行"，重试不再堆积；
    //   · 版本历史不丢——每次部署仍写 application_versions 快照
    //     （saveVersionSnapshot 按 (applicationId, version) 去重），
    //     发布列表 / 回滚面读的是快照表，不依赖 app_deployments 的行数；
    //   · 审批行（approvalStatus=pending_approval）**不复用**——它是在途行，
    //     已由上方守卫拦截，到不了这里；终态审批行复用无副作用（其
    //     approvalStatus 会被本次重置，见下）。
    //
    // 不复用的情形：runMode 改变（用户在"重新部署"弹窗里换了模式）。模式是
    // 该行的语义配置，静默改写会让"这台设备跑的是常驻还是单次"变得不可追溯，
    // 故模式变化时仍新建一行，把差异显式留在历史里。
    const reusable = await this.repo.findOne({
      where: {
        applicationId,
        executorId: executor.id,
        status: In([DeploymentStatus.FAILED, DeploymentStatus.STOPPED]),
        // DEEP-AUDIT B·4.2：缺省 ONCE（同 deploy() 缺省口径，见上方总注）。
        runMode: dto.runMode ?? RunMode.ONCE,
      },
      order: { updatedAt: "DESC" },
    });

    if (reusable) {
      reusable.executorAddress = executor.address;
      // DEEP-AUDIT B·4.2：缺省 ONCE（同上）。
      reusable.runMode = dto.runMode ?? RunMode.ONCE;
      reusable.env = dto.env ?? app.env;
      reusable.startCommand = dto.startCommand ?? app.entrypoint ?? null;
      // 重置为在途态：心跳会把它收敛到 running/failed。
      reusable.status = DeploymentStatus.PENDING;
      reusable.statusMessage = "Redeploying (reusing this deployment record)";
      reusable.triggerType = trigger?.triggerType ?? null;
      reusable.operator = trigger?.operator ?? null;
      // 清掉上一轮的终态残留，避免"新部署却显示旧 PID / 旧审批痕迹"。
      reusable.pid = null;
      reusable.approvalStatus = null;
      reusable.approvalMeta = null;
      reusable.rolloutState = null;
      reusable.rolloutMeta = null;

      let reused: AppDeployment;
      try {
        // A-3: 并发双击「重新部署」——两个请求都能通过上方的 reusable
        // findOne，后写者在 @VersionColumn 上撞版本抛
        // OptimisticLockVersionMismatchError。此前这里裸 save 未映射该错误
        // → 500；收口到 saveWithOptimisticLock 与 stop/upgrade 同口径
        // （版本冲突转 409 让客户端重载重试），唯一索引冲突分支保持不变
        // （saveWithOptimisticLock 对其他错误原样上抛）。
        reused = await this.saveWithOptimisticLock(reusable);
      } catch (err: unknown) {
        if (this.isInFlightUniqueViolation(err)) {
          throw new AppError(ErrorCode.APP_DEPLOYMENT_ALREADY_IN_FLIGHT, {
            name: app.name,
            detail: "",
          });
        }
        throw err;
      }

      this.logger.log(
        `Redeploy reuses existing deployment ${reused.id} for ${app.name} on ${executor.address}`,
      );
      // R4（§4.1A）：行复用重推不产生新部署行——事件表是这次动作的唯一痕迹，
      // deployCount 聚合（redeploy_reused 计入）依赖它。
      await this.recordDeploymentEvent({
        applicationId,
        deploymentId: reused.id,
        eventType: AppDeploymentEventType.REDEPLOY_REUSED,
        executorId: reused.executorId,
        executorAddress: reused.executorAddress,
        deployedVersion: app.version ?? null,
        triggerType: trigger?.triggerType ?? null,
        operator: trigger?.operator ?? null,
        detail: { runMode: reused.runMode },
      });
      this.pushDeployToExecutor(reused, app).catch((err) => {
        this.logger.error(`Failed to push deploy to executor: ${err.message}`);
      });

      return this.maskDeploymentForRead(reused);
    }

    const deployment = this.repo.create({
      applicationId,
      executorId: executor.id,
      executorAddress: executor.address,
      // DEEP-AUDIT B·4.2：缺省 ONCE（同 deploy() 缺省口径，见上方总注）——
      // 未声明模式时绝不静默启动常驻进程。
      runMode: dto.runMode ?? RunMode.ONCE,
      env: dto.env ?? app.env,
      startCommand: dto.startCommand ?? app.entrypoint ?? null,
      status: DeploymentStatus.PENDING,
      // FEAT-20: 部署触发来源（manual=控制台部署，operator=JWT 用户名）。
      triggerType: trigger?.triggerType ?? null,
      operator: trigger?.operator ?? null,
    });

    // R5: the findOne guard above is TOCTOU-racy — two concurrent deploy()
    // calls can both pass it. The partial unique index
    // uq_app_deployments_application_in_flight (migration 1789000000000) is
    // the real race-closing guard: the losing insert fails with 23505 and is
    // surfaced here as the same "already in-progress" rejection the guard
    // raises (409 instead of 400).
    let saved: AppDeployment;
    try {
      saved = await this.repo.save(deployment);
    } catch (err: unknown) {
      if (this.isInFlightUniqueViolation(err)) {
        throw new AppError(ErrorCode.APP_DEPLOYMENT_ALREADY_IN_FLIGHT, {
          name: app.name,
          detail: "",
        });
      }
      throw err;
    }

    // Asynchronously push deploy command to executor
    this.pushDeployToExecutor(saved, app).catch((err) => {
      this.logger.error(`Failed to push deploy to executor: ${err.message}`);
    });

    // R4（§4.1A）：新建行落 deploy_created 事件（版本事实 = 动作时的
    // app.version；行上的 deployedVersion 要等推送/心跳推进才置位）。
    await this.recordDeploymentEvent({
      applicationId,
      deploymentId: saved.id,
      eventType: AppDeploymentEventType.DEPLOY_CREATED,
      executorId: saved.executorId,
      executorAddress: saved.executorAddress,
      deployedVersion: app.version ?? null,
      triggerType: trigger?.triggerType ?? null,
      operator: trigger?.operator ?? null,
      detail: { runMode: saved.runMode },
    });

    // QA1: HTTP response is a read surface — return masked.
    return this.maskDeploymentForRead(saved);
  }

  // -----------------------------------------------------------------------
  // DEP-04: deployment approval flow
  // -----------------------------------------------------------------------

  /** DEP-04: 审批通过——第二人规则校验后转入正常推送链。
   *  原子认领（UPDATE … WHERE approvalStatus='pending_approval'）保证并发
   *  双审批只有首者生效，不会双推；推送链与 deploy() 同款 fire-and-forget，
   *  PENDING→DEPLOYING→FAILED 转移与失败语义由 pushDeployToExecutor 独占。 */
  async approveDeployment(
    deploymentId: string,
    actor: DeploymentApprovalActor,
    reason?: string,
    trigger?: DeploymentTriggerContext,
  ): Promise<AppDeployment> {
    const deployment = await this.findPendingApproval(deploymentId);
    this.assertSecondPerson(deployment, actor);

    const actedAt = new Date().toISOString();
    const nextMeta: Record<string, any> = {
      ...(deployment.approvalMeta ?? {}),
      actedBy: actor.id ?? null,
      actedByName: actor.name ?? null,
      actedAt,
    };
    if (reason) nextMeta.reason = reason;
    const claimed = await this.repo.update(
      {
        id: deploymentId,
        approvalStatus: DeploymentApprovalStatus.PENDING_APPROVAL,
      },
      {
        approvalStatus: DeploymentApprovalStatus.APPROVED,
        approvalMeta: nextMeta,
      },
    );
    if (!claimed.affected) {
      throw new AppError(ErrorCode.APP_DEPLOYMENT_ALREADY_HANDLED, {
        deploymentId,
      });
    }

    deployment.approvalStatus = DeploymentApprovalStatus.APPROVED;
    deployment.approvalMeta = nextMeta;
    // FEAT-20: 审批通过即实际派发动作——行覆写为 approval 语义 + 审批人。
    // （提交时的 manual 痕迹已被替换：该行的最终触发来源 = 让它真正
    // 发生的人。提交人仍可在 approvalMeta.requestedByName 追溯。）
    deployment.triggerType =
      trigger?.triggerType ?? DeploymentTriggerType.APPROVAL;
    deployment.operator = trigger?.operator ?? actor.name ?? null;

    // R1: the push sends the merged app+deployment env — raw entity only.
    const app = await this.appService.findByIdRaw(deployment.applicationId);
    this.pushDeployToExecutor(deployment, app).catch((err) => {
      this.logger.error(`Approved deploy push failed: ${err.message}`);
    });
    await this.writeApprovalAudit("deployment.approve", deployment, actor);
    // R4（§4.1A）：审批决策进事件流（不计入 deployCount——请求行的
    // deploy_created 已计，见 DEPLOY_COUNTED_EVENT_TYPES）。
    await this.recordDeploymentEvent({
      applicationId: deployment.applicationId,
      deploymentId: deployment.id,
      eventType: AppDeploymentEventType.APPROVAL_APPROVED,
      executorId: deployment.executorId,
      executorAddress: deployment.executorAddress,
      deployedVersion: app.version ?? null,
      triggerType: deployment.triggerType ?? null,
      operator: deployment.operator ?? null,
      detail: { reason: reason ?? null },
    });
    return this.maskDeploymentForRead(deployment);
  }

  /** DEP-04: 审批拒绝——终态落 FAILED（离开 in-flight 集合），reason 随
   *  approvalMeta 与 statusMessage 双落。第二人规则与 approve 同校验
   *  （提交者撤回自己的请求走 cancel，不走 reject）。 */
  async rejectDeployment(
    deploymentId: string,
    actor: DeploymentApprovalActor,
    reason?: string,
  ): Promise<AppDeployment> {
    const deployment = await this.findPendingApproval(deploymentId);
    this.assertSecondPerson(deployment, actor);

    const actedAt = new Date().toISOString();
    const nextMeta: Record<string, any> = {
      ...(deployment.approvalMeta ?? {}),
      actedBy: actor.id ?? null,
      actedByName: actor.name ?? null,
      actedAt,
      reason: reason ?? null,
    };
    const claimed = await this.repo.update(
      {
        id: deploymentId,
        approvalStatus: DeploymentApprovalStatus.PENDING_APPROVAL,
      },
      {
        approvalStatus: DeploymentApprovalStatus.REJECTED,
        status: DeploymentStatus.FAILED,
        statusMessage:
          `Deployment rejected by ${actor.name ?? "unknown"}` +
          (reason ? `: ${reason}` : ""),
        approvalMeta: nextMeta,
      },
    );
    if (!claimed.affected) {
      throw new AppError(ErrorCode.APP_DEPLOYMENT_ALREADY_HANDLED, {
        deploymentId,
      });
    }

    deployment.approvalStatus = DeploymentApprovalStatus.REJECTED;
    deployment.status = DeploymentStatus.FAILED;
    deployment.statusMessage =
      `Deployment rejected by ${actor.name ?? "unknown"}` +
      (reason ? `: ${reason}` : "");
    deployment.approvalMeta = nextMeta;
    await this.writeApprovalAudit(
      "deployment.reject",
      deployment,
      actor,
      reason,
    );
    // R4（§4.1A）：审批拒绝进事件流（reason 是决策的短事实）。
    await this.recordDeploymentEvent({
      applicationId: deployment.applicationId,
      deploymentId: deployment.id,
      eventType: AppDeploymentEventType.APPROVAL_REJECTED,
      executorId: deployment.executorId,
      executorAddress: deployment.executorAddress,
      deployedVersion: deployment.deployedVersion ?? null,
      triggerType: deployment.triggerType ?? null,
      operator: actor.name ?? null,
      detail: { reason: reason ?? null },
    });
    return this.maskDeploymentForRead(deployment);
  }

  /** DEP-04: 提交者撤回自己的待审批请求（第二人规则的镜像面——其他管理员
   *  想否决走 reject）。终态语义与 reject 相同（FAILED 离开 in-flight）。 */
  async cancelDeployment(
    deploymentId: string,
    actor: DeploymentApprovalActor,
  ): Promise<AppDeployment> {
    const deployment = await this.findPendingApproval(deploymentId);

    const meta = deployment.approvalMeta ?? {};
    if (
      meta.requestedBy != null &&
      actor.id != null &&
      meta.requestedBy !== actor.id
    ) {
      throw new AppError(ErrorCode.APP_DEPLOYMENT_CANCEL_NOT_REQUESTER);
    }

    const actedAt = new Date().toISOString();
    const nextMeta: Record<string, any> = {
      ...meta,
      actedBy: actor.id ?? null,
      actedByName: actor.name ?? null,
      actedAt,
    };
    const claimed = await this.repo.update(
      {
        id: deploymentId,
        approvalStatus: DeploymentApprovalStatus.PENDING_APPROVAL,
      },
      {
        approvalStatus: DeploymentApprovalStatus.CANCELLED,
        status: DeploymentStatus.FAILED,
        statusMessage: `Deployment request cancelled by ${actor.name ?? "unknown"}`,
        approvalMeta: nextMeta,
      },
    );
    if (!claimed.affected) {
      throw new AppError(ErrorCode.APP_DEPLOYMENT_ALREADY_HANDLED, {
        deploymentId,
      });
    }

    deployment.approvalStatus = DeploymentApprovalStatus.CANCELLED;
    deployment.status = DeploymentStatus.FAILED;
    deployment.statusMessage = `Deployment request cancelled by ${actor.name ?? "unknown"}`;
    deployment.approvalMeta = nextMeta;
    await this.writeApprovalAudit("deployment.cancel", deployment, actor);
    // R4（§4.1A）：提交者撤回进事件流。
    await this.recordDeploymentEvent({
      applicationId: deployment.applicationId,
      deploymentId: deployment.id,
      eventType: AppDeploymentEventType.APPROVAL_CANCELLED,
      executorId: deployment.executorId,
      executorAddress: deployment.executorAddress,
      deployedVersion: deployment.deployedVersion ?? null,
      triggerType: deployment.triggerType ?? null,
      operator: actor.name ?? null,
      detail: null,
    });
    return this.maskDeploymentForRead(deployment);
  }

  /** DEP-04: 待审批行加载（三动作共用前置）。 */
  private async findPendingApproval(
    deploymentId: string,
  ): Promise<AppDeployment> {
    const deployment = await this.findByIdRaw(deploymentId);
    if (
      deployment.approvalStatus !== DeploymentApprovalStatus.PENDING_APPROVAL
    ) {
      throw new AppError(ErrorCode.APP_DEPLOYMENT_NOT_PENDING_APPROVAL, {
        deploymentId,
        approvalStatus: deployment.approvalStatus ?? "none",
      });
    }
    return deployment;
  }

  /** DEP-04: 第二人规则——审批者不得与提交者为同一人（userId 同域比较，
   *  API-key 主体的 userId 即属主用户 id）。任一侧未知（理论不可达：deploy
   *  与审批端点均为已认证主体）时放行并留 warn，避免脏数据卡死审批链。 */
  private assertSecondPerson(
    deployment: AppDeployment,
    actor: DeploymentApprovalActor,
  ): void {
    const requestedBy = deployment.approvalMeta?.requestedBy ?? null;
    if (requestedBy == null || actor.id == null) {
      this.logger.warn(
        `Second-person check skipped (requestedBy=${String(requestedBy)}, ` +
          `actorId=${String(actor.id)}) for deployment ${deployment.id}`,
      );
      return;
    }
    if (requestedBy === actor.id) {
      throw new AppError(ErrorCode.APP_DEPLOYMENT_SECOND_PERSON_REQUIRED);
    }
  }

  /** DEP-04: 审批决策审计留痕（best-effort fail-open，先例 executor.service
   *  的 rotate/delete——审计故障不阻断主链，仅 warn）。 */
  private async writeApprovalAudit(
    action: "deployment.approve" | "deployment.reject" | "deployment.cancel",
    deployment: AppDeployment,
    actor: DeploymentApprovalActor,
    reason?: string,
  ): Promise<void> {
    if (!this.audit) return;
    try {
      await this.audit.log({
        userId: actor.id ?? undefined,
        username: actor.name ?? undefined,
        action,
        resource: "app_deployment",
        resourceId: deployment.id,
        detail: {
          applicationId: deployment.applicationId,
          executorAddress: deployment.executorAddress,
          reason: reason ?? null,
        },
      });
    } catch (err: unknown) {
      this.logger.warn(
        `Approval audit write failed: ` +
          (err instanceof Error ? err.message : String(err)),
      );
    }
  }

  /** D3-B-P2-1: stop/rollback 执行门审计落证（best-effort fail-open，
   *  同 writeApprovalAudit——审计故障不阻断主链）。 */
  private async writeTransitionAudit(
    action: "deployment.stop" | "deployment.rollback" | "deployment.delete",
    deployment: AppDeployment,
    extraDetail?: Record<string, unknown>,
  ): Promise<void> {
    if (!this.audit) return;
    try {
      await this.audit.log({
        action,
        resource: "app_deployment",
        resourceId: deployment.id,
        detail: {
          applicationId: deployment.applicationId,
          executorAddress: deployment.executorAddress,
          ...(extraDetail ?? {}),
        },
      });
    } catch (err: unknown) {
      this.logger.warn(
        `Transition audit write failed: ` +
          (err instanceof Error ? err.message : String(err)),
      );
    }
  }

  /**
   * R4（§4.1A）：部署事件落库（append-only 不可变事件表，纯旁路记录）。
   *
   * 事务策略：与部署行同库但**不共事务**（best-effort + warn）。部署域主链
   * （deploy/approve/upgrade/stop…）本身大多无显式事务边界，事件 insert 与
   * 主链写操作分属独立语句——事件表抖动绝不能拖挂主动作（部署推送已在执行器
   * 侧生效，因事件失败回滚主链反而制造「执行器有进程、中台无记录」的分裂）。
   * fail-open 口径与 writeApprovalAudit 相同。
   *
   * detail 只放标量短事实（reason/runMode/deletedStatus 等），**绝不放 env**：
   * 事件表没有掩码读面，密钥进事件即泄漏（QA1 同源约束）。
   */
  private async recordDeploymentEvent(input: {
    applicationId: string;
    deploymentId: string | null;
    eventType: AppDeploymentEventType;
    executorId?: string | null;
    executorAddress?: string | null;
    deployedVersion?: string | null;
    triggerType?: string | null;
    operator?: string | null;
    detail?: Record<string, unknown> | null;
  }): Promise<void> {
    if (!this.deploymentEventRepo) return; // @Optional 装配缺席（存量单测）
    try {
      await this.deploymentEventRepo.insert({
        applicationId: input.applicationId,
        deploymentId: input.deploymentId,
        executorId: input.executorId ?? null,
        executorAddress: input.executorAddress ?? null,
        eventType: input.eventType,
        deployedVersion: input.deployedVersion ?? null,
        triggerType: input.triggerType ?? null,
        operator: input.operator ?? null,
        detail: input.detail ?? null,
      });
    } catch (err: unknown) {
      this.logger.warn(
        `Deployment event write failed (${input.eventType}, deployment=` +
          `${input.deploymentId ?? "n/a"}): ` +
          (err instanceof Error ? err.message : String(err)),
      );
    }
  }

  /**
   * Trigger upgrade on an existing deployment (git pull + restart).
   */
  async upgrade(
    deploymentId: string,
    trigger?: DeploymentTriggerContext,
  ): Promise<AppDeployment> {
    // R1/QA1: raw lookup — the merged env is pushed to the executor AND the
    // entity is saved back; either step persisting the masked surface would
    // destroy the stored secrets with '***'.
    const deployment = await this.findByIdRaw(deploymentId);
    // DEP-04: 待审批行从未被派发过，upgrade 语义（拉新版本重启）不适用；
    // 出口只有 approve/reject/cancel 三条审批动作。
    if (
      deployment.approvalStatus === DeploymentApprovalStatus.PENDING_APPROVAL
    ) {
      throw new AppError(ErrorCode.APP_DEPLOYMENT_AWAITING_APPROVAL);
    }
    // R1: upgrade pushes the merged app+deployment env to the executor —
    // must be the raw value, not the masked read surface.
    const app = await this.appService.findByIdRaw(deployment.applicationId);

    // A-4: startCommand 是 deploy() 落库时的 entrypoint 快照——行复用升级
    // 语义下推送载荷 entrypoint = startCommand || app.entrypoint 会被这份
    // 陈旧快照压住（app.entrypoint 已随新版本变化，却永远推不出去）。升级链
    // 的「本次目标 entrypoint」即当前 app.entrypoint，推送前同步改写；deploy()
    // 的快照语义与载荷优先级保持不变（DeployModeFields 的按部署自定义
    // startCommand 在 deploy() 时已落库，升级后行上记录的就是本次实际推送值）。
    deployment.startCommand = app.entrypoint ?? deployment.startCommand ?? null;

    deployment.status = DeploymentStatus.UPGRADING;
    deployment.statusMessage = "Upgrade triggered";
    // FEAT-20: 升级动作落触发来源（upgrade 语义；不覆盖既有 operator 时
    // 用本次触发人——行复用升级，最近一次动作人是最新事实）。
    if (trigger) {
      deployment.triggerType = trigger.triggerType;
      deployment.operator = trigger.operator;
    }
    // E-P1-R2：乐观锁收口——并发后写撞版本转 409。
    await this.saveWithOptimisticLock(deployment);

    // R4（§4.1A）：叠加升级是行原位覆盖（无新行）——事件表是这次动作的唯一
    // 痕迹；R1 deploy-version / 旧 rollback alias / upgrade-all 全部经本方法，
    // 单写入点全覆盖。版本事实 = 本次推送目标 app.version（行上 deployedVersion
    // 要等心跳确认才推进）。
    await this.recordDeploymentEvent({
      applicationId: deployment.applicationId,
      deploymentId: deployment.id,
      eventType: AppDeploymentEventType.UPGRADE,
      executorId: deployment.executorId,
      executorAddress: deployment.executorAddress,
      deployedVersion: app.version ?? null,
      triggerType: deployment.triggerType ?? null,
      operator: deployment.operator ?? null,
      detail: null,
    });

    this.pushDeployToExecutor(deployment, app, true).catch((err) => {
      this.logger.error(`Upgrade push failed: ${err.message}`);
    });

    // QA1: HTTP response is a read surface — return masked (the push above
    // used the raw entity).
    return this.maskDeploymentForRead(deployment);
  }

  /**
   * Stop a running deployment.
   */
  async stop(deploymentId: string): Promise<AppDeployment> {
    // QA1: raw lookup — the entity is saved back below; persisting the
    // masked read surface would overwrite stored env secrets with '***'.
    const deployment = await this.findByIdRaw(deploymentId);
    // DEP-04: 待审批行从未派发，对执行器发 stop 信号无意义；出口同 upgrade。
    if (
      deployment.approvalStatus === DeploymentApprovalStatus.PENDING_APPROVAL
    ) {
      throw new AppError(ErrorCode.APP_DEPLOYMENT_AWAITING_APPROVAL);
    }
    // P2-1（2026-10-25 审计）：在途行（pending/deploying/upgrading）禁停。
    // 此前 stop 只挡 pending_approval——deploy 的推送是 fire-and-forget，行
    // 在推送在途时被 stop 立即置 STOPPED 并发 app-stop，随后推送照常到达把
    // 应用拉起；心跳又被 A-2② 的状态守卫（terminal 行不推进）拒绝，行永久
    // STOPPED 而设备上进程在跑。与 removeDeployment 的终态守卫（只许终态行
    // 删除）同口径：在途行的出口只有它自己的完成/失败链。
    const inFlight: DeploymentStatus[] = [
      DeploymentStatus.PENDING,
      DeploymentStatus.DEPLOYING,
      DeploymentStatus.UPGRADING,
    ];
    if (inFlight.includes(deployment.status)) {
      throw new AppError(ErrorCode.APP_DEPLOYMENT_STOP_IN_FLIGHT, {
        deploymentId,
        status: deployment.status,
      });
    }

    try {
      // ARCH-33（ADR-016）：pull 执行器走命令队列。stop 本就是 best-effort
      // （下方 catch 只 warn，行仍转 STOPPED），所以入队即视为「已通知」。
      const routed = await this.executorService.deliverControlCommand({
        executorId: deployment.executorId,
        address: deployment.executorAddress,
        type: "app-stop",
        payload: { deploymentId: deployment.id },
      });
      if (routed.delivered === "unresolved") {
        // 行已不存在 = 没有可通知的对象。stop 本就是 best-effort（下方 catch 只
        // warn），此处直接跳过 HTTP：对陈旧快照地址打 10s 超时什么都没换来。
        this.logger.warn(
          `Stop signal skipped for deployment ${deployment.id}: executor row ` +
            `${deployment.executorId ?? "(none)"} no longer exists`,
        );
      } else if (routed.delivered === "pull") {
        this.logger.log(
          `Stop signal queued for pull executor ${deployment.executorAddress} (deployment ${deployment.id}, commandId=${routed.commandId})`,
        );
      } else {
        const url = this.executorService.getExecutorUrl(
          deployment.executorAddress,
          `api/app-stop`,
        );
        // R8: stop() is an outbound admin→executor request, same exposure as
        // dispatch — run the executor SSRF policy (metadata/link-local refused)
        // before contacting the address. A refusal is logged and treated like
        // any other stop-signal failure: the row still transitions to STOPPED.
        // F-3 (SEC-NEW): pin the connection to the validated IP.
        const pinned = await assertAndPinExecutorUrl(url);
        const pinCfg = pinnedAxiosConfig(pinned);
        await axios.post(
          url,
          { deploymentId: deployment.id },
          {
            timeout: 10_000,
            headers: await this.getExecutorHeaders(),
            maxRedirects: 0,
            ...pinCfg,
          },
        );
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Stop signal failed (executor may be offline): ${msg}`);
      // 用户报障（中台显示不可信）：此前失败只写日志，行**照样**转 STOPPED 且
      // 接口返回 {status:'stopped'}——执行器离线时用户看到"已停止"、行变灰，
      // 但设备上的进程还在跑，而该行已不在 running（没有停止按钮），用户失去了
      // 唯一的真相来源。这正是本次报障的主线「界面说的和实际不一致」。
      //
      // 保留原 best-effort 语义（行仍转 STOPPED——停机意图已表达，且执行器可能
      // 只是慢/暂时不可达，卡在 running 更糟），但把**送达失败**如实写进
      // statusMessage，让前端能区分「真的停了」与「信号没送到」。
      // 前缀是跨端契约：前端按它决定用 warning 而非 success 提示。
      deployment.statusMessage = `${STOP_NOT_DELIVERED_PREFIX}${msg}`;
    }

    deployment.status = DeploymentStatus.STOPPED;
    deployment.pid = null;
    // E-P1-R2：乐观锁收口——并发后写撞版本转 409。
    const saved = await this.saveWithOptimisticLock(deployment);
    // D3-B-P2-1: stop 执行门落证（审批门已有痕，执行门此前无痕）。
    await this.writeTransitionAudit("deployment.stop", saved);
    // R4（§4.1A）：停机动作进事件流；送达与否从 STOP_NOT_DELIVERED_PREFIX
    // 推导（与前端同一条跨端契约），失败保留「信号没送到」的事实。
    await this.recordDeploymentEvent({
      applicationId: saved.applicationId,
      deploymentId: saved.id,
      eventType: AppDeploymentEventType.STOP,
      executorId: saved.executorId,
      executorAddress: saved.executorAddress,
      deployedVersion: saved.deployedVersion ?? null,
      triggerType: saved.triggerType ?? null,
      operator: saved.operator ?? null,
      detail: {
        stopSignalDelivered: !(saved.statusMessage ?? "").startsWith(
          STOP_NOT_DELIVERED_PREFIX,
        ),
      },
    });
    // QA1: mask the HTTP return; the raw entity was already persisted.
    return this.maskDeploymentForRead(saved);
  }

  /**
   * 用户报障：部署失败后记录永久残留、无法删除（「我重新部署了，旧的失败记录还在，
   * 而且无法删除或者撤销部署」）。
   *
   * 背景：app-deployments 此前只有 stop（停机保行），**没有任何删除面**；而
   * deploy() 恒定 INSERT 新行——于是每次「重新部署」都在列表里叠一条，旧失败行
   * 既不会被复用也删不掉，列表随重试次数单调膨胀。本方法补齐终态行的清理出口。
   *
   * 只允许删除**终态且不在途**的行：
   *   · FAILED / STOPPED —— 历史残影，删除只影响历史可读性；
   *   · 在途行（PENDING / DEPLOYING / UPGRADING）一律 409——行是在途唯一性的
   *     载体（部分唯一索引 uq_app_deployments_application_in_flight 与 deploy()
   *     的应用层守卫都靠它），删掉等于把「同一应用同时只能有一个部署在途」这条
   *     不变量连同闸门一起拆了，两个真实进程会同时跑起来；
   *   · RUNNING 行也拒绝——进程还活着，删行会留下无人认领的孤儿进程（用户想停
   *     它就应当先走 stop，把进程收掉再删）。
   *   · 待审批行（approvalStatus=pending_approval）同样拒绝——它有独立的
   *     reject/cancel 出口，语义上不是"要删的历史"。
   *
   * 执行器侧不派发任何指令：能删到的都是终态行，其进程已退出（stop 会把 pid 置
   * null 并向执行器发过 app-stop；failed 行则由其失败路径收尾）。此处刻意不做
   * best-effort 停机扇出——对一个已经死掉的部署重发 stop 只会制造噪音日志。
   */
  async removeDeployment(
    deploymentId: string,
    actor?: { id?: number; username?: string },
  ): Promise<{ ok: boolean; deletedId: string }> {
    // R1: 读取走原始行（审计 detail 里要带真实 executorAddress；掩码面不含密钥，
    // 但保持一致先例——写面一律 findByIdRaw）。
    const deployment = await this.findByIdRaw(deploymentId);

    // DEP-04: 待审批行有专属出口（approve/reject/cancel），不走删除。
    if (
      deployment.approvalStatus === DeploymentApprovalStatus.PENDING_APPROVAL
    ) {
      throw new AppError(ErrorCode.APP_DEPLOYMENT_AWAITING_APPROVAL_DELETE);
    }

    const inFlight: DeploymentStatus[] = [
      DeploymentStatus.PENDING,
      DeploymentStatus.DEPLOYING,
      DeploymentStatus.UPGRADING,
    ];
    if (inFlight.includes(deployment.status)) {
      throw new AppError(ErrorCode.APP_DEPLOYMENT_STILL_IN_FLIGHT, {
        deploymentId,
        status: deployment.status,
      });
    }
    if (deployment.status === DeploymentStatus.RUNNING) {
      throw new AppError(ErrorCode.APP_DEPLOYMENT_STILL_RUNNING, {
        deploymentId,
      });
    }

    // 审计先行：删掉行之后就没有 resourceId 可追溯了，落证必须在 delete 之前。
    await this.writeTransitionAudit("deployment.delete", deployment, {
      deletedStatus: deployment.status,
      deployedVersion: deployment.deployedVersion,
      deletedBy: actor?.username ?? null,
    });

    // R4（§4.1A）：事件无外键、比行活得久——删除前的最后一条事实，同样必须
    // 在 delete 之前落（事件表是「这台设备曾部署过」的唯一幸存痕迹）。
    await this.recordDeploymentEvent({
      applicationId: deployment.applicationId,
      deploymentId: deployment.id,
      eventType: AppDeploymentEventType.REMOVE,
      executorId: deployment.executorId,
      executorAddress: deployment.executorAddress,
      deployedVersion: deployment.deployedVersion ?? null,
      triggerType: deployment.triggerType ?? null,
      operator: actor?.username ?? null,
      detail: { deletedStatus: deployment.status },
    });

    await this.repo.delete({ id: deploymentId });
    this.logger.log(
      `Deployment record ${deploymentId} deleted (status=${deployment.status}, ` +
        `application=${deployment.applicationId}) by ${actor?.username ?? "unknown"}`,
    );
    return { ok: true, deletedId: deploymentId };
  }

  /**
   * Handle heartbeat from executor reporting app process status.
   */
  async handleHeartbeat(dto: DeploymentHeartbeatDto): Promise<void> {
    const deployment = await this.repo.findOne({
      where: { id: dto.deploymentId },
    });
    if (!deployment) {
      this.logger.warn(`Heartbeat for unknown deployment ${dto.deploymentId}`);
      return;
    }

    const statusMap: Record<string, DeploymentStatus> = {
      running: DeploymentStatus.RUNNING,
      stopped: DeploymentStatus.STOPPED,
      failed: DeploymentStatus.FAILED,
    };
    if (dto.status && statusMap[dto.status]) {
      deployment.status = statusMap[dto.status];
    } else if (dto.status) {
      this.logger.warn(
        `Heartbeat received unknown status "${dto.status}" for ${dto.deploymentId}`,
      );
    }

    if (dto.pid !== undefined) deployment.pid = dto.pid;
    if (dto.message) deployment.statusMessage = dto.message;
    deployment.lastHeartbeat = new Date();

    // E-P1-R2：心跳走轻量条件 UPDATE，不经过 @VersionColumn save——每次心跳
    // 都 bump version 会与并发 stop/upgrade 的乐观锁互撞。仅写心跳相关标量列；
    // 内存对象已按 dto 就地更新，下游版本快照/事件/灰度钩子读到一致值。
    //
    // A-2②：状态守卫——只有在途行（deploying/upgrading/running）允许被心跳
    // 推进。此前无条件按 id 写，卡死扫描判 FAILED 的行会被迟到的 running 心跳
    // 复活成 RUNNING（in-flight 槽位被占 + 版本快照 failed→released 反复翻转）；
    // FAILED 只允许显式重试链（deploy 复用行）改写。UPGRADING 必须在集合内：
    // R5 起升级全程保持 UPGRADING，执行器心跳是它到 RUNNING 的唯一出口。
    const advanced = await this.repo.update(
      {
        id: deployment.id,
        status: In([
          DeploymentStatus.DEPLOYING,
          DeploymentStatus.UPGRADING,
          DeploymentStatus.RUNNING,
        ]),
      },
      {
        ...(dto.status && statusMap[dto.status]
          ? { status: statusMap[dto.status] }
          : {}),
        ...(dto.pid !== undefined ? { pid: dto.pid } : {}),
        ...(dto.message ? { statusMessage: dto.message } : {}),
        lastHeartbeat: deployment.lastHeartbeat,
      },
    );
    if (!advanced.affected) {
      // 守卫未命中：行已是终态（或并发刚被收尾）——心跳不得推进任何状态、
      // 不得翻转版本快照、不得触发完成事件/灰度钩子。
      this.logger.warn(
        `Heartbeat ignored for deployment ${deployment.id} ` +
          `(row status=${deployment.status} is not in-flight) — terminal rows ` +
          `are not advanced by heartbeats`,
      );
      return;
    }

    if (deployment.status === DeploymentStatus.RUNNING) {
      await this.markVersionSnapshotStatus(deployment, "released");
    } else if (deployment.status === DeploymentStatus.FAILED) {
      await this.markVersionSnapshotStatus(deployment, "failed");
    }
    // FEAT-07: 部署终态落库后发布 deployment.completed（status=running 视为
    // 完成；fail-open，eventBus 为 null 时静默跳过）。
    this.emitDeploymentCompleted(deployment);

    // DEP-02: 灰度批次心跳钩子——批次在途时把 RUNNING/FAILED/STOPPED 上报
    // 推进到批次状态机（probing/失败）。fire-and-forget：心跳响应路径
    // 不被批次逻辑阻塞/失败（fail-open）。
    this.notifyHeartbeatToRollout(deployment).catch((err) => {
      this.logger.warn(
        `Rollout heartbeat hook failed for ${deployment.id}: ${err.message}`,
      );
    });
  }

  /**
   * FEAT-07: 部署终态落库后发布 deployment.completed（fail-open；载荷全为
   * 原始类型，与 domain-events.ts 设计约束一致）。
   */
  private emitDeploymentCompleted(deployment: AppDeployment): void {
    if (!this.eventBus) return;
    if (deployment.status !== DeploymentStatus.RUNNING) return;
    const payload: DeploymentCompletedEventPayload = {
      deploymentId: deployment.id,
      applicationId: deployment.applicationId,
      executorAddress: deployment.executorAddress,
      status: deployment.status,
      deployedVersion: deployment.deployedVersion ?? null,
      deployedCommit: deployment.deployedCommit ?? null,
      occurredAt: new Date().toISOString(),
    };
    try {
      this.eventBus.emit(DOMAIN_EVENTS.DEPLOYMENT_COMPLETED, payload);
    } catch {
      /* bus contract is fail-open; second fuse */
    }
  }

  // -----------------------------------------------------------------------
  // Internal helpers
  // -----------------------------------------------------------------------

  /**
   * R5: detect a Postgres unique-violation (SQLSTATE 23505) for a specific
   * constraint. TypeORM wraps the driver error in a QueryFailedError
   * (driverError / cause carry `code` and `constraint`), so walk one wrapper
   * level deep and require the constraint name — any other unique violation
   * must not be misreported.
   * (QA6: shared by the in-flight deployment guard and the version-snapshot
   * dedupe.)
   */
  private isUniqueViolationWithConstraint(
    err: unknown,
    constraint: string,
  ): boolean {
    const candidates: Array<Record<string, unknown> | unknown> = [err];
    if (err && typeof err === "object") {
      candidates.push((err as any).driverError, (err as any).cause);
    }
    for (const e of candidates) {
      if (!e || typeof e !== "object") continue;
      const anyErr = e as {
        code?: string;
        constraint?: string;
        message?: string;
      };
      if (anyErr.constraint === constraint) return true;
      if (
        anyErr.code === "23505" &&
        typeof anyErr.message === "string" &&
        anyErr.message.includes(constraint)
      ) {
        return true;
      }
    }
    return false;
  }

  private isInFlightUniqueViolation(err: unknown): boolean {
    return this.isUniqueViolationWithConstraint(err, IN_FLIGHT_UNIQUE_INDEX);
  }

  /**
   * Validate that an executor address looks like "host:port" to prevent SSRF.
   * Allows IPv4, IPv6 brackets, and hostnames.
   */
  private validateExecutorAddress(address: string): void {
    // Must match host:port where port is numeric 1-65535
    const re = /^(\[?[a-zA-Z0-9._:-]+\]?):([0-9]{1,5})$/;
    const m = address.match(re);
    if (!m) {
      throw new AppError(ErrorCode.EXECUTOR_ADDRESS_FORMAT_INVALID, {
        address,
      });
    }
    const port = parseInt(m[2], 10);
    if (port < 1 || port > 65535) {
      throw new AppError(ErrorCode.EXECUTOR_ADDRESS_PORT_OUT_OF_RANGE, {
        port,
      });
    }
  }

  private async pushDeployToExecutor(
    deployment: AppDeployment,
    app: Application,
    upgrade = false,
  ): Promise<void> {
    // R5: upgrades keep the row in UPGRADING for the whole push. Transitioning
    // to DEPLOYING here would make concurrent rolling upgrades of multiple
    // RUNNING deployments of the same application collide on the partial
    // unique index uq_app_deployments_application_in_flight. The executor's
    // heartbeat moves the row to RUNNING (or FAILED) afterwards.
    deployment.status = upgrade
      ? DeploymentStatus.UPGRADING
      : DeploymentStatus.DEPLOYING;
    deployment.statusMessage = upgrade
      ? "Pulling latest commit..."
      : "Cloning repository...";
    // R59：走本模块**自己的**乐观锁收口，而不是裸 save。
    //
    // 同文件 saveWithOptimisticLock 的头注写得很清楚：@VersionColumn 会让 save 自动追加
    // 「AND version = :expected」，并发后写撞版本时 TypeORM 抛 OptimisticLockVersionMismatchError
    // —— 那个 helper 负责把它翻成 409 APP_DEPLOYMENT_CONCURRENT_MODIFICATION。这里裸 save 意味着：
    // 数据**确实**被版本列保护着（不会静默覆盖），但撞版本时抛的是**未映射的** TypeORM 异常 ⇒
    // 调用方拿到 500，而不是「请重载重试」的 409。同一模块里两条写路径对同一类竞争给出不同
    // 答案，是缺陷而非风格。
    await this.saveWithOptimisticLock(deployment);

    // SSRF guard: validate address format before making any outbound request.
    // R8: format-only validation was not enough — the address is
    // executor-controlled (register/heartbeat carry it), so a poisoned row
    // could point the authenticated deploy push at cloud metadata / loopback
    // while skipping the guard entirely (dispatch and package-push both run
    // assertSafeExecutorUrl). The full URL goes through the same policy; a
    // refusal takes the FAILED branch below like any other push failure.
    //
    // ARCH-33（ADR-016）：传输分流。pull 执行器（NAT 内）无法被中台拨入——
    // 生产实证：公网中台 + 公司内网执行器拓扑下，此处 3 次重试全部 30s 超时
    // （app_deployments.statusMessage = "Failed to reach executor after 3
    // attempts: timeout of 30000ms exceeded"）。改为把部署载荷投进该执行器的
    // pull 命令队列，由执行器长轮询取走后本地 POST /api/deploy 执行。
    //
    // 语义零损失：本行的 DEPLOYING 状态与 push 路径同刻度（下方 save 已发生），
    // 终态仍由执行器 /app-deployments/heartbeat 收敛。
    const payload = {
      deploymentId: deployment.id,
      applicationId: app.id,
      appName: app.name,
      gitRepo: app.gitRepo || null,
      gitBranch: app.gitBranch || "main",
      gitCommit: app.gitCommit || null,
      packageUrl: (app as any).packageUrl || null,
      version: app.version || null,
      runtime: app.runtime,
      entrypoint: deployment.startCommand || app.entrypoint,
      runMode: deployment.runMode,
      env: { ...(app.env ?? {}), ...(deployment.env ?? {}) },
      upgrade,
    };

    // ARCH-33: 先试 pull 通道。delivered='pull' 表示已入队——此时**不**再走
    // 下方 HTTP 重试（那对本地址必然超时，且会白等 90 秒才落 FAILED）。
    const routed = await this.executorService.deliverControlCommand({
      executorId: deployment.executorId,
      address: deployment.executorAddress,
      type: "deploy",
      payload,
    });
    // §8.2 建议的排障闭环（一行 info）：把「本次下发到底走了哪条通道、打给谁」
    // 记下来。此前升级链路的 push 失败只能靠 Nginx 日志 + 「无 API 调用」反推，
    // dev 侧为此多花了一整轮往返。
    this.logger.log(
      `Deploy ${deployment.id} dispatch: executorId=${deployment.executorId ?? "(none)"} ` +
        `address=${deployment.executorAddress} transport=${routed.delivered}` +
        (routed.commandId ? ` commandId=${routed.commandId}` : ""),
    );
    if (routed.delivered === "unresolved") {
      // P0-3（生产实证 2026-10-22）：`executorId` 指向的执行器行已被删除
      // （app_deployments.executorId 无外键）⇒ 快照地址是陈旧的，且全 pull
      // 机队下它落在 NAT 内 / Clash 伪 IP 上（198.18.0.1:8002），push 必然
      // 3 × 30s 超时后 FAILED。这里改为**秒级失败**并给出可操作提示，同时
      // 立刻释放该应用的在途槽位（否则后续每次 deploy 都 409）。
      const msg =
        "Deploy target executor record no longer exists (it may have been deleted or " +
        "auto-cleaned). Re-select an executor and deploy again.";
      this.logger.error(
        `Deploy ${deployment.id} aborted: executorId ${deployment.executorId ?? "(none)"} no ` +
          `longer exists (snapshot address ${deployment.executorAddress}) — failing fast ` +
          `instead of pushing to a stale address`,
      );
      await this.failDeploymentIfInFlight(deployment, msg);
      return;
    }
    if (routed.delivered === "pull") {
      // A-2①：statusMessage 记下 commandId（前缀常量供卡死扫描识别「命令
      // 未决」行——见 PULL_QUEUED_MESSAGE_PREFIX 注释）。
      // R34-A2：状态写条件化（见 persistDeployProgress 头注）。
      await this.persistDeployProgress(
        deployment,
        upgrade ? DeploymentStatus.UPGRADING : DeploymentStatus.DEPLOYING,
        `${PULL_QUEUED_MESSAGE_PREFIX} (commandId=${routed.commandId})`,
        app,
      );
      await this.saveVersionSnapshot(deployment, app, "deploying");
      this.logger.log(
        `Deploy ${deployment.id} queued for pull executor ${deployment.executorAddress} (commandId=${routed.commandId})`,
      );
      return;
    }

    const url = this.executorService.getExecutorUrl(
      deployment.executorAddress,
      "api/deploy",
    );
    let pinned: PinnedHttpTarget;
    try {
      this.validateExecutorAddress(deployment.executorAddress);
      // F-3 (SEC-NEW): validate + pin to the validated IP in one step.
      pinned = await assertAndPinExecutorUrl(url);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      await this.failDeploymentIfInFlight(deployment, msg);
      return;
    }

    // Retry up to 3 times with exponential back-off (1s, 2s, 4s)
    const MAX_ATTEMPTS = 3;
    const pinCfg = pinnedAxiosConfig(pinned);
    let lastError: string | null = null;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        await axios.post(url, payload, {
          timeout: 30_000,
          headers: await this.getExecutorHeaders(),
          maxRedirects: 0, // R3 parity: 首跳是唯一经 SSRF 校验的地址
          ...pinCfg,
        });
        // Success（R34-A2：条件写，见 persistDeployProgress 头注）
        await this.persistDeployProgress(
          deployment,
          upgrade ? DeploymentStatus.UPGRADING : DeploymentStatus.DEPLOYING,
          "Deploy command sent to executor",
          app,
        );
        await this.saveVersionSnapshot(deployment, app, "deploying");
        return;
      } catch (err: unknown) {
        lastError = err instanceof Error ? err.message : String(err);
        this.logger.warn(
          `Deploy push attempt ${attempt}/${MAX_ATTEMPTS} failed for ${deployment.id}: ${lastError}`,
        );
        if (attempt < MAX_ATTEMPTS) {
          // Exponential back-off: 1000ms, 2000ms
          await new Promise((r) =>
            setTimeout(r, 1000 * Math.pow(2, attempt - 1)),
          );
        }
      }
    }

    // All attempts exhausted
    const exhaustedMsg = `Failed to reach executor after ${MAX_ATTEMPTS} attempts: ${lastError}`;
    this.logger.error(
      `Deploy push failed for ${deployment.id} after ${MAX_ATTEMPTS} attempts: ${lastError}`,
    );
    // R33-B2: **条件写**，不是无条件 save。
    //
    // 本分支的窗口很长：3 次尝试 × 30s 超时 + 1s/2s 退避 ⇒ 最长约 93 秒。而
    // 「HTTP 请求被对端接受、响应超时」是完全常见的形态——执行器其实**已经**
    // 收到命令并成功部署，随后心跳把行推进到 RUNNING。旧实现此刻无条件
    // save(FAILED) 会把这个成功**回滚成失败**（并把整份陈旧快照写回，连
    // deployedCommit/deployedVersion/statusMessage 一起盖掉）——运维看到
    // 「部署失败」而去重试，实际线上是好的。
    //
    // 判据用「行是否仍在飞」：只有仍在 PENDING/DEPLOYING/UPGRADING 时才写
    // FAILED；已被心跳推进（RUNNING/FAILED/STOPPED…）就一个字都不动，只留
    // 一条 warn（这是并发收敛，不是错误）。与 upgrade/stop 的
    // saveWithOptimisticLock 同方向：**让后来的写者看见别人已经写完**。
    // R33-B2 / R34-A2: 条件写在 failDeploymentIfInFlight 里（与 SSRF 分支同一实现）。
    await this.failDeploymentIfInFlight(deployment, exhaustedMsg);
  }

  /**
   * R34-A2（ADR-026）：推送**成功**路径的状态写也必须条件化。
   *
   * 两处（pull 已入队 / push 已送达）都在一次 await 之后写 `DEPLOYING|UPGRADING`。
   * 若执行器极快（pull 模式尤其：「入队后立刻被取走并跑完」），心跳可能已把行推进到
   * RUNNING —— 无条件 save 会把状态**回退**成 DEPLOYING（随后又被卡死扫描判 stalled）。
   *
   * 但这里不能像失败分支那样「整条跳过」：本次推送的 deployedCommit / deployedVersion /
   * deployedAt 是**真实事实**（部署确实发生了），丢掉会丢部署记录。故采取：
   *   · 行仍在飞 → 一次条件写，状态 + 元数据一起落；
   *   · 行已被推进 → **只补元数据，不回退状态**（并 warn 说明让位）。
   */
  private async persistDeployProgress(
    deployment: AppDeployment,
    status: DeploymentStatus,
    statusMessage: string,
    app: Application,
  ): Promise<void> {
    const metadata = {
      statusMessage,
      deployedCommit: app.gitCommit || null,
      deployedVersion: app.version || null,
      deployedAt: new Date(),
    };
    const applied = await this.repo.update(
      {
        id: deployment.id,
        status: In([
          DeploymentStatus.PENDING,
          DeploymentStatus.DEPLOYING,
          DeploymentStatus.UPGRADING,
        ]),
      },
      { status, ...metadata },
    );
    if (applied.affected) {
      Object.assign(deployment, { status, ...metadata });
      return;
    }
    // adr-026-exempt: 只写部署元数据（deployedCommit / deployedVersion / deployedAt /
    // statusMessage），**patch 里不含 status** —— 无条件写是刻意的：状态由上面的条件写
    // 决定，这里补的是「部署确实发生过」这一事实，与并发无关。
    await this.repo.update({ id: deployment.id }, metadata);
    Object.assign(deployment, metadata);
    this.logger.warn(
      "Deploy push to " +
        deployment.id +
        " succeeded but the row was already advanced by its heartbeat — status kept, " +
        "deploy metadata recorded.",
    );
  }
  /**
   * R34-A2（ADR-026）：把「本次推送失败」写成终态时，必须是**条件写**。
   *
   * 两个调用点的窗口都不短：SSRF 校验要**做 DNS 解析**（秒级），重试耗尽要
   * 3 次 30s 超时 + 退避（约 93 秒）。期间执行器完全可能已经收到命令并成功
   * 部署、心跳把行推进到 RUNNING —— 此时无条件写 FAILED 会把**成功回滚成
   * 失败**（并整份陈旧快照覆盖 deployedCommit/deployedVersion/statusMessage）。
   *
   * 判据用「行是否仍在飞」：只有仍在 DEPLOYING/UPGRADING 时才落 FAILED；
   * 已被推进就一个字都不写，只留 warn（并发收敛，不是错误）。
   *
   * @returns 是否真的写了 FAILED（false = 让位给了并发写者）
   */
  private async failDeploymentIfInFlight(
    deployment: AppDeployment,
    message: string,
  ): Promise<boolean> {
    const marked = await this.repo.update(
      {
        id: deployment.id,
        status: In([DeploymentStatus.DEPLOYING, DeploymentStatus.UPGRADING]),
      },
      { status: DeploymentStatus.FAILED, statusMessage: message },
    );
    if (!marked.affected) {
      this.logger.warn(
        "Deploy push to " +
          deployment.id +
          " failed, but the row is no longer in-flight (the executor may already have " +
          "succeeded and been advanced by its heartbeat) — not overwriting it with FAILED. " +
          "Reason: " +
          message,
      );
      return false;
    }
    deployment.status = DeploymentStatus.FAILED;
    deployment.statusMessage = message;
    return true;
  }
  private buildSnapshot(app: Application): Record<string, any> {
    return {
      id: app.id,
      name: app.name,
      description: app.description,
      version: app.version,
      runtime: app.runtime,
      status: app.status,
      gitRepo: app.gitRepo,
      gitBranch: app.gitBranch,
      gitCommit: app.gitCommit,
      packageUrl: app.packageUrl,
      manifest: app.manifest,
      env: app.env,
      entrypoint: app.entrypoint,
    };
  }

  /**
   * P3-7（2026-10-25 审计，登记不修）：application_versions **无保留策略**。
   * 每次部署/升级都按 (applicationId, version, gitCommit, sourceDeploymentId)
   * 去重落快照，行数随部署次数单调增长且永不清理——版本快照同时是回滚面与
   * 发布列表的事实源，自动保留/清理需要产品决策（保留多少个版本？released
   * 与 failed 快照是否同策略？），登记为残差，不在本轮处置。
   */
  private async saveVersionSnapshot(
    deployment: AppDeployment,
    app: Application,
    status: string,
  ): Promise<void> {
    if (!app.version) return;
    const existing = await this.versionRepo.findOne({
      where: {
        applicationId: app.id,
        version: app.version,
        // TypeORM 1.x：where 里的 null **字面量**不再编译成 IS NULL，而是按
        // invalidWhereValuesBehavior 默认抛错。app.gitCommit 为 null（未接 Git
        // 的应用、或本机 selftest 的应用）时，这里此前必抛
        // 「Null value encountered in property 'ApplicationVersion.gitCommit'」，
        // 直接导致整个部署推送到执行器失败（statusMessage 可见原文）。必须显式
        // 写 IsNull()。
        gitCommit: app.gitCommit != null ? app.gitCommit : IsNull(),
        sourceDeploymentId: deployment.id,
      },
    });
    if (existing) return;

    try {
      await this.versionRepo.save(
        this.versionRepo.create({
          applicationId: app.id,
          version: app.version,
          gitCommit: app.gitCommit ?? null,
          sourceDeploymentId: deployment.id,
          status,
          snapshot: this.buildSnapshot(app),
          description: `Deployment ${deployment.id}`,
        }),
      );
    } catch (err: unknown) {
      // QA6: uq_application_versions_applicationId_version constrains only
      // (applicationId, version), while the findOne dedupe above keys on
      // sourceDeploymentId as well. When the same application rolls out on
      // several executors concurrently (rolling upgrade), every instance
      // passes the dedupe check but only the first INSERT wins; the losers
      // fail with 23505. That must NOT fail the push — the executor already
      // accepted the deploy and the snapshot row exists (first writer wins),
      // so swallow exactly that violation and keep the push-success semantics.
      if (
        this.isUniqueViolationWithConstraint(
          err,
          "uq_application_versions_applicationId_version",
        )
      ) {
        this.logger.warn(
          `Version snapshot for ${app.id}@${app.version} already exists ` +
            `(concurrent deployment ${deployment.id}) — skipping duplicate snapshot`,
        );
        return;
      }
      throw err;
    }
  }

  private async markVersionSnapshotStatus(
    deployment: AppDeployment,
    status: string,
  ): Promise<void> {
    if (!deployment.deployedVersion) return;
    const version = await this.versionRepo.findOne({
      where: {
        applicationId: deployment.applicationId,
        version: deployment.deployedVersion,
        // 同 saveVersionSnapshot：null 字面量在 TypeORM 1.x 的 where 里会抛错，
        // 未接 Git 的部署（deployedCommit 为 null）必须走 IsNull()。
        gitCommit:
          deployment.deployedCommit != null
            ? deployment.deployedCommit
            : IsNull(),
        sourceDeploymentId: deployment.id,
      },
    });
    if (!version || version.status === status) return;

    version.status = status;
    await this.versionRepo.save(version);
  }

  /**
   * R4（§4.7 / §4.1A）：版本 deployCount 改为事件表 DB 侧 GROUP BY 聚合。
   *
   * 切换依据：行复用模型下「同一版本部署过几次」在 app_deployments 上不可
   * 数（原地覆盖只留现状）——事件表（deploy_created/redeploy_reused/upgrade）
   * 才是动作的持久载体；DB 侧 GROUP BY 也让该读面摆脱 findAllByApp 的
   * take:5000 内存闸（超限静默失真是 §P8 的问题本体）。
   *
   * legacy 回退：该应用**一条事件都没有**时，事件聚合恒为空——回退旧的
   * findAllByApp 行计数。迁移 1790000000064 已把「迁移 1790000000062 之前
   * 历史动作数凭空消失」的混合窗口期消除（对无事件应用从现存部署行合成
   * deploy_created 下界事件，折算语义见该迁移注释），但本分支仍需保留，
   * 服务两类残余场景：
   *  1. **回填后仍无行可折算的应用**：部署行已全被 remove（行删除不落
   *     remove 事件之外的历史）或从未有过部署行——回填无米下炊，事件表对其
   *     恒空，行计数仍是唯一可用口径（findAllByApp 也空时得空 map，自洽）；
   *  2. **测试装配缺席**：deploymentEventRepo 为 null（@Optional 存量单测
   *     装配）同走回退。
   * 有事件即切事件聚合的语义不变（混加行数与事件数无法自洽，行数随行复用
   * 漂移）。
   */
  private async buildDeployCountMap(
    applicationId: string,
  ): Promise<Map<string, number>> {
    if (this.deploymentEventRepo) {
      const eventCount = await this.deploymentEventRepo.count({
        where: { applicationId },
      });
      if (eventCount > 0) {
        const rows: Array<Record<string, unknown>> =
          await this.deploymentEventRepo
            .createQueryBuilder("e")
            .select("e.deployedVersion", "version")
            .addSelect("COUNT(*)", "count")
            .where("e.applicationId = :applicationId", { applicationId })
            .andWhere("e.eventType IN (:...types)", {
              types: DEPLOY_COUNTED_EVENT_TYPES,
            })
            .andWhere("e.deployedVersion IS NOT NULL")
            .groupBy("e.deployedVersion")
            .getRawMany();
        const countMap = new Map<string, number>();
        for (const row of rows) {
          // pg 驱动下 COUNT(*) 回 bigint 字符串（findStats 同款收口）。
          const n = Number(row.count);
          if (typeof row.version === "string" && Number.isFinite(n) && n > 0) {
            countMap.set(row.version, n);
          }
        }
        return countMap;
      }
    }
    // legacy 回退：事件表空（或测试装配缺席）→ 既有行计数语义。
    const deployments = await this.findAllByApp(applicationId);
    const countMap = new Map<string, number>();
    for (const d of deployments) {
      if (!d.deployedVersion) continue;
      countMap.set(
        d.deployedVersion,
        (countMap.get(d.deployedVersion) ?? 0) + 1,
      );
    }
    return countMap;
  }

  private async getDeploymentVersionFallback(applicationId: string) {
    const deployments = await this.findAllByApp(applicationId);
    const seen = new Set<string>();
    const countMap = new Map<string, number>();
    for (const d of deployments) {
      const key = d.deployedVersion ?? "__unknown__";
      countMap.set(key, (countMap.get(key) ?? 0) + 1);
    }

    const versionHistory: Array<{
      id: string | null;
      deploymentId: string;
      sourceDeploymentId: string;
      version: string | null;
      commit: string | null;
      status: string;
      deployedAt: Date | null;
      createdAt: Date | null;
      executorAddress: string;
      deployCount: number;
      snapshot: Record<string, any> | null;
    }> = [];

    for (const d of deployments) {
      const key = d.deployedVersion ?? "__unknown__";
      if (!seen.has(key)) {
        seen.add(key);
        versionHistory.push({
          id: null,
          deploymentId: d.id,
          sourceDeploymentId: d.id,
          version: d.deployedVersion,
          commit: d.deployedCommit,
          status: d.status,
          deployedAt: d.deployedAt,
          createdAt: d.deployedAt,
          executorAddress: d.executorAddress,
          deployCount: countMap.get(key) ?? 1,
          snapshot: null,
        });
      }
    }
    return versionHistory;
  }

  /** QA1: shallow-clone a version snapshot with its env record masked. */
  private maskSnapshotForRead(
    snapshot: Record<string, any> | null,
  ): Record<string, any> | null {
    if (!snapshot || typeof snapshot !== "object") return snapshot;
    if (!("env" in snapshot)) return snapshot;
    return {
      ...snapshot,
      env: this.appService.maskEnvForRead(snapshot.env),
    };
  }

  private async upgradeRunningDeployments(
    appId: string,
    trigger?: DeploymentTriggerContext,
  ) {
    const running = await this.findRunningByApp(appId);
    const results = await Promise.allSettled(
      running.map((d) => this.upgrade(d.id, trigger)),
    );
    const succeeded = results.filter((r) => r.status === "fulfilled").length;
    return {
      ok: true,
      total: running.length,
      succeeded,
      failed: running.length - succeeded,
    };
  }

  /** Scan every 2 minutes for deployments stuck in an in-progress state
   *  ('deploying'/'upgrading') with no update for > 10 minutes and mark them
   *  failed.
   *  R6: the predicate used to be createdAt-based — a legacy deployment
   *  upgraded (re-entering DEPLOYING on the SAME row) kept its original
   *  createdAt and was mis-marked FAILED by this cron 10 minutes later,
   *  polluting the version snapshot. updatedAt is refreshed both when the
   *  row enters DEPLOYING/UPGRADING (status save) and on every heartbeat
   *  save, so the semantics are now "in-progress and untouched for 10
   *  minutes". UPGRADING is included because upgrades no longer pass through
   *  DEPLOYING (R5 index compatibility) and still need the same timeout
   *  coverage.
   *  QA5: PENDING is swept on a shorter threshold (5 minutes). deploy()
   *  INSERTs the row as PENDING and pushes to the executor asynchronously —
   *  a crash between the two steps leaves the row PENDING forever, where it
   *  keeps matching the partial unique index
   *  uq_app_deployments_application_in_flight and permanently 409s every
   *  future deployment of the application. The normal PENDING window is
   *  process-internal (auto-select + push retries ≈ <100s), so 5 minutes is
   *  safely above any legitimate hold.
   *  A-1: 待审批行复用 status=PENDING 挂在途位（见 entity 注释）——审批可以
   *  合法悬置超过 5min，不参与卡死判定（扫描 where / JS 过滤 / UPDATE 守卫
   *  三层同口径排除 approvalStatus=pending_approval）。
   *  A-2①: pull 入队后行恒 DEPLOYING 且离线执行器不产生心跳——行龄未超命令
   *  TTL 的「commandId 未决」行（statusMessage 带 PULL_QUEUED_MESSAGE_PREFIX）
   *  豁免扫描：否则执行器离线 >10min 时行被判 FAILED 并释放 in-flight 槽位，
   *  旧命令在 TTL 内被重连的执行器消费 → 同一执行器两个真实进程。命令 TTL
   *  过后执行器侧本就按 issuedAt 丢弃载荷，届时再扫死是安全的。 */
  @Cron("0 */2 * * * *")
  async detectStuckDeployments(): Promise<void> {
    // ARCH-31 §5: 多实例下仅 cron Leader 执行（详见 LeaderGateService）
    if (this.leaderGate && !this.leaderGate.isLeader) return;
    const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000);
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
    const stuck = await this.repo.find({
      where: [
        {
          status: DeploymentStatus.PENDING,
          updatedAt: LessThan(fiveMinutesAgo),
          // A-1: 待审批行（pending_approval）不扫死。Raw 而非 Not()——
          // approvalStatus 可空，`!= 'pending_approval'` 对 NULL 行求值为
          // NULL 会把普通行也一并排除。
          approvalStatus: Raw(
            (alias) => `(${alias} IS NULL OR ${alias} <> :pendingApproval)`,
            { pendingApproval: DeploymentApprovalStatus.PENDING_APPROVAL },
          ),
        },
        {
          status: DeploymentStatus.DEPLOYING,
          updatedAt: LessThan(tenMinutesAgo),
        },
        {
          status: DeploymentStatus.UPGRADING,
          updatedAt: LessThan(tenMinutesAgo),
        },
      ],
      // O-5: bound the cron sweep; rows flipped to FAILED leave the predicate,
      // so the next tick self-converges any backlog.
      take: 1000,
    });
    if (stuck.length === 0) return;

    // A-1（JS 侧防御性二次过滤，findInFlightRolloutRows 同款——仓储 mock /
    // 副本读面可能不带 where 语义）+ A-2①（pull 未决命令豁免）。
    // `||` 与 ExecutorPullService.commandTtlMs 同款（0/非法值回退缺省）。
    const cmdTtlMs =
      this.configService.get<number>(EXECUTOR_CMD_TTL_CONFIG_KEY) ||
      DEPLOYMENT_CMD_TTL_MS_DEFAULT;
    const now = Date.now();
    const sweepable = stuck.filter((d) => {
      if (
        d.status === DeploymentStatus.PENDING &&
        d.approvalStatus === DeploymentApprovalStatus.PENDING_APPROVAL
      ) {
        return false; // A-1: 待审批行永不扫死
      }
      if (
        (d.status === DeploymentStatus.DEPLOYING ||
          d.status === DeploymentStatus.UPGRADING) &&
        (d.statusMessage ?? "").startsWith(PULL_QUEUED_MESSAGE_PREFIX) &&
        d.updatedAt &&
        now - new Date(d.updatedAt).getTime() < cmdTtlMs
      ) {
        // A-2①: 部署命令仍可能在 pull 队列里未决（行龄未超命令 TTL）——
        // 此时判 FAILED 会释放 in-flight 槽位并放行新部署，与旧命令叠加成
        // 双进程。豁免到 TTL 过后（届时命令已被执行器侧丢弃）。
        this.logger.log(
          `Stuck sweep: deployment ${d.id} still has an undelivered pull ` +
            `command younger than the command TTL (${cmdTtlMs}ms) — exempt`,
        );
        return false;
      }
      return true;
    });
    if (sweepable.length === 0) return;

    const PENDING_MSG =
      "[System] Deployment stuck in PENDING (deploy push never started, " +
      "likely a restart between insert and push) — timed out after 5 minutes";
    const TIMEOUT_MSG = "[System] Deployment timed out after 10 minutes";

    // O-5: two batched UPDATEs (message differs for PENDING vs DEPLOYING/
    // UPGRADING) instead of N per-row save() round-trips.
    const pendingIds = sweepable
      .filter((d) => d.status === DeploymentStatus.PENDING)
      .map((d) => d.id);
    const otherIds = sweepable
      .filter((d) => d.status !== DeploymentStatus.PENDING)
      .map((d) => d.id);
    // A-9: 只对条件 UPDATE **实际命中**的行做版本快照标记——SELECT 快照与
    // UPDATE 之间被并发心跳推进到 RUNNING 的行 affected=0，其快照必须保持
    // 原状（此前 for 循环对 stuck 全量 markVersionSnapshotStatus(failed)，
    // 会把刚成功的部署快照误标 failed）。Postgres RETURNING 精确取回命中 id。
    const affectedIds = new Set<string>();
    const collectAffected = (result: {
      raw?: unknown;
      affected?: number | null;
    }) => {
      const rows = (result.raw ?? []) as Array<{ id?: string }>;
      for (const row of rows) if (row?.id) affectedIds.add(row.id);
    };
    if (pendingIds.length > 0) {
      collectAffected(
        await this.repo
          .createQueryBuilder()
          .update(AppDeployment)
          .set({ status: DeploymentStatus.FAILED, statusMessage: PENDING_MSG })
          .where("id IN (:...ids)", { ids: pendingIds })
          // E-P1-R3: must still require the source status to be PENDING. Between the
          // SELECT snapshot and this UPDATE, a concurrent heartbeat/advance may have
          // already moved a row PENDING->RUNNING. Blindly writing by id would clobber
          // a just-succeeded heartbeat into FAILED; the guarded UPDATE makes such rows
          // affected=0 so they are not overwritten.
          .andWhere("status = :expectedStatus", {
            expectedStatus: DeploymentStatus.PENDING,
          })
          // A-1: 审批认领（approve→approved）与扫描 UPDATE 竞态时不得把已
          // 认领的行盖回 FAILED——待审批态同被排除。
          .andWhere(
            "(approvalStatus IS NULL OR approvalStatus <> :pendingApproval)",
            {
              pendingApproval: DeploymentApprovalStatus.PENDING_APPROVAL,
            },
          )
          .returning("id")
          .execute(),
      );
    }
    if (otherIds.length > 0) {
      collectAffected(
        await this.repo
          .createQueryBuilder()
          .update(AppDeployment)
          .set({ status: DeploymentStatus.FAILED, statusMessage: TIMEOUT_MSG })
          .where("id IN (:...ids)", { ids: otherIds })
          // E-P1-R3: same as the pending branch -- a DEPLOYING/UPGRADING row already
          // advanced to RUNNING by a concurrent heartbeat must not be swept back to
          // FAILED (affected=0).
          .andWhere("status IN (:...expectedStatuses)", {
            expectedStatuses: [
              DeploymentStatus.DEPLOYING,
              DeploymentStatus.UPGRADING,
            ],
          })
          .returning("id")
          .execute(),
      );
    }

    for (const d of sweepable) {
      if (!affectedIds.has(d.id)) continue; // A-9: 未被本次 UPDATE 命中（并发已推进）→ 不动快照
      const previousStatus = d.status; // R4：扫死前的在途状态进事件 detail
      d.status = DeploymentStatus.FAILED;
      await this.markVersionSnapshotStatus(d, "failed");
      // R4（§4.1A）：系统侧转 FAILED 也进事件流（operator=null——机器路径）。
      await this.recordDeploymentEvent({
        applicationId: d.applicationId,
        deploymentId: d.id,
        eventType: AppDeploymentEventType.STUCK_FAILED,
        executorId: d.executorId,
        executorAddress: d.executorAddress,
        deployedVersion: d.deployedVersion ?? null,
        triggerType: d.triggerType ?? null,
        operator: null,
        detail: { previousStatus },
      });
      this.logger.warn(
        `Stuck deployment marked FAILED: id=${d.id}, app=${d.applicationId}, status=${d.status}`,
      );
    }
  }

  // -----------------------------------------------------------------------
  // DEP-02/DEP-03: 灰度（canary）发布批次 + manifest 健康探针 + 自动回滚
  // -----------------------------------------------------------------------

  /**
   * DEP-02: upgrade-all 引擎入口。
   *  - 未传 rollout 或 strategy='all'：既有全量语义原样返回（零破坏——同一
   *    Promise.allSettled(upgrade) 路径，不落 rolloutState）。
   *  - strategy='canary'：首批 ceil(N×percentage%) 台（至少 1 台）触发 upgrade
   *    → 行落 rolloutState=pending（批次元数据见 rolloutMeta）→ 进程内批次
   *    引擎等待心跳确认（handleHeartbeat 落 RUNNING 时推进）→ 逐台按
   *    manifest.healthCheck 主动探测（GET http://<host>:<port><path>，
   *    interval×failThreshold 重试窗）→ 全部通过提升其余台 → 任一失败暂停
   *    批次并对已升级台自动回滚（复用「重新部署上一版本」链）。
   *    manifest 无 healthCheck 声明时跳过探测直接提升（行为可预期：无验收
   *    依据时阻塞灰度毫无意义）。
   *
   * R2（部署模型评审 §4.4/§9.4，2026-10-24）：覆盖面显式化——「该应用已部署
   * 的设备」默认 = 全部 RUNNING 行。scheduled 实证口径（与 §P7 的原始推断
   * 不同）：executor deploy.ts scheduled 分支部署完成即一次性
   * reportStatus(deploymentId,'running')，行经 handleHeartbeat 状态守卫落
   * RUNNING；此后无进程、无持续心跳，但 detectStuckDeployments 只扫
   * PENDING(5min)/DEPLOYING(10min)/UPGRADING(10min)，**永不触碰 RUNNING 行**
   * ——scheduled 行稳态就是 RUNNING，findRunningByApp 天然覆盖，不存在
   * 「拿不到新版本」。真正掉出覆盖面的只有「完成上报丢失 → 滞留 DEPLOYING →
   * 10min 后被扫成 FAILED」的行，而那是 failed 口径（默认排除，走显式重新
   * 部署）。因此默认覆盖集合与改造前逐字节一致；本方法新增的只是把覆盖面
   * **显式分组回显**（coverage）+ 在途行跳过明细（skipped，不抛错）+ stopped
   * 显式 opt-in（includeStopped，默认 false——stopped 可能是人为停用）。
   */
  async upgradeAllWithRollout(
    appId: string,
    rollout?: { strategy?: "canary" | "all"; percentage?: number } | null,
    trigger?: DeploymentTriggerContext,
    version?: string,
    includeStopped = false,
    // P0-1：version 定向灰度的「定版」分支写 applications 表（快照恢复），
    // 同样经属主守卫。upgrade-all 是 @Roles(ADMIN) 的人工干预面，恒有
    // @CurrentUser——按人类 actor 语义透传，无需 systemBypass（机器面先例
    // 只有 HMAC webhook 一条，见 application.controller.webhook）。
    actor?: { id: number; role: UserRole } | null,
  ): Promise<{
    ok: boolean;
    total: number;
    succeeded: number;
    failed: number;
    /** version 定向灰度时回显实际目标版本（快照恢复后 app 的 version）。 */
    version?: string;
    /** R2 §4.4：覆盖面分组计数（本方法所有返回路径恒携带）。 */
    coverage: {
      running: number;
      scheduled: number;
      stopped: number;
      failed: number;
      inFlight: number;
    };
    /** R2 §4.4：在途行跳过明细（pending/deploying/upgrading 不抛错）。 */
    skipped: Array<{
      deploymentId: string;
      executorId: string | null;
      status: string;
      reason: string;
    }>;
    rollout?: {
      batchId: string;
      strategy: "canary" | "all";
      canaryIds: string[];
      promotedIds: string[];
      /** ARCH-31: 同应用已有在途批次时的拒绝原因（跨实例互斥，非异常）。 */
      blockedReason?: string;
    };
  }> {
    // 版本定向灰度（2026-10-07 拍板立项）：先按指定 released 版本快照恢复
    // 应用字段（与 rollbackApplication 同一映射），再走既有 rollout 全套。
    // version 与当前 version 相同则跳过恢复——「缺省=latest 逐字节不变」的
    // 同版本显式请求保持纯升级语义。
    let targetVersion: string | undefined;
    if (
      version !== undefined &&
      version !== null &&
      String(version).trim() !== ""
    ) {
      const row = await this.versionRepo.findOne({
        where: { applicationId: appId, version: String(version).trim() },
      });
      if (!row) {
        throw new AppError(ErrorCode.APP_ROLLOUT_VERSION_NOT_FOUND, {
          version,
        });
      }
      if (row.status !== "released") {
        throw new AppError(ErrorCode.APP_ROLLOUT_VERSION_NOT_RELEASED);
      }
      const app = await this.appService.findByIdRaw(appId);
      if (app.version !== row.version) {
        const updateDto = this.buildVersionRestoreDto(app, row);
        if (updateDto) await this.appService.update(appId, updateDto, actor);
      }
      targetVersion = row.version;
    }
    // R2 §4.4：覆盖面分组——一次拉全量行（不加 application relation，分组只
    // 需状态/模式标量列），JS 侧按状态分组。RUNNING 内再按 runMode 拆出
    // scheduled（仅部署待触发）单独计数；「已部署设备」默认覆盖两者之和，
    // 与改造前 findRunningByApp 的集合逐字节一致（见方法头实证注释）。
    const allRows = await this.repo.find({
      where: { applicationId: appId },
      order: { createdAt: "DESC" },
    });
    const runningRows = allRows.filter(
      (d) => d.status === DeploymentStatus.RUNNING,
    );
    const stoppedRows = allRows.filter(
      (d) => d.status === DeploymentStatus.STOPPED,
    );
    const inFlightRows = allRows.filter(
      (d) =>
        d.status === DeploymentStatus.PENDING ||
        d.status === DeploymentStatus.DEPLOYING ||
        d.status === DeploymentStatus.UPGRADING,
    );
    const coverage = {
      running: runningRows.filter((d) => d.runMode !== RunMode.SCHEDULED)
        .length,
      scheduled: runningRows.filter((d) => d.runMode === RunMode.SCHEDULED)
        .length,
      stopped: stoppedRows.length,
      failed: allRows.filter((d) => d.status === DeploymentStatus.FAILED)
        .length,
      inFlight: inFlightRows.length,
    };
    // 在途行跳过明细：不抛错（一次 upgrade-all 不应被单台在途行打断），但必须
    // 如实回显。待审批行复用 status=pending 占坑（DEP-04），单独给出原因。
    const skipped = inFlightRows.map((d) => ({
      deploymentId: d.id,
      executorId: d.executorId ?? null,
      status: d.status,
      reason:
        d.status === DeploymentStatus.PENDING &&
        d.approvalStatus === DeploymentApprovalStatus.PENDING_APPROVAL
          ? "awaiting_approval"
          : "in_flight",
    }));
    const deployments = runningRows;
    const strategy = rollout?.strategy ?? "all";

    // ARCH-31: 同应用并发批次守卫（跨实例）——DB 里若已有在途（pending/
    // probing）的灰度行，说明另一个实例正在推进同一应用的批次，直接 409。
    // 此前只有进程内 Map 判重，多实例下两个实例可同时对同一应用开灰度。
    if (strategy === "canary" && deployments.length > 0) {
      const inFlight = await this.findInFlightRolloutRows(appId);
      if (inFlight.length > 0) {
        const owner = (inFlight[0].rolloutMeta as Record<string, any> | null)
          ?.leasedBy;
        return {
          ok: false,
          total: deployments.length,
          succeeded: 0,
          failed: 0,
          coverage,
          skipped,
          ...(targetVersion ? { version: targetVersion } : {}),
          rollout: {
            batchId: String(
              (inFlight[0].rolloutMeta as Record<string, any> | null)
                ?.batchId ?? "unknown",
            ),
            strategy: "canary",
            canaryIds: [],
            promotedIds: [],
            blockedReason: `another rollout batch is in flight for this application (${inFlight.length} row(s) pending/probing${owner ? `, owner=${String(owner)}` : ""})`,
          },
        };
      }
    }

    // all 模式：既有四键形状（ok/total/succeeded/failed）逐字节保持，只**增**
    // coverage/skipped。includeStopped 仅作用于 all 策略——canary 的健康探测
    // 需要活进程，把 stopped 设备扩进灰度只会制造必失败的探测；canary 集合
    // 维持既有「全部 RUNNING 行」口径（scheduled 实证口径已在其中，见上）。
    // canary 空集回退（deployments.length===0）也进本分支：effective 收口保证
    // 「canary 忽略 includeStopped」零例外（回退路径不偷偷扩覆盖）。
    if (strategy !== "canary" || deployments.length === 0) {
      const effectiveIncludeStopped = includeStopped && strategy !== "canary";
      const targets = effectiveIncludeStopped
        ? [...runningRows, ...stoppedRows]
        : runningRows;
      const results = await Promise.allSettled(
        targets.map((d) => this.upgrade(d.id, trigger)),
      );
      const succeeded = results.filter((r) => r.status === "fulfilled").length;
      return {
        ok: true,
        total: targets.length,
        succeeded,
        failed: targets.length - succeeded,
        coverage,
        skipped,
        ...(targetVersion ? { version: targetVersion } : {}),
      };
    }

    const percentage =
      typeof rollout?.percentage === "number" &&
      Number.isFinite(rollout.percentage)
        ? rollout.percentage
        : ROLLOUT_DEFAULT_PERCENTAGE;
    const canaryCount = canaryBatchSize(deployments.length, percentage);
    const canaryRows = deployments.slice(0, canaryCount);
    const promoteRows = deployments.slice(canaryCount);
    const healthCheck = await this.resolveHealthCheck(appId);

    const batchId = `rollout-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2, 8)}`;
    const batch: RolloutBatch = {
      batchId,
      applicationId: appId,
      strategy: "canary",
      percentage,
      healthCheck,
      upgradedIds: canaryRows.map((d) => d.id),
      promotedIds: promoteRows.map((d) => d.id),
      startedAt: Date.now(),
      timer: null,
      tickTimer: null,
      probedIds: new Set<string>(),
    };
    this.rolloutBatches.set(appId, batch);

    // canary 首批触发 upgrade（复用既有单台链：UPGRADING → 心跳 RUNNING），
    // 行级 rolloutState=pending + rolloutMeta 批次痕迹落库。
    for (const d of canaryRows) {
      await this.markRolloutState(d.id, RolloutState.PENDING, {
        batchId,
        role: "canary",
        strategy: "canary",
        percentage,
        upgradedIds: canaryRows.map((x) => x.id),
      });
      try {
        await this.upgrade(d.id, trigger);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        await this.failBatch(batch, d.id, `upgrade trigger failed: ${msg}`);
        return {
          ok: false,
          total: deployments.length,
          succeeded: 0,
          failed: 1,
          coverage,
          skipped,
          ...(targetVersion ? { version: targetVersion } : {}),
          rollout: {
            batchId,
            strategy: "canary",
            canaryIds: [...batch.upgradedIds],
            promotedIds: [...batch.promotedIds],
          },
        };
      }
    }
    this.logger.log(
      `Rollout batch ${batchId} started for app ${appId}: canary ` +
        `${batch.upgradedIds.length}/${deployments.length} (percentage=${percentage}), ` +
        `healthCheck=${healthCheck ? healthCheck.path : "none"}`,
    );

    // 无健康声明：跳过探测，canary 心跳确认后直接提升（由 tick 引擎处理）。
    this.scheduleRolloutTick(appId, ROLLOUT_TICK_MS);
    return {
      ok: true,
      total: deployments.length,
      succeeded: batch.upgradedIds.length,
      failed: 0,
      coverage,
      skipped,
      ...(targetVersion ? { version: targetVersion } : {}),
      rollout: {
        batchId,
        strategy: "canary",
        canaryIds: [...batch.upgradedIds],
        promotedIds: [...batch.promotedIds],
      },
    };
  }

  /** DEP-03：解析应用 manifest 的 healthCheck 声明（宽松解析，非法=null）。 */
  private async resolveHealthCheck(
    appId: string,
  ): Promise<ReturnType<typeof parseManifestHealthCheck>> {
    try {
      const app = await this.appService.findByIdRaw(appId);
      return parseManifestHealthCheck(app?.manifest);
    } catch {
      return null;
    }
  }

  /** 行级批次痕迹落库（不取 raw 面外字段，仅 rolloutState/rolloutMeta 写回，
   *  不触碰 env——掩码风险为零）。 */
  private async markRolloutState(
    deploymentId: string,
    state: RolloutState,
    meta: Record<string, any> | null,
  ): Promise<void> {
    try {
      const row = await this.repo.findOne({ where: { id: deploymentId } });
      if (!row) return;
      // R50（ADR-026 规则 4）：只写这两列，**不整行 save**。整行回写会用本方法读到
      // 的快照覆盖并发的 status / statusMessage / rollout 进度（心跳推进终态、管理员
      // 停止等），而这里要改的只是「批次痕迹」两列——多写一列就是在替别人做决定。
      // adr-026-exempt: 只写 rolloutState / rolloutMeta 两个**批次痕迹列**（patch 里不含
      // status/statusMessage 等状态列）；状态迁移由 handleHeartbeat / 升级链的条件 UPDATE 独占。
      await this.repo.update(
        { id: deploymentId },
        { rolloutState: state, rolloutMeta: meta },
      );
      // 同步内存视图：调用方随后还会读 row 的这两列；列级写不会回灌到已取出的实体。
      row.rolloutState = state;
      row.rolloutMeta = meta;
    } catch (err: unknown) {
      // 批次痕迹写失败不阻断升级主链（fail-open，仅日志）。
      this.logger.warn(
        `Failed to persist rolloutState=${state} for ${deploymentId}: ` +
          (err instanceof Error ? err.message : String(err)),
      );
    }
  }

  // -----------------------------------------------------------------------
  // ARCH-31: 灰度批次的多实例一致性
  // -----------------------------------------------------------------------

  /** 该应用在途（pending/probing）的灰度行——跨实例可见的「批次是否已被占用」。 */
  private async findInFlightRolloutRows(
    appId: string,
  ): Promise<AppDeployment[]> {
    try {
      const rows = await this.repo.find({
        where: {
          applicationId: appId,
          rolloutState: In([RolloutState.PENDING, RolloutState.PROBING]),
        },
      });
      // 客户端二次过滤：仓储 mock / 副本读面可能不带 where 语义，只有行上
      // 真的处在在途态才算「批次被占用」（防御性，判定权归行状态本身）。
      return rows.filter(
        (r) =>
          r.rolloutState === RolloutState.PENDING ||
          r.rolloutState === RolloutState.PROBING,
      );
    } catch (err: unknown) {
      // 查不到就当作没有在途批次（fail-open：宁可放行一次灰度，也不因一次
      // 查询抖动永久拒绝该应用的升级）。
      this.logger.warn(
        `findInFlightRolloutRows failed for ${appId}: ` +
          (err instanceof Error ? err.message : String(err)),
      );
      return [];
    }
  }

  /**
   * 解析部署行所属批次：本实例持有的内存批次优先；否则**从 DB 痕迹重建一个
   * 只读上下文**（hydrated=true），使落在非持有实例上的心跳/回调也能推进
   * 行级状态——此前这些事件被静默丢弃（`if (!batch) return`），批次只能在
   * 收到心跳的那个实例上前进，多实例下灰度大面积卡死。
   *
   * `hint` 用于廉价短路：行上没有任何批次痕迹时不做任何查询（心跳是高频
   * 路径，绝不能为每个心跳多加一次 DB 往返）。
   */
  private async resolveRolloutBatch(
    appId: string,
    hint?: AppDeployment,
  ): Promise<RolloutBatch | null> {
    const owned = this.rolloutBatches.get(appId);
    if (owned) return owned;
    if (hint && !this.hasRolloutTrace(hint)) return null;
    return this.hydrateRolloutBatch(appId);
  }

  /** 行上是否留有批次痕迹（rolloutState 在途，或曾有 batchId）。 */
  private hasRolloutTrace(deployment: AppDeployment): boolean {
    if (
      deployment.rolloutState === RolloutState.PENDING ||
      deployment.rolloutState === RolloutState.PROBING
    ) {
      return true;
    }
    const meta = deployment.rolloutMeta as Record<string, any> | null;
    return !!meta?.batchId;
  }

  /** 从 DB 行痕迹重建批次上下文（不注册定时器、不驱动探测/提升）。 */
  private async hydrateRolloutBatch(
    appId: string,
  ): Promise<RolloutBatch | null> {
    try {
      const rows = await this.findInFlightRolloutRows(appId);
      if (rows.length === 0) return null;
      const meta = (rows[0].rolloutMeta ?? {}) as Record<string, any>;
      const roleOf = (r: AppDeployment) =>
        (r.rolloutMeta as Record<string, any> | null)?.role;
      return {
        batchId: String(meta.batchId ?? `restored-${appId}`),
        applicationId: appId,
        strategy: "canary",
        percentage:
          typeof meta.percentage === "number"
            ? meta.percentage
            : ROLLOUT_DEFAULT_PERCENTAGE,
        healthCheck: await this.resolveHealthCheck(appId),
        upgradedIds: rows
          .filter((r) => roleOf(r) !== "promoted")
          .map((r) => r.id),
        promotedIds: rows
          .filter((r) => roleOf(r) === "promoted")
          .map((r) => r.id),
        startedAt: rows[0].updatedAt
          ? new Date(rows[0].updatedAt).getTime()
          : Date.now(),
        timer: null,
        tickTimer: null,
        hydrated: true,
        probedIds: new Set<string>(),
      };
    } catch (err: unknown) {
      this.logger.warn(
        `hydrateRolloutBatch failed for ${appId}: ` +
          (err instanceof Error ? err.message : String(err)),
      );
      return null;
    }
  }

  /**
   * 条件 UPDATE 认领：把仍处于在途态的行批量置为 `toState`，返回是否命中。
   * 多实例下「谁先把在途行终结，谁负责后续补偿（自动回滚）」——未命中的
   * 实例直接退出，避免两台实例对同一批执行器重复回滚。
   */
  private async claimRolloutRows(
    ids: string[],
    fromStates: RolloutState[],
    toState: RolloutState,
  ): Promise<boolean> {
    if (ids.length === 0) return false;
    try {
      const result = await this.repo
        .createQueryBuilder()
        .update(AppDeployment)
        .set({ rolloutState: toState })
        .where("id IN (:...ids)", { ids })
        .andWhere("rolloutState IN (:...fromStates)", { fromStates })
        .execute();
      return (result.affected ?? 0) > 0;
    } catch (err: unknown) {
      this.logger.warn(
        `claimRolloutRows failed (fallback to proceed): ` +
          (err instanceof Error ? err.message : String(err)),
      );
      // 认领失败（DB 抖动）不阻断失败处理——宁可重复一次回滚，也不能
      // 因为条件 UPDATE 异常而永久跳过自动回滚。
      return true;
    }
  }

  /** 刷新批次活性租约（滚动重启时新实例据此判断「有实例仍在推进」）。 */
  private async touchRolloutLease(batch: RolloutBatch): Promise<void> {
    const id = batch.upgradedIds[0];
    if (!id) return;
    try {
      // 与 markRolloutState 同形态（findOne + save）：jsonb 列走 QueryBuilder
      // 的 set() 会撞 TypeORM 的类型收窄，且本路径不需要原子性。
      const row = await this.repo.findOne({ where: { id } });
      if (!row) return;
      const nextMeta = {
        ...((row.rolloutMeta as Record<string, any>) ?? {}),
        ...this.lastRolloutMeta(batch),
        leasedAt: new Date().toISOString(),
        leasedBy: ROLLOUT_INSTANCE_ID,
      };
      // R50：同 markRolloutState——只写 rolloutMeta 一列。jsonb 会被
      // _QueryDeepPartialEntity 深度收窄（字面量报 TS2322），故用一次窄化断言；
      // 这只是编译期问题，退回 save() 会重新引入「覆盖并发列」的真实缺陷。
      // adr-026-exempt: 只写 rolloutMeta 一列（租约心跳，advisory）；不碰任何状态列。
      await this.repo.update({ id }, {
        rolloutMeta: nextMeta,
      } as unknown as Parameters<typeof this.repo.update>[1]);
      row.rolloutMeta = nextMeta;
    } catch {
      // 租约刷新是尽力而为（失败仅影响滚动重启时的 sweep 判据）
    }
  }

  private lastRolloutMeta(
    batch: RolloutBatch,
  ): Record<string, any> | undefined {
    return { batchId: batch.batchId, strategy: batch.strategy };
  }

  /** DEP-02：handleHeartbeat 钩子——批次在途时，RUNNING 确认把行推进到
   *  probing（健康探测阶段）。FAILED/STOPPED 上报直接判批次失败。 */
  private async notifyHeartbeatToRollout(
    deployment: AppDeployment,
  ): Promise<void> {
    const batch = await this.resolveRolloutBatch(
      deployment.applicationId,
      deployment,
    );
    if (!batch) return;
    if (batch.upgradedIds.includes(deployment.id)) {
      if (deployment.status === DeploymentStatus.RUNNING) {
        await this.markRolloutState(deployment.id, RolloutState.PROBING, {
          batchId: batch.batchId,
          role: "canary",
          heartbeatConfirmedAt: new Date().toISOString(),
          ...(batch.hydrated ? {} : { leasedBy: ROLLOUT_INSTANCE_ID }),
        });
        // 探测与提升只由批次持有实例驱动（hydrated 上下文不持定时器、
        // 不启探测，避免两个实例同时对同一批执行器推进）。
        if (batch.healthCheck && !batch.hydrated) {
          if (!batch.probedIds) batch.probedIds = new Set<string>();
          if (!batch.probedIds.has(deployment.id)) {
            batch.probedIds.add(deployment.id);
            void this.probeDeployment(batch, deployment.id);
          }
        }
        // 无健康声明：tick 引擎看到「pending 全部清空」即提升。
      } else if (
        deployment.status === DeploymentStatus.FAILED ||
        deployment.status === DeploymentStatus.STOPPED
      ) {
        await this.failBatch(
          batch,
          deployment.id,
          `heartbeat reported ${deployment.status}`,
        );
      }
      return;
    }
    // 提升轮（promotedIds）同样吃心跳确认：RUNNING → promoted。
    if (
      batch.promotedIds.includes(deployment.id) &&
      deployment.status === DeploymentStatus.RUNNING
    ) {
      await this.markRolloutState(deployment.id, RolloutState.PROMOTED, {
        batchId: batch.batchId,
        role: "promoted",
      });
      batch.promotedIds = batch.promotedIds.filter((x) => x !== deployment.id);
      if (batch.promotedIds.length === 0)
        await this.finishBatch(batch.applicationId);
    }
  }

  /** 提升轮结束：清批次内存态 + **行态收口**（行上 promoted 痕迹保留供读面）。 */
  private async finishBatch(appId: string): Promise<void> {
    const batch = this.rolloutBatches.get(appId);
    if (!batch) return;
    this.clearBatchTimers(batch);
    this.rolloutBatches.delete(appId);
    // ARCH-31 真机验证抓到的缺陷（跨实例灰度套件）：此前只清内存态，canary
    // 命中台的行**永远停在 probing**——①findInFlightRolloutRows 因此把该应用
    // 永久判定为「有批次在途」，后续任何 canary 都被互斥挡死（blockedReason
    // 一直存在）；②滚动重启时 sweep 会把这条陈旧在途行误标 failed（噪音）。
    // 收口为 promoted（终态），只动 pending/probing，不覆盖 failed/rolled_back
    // 的真实失败痕迹。
    await this.settleRolloutRows(
      [...batch.upgradedIds, ...batch.promotedIds],
      RolloutState.PROMOTED,
    );
    this.logger.log(`Rollout batch ${batch.batchId} finished (promoted all)`);
  }

  /**
   * 把给定行的**在途态**（pending/probing）收口到终态 state。
   * 条件 UPDATE 只命在途行：已 failed/rolled_back/promoted 的行不受影响，
   * 重复调用幂等。DB 抖动只记 warn（收口是收尾动作，失败不改变批次结论）。
   */
  private async settleRolloutRows(
    ids: string[],
    state: RolloutState,
  ): Promise<void> {
    if (ids.length === 0) return;
    try {
      await this.repo
        .createQueryBuilder()
        .update(AppDeployment)
        .set({ rolloutState: state })
        .where("id IN (:...ids)", { ids })
        .andWhere("rolloutState IN (:...from)", {
          from: [RolloutState.PENDING, RolloutState.PROBING],
        })
        .execute();
    } catch (err: unknown) {
      this.logger.warn(
        `settleRolloutRows(${state}) failed (rows keep in-flight state): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /** DEP-02：批次失败——暂停批次 + 对已升级（含 probing）台自动回滚 +
   *  meta 记录失败原因。自动回滚=对每台走「重新部署上一版本」既有链；
   *  触发失败的台自身若未升上去则仅标记不回滚。 */
  private async failBatch(
    batch: RolloutBatch,
    failedId: string,
    reason: string,
  ): Promise<void> {
    // ARCH-31: 条件 UPDATE 认领终结权——多实例下心跳/探测可能同时落到多个
    // 实例，只有第一个把在途行置为 failed 的实例执行后续自动回滚，避免对
    // 同一批执行器重复回滚（claim 未命中 = 别的实例已收尾）。
    const claimed = await this.claimRolloutRows(
      [failedId, ...batch.upgradedIds.filter((x) => x !== failedId)],
      [RolloutState.PENDING, RolloutState.PROBING],
      RolloutState.FAILED,
    );
    if (!claimed) {
      this.logger.warn(
        `Rollout batch ${batch.batchId} already terminated by another instance — skipping duplicate rollback (reason: ${reason})`,
      );
      this.clearBatchTimers(batch);
      this.rolloutBatches.delete(batch.applicationId);
      return;
    }
    this.clearBatchTimers(batch);
    this.rolloutBatches.delete(batch.applicationId);
    const failedIds = batch.upgradedIds.filter((x) => x !== failedId);
    this.logger.error(
      `Rollout batch ${batch.batchId} failed (${reason}) — rolling back ` +
        `${failedIds.length} upgraded deployment(s)`,
    );
    for (const id of failedIds) {
      await this.markRolloutState(id, RolloutState.FAILED, {
        batchId: batch.batchId,
        failureReason: reason,
      });
      try {
        await this.rollbackDeploymentToPrevious(id, {
          operator: null,
          triggerType: DeploymentTriggerType.ROLLBACK,
        });
        await this.markRolloutState(id, RolloutState.ROLLED_BACK, {
          batchId: batch.batchId,
          failureReason: reason,
        });
      } catch (err: unknown) {
        this.logger.error(
          `Auto-rollback failed for ${id}: ` +
            (err instanceof Error ? err.message : String(err)),
        );
      }
    }
    await this.markRolloutState(failedId, RolloutState.FAILED, {
      batchId: batch.batchId,
      failureReason: reason,
    });
  }

  /** DEP-03：单台自动回滚——「重新部署上一版本」。复用既有版本快照链：
   * 取该部署行 deployedVersion 之外的最近一个 released 快照（时间倒序），
   * 有则把快照字段恢复到本台 push（upgradeWithSnapshot）；无上一版本可回退
   * 时仅记录（fail-safe：保持新版本运行比把行打成 FAILED 更可预期）。 */
  async rollbackDeploymentToPrevious(
    deploymentId: string,
    trigger?: DeploymentTriggerContext,
  ): Promise<void> {
    const deployment = await this.findByIdRaw(deploymentId);
    const versions = await this.versionRepo.find({
      where: { applicationId: deployment.applicationId, status: "released" },
      order: { createdAt: "DESC" },
      // P2-6：只需「除当前版本外最近的一个 released 快照」。版本按时间倒序，
      // uq(applicationId, version) 保证同一版本至多一行——take 2 即覆盖最坏
      // 情形（versions[0]=当前版本，versions[1]=上一版本）；全量拉取会随版本
      // 历史线性膨胀。
      take: 2,
    });
    const previous = versions.find((v) => {
      if (!v.version) return false;
      return v.version !== (deployment.deployedVersion ?? null);
    });
    if (!previous) {
      this.logger.warn(
        `No previous released version to roll back for ${deploymentId} ` +
          `(current=${deployment.deployedVersion ?? "unknown"})`,
      );
      return;
    }
    await this.upgradeWithSnapshot(deployment, previous, trigger);
    // D3-B-P2-1: rollback 执行门落证（回退到上一版本）。
    await this.writeTransitionAudit("deployment.rollback", deployment, {
      previousVersion: previous.version,
    });
  }

  /** 快照回退的单台升级（快照字段恢复→pushDeployToExecutor upgrade 链）。
   *  注意：只恢复本台 push 载荷所需字段，不写 applications 表——应用当前
   *  版本是否随之回退属批次外决策（全量回退请走既有 rollback 端点）。 */
  private async upgradeWithSnapshot(
    deployment: AppDeployment,
    version: {
      version: string;
      gitCommit: string | null;
      snapshot: Record<string, any>;
    },
    trigger?: DeploymentTriggerContext,
  ): Promise<void> {
    const snapshot = version.snapshot ?? {};
    // R1：回退 push 用原始 env（掩码面不得进入发送路径）。
    const app = await this.appService.findByIdRaw(deployment.applicationId);
    const pushApp: Application = {
      ...app,
      version: version.version,
    } as Application;
    if (typeof version.gitCommit === "string")
      pushApp.gitCommit = version.gitCommit;
    if (typeof snapshot.packageUrl === "string")
      pushApp.packageUrl = snapshot.packageUrl;
    if (typeof snapshot.gitBranch === "string")
      pushApp.gitBranch = snapshot.gitBranch;
    if (snapshot.env && typeof snapshot.env === "object") {
      pushApp.env = snapshot.env as Record<string, string>;
    }
    if (typeof snapshot.entrypoint === "string")
      pushApp.entrypoint = snapshot.entrypoint;
    // A-4: 同 upgrade()——回滚推送前把 startCommand 同步为本次目标（快照）
    // entrypoint。否则推送载荷 entrypoint = startCommand || app.entrypoint
    // 仍被部署时的陈旧快照压住，rollbackApplication / 本链恢复的 entrypoint
    // 永远推不出去（回滚后推送载荷 entrypoint 必须等于快照值）。
    deployment.startCommand =
      pushApp.entrypoint ?? deployment.startCommand ?? null;
    deployment.status = DeploymentStatus.UPGRADING;
    deployment.statusMessage = `Rolling back to ${version.version}`;
    // FEAT-20: 自动回滚痕迹（rollback 语义；operator 保留原行值——
    // 机器触发的自动回滚无人工操作者）。
    if (trigger) {
      deployment.triggerType = trigger.triggerType;
      deployment.operator = trigger.operator;
    }
    // E-P1-R2：乐观锁收口——并发后写撞版本转 409。
    await this.saveWithOptimisticLock(deployment);
    await this.pushDeployToExecutor(deployment, pushApp, true);
  }

  /** DEP-03：逐台健康探测——GET http://<host>:<port><path>，
   *  interval 间隔重试 failThreshold 次；探活成功即提升其余台；窗口耗尽
   *  失败 → failBatch（自动回滚已升级台）。 */
  /**
   * NETOPT-1①: 探测以 `void` fire-and-forget 启动（心跳确认路径 + tick 驱动
   * 路径），而内部 failBatch（claimRolloutRows/markRolloutState 等 DB 写）与
   * promoteRest 均不在任何 try/catch 内——同 rolloutTick 的 unhandledRejection
   * 整实例退出风险。全程兜底：记日志、不外抛、不推进批次状态（行保持
   * probing/pending，由 tick 的硬超时分支兜底收尾）。
   */
  private async probeDeployment(
    batch: RolloutBatch,
    deploymentId: string,
  ): Promise<void> {
    try {
      await this.probeDeploymentInner(batch, deploymentId);
    } catch (err: unknown) {
      this.logger.error(
        `Health probe for deployment ${deploymentId} (batch ${batch.batchId}) failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  private async probeDeploymentInner(
    batch: RolloutBatch,
    deploymentId: string,
  ): Promise<void> {
    const hc = batch.healthCheck;
    if (!hc) return;
    let deployment: AppDeployment;
    try {
      deployment = await this.findByIdRaw(deploymentId);
    } catch {
      await this.failBatch(batch, deploymentId, "deployment row vanished");
      return;
    }
    const url = this.buildProbeUrl(
      deployment.executorAddress,
      hc.port,
      hc.path,
    );
    if (!url) {
      await this.failBatch(
        batch,
        deploymentId,
        "invalid executor address for probe",
      );
      return;
    }
    // R-07（DEEP_REVIEW 0ef3bbe）：探针是 admin→执行器侧的出站请求，且主机名
    // 来自执行器自报地址（register/heartbeat 可注入）——此前未过 SSRF 策略，
    // 构成「管理员写入 manifest 端口/路径 + 投毒执行器地址」的内网盲探 oracle
    // （2xx-4xx 即判定端口存活，可枚举内网服务）。此处与 deploy/stop/dispatch
    // 走同一套 assertSafeExecutorUrl（loopback/云元数据/restricted 恒拒，
    // private-LAN 放行、EXECUTOR_ALLOW_PRIVATE_NETWORK 可豁免 loopback），
    // 与同文件 deploy 面姿态对齐。拒绝时 fail-closed 直接判批次失败，不盲探。
    // F-3（SEC-NEW）: 同时 pin 到校验通过的 IP——探针若经域名逐次 rebind，
    // 同样可把请求打到内网其他主机。
    let pinned: PinnedHttpTarget;
    try {
      pinned = await assertAndPinExecutorUrl(url);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      await this.failBatch(
        batch,
        deploymentId,
        `health probe URL refused: ${msg}`,
      );
      return;
    }
    const pinCfg = pinnedAxiosConfig(pinned);
    const attempts = hc.failThreshold;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      const ok = await this.probeOnce(url, pinCfg, hc.timeoutMs);
      if (ok) {
        this.logger.log(
          `Health probe passed for ${deploymentId} (attempt ${attempt}/${attempts}): ${url}`,
        );
        await this.promoteRest(batch);
        return;
      }
      if (attempt < attempts) {
        await this.waitMs(hc.interval, batch);
      }
    }
    await this.failBatch(
      batch,
      deploymentId,
      `health probe failed after ${attempts} attempts: ${url}`,
    );
  }

  /** 探测 URL 组装：host 取执行器地址（R8 语义——地址本就执行器可控，
   *  探针端口/路径来自应用 manifest（管理员写入面））；端口缺省回退执行器
   *  地址端口。纯函数（public 便于测试）。 */
  buildProbeUrl(
    executorAddress: string,
    manifestPort: number | null,
    pathName: string,
  ): string | null {
    let hostname: string | null = null;
    let port: number | null = null;
    if (
      executorAddress.startsWith("http://") ||
      executorAddress.startsWith("https://")
    ) {
      try {
        const u = new URL(executorAddress);
        hostname = u.hostname;
        port = u.port ? Number(u.port) : null;
      } catch {
        return null;
      }
    } else {
      // host:port 形态（含 [IPv6]:port）；无端口的裸主机名也放行——探测
      // 端口此时必须由 manifest.port 显式提供。
      const m = executorAddress.match(
        /^(\[[a-zA-Z0-9:]+\]|[a-zA-Z0-9._-]+)(?::([0-9]{1,5}))?$/,
      );
      if (!m) return null;
      hostname = m[1];
      port = m[2] ? Number(m[2]) : null;
    }
    if (!hostname) return null;
    // IPv6 全文本形（含冒号）需方括号；形如 [::1] 已带括号原样保留；其余
    // （IPv4/主机名）直拼。
    let hostPart = hostname;
    const bareIpv6 =
      hostname.includes(":") &&
      !hostname.startsWith("[") &&
      (hostname.match(/:/g)?.length ?? 0) > 1;
    if (bareIpv6) hostPart = `[${hostname}]`;
    const finalPort = manifestPort ?? port;
    return `http://${hostPart}${finalPort ? `:${finalPort}` : ""}${pathName}`;
  }

  /** 单次探测：任何 2xx-4xx 状态=探活成功（端口有活体即认为应用可路由）；
   *  5xx/超时/网络错=失败。 */
  private async probeOnce(
    url: string,
    pinCfg: ReturnType<typeof pinnedAxiosConfig>,
    timeoutMs: number,
  ): Promise<boolean> {
    try {
      const res = await axios.get(url, {
        timeout: timeoutMs,
        maxRedirects: 0,
        validateStatus: (s) => s >= 200 && s < 500,
        ...pinCfg,
      });
      return res.status < 500;
    } catch {
      return false;
    }
  }

  /** canary 全部通过后提升其余台：逐台 upgrade + rolloutState=pending，
   *  其心跳确认（RUNNING→promoted）由 notifyHeartbeatToRollout 处理。 */
  private async promoteRest(batch: RolloutBatch): Promise<void> {
    if (batch.promotedIds.length === 0) {
      await this.finishBatch(batch.applicationId);
      return;
    }
    const promoteIds = [...batch.promotedIds];
    this.logger.log(
      `Rollout batch ${batch.batchId}: promoting remaining ${promoteIds.length} deployment(s)`,
    );
    for (const id of promoteIds) {
      await this.markRolloutState(id, RolloutState.PENDING, {
        batchId: batch.batchId,
        role: "promoted",
        strategy: "canary",
        percentage: batch.percentage,
        upgradedIds: promoteIds,
      });
      try {
        await this.upgrade(id);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        await this.failBatch(batch, id, `promotion upgrade failed: ${msg}`);
        return;
      }
    }
    // promotedIds 的逐台清空发生在心跳确认侧；此处同步置空避免批次硬超时
    // 误判（promote 轮心跳可能晚于 tick 节奏）。
    batch.promotedIds = [];
  }

  /** 批次推进 tick（进程内 setTimeout 队列，先例 outbound-event-dispatcher）：
   *  ① canary pending 台心跳窗（ROLLOUT_HEARTBEAT_WINDOW_MS）超时判失败；
   *  ② 无健康声明时 pending 全部确认 → 直接提升；
   *  ③ 批次硬超时（ROLLOUT_BATCH_TIMEOUT_MS）兜底收尾。 */
  private scheduleRolloutTick(appId: string, delayMs: number): void {
    const batch = this.rolloutBatches.get(appId);
    if (!batch) return;
    const t = setTimeout(() => {
      this.rolloutTimers.delete(t);
      void this.rolloutTick(appId);
    }, delayMs);
    this.rolloutTimers.add(t);
    batch.tickTimer = t;
  }

  /**
   * NETOPT-1①: 批次推进 tick 以 `void` fire-and-forget 运行（scheduleRolloutTick
   * 的 setTimeout 回调），而方法体内的 repo.find / failBatch / touchRolloutLease
   * 等 DB 读写此前均不在任何 try/catch 内——一次瞬时 DB 抖动就会以
   * unhandledRejection 冒泡到 main.ts 的 process.on("unhandledRejection") →
   * gracefulFatalShutdown → 整实例退出。此处全程兜底（对齐 outbox-dispatcher
   * scanOnce 的「绝不外抛」纪律）：记日志、不外抛、不改批次/行状态；批次仍在
   * 途则续排下一 tick 重试，硬超时收尾由下一 tick 顶部的兜底分支裁决。
   */
  private async rolloutTick(appId: string): Promise<void> {
    const batch = this.rolloutBatches.get(appId);
    if (!batch) return;
    try {
      await this.rolloutTickInner(appId, batch);
    } catch (err: unknown) {
      this.logger.error(
        `Rollout tick for batch ${batch.batchId} failed (batch kept, retry on next tick): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      // 批次仍在途（未被 failBatch 收尾删除）才续排；行级状态保持不动。
      if (this.rolloutBatches.has(appId)) {
        this.scheduleRolloutTick(appId, ROLLOUT_TICK_MS);
      }
    }
  }

  private async rolloutTickInner(
    appId: string,
    batch: RolloutBatch,
  ): Promise<void> {
    if (Date.now() - batch.startedAt > ROLLOUT_BATCH_TIMEOUT_MS) {
      const stuckId = batch.upgradedIds[0];
      await this.failBatch(batch, stuckId, "batch hard timeout");
      return;
    }

    // canary pending 行心跳确认进度：确认过的行已被 notifyHeartbeatToRollout
    // 推到 probing/promoted；行读面核对。
    const rows = await this.repo.find({
      where: { id: In(batch.upgradedIds) },
    });
    const stillPending = rows.filter(
      (r) => r.rolloutState === RolloutState.PENDING,
    );
    const windowExpired =
      Date.now() - batch.startedAt > ROLLOUT_HEARTBEAT_WINDOW_MS;

    if (windowExpired && stillPending.length > 0) {
      await this.failBatch(
        batch,
        stillPending[0].id,
        `heartbeat confirmation window (${ROLLOUT_HEARTBEAT_WINDOW_MS}ms) expired`,
      );
      return;
    }

    // ARCH-31: 批次已被其他实例终结（行全部落入 failed/rolled_back）→ 本实例
    // 立即收尾，避免继续沿 promoteRest 推进一个已被判失败的批次。
    const active = rows.some(
      (r) =>
        r.rolloutState === RolloutState.PENDING ||
        r.rolloutState === RolloutState.PROBING ||
        r.rolloutState === RolloutState.PROMOTED,
    );
    if (!active) {
      this.clearBatchTimers(batch);
      this.rolloutBatches.delete(appId);
      this.logger.warn(
        `Rollout batch ${batch.batchId} no longer active in DB — dropped from this instance`,
      );
      return;
    }

    if (stillPending.length === 0) {
      if (!batch.healthCheck) {
        // 无健康声明：跳过探测直接提升。
        await this.promoteRest(batch);
        // ARCH-31 真机验证抓到的缺陷（跨实例灰度套件）：此前这里直接 return，
        // **不再排下一次 tick**——提升轮把其余台 upgrade 出去后，批次再也没有
        // 机会调用 finishBatch：内存批次永久驻留、A 日志永不出现 finished、
        // canary 命中台永远停在 probing（随后被互斥判定「有批次在途」挡死该应用
        // 的后续灰度）。提升轮不是终点：还要等 promote 台的心跳确认并在下一次
        // tick 收尾，故此处继续排 tick（已收尾/已被终结则不再排）。
        if (!this.rolloutBatches.has(appId)) return;
        await this.touchRolloutLease(batch);
        this.scheduleRolloutTick(appId, ROLLOUT_TICK_MS);
        return;
      }
      // ARCH-31: 探测补驱——心跳若落在别的实例（只把行推进到 probing），
      // 持有者实例的 tick 在此接管探测，避免该台永远停在 probing 直到硬超时。
      for (const r of rows) {
        if (
          r.rolloutState === RolloutState.PROBING &&
          !batch.probedIds?.has(r.id)
        ) {
          batch.probedIds?.add(r.id);
          void this.probeDeployment(batch, r.id);
        }
      }
      // 探测在心跳确认时各自启动（probeDeployment 窗口）；全部行已 promoted
      // 说明探测通过路径已收尾。probing 在途则继续等下一 tick。
      const promoted = rows.filter(
        (r) => r.rolloutState === RolloutState.PROMOTED,
      );
      if (promoted.length === rows.length) {
        await this.finishBatch(appId);
        return;
      }
    }

    // ARCH-31: 刷新活性租约（滚动重启时新起的实例据此保留在途批次）
    await this.touchRolloutLease(batch);
    this.scheduleRolloutTick(appId, ROLLOUT_TICK_MS);
  }

  /** 退避等待（登记句柄供 OnModuleDestroy 统一清理）。 */
  private waitMs(ms: number, batch: RolloutBatch): Promise<void> {
    return new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        this.rolloutTimers.delete(t);
        resolve();
      }, ms);
      this.rolloutTimers.add(t);
      batch.timer = t;
    });
  }

  private clearBatchTimers(batch: RolloutBatch): void {
    if (batch.timer) {
      clearTimeout(batch.timer);
      this.rolloutTimers.delete(batch.timer);
      batch.timer = null;
    }
    if (batch.tickTimer) {
      clearTimeout(batch.tickTimer);
      this.rolloutTimers.delete(batch.tickTimer);
      batch.tickTimer = null;
    }
  }

  /**
   * P0-4 附带（生产报告 2026-10-22 §7 P0-3 末条）：地址漂移 → 部署行地址快照跟着滚。
   *
   * 为什么需要：`app_deployments.executorAddress` 是**快照**，此前从不随漂移更新。
   * 执行器换网/换 IP（ADR-017 §2 的正常形态）之后，任何按快照地址出站的路径
   * （push 回退、包推送、UI 展示「部署在哪台」）都停在**已失效的旧地址**上——
   * 这正是 §4.2 「静默回退 push 打到 198.18.0.1:8002」那条链路能一直成立的一半原因
   * （另一半是悬空 id，已由 unresolved 三态修掉）。
   *
   * 口径：
   *  - 只滚**未终结**行（pending/deploying/running/upgrading）：终态行的地址是
   *    历史事实，串改会让「当时部署在哪台」失真；
   *  - 条件更新带 `executorAddress = previousAddress`：已被并发写过（比如又一次
   *    漂移）的行不会被本事件的旧值覆盖回去；
   *  - 按 executorId 匹配（不是 address）：同址多行时不会误伤别人那行。
   */
  private readonly handleExecutorAddressDrifted = (
    payload: ExecutorAddressDriftedEventPayload,
  ): void => {
    void this.refreshExecutorAddressSnapshot(payload).catch((err: unknown) => {
      this.logger.warn(
        `Failed to roll deployment address snapshot for executor ${payload?.executorId}: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    });
  };

  /**
   * 地址快照滚动的实现体（返回受影响行数，供单测断言）。
   * 语义见 handleExecutorAddressDrifted 头注。
   */
  async refreshExecutorAddressSnapshot(
    payload: ExecutorAddressDriftedEventPayload,
  ): Promise<number> {
    if (!payload?.executorId || !payload.address) return 0;
    const previousAddress = payload.previousAddress;
    if (!previousAddress || previousAddress === payload.address) return 0;
    const applied = await this.repo.update(
      {
        executorId: payload.executorId,
        executorAddress: previousAddress,
        status: In([
          DeploymentStatus.PENDING,
          DeploymentStatus.DEPLOYING,
          DeploymentStatus.RUNNING,
          DeploymentStatus.UPGRADING,
        ]),
      },
      { executorAddress: payload.address },
    );
    const affected = applied?.affected ?? 0;
    if (affected > 0) {
      this.logger.log(
        `Rolled ${affected} deployment snapshot(s) of executor ${payload.executorId} ` +
          `from ${previousAddress} to ${payload.address} (address drift adopted)`,
      );
    }
    return affected;
  }

  /**
   * P0-4（生产报告 2026-10-22 §4.4）：「pull 部署命令执行失败」→ 立刻收 FAILED。
   *
   * 旧链路的三处叠加造成用户体感「点部署没反应」：
   *   ① 部署行入 pull 队列后只记 `commandId`，失败回执**不推进行**；
   *   ② 卡死扫描对带 `Deploy command queued` 前缀的 pull 未决行豁免到**命令 TTL
   *      30 分钟**；
   *   ③ 期间同一应用的任何 deploy 都被在途锁拒成 409（现场 6 次）。
   * 现在执行器上报 ok=false 时由本订阅方秒级收口，槽位立即释放。
   *
   * 为什么必须**条件写**（而不是无条件 update）：同一应用重新部署后，行的
   * statusMessage 会换成新的 commandId，此时**旧命令**的迟到失败绝不能把新行
   * 打成 FAILED（那会把一次成功的重部署回滚成失败）。判据就落在
   * `statusMessage LIKE '%commandId=<本次 id>%'` 上——行还认这条命令，才动它。
   */
  private readonly handleExecutorCommandFailed = (
    payload: ExecutorCommandFailedEventPayload,
  ): void => {
    // 总线本身 fail-open；这里再兜一层并 fire-and-forget——命令结果上报的
    // HTTP 响应绝不等待这次 DB 写。
    void this.failDeploymentForFailedCommand(payload).catch((err: unknown) => {
      this.logger.warn(
        `Failed to mark deployment for failed pull command ${payload?.commandId}: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    });
  };

  /**
   * 条件写的实现体（返回是否真的收了口，供单测断言）。
   *
   * 与 `failDeploymentIfInFlight` 的差异：那条判据只看「行是否仍在飞」，这里
   * 还要看「行是否仍属于这条命令」——pull 命令是**带 commandId 的异步调用**，
   * 而 HTTP push 失败是同步窗口，两者需要不同强度的护栏。
   */
  async failDeploymentForFailedCommand(
    payload: ExecutorCommandFailedEventPayload,
  ): Promise<boolean> {
    if (!payload || payload.type !== "deploy" || !payload.deploymentId) {
      return false;
    }
    const commandId = payload.commandId;
    if (!commandId) return false;
    const message =
      `[Executor] Deploy command failed on ${payload.address}: ` +
      `${payload.error ?? "unknown error"}`;
    const applied = await this.repo.update(
      {
        id: payload.deploymentId,
        status: In([
          DeploymentStatus.PENDING,
          DeploymentStatus.DEPLOYING,
          DeploymentStatus.UPGRADING,
        ]),
        statusMessage: Like(`%commandId=${commandId}%`),
      },
      { status: DeploymentStatus.FAILED, statusMessage: message },
    );
    if (!applied?.affected) {
      // 正常竞态：行已被心跳推进到终态，或已被**新的**部署命令接管。
      // 不写、只留 debug（这不是错误，是"让后来的写者看见别人已经写完"）。
      this.logger.debug(
        `Ignored failed pull command ${commandId}: deployment ${payload.deploymentId} is no ` +
          `longer in flight for this command`,
      );
      return false;
    }
    this.logger.warn(
      `Deploy ${payload.deploymentId} marked FAILED immediately: pull command ${commandId} ` +
        `failed on ${payload.address} — ${payload.error ?? "unknown error"} ` +
        `(previously this row waited for the 30-minute stuck sweep; its in-flight slot is free now)`,
    );
    return true;
  }

  /** 优雅关闭：清全部批次 timer（进程内批次随之丢弃，行级 pending/probing
   *  痕迹由重启 sweep 标记 failed）。 */
  onModuleDestroy(): void {
    for (const t of this.rolloutTimers) clearTimeout(t);
    this.rolloutTimers.clear();
    this.rolloutBatches.clear();
    // P0-4: 与 onModuleInit 的订阅成对（不 off 会让总线持有已销毁实例，
    // 热重载/多实例测试里表现为重复处理）。
    this.eventBus?.off(
      DOMAIN_EVENTS.EXECUTOR_COMMAND_FAILED,
      this.handleExecutorCommandFailed,
    );
    this.eventBus?.off(
      DOMAIN_EVENTS.EXECUTOR_ADDRESS_DRIFTED,
      this.handleExecutorAddressDrifted,
    );
  }

  /** DEP-02：服务重启收尾——进程内批次不恢复（最低正确形态），把所有
   *  pending/probing 行标记 failed（文档写明：重启即暂停灰度，人工重发）。 */
  async onModuleInit(): Promise<void> {
    // P0-4（生产报告 2026-10-22 §4.4）：订阅「pull 控制命令执行失败」，
    // 把在飞行立刻收成 FAILED（详见 handleExecutorCommandFailed 头注）。
    // eventBus 为 @Optional：未装配的存量单测/裁剪装配下静默跳过。
    this.eventBus?.on(
      DOMAIN_EVENTS.EXECUTOR_COMMAND_FAILED,
      this.handleExecutorCommandFailed,
    );
    // P0-4 附带：地址漂移 → 把未终结部署行的地址快照滚到新地址（§7 P0-3 末条）。
    this.eventBus?.on(
      DOMAIN_EVENTS.EXECUTOR_ADDRESS_DRIFTED,
      this.handleExecutorAddressDrifted,
    );
    try {
      await this.markInterruptedRolloutsFailed();
    } catch (err: unknown) {
      // DB 尚不可达等启动期异常不阻断应用引导（既有 cron sweep 2 分钟后兜底）。
      this.logger.warn(
        `Rollout restart sweep failed: ` +
          (err instanceof Error ? err.message : String(err)),
      );
    }
  }

  /** DEP-02：重启 sweep 本体——pending/probing 行标记 failed。 */
  async markInterruptedRolloutsFailed(): Promise<number> {
    const stale = await this.repo.find({
      where: [
        { rolloutState: RolloutState.PENDING },
        { rolloutState: RolloutState.PROBING },
      ],
    });
    // ARCH-31: 跳过「别的实例仍在推进」的批次——滚动重启时新起的实例若
    // 一律标 failed，会把另一个实例正在跑的灰度直接打断（多实例下的真实
    // 破坏路径）。判据=行上 rolloutMeta.leasedAt 落在宽限窗内。
    const now = Date.now();
    const orphaned = stale.filter((d) => {
      const meta = d.rolloutMeta as Record<string, any> | null;
      const leasedAt = meta?.leasedAt ? Date.parse(String(meta.leasedAt)) : NaN;
      return !(
        Number.isFinite(leasedAt) && now - leasedAt < ROLLOUT_LEASE_GRACE_MS
      );
    });
    const skipped = stale.length - orphaned.length;
    if (skipped > 0) {
      this.logger.log(
        `Rollout restart sweep: skipped ${skipped} row(s) with a fresh lease (another instance is driving them)`,
      );
    }
    // O-1: one batched UPDATE instead of N per-row save() round-trips. The
    // rolloutMeta merge is done in SQL (jsonb ||) so each row keeps its own
    // batch metadata while failureReason is appended; COALESCE covers NULL rows.
    if (orphaned.length > 0) {
      const orphanedIds = orphaned.map((d) => d.id);
      await this.repo
        .createQueryBuilder()
        .update(AppDeployment)
        .set({
          rolloutState: RolloutState.FAILED,
          rolloutMeta: () =>
            `COALESCE("rolloutMeta", '{}'::jsonb) || '{"failureReason":"admin-api restarted — rollout batch not resumed"}'::jsonb`,
        })
        .where("id IN (:...ids)", { ids: orphanedIds })
        .execute();
      this.logger.warn(
        `Marked ${orphaned.length} interrupted rollout deployment(s) as failed after restart`,
      );
    }
    return orphaned.length;
  }
}
