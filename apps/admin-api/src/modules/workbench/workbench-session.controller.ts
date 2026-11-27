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
  ForbiddenException,
  Get,
  Inject,
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
  DecideWorkbenchApprovalDto,
  PostWorkbenchMessageDto,
  WORKBENCH_APPROVAL_DECISIONS,
  WORKBENCH_MESSAGE_MODES,
  WorkbenchChatSessionResponseDto,
  WorkbenchSessionActionResponseDto,
  type WorkbenchApprovalDecision,
  type WorkbenchMessageMode,
} from "./dto/workbench-interactive.dto";
import {
  WORKBENCH_SESSION_INTERACTION_PORT,
  type WorkbenchSessionInteractionPort,
} from "./workbench-session-interaction.port";

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
    if ((user as { role?: string } | undefined)?.role === UserRole.ADMIN) return;
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
      throw new AppError(ErrorCode.VALIDATION_FAILED, { detail: "prompt 不能为空" });
    }
    const kind = dto.kind ?? inferWorkbenchSessionKind(prompt);
    const identity = `user:${userId}`;
    const created = await port.createSession({
      kind,
      title: dto.title?.trim() || clip(prompt, 60),
      createdBy: identity,
      triggerSource: "workbench",
      context: {
        prompt,
        ...(dto.context && Object.keys(dto.context).length > 0 ? { extra: dto.context } : {}),
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
  @ApiQuery({ name: "ticket", required: false, description: "SSE 专用短效票据（30 秒）" })
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
      throw new AppError(ErrorCode.VALIDATION_FAILED, { detail: "content 不能为空" });
    }
    const mode: WorkbenchMessageMode = dto.mode ?? "followup";
    if (!(WORKBENCH_MESSAGE_MODES as readonly string[]).includes(mode)) {
      throw new AppError(ErrorCode.VALIDATION_FAILED, { detail: "mode 非法" });
    }
    await port.sendMessage({
      sessionId: id,
      content,
      mode,
      actor: `user:${Number(user?.id)}`,
    });
    return { ok: true, sessionId: id };
  }

  /** 取消会话：请求中止（ cooperative abort，不伪造终态）。 */
  @Post("sessions/:id/cancel")
  @ApiOperation({
    summary: "请求中止工作台会话",
    description: "向正在运行的会话发出协作式中止请求；是否命中由会话运行态决定。仅创建者或管理员可调用。",
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
    if (!(WORKBENCH_APPROVAL_DECISIONS as readonly string[]).includes(decision)) {
      throw new AppError(ErrorCode.VALIDATION_FAILED, { detail: "decision 非法" });
    }
    // withdraw 是创建者撤回自己的待批单 ⇒ 走 owner 校验；
    // grant/deny 是审批动作 ⇒ 审批人按定义不是创建者（四眼），不能先做 owner 校验。
    if (decision === "withdraw") this.assertOwner(session, user);
    const isAdmin = (user as { role?: string } | undefined)?.role === UserRole.ADMIN;
    if (decision !== "withdraw" && !isAdmin) {
      throw new ForbiddenException("只有管理员可以批准或拒绝审批单");
    }
    // 四眼原则：创始人（session.createdBy）不能批准自己的待批单。
    // createdBy 在仓内有两种口径（user:<id> / user:<username>），两种都要挡。
    if (decision === "grant") {
      const numericId = Number(user?.id);
      const selfIdentities = [
        Number.isFinite(numericId) ? `user:${numericId}` : null,
        user?.username ? `user:${user.username}` : null,
      ].filter((value): value is string => value !== null);
      if (session?.createdBy && selfIdentities.includes(session.createdBy)) {
        throw new ForbiddenException("不可批准自己发起的操作（四眼原则）");
      }
    }
    const resumed = await port.decideApproval({
      sessionId: id,
      approvalKey,
      decision,
      actor: `user:${Number(user?.id)}`,
      username: String(user?.username ?? ""),
    });
    return { ok: true, sessionId: id, resumed };
  }

}

/** prompt 推导会话类型的纯函数：包含 SOP 意图走起草、含计划意图走 plan，否则 chat。 */
export function inferWorkbenchSessionKind(prompt: string): "chat" | "sop_authoring" | "plan" {
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
