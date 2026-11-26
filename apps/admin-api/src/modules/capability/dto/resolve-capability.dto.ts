import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Type } from "class-transformer";
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsObject,
  IsOptional,
  IsString,
  ValidateNested,
} from "class-validator";

/**
 * ADR-040 / P1：resolve 请求体的**形态**校验。
 *
 * 语义校验（key 必须已注册、层数 1-8、每层 config 为纯对象、fieldRules 取值合法、
 * semanticLayers 的 semantic 取值与层形态）一律落在 CapabilityService——单测以内存
 * repo 直接调 service，判据必须住在那里。
 */
export const FIELD_RULE_VALUES = [
  "replace",
  "keyMerge",
  "append",
  "replaceIfSameKey",
  "policyTighten",
] as const;

export type FieldRuleValue = (typeof FIELD_RULE_VALUES)[number];

/** 四语义取值，与 scope-engine 的 PolicySemantic 同口径（单一来源）。 */
export const POLICY_SEMANTIC_VALUES = [
  "override",
  "restrict",
  "fallback",
  "rules",
] as const;

export type PolicySemanticValue = (typeof POLICY_SEMANTIC_VALUES)[number];

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

/** 带语义标签的策略层：四语义求值只用于 decision，不参与配置合并。 */
export class SemanticPolicyLayerDto {
  @ApiProperty({
    example: "managed",
    description: "语义策略层名；数组按高→低排列",
  })
  @IsString()
  name: string;

  @ApiProperty({
    enum: [...POLICY_SEMANTIC_VALUES],
    description:
      "本层与已解析上层的合并语义：override 同名替换 / restrict 的 deny 单调锁定 / fallback 仅上层无命中时生效 / rules 与上层取更紧",
  })
  @IsIn(POLICY_SEMANTIC_VALUES)
  semantic: PolicySemanticValue;

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

  @ApiPropertyOptional({
    type: [SemanticPolicyLayerDto],
    description:
      "可选四语义策略层，1-8 层；传入时 decision 由 scope-engine 的 evaluateAll 判定，effective 仍按 fieldRules 合并；省略则沿用旧 evaluatePolicy 判定",
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(8)
  @IsOptional()
  @ValidateNested({ each: true })
  @Type(() => SemanticPolicyLayerDto)
  semanticLayers?: SemanticPolicyLayerDto[];
}

/** N9：resolve / dump 响应共用的可达性降级字段（均为可选，旧响应不变）。 */
export class CapabilityDegradationDto {
  @ApiPropertyOptional({
    enum: ["direct", "x11+fromVideo", "unknown"],
    description:
      "能力可达性降级编排标记：direct 直连、x11+fromVideo 走 X11 桌面与录屏转写、unknown 为 fail-closed",
  })
  degradePath?: "direct" | "x11+fromVideo" | "unknown";

  @ApiPropertyOptional({
    example: "unreachable:x11+fromVideo",
    description: "降级原因提示，格式为「可达性分级:降级编排标记」",
  })
  degradationHint?: string;
}

/** N9：POST /api/capabilities/resolve 响应契约（追加可选降级字段）。 */
export class CapabilityResolutionResponseDto extends CapabilityDegradationDto {
  @ApiProperty({ example: "browser", description: "已注册的 capability key" })
  key: string;

  @ApiProperty({
    type: "object",
    additionalProperties: true,
    description: "按字段族规则合并后的生效配置",
  })
  effective: Record<string, unknown>;

  @ApiProperty({
    type: "object",
    additionalProperties: true,
    description: "以 capability key 为资源的策略结论",
  })
  decision: Record<string, unknown>;
}

/** N9：GET /api/capabilities/:key/dump 响应契约（追加可选降级字段）。 */
export class CapabilityDumpResponseDto extends CapabilityDegradationDto {
  @ApiProperty({ example: "browser", description: "已注册的 capability key" })
  key: string;

  @ApiProperty({
    type: "array",
    items: { type: "object" },
    description: "分层来源 / 生效值 / 来源层的三栏审计行",
  })
  dump: unknown[];
}
