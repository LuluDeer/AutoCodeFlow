import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Type } from "class-transformer";
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsObject,
  IsOptional,
  IsString,
  ValidateNested,
} from "class-validator";

/**
 * ADR-040 / P1：resolve 请求体的**形态**校验。
 *
 * 语义校验（key 必须已注册、层数 1-8、每层 config 为纯对象、fieldRules 取值合法）
 * 一律落在 CapabilityService——单测以内存 repo 直接调 service，判据必须住在那里。
 */
export const FIELD_RULE_VALUES = [
  "replace",
  "keyMerge",
  "append",
  "replaceIfSameKey",
  "policyTighten",
] as const;

export type FieldRuleValue = (typeof FIELD_RULE_VALUES)[number];

export class ResolveLayerDto {
  @ApiProperty({
    example: "managed",
    description: "层名；数组按高→低排列，如 managed / project / private",
  })
  @IsString()
  name: string;

  @ApiProperty({
    type: "object",
    additionalProperties: true,
    description: "该层的原始配置（纯对象）",
  })
  @IsObject()
  config: Record<string, unknown>;
}

export class ResolveCapabilityDto {
  @ApiProperty({ example: "browser", description: "已注册的 capability key" })
  @IsString()
  key: string;

  @ApiProperty({
    type: [ResolveLayerDto],
    description: "高→低排列的配置层，1-8 层",
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(8)
  @ValidateNested({ each: true })
  @Type(() => ResolveLayerDto)
  layers: ResolveLayerDto[];

  @ApiPropertyOptional({
    type: "object",
    additionalProperties: { enum: [...FIELD_RULE_VALUES] },
    description: "字段族规则表；省略则使用 service 的默认规则表",
  })
  @IsObject()
  @IsOptional()
  fieldRules?: Record<string, FieldRuleValue>;
}
