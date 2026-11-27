/**
 * Agent 会话实时交互 HTTP 面（SSE 流 / 追加消息 / 中断）。
 *
 * 与 agent.controller.ts 分开注册：那个文件已在 size-caps 棘轮基线顶格，新增
 * 路由放这里。权限与它一致——class 级 JwtAuthGuard + @Roles(ADMIN)。
 * SSE 使用 @Res() library mode 直写（不能改成 @Sse()/Observable：那会绕过
 * 直写语义，且全局 ResponseInterceptor 的 envelope 无法正确渲染流）。
 *
 * SSE 票据校验沿用 JwtStrategy 既有逻辑：`?ticket=` 只进 DTO 白名单，真正的
 * 校验发生在 passport-jwt 提取与 `assertTicketOnlyOnStreamPath` 中，路径已在
 * SSE_TICKET_PATH_PATTERNS 放行。
 */
import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from "@nestjs/common";
import { SkipThrottle } from "@nestjs/throttler";
import type { Request, Response } from "express";
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiTags,
} from "@nestjs/swagger";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard";
import { Roles } from "../../common/decorators/roles.decorator";
import { SkipTimeout } from "../../common/decorators/skip-timeout.decorator";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import type { AuthUser } from "../../common/interfaces/auth-user.interface";
import { ParseUuidShapePipe } from "../../common/pipes/parse-uuid-shape.pipe";
import { UserRole } from "../users/entities/user.entity";
import { AgentEventStreamService } from "./runtime/agent-event-stream.service";
import {
  AgentCancelResponseDto,
  AgentMessageDto,
  AgentMessageResponseDto,
  AgentStreamQueryDto,
} from "./dto/agent-interaction.dto";

@ApiTags("Agent")
@ApiBearerAuth("JWT")
@UseGuards(JwtAuthGuard)
@Roles(UserRole.ADMIN)
@Controller("agent")
export class AgentInteractionController {
  constructor(private readonly stream: AgentEventStreamService) {}

  @Get("sessions/:id/stream")
  @ApiOperation({
    summary: "Agent 会话事件 SSE 流",
    description:
      "按 seq 重放持久事件后转入实时推送：先发 synced 边界帧，再有 token/reasoning/tool_call/phase/status 增量帧；每 15 秒发送心跳注释帧。断线重连传 fromSeq 从上次的 seq 续传，队列溢出时收到 resync_required 后应主动重连。",
  })
  @ApiParam({ name: "id", description: "会话 ID", format: "uuid" })
  @ApiQuery({ name: "ticket", required: false, type: String, description: "SSE 建连专用短效票据，仅用于鉴权，不参与事件查询" })
  @ApiQuery({ name: "fromSeq", required: false, type: Number, description: "断点续传起点：只推送 seq 大于该值的事件，缺省从头开始" })
  @ApiOkResponse({
    description: "SSE 事件流（Res 直写，Content-Type: text/event-stream）",
    content: { "text/event-stream": { schema: { type: "string" } } },
  })
  @SkipTimeout()
  @SkipThrottle()
  async streamSession(
    @Param("id", ParseUuidShapePipe) id: string,
    @Query() query: AgentStreamQueryDto,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const ac = new AbortController();
    req.on("close", () => ac.abort());
    await this.stream.streamSession(id, {
      fromSeq: query?.fromSeq,
      res,
      signal: ac.signal,
    });
  }

  @Post("sessions/:id/messages")
  @ApiOperation({
    summary: "追加用户消息并续跑 Agent 会话",
    description:
      "持久化一条 user 步（正文服务端统一脱敏）后，按会话状态注入运行中的步边界（steered）或转 pending 重新入队 agent-jobs（enqueued）。会话仍有未处置审批单时不自动恢复，消息以 steer 形式等待处置。",
  })
  @ApiParam({ name: "id", description: "会话 ID", format: "uuid" })
  @ApiCreatedResponse({
    type: AgentMessageResponseDto,
    description: "消息写入与续跑结果",
  })
  async postMessage(
    @Param("id", ParseUuidShapePipe) id: string,
    @Body() dto: AgentMessageDto,
    @CurrentUser() user: AuthUser,
  ): Promise<AgentMessageResponseDto> {
    return this.stream.sendMessageAndResume(id, {
      content: dto.content,
      mode: dto.mode,
      actor: user?.username ?? "unknown",
    });
  }

  @Post("sessions/:id/cancel")
  @ApiOperation({
    summary: "取消（中止）Agent 会话",
    description:
      "DB 条件写把非终态会话置为 aborted（幂等，不覆盖已有结论），并通过 Redis 与本地事件通道通知正在运行的 worker 停止；终态会话保持原状态，aborted 字段返回 false。",
  })
  @ApiParam({ name: "id", description: "会话 ID", format: "uuid" })
  @ApiOkResponse({
    type: AgentCancelResponseDto,
    description: "取消结果（含是否真的改变了状态）",
  })
  async cancel(
    @Param("id", ParseUuidShapePipe) id: string,
    @CurrentUser() user: AuthUser,
  ): Promise<AgentCancelResponseDto> {
    return this.stream.requestAbort(id, user?.username ?? "unknown");
  }
}
