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
    description: "Request accepted; NOT equivalent to every channel delivering",
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
      "Per-channel delivery result: 'sent' delivered; 'blocked' rejected by " +
      "the SSRF guard (private/loopback/link-local/benchmark/CGNAT target); " +
      "'failed' transport error after retries; 'skipped' channel not " +
      "configured (no saved config and no env default).",
  })
  results: Record<string, ChannelDeliveryStatus>;
}
