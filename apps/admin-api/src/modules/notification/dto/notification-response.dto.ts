import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";

/**
 * ARCH-23 / N-12（2026-10-07 A1 批）：通知配置域（tag "Notification Config"）
 * 响应契约。通道密钥值在读面恒掩码（config 值可能含 webhook secret/token）。
 */

/** 通知通道配置行（key 是固定枚举：email/slack/dingtalk/wecom/webhook）。 */
export class NotificationChannelDto {
  @ApiProperty({ enum: ["email", "slack", "dingtalk", "wecom", "webhook"] })
  key: string;

  @ApiProperty()
  name: string;

  @ApiProperty()
  enabled: boolean;

  @ApiProperty({
    description:
      "Channel-specific settings; credential values are masked on read",
    additionalProperties: { type: "string" },
  })
  config: Record<string, string>;

  @ApiProperty()
  description: string;
}

/** 逐通道投递状态（test/send 回执的 results 值域）。 */
export type ChannelDeliveryStatus = "sent" | "blocked" | "failed" | "skipped";

/** POST /notification/channels/{key}/test 与 POST /notification/test 的回执。 */
export class ChannelTestResponseDto {
  @ApiProperty({
    description: "false when all addressed channels failed/skipped",
  })
  success: boolean;

  @ApiProperty()
  message: string;

  @ApiPropertyOptional({
    description: "Per-channel delivery status",
    additionalProperties: {
      type: "string",
      enum: ["sent", "blocked", "failed", "skipped"],
    },
  })
  results?: Record<string, ChannelDeliveryStatus>;
}

/** notification_silences 行（静默规则）。 */
export class NotificationSilenceDto {
  @ApiProperty({ format: "uuid" })
  id: string;

  @ApiProperty({ enum: ["global", "task", "application"] })
  scope: "global" | "task" | "application";

  @ApiProperty({ nullable: true })
  channelType: string | null;

  @ApiProperty({
    description: "scope=task 时生效",
    nullable: true,
    format: "uuid",
  })
  taskId: string | null;

  @ApiProperty({
    description: "scope=application 时生效",
    nullable: true,
    format: "uuid",
  })
  applicationId: string | null;

  @ApiProperty({
    description: "空 = 所有级别；否则 info/warning/critical 等 AlertLevel",
    nullable: true,
  })
  level: string | null;

  @ApiProperty({ nullable: true })
  reason: string | null;

  @ApiProperty({ nullable: true })
  startTime: Date | null;

  @ApiProperty({
    description: "空 = 不过期；durationMinutes 写入时折算",
    nullable: true,
  })
  endTime: Date | null;

  @ApiProperty({ nullable: true })
  durationMinutes: number | null;

  @ApiProperty({ nullable: true })
  createdBy: string | null;

  @ApiProperty()
  createdAt: Date;
}
