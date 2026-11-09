import { Logger } from "@nestjs/common";
import { AppError } from "../../common/errors/app-error";
import { ErrorCode } from "../../common/errors/error-codes";
import { sanitizeSecrets } from "../../common/utils/sanitize-secrets.util";
import {
  AppDeployment,
  DeploymentApprovalStatus,
  DeploymentStatus,
  DeploymentTriggerType,
} from "./entities/app-deployment.entity";
import { AppDeploymentEventType } from "./entities/app-deployment-event.entity";
import type { Repository } from "typeorm";
import type { AuditService } from "../audit/audit.service";
import type { ApplicationService } from "./application.service";

/**
 * 部署审批决策协作者（B1a 拆分第 1 步）。
 *
 * ## 职责边界（为什么是这一段）
 *
 * 本类只负责**审批决策**这一件事：
 *
 * - 待审批行加载（`findPendingApproval`）
 * - 第二人规则（`assertSecondPerson`）
 * - 三个审批动作：批准 / 拒绝 / 撤回
 * - 审批决策的审计留痕（`writeApprovalAudit`）
 * - 事件 detail 的写前脱敏（`sanitizeEventDetail`）
 *
 * ## 刻意**不**收进来的东西（以及原因）
 *
 * 本类的每个外部能力都以**最小接口**注入，不接收整个 `AppDeploymentService`：
 *
 * - `recordDeploymentEvent`（部署事件落库）—— **跨簇横向能力**：6 个调用点里
 *   3 个在审批簇外（`deploy`/`upgrade`/`stop`/`removeDeployment`）。它同时被
 *   A2（部署执行）消费 ⇒ 留在 service，审批簇以 `onEvent` 回调调用它。
 *   ⚠️ 这也是**唯一一处 spec 直接调私有方法**的地方
 *   （`app-deployment-events.spec.ts:729` 调 `recordDeploymentEvent` 验脱敏）
 *   ⇒ 留在 service ⇒ 那条 spec 逐字未改仍绿。
 * - `maskDeploymentForRead`（读面掩码）—— 9 个调用点，跨 A2/A3。
 * - `findByIdRaw`（raw 行读取）—— 6 个调用点，跨簇。
 * - `pushDeployToExecutor`（推送到执行器）—— 5 个调用点，跨簇。
 * - `writeTransitionAudit`（stop/rollback/delete 的门控审计）—— 3 个调用点
 *   全在审批簇外（`stop`/`removeDeployment`/`rollbackDeploymentToPrevious`）。
 *
 * ## 时序不变量（搬迁时不得重排）
 *
 * 三个审批动作的编排顺序固定为：
 * **决策落库（条件 UPDATE + affected 闸）→ 推送执行器 → 审计留痕 → 事件落库 → 掩码返回**。
 * 其中「决策落库 → 事件落库」之间隔着推送与审计，三者的相对顺序**逐字不变**。
 *
 * ⚠️ 三个审批动作**均无事务包裹**（实测：1695-1885 区间零 `transaction` /
 * `manager.` / `queryRunner`）⇒ 回调 `onEvent` 在**同一 await 点**执行即
 * 等价于原顺序，无需事务协调。
 *
 * ## logger 纪律
 *
 * 本类**不自己 `new Logger()`**，而是由 Facade 注入 service 的 logger 实例。
 * 原因：`app-deployment.service.spec.ts:1422/1464` 用
 * `jest.spyOn((service as any).logger, "warn")` 断言 service 的 logger ⇒
 * 协作者若持自己的 logger，那两条用例会红。
 */

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

/**
 * 部署事件落库的**最小回调面**。
 *
 * 只表达「记一条部署事件」这一件事，不把整个 service 递进来（那只是把耦合
 * 换个名字）。`detail` 已在 service 侧完成脱敏（见 `sanitizeEventDetail`）。
 */
export type DeploymentEventRecorder = (input: {
  applicationId: string;
  deploymentId: string | null;
  eventType: AppDeploymentEventType;
  executorId?: string | null;
  executorAddress?: string | null;
  deployedVersion?: string | null;
  triggerType?: string | null;
  operator?: string | null;
  detail?: Record<string, unknown> | null;
}) => Promise<void>;

/** 读面掩码的**最小回调面**（把实体转成对外可读形状）。 */
export type DeploymentMasker = (deployment: AppDeployment) => AppDeployment;

/**
 * 应用实体的**最小读取面**（审批通过后要把 app 的版本等并进推送参数）。
 */
export type ApplicationRawLoader = (
  applicationId: string,
) => Promise<{ version?: string | null } | null>;

/**
 * 推送部署到执行器的**最小回调面**。
 *
 * ⚠️ 原实现的调用是**不 await 的**（`.catch(err => logger.error(...))`）——
 * 即「推送失败不阻断审批返回」。本回调面保留这一语义：调用方**不 await**
 * 它，只挂 `.catch`。
 */
export type DeploymentPush = (
  deployment: AppDeployment,
  app: unknown,
) => Promise<void>;

/** 协作者构造器依赖（全部为最小接口，不含整个 service）。 */
export interface ApplicationApprovalCollaboratorDeps {
  /** 部署表仓库（条件 UPDATE 的领取闸）。 */
  repo: Repository<AppDeployment>;
  /** 审计服务（审批决策留痕；fail-open）。 */
  audit: AuditService | null;
  /** 应用服务（审批通过后取 app 的 version；只用到 `findByIdRaw`）。 */
  appService: Pick<ApplicationService, "findByIdRaw">;
  /** 日志器（**必须是 service 的实例**，见类头注「logger 纪律」）。 */
  logger: Logger;
  /** 部署事件落库回调（跨簇横向能力，见类头注）。 */
  onEvent: DeploymentEventRecorder;
  /** 读面掩码回调（跨簇能力，见类头注）。 */
  maskForRead: DeploymentMasker;
  /** 应用实体读取回调（跨簇能力，见类头注）。 */
  loadApplication: ApplicationRawLoader;
  /** 推送到执行器回调（跨簇能力，见类头注）。 */
  pushDeploy: DeploymentPush;
}

export class ApplicationApprovalCollaborator {
  private readonly repo: Repository<AppDeployment>;
  private readonly audit: AuditService | null;
  private readonly appService: Pick<ApplicationService, "findByIdRaw">;
  private readonly logger: Logger;
  private readonly onEvent: DeploymentEventRecorder;
  private readonly maskForRead: DeploymentMasker;
  private readonly loadApplication: ApplicationRawLoader;
  private readonly pushDeploy: DeploymentPush;

  constructor(deps: ApplicationApprovalCollaboratorDeps) {
    this.repo = deps.repo;
    this.audit = deps.audit;
    this.appService = deps.appService;
    this.logger = deps.logger;
    this.onEvent = deps.onEvent;
    this.maskForRead = deps.maskForRead;
    this.loadApplication = deps.loadApplication;
    this.pushDeploy = deps.pushDeploy;
  }

  /** DEP-04：待审批行加载（三动作共用前置）。 */
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

  /** raw 行读取（`findByIdRaw` 的跨簇调用，留在 service 的薄壳）。 */
  private async findByIdRaw(id: string): Promise<AppDeployment> {
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

  /** DEP-04：第二人规则——审批者不得与提交者为同一人（userId 同域比较，
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

  /** DEP-04：审批决策审计留痕（best-effort fail-open，先例 executor.service
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

  /**
   * 部署事件 `detail` 的写前脱敏（2026-11-02）。
   *
   * 判据：**逐值**过 `sanitizeSecrets`（文本规则：全大写 env / `Bearer` /
   * `token=`/`apiKey=` 一类赋值 / `sk-`·`ghp_` 前缀 / 32+hex / 40+b64），
   * **键名本身不动**（`reason`/`runMode` 这些键没有凭据语义，改键名会破坏读面契约）。
   *
   * 为什么只处理「字符串叶子」：`detail` 的契约是「短事实快照：reason/runMode/
   * deletedStatus 等**标量**」⇒ 字符串叶子就够了；嵌套对象/数组也递归走一遍
   * （防御：将来有人塞结构进来也不会漏）。
   *
   * ⚠ 与 `agent-sanitize.util.ts` 的 `sanitizeValue` 分开的理由：那是 agent 域的
   * 「键名剥除 + 逐值文本规则」，面向的是**模型进出的参数**；本处只要**文本规则**，
   * 复用 `common/utils/sanitize-secrets.util.ts` 的**唯一实现**即可，
   * 不引入 application → agent 的跨模块依赖。
   */
  sanitizeEventDetail(
    detail: Record<string, unknown> | null | undefined,
  ): Record<string, unknown> | null {
    if (!detail || typeof detail !== "object") return null;
    const walk = (v: unknown, depth: number): unknown => {
      if (depth > 4) return "[omitted: too deep]"; // 防循环/病态嵌套
      if (typeof v === "string") return sanitizeSecrets(v);
      if (Array.isArray(v)) return v.map((x) => walk(x, depth + 1));
      if (v && typeof v === "object") {
        const out: Record<string, unknown> = {};
        for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
          out[k] = walk(val, depth + 1);
        }
        return out;
      }
      return v; // number / boolean / null 原样
    };
    const sanitized = walk(detail, 0);
    return sanitized && typeof sanitized === "object"
      ? (sanitized as Record<string, unknown>)
      : null;
  }

  /** DEP-04：审批通过。 */
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
    this.pushDeploy(deployment, app).catch((err: unknown) => {
      this.logger.error(
        `Approved deploy push failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    });
    await this.writeApprovalAudit("deployment.approve", deployment, actor);
    // R4（§4.1A）：审批决策进事件流（不计入 deployCount——请求行的
    // deploy_created 已计，见 DEPLOY_COUNTED_EVENT_TYPES）。
    await this.onEvent({
      applicationId: deployment.applicationId,
      deploymentId: deployment.id,
      eventType: AppDeploymentEventType.APPROVAL_APPROVED,
      executorId: deployment.executorId,
      executorAddress: deployment.executorAddress,
      deployedVersion: app?.version ?? null,
      triggerType: deployment.triggerType ?? null,
      operator: deployment.operator ?? null,
      detail: { reason: reason ?? null },
    });
    return this.maskForRead(deployment);
  }

  /** DEP-04：审批拒绝——终态落 FAILED（离开 in-flight 集合），reason 随
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
    await this.onEvent({
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
    return this.maskForRead(deployment);
  }

  /** DEP-04：提交者撤回自己的待审批请求（终态落 FAILED）。 */
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
    await this.onEvent({
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
    return this.maskForRead(deployment);
  }
}
