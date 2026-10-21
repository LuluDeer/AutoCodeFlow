import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
// R150-A1: 渠道 id 的单一事实源（与 send-notification.dto.ts 同源导入）。
import { AlertChannel } from "../notification.service";

/**
 * ARCH-23 / N-12（2026-10-07 A1 批）：通知配置域（tag "Notification Config"）
 * 响应契约。通道密钥值在读面恒掩码（config 值可能含 webhook secret/token）。
 */

/**
 * 通知通道配置行（key 是固定枚举：email/slack/dingtalk/wecom/webhook/feishu）。
 *
 * R150-A1（出站面审计 · 轴3）：这里的 swagger enum 曾是**手写第四份**渠道清单，
 * NF-05 加 feishu 后没人同步——openapi/api-types 因此少一个渠道，而
 * AlertChannel 才是单一事实源。改为直接从枚举派生，漂移不再可能。
 */
export class NotificationChannelDto {
  @ApiProperty({ enum: Object.values(AlertChannel) })
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
  // R32-A2: 描述与实现对齐——实现是「任一路非 'sent' 即 false」（skipped
  // 也算未投递：渠道已启用但没解析到 URL/凭据，零次尝试）。旧文案只说
  // "所有目标通道都失败/跳过"，读者会以为部分 skipped 仍是成功。
  @ApiProperty({
    description:
      "仅当每一个请求的渠道都真的投递成功（'sent'）时为 true；任一路为 'blocked'/'failed'/'skipped' 都是 false，逐通道结果见 results",
  })
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
