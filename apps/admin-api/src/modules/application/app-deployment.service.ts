import {
  Injectable,
  Logger,
  Optional,
  OnModuleDestroy,
  OnModuleInit,
} from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import {
  Repository,
  LessThan,
  MoreThanOrEqual,
  And,
  In,
  IsNull,
  Like,
  Not,
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
// rt-5（CRON-GUARD）：@Cron 方法体的顶层异常闸（全仓唯一实现）
import { guardedCron } from "../../common/utils/cron-guard.util";
import {
  assertAndPinExecutorUrl,
  PinnedHttpTarget,
  pinnedAxiosConfig,
} from "../../common/utils/safe-http.util";
import {
  CreateDeploymentDto,
  DeploymentHeartbeatDto,
} from "./dto/app-deployment.dto";
// DEP-02/DEP-03: 灰度（canary）批次 + manifest 健康探针 + 自动回滚
import { RolloutState } from "./entities/app-deployment.entity";
import { parseManifestHealthCheck } from "./dto/rollout.dto";
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

/** DEP-02/DEP-03：单个部署行在批次内的健康探测 + 自动回滚（进程内）。
 *  结构化批次状态（最低正确形态，复用 FEAT-07 dispatcher 的进程内
 *  setTimeout 队列模式）：批次本体在内存，行级状态落 rolloutState/
 *  rolloutMeta；服务重启时 pending/probing 批次标记 failed（不自动恢复）。 */

/** R5: name of the partial unique index created by migration
 *  1789000000000-AddAppDeploymentsInFlightUniqueIndex (applicationId is
 *  unique among rows with status pending/deploying). */
const IN_FLIGHT_UNIQUE_INDEX = "uq_app_deployments_application_in_flight";

/** R1 阶段 1 · 1-B（迁移 1790000000095-AddRolloutBatchClaim）：灰度**批次占坑**
 * 的部分唯一索引名（`applicationId` 上唯一，谓词
 * `"rolloutBatchClaimId" IS NOT NULL`）。
 *
 * ⚠️ 与 `IN_FLIGHT_UNIQUE_INDEX` **必须分开识别**：前者管「部署创建」
 * （`status IN ('pending','deploying')`），后者管「灰度批次」
 * （携带 claim 的行）。两者冲突时的含义完全不同 ⇒ 归因错位会把
 * 「部署创建被拒」误报成「别的实例在灰度」。
 */
const ROLLOUT_CLAIM_UNIQUE_INDEX = "uq_app_deployments_rollout_claim";

// T1-B5a 拆分：/releases 的分页/扫描限幅与排序键已迁至
// `./app-deployment-release-view.collaborator.ts`（与只读追溯视图同域）。
// **本文件 re-export 保持外部 import 路径不变**（`app-releases.spec.ts` /
// `app-releases.devices.spec.ts` / `app-deployment-events.spec.ts` 直接从本
// 文件 import 这些符号 ⇒ 迁移对消费方零改动，先例同 B1a 的审批聚类类型）。
export {
  RELEASES_DEFAULT_PAGE_SIZE,
  RELEASES_MAX_PAGE_SIZE,
  RELEASES_SYNTHETIC_SCAN_PAGE_SIZE,
  RELEASES_SYNTHETIC_SCAN_MAX_ROWS,
  releaseSortTimestampMs,
} from "./app-deployment-release-view.collaborator";
// 同名符号本地绑定（`export {x} from` 不引入本地作用域；转发层的默认参数
// 需要 RELEASES_DEFAULT_PAGE_SIZE）。
import { RELEASES_DEFAULT_PAGE_SIZE } from "./app-deployment-release-view.collaborator";

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

/**
 * P1-A2（2026-10-25 真机审计）：卡死扫描阈值——PENDING 行 5 分钟。
 *
 * deploy() 先 INSERT（PENDING）再异步推送，进程在两步之间崩溃会留下永久
 * PENDING 行，持续占住 in-flight 唯一索引。正常 PENDING 窗口是进程内的
 * （自动选机 + 推送重试 ≈ <100s），5 分钟已高于任何合法持有。
 */
export const DEPLOYMENT_PENDING_TIMEOUT_MS = 5 * 60_000;

/**
 * P1-A2（2026-10-25 真机审计）：卡死扫描阈值——DEPLOYING/UPGRADING 行
 * 30 分钟无任何写（心跳/状态推进/批次痕迹都算进度写）→ 判败。
 *
 * 判据键是 updatedAt（@UpdateDateColumn）：执行器心跳（handleHeartbeat 的
 * 条件 UPDATE）、deploy/upgrade 的进度写、灰度批次痕迹写都会刷新它——
 * 即「以最后一次心跳/事件时间起算」，活跃部署（慢网络拉大包也在持续心跳）
 * 永远不会被误杀；只有执行器彻底沉默（如注册 409 死锁、容器被删）的行
 * 才会被扫死，解锁 stop/删除链与该应用的下一个部署。
 *
 * 历史取值 10min：对「执行器接受命令后本地慢慢部署」的形态偏紧——执行器
 * 侧部署完成前不一定产出心跳（大包下载/解压），慢链路下 10 分钟可能误杀
 * 正常部署，故按审计建议放宽到 30min（仍远小于「永久在途」的故障面）。
 * 与命令 TTL（DEPLOYMENT_CMD_TTL_MS_DEFAULT，同为 30min）同量级不是巧合：
 * pull 入队行的豁免窗就是按「TTL 内不扫死」设计的，两窗对齐后豁免仅在
 * 运维调大 TTL 时才实际生效。
 */
export const DEPLOYMENT_STALL_TIMEOUT_MS = 30 * 60_000;

// B1a 拆分：审批动作人身份与触发来源两个类型已迁至
// `./application-approval.collaborator.ts`（与审批决策同域）。
// 本文件 re-export 保持外部 import 路径不变（`app-deployment.controller.ts`
// 等消费方零改动）。
import {
  ApplicationApprovalCollaborator,
  type DeploymentApprovalActor,
  type DeploymentTriggerContext,
} from "./application-approval.collaborator";
export type {
  DeploymentApprovalActor,
  DeploymentTriggerContext,
} from "./application-approval.collaborator";
// T1-B5a：版本 × 部署**只读追溯视图**协作者（DEP-01）。写面仍在本类。
import { AppDeploymentReleaseView } from "./app-deployment-release-view.collaborator";
// T1-B5b：灰度编排状态机协作者（连状态一起搬；Facade 不再持批次表）。
import {
  AppDeploymentRollout,
  type RolloutBatch,
} from "./app-deployment-rollout.collaborator";

/**
 * DEP-04 门控的**调用方意图**（Agent 侧 fail-closed 前置用）。
 *
 * ## 为什么需要这个参数
 * DEP-04 的开关 `application.approvalRequired` 是**按应用**的、默认 `false`
 * （`application.entity.ts:60`）。人工路径（控制台 / API）直接用这个开关：
 * 应用开了才冻结成待审批，没开就直跑——这是**人工自己点的部署**，人本身就是
 * 决策者，不需要第二个人再点一次。
 *
 * 但 Agent 路径不同：Agent 不是人。`deploy_application` / `deploy_app`
 * （`agent/tools/tool-binder.service.ts`）是**机器**在部署生产应用，而 DEP-04
 * 默认关 ⇒ 从未开过审批的应用，Agent 部署是**零门**的（这正是
 * `agent/tools/gate-inventory.ts` 里 `deploy_application` / `deploy_app`
 * 两条 `known-gap` 登记的事实）。
 *
 * ## 判据（可复核）
 * `forceApproval: true` ⇒ **无论** `app.approvalRequired` 是 true 还是 false，
 * 本次部署都走 DEP-04 的冻结路径（落 `pending_approval` 行、不派发），
 * 由另一位管理员在审批待办里处置。
 *
 * ## 为什么用参数而不是改 `app.approvalRequired` 的默认值
 * 改默认值会**同时改变人工路径的行为**（人工部署也会全部变待审批）——那超出
 * 「给 Agent 侧加一道门」的范畴，且违反「人工路径行为逐字节不变」的纪律。
 * 本参数是**调用方意图**：`undefined` = 旧行为（只看应用开关），
 * 人工路径永远传 `undefined`，故其行为**逐字节不变**。
 *
 * ## 不做什么
 * 不在本层做「谁该批准」的身份判定——那是 DEP-04 的第二人规则（`approve()`
 * 里的 `assertSecondPerson`）与审批待办面的事。本参数只回答
 * 「这次要不要先冻结成待审批行」。
 */
export interface DeploymentApprovalIntent {
  /**
   * true ⇒ 强制走 DEP-04 冻结路径（即使应用未开 `approvalRequired`）。
   * false / undefined ⇒ 沿用「只看应用开关」的旧语义。
   */
  forceApproval?: boolean;
}

@Injectable()
export class AppDeploymentService implements OnModuleDestroy, OnModuleInit {
  private readonly logger = new Logger(AppDeploymentService.name);

  // T1-B5b：`rolloutBatches` / `rolloutTimers` **已整体搬进协作者**
  // （`AppDeploymentRollout` 自持）——这是「Facade 持 Map + 协作者拿引用 =
  // 伪拆分」那条判据的直接落地。**请勿在此恢复同名字段**：两份状态会让
  // finishBatch 删一份、onModuleDestroy 清另一份 ⇒ 幽灵批次永久占着该应用
  // 的灰度位（`uq_app_deployments_rollout_claim` 恒有占用行）。

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

  /**
   * B1a 拆分：审批决策协作者（懒构造）。
   *
   * 为什么**懒构造**而不是在构造器里 `new`：
   * - 协作者需要 `this.logger`（service 的实例 —— 两条 spec spy 的是它）
   *   与 `this.recordDeploymentEvent`（跨簇回调）——两者都要等 service 自身
   *   构造完才可用；
   * - 懒构造让**构造器的 9 个位置参数完全不动**（B 方案 C1 策略的硬不变量：
   *   存量 spec 以位置实参装配 `new AppDeploymentService(...)`）。
   *
   * 协作者的依赖全部是**最小接口**（不接收整个 service），见
   * `application-approval.collaborator.ts` 的类头注。
   */
  private approvalCollaborator?: ApplicationApprovalCollaborator;

  private get approval(): ApplicationApprovalCollaborator {
    if (!this.approvalCollaborator) {
      this.approvalCollaborator = new ApplicationApprovalCollaborator({
        repo: this.repo,
        audit: this.audit,
        appService: this.appService,
        // ⚠️ 必须传 service 自己的 logger：spec 用
        // `jest.spyOn((service as any).logger, "warn")` 断言它
        // （app-deployment.service.spec.ts:1422/1464）⇒ 协作者若自己
        // `new Logger()`，那两条用例会红。
        logger: this.logger,
        // 跨簇横向能力以回调注入（不把整个 service 递进去）
        onEvent: (input) => this.recordDeploymentEvent(input),
        maskForRead: (deployment) => this.maskDeploymentForRead(deployment),
        loadApplication: (applicationId) =>
          this.appService.findByIdRaw(applicationId),
        pushDeploy: (deployment, app) =>
          this.pushDeployToExecutor(deployment, app as Application),
      });
    }
    return this.approvalCollaborator;
  }

  /**
   * T1-B5a：**版本 × 部署只读追溯视图**协作者（懒构造）。
   *
   * 边界：只收 `/versions` 与 `/releases` 两条**只读**追溯面的拼装逻辑，
   * **零 repo 写、零事务、零可变状态**（实测本簇无 S3 / 无缓存字段 ⇒
   * 不需要「按引用共享」纪律，与 rolloutBatches 那类状态机本体不同）。
   *
   * 懒构造：协作者需要本类的 `logger` / `repo` / `versionRepo` /
   * `deploymentEventRepo` / `appService` / `executorService`，且必须让
   * 构造器 **9 个位置参数 / 4 个 @Optional 完全不动**。
   */
  private releaseViewCollaborator?: AppDeploymentReleaseView;

  private get releaseView(): AppDeploymentReleaseView {
    if (!this.releaseViewCollaborator) {
      this.releaseViewCollaborator = new AppDeploymentReleaseView({
        repo: this.repo,
        versionRepo: this.versionRepo,
        deploymentEventRepo: this.deploymentEventRepo,
        appService: this.appService,
        executorService: this.executorService,
        // `findAllByApp` 是 ① 直调的 public 读面（留 Facade）——经回调调用
        findAllByApp: (applicationId) => this.findAllByApp(applicationId),
        // ⚠️ 必须是本类的 logger 实例（既有 spec spy 的是它）
        logger: this.logger,
      });
    }
    return this.releaseViewCollaborator;
  }

  /**
   * T1-B5b：**灰度编排状态机**协作者（懒构造）。
   *
   * ## ⚠️ 状态归属：`rolloutBatches` / `rolloutTimers` 已**搬进协作者**
   *
   * 这是 T1-B5 那条判据的直接落地：「Facade 持 Map + 协作者拿引用 = 伪拆分」。
   * 两个 Map 现在是 `AppDeploymentRollout` 的**自持字段**，Facade 只经
   * `this.rollout` 转发调用；**不再**在 Facade 上保留同名字段（保留会立刻
   * 出现两份状态，`finishBatch` 删一份、`onModuleDestroy` 清另一份 ⇒ 幽灵批次）。
   *
   * ## 测试探针
   *
   * spec 原用 `(service as any).rolloutBatches` 直摸字段（17 处）。搬走后统一走
   * {@link __rolloutStateForTest}：交出的是**限定能力句柄**（每次调用读当前
   * 状态，不是快照），不是 Map 实例本身 —— 与「Facade 不该交出可变状态容器」
   * 一致。轮询闭包（rollout.spec:598）与中途删批次（:887）依赖这个实时性。
   *
   * 懒构造：协作者需要本类的 `logger` / `repo` / `versionRepo` / `appService`
   * 与若干写面回调，且必须让构造器 **9 个位置参数 / 4 个 @Optional 完全不动**。
   */
  private rolloutCollaborator?: AppDeploymentRollout;

  private get rollout(): AppDeploymentRollout {
    if (!this.rolloutCollaborator) {
      this.rolloutCollaborator = new AppDeploymentRollout({
        repo: this.repo,
        versionRepo: this.versionRepo,
        appService: this.appService,
        // ⚠️ 必须是本类的 logger 实例（spec spy 的是它）
        logger: this.logger,
        // 跨簇写面一律经 Facade 转发（这些成员各自被 spec spyOn / 属写面）
        // ⚠️ **必须原样透传实参元数**（`...args`）：两个调用点形状不同——
        //   · `upgradeAllWithRollout` 是 `this.upgrade(id, trigger)`（**2 参**，
        //     trigger 常为 undefined）；
        //   · `promoteRest` 是 `this.upgrade(id)`（**1 参**）。
        // 若在此「统一成 2 参」或「把 undefined 折叠掉」，jest 的
        // `toHaveBeenCalledWith(...)` 实参元数就对不上（本轮实测 4 例假红）。
        upgrade: (...args: [string, DeploymentTriggerContext?]) =>
          this.upgrade(...args),
        rollbackDeploymentToPrevious: (deploymentId, trigger) =>
          this.rollbackDeploymentToPrevious(
            deploymentId,
            trigger as DeploymentTriggerContext | undefined,
          ),
        findByIdRaw: (id) => this.findByIdRaw(id),
        buildVersionRestoreDto: (app, version) =>
          this.buildVersionRestoreDto(app, version),
        // ③ 赋值式覆写的两个成员：必须经 Facade 转发，否则 spec 的桩恒不被
        // 调用 ⇒ 静默假过（先例：B3 的 failInterpreterUnavailable 判据）。
        probeOnce: (url, pinCfg, timeoutMs) =>
          this.probeOnce(url, pinCfg, timeoutMs),
        rolloutTickInner: (appId, batch) => this.rolloutTickInner(appId, batch),
        isRolloutClaimUniqueViolation: (err) =>
          this.isRolloutClaimUniqueViolation(err),
      });
    }
    return this.rolloutCollaborator;
  }

  /**
   * T1-B5b：**灰度状态探针**（仅供 spec；生产不调用）。
   *
   * 交出的是**限定能力句柄**——方法内部读 `this.rollout.batches`，所有权仍在
   * 协作者。**每次调用读当前状态**（不是快照）：rollout.spec:598 的
   * `pumpUntil` 轮询闭包、:887 的中途删批次都依赖这一点。
   */
  __rolloutStateForTest(): {
    hasBatch(appId: string): boolean;
    batchCount(): number;
    getBatch(appId: string): RolloutBatch | undefined;
    seedBatch(appId: string, batch: RolloutBatch): void;
    dropBatch(appId: string): void;
    timerCount(): number;
    hasTimer(t: NodeJS.Timeout): boolean;
  } {
    return {
      hasBatch: (appId) => this.rollout.batches.has(appId),
      batchCount: () => this.rollout.batches.size,
      getBatch: (appId) => this.rollout.batches.get(appId),
      seedBatch: (appId, batch) => {
        this.rollout.batches.set(appId, batch);
      },
      dropBatch: (appId) => {
        this.rollout.batches.delete(appId);
      },
      timerCount: () => this.rollout.timers.size,
      hasTimer: (t) => this.rollout.timers.has(t),
    };
  }

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

  /** ⚠️ D-18：**本方法的乐观锁分支是死分支，不要依赖它提供互斥**。
   *
   *  ## 曾经的错误假设（已证伪，2026-11-03，源码级三重取证）
   *
   * 此前这里的注释宣称「`@VersionColumn` 让 `save` 自动追加 `AND version = :expected`；
   * 并发后写撞版本时 TypeORM 抛 `OptimisticLockVersionMismatchError`」。**三条全为假**：
   *   ① `typeorm/persistence/SubjectExecutor.js`（`save()` 的执行体）**零处**把
   *      `versionColumn` 用于 WHERE；
   *   ② `typeorm/query-builder/UpdateQueryBuilder.js` 对版本列**只自增**
   *      （`SET "version" = "version" + 1`），不拼接任何版本谓词；
   *   ③ `OptimisticLockVersionMismatchError` 的**唯一**抛出点在
   *      `SelectQueryBuilder.js`，且被 `lockMode === "optimistic"` 守护 ⇒
   *      `repo.save()` **永不进入**（全仓亦无 `setLock("optimistic")`）。
   *
   * ⇒ `repo.save()` 是**最后写入者静默胜出**：并发 `stop` / `upgrade` / `redeploy`
   * 之间既不报错、也不互相拦截。下面 catch 里的
   * `APP_DEPLOYMENT_CONCURRENT_MODIFICATION`（409）**生产永不触发**。
   *
   * ## 正确的并发保护
   *
   * 必须靠**显式条件 UPDATE**（`WHERE id = :id AND version = :expected`，配合
   * `SET version = version + 1`，`affected = 0` ⇒ 409）。见 `stop()` 与
   * `upgrade()`（1-A）的实现。
   *
   * ## 本方法为何保留
   *
   * 仍有若干 read-modify-write 调用点尚未改造（清单见
   * `docs/archive/audits/2026-11-03-round1/optimistic-lock.md` §2）。
   * 保留它不会更糟（它等价于裸 `repo.save`），但**它不提供任何互斥**。
   * 新增代码**不要**再走这里。
   *
   * 反向实证见
   * `apps/admin-api/src/modules/application/__tests__/app-deployment.optimistic-lock.spec.ts`。 */
  /**
   * R179：**复用行的条件 UPDATE（CAS）** —— 从 `deploy()` 外提。
   *
   * ## 为什么外提
   * `deploy()` 的函数体已顶到 `check:size-caps` 的**逐函数**上限（307），
   * 而这段 CAS 有 15 个 `.set()` 列 + 链式调用 ⇒ 塞进 `deploy()` 必然破顶。
   * 这是**纯搬移**（同一份判定、同一份列、同一个错误码），不改变行为。
   *
   * ## 语义（**这是它存在的全部理由**）
   * 两个并发「重新部署」都能读到**同一条**可复用行。此前各自 `save()` **整行写回**
   * ⇒ 后写者把前者的改动整个覆盖，且两次都往执行器推了命令 ⇒
   * **表里的状态与执行器实际状态永久对不上**。
   * 现在用 `version` 谓词的条件 UPDATE：**只有一个请求 `affected === 1`**，
   * 另一个 `affected === 0` ⇒ 抛并发冲突（409）。
   *
   * ⚠️ 谓词同时含 `version` **和** `status`：`version` 拦「同一条行的并发写」，
   * `status` 额外保证「这条行此刻仍是我读到时的终态」。
   * ⚠️ **为什么不是 `saveWithOptimisticLock`**：TypeORM 的 `save()` **不拼 `WHERE version`**；
   * 该异常只由 `SelectQueryBuilder` 的 optimistic 分支抛，而仓内无 `setLock("optimistic")`
   * ⇒ 那个 catch 是**死分支**（三重源码取证见其头注）。
   */
  private async claimReusableDeployment(
    reusable: AppDeployment,
    originalStatus: DeploymentStatus,
  ): Promise<void> {
    const expectedVersion = reusable.version;
    const claim = await this.repo
      .createQueryBuilder()
      .update(AppDeployment)
      .set({
        executorAddress: reusable.executorAddress,
        runMode: reusable.runMode,
        env: reusable.env,
        startCommand: reusable.startCommand,
        status: reusable.status,
        statusMessage: reusable.statusMessage,
        triggerType: reusable.triggerType,
        operator: reusable.operator,
        pid: reusable.pid,
        approvalStatus: reusable.approvalStatus,
        approvalMeta: reusable.approvalMeta,
        rolloutState: reusable.rolloutState,
        rolloutMeta: reusable.rolloutMeta,
        rolloutBatchClaimId: reusable.rolloutBatchClaimId,
        version: () => '"version" + 1',
      })
      .where('"id" = :id', { id: reusable.id })
      .andWhere('"version" = :expected', { expected: expectedVersion })
      .andWhere('"status" = :expectedStatus', {
        expectedStatus: originalStatus,
      })
      .execute();
    if ((claim?.affected ?? 0) === 0) {
      throw new AppError(ErrorCode.APP_DEPLOYMENT_CONCURRENT_MODIFICATION, {
        deploymentId: reusable.id,
      });
    }
    reusable.version = expectedVersion + 1;
  }

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

  /** T1-B5a：**转发层**（实现已迁至 `AppDeploymentReleaseView`）。 */
  async getVersionHistory(applicationId: string) {
    return this.releaseView.getVersionHistory(applicationId);
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
  /** T1-B5a：**转发层**（实现已迁至 `AppDeploymentReleaseView`）。 */
  async getReleases(
    applicationId: string,
    page = 1,
    pageSize = RELEASES_DEFAULT_PAGE_SIZE,
  ): ReturnType<AppDeploymentReleaseView["getReleases"]> {
    return this.releaseView.getReleases(applicationId, page, pageSize);
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

  /**
   * P8-R（部署模型评审遗留）：「有设备保留但被 truncated 吞掉」的版本号差集。
   *  口径与 buildReleaseDevices 完全一致：currentVersion 命中或 ∈ retainedVersions
   *  即「设备还留着这版」；与本页已返回行的版本集合（含 synthetic 行）求差，
   *  剩下的就是只在被截部分出现的事实版本号。纯内存计算（facts 本就全量在
   *  手），字母序排序保证响应确定性。
   */

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

  /** FEAT-20：release 行触发方式解析——部署行 triggerType 持久化列优先
   *  （manual/upgrade/rollback/approval 直读），存量行（null）回退既有
   *  classifyReleaseTrigger 信号推导。 */

  /**
   * 版本快照 → 应用字段恢复映射（rollbackApplication 与版本定向灰度共用）。
   * 恒返回至少含 version/runtime 两键的对象（调用方直接 update）。
   */
  /** T1-B5a：**转发层**（实现已迁至 `AppDeploymentReleaseView`）。 */
  private buildVersionRestoreDto(
    app: { runtime: string },
    version: {
      version: string;
      gitCommit?: string | null;
      snapshot?: Record<string, any> | null;
    },
  ): Record<string, any> | null {
    return this.releaseView.buildVersionRestoreDto(app, version);
  }

  /**
   * R1（2026-10-24 部署模型评审 §4.2）：rollbackApplication 快照路径的三重守卫
   * 抽段——setCurrentVersion / deployVersion 与 rollbackApplication 共用同一份
   * 校验与错误码（属本应用 → 有版本号 → released），三个写面口径永不漂移。
   */
  /** T1-B5a：**转发层**（实现已迁至 `AppDeploymentReleaseView`）。 */
  private assertVersionRestorable(
    appId: string,
    version: {
      applicationId: string;
      version: string | null;
      status: string | null;
    },
  ): void {
    this.releaseView.assertVersionRestorable(appId, version);
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
    intent?: DeploymentApprovalIntent,
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
    //
    // 判据（可复核）：
    //   · `app.approvalRequired` —— 应用级开关，**人工路径**的唯一判据；
    //     默认 false（`application.entity.ts:60`）。
    //   · `intent?.forceApproval` —— **Agent 路径**的 fail-closed 前置：
    //     即使应用没开开关，Agent 触发的部署也要先冻结成待审批行。
    //     人工路径永远不传它（controller 的 deploy() 不传），故人工行为
    //     **逐字节不变**（见 `DeploymentApprovalIntent` 头注）。
    //
    // 两个判据是**或**关系：任一为真即冻结。应用开了开关时走既有路径
    // （approvalMeta / 事件 detail 都逐字节不变）；Agent 路径且应用没开
    // 开关时，同样落 pending_approval 行——此时 detail 里的
    // `approvalRequired: true` 仍然**准确**（这一行确实被门控了），
    // 故不必（也不宜）引入新的 detail 键：那会改动人工路径的事件字节。
    // Agent 来源的审计线索由 `approvalMeta.requestedByName="agent"` 承担。
    const approvalRequired =
      app.approvalRequired || intent?.forceApproval === true;
    if (approvalRequired) {
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
      const originalStatus = reusable.status; // R179：CAS 谓词要用**读到时**的 status
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
      // R1 阶段 1 · 1-B（迁移 1790000000095）：复用行必须**清 claim**。
      //
      // ⚠️ 不清的后果：`uq_app_deployments_rollout_claim` 的谓词是
      // `"rolloutBatchClaimId" IS NOT NULL` ⇒ 陈旧的 claim 留在行上 ⇒
      // 该应用的唯一索引**恒有占用行** ⇒ **后续所有灰度永久被拒**
      // （CAS 恒 affected=0）——比原来的 TOCTOU 缺陷更严重（那个只影响并发
      // 窗口，这个影响该应用 forever）。
      reusable.rolloutBatchClaimId = null;

      let reused: AppDeployment;
      try {
        // A-3: 并发双击「重新部署」——两个请求都能通过上方的 reusable findOne。
        //
        // ⚠️ D-18（2026-11-03）订正：原注释称「后写者在 @VersionColumn 上撞版本抛
        // `OptimisticLockVersionMismatchError`，收口到 saveWithOptimisticLock 转 409」
        // —— **该保护不存在**（三重源码取证见 `saveWithOptimisticLock` 头注：
        // TypeORM `save()` 不拼 `WHERE version`，该异常只在 `SelectQueryBuilder` 的
        // optimistic 锁分支抛出，而仓内无 `setLock("optimistic")`）。
        // ⇒ 并发双击时**后写者静默覆盖前者**，不会 409。
        //
        // 本路径**实际生效**的并发保护是**唯一索引**
        // `uq_app_deployments_application_in_flight`（下方 catch 里的
        // `isInFlightUniqueViolation`）——它才是真正拦住「同一应用并发建行」的那道闸。
        // 条件 UPDATE 改造待做（见 `optimistic-lock.md` §2 调用点 #1）。
        // R179：不再 save() 整行写回（会静默覆盖并发写）⇒ 走 version 谓词的条件 UPDATE。
        await this.claimReusableDeployment(reusable, originalStatus);
        reused = reusable;
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
  /**
   * DEP-04：审批通过。
   *
   * B1a 拆分：实现已迁至 `ApplicationApprovalCollaborator`（审批决策域），
   * 本方法保留为**转发层**——public 签名与外部行为逐字节不变。
   * 编排顺序（决策落库 → 推送执行器 → 审计留痕 → 事件落库 → 掩码返回）
   * 在协作者内保持不变，见协作者类头注「时序不变量」。
   */
  async approveDeployment(
    deploymentId: string,
    actor: DeploymentApprovalActor,
    reason?: string,
    trigger?: DeploymentTriggerContext,
  ): Promise<AppDeployment> {
    return this.approval.approveDeployment(
      deploymentId,
      actor,
      reason,
      trigger,
    );
  }

  /** DEP-04: 审批拒绝——终态落 FAILED（离开 in-flight 集合），reason 随
   *  approvalMeta 与 statusMessage 双落。第二人规则与 approve 同校验
   *  （提交者撤回自己的请求走 cancel，不走 reject）。 */
  /**
   * DEP-04：审批拒绝——终态落 FAILED（离开 in-flight 集合），reason 随
   *  approvalMeta 与 statusMessage 双落。第二人规则与 approve 同校验
   *  （提交者撤回自己的请求走 cancel，不走 reject）。
   *
   * B1a 拆分：实现已迁至 `ApplicationApprovalCollaborator`，本方法为转发层。
   */
  async rejectDeployment(
    deploymentId: string,
    actor: DeploymentApprovalActor,
    reason?: string,
  ): Promise<AppDeployment> {
    return this.approval.rejectDeployment(deploymentId, actor, reason);
  }

  /** DEP-04: 提交者撤回自己的待审批请求（第二人规则的镜像面——其他管理员
   *  想否决走 reject）。终态语义与 reject 相同（FAILED 离开 in-flight）。 */
  /**
   * DEP-04：提交者撤回自己的待审批请求（终态落 FAILED）。
   *
   * B1a 拆分：实现已迁至 `ApplicationApprovalCollaborator`，本方法为转发层。
   */
  async cancelDeployment(
    deploymentId: string,
    actor: DeploymentApprovalActor,
  ): Promise<AppDeployment> {
    return this.approval.cancelDeployment(deploymentId, actor);
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
   *
   * ⚠️ B1a 拆分：本方法**刻意留在 service**——它是跨簇横向能力（6 个调用点里
   * 3 个在审批簇外：deploy/upgrade/stop/removeDeployment），且
   * `app-deployment-events.spec.ts:729` 直接调用它验证 detail 脱敏 ⇒
   * 留在 service ⇒ 那条 spec 逐字未改仍绿。审批簇以 `onEvent` 回调调用它。
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
        // 2026-11-02（自查）：`detail` 落库前过脱敏。
        // 为什么必须补：本表的注释自己写着「**事件表无掩码读面**，密钥进事件即泄漏」，
        // 而此前这里是 `input.detail ?? null` —— **不过任何脱敏函数**，
        // 安全性只来自「7 个调用方各自只传标量」这个**约定**。
        // 其中 `reason` 是**人工输入的审批理由**（controller 传入的自由文本）
        // ⇒ 运维写一句「rotated token=abc…」就会明文进表，且**没有掩码读面兜底**。
        // 现在把「约定」升级成「机制」：键名/字符串值都过一遍脱敏。
        detail: this.approval.sanitizeEventDetail(input.detail),
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

    // R1 阶段 1 · 1-A：**行级原子占坑**——根治 P-5「同一行被两次 upgrade」。
    //
    // ## 缺陷现场（Round 1 审计 P-5）
    //
    // `upgrade()` 此前直接 `deployment.status = UPGRADING; saveWithOptimisticLock(...)`，
    // **没有任何「该行是否已在 upgrading」的守卫**。
    //
    // ⚠️ D-18（2026-11-03）订正：原注释称「`@VersionColumn` 乐观锁只保证不互相覆盖」——
    // **连「不互相覆盖」都保证不了**（TypeORM `save()` 不拼版本谓词，见
    // `saveWithOptimisticLock` 头注的三重取证）。所以当时的并发 upgrade **不是**
    // 「其中一个 409」，而是**两个都成功、后写者静默覆盖**：
    //   · 两个**并发** upgrade → 双方都写成功（无 409）⇒ 状态机被后者覆盖；
    //   · 两个**串行** upgrade（人工先 webhook 后点 deploy-version）→ **两次都成功**
    //     ⇒ 执行器收到两次 deploy 命令（执行器侧会先停旧进程再启新的 ⇒ 不是
    //     双进程，但多一次停机+启动，且用户看到的状态机跳变）。
    //
    // ## 为什么是「条件 UPDATE」而不是「先查状态再改」（TOCTOU）
    //
    // 「先 `findOne` 看 status、再 `save`」是**读后判**：两个并发请求可同时通过
    // 检查、都看到 `status='running'`、都写 `UPGRADING` ⇒ 拦不住。
    // 而**条件 UPDATE**（`WHERE id=:id AND status='running'`）是**原子 CAS**：
    // DB 保证只有一个赢家拿到 `affected=1`，另一个拿到 `affected=0` ⇒
    // **结构上不可能重复执行**，应用层写错也安全。
    //
    // ## 语义边界（刻意保守）
    //
    // 只允许 `running → upgrading`。`failed`/`stopped` 行**不可**直接 upgrade
    // （需先 deploy 出一条新行）——这与既有语义一致，且避免把「已停止」的部署
    // 复活。`affected=0` 时抛 409（复用既有码 `APP_DEPLOYMENT_ALREADY_IN_FLIGHT`）。
    const claimed = await this.repo
      .createQueryBuilder()
      .update(AppDeployment)
      .set({
        status: DeploymentStatus.UPGRADING,
        statusMessage: "Upgrade triggered",
        startCommand: deployment.startCommand,
        // FEAT-20：升级动作落触发来源（upgrade 语义；不覆盖既有 operator 时
        // 用本次触发人——行复用升级，最近一次动作人是最新事实）。
        ...(trigger
          ? { triggerType: trigger.triggerType, operator: trigger.operator }
          : {}),
      })
      .where('"id" = :id AND "status" = :expected', {
        id: deployment.id,
        expected: DeploymentStatus.RUNNING,
      })
      .execute();

    if ((claimed?.affected ?? 0) === 0) {
      // 条件 UPDATE 输掉 = 该行已不在 `running`（已在 upgrading / 已停止 / 已失败）
      // ⇒ 结构上不可能重复执行。抛 409 让调用方显式感知（而非静默二次执行）。
      this.logger.warn(
        `Upgrade claim lost for deployment ${deployment.id} ` +
          `(status is not ${DeploymentStatus.RUNNING}) — refusing duplicate upgrade`,
      );
      throw new AppError(ErrorCode.APP_DEPLOYMENT_ALREADY_IN_FLIGHT, {
        name: app.name,
        deploymentId: deployment.id,
        detail: "（该部署已在升级中）",
      });
    }

    // 占坑成功后把内存实体同步到落库后的状态（后续事件/推送都读它）。
    deployment.status = DeploymentStatus.UPGRADING;
    deployment.statusMessage = "Upgrade triggered";
    if (trigger) {
      deployment.triggerType = trigger.triggerType;
      deployment.operator = trigger.operator;
    }

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
    // D-18：**显式条件 UPDATE** 取代 read-modify-write + save。
    //
    // 为什么必须换：`repo.save()` 的 `@VersionColumn` **不做**任何版本比较
    // （TypeORM 的 SubjectExecutor 零处把 versionColumn 用于 WHERE，见
    // `saveWithOptimisticLock` 头注的三重取证）⇒ 旧的
    // `saveWithOptimisticLock(deployment)` 是**最后写入者静默胜出**：
    // 两个并发 stop/upgrade 都成功，后者的整行覆盖前者，且**永不**抛 409。
    //
    // 条件 UPDATE 是原子 CAS：`WHERE id = :id AND version = :expected` +
    // `SET version = version + 1`。DB 保证只有一个赢家拿到 `affected = 1`，
    // 另一个拿到 0 ⇒ 转 409，客户端重载重试。与 `upgrade()`（1-A）同口径。
    //
    // 只写本次动作真正改变的列（status / pid / statusMessage），不整行回写
    // ——整行 save 会用读到的快照覆盖并发的其他列（心跳推进、审批痕迹等）。
    const expectedVersion = deployment.version;
    const stopClaimed = await this.repo
      .createQueryBuilder()
      .update(AppDeployment)
      .set({
        status: DeploymentStatus.STOPPED,
        pid: null,
        statusMessage: deployment.statusMessage,
        version: () => '"version" + 1',
      })
      .where('"id" = :id', { id: deployment.id })
      .andWhere('"version" = :expected', { expected: expectedVersion })
      .execute();
    if ((stopClaimed?.affected ?? 0) === 0) {
      // 输掉 CAS = 该行已被别的请求改写（并发 stop/upgrade/redeploy）
      // ⇒ 结构上不可能「两个都成功」，也不再是静默覆盖。
      this.logger.warn(
        `Stop claim lost for deployment ${deployment.id} ` +
          `(expected version ${expectedVersion}) — concurrent modification`,
      );
      throw new AppError(ErrorCode.APP_DEPLOYMENT_CONCURRENT_MODIFICATION, {
        deploymentId: deployment.id,
      });
    }
    // 内存视图同步到落库后的状态（version 已被 DB 自增），供下方的
    // 审计 / 事件 / 读面使用——它们只读这些列，不需要再回查。
    deployment.version = expectedVersion + 1;
    const saved = deployment;
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
   * R1 阶段 1 · 1-B：是否撞了**灰度批次 claim** 的部分唯一索引
   * （`uq_app_deployments_rollout_claim`）。
   *
   * 与 `isInFlightUniqueViolation` **严格分开**——两者约束不同列、语义不同：
   * 前者 = 「部署创建被拒（已有在途部署行）」，后者 = 「另一个实例正在灰度
   * 本应用」。把后者误报成前者（或反之）会把运维引向错误的排查方向。
   */
  private isRolloutClaimUniqueViolation(err: unknown): boolean {
    return this.isUniqueViolationWithConstraint(
      err,
      ROLLOUT_CLAIM_UNIQUE_INDEX,
    );
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
    // ⚠️ D-18（2026-11-03）：**这里没有并发保护**——原注释的论证链已被证伪。
    //
    // 原注释（R59）声称：「`@VersionColumn` 会让 save 自动追加 `AND version = :expected`，
    // 撞版本时抛 `OptimisticLockVersionMismatchError`，helper 翻成 409 ⇒ 数据**确实**
    // 被版本列保护着，只是错误码映射不同」。**该链条整体为假**（源码级三重取证见
    // `saveWithOptimisticLock` 头注与 `docs/archive/audits/2026-11-03-round1/optimistic-lock.md`）：
    //   ① TypeORM `SubjectExecutor` **零处**把 `versionColumn` 用于 WHERE；
    //   ② `UpdateQueryBuilder` 对版本列**只自增**，不拼任何版本谓词；
    //   ③ `OptimisticLockVersionMismatchError` **只**由 `SelectQueryBuilder` 的
    //      `lockMode==='optimistic'` 分支抛出，而仓内**无任何** `setLock("optimistic")`
    //      ⇒ `repo.save()` 永不可达该分支。
    //
    // ⇒ **本方法这一步是「最后写入者静默胜出」**：两个并发推送/停机/心跳会互相覆盖，
    //   既不会 409，也不会抛任何异常。`saveWithOptimisticLock` 的 catch 是死分支。
    //
    // ## 为什么本轮**没有**把它改成条件 UPDATE（如实登记，不是遗漏）
    //
    // 试过：条件 UPDATE 只能写 `status` / `statusMessage` 两列（CAS 的正确形态），
    // 而此处原本的整行 `save` **还会写 `env` / `pid` 等列**。改完会使「推送后落库」
    // 不再持久化 env —— 这是**持久化形态变更**，不是加一把锁；实测触发了
    // `app-deployment.service.spec.ts` 的 QA1（raw env 落库）等 3 条用例，
    // 说明该行为确实被依赖。故按「先订正虚假声明、根治单独立项」的裁决处理：
    //   · **已做**：把这段假保护声明改成事实（本注释）。
    //   · **待做**：需先确认「升级/推送路径是否仍需要整行持久化 env」，
    //     再决定是（a）改为窄列条件 UPDATE + 把 env 持久化挪到明确位置，
    //     还是（b）保留整行写但接受静默覆盖并在上层加版本校验。
    //     登记于 `optimistic-lock.md` §2 的调用点 #3。
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
      // P3-①（2026-10-25 审计）：statusMessage 直出管理台状态列，文案用
      // 可读中文（下同）。
      const msg =
        "部署目标执行器记录已不存在（可能已被删除或自动清理）——请重新选择执行器后再次部署。";
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
        // P3-①（2026-10-25 审计）：这行文案会原样出现在管理台部署行状态列，
        // 直出英文「Deploy command sent to executor」不可读——改可读中文。
        // 语义：push HTTP 已成功，行转 DEPLOYING/UPGRADING，等执行器完成
        // 部署后经心跳回报（running → RUNNING / 失败 → FAILED）。
        await this.persistDeployProgress(
          deployment,
          upgrade ? DeploymentStatus.UPGRADING : DeploymentStatus.DEPLOYING,
          "部署命令已送达执行器，等待执行器完成部署并回报状态",
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
    // P3-①：推送失败的原因串同样直出状态列——中文化主句，保留底层 err 原文
    // （axios 报错是排障关键事实，不做翻译/加工）。
    const exhaustedMsg = `连续 ${MAX_ATTEMPTS} 次推送部署命令到执行器均失败：${lastError}`;
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
    // R50 同款（ADR-026 规则 4）：从「findOne → 改字段 → **整行 save**」改为
    // **列级条件 UPDATE**，只写 status 一列。
    //
    // 旧写法在 QA6 注释自己承认的真实形态（同一版本在多台执行器并发 rolling
    // upgrade）下有两个后果：
    //  ① 后写者按**自己读到的旧快照**整行回写，把对方刚写的
    //     status / snapshot / description 一起覆盖回去；
    //  ② 读与写之间的窗口里用户改的 description 会被整行回写弹回旧值。
    // 条件写把「当前 status 已经是目标值」写进 WHERE（Not(status)），因此：
    //  · 幂等——重复调用 affected=0，不产生无意义写入；
    //  · 行不存在时同样 affected=0（旧代码是 findOne 返回 null 后 return），
    //    语义逐字节等价，故无需读回。
    await this.versionRepo.update(
      {
        applicationId: deployment.applicationId,
        version: deployment.deployedVersion,
        // 同 saveVersionSnapshot：null 字面量在 TypeORM 1.x 的 where 里会抛错，
        // 未接 Git 的部署（deployedCommit 为 null）必须走 IsNull()。
        gitCommit:
          deployment.deployedCommit != null
            ? deployment.deployedCommit
            : IsNull(),
        sourceDeploymentId: deployment.id,
        status: Not(status),
      },
      { status },
    );
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

  /** QA1: shallow-clone a version snapshot with its env record masked. */

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
   *  ('deploying'/'upgrading') with no update for a while and mark them
   *  failed.
   *  P1-A2（2026-10-25 真机审计）：阈值收敛为命名常量——DEPLOYING/UPGRADING
   *  用 DEPLOYMENT_STALL_TIMEOUT_MS（30min）、PENDING 用
   *  DEPLOYMENT_PENDING_TIMEOUT_MS（5min），语义与取值依据见常量注释。
   *  R6: the predicate is updatedAt-based — a legacy deployment upgraded
   *  (re-entering DEPLOYING on the SAME row) kept its original createdAt;
   *  updatedAt is refreshed both when the row enters DEPLOYING/UPGRADING
   *  (status save) and on every heartbeat save, so the semantics are
   *  "in-progress and untouched for the window". UPGRADING is included
   *  because upgrades no longer pass through DEPLOYING (R5 index
   *  compatibility) and still need the same timeout coverage.
   *  QA5: PENDING is swept on a shorter threshold. deploy()
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
   *  豁免扫描：否则执行器离线超窗时行被判 FAILED 并释放 in-flight 槽位，
   *  旧命令在 TTL 内被重连的执行器消费 → 同一执行器两个真实进程。命令 TTL
   *  过后执行器侧本就按 issuedAt 丢弃载荷，届时再扫死是安全的。
   *
   *  rt-5（CRON-GUARD）：**顶层异常闸**。cron 回调不 await 返回的 Promise——
   *  本体内 find / 逐行 markVersionSnapshotStatus / recallDeploymentCommands /
   *  recordDeploymentEvent 全是独立 await 点，2 分钟一拍、每天 720 次暴露，
   *  任一次瞬态 DB 错误即 unhandledRejection → main.ts 的 gracefulFatalShutdown
   *  → 整实例 exit(1)。异常改由 guardedCron 兜住（warn + 下一拍重试，判态
   *  幂等），扫描体抽到 detectStuckDeploymentsBody。 */
  @Cron("0 */2 * * * *")
  async detectStuckDeployments(): Promise<void> {
    // ARCH-31 §5: 多实例下仅 cron Leader 执行。门禁必须留在**@Cron 方法体内**：
    // check-cron-leader-gate 的判据是「装饰器向下窗口内可见」，把门禁搬进
    // *Body 会让它判成「没有 leader 门禁」（本轮实测 5 个站点一起红）。
    if (this.leaderGate && !this.leaderGate.isLeader) return;
    await guardedCron("application.detectStuckDeployments", this.logger, () =>
      this.detectStuckDeploymentsBody(),
    );
  }

  /** detectStuckDeployments 的扫描体（异常由 guardedCron 统一兜住）。 */
  private async detectStuckDeploymentsBody(): Promise<void> {
    const fiveMinutesAgo = new Date(Date.now() - DEPLOYMENT_PENDING_TIMEOUT_MS);
    const stallCutoff = new Date(Date.now() - DEPLOYMENT_STALL_TIMEOUT_MS);
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
          updatedAt: LessThan(stallCutoff),
        },
        {
          status: DeploymentStatus.UPGRADING,
          updatedAt: LessThan(stallCutoff),
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

    // P1-A2：statusMessage 直出可读中文（消费面是管理台部署行的状态列，
    // 与 P3-①「Deploy command sent to executor」中文化同口径）；「[System]」
    // 前缀保留为机器可识别标记（迁移 1789000000000 的存量文案同款前缀），
    // 分钟数由常量推导，改阈值不会让文案漂移。
    const PENDING_MSG =
      `[System] 部署卡在 PENDING：推送始终未开始（可能服务重启时丢失）——` +
      `超过 ${DEPLOYMENT_PENDING_TIMEOUT_MS / 60_000} 分钟无进度，系统自动判败`;
    const TIMEOUT_MSG =
      `[System] 部署超时（无心跳）——超过 ${DEPLOYMENT_STALL_TIMEOUT_MS / 60_000} 分钟` +
      `无心跳或进度更新，系统自动判败`;

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
      // P2-2（2026-10-26 第三轮审计）：判败即撤令——行进 FAILED 后 in-flight
      // 槽位释放、新部署放行，而该部署的 pull deploy 命令在命令 TTL（默认
      // 30min）内仍滞留在执行器队列里：回归 pull 的执行器会照常执行它，给
      // 设备装上无人跟踪的应用（终态行心跳守卫拒绝推进），还可能与新部署
      // 叠成双进程。按 acf:cmdbydep:{deploymentId} 反向集合撤销在途命令
      // （ExecutorService 包装层收敛 Redis 故障，best-effort 不影响判败主链；
      // 撤销失败退回既有兜底：命令 TTL 过后执行器侧按 issuedAt 丢弃）。
      await this.executorService.recallDeploymentCommands(d.id);
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

  /** T1-B5b：**转发层**（实现已迁至 `AppDeploymentRollout`）。 */
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
    return this.rollout.upgradeAllWithRollout(
      appId,
      rollout,
      trigger,
      version,
      includeStopped,
      actor,
    );
  }

  /** T1-B5b：**转发层**（实现已迁至 `AppDeploymentRollout`）。 */
  /** DEP-03：解析应用 manifest 的 healthCheck 声明（宽松解析，非法=null）。 */
  private async resolveHealthCheck(
    appId: string,
  ): Promise<ReturnType<typeof parseManifestHealthCheck>> {
    return this.rollout.resolveHealthCheck(appId);
  }

  /** T1-B5b：**转发层**（实现已迁至 `AppDeploymentRollout`）。 */
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
  private async markRolloutState(
    deploymentId: string,
    state: RolloutState,
    meta: Record<string, any> | null,
    options?: { allowFromInFlight?: boolean },
  ): Promise<{ ok: boolean; reason?: string }> {
    return this.rollout.markRolloutState(deploymentId, state, meta, options);
  }

  // -----------------------------------------------------------------------
  // ARCH-31: 灰度批次的多实例一致性
  // -----------------------------------------------------------------------

  /** T1-B5b：**转发层**（实现已迁至 `AppDeploymentRollout`）。 */
  /**
   * R1 1-B（迁移 1790000000095）：**释放本批次的应用级占坑**（claim 列置回 NULL）。
   *
   * 带 `batchId` 守卫：只清自己那条 claim，绝不误清别的批次的
   * （两实例交接时后者已抢占成功的情况下，前者迟到的释放不得把后者的坑填掉）。
   *
   * ⚠️ 之所以把 `batchId` 作**入参**而不是从 `this.rolloutBatches` 现取：
   * `finishBatch` / `failBatch` 在调用本方法前已经 `delete` 了内存批次
   * （先清定时器与内存态，再做行级收口），此时 `rolloutBatches.get(appId)`
   * 恒为 undefined ⇒ 现取会把 batchId 取成 undefined ⇒ 守卫恒不命中 ⇒
   * **claim 永不释放** ⇒ 该应用后续所有灰度永久 blocked。
   * 故所有调用点都必须传**调用前捕获**的 batchId 局部变量。
   *
   * 失败只记 warn（fail-open）：释放是收尾动作，DB 抖动不该改变批次结论；
   * `markInterruptedRolloutsFailed` 的兜底扫描会覆盖残留 claim。
   */
  private async releaseRolloutClaim(
    appId: string,
    batchId: string,
  ): Promise<void> {
    return this.rollout.releaseRolloutClaim(appId, batchId);
  }

  /** T1-B5b：**转发层**（实现已迁至 `AppDeploymentRollout`）。 */
  /** 该应用在途（pending/probing）的灰度行——跨实例可见的「批次是否已被占用」。 */
  private async findInFlightRolloutRows(
    appId: string,
  ): Promise<AppDeployment[]> {
    return this.rollout.findInFlightRolloutRows(appId);
  }

  /** T1-B5b：**转发层**（实现已迁至 `AppDeploymentRollout`）。 */
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
    return this.rollout.resolveRolloutBatch(appId, hint);
  }

  /** T1-B5b：**转发层**（实现已迁至 `AppDeploymentRollout`）。 */
  /** 行上是否留有批次痕迹（rolloutState 在途，或曾有 batchId）。 */
  private hasRolloutTrace(deployment: AppDeployment): boolean {
    return this.rollout.hasRolloutTrace(deployment);
  }

  /** T1-B5b：**转发层**（实现已迁至 `AppDeploymentRollout`）。 */
  /** 从 DB 行痕迹重建批次上下文（不注册定时器、不驱动探测/提升）。 */
  private async hydrateRolloutBatch(
    appId: string,
  ): Promise<RolloutBatch | null> {
    return this.rollout.hydrateRolloutBatch(appId);
  }

  /** T1-B5b：**转发层**（实现已迁至 `AppDeploymentRollout`）。 */
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
    return this.rollout.claimRolloutRows(ids, fromStates, toState);
  }

  /** T1-B5b：**转发层**（实现已迁至 `AppDeploymentRollout`）。 */
  /** 刷新批次活性租约（滚动重启时新实例据此判断「有实例仍在推进」）。 */
  private async touchRolloutLease(batch: RolloutBatch): Promise<void> {
    return this.rollout.touchRolloutLease(batch);
  }

  /** T1-B5b：**转发层**（实现已迁至 `AppDeploymentRollout`）。 */
  private lastRolloutMeta(
    batch: RolloutBatch,
  ): Record<string, any> | undefined {
    return this.rollout.lastRolloutMeta(batch);
  }

  /** T1-B5b：**转发层**（实现已迁至 `AppDeploymentRollout`）。 */
  /** DEP-02：handleHeartbeat 钩子——批次在途时，RUNNING 确认把行推进到
   *  probing（健康探测阶段）。FAILED/STOPPED 上报直接判批次失败。 */
  private async notifyHeartbeatToRollout(
    deployment: AppDeployment,
  ): Promise<void> {
    return this.rollout.notifyHeartbeatToRollout(deployment);
  }

  /** T1-B5b：**转发层**（实现已迁至 `AppDeploymentRollout`）。 */
  /** 提升轮结束：清批次内存态 + **行态收口**（行上 promoted 痕迹保留供读面）。 */
  private async finishBatch(appId: string): Promise<void> {
    return this.rollout.finishBatch(appId);
  }

  /** T1-B5b：**转发层**（实现已迁至 `AppDeploymentRollout`）。 */
  /**
   * 把给定行的**在途态**（pending/probing）收口到终态 state。
   * 条件 UPDATE 只命在途行：已 failed/rolled_back/promoted 的行不受影响，
   * 重复调用幂等。DB 抖动只记 warn（收口是收尾动作，失败不改变批次结论）。
   */
  private async settleRolloutRows(
    ids: string[],
    state: RolloutState,
  ): Promise<void> {
    return this.rollout.settleRolloutRows(ids, state);
  }

  /** T1-B5b：**转发层**（实现已迁至 `AppDeploymentRollout`）。 */
  /** DEP-02：批次失败——暂停批次 + 对已升级（含 probing）台自动回滚 +
   *  meta 记录失败原因。自动回滚=对每台走「重新部署上一版本」既有链；
   *  触发失败的台自身若未升上去则仅标记不回滚。 */
  private async failBatch(
    batch: RolloutBatch,
    failedId: string,
    reason: string,
  ): Promise<void> {
    return this.rollout.failBatch(batch, failedId, reason);
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
    // ⚠️ D-18（2026-11-03）：此处**曾**标注「E-P1-R2：乐观锁收口——并发后写撞版本转 409」，
    // 该保护**不存在**（TypeORM `save()` 不拼版本谓词，异常分支不可达；三重取证见
    // `saveWithOptimisticLock` 头注）。实际语义是**最后写入者静默胜出**。
    //
    // 本方法由自动回滚/升级链路调用，且异常在上层被 catch 吞成日志 ⇒ 改错难察觉，
    // 故按「先订正虚假声明、根治单独立项」处理（见 `optimistic-lock.md` §2 调用点 #4）。
    await this.saveWithOptimisticLock(deployment);
    await this.pushDeployToExecutor(deployment, pushApp, true);
  }

  /** T1-B5b：**转发层**（实现已迁至 `AppDeploymentRollout`）。 */
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
    return this.rollout.probeDeployment(batch, deploymentId);
  }

  /** T1-B5b：**转发层**（实现已迁至 `AppDeploymentRollout`）。 */
  private async probeDeploymentInner(
    batch: RolloutBatch,
    deploymentId: string,
  ): Promise<void> {
    return this.rollout.probeDeploymentInner(batch, deploymentId);
  }

  /** T1-B5b：**转发层**（实现已迁至 `AppDeploymentRollout`）。 */
  /** 探测 URL 组装：host 取执行器地址（R8 语义——地址本就执行器可控，
   *  探针端口/路径来自应用 manifest（管理员写入面））；端口缺省回退执行器
   *  地址端口。纯函数（public 便于测试）。 */
  buildProbeUrl(
    executorAddress: string,
    manifestPort: number | null,
    pathName: string,
  ): string | null {
    return this.rollout.buildProbeUrl(executorAddress, manifestPort, pathName);
  }

  /** T1-B5b：**转发层**（实现已迁至 `AppDeploymentRollout`）。 */
  /** 单次探测：任何 2xx-4xx 状态=探活成功（端口有活体即认为应用可路由）；
   *  5xx/超时/网络错=失败。 */
  private async probeOnce(
    url: string,
    pinCfg: ReturnType<typeof pinnedAxiosConfig>,
    timeoutMs: number,
  ): Promise<boolean> {
    return this.rollout.probeOnce(url, pinCfg, timeoutMs);
  }

  /** T1-B5b：**转发层**（实现已迁至 `AppDeploymentRollout`）。 */
  /** canary 全部通过后提升其余台：逐台 upgrade + rolloutState=pending，
   *  其心跳确认（RUNNING→promoted）由 notifyHeartbeatToRollout 处理。 */
  private async promoteRest(batch: RolloutBatch): Promise<void> {
    return this.rollout.promoteRest(batch);
  }

  /** T1-B5b：**转发层**（实现已迁至 `AppDeploymentRollout`）。 */
  /** 批次推进 tick（进程内 setTimeout 队列，先例 outbound-event-dispatcher）：
   *  ① canary pending 台心跳窗（ROLLOUT_HEARTBEAT_WINDOW_MS）超时判失败；
   *  ② 无健康声明时 pending 全部确认 → 直接提升；
   *  ③ 批次硬超时（ROLLOUT_BATCH_TIMEOUT_MS）兜底收尾。 */
  private scheduleRolloutTick(appId: string, delayMs: number): void {
    return this.rollout.scheduleRolloutTick(appId, delayMs);
  }

  /** T1-B5b：**转发层**（实现已迁至 `AppDeploymentRollout`）。 */
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
    return this.rollout.rolloutTick(appId);
  }

  /** T1-B5b：**转发层**（实现已迁至 `AppDeploymentRollout`）。 */
  private async rolloutTickInner(
    appId: string,
    batch: RolloutBatch,
  ): Promise<void> {
    return this.rollout.rolloutTickInner(appId, batch);
  }

  /** T1-B5b：**转发层**（实现已迁至 `AppDeploymentRollout`）。 */
  /** 退避等待（登记句柄供 OnModuleDestroy 统一清理）。 */
  private waitMs(ms: number, batch: RolloutBatch): Promise<void> {
    return this.rollout.waitMs(ms, batch);
  }

  /** T1-B5b：**转发层**（实现已迁至 `AppDeploymentRollout`）。 */
  private clearBatchTimers(batch: RolloutBatch): void {
    return this.rollout.clearBatchTimers(batch);
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
    // T1-B5b：状态在协作者内，经它清理（同 owner，不拆）。
    if (this.rolloutCollaborator) {
      for (const t of this.rolloutCollaborator.timers) clearTimeout(t);
      this.rolloutCollaborator.timers.clear();
      this.rolloutCollaborator.batches.clear();
    }
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

  /**
   * R1 1-B（F-9b）：**周期性回收残留 claim / 孤儿在途行**。
   *
   * ## 为什么必须有这个 cron（不是「重启时跑一次就够」）
   *
   * 上一轮把 claim 的兜底寄托在 `markInterruptedRolloutsFailed` 上，而它**只在
   * `onModuleInit` 跑一次**。于是「持有者在批次进行中崩溃（进程 OOM / 被 kill /
   * 容器驱逐）」这条路径上：claim 永远留在行上 ⇒ `uq_app_deployments_rollout_claim`
   * 恒有占用行 ⇒ 该应用**后续所有灰度被拒**（CAS 恒 affected=0），而且
   * **灰度批次没有人工中止端点** ⇒ 零人工兜底 ⇒ 只能改库。
   * 周期 30s（< `ROLLOUT_LEASE_GRACE_MS`=60s 的租约 TTL）保证「崩溃 → 可再开灰度」
   * 的恢复窗口是一个租约量级，而不是「等下一次滚动重启」。
   *
   * ## 为什么不是「再来一个定时器」
   *
   * rt-5 纪律：cron 回调不 await 返回的 Promise，方法体内任一 await 点的瞬态
   * 异常都会变成 unhandledRejection → gracefulFatalShutdown（整实例退出）。
   * 故门禁与异常闸都照既有两处 cron 的形态：**LeaderGate 在方法体内**（
   * check-cron-leader-gate 的判据是「装饰器向下窗口内可见」）+ `guardedCron`
   * 包裹扫描体（warn + 下一拍重试，判态幂等）。
   *
   * ## 与 `detectStuckDeployments` 的分工
   *
   * 那个扫的是**行级 status**（pending/deploying/upgrading 卡死 → failed）；
   * 本 cron 扫的是**批次级痕迹**（rolloutState 在途 + claim 残留）。两者判据不同、
   * 互不替代：只清 claim 不改 status 时，`findRunningByApp` 之类读面不受影响。
   */
  @Cron("*/30 * * * * *")
  async reapStaleRolloutBatches(): Promise<void> {
    // ARCH-31 §5: 多实例下仅 cron Leader 执行（门禁必须在方法体内，
    // 判定依据见 check-cron-leader-gate 的实现口径）。
    if (this.leaderGate && !this.leaderGate.isLeader) return;
    await guardedCron("application.reapStaleRolloutBatches", this.logger, () =>
      this.reapStaleRolloutBatchesBody(),
    );
  }

  /** T1-B5b：**转发层**（实现已迁至 `AppDeploymentRollout`）。 */
  /** `reapStaleRolloutBatches` 的扫描体（异常由 guardedCron 统一兜住）。 */
  private async reapStaleRolloutBatchesBody(): Promise<void> {
    return this.rollout.reapStaleRolloutBatchesBody();
  }

  /** T1-B5b：**转发层**（实现已迁至 `AppDeploymentRollout`）。 */
  /** DEP-02：重启 sweep 本体——pending/probing 行标记 failed。 */
  async markInterruptedRolloutsFailed(): Promise<number> {
    return this.rollout.markInterruptedRolloutsFailed();
  }
}
