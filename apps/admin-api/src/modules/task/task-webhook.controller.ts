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
    summary: "通过入站 Webhook 触发任务",
    description:
      "公开的机器调用端点。需要 X-AutoCodeFlow-Timestamp 与 " +
      "X-Hub-Signature-256 请求头；签名是用该任务的 Webhook 密钥对 " +
      "`${timestamp}.${rawBody}` 计算的 HMAC-SHA256（可通过 " +
      "POST /api/tasks/:id/webhook/enable 启用）。请求体 `{ params }` 会覆盖该任务" +
      "本次执行的默认参数。可加 `?wait=1&timeout=N` 让请求停驻到执行进入终态（N ≤ " +
      WEBHOOK_WAIT_MAX_SECONDS +
      " 秒；超时则返回 `completed:false` 及最新快照）。任务不存在 / Webhook " +
      "未启用 / 签名错误一律返回相同的 401。",
  })
  @ApiParam({ name: "taskId", description: "任务 UUID" })
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
