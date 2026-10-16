import { IsArray, IsIn, IsOptional, IsString } from "class-validator";
import { ApiProperty } from "@nestjs/swagger";
import { AlertChannel, AlertLevel } from "../notification.service";
import { ChannelDeliveryStatus } from "../channels/base.channel";

/**
 * N22: body for POST /api/notification/send — the task-side reporting entry
 * used by the autocodeflow-notify SDK. Field set mirrors what the SDK posts
 * (title/content/level/channels/taskId) plus the taskName/webhookUrl shape.
 */
export class SendNotificationDto {
  @ApiProperty({ required: false, enum: AlertLevel, default: AlertLevel.INFO })
  @IsOptional()
  @IsIn(Object.values(AlertLevel))
  level?: AlertLevel;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  taskName?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  title?: string;

  @ApiProperty()
  @IsString()
  content: string;

  @ApiProperty({ required: false, type: [String], enum: AlertChannel })
  @IsOptional()
  @IsArray()
  @IsIn(Object.values(AlertChannel), { each: true })
  channels?: AlertChannel[];

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  webhookUrl?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  taskId?: string;
}

/**
 * V2 (round-7): response body of POST /api/notification/send. The endpoint
 * keeps 2xx semantics (notification failures must never 500 a task callback),
 * but reports the per-channel delivery outcome so callers can detect SSRF
 * blocks ("blocked") and send errors ("failed") without reading server logs.
 */
export class SendNotificationResultDto {
  @ApiProperty({
    example: true,
    description: "请求已受理；**不**等同于各通道均已投递成功",
  })
  success: boolean;

  @ApiProperty({
    type: "object",
    additionalProperties: {
      type: "string",
      enum: ["sent", "blocked", "failed", "skipped"],
    },
    example: {
      email: "sent",
      slack: "blocked",
      webhook: "failed",
      wecom: "skipped",
    },
    description:
      "逐通道投递结果：'sent' 已投递；'blocked' 被 SSRF 防护拒绝（目标为内网/环回/链路本地/benchmark/CGNAT）；'failed' 重试后仍传输失败；'skipped' 通道未配置（既无保存的配置也无环境变量缺省值）。",
  })
  results: Record<string, ChannelDeliveryStatus>;
}
