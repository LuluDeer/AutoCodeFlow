import {
  Body,
  Controller,
  Inject,
  Logger,
  Optional,
  Param,
  Post,
  UseGuards,
} from "@nestjs/common";
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiBody,
  ApiCreatedResponse,
  ApiOperation,
  ApiProperty,
  ApiPropertyOptional,
  ApiTags,
} from "@nestjs/swagger";
import { IsIn, IsNotEmpty, IsOptional, IsString } from "class-validator";

import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Roles } from "../../common/decorators/roles.decorator";
import { AppError } from "../../common/errors/app-error";
import { ErrorCode } from "../../common/errors/error-codes";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard";
import type { AuthUser } from "../../common/interfaces/auth-user.interface";
import { AuditService } from "../audit/audit.service";
import { SOP_RELEASE_AUDIT_ACTIONS } from "../agent/runtime/release-outcome.audit";
import { UserRole } from "../users/entities/user.entity";
import { sopContentHash, type SopFrontMatter } from "../sop/sop-frontmatter";
import {
  RELEASE_PUBLISHED_BY,
  RELEASE_SOPS_PORT,
  RELEASE_TOOL_NAME,
  ReleaseApprovalService,
  type ReleaseIfApprovedReason,
  type ReleaseSopsPort,
} from "./release-approval.service";

/**
 * R92：审批**发起**失败的重试审计 action。
 * 与 workbench.controller.ts 的 APPROVAL_REQUEST_FAILED_ACTION 成对登记；
 * 不跨文件 import controller，避免把 SopService/typeorm 依赖拖进本文件的单测装载。
 */
export const APPROVAL_REQUEST_RETRIED_ACTION =
  "sop_publish.approval_request_retried";

/**
 * ADR-045 一键重试白名单 —— **consume 之前的失败**才允许重试。
 *
 * `releaseIfApproved` 的顺序是「contentHash 比对 → consume → publish」：
 * 本表 5 个 reason 都在 consume 之前返回，审批单仍是 granted，重放整条
 * hash 比对 + consume + publish 不会重复发布；`publish_failed` 发生在
 * consume 之后（审批单已 consumed），重试只会拿到 approval_not_consumed，
 * 若绕过闸强行重放则存在重复发布风险，故它**不在**白名单里。
 */
export const RETRYABLE_REASONS = [
  "dependency_unavailable",
  "policy_fingerprint_unavailable",
  "sop_not_found",
  "content_changed",
  "approval_not_consumed",
] as const satisfies readonly ReleaseIfApprovedReason[];

const RETRYABLE_SET: ReadonlySet<string> = new Set<string>(RETRYABLE_REASONS);

/** 只接受一个 body 字段；全局 ValidationPipe 的 forbidNonWhitelisted 会挡多余字段。 */
export class RetryReleaseDto {
  @ApiProperty({
    description:
      "失败审计 detail.reason；只接受 consume 前失败的 5 种原因，publish_failed 一律拒绝",
    enum: [...RETRYABLE_REASONS],
  })
  @IsString()
  @IsNotEmpty()
  expectedReason: string;
}

export class ReleaseRetryResponseDto {
  @ApiProperty({ description: "本次是否受理了重试" })
  retried: boolean;

  @ApiProperty({ description: "系统代理发布是否真正执行成功" })
  published: boolean;

  @ApiProperty({
    required: false,
    description: "published=false 时的业务失败原因（不抛 5xx）",
    enum: [...RETRYABLE_REASONS, "publish_failed"],
  })
  reason?: ReleaseIfApprovedReason;
}

/**
 * R92「重新发起审批单」入参。全部来自失败审计 detail（或 commit failed 态回带）；
 * 只声明这 4 个字段，全局 ValidationPipe 的 forbidNonWhitelisted 挡多余字段。
 */
export class RequestReleaseRetryDto {
  @ApiProperty({ description: "失败审计 detail.sopId：已落库的 SOP 草稿 id" })
  @IsString()
  @IsNotEmpty()
  sopId: string;

  @ApiProperty({ description: "失败审计 detail.cardHash：方案卡内容哈希" })
  @IsString()
  @IsNotEmpty()
  cardHash: string;

  @ApiProperty({
    description:
      "失败审计 detail.contentHash：服务端从 draft 重算并严格比对，篡改即 400",
  })
  @IsString()
  @IsNotEmpty()
  contentHash: string;

  @ApiPropertyOptional({
    enum: ["patch", "minor", "major"],
    description: "可选版本递增策略，原样透传 requestRelease",
  })
  @IsOptional()
  @IsIn(["patch", "minor", "major"])
  bump?: "patch" | "minor" | "major";
}

export class RequestReleaseRetryResponseDto {
  @ApiProperty({ description: "重新发起的审批单 key（待主管四眼批准）" })
  approvalKey: string;

  @ApiProperty({ description: "复核会话 id" })
  sessionId: string;

  @ApiProperty({ description: "恒为 true：本次确实重新发起了审批单" })
  retried: boolean;
}

/**
 * ADR-045 发布链「一键重试」窄端点。
 *
 * 权限与批准同档（类级 ADMIN）：主管/ADMIN 才能对既有 granted 审批单重试
 * **系统代理发布**。这不改变四眼自批边界：发起人重新提交的仍是原审批链，
 * 本端点不 decide、不把 publish 权限交还业务人员，只对已批准过的单重跑
 * 「hash 比对 + consume + publish」。consume 之后的失败（publish_failed）
 * 被白名单挡在调用服务之前，杜绝重复发布。
 *
 * 刻意不塞进 agent.controller.ts（体量已顶格），由 WorkbenchModule 装配。
 */
@ApiTags("workbench")
@ApiBearerAuth("JWT")
@UseGuards(JwtAuthGuard)
@Roles(UserRole.ADMIN)
@Controller("workbench")
export class ReleaseRetryController {
  private readonly logger = new Logger(ReleaseRetryController.name);

  constructor(
    private readonly release: ReleaseApprovalService,
    private readonly audit: AuditService,
    // R92：draft 读取端口。@Optional 缺席 ⇒ 仅新端点 DEPENDENCY_UNAVAILABLE，
    // 旧 `/:approvalKey/retry` 逐字不受影响。生产由 WorkbenchModule 已注册的
    // RELEASE_SOPS_PORT 提供（同一 provider，无需改 module）。
    @Optional()
    @Inject(RELEASE_SOPS_PORT)
    private readonly sops?: ReleaseSopsPort | null,
  ) {}

  // HTTP 路径仍是 /workbench/release-approvals/:approvalKey/retry；
  // 前缀复用已登记的 workbench，避免新开一个未在接口地图登记的域。
  @Post("release-approvals/:approvalKey/retry")
  @ApiOperation({
    summary: "ADR-045：主管批准后发布失败的一键重试（仅 consume 前失败）",
    description:
      "expectedReason 必须来自失败审计 detail.reason 且在 consume 前失败白名单内；" +
      "publish_failed 表示 consume 已完成，调用会被拒绝以防重复发布。",
  })
  @ApiBody({ type: RetryReleaseDto })
  @ApiCreatedResponse({
    type: ReleaseRetryResponseDto,
    description: "重试已受理；published=false 是业务结果而非服务错误",
  })
  @ApiBadRequestResponse({
    description: "expectedReason 非白名单（含 publish_failed）或字段非法",
  })
  async retry(
    @Param("approvalKey") approvalKey: string,
    @Body() dto: RetryReleaseDto,
    @CurrentUser() user?: AuthUser,
  ): Promise<ReleaseRetryResponseDto> {
    // 安全核心：白名单闸必须在任何 releaseByApprovalKey 调用之前。
    // 即便有人对已 consumed 的单点 retry，也在这里被挡住，绝不进 consume/publish。
    if (
      typeof dto?.expectedReason !== "string" ||
      !RETRYABLE_SET.has(dto.expectedReason)
    ) {
      throw new AppError(ErrorCode.VALIDATION_FAILED, {
        detail:
          "expectedReason 只接受 consume 之前的失败原因；publish_failed 表示 consume 已完成，重试会造成重复发布",
      });
    }

    let outcome: Awaited<
      ReturnType<ReleaseApprovalService["releaseByApprovalKey"]>
    >;
    try {
      // 沿用批准 controller 的调用语义：null = 策略指纹由服务内部取当前值。
      outcome = await this.release.releaseByApprovalKey(approvalKey, null);
    } catch (err: unknown) {
      // 重试失败是业务结果，不把任何服务异常升级成 5xx。
      this.logger.warn(
        `release retry threw: ${approvalKey} — ${
          err instanceof Error ? err.name : "unknown"
        }`,
      );
      outcome = { published: false, reason: "publish_failed" };
    }

    // 审计旁路：与 release-outcome.audit.ts 同款 fire-and-forget，失败只 warn。
    this.writeAudit(approvalKey, dto.expectedReason, outcome, user);

    if (outcome.published) return { retried: true, published: true };
    return {
      retried: true,
      published: false,
      reason: outcome.reason ?? "publish_failed",
    };
  }

  /**
   * R92 跨角色闭环：ADMIN 对「审批发起失败」重新发起审批单。
   *
   * 与 `/:approvalKey/retry` 严格区分：那边是「已有 granted 单的 consume 前失败」
   * 重跑发布；这边是「根本没有审批单」重新建单。只调 requestRelease，
   * 绝不 decide、不 consume、不 publish —— 四眼边界逐字不变。
   */
  @Post("release-approvals/request")
  @ApiOperation({
    summary: "R92：审批发起失败后由 ADMIN 重新发起审批单（不发布）",
    description:
      "sopId/cardHash/contentHash 来自失败审计 detail；服务端从 draft 重算 contentHash 严格比对，" +
      "通过后重新发起审批单，仍需主管四眼批准 + 系统代理发布。",
  })
  @ApiBody({ type: RequestReleaseRetryDto })
  @ApiCreatedResponse({ type: RequestReleaseRetryResponseDto })
  @ApiBadRequestResponse({
    description: "contentHash 与服务端重算不一致 / draft 缺失 / 发起人缺失",
  })
  async requestReleaseRetry(
    @Body() dto: RequestReleaseRetryDto,
    @CurrentUser() user?: AuthUser,
  ): Promise<RequestReleaseRetryResponseDto> {
    if (!this.sops) {
      throw new AppError(ErrorCode.DEPENDENCY_UNAVAILABLE, {});
    }
    const requestedBy = String(user?.username ?? "").trim();
    if (!requestedBy) {
      throw new AppError(ErrorCode.VALIDATION_FAILED, {
        detail: "无法识别发起人：ADMIN 上下文缺少 username",
      });
    }
    const sopId = String(dto?.sopId ?? "").trim();
    const cardHash = String(dto?.cardHash ?? "").trim();
    const expectedContentHash = String(dto?.contentHash ?? "").trim();
    if (!sopId || !cardHash || !expectedContentHash) {
      throw new AppError(ErrorCode.VALIDATION_FAILED, {
        detail: "sopId / cardHash / contentHash 均为必填",
      });
    }

    // 服务端重算锚定：与 releaseIfApproved 同款，绝不信任客户端传来的 contentHash。
    const draft = await this.sops.findDraft(sopId);
    if (!draft || !draft.frontMatterJson || draft.bodyMarkdown == null) {
      throw new AppError(ErrorCode.VALIDATION_FAILED, {
        detail: "SOP 草稿不存在或 front-matter/body 缺失，无法重算 contentHash",
      });
    }
    const contentHash = sopContentHash(
      draft.frontMatterJson as unknown as SopFrontMatter,
      draft.bodyMarkdown,
    );
    if (contentHash !== expectedContentHash) {
      throw new AppError(ErrorCode.VALIDATION_FAILED, {
        detail:
          "contentHash 与服务端从 draft 重算的结果不一致（内容已变更或入参被篡改）",
      });
    }

    const created = await this.release.requestRelease({
      sopId,
      cardHash,
      contentHash,
      username: requestedBy,
      ...(dto.bump !== undefined ? { bump: dto.bump } : {}),
    });

    // 审计旁路：与既有 retry.writeAudit 同款 fire-and-forget，失败只 warn。
    this.writeRequestRetryAudit(
      { sopId, cardHash, contentHash, requestedBy },
      created,
    );

    return {
      approvalKey: created.approvalKey,
      sessionId: created.sessionId,
      retried: true,
    };
  }

  private writeRequestRetryAudit(
    input: {
      sopId: string;
      cardHash: string;
      contentHash: string;
      requestedBy: string;
    },
    created: { approvalKey: string; sessionId: string },
  ): void {
    const payload = {
      action: APPROVAL_REQUEST_RETRIED_ACTION,
      resource: "sop",
      resourceId: input.sopId,
      result: "success" as const,
      detail: {
        ...input,
        approvalKey: created.approvalKey,
        sessionId: created.sessionId,
        attempt: "request_retry",
      },
    };
    try {
      void Promise.resolve(this.audit.log(payload)).catch((err: unknown) => {
        this.logger.warn(
          `approval_request_retried audit append failed — ${
            err instanceof Error ? err.name : "unknown"
          }`,
        );
      });
    } catch (err: unknown) {
      this.logger.warn(
        `approval_request_retried audit append failed — ${
          err instanceof Error ? err.name : "unknown"
        }`,
      );
    }
  }

  private writeAudit(
    approvalKey: string,
    expectedReason: string,
    outcome: Awaited<
      ReturnType<ReleaseApprovalService["releaseByApprovalKey"]>
    >,
    user?: AuthUser,
  ): void {
    const detail: Record<string, unknown> = {
      approvalKey,
      expectedReason,
      toolName: RELEASE_TOOL_NAME,
      retriedBy: user?.username ?? null,
      // 新 attempt 标记：把一键重试与首次批准后的自动发布区分开。
      retry: "主管 ADMIN 一键重试",
      attempt: "retry",
    };
    if (outcome.published) {
      detail.published = true;
      detail.publishedBy = RELEASE_PUBLISHED_BY;
    } else {
      detail.published = false;
      detail.reason = outcome.reason ?? "publish_failed";
    }

    const payload = {
      action: outcome.published
        ? SOP_RELEASE_AUDIT_ACTIONS.succeeded
        : SOP_RELEASE_AUDIT_ACTIONS.failed,
      resource: "agent_approval",
      resourceId: approvalKey,
      result: outcome.published ? ("success" as const) : ("failure" as const),
      detail,
    };
    try {
      void Promise.resolve(this.audit.log(payload)).catch((err: unknown) => {
        this.logger.warn(
          `sop_publish retry audit append failed: ${payload.action} — ${
            err instanceof Error ? err.name : "unknown"
          }`,
        );
      });
    } catch (err: unknown) {
      this.logger.warn(
        `sop_publish retry audit append failed: ${payload.action} — ${
          err instanceof Error ? err.name : "unknown"
        }`,
      );
    }
  }
}
