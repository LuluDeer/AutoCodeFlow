import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Type } from "class-transformer";
import {
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from "class-validator";

/**
 * N20 成本分摊 + showback 的配额契约。
 *
 * 计量口径只有「能力激活调用次数」（capability_activation_log 的 GROUP BY），
 * 本仓没有 token 用量样本，故 **不存在 token 计费**——ROADMAP 的「模型推导
 * 窗口」因零样本推迟，这里不虚构任何 token 字段。
 */

/** system_configs 的 key 前缀：配额配置以 JSON value 落在该前缀下（无新表）。 */
export const QUOTA_KEY_PREFIX = "acf.showback.quota.";

export const QUOTA_SCOPES = ["project", "capability"] as const;
export type QuotaScope = (typeof QUOTA_SCOPES)[number];

/** 硬阈比较单位：缺省 invocations，保持旧配置逐字不变。 */
export const QUOTA_UNITS = ["invocations", "amount"] as const;
export type QuotaUnit = (typeof QUOTA_UNITS)[number];

export type QuotaStatus = "ok" | "warn" | "exceeded";

/** 落库 value（JSON）与 list/quota 端点的返回形状。 */
export interface QuotaConfig {
  scope: QuotaScope;
  target: string;
  softLimit: number;
  hardLimit: number;
  windowDays: number;
  webhookUrl?: string;
  /** 缺省 invocations；旧配置不写该字段即按调用次数硬阈判定。 */
  unit?: QuotaUnit;
  /** unit='amount' 必填：正数有限金额阈值；非金额配置忽略。 */
  amountHardLimit?: number;
}

/** quota-status 单行：usage 来自 stats，status 由 soft/hard 边界判定。 */
export interface QuotaStatusRow {
  scope: QuotaScope;
  target: string;
  softLimit: number;
  hardLimit: number;
  usage: number;
  status: QuotaStatus;
  windowDays: number;
  /** 缺省 invocations；金额闸只对显式 'amount' 行生效。 */
  unit?: QuotaUnit;
  /** 金额不可得必须是 null，绝不使用 0 兜底。 */
  amount?: number | null;
  /** 金额不可得原因（零样本 / 缺价目 / 折算失败），透传给审计 detail。 */
  priceReason?: string;
  /** 金额硬阈副本；缺席时纯函数回退到 hardLimit 以兼容直接构造的测试行。 */
  amountHardLimit?: number;
}

/** PUT /api/capability-activation/quota 的请求体。 */
export class SetQuotaDto implements QuotaConfig {
  @ApiProperty({ enum: [...QUOTA_SCOPES], description: "按项目或按能力计量" })
  @IsIn([...QUOTA_SCOPES])
  scope: QuotaScope;

  @ApiProperty({ description: "projectId 或 capabilityKey" })
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  target: string;

  @ApiProperty({
    type: Number,
    description: "软阈值：usage >= softLimit 记 warn",
  })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  softLimit: number;

  @ApiProperty({
    type: Number,
    description: "硬阈值：usage >= hardLimit 记 exceeded",
  })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  hardLimit: number;

  @ApiProperty({ type: Number, minimum: 1, maximum: 90 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(90)
  windowDays: number;

  @ApiPropertyOptional({
    description: "告警 webhook URL；缺省回落全局通知配置",
  })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  webhookUrl?: string;

  @ApiPropertyOptional({
    enum: [...QUOTA_UNITS],
    default: "invocations",
    description: "硬阈单位；缺省按调用次数，旧配置零漂移",
  })
  @IsOptional()
  @IsIn([...QUOTA_UNITS])
  unit?: QuotaUnit;

  @ApiPropertyOptional({
    type: Number,
    description: "unit='amount' 必填：正数有限金额硬阈，非金额配置忽略",
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(0)
  amountHardLimit?: number;
}

/** GET /api/capability-activation/quota-status 的查询参数。 */
export class QuotaStatusQueryDto {
  @ApiPropertyOptional({ type: Number, default: 30, minimum: 1, maximum: 90 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(90)
  windowDays?: number;
}
