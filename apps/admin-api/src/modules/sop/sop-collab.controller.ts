import {
  Body,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Ip,
  Param,
  Post,
  UploadedFile,
  UseInterceptors,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { diskStorage } from "multer";
import { ConfigService } from "@nestjs/config";
import {
  IsArray,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from "class-validator";
import {
  ApiProperty,
  ApiPropertyOptional,
  ApiOkResponse,
  ApiCreatedResponse,
  ApiExtraModels,
} from "@nestjs/swagger";

import { Public } from "../../common/decorators/public.decorator";
import { WriteGuard } from "../../common/decorators/write-guard.decorator";
import { ExecutorService } from "../executor/executor.service";
import type { Executor } from "../executor/entities/executor.entity";
import { ExecutorPackageService } from "../executor-package/executor-package.service";
import { PACKAGE_UPLOAD_TMP_DIR } from "../executor-package/executor-package.service";
import {
  AiService,
  type MultimodalMessage,
  type MultimodalPart,
} from "../ai/ai.service";
import { SopService } from "./sop.service";
import { SopMediaService, MAX_AGENT_MEDIA_BYTES } from "./sop-media.service";
import type { SopClarificationMediaRef } from "./entities/sop-clarification.entity";
// ADR-017 阶段 3（复查补口）：判定「指纹是否已上报」以决定能否走凭据反查
// 兜底（与 executor.service 的定位键规范化同一事实源）。
import { normalizeDeviceFingerprint } from "../executor/executor-fingerprint.util";
// ARCH-23 / N-12: Agent 协作面响应契约（与 sop 管理面共用 dto 文件）。
import {
  CollabAssignmentItemDto,
  CollabCandidatePackageResponseDto,
  CollabClarificationReplyItemDto,
  CollabClarifyResponseDto,
  CollabCompleteResponseDto,
  CollabLlmRelayResponseDto,
  CollabMediaUploadResponseDto,
  CollabPollResponseDto,
} from "./dto/sop-response.dto";
// LANG-ERR-01: 用户可见报错改为稳定错误码（文案由前端按用户语言渲染）。
import { AppError } from "../../common/errors/app-error";
import { ErrorCode } from "../../common/errors/error-codes";

/**
 * P6（agent-and-deployment）：Agent 协作 API（设计文档 11）——执行器 Agent
 * ↔ 中台 Agent 的通信面。P5/P6 阶段由**手工 HTTP 模拟执行器**驱动验收，
 * P7 的 executor-desktop Agent 走同一批端点。
 *
 * ## 鉴权（11 §2：复用已验证的机制，不新造凭据体系）
 * per-executor token（`validateTokenByAddress`）——与 pull / heartbeat
 * 同一条机器身份链。**不进 JWT/API-Key 体系**。
 *
 * ## 能力闸（11 §5.1）
 * 澄清/进度/完成等协作面要求执行器 `agentCapabilities` 显式含 `agent:sop`——
 * **空能力 ≠ 通用**（既有「空 = runtime 通用」语义不沿用，10 §缺口2补）。
 * `capability` 上报端点是**唯一例外**：它就是执行器声明能力的入口。
 *
 * ## 拉模式优先
 * 执行器多在 NAT 后（ADR-015）。poll 走长轮询（服务端钳位 ≤25s，低于反代
 * 60s 读超时）；绝不要求中台拨入执行器。
 */

/** 长轮询上限（与 pull 通道同款纪律：必须 < 反代 60s 读超时）。 */
const POLL_MAX_WAIT_MS = 25_000;
const POLL_TICK_MS = 500;

/**
 * B-9：媒体上传的 multer 层上限。100MB 的业务判定（SopMediaService.save）
 * 在整包读入内存之后才发生——没有这道拦截器闸，超大 multipart 会先整包
 * 进内存再被拒。与候选包端点的 500MB limits 同款先例。
 */
export const MEDIA_UPLOAD_LIMITS = { fileSize: MAX_AGENT_MEDIA_BYTES } as const;

/**
 * R203-A1：本控制器 9 条写路由的授权形态声明文本（@WriteGuard scope='token'）。
 *
 * 此前这 9 条只有类级 @Public()——**免 JWT 写端点却没有任何声明**。A2 的纪律
 * （write-guard-coverage：每个写端点必须显式声明 @Roles 或 @WriteGuard）之所以
 * 没拦住它们，是因为那份 spec 的控制器清单是手写的且漏了本控制器（26/30）。
 * 清单改为文件系统发现后这 9 条立刻变红，补上本条即恢复绿：声明不是文档，
 * 是「这个免 JWT 的写面凭什么可以不鉴权」的必须答案。
 */
const AGENT_TOKEN_AUTH_REASON =
  "执行器机器面：per-executor 令牌（validateTokenByAddress + resolveCredentialExecutorId 凭据反查），不进 JWT/API-Key 体系；令牌缺失或无效即 SOP_COLLAB_EXECUTOR_TOKEN_INVALID，协作写面另需 agent:sop 能力闸";

function bearer(auth: string | undefined): string {
  return auth?.startsWith("Bearer ") ? auth.slice(7) : (auth ?? "");
}

export class AgentCollabPollDto {
  @ApiProperty({ example: "office-pc-07:8002" })
  @IsString()
  @MaxLength(255)
  address!: string;
  /** ADR-017 阶段 3：稳定设备指纹（可选；旧执行器不传）——pull 同址多行时唯一定位本行。 */
  @IsOptional()
  @IsString()
  @MaxLength(255)
  deviceFingerprint?: string | null;
  @ApiPropertyOptional({ description: "长轮询等待（服务端钳位 ≤25s）" })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(25_000)
  waitMs?: number;
  /**
   * 执行器丢了本地状态时强制重发指派载荷（含 SOP 全量）。
   * `true` = 全部活跃单重发（未投递的旧单重新排队）；
   * `[id]` = 只重发指定单（P7d 崩溃恢复，定向且不触碰其它单的游标）。
   */
  @ApiPropertyOptional({
    oneOf: [{ type: "boolean" }, { type: "array", items: { type: "string" } }],
  })
  @IsOptional()
  resendAssignments?: boolean | string[];
  @ApiPropertyOptional({ isArray: true, type: "string" })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  inflight?: string[];
}

export class AgentCollabCapabilityDto {
  @ApiProperty()
  @IsString()
  @MaxLength(255)
  address!: string;
  /** ADR-017 阶段 3：稳定设备指纹（可选；旧执行器不传）——pull 同址多行时唯一定位本行。 */
  @IsOptional()
  @IsString()
  @MaxLength(255)
  deviceFingerprint?: string | null;
  /** 能力域清单（覆盖式）。接 SOP 的机器必须显式含 `agent:sop`。 */
  @ApiProperty({ isArray: true, type: "string" })
  @IsArray()
  @IsString({ each: true })
  @MaxLength(64, { each: true })
  capabilities!: string[];
  /** 富结构能力报告（可选，P7 的可行性预检用）。 */
  @ApiPropertyOptional({ type: "object", additionalProperties: true })
  @IsOptional()
  @IsObject()
  report?: Record<string, unknown>;
}

export class AgentCollabClarificationDto {
  @ApiProperty()
  @IsString()
  @MaxLength(255)
  address!: string;
  /** ADR-017 阶段 3：稳定设备指纹（可选；旧执行器不传）——pull 同址多行时唯一定位本行。 */
  @IsOptional()
  @IsString()
  @MaxLength(255)
  deviceFingerprint?: string | null;
  @ApiProperty({ format: "uuid" })
  @IsUUID()
  assignmentId!: string;
  /** 客户端生成的幂等键（UUID）——重试重发不产生两条澄清。 */
  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  clientClarificationId?: string;
  @ApiProperty()
  @IsString()
  @MaxLength(10_000)
  question!: string;
  @ApiPropertyOptional({ type: "object", additionalProperties: true })
  @IsOptional()
  @IsObject()
  context?: Record<string, unknown>;
  @ApiPropertyOptional({
    type: "object",
    additionalProperties: true,
    isArray: true,
  })
  @IsOptional()
  @IsArray()
  mediaRefs?: SopClarificationMediaRef[];
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(255)
  targetAgentSessionId?: string;
}

export class AgentCollabProgressDto {
  @ApiProperty()
  @IsString()
  @MaxLength(255)
  address!: string;
  /** ADR-017 阶段 3：稳定设备指纹（可选；旧执行器不传）——pull 同址多行时唯一定位本行。 */
  @IsOptional()
  @IsString()
  @MaxLength(255)
  deviceFingerprint?: string | null;
  @ApiPropertyOptional({ type: "object", additionalProperties: true })
  @IsOptional()
  @IsObject()
  progressJson?: Record<string, unknown>;
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(255)
  targetAgentSessionId?: string;
}

export class AgentCollabCompleteDto {
  @ApiProperty()
  @IsString()
  @MaxLength(255)
  address!: string;
  /** ADR-017 阶段 3：稳定设备指纹（可选；旧执行器不传）——pull 同址多行时唯一定位本行。 */
  @IsOptional()
  @IsString()
  @MaxLength(255)
  deviceFingerprint?: string | null;
  @ApiProperty({ enum: ["completed", "failed"] })
  @IsIn(["completed", "failed"])
  status!: "completed" | "failed";
  @ApiPropertyOptional({ type: "object", additionalProperties: true })
  @IsOptional()
  @IsObject()
  result?: Record<string, unknown>;
  /** 幂等：同 attempt 重放无害。 */
  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(1)
  attempt?: number;
}

export class AgentCollabAckReplyDto {
  @ApiProperty()
  @IsString()
  @MaxLength(255)
  address!: string;
  /** ADR-017 阶段 3：稳定设备指纹（可选；旧执行器不传）——pull 同址多行时唯一定位本行。 */
  @IsOptional()
  @IsString()
  @MaxLength(255)
  deviceFingerprint?: string | null;
  @ApiProperty({ format: "uuid" })
  @IsUUID()
  clarificationId!: string;
}

/**
 * 解析 LLM relay 的 message content：允许 string（历史形态）或 OpenAI
 * 多模态 part 数组（text + image_url）。图片接受两类：
 *   · http(s) URL（provider 自行抓取）；
 *   · `data:image/(png|jpeg|webp);base64,...`（执行器本地截图直传，单图 ≤3MB）。
 * 后者实测被 provider 接受，且不触发服务端出站抓取（SSRF 面为零）；视频
 * 与未知 part 一律拒绝（当前 provider 无视频能力）。
 */
function parseRelayMessages(
  raw: Array<{ role?: string; content?: unknown }>,
): MultimodalMessage[] {
  let imageCount = 0;
  return raw.map((m, index) => {
    const role = m?.role;
    if (role !== "system" && role !== "user" && role !== "assistant") {
      throw new AppError(ErrorCode.SOP_COLLAB_MESSAGE_ROLE_INVALID, { index });
    }
    const content = m?.content;
    if (typeof content === "string") {
      if (content.length === 0) {
        throw new AppError(ErrorCode.SOP_COLLAB_MESSAGE_CONTENT_REQUIRED, { index });
      }
      if (content.length > 100_000) {
        throw new AppError(ErrorCode.SOP_COLLAB_MESSAGE_CONTENT_TOO_LARGE, { index });
      }
      return { role, content } as MultimodalMessage;
    }
    if (!Array.isArray(content) || content.length === 0) {
      throw new AppError(ErrorCode.SOP_COLLAB_MESSAGE_CONTENT_REQUIRED, { index });
    }
    const parts: MultimodalPart[] = [];
    for (const part of content) {
      if (!part || typeof part !== "object") {
        throw new AppError(ErrorCode.SOP_COLLAB_MESSAGE_CONTENT_REQUIRED, { index });
      }
      const rec = part as Record<string, unknown>;
      if (rec.type === "text" && typeof rec.text === "string" && rec.text.length > 0) {
        if (rec.text.length > 100_000) {
          throw new AppError(ErrorCode.SOP_COLLAB_MESSAGE_CONTENT_TOO_LARGE, { index });
        }
        parts.push({ type: "text", text: rec.text });
        continue;
      }
      const image = rec.type === "image_url" ? (rec.image_url as { url?: unknown } | undefined) : undefined;
      if (image && typeof image.url === "string") {
        const url = image.url;
        const isHttp = /^https?:\/\//i.test(url);
        const isInlineImage =
          /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/i.test(url) &&
          url.length <= 3 * 1024 * 1024;
        if (!isHttp && !isInlineImage) {
          throw new AppError(ErrorCode.SOP_COLLAB_MESSAGE_CONTENT_REQUIRED, { index });
        }
        if (isHttp && url.length > 2048) {
          throw new AppError(ErrorCode.SOP_COLLAB_MESSAGE_CONTENT_REQUIRED, { index });
        }
        imageCount += 1;
        if (imageCount > 4) {
          throw new AppError(ErrorCode.SOP_COLLAB_MESSAGE_CONTENT_TOO_LARGE, { index });
        }
        parts.push({ type: "image_url", image_url: { url: image.url } });
        continue;
      }
      // video_url / 未知 part：该 provider 无视频能力；拒绝比静默丢弃诚实。
      throw new AppError(ErrorCode.SOP_COLLAB_MESSAGE_CONTENT_REQUIRED, { index });
    }
    if (parts.length === 0) {
      throw new AppError(ErrorCode.SOP_COLLAB_MESSAGE_CONTENT_REQUIRED, { index });
    }
    return { role, content: parts } as MultimodalMessage;
  });
}

// @Public() + 手工机器鉴权：执行器面（非用户 JWT 面）
@Public()
// poll 的混合 items 走 getSchemaPath 裸 $ref，两个 item 类必须显式登记。
@ApiExtraModels(CollabAssignmentItemDto, CollabClarificationReplyItemDto)
@Controller("agent-collab")
export class SopCollabController {
  constructor(
    private readonly executors: ExecutorService,
    private readonly sops: SopService,
    private readonly media: SopMediaService,
    private readonly packages: ExecutorPackageService,
    private readonly config: ConfigService,
    private readonly ai: AiService,
  ) {}

  /**
   * 长轮询：返回指派（首次领取含 SOP 全量）与澄清回复。
   * 载荷随 poll 附带 `sopPolicy`（11 §3.1）——企业策略每轮下发，
   * 执行器本地配置突破不了（P7 执行器侧实现「min(本地, 中台上限)」合并）。
   */
  @WriteGuard("agent-collab-poll", {
    scope: "token",
    reason: AGENT_TOKEN_AUTH_REASON,
  })
  @Post("poll")
  @HttpCode(HttpStatus.OK)
  // N-12: items 是 assignment 与 clarification_reply 的混合数组（oneOf）。
  @ApiOkResponse({ type: CollabPollResponseDto })
  async poll(
    @Body() body: AgentCollabPollDto,
    @Headers("authorization") auth: string,
  ) {
    const executor = await this.authenticate(
      body?.address,
      auth,
      body?.deviceFingerprint,
    );
    const requested = Number(body.waitMs ?? 0);
    const deadline =
      Number.isFinite(requested) && requested > 0
        ? Math.min(requested, POLL_MAX_WAIT_MS)
        : 0;
    const start = Date.now();

    for (;;) {
      const items = await this.sops.pollPending({
        executorId: executor.id,
        // B-5：按 id 重发的数组形态必须透传（DTO 声明支持、service 支持）——
        // 此前 `=== true` 把数组丢成 false，P7d 崩溃恢复的定向重发永远收不到
        resendAssignments:
          body.resendAssignments === true
            ? true
            : Array.isArray(body.resendAssignments)
              ? body.resendAssignments.filter(
                  (x): x is string => typeof x === "string" && x.length > 0,
                )
              : false,
      });
      if (items.length > 0 || Date.now() - start >= deadline) {
        return { items, sopPolicy: this.sopPolicy() };
      }
      await new Promise((r) => setTimeout(r, POLL_TICK_MS));
    }
  }

  /** 上报能力清单（覆盖式）。接 SOP 派发的机器在此声明 `agent:sop`。 */
  @WriteGuard("agent-collab-capability", {
    scope: "token",
    reason: AGENT_TOKEN_AUTH_REASON,
  })
  @Post("capability")
  @HttpCode(HttpStatus.OK)
  @ApiOkResponse({
    schema: {
      type: "object",
      properties: { ok: { type: "boolean", enum: [true] } },
      required: ["ok"],
    },
  })
  async capability(
    @Body() body: AgentCollabCapabilityDto,
    @Headers("authorization") auth: string,
  ) {
    const executor = await this.authenticate(
      body?.address,
      auth,
      body?.deviceFingerprint,
    );
    const caps = Array.isArray(body.capabilities) ? body.capabilities : [];
    if (
      caps.length > 32 ||
      caps.some((c) => typeof c !== "string" || c.length > 64)
    ) {
      throw new AppError(ErrorCode.SOP_COLLAB_CAPABILITIES_INVALID);
    }
    await this.executors.updateCapabilities(executor.id, caps);
    return { ok: true };
  }

  /** 发起澄清（P6 核心：执行器 Agent 回问）。 */
  @WriteGuard("agent-collab-clarification", {
    scope: "token",
    reason: AGENT_TOKEN_AUTH_REASON,
  })
  @Post("clarifications")
  @HttpCode(HttpStatus.OK)
  @ApiOkResponse({ type: CollabClarifyResponseDto })
  async clarify(
    @Body() body: AgentCollabClarificationDto,
    @Headers("authorization") auth: string,
    // R41-A1：审计来源 ip（本面是机器身份，没有登录用户——操作者由服务层
    // 记作 executor:<id>）。
    @Ip() ip?: string,
  ) {
    // 鉴权 + 能力闸（结果本体不入账——澄清归属由 assignmentId 决定，
    // 但归属断言需要 executor.id，B-1）
    const executor = await this.authenticateAgent(
      body?.address,
      auth,
      body?.deviceFingerprint,
    );
    if (!body.assignmentId || typeof body.question !== "string") {
      throw new AppError(
        ErrorCode.SOP_COLLAB_ASSIGNMENT_ID_AND_QUESTION_REQUIRED,
      );
    }
    const { clarification, escalated } = await this.sops.ingestClarification({
      assignmentId: body.assignmentId,
      // B-1：归属校验下沉到服务层（与 completeAssignment 同一道闸）——
      // 澄清归属由 assignmentId 决定，但「该指派是否属于这台机器」必须在
      // 落库前断言，否则任何 agent:sop 机器可对他人工单发起澄清。
      executorId: executor.id,
      clientClarificationId: body.clientClarificationId,
      question: body.question,
      context: body.context ?? null,
      mediaRefs: body.mediaRefs ?? [],
      targetAgentSessionId: body.targetAgentSessionId ?? null,
      audit: { ip: ip ?? null },
    });
    return {
      clarificationId: clarification.clientClarificationId ?? clarification.id,
      round: clarification.round,
      escalated,
      // escalated=true 时中台不会再起 sop_review 会话——人会在通知渠道看到
    };
  }

  /** 进度心跳（存活信号，卡死判定依据）。 */
  @WriteGuard("agent-collab-progress", {
    scope: "token",
    reason: AGENT_TOKEN_AUTH_REASON,
  })
  @Post("assignments/:id/progress")
  @HttpCode(HttpStatus.OK)
  @ApiOkResponse({
    schema: {
      type: "object",
      properties: { ok: { type: "boolean", enum: [true] } },
      required: ["ok"],
    },
  })
  async progress(
    @Param("id") assignmentId: string,
    @Body() body: AgentCollabProgressDto,
    @Headers("authorization") auth: string,
  ) {
    const executor = await this.authenticateAgent(
      body?.address,
      auth,
      body?.deviceFingerprint,
    );
    await this.sops.recordProgress({
      assignmentId,
      executorId: executor.id,
      progressJson: body.progressJson ?? null,
      targetAgentSessionId: body.targetAgentSessionId ?? null,
    });
    return { ok: true };
  }

  /** 回报完成（幂等键 attempt）。验收判定是中台 Agent 的职责，这里只落账。 */
  @WriteGuard("agent-collab-completion", {
    scope: "token",
    reason: AGENT_TOKEN_AUTH_REASON,
  })
  @Post("assignments/:id/complete")
  @HttpCode(HttpStatus.OK)
  @ApiOkResponse({ type: CollabCompleteResponseDto })
  async complete(
    @Param("id") assignmentId: string,
    @Body() body: AgentCollabCompleteDto,
    @Headers("authorization") auth: string,
    // R41-A1：审计来源 ip（执行器面，无登录用户）。
    @Ip() ip?: string,
  ) {
    const executor = await this.authenticateAgent(
      body?.address,
      auth,
      body?.deviceFingerprint,
    );
    if (body.status !== "completed" && body.status !== "failed") {
      throw new AppError(ErrorCode.SOP_COLLAB_STATUS_INVALID);
    }
    const { accepted } = await this.sops.completeAssignment({
      assignmentId,
      executorId: executor.id,
      status: body.status,
      result: body.result ?? null,
      attempt: body.attempt,
      audit: { ip: ip ?? null },
    });
    return { accepted };
  }

  /**
   * 澄清回复 ACK（P7d 双端确认的执行器半边）。执行器把回复落盘并消费
   * （续跑循环）之后才确认；确认前该回复随每次 poll 重发（至少一次投递），
   * 执行器侧按 clarificationId 幂等去重——重复投递不产生重复消费。
   */
  @WriteGuard("agent-collab-clarification", {
    scope: "token",
    reason: AGENT_TOKEN_AUTH_REASON,
  })
  @Post("assignments/:id/clarifications/ack")
  @HttpCode(HttpStatus.OK)
  @ApiOkResponse({
    schema: {
      type: "object",
      properties: { ok: { type: "boolean", enum: [true] } },
      required: ["ok"],
    },
  })
  async ackClarificationReply(
    @Param("id") assignmentId: string,
    @Body() body: AgentCollabAckReplyDto,
    @Headers("authorization") auth: string,
  ) {
    const executor = await this.authenticateAgent(
      body?.address,
      auth,
      body?.deviceFingerprint,
    );
    if (!body?.clarificationId) {
      throw new AppError(ErrorCode.SOP_COLLAB_CLARIFICATION_ID_REQUIRED);
    }
    await this.sops.ackClarificationReply({
      assignmentId,
      executorId: executor.id,
      clarificationId: body.clarificationId,
    });
    return { ok: true };
  }

  /**
   * LLM relay（P7a 续批）：执行器 Agent 的推理调用经中台代跑。
   *
   * ## 为什么是 relay 而不是把 API key 下发
   * ① key 不出服务端——客户端被入侵也不泄露 LLM 凭据；② 令牌消耗记在
   * 中台 metrics（成本归因唯一数据源）；③ 企业 IT 只需在中台配额，不必
   * 逐台下发 key（09 §4.2 同款集中管控思路）。
   *
   * ## 载荷边界
   * messages ≤64 条、单条 content ≤100KB（防塞爆上游上下文/烧穿配额）；
   * role 白名单（system/user/assistant——tool 往返由中台 Agent 自己用，
   * 不对执行器开放）。provider 未启用/不可用时 chatMultimodal fail-open
   * 返回空 content——**原样透传**，执行器按「模型不可用」降级（不掩盖、
   * 不造成功假象）。
   */
  @WriteGuard("agent-collab-llm", {
    scope: "token",
    reason: AGENT_TOKEN_AUTH_REASON,
  })
  @Post("llm")
  @HttpCode(HttpStatus.OK)
  @ApiOkResponse({ type: CollabLlmRelayResponseDto })
  async llmRelay(
    @Body()
    body: {
      address: string;
      deviceFingerprint?: string | null;
      messages?: Array<{ role?: string; content?: unknown }>;
      tools?: unknown;
    },
    @Headers("authorization") auth: string,
  ) {
    await this.authenticateAgent(body?.address, auth, body?.deviceFingerprint);

    const raw = Array.isArray(body?.messages) ? body.messages : [];
    if (raw.length === 0 || raw.length > 64) {
      throw new AppError(ErrorCode.SOP_COLLAB_MESSAGES_COUNT_INVALID);
    }
    const messages = parseRelayMessages(raw);
    const tools = Array.isArray(body?.tools) ? body.tools : undefined;
    if (tools && tools.length > 32) {
      throw new AppError(ErrorCode.SOP_COLLAB_TOOLS_TOO_MANY);
    }

    const res = await this.ai.chatMultimodal({
      messages,
      ...(tools ? { tools: tools as never } : {}),
    });
    return {
      content: res.content,
      toolCalls: res.toolCalls ?? null,
      usage: res.usage,
      model: res.model,
    };
  }

  /**
   * 媒体回传（P7b）：执行器把截图/录屏挂到指派上。
   *
   * 返回的 `mediaPath` 是 mediaRefs 的**唯一合法引用形态**
   * （`/api/sop/media/<id>`，R35-A1 更正——此前写的
   * `/api/agent-collab/media/<id>` 从不是一条路由，取回 404）——澄清提问
   * 引用外网 URL 的门在 SopService.validateMediaRefs 早已关死（SSRF 转嫁面），
   * 这里给出的是平台内路径，中心侧（Qwen 视频理解）与 admin-web 复核都经
   * `SopController.downloadMedia`（@Get("media/:mediaId")，ADMIN）取字节。
   *
   * 归属校验：指派必须属于该执行器（防 A 机器给 B 的工单塞证据）；
   * 状态不设限——澄清期间（blocked）正是要发截图的场景。
   */
  @WriteGuard("agent-collab-media", {
    scope: "token",
    reason: AGENT_TOKEN_AUTH_REASON,
  })
  @Post("assignments/:id/media")
  @HttpCode(HttpStatus.CREATED)
  @ApiCreatedResponse({ type: CollabMediaUploadResponseDto })
  // B-9：limits 在拦截器即生效——超过 100MB 的 multipart 在 multer 层被拒，
  // 不再整包读入内存后才由业务判定拒绝。
  @UseInterceptors(FileInterceptor("file", { limits: MEDIA_UPLOAD_LIMITS }))
  async uploadMedia(
    @Param("id") assignmentId: string,
    @Body() body: { address: string; deviceFingerprint?: string | null },
    @UploadedFile() file?: Express.Multer.File,
    @Headers("authorization") auth?: string,
  ) {
    const executor = await this.authenticateAgent(
      body?.address,
      auth,
      body?.deviceFingerprint,
    );
    const { assignment } = await this.sops.getAssignment(assignmentId);
    if (assignment.targetExecutorId !== executor.id) {
      throw new AppError(ErrorCode.SOP_ASSIGNMENT_NOT_OWNED_BY_EXECUTOR);
    }
    if (!file?.buffer?.length) {
      throw new AppError(ErrorCode.SOP_COLLAB_FILE_FIELD_MISSING);
    }
    const stored = await this.media.save({
      assignmentId,
      name: file.originalname ?? "media.bin",
      mime: file.mimetype ?? null,
      buf: file.buffer,
      uploadedBy: `executor:${executor.id}`,
    });
    return stored;
  }

  /**
   * 候选应用包上传（P7d 前半，07 §3.3）：验收通过的候选打成标准 zip 交给
   * **既有 executor-package 校验链**（PK 魔数/后缀白名单/zip bomb SEC-05
   * 逐项生效）——Agent 的自由被限制在生成阶段，运行阶段走既有纪律。
   *
   * ## 来源标记由平台代码打（ADR-022 决策 5）
   * uploadedBy/description 由本端点写 `agent:sop:<executorId>` 与
   * assignment/contentHash——绝不让 Agent 自称可信来源。版本带
   * `+agent.<时间戳>` 构建元数据：同 SOP 同版本可重复交付（幂等建包），
   * 不撞 (name, version, type) 唯一约束。
   *
   * 部署本身仍走既有 deploy_application（DEP-04 审批，方案 C）——本端点
   * 只负责"包进系统"，不触部署。
   */
  @WriteGuard("agent-collab-package", {
    scope: "token",
    reason: AGENT_TOKEN_AUTH_REASON,
  })
  @Post("assignments/:id/candidate-package")
  @HttpCode(HttpStatus.CREATED)
  @ApiCreatedResponse({ type: CollabCandidatePackageResponseDto })
  @UseInterceptors(
    FileInterceptor("file", {
      storage: diskStorage({ destination: PACKAGE_UPLOAD_TMP_DIR }),
      limits: { fileSize: 500 * 1024 * 1024 },
    }),
  )
  async uploadCandidatePackage(
    @Param("id") assignmentId: string,
    @Body()
    body: {
      address: string;
      deviceFingerprint?: string | null;
      sopSlug?: string;
      sopVersion?: string;
      contentHash?: string;
      runtime?: string;
    },
    @UploadedFile() file?: Express.Multer.File,
    @Headers("authorization") auth?: string,
  ) {
    const executor = await this.authenticateAgent(
      body?.address,
      auth,
      body?.deviceFingerprint,
    );
    const { assignment } = await this.sops.getAssignment(assignmentId);
    if (assignment.targetExecutorId !== executor.id) {
      throw new AppError(ErrorCode.SOP_ASSIGNMENT_NOT_OWNED_BY_EXECUTOR);
    }
    if (!file?.path) {
      throw new AppError(ErrorCode.SOP_COLLAB_FILE_FIELD_MISSING);
    }
    const runtime = body.runtime === "node" ? "node" : "python";
    const sopSlug = (body.sopSlug ?? "candidate").slice(0, 64);
    const pkg = await this.packages.create(
      {
        name: `sop-${sopSlug}`,
        version:
          `${assignment.sopVersion}+agent.${Date.now().toString(36)}`.slice(
            0,
            64,
          ),
        type: runtime as never,
        platform: "any",
        description: `agent candidate assignment=${assignmentId} contentHash=${(body.contentHash ?? "").slice(0, 64)}`,
      },
      file,
      `agent:sop:${executor.id}`,
    );
    return { packageId: pkg.id, name: pkg.name, version: pkg.version };
  }

  // ── 内部 ────────────────────────────────────────────────────────

  /**
   * 基础机器鉴权（能力上报入口用——此时 agent:sop 可能尚未声明）。
   *
   * ADR-017 阶段 3：新增可选 `deviceFingerprint`，并把**取行挪到鉴权之后**、
   * 走指纹优先解析。此前是 `findByAddress`（裸按地址）在先——pull 同址多行
   * 并存时（ADR-017 §5）会返回**任一行**，调用方据此拿到别人的 executor.id
   * （后续能力闸/协作写面全挂在错行上）。阶段 3 下行必须先被无歧义识别。
   */
  private async authenticate(
    address: string | undefined,
    auth?: string,
    deviceFingerprint?: string | null,
  ) {
    if (!address) throw new AppError(ErrorCode.SOP_COLLAB_ADDRESS_REQUIRED);
    const presented = bearer(auth);
    const ok = await this.executors.validateTokenByAddress(
      address,
      presented,
      deviceFingerprint,
    );
    if (!ok) {
      // R34-A1（轴 2）：**per-executor 令牌 + 同址多行 + 无指纹**曾被整片 401。
      // 原因：validateTokenByAddress 对「同地址多行且本次未带指纹」按 ADR-017 §5
      // fail-closed 拒绝（resolveExecutorRow 返回 null ⇒ 只有共享令牌能通过），
      // 而下面的凭据反查挂在「校验通过之后」——对唯一需要它的场景永远走不到。
      // 桌面 Agent（agent-worker 子进程）恰恰产不出指纹，这正是当初「复查补口」
      // 要解决的那台机器。
      //
      // 凭据反查为什么安全且等价：per-executor 令牌是**行绑定**的（bcrypt 比对
      // 该行 tokenHash），「令牌匹配到哪一行」本身就是行证明——匿名调用方伪造
      // 不出别人的令牌让本方法解析到别人的行。共享令牌不绑定任何行，反查必空，
      // 所以这条兜底不会把共享令牌路径放宽（那条仍是 fail-closed 的 404）。
      // 指纹在场时**不进兜底**：指纹路径的 fail-closed 语义保持原样。
      if (!normalizeDeviceFingerprint(deviceFingerprint)) {
        const byCredential = await this.executorByCredential(
          address,
          presented,
        );
        if (byCredential) return byCredential;
      }
      throw new AppError(ErrorCode.SOP_COLLAB_EXECUTOR_TOKEN_INVALID);
    }
    // ADR-017 阶段 3（复查补口）：指纹缺省时**用所持凭据反查行身份**，而不是
    // 直接 fail-closed 拒绝。
    //
    // 为什么必须补这一层：desktop 的 Agent（agent-worker 子进程）走的就是这个
    // 协作面，而它**无法**产出指纹——盐按 `<workDir>/.device-identity/<kind>.salt`
    // 分域，那个盐属于内嵌的 executor-node bundle（kind=desktop），Agent worker
    // 是另一个进程、不共享该盐，也无从读执行器的私有派生值。若只认指纹，
    // 「pull 同址多行 + 桌面 Agent」就会整片 401/404——比不改更糟。
    //
    // 凭据反查为什么安全且等价：per-executor 令牌是**行绑定**的（bcrypt 比对
    // 该行 tokenHash），匿名调用方不可能伪造出别人的令牌来让本方法解析到一行。
    // 故「令牌匹配到哪一行」与「指纹命中哪一行」是同一强度的定位判据——前者
    // 甚至更强（指纹是自报值，可伪造；令牌是共享密钥派生）。
    //
    // 解析不出唯一行（共享令牌路径：共享令牌不绑定任何行）→ 回落地址定位的
    // 原有语义（`findByAddress` 在同址多行且无指纹时 fail-closed 返回 null）。
    let executor = await this.executors.findByAddress(
      address,
      deviceFingerprint,
    );
    if (!executor && !normalizeDeviceFingerprint(deviceFingerprint)) {
      // 指纹未上报时用凭据反查（同址多行也能唯一定位）。
      executor = await this.executorByCredential(address, presented);
    }
    if (!executor) throw new AppError(ErrorCode.SOP_COLLAB_EXECUTOR_NOT_FOUND);
    return executor;
  }

  /**
   * 凭据反查行身份（R34-A1 轴 2）。per-executor 令牌是行绑定的：bcrypt 命中
   * 哪一行的 tokenHash，就证明调用方持有那一行的凭据。反查命中的行还必须真的
   * 落在本次声明的 address 上——防 resolve 实现漂移时把一个错行的身份静默顶替
   * 进来（那是跨机器的身份冒用）。共享令牌对任何行都不命中 ⇒ 恒 null。
   */
  private async executorByCredential(
    address: string,
    presented: string,
  ): Promise<Executor | null> {
    if (!presented) return null;
    const rowId = await this.executors.resolveCredentialExecutorId(
      address,
      presented,
    );
    if (!rowId) return null;
    const row = await this.executors.findOne(rowId);
    if (!row || row.address !== address) return null;
    return row;
  }

  /** 协作面鉴权 = 机器鉴权 + 显式 `agent:sop` 能力闸（11 §5.1）。 */
  private async authenticateAgent(
    address: string | undefined,
    auth?: string,
    deviceFingerprint?: string | null,
  ) {
    const executor = await this.authenticate(address, auth, deviceFingerprint);
    const caps = await this.executors.getAgentCapabilities(executor.id);
    if (!caps.includes("agent:sop")) {
      throw new AppError(ErrorCode.SOP_COLLAB_AGENT_SOP_CAPABILITY_MISSING);
    }
    return executor;
  }

  /**
   * 随 poll 下发的策略（11 §3.1）。P5/P6 先落「中台侧权威 + 配置可改」；
   * 执行器侧的 min(本地, 中台) 合并在 P7 实现。集中管控的存在意义是：
   * 员工本地改配置突破不了公司策略——策略必须由中台每轮下发。
   */
  private sopPolicy(): Record<string, unknown> {
    return {
      permissionPolicy:
        this.config.get<string>("agent.collab.sopPolicy.permissionPolicy") ??
        "standard",
      allowedProfiles: this.config.get<string[]>(
        "agent.collab.sopPolicy.allowedProfiles",
      ) ?? ["minimal", "standard"],
    };
  }
}
