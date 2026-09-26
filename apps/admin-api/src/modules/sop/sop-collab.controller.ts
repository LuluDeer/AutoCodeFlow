import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Headers,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  Post,
  UnauthorizedException,
  UploadedFile,
  UseInterceptors,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { diskStorage } from "multer";
import { ConfigService } from "@nestjs/config";
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";

import { Public } from "../../common/decorators/public.decorator";
import { ExecutorService } from "../executor/executor.service";
import { ExecutorPackageService } from "../executor-package/executor-package.service";
import { PACKAGE_UPLOAD_TMP_DIR } from "../executor-package/executor-package.service";
import { AiService, type MultimodalMessage } from "../ai/ai.service";
import { SopService } from "./sop.service";
import { SopMediaService } from "./sop-media.service";
import type { SopClarificationMediaRef } from "./entities/sop-clarification.entity";

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

function bearer(auth: string | undefined): string {
  return auth?.startsWith("Bearer ") ? auth.slice(7) : (auth ?? "");
}

class AgentCollabPollDto {
  @ApiProperty({ example: "office-pc-07:8002" })
  address!: string;
  @ApiPropertyOptional({ description: "长轮询等待（服务端钳位 ≤25s）" })
  waitMs?: number;
  /**
   * 执行器丢了本地状态时强制重发指派载荷（含 SOP 全量）。
   * `true` = 全部活跃单重发（未投递的旧单重新排队）；
   * `[id]` = 只重发指定单（P7d 崩溃恢复，定向且不触碰其它单的游标）。
   */
  @ApiPropertyOptional({
    oneOf: [{ type: "boolean" }, { type: "array", items: { type: "string" } }],
  })
  resendAssignments?: boolean | string[];
  @ApiPropertyOptional({ isArray: true, type: "string" })
  inflight?: string[];
}

class AgentCollabCapabilityDto {
  @ApiProperty()
  address!: string;
  /** 能力域清单（覆盖式）。接 SOP 的机器必须显式含 `agent:sop`。 */
  @ApiProperty({ isArray: true, type: "string" })
  capabilities!: string[];
  /** 富结构能力报告（可选，P7 的可行性预检用）。 */
  @ApiPropertyOptional({ type: "object", additionalProperties: true })
  report?: Record<string, unknown>;
}

class AgentCollabClarificationDto {
  @ApiProperty()
  address!: string;
  @ApiProperty({ format: "uuid" })
  assignmentId!: string;
  /** 客户端生成的幂等键（UUID）——重试重发不产生两条澄清。 */
  @ApiPropertyOptional()
  clientClarificationId?: string;
  @ApiProperty()
  question!: string;
  @ApiPropertyOptional({ type: "object", additionalProperties: true })
  context?: Record<string, unknown>;
  @ApiPropertyOptional({
    type: "object",
    additionalProperties: true,
    isArray: true,
  })
  mediaRefs?: SopClarificationMediaRef[];
  @ApiPropertyOptional()
  targetAgentSessionId?: string;
}

class AgentCollabProgressDto {
  @ApiProperty()
  address!: string;
  @ApiPropertyOptional({ type: "object", additionalProperties: true })
  progressJson?: Record<string, unknown>;
  @ApiPropertyOptional()
  targetAgentSessionId?: string;
}

class AgentCollabCompleteDto {
  @ApiProperty()
  address!: string;
  @ApiProperty({ enum: ["completed", "failed"] })
  status!: "completed" | "failed";
  @ApiPropertyOptional({ type: "object", additionalProperties: true })
  result?: Record<string, unknown>;
  /** 幂等：同 attempt 重放无害。 */
  @ApiPropertyOptional()
  attempt?: number;
}

class AgentCollabAckReplyDto {
  @ApiProperty()
  address!: string;
  @ApiProperty({ format: "uuid" })
  clarificationId!: string;
}

// @Public() + 手工机器鉴权：执行器面（非用户 JWT 面）
@Public()
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
  @Post("poll")
  @HttpCode(HttpStatus.OK)
  async poll(
    @Body() body: AgentCollabPollDto,
    @Headers("authorization") auth: string,
  ) {
    const executor = await this.authenticate(body?.address, auth);
    const requested = Number(body.waitMs ?? 0);
    const deadline =
      Number.isFinite(requested) && requested > 0
        ? Math.min(requested, POLL_MAX_WAIT_MS)
        : 0;
    const start = Date.now();

    for (;;) {
      const items = await this.sops.pollPending({
        executorId: executor.id,
        resendAssignments: body.resendAssignments === true,
      });
      if (items.length > 0 || Date.now() - start >= deadline) {
        return { items, sopPolicy: this.sopPolicy() };
      }
      await new Promise((r) => setTimeout(r, POLL_TICK_MS));
    }
  }

  /** 上报能力清单（覆盖式）。接 SOP 派发的机器在此声明 `agent:sop`。 */
  @Post("capability")
  @HttpCode(HttpStatus.OK)
  async capability(
    @Body() body: AgentCollabCapabilityDto,
    @Headers("authorization") auth: string,
  ) {
    const executor = await this.authenticate(body?.address, auth);
    const caps = Array.isArray(body.capabilities) ? body.capabilities : [];
    if (
      caps.length > 32 ||
      caps.some((c) => typeof c !== "string" || c.length > 64)
    ) {
      throw new BadRequestException(
        "capabilities 必须是 ≤32 个、每个 ≤64 字符的字符串",
      );
    }
    await this.executors.updateCapabilities(executor.id, caps);
    return { ok: true };
  }

  /** 发起澄清（P6 核心：执行器 Agent 回问）。 */
  @Post("clarifications")
  @HttpCode(HttpStatus.OK)
  async clarify(
    @Body() body: AgentCollabClarificationDto,
    @Headers("authorization") auth: string,
  ) {
    // 鉴权 + 能力闸（结果本体不入账——澄清归属由 assignmentId 决定）
    await this.authenticateAgent(body?.address, auth);
    if (!body.assignmentId || typeof body.question !== "string") {
      throw new BadRequestException("assignmentId 与 question 必填");
    }
    const { clarification, escalated } = await this.sops.ingestClarification({
      assignmentId: body.assignmentId,
      clientClarificationId: body.clientClarificationId,
      question: body.question,
      context: body.context ?? null,
      mediaRefs: body.mediaRefs ?? [],
      targetAgentSessionId: body.targetAgentSessionId ?? null,
    });
    return {
      clarificationId: clarification.clientClarificationId ?? clarification.id,
      round: clarification.round,
      escalated,
      // escalated=true 时中台不会再起 sop_review 会话——人会在通知渠道看到
    };
  }

  /** 进度心跳（存活信号，卡死判定依据）。 */
  @Post("assignments/:id/progress")
  @HttpCode(HttpStatus.OK)
  async progress(
    @Param("id") assignmentId: string,
    @Body() body: AgentCollabProgressDto,
    @Headers("authorization") auth: string,
  ) {
    const executor = await this.authenticateAgent(body?.address, auth);
    await this.sops.recordProgress({
      assignmentId,
      executorId: executor.id,
      progressJson: body.progressJson ?? null,
      targetAgentSessionId: body.targetAgentSessionId ?? null,
    });
    return { ok: true };
  }

  /** 回报完成（幂等键 attempt）。验收判定是中台 Agent 的职责，这里只落账。 */
  @Post("assignments/:id/complete")
  @HttpCode(HttpStatus.OK)
  async complete(
    @Param("id") assignmentId: string,
    @Body() body: AgentCollabCompleteDto,
    @Headers("authorization") auth: string,
  ) {
    const executor = await this.authenticateAgent(body?.address, auth);
    if (body.status !== "completed" && body.status !== "failed") {
      throw new BadRequestException("status 必须是 completed | failed");
    }
    const { accepted } = await this.sops.completeAssignment({
      assignmentId,
      executorId: executor.id,
      status: body.status,
      result: body.result ?? null,
      attempt: body.attempt,
    });
    return { accepted };
  }

  /**
   * 澄清回复 ACK（P7d 双端确认的执行器半边）。执行器把回复落盘并消费
   * （续跑循环）之后才确认；确认前该回复随每次 poll 重发（至少一次投递），
   * 执行器侧按 clarificationId 幂等去重——重复投递不产生重复消费。
   */
  @Post("assignments/:id/clarifications/ack")
  @HttpCode(HttpStatus.OK)
  async ackClarificationReply(
    @Param("id") assignmentId: string,
    @Body() body: AgentCollabAckReplyDto,
    @Headers("authorization") auth: string,
  ) {
    const executor = await this.authenticateAgent(body?.address, auth);
    if (!body?.clarificationId) {
      throw new BadRequestException("clarificationId 必填");
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
  @Post("llm")
  @HttpCode(HttpStatus.OK)
  async llmRelay(
    @Body()
    body: {
      address: string;
      messages?: Array<{ role?: string; content?: unknown }>;
      tools?: unknown;
    },
    @Headers("authorization") auth: string,
  ) {
    await this.authenticateAgent(body?.address, auth);

    const raw = Array.isArray(body?.messages) ? body.messages : [];
    if (raw.length === 0 || raw.length > 64) {
      throw new BadRequestException("messages 必须是 1..64 条");
    }
    const messages: MultimodalMessage[] = raw.map((m, i) => {
      const role = m?.role;
      if (role !== "system" && role !== "user" && role !== "assistant") {
        throw new BadRequestException(
          `messages[${i}].role 必须是 system | user | assistant`,
        );
      }
      if (typeof m?.content !== "string" || m.content.length === 0) {
        throw new BadRequestException(
          `messages[${i}].content 必须是非空字符串`,
        );
      }
      if (m.content.length > 100_000) {
        throw new BadRequestException(`messages[${i}].content 超过 100KB 上限`);
      }
      return { role, content: m.content } as MultimodalMessage;
    });
    const tools = Array.isArray(body?.tools) ? body.tools : undefined;
    if (tools && tools.length > 32) {
      throw new BadRequestException("tools 最多 32 个");
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
   * （/api/agent-collab/media/<id>）——澄清提问引用外网 URL 的门在
   * SopService.validateMediaRefs 早已关死（SSRF 转嫁面），这里给出的是
   * 平台内路径，中心侧（Qwen 视频理解）经下载端点取字节。
   *
   * 归属校验：指派必须属于该执行器（防 A 机器给 B 的工单塞证据）；
   * 状态不设限——澄清期间（blocked）正是要发截图的场景。
   */
  @Post("assignments/:id/media")
  @HttpCode(HttpStatus.CREATED)
  @UseInterceptors(FileInterceptor("file"))
  async uploadMedia(
    @Param("id") assignmentId: string,
    @Body() body: { address: string },
    @UploadedFile() file?: Express.Multer.File,
    @Headers("authorization") auth?: string,
  ) {
    const executor = await this.authenticateAgent(body?.address, auth);
    const { assignment } = await this.sops.getAssignment(assignmentId);
    if (assignment.targetExecutorId !== executor.id) {
      throw new ForbiddenException("指派不属于该执行器");
    }
    if (!file?.buffer?.length) {
      throw new BadRequestException("缺少 file 字段（multipart）");
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
  @Post("assignments/:id/candidate-package")
  @HttpCode(HttpStatus.CREATED)
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
      sopSlug?: string;
      sopVersion?: string;
      contentHash?: string;
      runtime?: string;
    },
    @UploadedFile() file?: Express.Multer.File,
    @Headers("authorization") auth?: string,
  ) {
    const executor = await this.authenticateAgent(body?.address, auth);
    const { assignment } = await this.sops.getAssignment(assignmentId);
    if (assignment.targetExecutorId !== executor.id) {
      throw new ForbiddenException("指派不属于该执行器");
    }
    if (!file?.path) {
      throw new BadRequestException("缺少 file 字段（multipart）");
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

  /** 基础机器鉴权（能力上报入口用——此时 agent:sop 可能尚未声明）。 */
  private async authenticate(address: string | undefined, auth?: string) {
    if (!address) throw new BadRequestException("address 必填");
    const executor = await this.executors.findByAddress(address);
    if (!executor) throw new NotFoundException("Executor not found");
    const ok = await this.executors.validateTokenByAddress(
      address,
      bearer(auth),
    );
    if (!ok) throw new UnauthorizedException("Invalid executor token");
    return executor;
  }

  /** 协作面鉴权 = 机器鉴权 + 显式 `agent:sop` 能力闸（11 §5.1）。 */
  private async authenticateAgent(address: string | undefined, auth?: string) {
    const executor = await this.authenticate(address, auth);
    const caps = await this.executors.getAgentCapabilities(executor.id);
    if (!caps.includes("agent:sop")) {
      throw new ForbiddenException(
        "该执行器未声明 agent:sop 能力——SOP 协作面只对显式声明的机器开放（空能力 ≠ 通用）",
      );
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
