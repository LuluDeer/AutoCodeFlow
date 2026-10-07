import {
  Body,
  Controller,
  Headers,
  HttpCode,
  Ip,
  Param,
  Post,
  Query,
  Req,
} from "@nestjs/common";
import {
  ApiBody,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiTags,
  ApiOkResponse,
} from "@nestjs/swagger";
import type { Request } from "express";
import { Throttle } from "@nestjs/throttler";
import { Public } from "../../common/decorators/public.decorator";
import { WriteGuard } from "../../common/decorators/write-guard.decorator";
import {
  WEBHOOK_SIGNATURE_HEADER,
  WEBHOOK_TIMESTAMP_HEADER,
} from "../../common/utils/webhook-hmac.util";
import { WEBHOOK_THROTTLE } from "../../config/throttle-profiles";
import { TriggerTaskDto } from "./dto/trigger-task.dto";
import {
  TaskWebhookService,
  WEBHOOK_WAIT_DEFAULT_SECONDS,
  WEBHOOK_WAIT_MAX_SECONDS,
} from "./task-webhook.service";
import { TaskWebhookTriggerResponseDto } from "../auth/dto/misc-response.dto";

/**
 * FEAT-21: 任务 webhook 入站触发端点（公开机器面）。
 *
 * 与 applications / alerts webhook 同一安全范式：@Public + per-task secret
 * HMAC 校验（签名纪律见 common/utils/webhook-hmac.util）。请求体与
 * POST /tasks/:id/trigger 同形（{ params }），params 覆盖任务默认参数
 * 落到本次执行；`?wait=1` 切同步等待模式——HTTP 挂起到执行终态或超时
 * （timeout ≤ {MAX}s），响应带执行结果白名单视图（无日志大对象）。
 *
 * 非 wait 模式返回 200 + execution 行（与手动触发同语义：入队即返回）。
 */
@ApiTags("Task Webhooks")
@Controller("webhooks/tasks")
export class TaskWebhookController {
  constructor(private readonly webhookService: TaskWebhookService) {}

  @Public()
  @WriteGuard("task-webhook", {
    scope: "public",
    reason:
      "任务 webhook 入站触发端点，凭 per-task secret 做 HMAC 校验（FEAT-21）",
  })
  @Throttle({ default: WEBHOOK_THROTTLE })
  @HttpCode(200)
  @Post(":taskId")
  @ApiOperation({
    summary: "Trigger a task via inbound webhook",
    description:
      "Public machine endpoint. Requires X-AutoCodeFlow-Timestamp and " +
      "X-Hub-Signature-256 headers; the signature is HMAC-SHA256 over " +
      "`${timestamp}.${rawBody}` with the task's webhook secret (enable via " +
      "POST /api/tasks/:id/webhook/enable). Body `{ params }` overrides the " +
      "task's default params for this execution. Add `?wait=1&timeout=N` to " +
      "park the request until the execution reaches a terminal state (N ≤ " +
      WEBHOOK_WAIT_MAX_SECONDS +
      "s; on timeout `completed:false` plus the latest snapshot). Unknown " +
      "task / disabled webhook / bad signature all answer the same 401.",
  })
  @ApiParam({ name: "taskId", description: "Task UUID" })
  @ApiQuery({
    name: "wait",
    required: false,
    description: "'1'/'true' = 同步等待终态（缺省入队即返回）",
  })
  @ApiQuery({
    name: "timeout",
    required: false,
    description: `wait 模式超时秒数（1-${WEBHOOK_WAIT_MAX_SECONDS}，缺省 ${WEBHOOK_WAIT_DEFAULT_SECONDS}）`,
  })
  @ApiBody({ type: TriggerTaskDto })
  @ApiOkResponse({ type: TaskWebhookTriggerResponseDto })
  async trigger(
    @Param("taskId") taskId: string,
    @Body() dto: TriggerTaskDto,
    @Headers(WEBHOOK_SIGNATURE_HEADER) signature?: string,
    @Headers(WEBHOOK_TIMESTAMP_HEADER) timestamp?: string,
    @Query("wait") wait?: string,
    @Query("timeout") timeout?: string,
    @Ip() ip?: string,
    @Req() req?: Request & { rawBody?: Buffer },
  ) {
    const wantsWait = wait === "1" || wait === "true" || wait === "yes";
    let timeoutSeconds: number | undefined;
    if (wantsWait && timeout !== undefined && timeout !== "") {
      const parsed = Number(timeout);
      if (!Number.isFinite(parsed) || parsed < 1) {
        timeoutSeconds = WEBHOOK_WAIT_DEFAULT_SECONDS;
      } else {
        timeoutSeconds = Math.min(Math.floor(parsed), WEBHOOK_WAIT_MAX_SECONDS);
      }
    }
    return this.webhookService.triggerFromWebhook(taskId, dto, {
      rawBody: req?.rawBody,
      signature,
      timestamp,
      wait: wantsWait,
      timeoutSeconds,
      ip: ip ?? req?.ip ?? null,
      userAgent: req?.headers?.["user-agent"] ?? null,
    });
  }
}
