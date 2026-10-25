import {
  IsArray,
  IsIn,
  IsOptional,
  IsString,
} from "class-validator";
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
 * F-53（UIAUDIT 后端轮 P2-2）：POST /notification/test（admin 全渠道测试扇出）
 * 的请求体 class DTO。此前控制器用内联类型 `{ channels: string[]; title:
 * string; content: string }`（metatype=Object，全局 ValidationPipe 跳过）——
 * 任意多余字段被静默收下，「多余字段必 400」的全站纪律在这一面失效。
 *
 * 校验面对齐同文件 SendNotificationDto 的既有口径：channels 走 AlertChannel
 * 取值域白名单（service 的 switch 对未知渠道本就静默跳过，DTO 先拦住比静默
 * 跳过诚实）；title/content 维持**必填**（与 service sendTest 签名和旧内联
 * 类型逐字一致，翻译为 class DTO 不放宽也不收紧），只钉类型不设长度上限——
 * 本模块对通知文案无既有长度契约（SendNotificationDto 同样无），发明出上限
 * 反而会对既有调用方引入新的 400（滥用面由全局 body 1MB + ADMIN-only 兜住）。
 */
export class SendTestDto {
  @ApiProperty({
    type: [String],
    enum: Object.values(AlertChannel),
    description: "要扇出的渠道（取值域 = 已注册渠道枚举）",
  })
  @IsArray()
  @IsString({ each: true })
  @IsIn(Object.values(AlertChannel), { each: true })
  channels: string[];

  @ApiProperty({ description: "测试通知标题" })
  @IsString()
  title: string;

  @ApiProperty({ description: "测试通知内容" })
  @IsString()
  content: string;
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
