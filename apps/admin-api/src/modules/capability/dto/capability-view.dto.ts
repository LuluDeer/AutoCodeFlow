import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import {
  CapabilityScope,
  CapabilitySource,
} from "../entities/capability.entity";

/**
 * ADR-040 / P1：Capability 的读模型（响应 DTO）。
 *
 * capability.entity.ts 的实体类没有 @ApiProperty：Swagger 直接以实体为
 * response type 时 emit 出的组件 properties 为空（check-openapi-response-schema
 * selftest 因此变红，前端会生成 Record<string, never>）。本 DTO 逐一标注
 * 实体对用户可见的全部字段，供 list/create/update 三个端点的响应引用。
 *
 * 字段类型与 Capability 实体保持一致，service 返回的实体在 TypeScript
 * 结构类型下天然兼容，无需在 service 层做转换。
 */
export class CapabilityViewDto {
  @ApiProperty({ description: "capability UUID", example: "c1f0...uuid" })
  id: string;

  @ApiProperty({
    description: "稳定标识（小写字母/数字起头的 1-128 位）",
    example: "browser",
  })
  key: string;

  @ApiProperty({
    description: "能力类型：skill | mcp | agent | provider | template",
    example: "skill",
  })
  kind: string;

  @ApiProperty({ description: "展示名", example: "Browser" })
  label: string;

  @ApiPropertyOptional({
    nullable: true,
    description: "能力说明；NULL 表示未提供",
  })
  description: string | null;

  @ApiProperty({ description: "语义化版本", example: "1.0.0" })
  version: string;

  @ApiProperty({
    type: Object,
    description: "来源：{ type: builtin | registry | git | folder, ref? }",
    example: { type: "builtin" },
  })
  source: CapabilitySource;

  @ApiProperty({
    description: "可见范围：global | project | private",
    example: "private",
  })
  visibility: string;

  @ApiProperty({
    type: Object,
    description:
      "作用域：{ mode: managed | supervised | self_service, guidance: L1 | L2 | L3 }",
    example: { mode: "supervised", guidance: "L2" },
  })
  scope: CapabilityScope;

  @ApiProperty({
    type: "object",
    additionalProperties: true,
    description: "能力声明（封闭键集合，禁止可执行字段）",
  })
  manifest: Record<string, unknown>;

  @ApiProperty({ description: "是否启用", example: true })
  enabled: boolean;

  @ApiPropertyOptional({
    nullable: true,
    description: "创建人身份键（user:<id>|<username>）；NULL = 系统/迁移写入",
  })
  createdBy: string | null;

  @ApiProperty({ type: Date, description: "创建时间（ISO 8601）" })
  createdAt: Date;

  @ApiProperty({ type: Date, description: "更新时间（ISO 8601）" })
  updatedAt: Date;
}
