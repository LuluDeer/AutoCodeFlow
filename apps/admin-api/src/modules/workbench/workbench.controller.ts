import {
  Body,
  Controller,
  Inject as NestInject,
  Ip,
  Logger,
  Optional as NestOptional,
  Post,
  UseGuards,
} from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from "@nestjs/swagger";

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

/** 极简框架替身可能没有 @Optional / @Inject；缺席时降级 no-op，手动 new 不受影响。 */
const Optional: (...args: any[]) => any =
  typeof NestOptional === "function" ? NestOptional : () => () => undefined;
const Inject: (...args: any[]) => any =
  typeof NestInject === "function" ? NestInject : () => () => undefined;

/** 与 sop.controller.ts:100 auditUserId 同口径：非有限数一律 null。 */
function auditUserId(user?: { id: number | string }): number | null {
  const id = Number(user?.id);
  return Number.isFinite(id) ? id : null;
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
@Roles(UserRole.ADMIN)
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

    // 输出锚点：回带第三闸放行的 currentGeneration，不在返回时重算。
    return {
      sopId: saved.id,
      slug: payload.slug,
      status: "draft",
      next: "请在 SOP 页面审阅并发布",
      policyGeneration: currentGeneration,
    };
  }

  @Post("rewind")
  @ApiOperation({
    summary:
      "N18：作废旧代在途异步写入与通知并留审计（代际只读服务端注册表，不信任客户端）",
  })
  @ApiOkResponse({ type: RewindResultDto })
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
}
