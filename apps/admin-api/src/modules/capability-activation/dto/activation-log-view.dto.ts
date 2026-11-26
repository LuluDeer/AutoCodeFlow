import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import {
  ACTIVATION_RESULTS,
  ActivationResult,
} from "../entities/activation-log.entity";

/**
 * N15 / GCO §11：能力激活日志的读模型（响应 DTO）。
 *
 * activation-log.entity.ts 的实体类没有 @ApiProperty：Swagger 直接以实体为
 * POST 响应 type 时 emit 出的组件 properties 为空（check-openapi-response-schema
 * 因此变红，前端会生成 Record<string, never>）。本 DTO 逐一标注实体对用户
 * 可见的全部字段，供 record 端点的响应引用。
 *
 * 字段类型与 CapabilityActivationLog 实体保持一致，service 返回的实体在
 * TypeScript 结构类型下天然兼容，无需在 service 层做转换；controller 方法
 * 返回签名仍是 Promise<CapabilityActivationLog>。
 */
export class ActivationLogViewDto {
  @ApiProperty({ description: "激活日志 UUID", example: "c1f0...uuid" })
  id: string;

  @ApiProperty({
    description: "被激活能力的稳定 key（无 FK，能力删除后仍留存）",
    example: "finance-export",
  })
  capabilityKey: string;

  @ApiPropertyOptional({
    nullable: true,
    description: "激活时的能力版本（钉死，供 N16 归责）；NULL 表示未记录",
  })
  capabilityVersion: string | null;

  @ApiPropertyOptional({
    nullable: true,
    description: "触发的 Workbench/SOP 会话 ID；NULL 表示非会话内调用",
  })
  sessionId: string | null;

  @ApiProperty({
    description: "参数摘要 sha256 hex（明文参数永不落库）",
    example: "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
  })
  parametersDigest: string;

  @ApiPropertyOptional({
    nullable: true,
    description: "平台用户 ID；NULL 表示无平台用户身份",
  })
  userId: number | null;

  @ApiPropertyOptional({
    nullable: true,
    description: "平台用户名；NULL 表示无平台用户身份",
  })
  username: string | null;

  @ApiPropertyOptional({
    nullable: true,
    description: "IM 来源平台（与 imSenderId 成对）；NULL 表示非 IM 触发",
  })
  imPlatform: string | null;

  @ApiPropertyOptional({
    nullable: true,
    description: "IM 发送方 ID（与 imPlatform 成对）；NULL 表示非 IM 触发",
  })
  imSenderId: string | null;

  @ApiPropertyOptional({
    nullable: true,
    description: "归属项目 ID（可空 = 未分配），供按项目 showback",
  })
  projectId: string | null;

  @ApiProperty({
    enum: ACTIVATION_RESULTS,
    description: "激活结果：success | failure | blocked",
    example: "success",
  })
  result: ActivationResult;

  @ApiPropertyOptional({
    nullable: true,
    description: "N5 基线指标名；NULL 表示未采集",
  })
  baselineMetric: string | null;

  @ApiPropertyOptional({
    nullable: true,
    type: Number,
    description: "N5 相对基线的改进量 numeric(12,2)；NULL 表示未量化",
  })
  improvement: number | null;

  @ApiPropertyOptional({
    nullable: true,
    description: "N5 业务结果是否已确认；缺省落 false",
  })
  confirmed: boolean | null;

  @ApiProperty({ type: Date, description: "创建时间（ISO 8601）" })
  createdAt: Date;
}
