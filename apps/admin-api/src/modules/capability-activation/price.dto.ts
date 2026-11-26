import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Type } from "class-transformer";
import {
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
  MinLength,
} from "class-validator";

/**
 * N20 成本归责第二步：managed 价目表契约。
 *
 * 价目以 JSON value 落 system_configs 的 `acf.showback.price.` 前缀，**零迁移**：
 * 与 quota.service.ts 的 `acf.showback.quota.` 同一写模式，不新增表/实体/迁移。
 *
 * 诚实口径：零 token 样本、缺价目、坏价目一律产出金额=null + 明确的 reason，
 * 绝不用 0 元顶替「未知」。金额只做 token×单价折算，不做任何份额伪分摊。
 */

/** system_configs 的价目 key 前缀。 */
export const PRICE_KEY_PREFIX = "acf.showback.price.";

export const PRICE_DIRECTIONS = ["in", "out"] as const;
export type PriceDirection = (typeof PRICE_DIRECTIONS)[number];

/** 金额折算的判定理由；null↔非 OK 由纯函数强制保证。 */
export type PriceReason =
  | "OK"
  | "NO_TOKEN_SAMPLE"
  | "PRICE_MISSING"
  | "INVALID_TOKEN_COUNT"
  | "INVALID_PRICE";

/** 可计费的 token 样本：两边都是收敛后的非负有限数。 */
export interface TokenSample {
  tokensIn: number;
  tokensOut: number;
}

/** 落库 value 与读面形状：每百万 token 单价，币种为 3 字母代码。 */
export interface PricingConfig {
  provider: string;
  model: string;
  direction: PriceDirection;
  pricePerMillionTokens: number;
  currency: string;
}

/** 金额投影：amount=null 是「金额不可得」，不是 0 元。 */
export interface AmountProjection {
  amount: number | null;
  currency: string | null;
  reason: PriceReason;
  basis: "per-million-tokens";
  tokensIn: number;
  tokensOut: number;
  note: string;
}

/** PUT 价目配置的请求体（控制器接线由主控负责，本切片只提供契约）。 */
export class SetPriceDto implements PricingConfig {
  @ApiProperty({ description: "模型提供方标识" })
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  provider: string;

  @ApiProperty({ description: "模型标识" })
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  model: string;

  @ApiProperty({ enum: [...PRICE_DIRECTIONS], description: "输入或输出 token" })
  @IsIn([...PRICE_DIRECTIONS])
  direction: PriceDirection;

  @ApiProperty({
    type: Number,
    description: "每百万 token 单价，必须为正的有限数",
  })
  @Type(() => Number)
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(Number.MIN_VALUE)
  pricePerMillionTokens: number;

  @ApiProperty({ description: "3 字母币种代码，如 CNY / USD" })
  @IsString()
  @Matches(/^[A-Za-z]{3}$/)
  currency: string;

  /** 预留给控制器的可选备注；不影响落库 value 形状。 */
  @ApiPropertyOptional({ description: "价目备注（不参与金额折算）" })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}
