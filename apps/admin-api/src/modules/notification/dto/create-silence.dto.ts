import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import {
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from "class-validator";
import { SILENCE_SCOPES } from "../entities/notification-silence.entity";

/**
 * P3-5（2026-10-25 审计，PK-19 收尾）：POST /notification/silences 的请求体
 * class DTO。
 *
 * 演进：PK-19 只补了 @ApiBody 文档（本类无装饰器、运行时 @Body() 仍是内联
 * 对象类型——metatype=Object 使全局 whitelist/forbidNonWhitelisted 对本面
 * 整体跳过，多余字段静默收下，破坏全站校验纪律）。本轮把校验器搬到 DTO：
 * scope/level/channelType 与 silenceService.create 的校验器**同口径**
 * （枚举三处同源：实体 SILENCE_SCOPES / 本 DTO / service 白名单，漂移由
 * service 侧与 outbound-audit-r150.spec 的钉子兜住），长度上限对齐
 * notification_silences 建表列宽（迁移 1789100000000），durationMinutes
 * 上限对齐 service 的 MAX_SILENCE_DURATION_MINUTES（P3-1）。
 *
 * service.create 的内部校验保持不动——它是 NotificationService 等内部调用
 * 方的唯一闸，本 DTO 只服务 API 面（fast 400 + 恢复 whitelist 纪律）。
 */
export class CreateSilenceDto {
  @ApiProperty({
    enum: SILENCE_SCOPES,
    example: "task",
    description: "静默范围：global=全渠道；task=单任务；application=单应用",
  })
  @IsIn(SILENCE_SCOPES as unknown as string[])
  scope: (typeof SILENCE_SCOPES)[number];

  @ApiPropertyOptional({
    description:
      "仅作范围记录（isSilenced 在渠道扇出前判定，无法按渠道裁剪投递，NETOPT-5① 如实化）；取值须为已注册渠道类型",
    maxLength: 32,
  })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  channelType?: string;

  @ApiPropertyOptional({ description: "scope=task 时必填：任务 UUID" })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  taskId?: string;

  @ApiPropertyOptional({ description: "scope=application 时必填：应用 UUID" })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  applicationId?: string;

  @ApiPropertyOptional({
    enum: ["info", "warning", "error", "critical"],
    description: "仅静默该级别（精确匹配，非「及以下」）；空 = 全部级别",
  })
  @IsOptional()
  @IsIn(["info", "warning", "error", "critical"])
  level?: string;

  @ApiPropertyOptional({
    description: "静默原因（审计记录用）",
    maxLength: 255,
  })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  reason?: string;

  @ApiPropertyOptional({
    example: 60,
    description:
      "静默时长（分钟，1..5256000=10 年）；缺省走系统默认 TTL（P3-1 上界）",
    minimum: 1,
    maximum: 5256000,
  })
  @IsOptional()
  @IsNumber()
  @Min(1)
  // P3-1: 1e15 这类值此前穿透到 endTime 折算（durationMinutes * 60_000 溢出
  // → Invalid Date → save 失败 500）。上界取 10 年分钟数（5256000），与
  // service 侧 MAX_SILENCE_DURATION_MINUTES 同源。
  @Max(5256000)
  durationMinutes?: number;
}
