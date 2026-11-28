/**
 * 工作台交互面：prompt-first 会话、SSE 时间线、消息续问、取消、审批处置。
 *
 * 与 `workbench.controller.ts`（方案卡 preview/commit/旧 sop_authoring 面）刻意
 * 分开——那个文件已在 size-caps 棘轮上，本文件的所有新路由都走这里。
 *
 * 权限：类级 @Roles(ADMIN, USER)；owner 校验 ADMIN 任意、USER 仅
 * createdBy ∈ {`user:<id>`, `user:<username>`}。审批 grant/deny 额外要求
 * ADMIN + 四眼；withdraw 只给会话 owner（USER 可撤回自己的待批单）。
 */
import {
  Body,
  Controller,
  Get,
  Inject,
  Ip,
  Logger,
  Optional,
  Param,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from "@nestjs/common";
import type { Request, Response } from "express";
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from "@nestjs/swagger";
import { SkipThrottle } from "@nestjs/throttler";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Roles } from "../../common/decorators/roles.decorator";
import { AppError } from "../../common/errors/app-error";
import { ErrorCode } from "../../common/errors/error-codes";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard";
import { ParseUuidShapePipe } from "../../common/pipes/parse-uuid-shape.pipe";
import { UserRole } from "../users/entities/user.entity";
import {
  CreateWorkbenchChatSessionDto,
  ConvertWorkbenchSessionToSopDto,
  DecideWorkbenchApprovalDto,
  PostWorkbenchMessageDto,
  WORKBENCH_APPROVAL_DECISIONS,
  WORKBENCH_MESSAGE_MODES,
  WorkbenchChatSessionResponseDto,
  WorkbenchSessionActionResponseDto,
  WorkbenchSessionConvertResponseDto,
  type WorkbenchApprovalDecision,
  type WorkbenchMessageMode,
} from "./dto/workbench-interactive.dto";
import {
  WORKBENCH_SESSION_INTERACTION_PORT,
  type WorkbenchSessionInteractionPort,
} from "./workbench-session-interaction.port";
import {
  WORKBENCH_CONVERT_TO_SOP,
  type WorkbenchConvertToSopPort,
} from "./workbench-convert.port";

@ApiTags("workbench")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Roles(UserRole.ADMIN, UserRole.USER)
@Controller("workbench")
export class WorkbenchSessionController {
  private readonly logger = new Logger(WorkbenchSessionController.name);

  constructor(
    @Optional()
    @Inject(WORKBENCH_SESSION_INTERACTION_PORT)
    private readonly interaction?: WorkbenchSessionInteractionPort | null,
    // 切片 E1：workbench → SOP 转写端口。@Optional 仅兼容既有「手动 new +
    // 单端口实参」的存量单测构造；生产由 WorkbenchModule useClass 接真实服务。
    @Optional()
    @Inject(WORKBENCH_CONVERT_TO_SOP)
    private readonly convertToSop?: WorkbenchConvertToSopPort | null,
  ) {}

  /** ADMIN 任意会话；USER 仅自己的（createdBy = user:<id> 或 user:<username>）。 */
  private assertOwner(
    session: { createdBy?: string | null } | null,
    user: { id: number | string; username?: string; role?: string } | undefined,
  ): void {
    if (!session) {
      // 防枚举：不存在与越权统一 404。
      throw new AppError("AGENT_SESSION_NOT_FOUND", {});
    }
    if ((user as { role?: string } | undefined)?.role === UserRole.ADMIN)
      return;
    const userId = Number(user?.id);
    const identities = [
      Number.isFinite(userId) ? `user:${userId}` : null,
      user?.username ? `user:${user.username}` : null,
    ].filter((value): value is string => value !== null);
    if (!session.createdBy || !identities.includes(session.createdBy)) {
      throw new AppError("AGENT_SESSION_NOT_FOUND", {});
    }
  }

  private requirePort(): WorkbenchSessionInteractionPort {
    if (!this.interaction) {
      throw new AppError(ErrorCode.DEPENDENCY_UNAVAILABLE, {});
    }
    return this.interaction;
  }

  private requireConvert(): WorkbenchConvertToSopPort {
    if (!this.convertToSop) {
      throw new AppError(ErrorCode.DEPENDENCY_UNAVAILABLE, {});
    }
    return this.convertToSop;
  }

  /**
   * prompt-first 创建会话：不要求先 preview/commit SOP。
   * 服务端钉死 triggerSource=workbench，kind 从 prompt 推导；首条 user
   * AgentStep 由 sendMessageAndResume 落库并同步入队（不重复写、不重复入队）。
   */
  @Post("chat-sessions")
  @ApiOperation({
    summary: "发起工作台对话会话（prompt-first，无需先提交 SOP）",
    description:
      "以一句 prompt 直接创建 Agent 会话并将该 prompt 作为首条用户消息落库、入 agent-jobs 队列。会话类型由服务端从 prompt 推导（对话/起草 SOP/受限计划），请求体不能指定 kind/scope/createdBy/triggerSource。",
  })
  @ApiCreatedResponse({ type: WorkbenchChatSessionResponseDto })
  async createChatSession(
    @Body() dto: CreateWorkbenchChatSessionDto,
    @CurrentUser() user: { id: number | string; username?: string } | undefined,
  ): Promise<WorkbenchChatSessionResponseDto> {
    const port = this.requirePort();
    const userId = Number(user?.id);
    if (!Number.isFinite(userId)) {
      throw new AppError(ErrorCode.USER_NOT_FOUND, {});
    }
    const prompt = String(dto.prompt ?? "").trim();
    if (!prompt) {
      throw new AppError(ErrorCode.VALIDATION_FAILED, {
        detail: "prompt 不能为空",
      });
    }
    // kind 由服务端从 prompt 推导——DTO 已不声明该字段，whitelist 会剥除/拒绝客户端自报。
    const kind = inferWorkbenchSessionKind(prompt);
    const identity = `user:${userId}`;
    const created = await port.createSession({
      kind,
      title: dto.title?.trim() || clip(prompt, 60),
      createdBy: identity,
      triggerSource: "workbench",
      context: {
        prompt,
        ...(dto.context && Object.keys(dto.context).length > 0
          ? { extra: dto.context }
          : {}),
      },
      scope: {},
    });
    await port.sendMessage({
      sessionId: created.id,
      content: prompt,
      mode: "followup",
      actor: identity,
    });
    this.logger.log(
      JSON.stringify({
        event: "workbench.chat_session.created",
        sessionId: created.id,
        kind,
        createdBy: identity,
      }),
    );
    return {
      sessionId: created.id,
      status: created.status,
      kind,
      initialStepPersisted: true,
    };
  }

  /**
   * SSE 时间线：ticket（JWT 策略已放行）或 bearer 登录，owner 校验后委托
   * streamSession（含 fromSeq 断线续传、AbortSignal 取消）。
   */
  @SkipThrottle()
  @Get("sessions/:id/stream")
  @ApiOperation({
    description:
      "会话事件 SSE 流。EventSource 无法设置请求头时，可先 POST /auth/sse-ticket 换取 30 秒短效票据，再用 ?ticket= 建流；也支持常规 Authorization: Bearer。断线可用 ?fromSeq= 从上一次事件序号续传。仅会话创建者或管理员可读。",
    summary: "工作台会话事件时间线 SSE 流",
  })
  @ApiQuery({
    name: "ticket",
    required: false,
    description: "SSE 专用短效票据（30 秒）",
  })
  @ApiQuery({
    name: "fromSeq",
    required: false,
    description: "从该事件序号之后开始推送（断线续传）",
  })
  @ApiOkResponse({
    description: "Server-Sent Events 事件流",
    content: { "text/event-stream": { schema: { type: "string" } } },
  })
  async streamSession(
    @Param("id", ParseUuidShapePipe) id: string,
    @Query("fromSeq") fromSeq: string | undefined,
    @Req() req: Request,
    @Res() res: Response,
    @CurrentUser() user: { id: number | string; username?: string } | undefined,
  ): Promise<void> {
    const port = this.requirePort();
    const session = await port.findById(id);
    this.assertOwner(session, user);
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders?.();
    const ac = new AbortController();
    req.on("close", () => ac.abort());
    await port.streamSession({
      sessionId: id,
      fromSeq: parseFromSeq(fromSeq),
      res,
      signal: ac.signal,
    });
  }

  /** 追加用户消息：write 语义复用 sendMessageAndResume（唯一写入口）。 */
  @Post("sessions/:id/messages")
  @ApiOperation({
    summary: "向工作台会话追加用户消息并恢复执行",
    description:
      "正文落为 role=user 的 AgentStep；运行中的会话走 step 边界注入，挂起的会话重新入队。仅会话创建者或管理员可调用。",
  })
  @ApiOkResponse({ type: WorkbenchSessionActionResponseDto })
  async postMessage(
    @Param("id", ParseUuidShapePipe) id: string,
    @Body() dto: PostWorkbenchMessageDto,
    @CurrentUser() user: { id: number | string; username?: string } | undefined,
  ): Promise<WorkbenchSessionActionResponseDto> {
    const port = this.requirePort();
    const session = await port.findById(id);
    this.assertOwner(session, user);
    const content = String(dto.content ?? "").trim();
    if (!content) {
      throw new AppError(ErrorCode.VALIDATION_FAILED, {
        detail: "content 不能为空",
      });
    }
    const mode: WorkbenchMessageMode = dto.mode ?? "followup";
    if (!(WORKBENCH_MESSAGE_MODES as readonly string[]).includes(mode)) {
      throw new AppError(ErrorCode.VALIDATION_FAILED, { detail: "mode 非法" });
    }
    try {
      await port.sendMessage({
        sessionId: id,
        content,
        mode,
        actor: `user:${Number(user?.id)}`,
      });
    } catch (err: unknown) {
      // 终态会话追加消息：stream agent 返回 action='rejected_terminal'，适配层
      // 如实上抛 reason；这里必须回 ok:false（此前吞掉后回 ok:true 是假成功）。
      // 按判别字段识别而非 instanceof：port 的门禁不要求 controller 值 import 适配器
      // （适配器链拖着 Nest 重依赖，会撞内存替身单测的 ESM 装载）。
      const rejected = err as {
        action?: unknown;
        reason?: unknown;
      } | null;
      if (rejected && rejected.action === "rejected_terminal") {
        return {
          ok: false,
          sessionId: id,
          action: "rejected_terminal",
          reason: String(rejected.reason ?? "会话已处于终态，不能继续追加消息"),
        };
      }
      throw err;
    }
    return { ok: true, sessionId: id };
  }

  /** 取消会话：请求中止（ cooperative abort，不伪造终态）。 */
  @Post("sessions/:id/cancel")
  @ApiOperation({
    summary: "请求中止工作台会话",
    description:
      "向正在运行的会话发出协作式中止请求；是否命中由会话运行态决定。仅创建者或管理员可调用。",
  })
  @ApiOkResponse({ type: WorkbenchSessionActionResponseDto })
  async cancelSession(
    @Param("id", ParseUuidShapePipe) id: string,
    @CurrentUser() user: { id: number | string; username?: string } | undefined,
  ): Promise<WorkbenchSessionActionResponseDto> {
    const port = this.requirePort();
    const session = await port.findById(id);
    this.assertOwner(session, user);
    const cancelled = await port.requestAbort(id, `user:${Number(user?.id)}`);
    return { ok: cancelled, sessionId: id };
  }

  /**
   * 切片 E1（workbench→SOP 直连）：把一个 commit 锚定的工作台会话转写为
   * 业务人名下的新 SOP 草稿（slug 由 goal 归一化；title=卡 title；
   * body = goal + cadence + 会话步骤 + acceptance；front-matter 走
   * buildDraftPayloadFromCard 草稿档契约）。
   *
   * 校验链全部在服务端（fail-closed）：会话存在+归属（404 防枚举）→
   * commit 锚点齐全（409 WORKBENCH_CONVERT_NO_COMMIT）→ 重建 cardHash 与
   * 锚点一致（409 WORKBENCH_CONVERT_CARD_DRIFT）→ 该 sop 的 sop_publish
   * 审批单已 consumed（409 WORKBENCH_CONVERT_APPROVAL_NOT_CONSUMED）。
   * 转换只产 draft——绝不调用 publish，发布与指派仍走 SOP 页人工闸。
   */
  @Post("sessions/:id/convert-to-sop")
  @ApiOperation({
    summary: "把工作台会话转写为 SOP 草稿（不发布）",
    description:
      "校验会话归属、commit 锚点与发布审批 consumed 后，将方案卡与会话步骤固化为一份新的 SOP 草稿（归属当前用户）。" +
      "返回 slug/sopId/deeplink；发布与指派仍需管理员在 SOP 页人工完成。未提交方案卡、卡片漂移或审批未 consumed 一律 409。",
  })
  @ApiCreatedResponse({ type: WorkbenchSessionConvertResponseDto })
  async convertSessionToSop(
    @Param("id", ParseUuidShapePipe) id: string,
    @Body() dto: ConvertWorkbenchSessionToSopDto,
    @CurrentUser()
    user: { id: number | string; username?: string; role?: string } | undefined,
    @Ip() ip?: string,
  ): Promise<WorkbenchSessionConvertResponseDto> {
    const convert = this.requireConvert();
    const result = await convert.convert({
      sessionId: id,
      user,
      cadence: dto.cadence,
      ...(dto.params !== undefined ? { params: dto.params } : {}),
      ip: ip ?? null,
    });
    this.logger.log(
      JSON.stringify({
        event: "workbench.convert_to_sop.request",
        sessionId: id,
        sopId: result.sopId,
        slug: result.slug,
      }),
    );
    return result;
  }

  /**
   * 审批处置：grant/deny 需 ADMIN 且非自批；withdraw 只允许 owner USER 撤回
   * 待批单。三种动作都会 resume 会话（由端口实现负责 settle 台账 + 入队）。
   */
  @Post("sessions/:id/approvals/:approvalKey/decide")
  @ApiOperation({
    summary: "处置工作台会话的审批单",
    description:
      "grant/deny 仅管理员可用且受四眼原则约束（申请人不可批准自己发起的操作）；withdraw 允许会话创建者撤回自己的待批单。三种处置都会恢复会话执行。",
  })
  @ApiOkResponse({ type: WorkbenchSessionActionResponseDto })
  async decideApproval(
    @Param("id", ParseUuidShapePipe) id: string,
    @Param("approvalKey") approvalKey: string,
    @Body() dto: DecideWorkbenchApprovalDto,
    @CurrentUser()
    user: { id: number | string; username?: string; role?: string } | undefined,
  ): Promise<WorkbenchSessionActionResponseDto> {
    const port = this.requirePort();
    const session = await port.findById(id);
    const decision: WorkbenchApprovalDecision = dto.decision;
    if (
      !(WORKBENCH_APPROVAL_DECISIONS as readonly string[]).includes(decision)
    ) {
      throw new AppError(ErrorCode.VALIDATION_FAILED, {
        detail: "decision 非法",
      });
    }
    // withdraw 是创建者撤回自己的待批单 ⇒ 走 owner 校验；
    // grant/deny 是审批动作 ⇒ 审批人按定义不是创建者（四眼），不能先做 owner 校验。
    if (decision === "withdraw") this.assertOwner(session, user);
    const isAdmin =
      (user as { role?: string } | undefined)?.role === UserRole.ADMIN;
    if (decision !== "withdraw" && !isAdmin) {
      // AppError（禁裸内置异常，check:error-migration）：403 原型保持 instanceof 兼容，
      // 同时带出稳定错误码供前端按用户语言渲染。
      throw new AppError(ErrorCode.WORKBENCH_APPROVAL_DECISION_ADMIN_ONLY, {});
    }
    // 四眼原则：创始人（session.createdBy）不能批准自己的待批单。
    // createdBy 在仓内有两种口径（user:<id> / user:<username>），两种都要挡。
    // 用 AppError 而非裸 ForbiddenException：403 原型仍保持 instanceof 兼容，
    // 同时带出 AGENT_APPROVAL_SELF_DENIED 错误码，与 agent 主线 / 适配层同口径。
    if (decision === "grant") {
      const numericId = Number(user?.id);
      const selfIdentities = [
        Number.isFinite(numericId) ? `user:${numericId}` : null,
        user?.username ? `user:${user.username}` : null,
      ].filter((value): value is string => value !== null);
      if (session?.createdBy && selfIdentities.includes(session.createdBy)) {
        throw new AppError("AGENT_APPROVAL_SELF_DENIED");
      }
    }
    const applied = await port.decideApproval({
      sessionId: id,
      approvalKey,
      decision,
      actor: `user:${Number(user?.id)}`,
      username: String(user?.username ?? ""),
    });
    // applied=false = 审批单不存在/会话不匹配/已处置：如实回 ok:false，
    // 不再无条件 ok:true 伪造一次成功处置（区分「真的处置了」与「没处置」）。
    // 端口布尔现在只表示「处置已落库」，不再携带 resumed 语义——不伪造 resumed。
    return { ok: applied, sessionId: id };
  }
}

/** prompt 推导会话类型的纯函数：包含 SOP 意图走起草、含计划意图走 plan，否则 chat。 */
export function inferWorkbenchSessionKind(
  prompt: string,
): "chat" | "sop_authoring" | "plan" {
  const text = String(prompt ?? "").toLowerCase();
  if (/sop|草稿|起草|流程文档/.test(text)) return "sop_authoring";
  if (/计划|方案|规划|拆解步骤/.test(text)) return "plan";
  return "chat";
}

function clip(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

function parseFromSeq(raw?: string): number | undefined {
  if (raw === undefined || raw === "") return undefined;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 0 ? value : undefined;
}
