import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";

/**
 * PK-19（DEEP_REVIEW 0ef3bbe）: POST /notification/silences 的请求体 Swagger 文档 DTO。
 *
 * 本类**仅用于 openapi schema 生成**——控制器 @Body() 仍用内联对象类型（metatype =
 * Object，ValidationPipe 不 whitelist）。不挂 class-validator 装饰器，校验由
 * silenceService.create 内部完成，避免运行时行为漂移。
 */
export class CreateSilenceDto {
  @ApiProperty({
    enum: ["global", "task", "application"],
    description: "静默范围：global=全渠道；task=单任务；application=单应用",
    example: "task",
  })
  scope: "global" | "task" | "application";

  @ApiPropertyOptional({ description: "仅静默该渠道类型（wechat/dingtalk/slack/email）；空 = 全部渠道" })
  channelType?: string;

  @ApiPropertyOptional({ description: "scope=task 时必填：任务 UUID" })
  taskId?: string;

  @ApiPropertyOptional({ description: "scope=application 时必填：应用 UUID" })
  applicationId?: string;

  @ApiPropertyOptional({ description: "仅静默该级别及以下（info/warning/error/critical）；空 = 全部级别" })
  level?: string;

  @ApiPropertyOptional({ description: "静默原因（审计记录用）" })
  reason?: string;

  @ApiPropertyOptional({ description: "静默时长（分钟）；缺省走系统默认 TTL", example: 60 })
  durationMinutes?: number;
}
