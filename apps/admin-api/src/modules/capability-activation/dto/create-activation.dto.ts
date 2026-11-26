import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Type } from "class-transformer";
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from "class-validator";
import { ACTIVATION_RESULTS } from "../entities/activation-log.entity";

/**
 * N15：POST /api/capability-activation 的请求体。
 *
 * `parameters` 只在此处短暂存在于内存中；service 立即做确定性摘要后**只落
 * digest**，明文不进 DB、不进响应。DTO 的字段形状校验在此，语义（摘要算法、
 * append-only 语义）在 service。
 */
export class CreateActivationDto {
  @ApiProperty({
    example: "finance-export",
    description: "能力稳定 key（1-128 位 [a-z0-9._-]，小写字母/数字起头）",
  })
  @IsString()
  @Matches(/^[a-z0-9][a-z0-9._-]{0,127}$/, {
    message: "capabilityKey must match /^[a-z0-9][a-z0-9._-]{0,127}$/",
  })
  @MaxLength(128)
  capabilityKey: string;

  @ApiPropertyOptional({ example: "2.3.1", description: "激活时的能力版本" })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  capabilityVersion?: string;

  @ApiPropertyOptional({ description: "Workbench/SOP 会话 id" })
  @IsOptional()
  @IsString()
  @MaxLength(128)
  sessionId?: string;

  @ApiPropertyOptional({
    type: "object",
    additionalProperties: true,
    description:
      "本次激活的参数（敏感数据可含其中）；只用于计算摘要，明文永不落库",
  })
  @IsOptional()
  @IsObject()
  parameters?: Record<string, unknown>;

  @ApiPropertyOptional({ description: "平台用户 id" })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  userId?: number;

  @ApiPropertyOptional({ description: "平台用户名" })
  @IsOptional()
  @IsString()
  username?: string;

  @ApiPropertyOptional({ example: "wecom", description: "IM 平台" })
  @IsOptional()
  @IsString()
  @MaxLength(16)
  imPlatform?: string;

  @ApiPropertyOptional({ description: "IM 发送方标识" })
  @IsOptional()
  @IsString()
  @MaxLength(128)
  imSenderId?: string;

  @ApiPropertyOptional({ description: "归属项目 id（showback 维度）" })
  @IsOptional()
  @IsString()
  projectId?: string;

  @ApiPropertyOptional({
    enum: [...ACTIVATION_RESULTS],
    description: "激活结果；省略时按 success 落库",
  })
  @IsOptional()
  @IsIn([...ACTIVATION_RESULTS])
  result?: (typeof ACTIVATION_RESULTS)[number];

  @ApiPropertyOptional({
    description: "N5 基线指标名（业务结果归因）；≤64 字符",
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  baselineMetric?: string;

  @ApiPropertyOptional({
    type: Number,
    description: "N5 相对基线的改进量；numeric(12,2)，≤2 位小数",
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  improvement?: number;

  @ApiPropertyOptional({
    description: "N5 业务结果是否已确认；省略时按 false 落库",
  })
  @IsOptional()
  @IsBoolean()
  confirmed?: boolean;
}
