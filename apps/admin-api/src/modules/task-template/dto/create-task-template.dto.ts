import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import {
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from "class-validator";

/**
 * CORE-03：创建自定义任务模板的请求体。
 *
 * `config` 的结构合法性（是否为合法 CreateTaskDto 子集）在 service 层用
 * `assertValidTaskTemplateConfig` 走一遍 CreateTaskDto 的 validator——本 DTO
 * 只保证它是个对象；值域、枚举、cron 正则等复用既有 DTO 语义，避免二次定义。
 */
export class CreateTaskTemplateDto {
  @ApiProperty({ description: "模板展示名", example: "每日订单同步" })
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  name: string;

  @ApiPropertyOptional({ description: "模板说明（可选）" })
  @IsString()
  @IsOptional()
  @MaxLength(500)
  description?: string;

  @ApiPropertyOptional({
    description: "粗分类标签（备份/巡检/同步/清理/通知…），前端渲染为 Tag",
  })
  @IsString()
  @IsOptional()
  @MaxLength(32)
  category?: string;

  @ApiPropertyOptional({
    description:
      "稳定标识；缺省由 name 规整生成。官方模板保留 [a-z][a-z0-9_-]* 命名风格。",
    example: "daily_order_sync",
  })
  @IsString()
  @IsOptional()
  @Matches(/^[a-z0-9][a-z0-9_-]{0,63}$/i, {
    message: "key must be 1-64 chars of [A-Za-z0-9_-] starting with alnum",
  })
  key?: string;

  @ApiProperty({
    description: "合法 CreateTaskDto 子集（省略 name）；作为实例化任务的默认值",
    type: "object",
    additionalProperties: true,
    example: {
      triggerType: "cron",
      cronExpression: "0 2 * * *",
      runtime: "shell",
      entrypoint: "backup.sh",
      timeoutSeconds: 3600,
      maxRetry: 3,
      retryDelay: 60,
      blockStrategy: "discard",
    },
  })
  @IsObject()
  config: Record<string, unknown>;
}
