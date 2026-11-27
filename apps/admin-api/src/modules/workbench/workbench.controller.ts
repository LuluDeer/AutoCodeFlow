import {
  Body,
  Controller,
  ForbiddenException,
  Inject as NestInject,
  Ip,
  Logger,
  Optional as NestOptional,
  Param as NestParam,
  Post,
  Get as NestGet,
  UseGuards,
} from "@nestjs/common";
import { ModuleRef } from "@nestjs/core";
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from "@nestjs/swagger";

import { AuditService } from "../audit/audit.service";
import { AppError } from "../../common/errors/app-error";
import { ErrorCode } from "../../common/errors/error-codes";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Roles } from "../../common/decorators/roles.decorator";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard";
import { UserRole } from "../users/entities/user.entity";
import { SopService } from "../sop/sop.service";
import {
  QUOTA_HARD_LIMIT_GATE,
  type QuotaHardLimitGate,
} from "../capability-activation/quota-limit.gate";
import type { HardLimitTarget } from "../capability-activation/quota-limit";

/**
 * 激活记账的最小结构面 + 注入 token。
 *
 * 刻意不在控制器里值 import CapabilityActivationService：它依赖的 @nestjs/typeorm
 * 在内存替身单测（ts-jest/CJS）下会撞 ESM 装载错误，而 preview 单测的框架 mock
 * 只提供基础装饰器。生产由 WorkbenchModule 的 alias provider（useExisting）把真实
 * service 映射到这个 token；缺席（手动 new / 裁剪部署）则走 fail-open 跳过。
 */
export interface ActivationRecordInput {
  capabilityKey: string;
  capabilityVersion?: string;
  sessionId?: string;
  parameters?: Record<string, unknown>;
  userId?: number;
  username?: string;
  result?: "success" | "failure" | "blocked";
}

export abstract class CapabilityActivationRecorder {
  abstract record(dto: ActivationRecordInput): Promise<unknown>;
}

import {
  CommitPlanCardRequestDto,
  CommitResultDto,
  PlanCardPreviewResponseDto,
  PreviewPlanCardRequestDto,
} from "./dto/preview-plan-card.dto";
import {
  buildDraftPayloadFromCard,
  buildPreview,
  computePolicyGeneration,
  currentPolicySnapshot as readPolicySnapshot,
  rebuildCardFromInput,
  type PolicySnapshot,
} from "./preview-validator";
import { PolicyGenerationService } from "./policy-generation.service";
import type { PlanCardDto } from "./dto/preview-plan-card.dto";
import { classifyScopedRules, type ScopedRule } from "./scoped-rules";
import { RewindRunner } from "./rewind-runner";
import { RewindRequestDto, RewindResultDto } from "./dto/rewind.dto";
import {
  type ProjectedPart,
  type WorkbenchViewer,
  PartProjectionService,
} from "./part-projection.service";
import { ReleaseApprovalService } from "./release-approval.service";
import { sopContentHash } from "../sop/sop-frontmatter";
import { ParseUuidShapePipe } from "../../common/pipes/parse-uuid-shape.pipe";
import {
  CreateWorkbenchSessionDto,
  WorkbenchSessionCreateResponseDto,
  WorkbenchSessionDetailResponseDto,
} from "./dto/workbench-session.dto";
import {
  WORKBENCH_SESSIONS_PORT,
  type WorkbenchSessionsPort,
} from "./workbench-sessions.port";

/** 极简框架替身可能没有 @Optional / @Inject；缺席时降级 no-op，手动 new 不受影响。 */
const Optional: (...args: any[]) => any =
  typeof NestOptional === "function" ? NestOptional : () => () => undefined;
const Inject: (...args: any[]) => any =
  typeof NestInject === "function" ? NestInject : () => () => undefined;
/** 同上：极简框架替身可能没有 @Get；缺席时降级 no-op（仅影响元数据，不影响手动调用）。 */
const Get: (...args: any[]) => any =
  typeof NestGet === "function" ? NestGet : () => () => undefined;
const Param: (...args: any[]) => any =
  typeof NestParam === "function" ? NestParam : () => () => undefined;

/** 与 sop.controller.ts:100 auditUserId 同口径：非有限数一律 null。 */
function auditUserId(user?: { id: number | string }): number | null {
  const id = Number(user?.id);
  return Number.isFinite(id) ? id : null;
}

/**
 * R92 跨角色闭环：审批**发起**失败的可见面。
 *
 * 与 ADR-045 发布结果审计（release-outcome.audit.ts）同级，但触发点更早——
 * requestRelease 在「建单」阶段就抛错时根本没有 approvalKey / 审批行，
 * 因此失败必须落一条可定位、可重试的结构化审计，管理员才有接收面。
 * detail 只含 id / hash / 安全枚举 reason；异常原文（可能夹带 token）只进 warn 日志。
 */
export const APPROVAL_REQUEST_FAILED_ACTION =
  "sop_publish.approval_request_failed";

export const APPROVAL_REQUEST_RETRY_HINT =
  "管理员在审批发起失败条目点「重新发起审批单」；发布仍需主管四眼批准 + 系统代理执行";

export type ApprovalRequestFailureReason =
  | "policy_fingerprint_unavailable"
  | "dependency_unavailable"
  | "approval_request_failed";

/** 异常收敛成安全枚举：原文只进日志，绝不进审计 detail。 */
export function classifyApprovalRequestFailure(
  err: unknown,
): ApprovalRequestFailureReason {
  const message = err instanceof Error ? err.message : String(err);
  if (message.includes("策略指纹")) return "policy_fingerprint_unavailable";
  if (message.includes("端口未装配")) return "dependency_unavailable";
  return "approval_request_failed";
}

/** commit 失败态回带 + 审计 detail 共用的同一份事实。 */
export interface FailedApprovalInfo {
  sopId: string;
  cardHash: string;
  contentHash: string;
  requestedBy: string;
  reason: ApprovalRequestFailureReason;
  retryHint: string;
}

/**
 * N14 scopedRules 合成规则集（纯函数，零 IO / 零 Nest / 零 DB）。
 *
 * 把「方案卡能力声明 + 当前策略快照」投影成逐条 ScopedRule，交给
 * `classifyScopedRules` 判代际切换后的作废面。三种来源形态：
 *  1. 快照显式携带 `scopedRules`（未来能力策略下发形态）——原样采用，
 *     显式 ask/deny 因此在代际切换后保持 retained（保住人工确认/拒绝）；
 *  2. 卡未绑定任何 capability（capabilityHints 空）——等价于通配授权，
 *     合成 `*:*` allow，这是唯一会被第五闸作废的授权形态；
 *  3. 卡绑定 capability——命中当前策略白名单 ⇒ 精确 allow（action 非通配，
 *     作废也不触发「通配覆盖」拦截）；白名单外 ⇒ ask（fail-closed，
 *     不把未授权能力静默当成放行）。
 *
 * 快照形状异常时抛错，由 commit 第五闸捕获并 warn 放行（降级路径），
 * 与「判定为空 ⇒ 正常放行」刻意区分。
 */
export type CommitPolicySnapshot = PolicySnapshot & {
  scopedRules?: readonly ScopedRule[];
};

export function synthesizeCommitScopedRules(
  card: Pick<PlanCardDto, "capabilityHints"> | null | undefined,
  snapshot: CommitPolicySnapshot,
): ScopedRule[] {
  if (!snapshot || typeof snapshot !== "object") {
    throw new Error("N14 scopedRules：策略快照不可用");
  }
  if (snapshot.scopedRules !== undefined) {
    if (!Array.isArray(snapshot.scopedRules)) {
      throw new Error("N14 scopedRules：scopedRules 形态非法");
    }
    return snapshot.scopedRules.map((rule) => ({ ...rule }));
  }
  if (!Array.isArray(snapshot.capabilityWhitelist)) {
    throw new Error("N14 scopedRules：capabilityWhitelist 形态非法");
  }
  const hints = Array.isArray(card?.capabilityHints)
    ? (card as PlanCardDto).capabilityHints.filter(
        (value): value is string =>
          typeof value === "string" && value.length > 0,
      )
    : [];
  if (hints.length === 0) {
    return [
      {
        resource: "*",
        action: "*",
        decision: "allow",
        layer: "plan-card/wildcard",
      },
    ];
  }
  const whitelist: readonly string[] = snapshot.capabilityWhitelist;
  return hints.map((capability) => ({
    resource: capability,
    action: "invoke",
    decision: whitelist.includes(capability) ? "allow" : "ask",
    layer: "plan-card/capability",
  }));
}

/**
 * GCO 证伪切片的后端面（red V5 / N7 反幻觉闸门）。
 *
 * 权限对齐 SOP 管理面：sop.controller.ts 类级 @UseGuards(JwtAuthGuard) +
 * @Roles(UserRole.ADMIN)；preview 产出的方案卡后续会转成 SOP 草稿，发布权即
 * 指令注入权，因此同样收紧到 ADMIN（与 draft 端点同口径）。
 *
 * preview 只读内存入参，不落 SOP 行；commit 则把通过 hash 校验的方案卡落成
 * **draft 态** SOP 行——发布权仍是独立审批动作，本控制器从不调用 publish。
 */
@ApiTags("workbench")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller("workbench")
export class WorkbenchController {
  private readonly logger = new Logger(WorkbenchController.name);

  // 可选参数仅为兼容第一轮 preview 单测的 `new WorkbenchController()`；
  // 生产装配由 WorkbenchModule imports SopModule + CapabilityActivationModule 提供。
  // activation 走 @Optional（同 capability.service 对 AuditService 的处理）：
  // 缺席即跳过记账，极简装配/裁剪部署不崩。
  constructor(
    private readonly sops?: SopService,
    @Optional()
    private readonly activation: CapabilityActivationRecorder | null = null,
    // N14：运行时代际注册表。@Optional 缺席（手动 new / 极简装配）时回退到
    // 编译期快照，兼容第一轮 preview/commit 单测的装配方式。
    @Optional()
    private readonly generation?: PolicyGenerationService | null,
    // N20 硬阈值闸。@Optional 缺席（手动 new / 极简装配）→ 跳过第四闸，
    // 保持老单测与裁剪部署行为；生产由 WorkbenchModule 的 alias provider
    // 把 QUOTA_HARD_LIMIT_GATE 别名到 QuotaService。
    @Optional()
    @Inject(QUOTA_HARD_LIMIT_GATE)
    private readonly quotaGate?: QuotaHardLimitGate | null,
    // N18：rewind 代际围栏消费层。@Optional 缺席（手动 new / 裁剪部署）⇒ 端点报
    // DEPENDENCY_UNAVAILABLE；既有 preview/commit 的装配与四道闸逐字不变。
    @Optional()
    private readonly rewindRunner?: RewindRunner | null,
    // N10：Part 投影 / blob 消费口。@Optional 缺席（手动 new / 裁剪部署）⇒
    // 新端点报 DEPENDENCY_UNAVAILABLE；上面 preview/commit/rewind 的装配与闸门不变。
    @Optional()
    private readonly partProjection?: PartProjectionService | null,
    // ADR-045：发布审批编排。@Optional 缺席（老单测/裁剪部署）⇒ 不发起审批，
    // commit 仍只落 draft，既有五闸与返回值逐字不变。
    @Optional()
    private readonly releaseApproval?: ReleaseApprovalService | null,
    // R92：失败审计旁路。@Optional 缺席（老单测/裁剪部署）⇒ 只 warn 不写审计，
    // 五闸、draft 落库与三态返回逐字不变。
    @Optional()
    private readonly moduleRef?: ModuleRef,
    // 「运行我的草稿」会话端口。@Optional 追加在末尾以兼容既有定位参数单测；
    // 生产由 WorkbenchModule 注入真实 AgentSessionService + agent-jobs 队列。
    // 缺席 ⇒ 新端点显式报 DEPENDENCY_UNAVAILABLE（503），绝不回空壳。
    @Optional()
    @Inject(WORKBENCH_SESSIONS_PORT)
    private readonly sessions?: WorkbenchSessionsPort | null,
  ) {}

  /**
   * 当前策略快照读取口（N18 注入点，N14 起作为回退路径）。
   * 做成实例方法是为了让 preview 与 commit 各读一次快照——单测可 spy 模拟
   * 「两次读取之间策略变更」。生产有 generation service 时不再走这里。
   */
  currentPolicySnapshot(): PolicySnapshot {
    return readPolicySnapshot();
  }

  /**
   * N14+/持久化：preview / commit 共用的唯一代际读取口。
   * 有注册服务就读持久化版本（首次回源 system_configs，之后走缓存）；没有则
   * 回退到旧的编译期快照口径，保证未装配注册表的极简用例行为不变。
   * async：持久化版本首读是异步 DB 查询。
   */
  private async currentGeneration(): Promise<string> {
    return this.generation
      ? await this.generation.currentGeneration()
      : computePolicyGeneration(this.currentPolicySnapshot());
  }

  @Post("preview")
  @ApiOperation({
    summary:
      "最小方案卡预览 + 确定性校验（N7 反幻觉闸门；不调用 LLM、不落 SOP）",
  })
  @ApiOkResponse({ type: PlanCardPreviewResponseDto })
  @Roles(UserRole.ADMIN, UserRole.USER)
  async preview(
    @Body() dto: PreviewPlanCardRequestDto,
  ): Promise<PlanCardPreviewResponseDto> {
    const result = buildPreview(dto);

    // N7 留痕的另一半：服务端结构化单行日志（不写 DB、不落 SOP draft 行）。
    // 只记 goal 长度而非全文——goal 是请求方不可信输入，全文进日志无收益。
    this.logger.log(
      JSON.stringify({
        event: "workbench.preview.n7",
        eligible: result.eligible,
        cardHash: result.cardHash,
        cadence: dto.cadence,
        goalLength: dto.goal.length,
        failedFields: result.checks
          .filter((item) => item.status === "fail")
          .map((item) => item.field),
      }),
    );

    // N14+/持久化：把生成当下的**运行时**策略代际随卡一并返回，供 commit 回读比对。
    return {
      ...result,
      policyGeneration: await this.currentGeneration(),
    };
  }

  @Post("commit")
  @ApiOperation({
    summary:
      "确认方案卡并落成 SOP 草稿（N7 留痕 hash 校验；只 draft，不自动发布）",
  })
  @ApiOkResponse({ type: CommitResultDto })
  @Roles(UserRole.ADMIN, UserRole.USER)
  async commit(
    @Body() dto: CommitPlanCardRequestDto,
    @CurrentUser() user: { id: number | string; username?: string } | undefined,
    @Ip() ip?: string,
  ): Promise<CommitResultDto> {
    if (!this.sops) {
      throw new AppError(ErrorCode.DEPENDENCY_UNAVAILABLE, {});
    }

    // 防篡改：服务端重建，绝不信任客户端传来的 card（入参里也没有 card 字段）。
    const rebuilt = rebuildCardFromInput({
      goal: dto.goal,
      cadence: dto.cadence,
      params: dto.params,
    });
    const expected = String(dto.expectedCardHash ?? "").toLowerCase();
    if (!/^[0-9a-f]{16}$/.test(expected) || expected !== rebuilt.cardHash) {
      throw new AppError(ErrorCode.VALIDATION_FAILED, {
        detail:
          "expectedCardHash 与服务端重建结果不一致（方案卡已被篡改或入参不匹配）",
      });
    }
    // 闸门未过的卡不允许落库——preview 的 eligible=false 在这里必须真的挡住。
    if (!rebuilt.eligible) {
      throw new AppError(ErrorCode.VALIDATION_FAILED, {
        detail: "方案卡未通过确定性闸门（eligible=false），不得提交落库",
      });
    }
    // 第三道闸（N18 / N14）：hash 对、闸门过了，还要确认卡生成后策略没变。
    // 与 agent-approvals 的 policyFingerprint 同型：策略变更即旧卡作废。
    // N14：这里读运行时 counter——capability 写操作 emit 后立即换代际，在途旧卡
    // 无需重新部署就被拒（generation 不匹配）。
    const currentGeneration = await this.currentGeneration();
    const expectedGeneration = String(
      dto.expectedPolicyGeneration ?? "",
    ).toLowerCase();
    if (expectedGeneration !== currentGeneration) {
      throw new AppError(ErrorCode.VALIDATION_FAILED, {
        detail: "方案卡生成后能力策略已变更，请重新预览后再提交",
      });
    }

    // 第四道闸（N20 硬阈值 / fail-close）：必须发生在 draft 落库之前。
    // gate 自身已 fail-open（配额配置读取失败会放行），这里刻意不 try/catch
    // 吞它的 RATE_LIMITED——超限直接冒泡成 429，且 sops.draft / activation.record
    // 零调用。仅当 gate 未装配（@Optional 缺席）才跳过，兼容极简单测装配。
    if (this.quotaGate) {
      // gate 只按 capabilityKey/projectId 匹配；capabilityVersion 随对象带上，
      // 供 gate 将来按版本细分配额（当前 HardLimitTarget 结构面不含该字段）。
      const target: HardLimitTarget & { capabilityVersion: string } = {
        capabilityKey: "workbench.commit", // 与 activation 记账口径一致
        capabilityVersion: "1.0.0",
        ...(dto.params?.projectId ? { projectId: dto.params.projectId } : {}),
      };
      const decision = await this.quotaGate.evaluateHardLimit(target);
      if (decision.blocked) {
        const m = decision.matched;
        throw new AppError(ErrorCode.RATE_LIMITED, {
          detail: m
            ? `能力配额硬阈值拦截：${m.scope}/${m.target} 在 ${m.windowDays} 天窗口内已用 ${m.usage}，硬阈值 ${m.hardLimit}，禁止提交`
            : "能力配额硬阈值拦截：已达硬阈值，禁止提交",
        });
      }
    }

    // 第五道闸（N14 scopedRules，追加式）：上面 hash / eligible / generation /
    // quota 四闸逐字不动。第四闸比对的是客户端带来的代际锚点；这里在 draft
    // 落库前**再读一次**运行时代际——capability 写操作可能恰好在两次读取之间
    // emit bump。服务端合成的规则面（方案卡能力 + 当前策略快照）交给
    // classifyScopedRules：命中失效作用域的通配 allow 作废 ⇒ 拒绝落库，
    // 显式 ask/deny 原样保留（不被误作废）。
    // fail-closed 语义分两路：「判定为空（invalidated 空）」是正常放行；
    // 「规则集构造/判定不可得」是降级——warn 后放行，保住既有四闸行为。
    let scopedWildcardInvalidated = false;
    try {
      const rules = synthesizeCommitScopedRules(
        rebuilt.card,
        this.currentPolicySnapshot() as CommitPolicySnapshot,
      );
      const verdict = classifyScopedRules({
        rules,
        cardGeneration: expectedGeneration,
        currentGeneration: await this.currentGeneration(),
        scope: { resources: ["*"], actions: ["*"] },
      });
      scopedWildcardInvalidated = verdict.invalidated.some(
        (item) => item.disposition === "invalidate-wildcard-allow",
      );
    } catch (err: unknown) {
      // 构造失败 ⇒ warn + 放行（不拦）。与「判定为空 ⇒ 放行」刻意留痕区分：
      // 前者是降级路径，日志必须可追；后者是 classifyScopedRules 的正常结论。
      if (typeof this.logger?.warn === "function") {
        this.logger.warn(
          `N14 scopedRules 不可用（fail-open，不影响 commit）：` +
            `cardHash=${rebuilt.cardHash} — ` +
            `${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    if (scopedWildcardInvalidated) {
      throw new AppError(ErrorCode.VALIDATION_FAILED, {
        detail: "方案卡中的通配授权已随策略代际切换失效，请重新预览后再提交",
      });
    }

    const payload = buildDraftPayloadFromCard(rebuilt.card, rebuilt.cardHash);
    const saved = await this.sops.draft({
      slug: payload.slug,
      title: payload.title,
      frontMatterYaml: payload.frontMatterYaml,
      bodyMarkdown: payload.bodyMarkdown,
      applicationId: null,
      createdBy: `user:${user?.id}`,
      // R41-A1：与 sop.controller.ts draft 同口径（审计 userId 为整数列）。
      audit: {
        userId: auditUserId(user),
        username: user?.username ?? null,
        ip: ip ?? null,
      },
    });

    // 能力激活审计：draft 已落库（sopId 拿到）后记一条 workbench.commit 激活。
    // capabilityKey 用命名空间化稳定 key——workbench 能力暂未注册进 capabilities
    // 表，不借用别的能力 key；sessionId 关联刚落库的 SOP id。
    // parameters 仅为业务参数，record 内部 sha256 摘要后只落 digest、不存明文。
    // fail-open：记账异常只 warn，绝不回滚/阻断一次已成功的 commit（对齐
    // agent-approvals.service.ts emitDecision 的旁路写入纪律）。
    if (this.activation) {
      try {
        await this.activation.record({
          capabilityKey: "workbench.commit",
          capabilityVersion: "1.0.0",
          sessionId: saved.id,
          parameters: {
            goal: dto.goal,
            cadence: dto.cadence,
            capabilityIds: rebuilt.card.capabilityHints,
            cardHash: dto.expectedCardHash,
          },
          userId: auditUserId(user) ?? undefined,
          username: user?.username ?? undefined,
          result: "success",
        });
      } catch (err: unknown) {
        this.logger.warn(
          `capability activation record failed (bypass — commit unaffected): ` +
            `sopId=${saved.id} slug=${payload.slug} — ` +
            `${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    this.logger.log(
      JSON.stringify({
        event: "workbench.commit.n7",
        cardHash: rebuilt.cardHash,
        slug: payload.slug,
        sopId: saved.id,
      }),
    );

    // ADR-045：draft 落库后发起发布审批（业务人员不直接 publish，主管四眼后
    // 系统代理发布）。三态如实回带，不再静默失败、不再用中文 next 误导：
    //   submitted     = requestRelease 成功，带 approvalKey（原 happy path 逐字保留）；
    //   failed        = 进入发起分支但抛错（端口未装配/策略指纹不可读等），draft 已保留；
    //   not_requested = 端口缺席或非 USER 上下文（无 username），本就没有发起，非异常。
    // 既有五闸与 draft 调用逐字不动，draft 不回滚，发布权仍不在业务人员手里。
    let approvalStatus: CommitResultDto["approvalStatus"] = "not_requested";
    let approvalKey: string | undefined;
    let failedApproval: FailedApprovalInfo | undefined;
    if (this.releaseApproval && user?.username) {
      // contentHash 是本地纯函数，提到 try 外让 catch 也能回带/落审计；
      // 发起失败的语义只覆盖 requestRelease，既有五闸与 draft 落库逐字不变。
      const contentHash = sopContentHash(
        payload.frontMatter,
        payload.bodyMarkdown,
      );
      try {
        const req = await this.releaseApproval.requestRelease({
          sopId: saved.id,
          cardHash: rebuilt.cardHash,
          contentHash,
          username: user.username,
        });
        approvalKey = req.approvalKey;
        approvalStatus = "submitted";
      } catch (err: unknown) {
        this.logger.warn(
          `发布审批发起失败（draft 已保留，approvalStatus=failed）：sopId=${saved.id} — ` +
            `${err instanceof Error ? err.message : String(err)}`,
        );
        approvalStatus = "failed";
        failedApproval = {
          sopId: String(saved.id),
          cardHash: rebuilt.cardHash,
          contentHash,
          requestedBy: user.username,
          reason: classifyApprovalRequestFailure(err),
          retryHint: APPROVAL_REQUEST_RETRY_HINT,
        };
        // 审计旁路：fire-and-forget，失败只 warn，绝不改 commit 语义。
        this.writeApprovalRequestFailedAudit(failedApproval);
      }
    }

    // 输出锚点：回带第三闸放行的 currentGeneration，不在返回时重算。
    // next 为废弃可选字段，生产不再赋值；前端按 approvalStatus 稳定码渲染 i18n 文案。
    // approvalFailure 仅在 failed 态出现，供业务人员 UI 直接定位；用交叉类型局部变量
    // 返回，不改 CommitResultDto 既有声明形状（DTO 文件不在本切片边界内）。
    const result: CommitResultDto & {
      approvalFailure?: FailedApprovalInfo;
    } = {
      sopId: saved.id,
      slug: payload.slug,
      status: "draft",
      approvalStatus,
      policyGeneration: currentGeneration,
      ...(approvalKey ? { approvalKey } : {}),
      ...(failedApproval ? { approvalFailure: failedApproval } : {}),
    };
    return result;
  }

  @Post("rewind")
  @ApiOperation({
    summary:
      "N18：作废旧代在途异步写入与通知并留审计（代际只读服务端注册表，不信任客户端）",
  })
  @ApiOkResponse({ type: RewindResultDto })
  @Roles(UserRole.ADMIN)
  async rewind(
    @Body() dto: RewindRequestDto,
    @CurrentUser() user: { id: number | string; username?: string } | undefined,
  ): Promise<RewindResultDto> {
    if (!this.rewindRunner) {
      throw new AppError(ErrorCode.DEPENDENCY_UNAVAILABLE, {});
    }
    const result = await this.rewindRunner.rewind({
      sessionId: dto.sessionId,
      partIds: dto.partIds,
      username: user?.username,
    });
    return {
      resourceId: result.resourceId,
      allowedCount: result.allowedCount,
      invalidatedCount: result.invalidatedCount,
      executedWriteIds: result.executedWriteIds,
      generation: result.generation,
    };
  }

  @Post("part/project")
  @ApiOperation({
    summary:
      "N10：按服务端 Part 与会话归属投影可见面（大字段仅在可见时从 blob 读回）",
  })
  @Roles(UserRole.ADMIN, UserRole.USER)
  async projectPart(
    @Body() dto: { partId?: string },
    @CurrentUser() user: WorkbenchViewer | undefined,
  ): Promise<ProjectedPart | null> {
    if (!this.partProjection) {
      throw new AppError(ErrorCode.DEPENDENCY_UNAVAILABLE, {});
    }
    const partId = String(dto?.partId ?? "").trim();
    if (!partId) {
      throw new AppError(ErrorCode.VALIDATION_FAILED, {
        detail: "partId 不能为空",
      });
    }
    // currentGeneration 走既有服务端注册表；客户端只给 partId，不能带大字段/代际/share。
    const projected = await this.partProjection.projectById(
      partId,
      await this.currentGeneration(),
      user,
    );
    if (!projected) {
      throw new AppError(ErrorCode.VALIDATION_FAILED, {
        detail: "Part 不存在",
      });
    }
    return projected;
  }

  /**
   * R92 失败审计旁路：ModuleRef 惰性解析 AuditService，fire-and-forget。
   * 解析失败 / 落库失败只 warn，绝不把一次已经「draft 落库 + failed 回带」的
   * commit 升级成 5xx（与 release-outcome.audit.ts 同款纪律）。
   */
  private writeApprovalRequestFailedAudit(info: FailedApprovalInfo): void {
    let audit: AuditService | null = null;
    try {
      audit = this.moduleRef?.get(AuditService, { strict: false }) ?? null;
    } catch (err: unknown) {
      this.logger.warn(
        `approval_request_failed audit resolve skipped — ${
          err instanceof Error ? err.name : "unknown"
        }`,
      );
    }
    if (!audit) {
      this.logger.warn(
        "approval_request_failed audit skipped: AuditService unavailable",
      );
      return;
    }
    const payload = {
      action: APPROVAL_REQUEST_FAILED_ACTION,
      resource: "sop",
      resourceId: info.sopId,
      result: "failure" as const,
      detail: {
        sopId: info.sopId,
        cardHash: info.cardHash,
        contentHash: info.contentHash,
        requestedBy: info.requestedBy,
        reason: info.reason,
        retryHint: info.retryHint,
        attempt: "initial",
      },
    };
    try {
      void Promise.resolve(audit.log(payload)).catch((err: unknown) => {
        this.logger.warn(
          `approval_request_failed audit append failed — ${
            err instanceof Error ? err.name : "unknown"
          }`,
        );
      });
    } catch (err: unknown) {
      this.logger.warn(
        `approval_request_failed audit append failed — ${
          err instanceof Error ? err.name : "unknown"
        }`,
      );
    }
  }

  // ── 「运行我的草稿」业务用户会话面（阶段 B/C 的最小真实闭环）────────────

  /**
   * 业务用户把自己 commit 出来的 SOP draft 实例化为一个严格限权的 Agent 会话。
   *
   * 防越权三道闸：
   * ① SOP 必须存在、状态为 draft；否则 404 / 409（已发布的不许「跑草稿」）；
   * ② 归属必须是当前用户（`createdBy === user:<id>`）——ADMIN 可代跑（管理面）；
   *    其他 USER 的草稿一律 403（防枚举：与不存在同码不可分辨靠 404 区分不行，
   *    这里刻意 403 让本人知道自己没权限，ADMIN 例外）；
   * ③ kind/scope/creator/triggerSource 服务端钉死，请求体里根本没有这些字段
   *    （DTO whitelist + forbidNonWhitelisted 保证多传即 400）。
   *
   * 一步入队：与 agent.controller.ts:497-530 同口径（jobId=sessionId 去重、attempts=1）。
   */
  @Post("sessions")
  @ApiOperation({
    summary: "运行我的 SOP 草稿：创建限权 Agent 会话并入 agent-jobs 队列",
  })
  @Roles(UserRole.ADMIN, UserRole.USER)
  @ApiOkResponse({ type: WorkbenchSessionCreateResponseDto })
  async createSession(
    @Body() dto: CreateWorkbenchSessionDto,
    @CurrentUser() user: { id: number | string; username?: string } | undefined,
  ): Promise<WorkbenchSessionCreateResponseDto> {
    if (!this.sops || !this.sessions) {
      throw new AppError(ErrorCode.DEPENDENCY_UNAVAILABLE, {});
    }
    const userId = Number(user?.id);
    if (!Number.isFinite(userId)) {
      throw new AppError(ErrorCode.USER_NOT_FOUND, {});
    }
    const isAdmin = (user as { role?: string } | undefined)?.role === UserRole.ADMIN;
    const identity = `user:${userId}`;

    // ① 存在性 + 状态：用 SopService.getSop（不存在抛 SOP_NOT_FOUND → 404）。
    const sop = await this.sops.getSop(dto.sopId);
    if (sop.status !== "draft") {
      throw new AppError(ErrorCode.VALIDATION_FAILED, {
        detail: "SOP 不是 draft 状态，不能运行草稿",
      });
    }
    // ② 归属：createdBy 口径见 sop.entity.ts:64-66（user:<id> / agent:<sessionId>）。
    //    ADMIN 代跑是管理面例外；普通 USER 只能跑自己的草稿。
    if (!isAdmin && sop.createdBy !== identity) {
      throw new ForbiddenException("无权运行他人的 SOP 草稿");
    }

    // ③ 服务端钉死会话形状；context 只放服务端已知事实 + 客户提供的 goal。
    //    策略代际在 commit 时已算过并回带，这里读一次当前值随会话继承，
    //    供下游在途失效比对（与 CommitResultDto.policyGeneration 同口径）。
    const policyGeneration = await this.currentGeneration();
    const session = await this.sessions.create({
      kind: "sop_authoring",
      triggerSource: "workbench",
      title: `工作台草稿运行 · ${sop.slug}`,
      createdBy: identity,
      scope: { sops: [dto.sopId] },
      context: {
        goal: dto.goal,
        sopId: dto.sopId,
        cardHash: dto.expectedCardHash.toLowerCase(),
        policyGeneration,
        ...(dto.context && Object.keys(dto.context).length > 0
          ? { extra: dto.context }
          : {}),
      },
    });
    await this.sessions.enqueue(session.id, "trigger:workbench");
    this.logger.log(
      JSON.stringify({
        event: "workbench.session.created",
        sessionId: session.id,
        sopId: dto.sopId,
        createdBy: identity,
      }),
    );
    return { sessionId: session.id, status: session.status };
  }

  /** 读回自己的会话（creator 或 ADMIN）：状态 + 步骤/审批/产物摘要。 */
  @Get("sessions/:id")
  @ApiOperation({ summary: "读取工作台会话进度（仅创建者或管理员）" })
  @Roles(UserRole.ADMIN, UserRole.USER)
  @ApiOkResponse({ type: WorkbenchSessionDetailResponseDto })
  async getSession(
    @Param("id", ParseUuidShapePipe) id: string,
    @CurrentUser() user: { id: number | string; username?: string } | undefined,
  ): Promise<WorkbenchSessionDetailResponseDto> {
    if (!this.sessions) {
      throw new AppError(ErrorCode.DEPENDENCY_UNAVAILABLE, {});
    }
    const userId = Number(user?.id);
    if (!Number.isFinite(userId)) {
      throw new AppError(ErrorCode.USER_NOT_FOUND, {});
    }
    const isAdmin = (user as { role?: string } | undefined)?.role === UserRole.ADMIN;
    const session = await this.sessions.findById(id);
    // 防枚举：不存在与越权统一 404（不告诉调用方「存在但不属于你」）。
    if (!session) {
      throw new AppError("AGENT_SESSION_NOT_FOUND", { sessionId: id });
    }
    if (
      !isAdmin &&
      session.createdBy !== `user:${userId}` &&
      session.createdBy !== `user:${user?.username}`
    ) {
      throw new AppError("AGENT_SESSION_NOT_FOUND", { sessionId: id });
    }
    // 工作台读面只服务 sop_authoring 且 scope 指向 SOP 的会话——管理员建的
    // ops_watch/incident 等会话不走这条业务用户路径。
    const scope = (session.scopeJson ?? {}) as Record<string, unknown>;
    const summary = await this.sessions.readSummary(id);
    return {
      sessionId: session.id,
      kind: session.kind,
      status: session.status,
      createdBy: session.createdBy ?? null,
      scope,
      ...(session.title ? { title: session.title } : {}),
      ...summary,
    };
  }
}
