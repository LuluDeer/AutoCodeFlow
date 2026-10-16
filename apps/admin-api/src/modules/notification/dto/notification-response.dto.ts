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
    additionalProperties: { type: "string" },
    description: "通道专属配置；读取时凭据值会被掩码",
  })
  config: Record<string, string>;

  @ApiProperty()
  description: string;
}

/** 逐通道投递状态（test/send 回执的 results 值域）。 */
export type ChannelDeliveryStatus = "sent" | "blocked" | "failed" | "skipped";

/** POST /notification/channels/{key}/test 与 POST /notification/test 的回执。 */
export class ChannelTestResponseDto {
  @ApiProperty({ description: "当所有目标通道都失败/跳过时为 false" })
  success: boolean;

  @ApiProperty()
  message: string;

  @ApiPropertyOptional({
    additionalProperties: {
      type: "string",
      enum: ["sent", "blocked", "failed", "skipped"],
    },
    description: "逐通道投递状态",
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
    nullable: true,
    format: "uuid",
    description: "scope=task 时生效",
  })
  taskId: string | null;

  @ApiProperty({
    nullable: true,
    format: "uuid",
    description: "scope=application 时生效",
  })
  applicationId: string | null;

  @ApiProperty({
    nullable: true,
    description: "空 = 所有级别；否则 info/warning/critical 等 AlertLevel",
  })
  level: string | null;

  @ApiProperty({ nullable: true })
  reason: string | null;

  @ApiProperty({ nullable: true })
  startTime: Date | null;

  @ApiProperty({
    nullable: true,
    description: "空 = 不过期；durationMinutes 写入时折算",
  })
  endTime: Date | null;

  @ApiProperty({ nullable: true })
  durationMinutes: number | null;

  @ApiProperty({ nullable: true })
  createdBy: string | null;

  @ApiProperty()
  createdAt: Date;
}
