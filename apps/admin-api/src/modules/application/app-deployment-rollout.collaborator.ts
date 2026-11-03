import { Logger } from "@nestjs/common";
import { hostname } from "os";
import { In } from "typeorm";
import type { Repository } from "typeorm";
import { parseManifestHealthCheck } from "./dto/rollout.dto";
import {
  AppDeployment,
  DeploymentStatus,
  DeploymentApprovalStatus,
  DeploymentTriggerType,
  RunMode,
  RolloutState,
} from "./entities/app-deployment.entity";
import { AppError } from "../../common/errors/app-error";
import { ErrorCode } from "../../common/errors/error-codes";
import axios from "axios";
import {
  assertAndPinExecutorUrl,
  pinnedAxiosConfig,
  type PinnedHttpTarget,
} from "../../common/utils/safe-http.util";
import type { DeploymentTriggerContext } from "./application-approval.collaborator";
import type { UserRole } from "../users/entities/user.entity";
import type { ApplicationVersion } from "./entities/application-version.entity";
import { canaryBatchSize } from "./dto/rollout.dto";

/** 灰度默认百分比（未指定时取 50）。 */
const ROLLOUT_DEFAULT_PERCENTAGE = 50;
/** 批次 tick 周期（5s）。 */
const ROLLOUT_TICK_MS = 5_000;
/** 批次硬超时（15min）：到点由 tick 的硬超时分支收尾。 */
const ROLLOUT_BATCH_TIMEOUT_MS = 15 * 60_000;
/** 心跳确认窗口（2min）。 */
const ROLLOUT_HEARTBEAT_WINDOW_MS = 120_000;
/** 批次活性租约 TTL（60s）；reap 周期 30s < 它，保证「崩溃 → 可再开灰度」。 */
const ROLLOUT_LEASE_GRACE_MS = 60_000;
/** 批次活性租约的持有者标识（hostname:pid）。 */
const ROLLOUT_INSTANCE_ID = `${hostname()}:${process.pid}`;
import type { ApplicationService } from "./application.service";

/**
 * T1-B5b：**灰度编排状态机**协作者（rollout cluster）。
 *
 * ## 边界：状态 + 操作状态的逻辑**同 owner**
 *
 * 本类自持两个可变实例字段（`batches` / `timers`）——**不是**从 Facade 借引用。
 * 这是 T1-B5 那条判据的直接应用：
 *
 *   > Facade 转发层能承接「方法调用」，承接不了「可变状态对象的引用」。
 *
 * 「Facade 持 Map + 协作者拿引用」= 伪拆分（只是把跨 owner 共享可变状态包装成
 * 构造参数）。故本类把状态机连状态一起搬：谁持有谁说了算。
 *
 * ## ⚠️ `*Impl` 命名约定（**不要合并回单方法**）
 *
 * 被 Facade / spec 触达的成员是 **public 薄包装**（`failBatch` 等），真实实现是
 * `private *Impl`。原因：`scripts/check-collaborator-self-call.mjs` 判红「协作者
 * 内部直调自身 public 方法」——那会让 Facade 上的 `jest.spyOn` 拦不到内部调用，
 * **既有实现级断言静默失效**。簇内互调一律走 `*Impl`（私有，不参与外部 spy），
 * 外部入口保留 public 同名包装 ⇒ 两全。
 *
 * ## 跨簇依赖（全部经 deps 回调，不自持实现）
 *
 * `upgrade` / `rollbackDeploymentToPrevious` / `findByIdRaw` / `buildVersionRestoreDto`
 * 属 Facade 的**写面**（且 `upgrade`、`rollbackDeploymentToPrevious` 各自被 spec
 * `spyOn`）⇒ 经 `deps.*` 回调走 Facade 转发方法，绝不在此重实现。
 */

/** canary 批次的运行期形态（与 Facade 内原定义结构等价，迁出后此处为准）。 */
export interface RolloutBatch {
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

/** 协作者依赖（全部最小面；跨簇写面一律回调到 Facade）。 */
export interface AppDeploymentRolloutDeps {
  /** 部署行仓库（读写）。 */
  repo: Repository<AppDeployment>;
  /** 版本快照仓库（只读，定向灰度用）。 */
  versionRepo: Repository<ApplicationVersion>;
  /** 应用服务（findByIdRaw / update）。 */
  appService: Pick<ApplicationService, "findByIdRaw" | "update">;
  /** 日志（**必须是 Facade 的实例**——spec spy 的是它）。 */
  logger: Logger;
  /** Facade 的 `upgrade`（spec spyOn 15 处）——经 Facade 转发。 */
  upgrade: (
    ...args: [deploymentId: string, trigger?: DeploymentTriggerContext]
  ) => Promise<unknown>;
  /** Facade 的 `rollbackDeploymentToPrevious`（spec spyOn 3 处）。 */
  rollbackDeploymentToPrevious: (
    deploymentId: string,
    trigger?: unknown,
  ) => Promise<unknown>;
  /** Facade 的 `findByIdRaw`。 */
  findByIdRaw: (id: string) => Promise<AppDeployment>;
  /** Facade 的 `buildVersionRestoreDto`（已迁至只读视图协作者，此处经 Facade）。 */
  buildVersionRestoreDto: (
    app: { runtime: string },
    version: { version: string; gitCommit?: string | null; snapshot?: Record<string, any> | null },
  ) => Record<string, any> | null;
  /**
   * Facade 的 `probeOnce`（③ **赋值式覆写**：spec 用
   * `(service as any).probeOnce = jest.fn()`）⇒ 必须经 Facade 转发，
   * 否则协作者内部直调自己的实现，桩恒不被调用 ⇒ **静默假过**。
   */
  probeOnce: (
    url: string,
    pinCfg: ReturnType<typeof pinnedAxiosConfig>,
    timeoutMs: number,
  ) => Promise<boolean>;
  /**
   * Facade 的 `rolloutTickInner`（③ **赋值式覆写**：spec 用
   * `(service as any).rolloutTickInner = ...` 模拟「批次已被收尾删除」）⇒
   * 同上，必须经 Facade 转发。
   */
  rolloutTickInner: (appId: string, batch: RolloutBatch) => Promise<void>;
  /** Facade 的 `isRolloutClaimUniqueViolation`。 */
  isRolloutClaimUniqueViolation: (err: unknown) => boolean;
  /** 该应用 cron 是否由本实例执行（@Cron 门禁在 Facade）。 */
}

export class AppDeploymentRollout {
  /**
   * 批次表（**本类自持**）。Facade 的 `__rolloutStateForTest()` 探针只读它。
   */
  readonly batches = new Map<string, RolloutBatch>();
  /** 批次定时器（**本类自持**；onModuleDestroy 统一清理）。 */
  readonly timers = new Set<NodeJS.Timeout>();

  private readonly repo: Repository<AppDeployment>;
  private readonly versionRepo: Repository<ApplicationVersion>;
  private readonly appService: Pick<ApplicationService, "findByIdRaw" | "update">;
  private readonly logger: Logger;
  private readonly upgradeViaFacade: AppDeploymentRolloutDeps["upgrade"];
  private readonly probeOnceViaFacade: AppDeploymentRolloutDeps["probeOnce"];
  private readonly rolloutTickInnerViaFacade: AppDeploymentRolloutDeps["rolloutTickInner"];
  private readonly rollbackViaFacade: AppDeploymentRolloutDeps["rollbackDeploymentToPrevious"];
  private readonly findByIdRawViaFacade: AppDeploymentRolloutDeps["findByIdRaw"];
  private readonly buildVersionRestoreDtoViaFacade: AppDeploymentRolloutDeps["buildVersionRestoreDto"];
  private readonly isRolloutClaimUniqueViolationViaFacade: AppDeploymentRolloutDeps["isRolloutClaimUniqueViolation"];

  constructor(deps: AppDeploymentRolloutDeps) {
    this.repo = deps.repo;
    this.versionRepo = deps.versionRepo;
    this.appService = deps.appService;
    this.logger = deps.logger;
    this.upgradeViaFacade = deps.upgrade;
    this.probeOnceViaFacade = deps.probeOnce;
    this.rolloutTickInnerViaFacade = deps.rolloutTickInner;
    this.rollbackViaFacade = deps.rollbackDeploymentToPrevious;
    this.findByIdRawViaFacade = deps.findByIdRaw;
    this.buildVersionRestoreDtoViaFacade = deps.buildVersionRestoreDto;
    this.isRolloutClaimUniqueViolationViaFacade =
      deps.isRolloutClaimUniqueViolation;
  }

  /** Facade 探针用：活引用（每次调用读当前状态，不是快照）。 */
  get timerCount(): number {
    return this.timers.size;
  }


  // ── public 包装层（Facade 转发 / spec 拦截的入口）──────────────────────

  buildProbeUrl(
    executorAddress: string,
    manifestPort: number | null,
    pathName: string,
  ): string | null {
    return this.buildProbeUrlImpl(executorAddress, manifestPort, pathName);
  }

  claimRolloutRows(
    ids: string[],
    fromStates: RolloutState[],
    toState: RolloutState,
  ): Promise<boolean> {
    return this.claimRolloutRowsImpl(ids, fromStates, toState);
  }

  clearBatchTimers(batch: RolloutBatch): void {
    return this.clearBatchTimersImpl(batch);
  }

  failBatch(
    batch: RolloutBatch,
    failedId: string,
    reason: string,
  ): Promise<void> {
    return this.failBatchImpl(batch, failedId, reason);
  }

  findInFlightRolloutRows(
    appId: string,
  ): Promise<AppDeployment[]> {
    return this.findInFlightRolloutRowsImpl(appId);
  }

  finishBatch(appId: string): Promise<void> {
    return this.finishBatchImpl(appId);
  }

  hasRolloutTrace(deployment: AppDeployment): boolean {
    return this.hasRolloutTraceImpl(deployment);
  }

  hydrateRolloutBatch(
    appId: string,
  ): Promise<RolloutBatch | null> {
    return this.hydrateRolloutBatchImpl(appId);
  }

  lastRolloutMeta(
    batch: RolloutBatch,
  ): Record<string, any> | undefined {
    return this.lastRolloutMetaImpl(batch);
  }

  markInterruptedRolloutsFailed(): Promise<number> {
    return this.markInterruptedRolloutsFailedImpl();
  }

  markRolloutState(
    deploymentId: string,
    state: RolloutState,
    meta: Record<string, any> | null,
    options?: { allowFromInFlight?: boolean },
  ): Promise<{ ok: boolean; reason?: string }> {
    return this.markRolloutStateImpl(deploymentId, state, meta, options);
  }

  probeDeployment(
    batch: RolloutBatch,
    deploymentId: string,
  ): Promise<void> {
    return this.probeDeploymentImpl(batch, deploymentId);
  }

  probeDeploymentInner(
    batch: RolloutBatch,
    deploymentId: string,
  ): Promise<void> {
    return this.probeDeploymentInnerImpl(batch, deploymentId);
  }

  probeOnce(
    url: string,
    pinCfg: ReturnType<typeof pinnedAxiosConfig>,
    timeoutMs: number,
  ): Promise<boolean> {
    return this.probeOnceImpl(url, pinCfg, timeoutMs);
  }

  promoteRest(batch: RolloutBatch): Promise<void> {
    return this.promoteRestImpl(batch);
  }

  releaseRolloutClaim(
    appId: string,
    batchId: string,
  ): Promise<void> {
    return this.releaseRolloutClaimImpl(appId, batchId);
  }

  resolveHealthCheck(
    appId: string,
  ): Promise<ReturnType<typeof parseManifestHealthCheck>> {
    return this.resolveHealthCheckImpl(appId);
  }

  resolveRolloutBatch(
    appId: string,
    hint?: AppDeployment,
  ): Promise<RolloutBatch | null> {
    return this.resolveRolloutBatchImpl(appId, hint);
  }

  rolloutTick(appId: string): Promise<void> {
    return this.rolloutTickImpl(appId);
  }

  rolloutTickInner(
    appId: string,
    batch: RolloutBatch,
  ): Promise<void> {
    return this.rolloutTickInnerImpl(appId, batch);
  }

  scheduleRolloutTick(appId: string, delayMs: number): void {
    return this.scheduleRolloutTickImpl(appId, delayMs);
  }

  settleRolloutRows(
    ids: string[],
    state: RolloutState,
  ): Promise<void> {
    return this.settleRolloutRowsImpl(ids, state);
  }

  touchRolloutLease(batch: RolloutBatch): Promise<void> {
    return this.touchRolloutLeaseImpl(batch);
  }

  waitMs(ms: number, batch: RolloutBatch): Promise<void> {
    return this.waitMsImpl(ms, batch);
  }

  // ── 实现（private *Impl；簇内互调一律走这里）──────────────────────────

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
        const updateDto = this.buildVersionRestoreDtoViaFacade(app, row);
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
      const inFlight = await this.findInFlightRolloutRowsImpl(appId);
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
        targets.map((d) => this.upgradeViaFacade(d.id, trigger)),
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
    const healthCheck = await this.resolveHealthCheckImpl(appId);

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
    this.batches.set(appId, batch);

    // canary 首批触发 upgrade（复用既有单台链：UPGRADING → 心跳 RUNNING），
    // 行级 rolloutState=pending + rolloutMeta 批次痕迹落库。
    //
    // R1 阶段 1 · 1-B（迁移 `1790000000095` 重做版）：**claim 列原子占坑**。
    //
    // ## 缺陷现场（Round 1 审计 P-7 / S-7）
    //
    // 上面的 `findInFlightRolloutRows` 判定是**读后判**：命中与否是**读**，
    // 与随后写 `rolloutState=PENDING` 之间**没有原子占坑** ⇒ 两个实例可同时
    // 通过检查 ⇒ 都建批次 ⇒ 后写的覆盖先写的 `rolloutMeta.batchId` ⇒
    // **两批次各自对全部 canary 行调 `upgrade()`** ⇒ 同一行被两次 upgrade。
    //
    // ## 修法：claim 列 + DB 结构底线
    //
    // ① 新增可空列 `rolloutBatchClaimId`（值 = batchId），**只写在 owner 行**
    //    （`canaryRows[0]`），其余 canary 行保持 NULL。
    // ② 部分唯一索引 `UNIQUE ("applicationId") WHERE "rolloutBatchClaimId" IS NOT NULL`
    //    ⇒ 每个应用至多**一行携带 claim** ⇒ 「一个应用同时只有一个在途灰度批次」
    //    由 **DB 约束**保证（结构底线，不是应用层加锁）。
    // ③ 抢**同一** owner 行 ⇒ service 的 CAS（`WHERE claim IS NULL`）干净落败
    //    （affected=0，无异常噪声）。
    // ④ 抢**不同** owner 行 ⇒ 唯一索引在 **UPDATE 时**同样做冲突检查 ⇒ 第二个
    //    UPDATE 使表出现两行 `(applicationId, claim NOT NULL)` ⇒ 必然 23505。
    //
    // ⚠️ **为什么不在 `rolloutState` 上做应用级唯一**（已否决方案，勿重犯）：
    // `canaryBatchSize(N,pct)=ceil(N×pct/100)`、默认 pct=50 ⇒ N=10 时 **5 行同时
    // pending**，而 `UNIQUE(applicationId) WHERE rolloutState IN (...)` 会让**第 2 行
    // 必然 23505** ⇒ 多机灰度全线失效；且第 1 行已落 pending 无人回滚 ⇒ 该应用
    // **后续所有灰度永久阻塞**。claim 列方案没有这个冲突（多行 canary 全是 NULL）。
    const ownerRowId = canaryRows[0]?.id;
    if (ownerRowId) {
      let claimed: { affected?: number } | null = null;
      let claimConflict = false;
      try {
        claimed = await this.repo
          .createQueryBuilder()
          .update(AppDeployment)
          .set({ rolloutBatchClaimId: batchId })
          .where('"id" = :id', { id: ownerRowId })
          .andWhere('"rolloutBatchClaimId" IS NULL')
          .execute();
      } catch (err: unknown) {
        // 23505：`uq_app_deployments_rollout_claim` 冲突 ⇒ **另一个实例抢的是
        // 另一个 owner 行**，但表里已出现两行 `(applicationId, claim NOT NULL)`
        // ⇒ 唯一索引在 UPDATE 时同样做冲突检查 ⇒ 本 UPDATE 必然失败。
        // （这是结构底线，不是应用层加锁。）
        if (this.isRolloutClaimUniqueViolationViaFacade(err)) {
          claimConflict = true;
        } else {
          throw err;
        }
      }
      if (claimConflict || (claimed?.affected ?? 0) === 0) {
        // CAS 输掉：owner 行已被别的批次 claim ⇒ 与既有应用层判定同出口。
        this.logger.warn(
          `Rollout batch claim lost for app ${appId} (owner row ${ownerRowId}) ` +
            `— another instance is rolling out this application`,
        );
        this.batches.delete(appId);
        const inFlightNow = await this.findInFlightRolloutRowsImpl(appId);
        const owner = (
          inFlightNow[0]?.rolloutMeta as Record<string, any> | null | undefined
        )?.leasedBy;
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
              (inFlightNow[0]?.rolloutMeta as Record<string, any> | null)
                ?.batchId ?? "unknown",
            ),
            strategy: "canary",
            canaryIds: [],
            promotedIds: [],
            blockedReason: `another rollout batch is in flight for this application (${inFlightNow.length} row(s) pending/probing${owner ? `, owner=${String(owner)}` : ""})`,
          },
        };
      }
    }

    for (const d of canaryRows) {
      const marked = await this.markRolloutStateImpl(d.id, RolloutState.PENDING, {
        batchId,
        role: "canary",
        strategy: "canary",
        percentage,
        upgradedIds: canaryRows.map((x) => x.id),
      });
      if (!marked.ok) {
        // R1 1-B：**条件写未命中** = 该行已被另一个在途批次占着（`rolloutState`
        // 已在 pending/probing）。此时绝不能继续 `upgrade()`——那正是 H-2 的
        // 原始缺陷形态（两批次各自对同一行下发 deploy 命令）。
        // 处置：收掉本实例刚占的 claim + 内存批次，按 blocked 语义返回
        // （与上方 claim 落败同出口，调用方据 `blockedReason` 判定）。
        this.logger.warn(
          `Rollout batch ${batchId} aborted: deployment ${d.id} already belongs to ` +
            `another in-flight rollout batch (${marked.reason ?? "state guard missed"})`,
        );
        this.clearBatchTimersImpl(batch);
        this.batches.delete(appId);
        await this.releaseRolloutClaimImpl(appId, batchId);
        const inFlightNow = await this.findInFlightRolloutRowsImpl(appId);
        return {
          ok: false,
          total: deployments.length,
          succeeded: 0,
          failed: 0,
          coverage,
          skipped,
          ...(targetVersion ? { version: targetVersion } : {}),
          rollout: {
            batchId,
            strategy: "canary",
            canaryIds: [],
            promotedIds: [],
            blockedReason: `another rollout batch is in flight for this application (${inFlightNow.length} row(s) pending/probing)`,
          },
        };
      }
      try {
        await this.upgradeViaFacade(d.id, trigger);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        await this.failBatchImpl(batch, d.id, `upgrade trigger failed: ${msg}`);
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
    this.scheduleRolloutTickImpl(appId, ROLLOUT_TICK_MS);
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
  private async resolveHealthCheckImpl(
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
   *  不触碰 env——掩码风险为零）。
   *
   * R1 阶段 1 · 1-B：改为**条件写**并返回占坑结果。
   *
   * ## 为什么原来是「无条件写」
   *
   * 此前是 `repo.update({id}, {rolloutState, rolloutMeta})`——**不带状态守卫**。
   * 两个批次（两实例）可以对**同一行**各写一次痕迹 ⇒ 后者覆盖前者的
   * `rolloutMeta.batchId` ⇒ 读面显示错乱（行上的 batchId 指向另一个批次，
   * 而两个批次各自用自己的 batchId 去结算这行）。
   *
   * ## 现在的语义
   *
   * 写入**只在该行当前不在途态时**生效（守卫谓词与部分唯一索引的谓词同源：
   * `rolloutState IS NULL OR rolloutState NOT IN ('pending','probing')`）。
   * 于是：
   *   · 行不在途 → 写入成功，`affected=1`；
   *   · 行已在途（别的批次占着）→ **不写**，`affected=0` ⇒ 调用方据此判定
   *     「占坑输掉」。
   *
   * ⚠️ 终态写（FAILED / PROMOTED / ROLLED_BACK）也走这个方法——它们的
   * `state` 本身就在「非在途」集合里，故守卫不拦（`affected=1`）。
   * 但 `promoteRest` 批量的「pending → promoted」是**从在途态迁出**——此时
   * 守卫会拦！故对**迁出在途态**的写入用 `allowFromInFlight=true` 放宽守卫。
   *
   * @param allowFromInFlight 允许从在途态迁出（终态推进用；批次**创建**不用）
   */
  private async markRolloutStateImpl(
    deploymentId: string,
    state: RolloutState,
    meta: Record<string, any> | null,
    options?: { allowFromInFlight?: boolean },
  ): Promise<{ ok: boolean; reason?: string }> {
    try {
      const row = await this.repo.findOne({ where: { id: deploymentId } });
      if (!row) return { ok: false, reason: "deployment row not found" };
      // R50（ADR-026 规则 4）：只写这两列，**不整行 save**。整行回写会用本方法读到
      // 的快照覆盖并发的 status / statusMessage / rollout 进度（心跳推进终态、管理员
      // 停止等），而这里要改的只是「批次痕迹」两列——多写一列就是在替别人做决定。
      // adr-026-exempt: 只写 rolloutState / rolloutMeta 两个**批次痕迹列**（patch 里不含
      // status/statusMessage 等状态列）；状态迁移由 handleHeartbeat / 升级链的条件 UPDATE 独占。
      //
      // R1 1-B（迁移 1790000000095 重做版）：批次**创建**的占坑用 claim 列
      // （`rolloutBatchClaimId`）+ `WHERE claim IS NULL` 的 CAS；这里只写
      // rolloutState / rolloutMeta 两列（ADR-026 规则 4），**不**写 claim。
      //
      // ADR-026（条件写）：除 `id` 外必须带**源状态谓词**，否则「读后判」的窗口
      // 原封不动——两个批次各写一次痕迹，后者覆盖前者的 `rolloutMeta.batchId`，
      // 而两个批次又各自用自己的 batchId 去结算这行（读面显示错乱 + 重复结算）。
      // 守卫谓词与内存判定的口径同源：
      //   · 批次**创建**（`allowFromInFlight` 缺省）：期望旧态 = **不在途**
      //     （`rolloutState IS NULL OR NOT IN ('pending','probing')`）——
      //     命中 0 行 = 该行已被别的批次占着 ⇒ 返回 `ok:false` 让调用方走
      //     blocked/409（**不是**静默继续）。
      //   · **在途态内部推进 / 迁出**（`allowFromInFlight=true`）：pending→probing、
      //     pending|probing→promoted|failed|rolled_back 都是同批次内的合法迁移，
      //     此时旧态**本来就在**在途集合里，加「非在途」守卫会把正常推进挡死
      //     ⇒ 该路径不加状态谓词（由调用方持有的批次内存态 + 行上 batchId 归属
      //     决定），仍只写两列、不碰 status。
      //
      // ⚠️ **必须保留租约字段**（leasedAt/leasedBy）：本方法用**整列覆盖**
      // `rolloutMeta` 写回，而租约是 `touchRolloutLease` 单独写进同一列的。
      // 若不在此处继承，任何一次「心跳推进 probing / 结算终态」都会把租约**抹掉**
      // ⇒ `markInterruptedRolloutsFailed` 把这些行看成「没有活着的持有者」⇒
      // 周期性 sweep 会把**正在推进的批次**判死（F-9b 引入周期调度后这一条
      // 从「潜在」变成「必然」）。继承后语义回到：租约只由持有者的 tick 刷新。
      // 继承只在**来方没显式给**该字段时发生（`in` 判定，非真值判定）：
      // 显式 `leasedBy: X` 必须赢，否则「新实例接管租约」会被旧值盖回去；
      // 显式 `leasedAt: null` 同理（清租约是合法意图）。
      const prevMeta = (row.rolloutMeta ?? {}) as Record<string, any>;
      const nextMeta: Record<string, any> = { ...(meta ?? {}) };
      if (meta) {
        for (const key of ["leasedAt", "leasedBy"] as const) {
          if (!(key in meta) && key in prevMeta) nextMeta[key] = prevMeta[key];
        }
      }
      const qb = this.repo
        .createQueryBuilder()
        .update(AppDeployment)
        .set({ rolloutState: state, rolloutMeta: nextMeta })
        .where('"id" = :id', { id: deploymentId });
      if (!options?.allowFromInFlight) {
        qb.andWhere(
          '("rolloutState" IS NULL OR "rolloutState" NOT IN (:...inFlightStates))',
          {
            inFlightStates: [RolloutState.PENDING, RolloutState.PROBING],
          },
        );
      }
      const result = await qb.execute();

      if ((result?.affected ?? 0) === 0) {
        return {
          ok: false,
          reason: options?.allowFromInFlight
            ? "deployment row was not updated"
            : "deployment row is already part of another in-flight rollout batch",
        };
      }
      // 同步内存视图：调用方随后还会读 row 的这两列；列级写不会回灌到已取出的实体。
      row.rolloutState = state;
      row.rolloutMeta = nextMeta;
      return { ok: true };
    } catch (err: unknown) {
      // ⚠️ 本方法**不写 claim 列** ⇒ 它不可能违反 claim 唯一索引
      // （`uq_app_deployments_rollout_claim`）。若这里抛 23505，只可能是**别的**
      // 唯一约束 ⇒ 把它谎报成「another rollout batch is already in flight」是
      // **错误归因**（会把无关的约束冲突误导成「别的实例在灰度」）。
      // 故此处只记 warn（fail-open），不做任何 claim 归因。
      this.logger.warn(
        `Failed to persist rolloutState=${state} for ${deploymentId}: ` +
          (err instanceof Error ? err.message : String(err)),
      );
      return { ok: true };
    }
  }

  /**
   * R1 1-B（迁移 1790000000095）：**释放本批次的应用级占坑**（claim 列置回 NULL）。
   *
   * 带 `batchId` 守卫：只清自己那条 claim，绝不误清别的批次的
   * （两实例交接时后者已抢占成功的情况下，前者迟到的释放不得把后者的坑填掉）。
   *
   * ⚠️ 之所以把 `batchId` 作**入参**而不是从 `this.batches` 现取：
   * `finishBatch` / `failBatch` 在调用本方法前已经 `delete` 了内存批次
   * （先清定时器与内存态，再做行级收口），此时 `rolloutBatches.get(appId)`
   * 恒为 undefined ⇒ 现取会把 batchId 取成 undefined ⇒ 守卫恒不命中 ⇒
   * **claim 永不释放** ⇒ 该应用后续所有灰度永久 blocked。
   * 故所有调用点都必须传**调用前捕获**的 batchId 局部变量。
   *
   * 失败只记 warn（fail-open）：释放是收尾动作，DB 抖动不该改变批次结论；
   * `markInterruptedRolloutsFailed` 的兜底扫描会覆盖残留 claim。
   */
  private async releaseRolloutClaimImpl(
    appId: string,
    batchId: string,
  ): Promise<void> {
    if (!appId || !batchId) return;
    try {
      await this.repo
        .createQueryBuilder()
        .update(AppDeployment)
        .set({ rolloutBatchClaimId: null })
        .where('"applicationId" = :appId', { appId })
        .andWhere('"rolloutBatchClaimId" = :batchId', { batchId })
        .execute();
    } catch (err: unknown) {
      this.logger.warn(
        `Rollout claim release failed for app ${appId} (batch ${batchId}): ` +
          (err instanceof Error ? err.message : String(err)),
      );
    }
  }

  /** 该应用在途（pending/probing）的灰度行——跨实例可见的「批次是否已被占用」。 */
  private async findInFlightRolloutRowsImpl(
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
  private async resolveRolloutBatchImpl(
    appId: string,
    hint?: AppDeployment,
  ): Promise<RolloutBatch | null> {
    const owned = this.batches.get(appId);
    if (owned) return owned;
    if (hint && !this.hasRolloutTraceImpl(hint)) return null;
    return this.hydrateRolloutBatchImpl(appId);
  }

  /** 行上是否留有批次痕迹（rolloutState 在途，或曾有 batchId）。 */
  private hasRolloutTraceImpl(deployment: AppDeployment): boolean {
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
  private async hydrateRolloutBatchImpl(
    appId: string,
  ): Promise<RolloutBatch | null> {
    try {
      const rows = await this.findInFlightRolloutRowsImpl(appId);
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
        healthCheck: await this.resolveHealthCheckImpl(appId),
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
  private async claimRolloutRowsImpl(
    ids: string[],
    fromStates: RolloutState[],
    toState: RolloutState,
  ): Promise<boolean> {
    if (ids.length === 0) return false;
    try {
      const result = await this.repo
        .createQueryBuilder()
        .update(AppDeployment)
        .set({
          rolloutState: toState,
          // R1 1-B（迁移 1790000000095）：批次终结时**释放 claim**。
          // ⚠️ 不释放 ⇒ 该应用的 `uq_app_deployments_rollout_claim` 唯一索引
          // 恒有占用行 ⇒ 后续所有灰度**永久阻塞**（CAS 恒 affected=0）。
          rolloutBatchClaimId: null,
        })
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
  private async touchRolloutLeaseImpl(batch: RolloutBatch): Promise<void> {
    const id = batch.upgradedIds[0];
    if (!id) return;
    try {
      // 与 markRolloutState 同形态（findOne + save）：jsonb 列走 QueryBuilder
      // 的 set() 会撞 TypeORM 的类型收窄，且本路径不需要原子性。
      const row = await this.repo.findOne({ where: { id } });
      if (!row) return;
      const nextMeta = {
        ...((row.rolloutMeta as Record<string, any>) ?? {}),
        ...this.lastRolloutMetaImpl(batch),
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

  private lastRolloutMetaImpl(
    batch: RolloutBatch,
  ): Record<string, any> | undefined {
    return { batchId: batch.batchId, strategy: batch.strategy };
  }

  /** DEP-02：handleHeartbeat 钩子——批次在途时，RUNNING 确认把行推进到
   *  probing（健康探测阶段）。FAILED/STOPPED 上报直接判批次失败。 */
  async notifyHeartbeatToRollout(
    deployment: AppDeployment,
  ): Promise<void> {
    const batch = await this.resolveRolloutBatchImpl(
      deployment.applicationId,
      deployment,
    );
    if (!batch) return;
    if (batch.upgradedIds.includes(deployment.id)) {
      if (deployment.status === DeploymentStatus.RUNNING) {
        await this.markRolloutStateImpl(
          deployment.id,
          RolloutState.PROBING,
          {
            batchId: batch.batchId,
            role: "canary",
            heartbeatConfirmedAt: new Date().toISOString(),
            ...(batch.hydrated ? {} : { leasedBy: ROLLOUT_INSTANCE_ID }),
          },
          // R1 1-B：pending → probing 是**在途态内部**的推进（守卫会拦 ⇒ 放宽）
          { allowFromInFlight: true },
        );
        // 探测与提升只由批次持有实例驱动（hydrated 上下文不持定时器、
        // 不启探测，避免两个实例同时对同一批执行器推进）。
        if (batch.healthCheck && !batch.hydrated) {
          if (!batch.probedIds) batch.probedIds = new Set<string>();
          if (!batch.probedIds.has(deployment.id)) {
            batch.probedIds.add(deployment.id);
            void this.probeDeploymentImpl(batch, deployment.id);
          }
        }
        // 无健康声明：tick 引擎看到「pending 全部清空」即提升。
      } else if (
        deployment.status === DeploymentStatus.FAILED ||
        deployment.status === DeploymentStatus.STOPPED
      ) {
        await this.failBatchImpl(
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
      await this.markRolloutStateImpl(
        deployment.id,
        RolloutState.PROMOTED,
        {
          batchId: batch.batchId,
          role: "promoted",
        },
        // R1 1-B：probing → promoted 是**在途态迁出**（守卫会拦 ⇒ 放宽）
        { allowFromInFlight: true },
      );
      batch.promotedIds = batch.promotedIds.filter((x) => x !== deployment.id);
      if (batch.promotedIds.length === 0)
        await this.finishBatchImpl(batch.applicationId);
    }
  }

  /** 提升轮结束：清批次内存态 + **行态收口**（行上 promoted 痕迹保留供读面）。 */
  private async finishBatchImpl(appId: string): Promise<void> {
    const batch = this.batches.get(appId);
    if (!batch) return;
    // R1 1-B：**先捕获** batchId——下面对内存态做了 delete，之后再
    // `rolloutBatches.get(appId)` 恒为 undefined ⇒ claim 释放会恒不命中。
    const batchId = batch.batchId;
    this.clearBatchTimersImpl(batch);
    this.batches.delete(appId);
    // ARCH-31 真机验证抓到的缺陷（跨实例灰度套件）：此前只清内存态，canary
    // 命中台的行**永远停在 probing**——①findInFlightRolloutRows 因此把该应用
    // 永久判定为「有批次在途」，后续任何 canary 都被互斥挡死（blockedReason
    // 一直存在）；②滚动重启时 sweep 会把这条陈旧在途行误标 failed（噪音）。
    // 收口为 promoted（终态），只动 pending/probing，不覆盖 failed/rolled_back
    // 的真实失败痕迹。
    await this.settleRolloutRowsImpl(
      [...batch.upgradedIds, ...batch.promotedIds],
      RolloutState.PROMOTED,
    );
    // R1 1-B：`settleRolloutRows` 只命在途行；若 owner 行在收口前已不是
    // pending/probing（例如它已被心跳推到 promoted），那条 claim 不会被上面
    // 的条件 UPDATE 命中 ⇒ 必须**无条件再释放一次**（带 batchId 守卫，幂等）。
    await this.releaseRolloutClaimImpl(appId, batchId);
    this.logger.log(`Rollout batch ${batchId} finished (promoted all)`);
  }

  /**
   * 把给定行的**在途态**（pending/probing）收口到终态 state。
   * 条件 UPDATE 只命在途行：已 failed/rolled_back/promoted 的行不受影响，
   * 重复调用幂等。DB 抖动只记 warn（收口是收尾动作，失败不改变批次结论）。
   */
  private async settleRolloutRowsImpl(
    ids: string[],
    state: RolloutState,
  ): Promise<void> {
    if (ids.length === 0) return;
    try {
      // R1 1-B（迁移 1790000000095）：批次收口时**一并释放 claim**。
      //
      // ⚠️ 不释放的后果：claim 是「此刻有一个批次在推进」的瞬时事实，留在行上
      // ⇒ 该应用的 `uq_app_deployments_rollout_claim` 唯一索引恒有占用行 ⇒
      // **后续所有灰度永久阻塞**（CAS 恒 affected=0）——比原来的 TOCTOU 缺陷
      // 更严重（那个只影响并发窗口，这个影响该应用 forever）。
      //
      // 释放条件：行处于**在途态**（pending/probing）⇒ 只清真正在推进的行的
      // claim；已终态（failed/rolled_back/promoted）的行其 claim 由同一条件
      // UPDATE 一并清掉（见下方 set 的 rolloutBatchClaimId: null）。
      await this.repo
        .createQueryBuilder()
        .update(AppDeployment)
        .set({ rolloutState: state, rolloutBatchClaimId: null })
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
  private async failBatchImpl(
    batch: RolloutBatch,
    failedId: string,
    reason: string,
  ): Promise<void> {
    // ARCH-31: 条件 UPDATE 认领终结权——多实例下心跳/探测可能同时落到多个
    // 实例，只有第一个把在途行置为 failed 的实例执行后续自动回滚，避免对
    // 同一批执行器重复回滚（claim 未命中 = 别的实例已收尾）。
    // D-18/F-1（R1 审计 S-7）：结算集**必须含 `promotedIds`**。
    //
    // 缺陷现场：灰度分两轮——canary 轮（`upgradedIds`）→ 提升轮（`promotedIds`）。
    // 此处原结算集只有 `[failedId, ...upgradedIds]` ⇒ **提升轮已升上去的机器
    // 不会被置 FAILED**，它们永远留在 `pending`：
    //   · `claimRolloutRows` 的条件 UPDATE 覆盖不到它们 ⇒ 不被置终态；
    //   · 周期 sweep（30s）会把它们当孤儿标 failed，但**不会**被回滚
    //     （回滚循环只遍历 `upgradedIds`）⇒ **停在「新版本已生效但台账记失败」的
    //     不一致态**，且该应用的后续灰度会被残留的 pending 行持续干扰。
    //
    // ⇒ 结算集 = 失败台 + canary 轮 + **提升轮**。
    // ⚠️ 回滚语义随之扩大：提升轮的机器**也已被升级**，因此**同样需要回滚**
    //   （原先只有 canary 轮被回滚，提升轮被漏掉 —— 那才是真正的业务缺陷）。
    const settlementIds = [
      failedId,
      ...batch.upgradedIds.filter((x) => x !== failedId),
      ...batch.promotedIds.filter((x) => x !== failedId),
    ];
    const claimed = await this.claimRolloutRowsImpl(
      settlementIds,
      [RolloutState.PENDING, RolloutState.PROBING],
      RolloutState.FAILED,
    );
    if (!claimed) {
      this.logger.warn(
        `Rollout batch ${batch.batchId} already terminated by another instance — skipping duplicate rollback (reason: ${reason})`,
      );
      this.clearBatchTimersImpl(batch);
      this.batches.delete(batch.applicationId);
      return;
    }
    this.clearBatchTimersImpl(batch);
    this.batches.delete(batch.applicationId);
    // 回滚集同样含提升轮（见上）：这些机器已被升级到新版本，必须一并回滚。
    const failedIds = [
      ...batch.upgradedIds.filter((x) => x !== failedId),
      ...batch.promotedIds.filter((x) => x !== failedId),
    ];
    this.logger.error(
      `Rollout batch ${batch.batchId} failed (${reason}) — rolling back ` +
        `${failedIds.length} upgraded deployment(s)`,
    );
    for (const id of failedIds) {
      await this.markRolloutStateImpl(
        id,
        RolloutState.FAILED,
        {
          batchId: batch.batchId,
          failureReason: reason,
        },
        // R1 1-B：终态是**在途态迁出**（守卫会拦 ⇒ 放宽）
        { allowFromInFlight: true },
      );
      try {
        await this.rollbackViaFacade(id, {
          operator: null,
          triggerType: DeploymentTriggerType.ROLLBACK,
        });
        await this.markRolloutStateImpl(
          id,
          RolloutState.ROLLED_BACK,
          {
            batchId: batch.batchId,
            failureReason: reason,
          },
          // R1 1-B：终态是**在途态迁出**（守卫会拦 ⇒ 放宽）
          { allowFromInFlight: true },
        );
      } catch (err: unknown) {
        this.logger.error(
          `Auto-rollback failed for ${id}: ` +
            (err instanceof Error ? err.message : String(err)),
        );
      }
    }
    await this.markRolloutStateImpl(
      failedId,
      RolloutState.FAILED,
      {
        batchId: batch.batchId,
        failureReason: reason,
      },
      // R1 1-B：终态是**在途态迁出**（守卫会拦 ⇒ 放宽）
      { allowFromInFlight: true },
    );
    // R1 1-B：`claimRolloutRows` 已把「从在途态被终结」的行的 claim 一并清掉，
    // 但它只命 pending/probing 的行；若 owner 行在此前已被心跳推到终态
    // （promoted / failed），那条 claim 不会被命中 ⇒ 再显式释放一次（幂等）。
    await this.releaseRolloutClaimImpl(batch.applicationId, batch.batchId);
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
  private async probeDeploymentImpl(
    batch: RolloutBatch,
    deploymentId: string,
  ): Promise<void> {
    try {
      await this.probeDeploymentInnerImpl(batch, deploymentId);
    } catch (err: unknown) {
      this.logger.error(
        `Health probe for deployment ${deploymentId} (batch ${batch.batchId}) failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  private async probeDeploymentInnerImpl(
    batch: RolloutBatch,
    deploymentId: string,
  ): Promise<void> {
    const hc = batch.healthCheck;
    if (!hc) return;
    let deployment: AppDeployment;
    try {
      deployment = await this.findByIdRawViaFacade(deploymentId);
    } catch {
      await this.failBatchImpl(batch, deploymentId, "deployment row vanished");
      return;
    }
    const url = this.buildProbeUrlImpl(
      deployment.executorAddress,
      hc.port,
      hc.path,
    );
    if (!url) {
      await this.failBatchImpl(
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
      await this.failBatchImpl(
        batch,
        deploymentId,
        `health probe URL refused: ${msg}`,
      );
      return;
    }
    const pinCfg = pinnedAxiosConfig(pinned);
    const attempts = hc.failThreshold;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      const ok = await this.probeOnceViaFacade(url, pinCfg, hc.timeoutMs);
      if (ok) {
        this.logger.log(
          `Health probe passed for ${deploymentId} (attempt ${attempt}/${attempts}): ${url}`,
        );
        await this.promoteRestImpl(batch);
        return;
      }
      if (attempt < attempts) {
        await this.waitMsImpl(hc.interval, batch);
      }
    }
    await this.failBatchImpl(
      batch,
      deploymentId,
      `health probe failed after ${attempts} attempts: ${url}`,
    );
  }

  /** 探测 URL 组装：host 取执行器地址（R8 语义——地址本就执行器可控，
   *  探针端口/路径来自应用 manifest（管理员写入面））；端口缺省回退执行器
   *  地址端口。纯函数（public 便于测试）。 */
  private buildProbeUrlImpl(
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
  private async probeOnceImpl(
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
  private async promoteRestImpl(batch: RolloutBatch): Promise<void> {
    if (batch.promotedIds.length === 0) {
      await this.finishBatchImpl(batch.applicationId);
      return;
    }
    const promoteIds = [...batch.promotedIds];
    this.logger.log(
      `Rollout batch ${batch.batchId}: promoting remaining ${promoteIds.length} deployment(s)`,
    );
    for (const id of promoteIds) {
      await this.markRolloutStateImpl(
        id,
        RolloutState.PENDING,
        {
          batchId: batch.batchId,
          role: "promoted",
          strategy: "canary",
          percentage: batch.percentage,
          upgradedIds: promoteIds,
        },
        // R1 1-B：同一批次内的**第二批台**升 PENDING（canary 批已占位 ⇒
        // 部分唯一索引会因「同应用已有在途行」而拦这一行）——这是批次内部的
        // 正常推进，不是「新批次抢占」⇒ 放宽守卫。
        { allowFromInFlight: true },
      );
      try {
        await this.upgradeViaFacade(id);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        await this.failBatchImpl(batch, id, `promotion upgrade failed: ${msg}`);
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
  private scheduleRolloutTickImpl(appId: string, delayMs: number): void {
    const batch = this.batches.get(appId);
    if (!batch) return;
    const t = setTimeout(() => {
      this.timers.delete(t);
      void this.rolloutTickImpl(appId);
    }, delayMs);
    this.timers.add(t);
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
  private async rolloutTickImpl(appId: string): Promise<void> {
    const batch = this.batches.get(appId);
    if (!batch) return;
    try {
      await this.rolloutTickInnerViaFacade(appId, batch);
    } catch (err: unknown) {
      this.logger.error(
        `Rollout tick for batch ${batch.batchId} failed (batch kept, retry on next tick): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      // 批次仍在途（未被 failBatch 收尾删除）才续排；行级状态保持不动。
      if (this.batches.has(appId)) {
        this.scheduleRolloutTickImpl(appId, ROLLOUT_TICK_MS);
      }
    }
  }

  private async rolloutTickInnerImpl(
    appId: string,
    batch: RolloutBatch,
  ): Promise<void> {
    if (Date.now() - batch.startedAt > ROLLOUT_BATCH_TIMEOUT_MS) {
      const stuckId = batch.upgradedIds[0];
      await this.failBatchImpl(batch, stuckId, "batch hard timeout");
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
      await this.failBatchImpl(
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
      this.clearBatchTimersImpl(batch);
      this.batches.delete(appId);
      this.logger.warn(
        `Rollout batch ${batch.batchId} no longer active in DB — dropped from this instance`,
      );
      return;
    }

    if (stillPending.length === 0) {
      if (!batch.healthCheck) {
        // 无健康声明：跳过探测直接提升。
        await this.promoteRestImpl(batch);
        // ARCH-31 真机验证抓到的缺陷（跨实例灰度套件）：此前这里直接 return，
        // **不再排下一次 tick**——提升轮把其余台 upgrade 出去后，批次再也没有
        // 机会调用 finishBatch：内存批次永久驻留、A 日志永不出现 finished、
        // canary 命中台永远停在 probing（随后被互斥判定「有批次在途」挡死该应用
        // 的后续灰度）。提升轮不是终点：还要等 promote 台的心跳确认并在下一次
        // tick 收尾，故此处继续排 tick（已收尾/已被终结则不再排）。
        if (!this.batches.has(appId)) return;
        await this.touchRolloutLeaseImpl(batch);
        this.scheduleRolloutTickImpl(appId, ROLLOUT_TICK_MS);
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
          void this.probeDeploymentImpl(batch, r.id);
        }
      }
      // 探测在心跳确认时各自启动（probeDeployment 窗口）；全部行已 promoted
      // 说明探测通过路径已收尾。probing 在途则继续等下一 tick。
      const promoted = rows.filter(
        (r) => r.rolloutState === RolloutState.PROMOTED,
      );
      if (promoted.length === rows.length) {
        await this.finishBatchImpl(appId);
        return;
      }
    }

    // ARCH-31: 刷新活性租约（滚动重启时新起的实例据此保留在途批次）
    await this.touchRolloutLeaseImpl(batch);
    this.scheduleRolloutTickImpl(appId, ROLLOUT_TICK_MS);
  }

  /** 退避等待（登记句柄供 OnModuleDestroy 统一清理）。 */
  private waitMsImpl(ms: number, batch: RolloutBatch): Promise<void> {
    return new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        this.timers.delete(t);
        resolve();
      }, ms);
      this.timers.add(t);
      batch.timer = t;
    });
  }

  private clearBatchTimersImpl(batch: RolloutBatch): void {
    if (batch.timer) {
      clearTimeout(batch.timer);
      this.timers.delete(batch.timer);
      batch.timer = null;
    }
    if (batch.tickTimer) {
      clearTimeout(batch.tickTimer);
      this.timers.delete(batch.tickTimer);
      batch.tickTimer = null;
    }
  }

  /** `reapStaleRolloutBatches` 的扫描体（异常由 guardedCron 统一兜住）。 */
  async reapStaleRolloutBatchesBody(): Promise<void> {
    const marked = await this.markInterruptedRolloutsFailedImpl();
    if (marked > 0) {
      this.logger.log(
        `Rollout claim reaper: reclaimed ${marked} orphaned in-flight rollout row(s)`,
      );
    }
  }

  /** DEP-02：重启 sweep 本体——pending/probing 行标记 failed。 */
  private async markInterruptedRolloutsFailedImpl(): Promise<number> {
    const stale = await this.repo.find({
      where: [
        { rolloutState: RolloutState.PENDING },
        { rolloutState: RolloutState.PROBING },
      ],
    });
    // ARCH-31: 跳过「别的实例仍在推进」的批次——滚动重启时新起的实例若
    // 一律标 failed，会把另一个实例正在跑的灰度直接打断（多实例下的真实
    // 破坏路径）。判据=行上 rolloutMeta.leasedAt 落在宽限窗内。
    //
    // R1 1-B（F-9b）：判据必须按**批次**粒度求值，不能纯按行。
    // 租约只由持有者写在 `batch.upgradedIds[0]`（owner 行）上，同批次其余
    // canary/promoted 行**本来就没有 leasedAt**。纯按行判会把它们看成「没有
    // 活着的持有者」⇒ 周期 sweep 把**正在推进的批次**判死（引入 30s 调度后
    // 这不是潜在问题，是必然发生的）。
    // 故：同 `rolloutMeta.batchId` 只要有**任意一行**的租约新鲜，整批都跳过。
    // 无 batchId 的行（迁移前的存量/半写状态）退回**按行**判——它们本就没有
    // 批次归属，不能靠别人的租约续命。
    const now = Date.now();
    const freshLeaseBatches = new Set<string>();
    for (const d of stale) {
      const meta = d.rolloutMeta as Record<string, any> | null;
      const leasedAt = meta?.leasedAt ? Date.parse(String(meta.leasedAt)) : NaN;
      const batchId = meta?.batchId ? String(meta.batchId) : null;
      if (
        batchId &&
        Number.isFinite(leasedAt) &&
        now - leasedAt < ROLLOUT_LEASE_GRACE_MS
      ) {
        freshLeaseBatches.add(batchId);
      }
    }
    const orphaned = stale.filter((d) => {
      const meta = d.rolloutMeta as Record<string, any> | null;
      const batchId = meta?.batchId ? String(meta.batchId) : null;
      if (batchId) return !freshLeaseBatches.has(batchId);
      // 无批次归属：按自身租约判（与旧行为逐字节一致）。
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
    let marked = 0;
    if (orphaned.length > 0) {
      const orphanedIds = orphaned.map((d) => d.id);
      const result = await this.repo
        .createQueryBuilder()
        .update(AppDeployment)
        .set({
          rolloutState: RolloutState.FAILED,
          // R1 1-B（迁移 1790000000095）：**崩溃恢复必须释放 claim**。
          //
          // ⚠️ 这是本方案最容易漏、后果最重的一处：claim 是「此刻有批次在推进」
          // 的瞬时事实，而 sweep 正是「推进者已死」的判定者。只把 rolloutState
          // 标 failed 而不清 claim ⇒ 该应用的 `uq_app_deployments_rollout_claim`
          // 唯一索引**恒有占用行** ⇒ 后续**所有**灰度被拒（CAS 恒 affected=0），
          // 且没有任何终态事件会再碰这一行——只能人工改库。
          rolloutBatchClaimId: null,
          rolloutMeta: () =>
            `COALESCE("rolloutMeta", '{}'::jsonb) || '{"failureReason":"admin-api restarted — rollout batch not resumed"}'::jsonb`,
        })
        .where("id IN (:...ids)", { ids: orphanedIds })
        // ADR-026 条件写：find 与 update 之间，另一个实例的心跳/回调可能已把行
        // 推进出 pending/probing（例如刚成功的灰度）。按 id 盲写会把「已成功」
        // 盖回 failed，而本 sweep 恰恰跑在重启窗口——多实例重启是常态。
        // 只更新仍是 pending/probing 的行，用 RETURNING 精确计数（同文件 :3053 的
        // E-P1-R3 写法），返回值因此是「真正被标记的行数」而不是快照长度。
        .andWhere('"rolloutState" IN (:...expected)', {
          expected: [RolloutState.PENDING, RolloutState.PROBING],
        })
        .returning("id")
        .execute();
      marked = ((result.raw ?? []) as Array<{ id?: string }>).length;
      this.logger.warn(
        `Marked ${marked} interrupted rollout deployment(s) as failed after restart` +
          (marked < orphaned.length
            ? `（${orphaned.length - marked} 行已被其他实例推进，未覆盖）`
            : ""),
      );
    }
    return marked;
  }
}
