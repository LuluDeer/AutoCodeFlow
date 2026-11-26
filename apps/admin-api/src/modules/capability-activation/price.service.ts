import { Injectable, Logger } from "@nestjs/common";
import { AppError } from "../../common/errors/app-error";
import { ErrorCode } from "../../common/errors/error-codes";
import { SystemConfigService } from "../config/config.service";
import {
  PRICE_DIRECTIONS,
  PRICE_KEY_PREFIX,
  type AmountProjection,
  type PriceDirection,
  type PriceReason,
  type PricingConfig,
  type SetPriceDto,
} from "./price.dto";

/**
 * N20 成本归责第二步：managed 价目表 + 金额折算纯函数。
 *
 * 价目落在 system_configs（key 前缀 acf.showback.price.，valueType='json'），
 * 与配额表同一模式，零迁移、零新表。PriceService 只负责配置的读写与校验；
 * convertToAmount 是零依赖纯函数，按 token×单价折算，绝不按份额伪分摊。
 *
 * 诚实第一：零 token 样本 / 缺价目 / 坏价目一律 amount=null + 明确 reason，
 * 绝不把「未知」写成 0 元。
 */

/** 金额 note：如实声明口径与不可得语义，供 stats / 看板原样透出。 */
export const AMOUNT_NOTE =
  "金额按 token×每百万 token 单价折算；无 token 样本、缺价目或坏价目时金额为空（不是 0 元），不做份额伪分摊。";

const TOKENS_PER_MILLION = 1_000_000;
const CURRENCY_RE = /^[A-Za-z]{3}$/;

/** 稳定码校验失败：与 quota.service.ts 同一错误码与 detail 风格。 */
const invalid: (detail: string) => never = (detail: string): never => {
  throw new AppError(ErrorCode.VALIDATION_FAILED, { detail });
};

/** 价目在 system_configs 的 key：前缀 + provider/model/direction（点分）。 */
export function priceKey(
  provider: string,
  model: string,
  direction: PriceDirection,
): string {
  return `${PRICE_KEY_PREFIX}${provider}.${model}.${direction}`;
}

/** 折算入参 prices 的索引 key（斜分）：`${provider}/${model}/${direction}`。 */
export function priceIndexKey(
  provider: string,
  model: string,
  direction: PriceDirection,
): string {
  return `${provider}/${model}/${direction}`;
}

/** 把价目数组扁平成 convertToAmount 消费的 key→config 映射。 */
export function toPriceMap(
  configs: readonly PricingConfig[],
): Record<string, PricingConfig> {
  const map: Record<string, PricingConfig> = {};
  for (const cfg of configs) {
    map[priceIndexKey(cfg.provider, cfg.model, cfg.direction)] = cfg;
  }
  return map;
}

/**
 * 金额投影的运行时不变量：amount===null ⇔ reason!=='OK'。
 * 违反即抛错（不是静默修正），让任何「零样本变 0 元」的回退立刻转红。
 */
export function assertAmountProjectionInvariant(
  projection: AmountProjection,
): void {
  const amountIsNull = projection.amount === null;
  const reasonIsOk = projection.reason === "OK";
  if (amountIsNull === reasonIsOk) {
    throw new Error(
      `金额投影不变量被破坏：amount=${String(projection.amount)} reason=${projection.reason}`,
    );
  }
}

function project(
  reason: PriceReason,
  amount: number | null,
  currency: string | null,
  tokensIn: number,
  tokensOut: number,
): AmountProjection {
  const result: AmountProjection = {
    amount,
    currency,
    reason,
    basis: "per-million-tokens",
    tokensIn,
    tokensOut,
    note: AMOUNT_NOTE,
  };
  assertAmountProjectionInvariant(result);
  return result;
}

/**
 * token 收敛：null/undefined 与有限非正数 → 0（与 safeTokenCount 的生产口径一致），
 * NaN/Infinity/非 number 是损坏样本 → null，交调用方判 INVALID_TOKEN_COUNT。
 */
function convergeToken(value: unknown): number | null {
  if (value === null || value === undefined) return 0;
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return value > 0 ? value : 0;
}

function pricingConfigDetail(cfg: unknown): string | null {
  if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) {
    return "价目配置必须是对象";
  }
  const c = cfg as Partial<PricingConfig>;
  if (typeof c.provider !== "string" || c.provider.trim() === "") {
    return "价目 provider 必须是非空字符串";
  }
  if (typeof c.model !== "string" || c.model.trim() === "") {
    return "价目 model 必须是非空字符串";
  }
  if (!PRICE_DIRECTIONS.includes(c.direction as PriceDirection)) {
    return "价目 direction 必须是 in 或 out";
  }
  if (
    typeof c.pricePerMillionTokens !== "number" ||
    !Number.isFinite(c.pricePerMillionTokens) ||
    c.pricePerMillionTokens <= 0
  ) {
    return "价目 pricePerMillionTokens 必须是正的有限数";
  }
  if (typeof c.currency !== "string" || !CURRENCY_RE.test(c.currency)) {
    return "价目 currency 必须是 3 字母代码";
  }
  return null;
}

/** 显式 provider/model 优先；省略时只允许价目表里恰好一组 provider/model。 */
function resolveIdentity(
  prices: Readonly<Record<string, PricingConfig>>,
  provider?: string,
  model?: string,
): { provider: string; model: string } | null {
  const explicitProvider =
    typeof provider === "string" && provider.trim() !== "";
  const explicitModel = typeof model === "string" && model.trim() !== "";
  if (explicitProvider && explicitModel) {
    return { provider: provider as string, model: model as string };
  }
  if (provider !== undefined || model !== undefined) return null;

  const pairs = new Set<string>();
  for (const key of Object.keys(prices)) {
    const parts = key.split("/");
    if (parts.length !== 3) continue;
    const [p, m, d] = parts;
    if (!p || !m || (d !== "in" && d !== "out")) continue;
    pairs.add(`${p}\u0000${m}`);
  }
  if (pairs.size !== 1) return null;
  const [pair] = [...pairs];
  const separator = pair.indexOf("\u0000");
  return {
    provider: pair.slice(0, separator),
    model: pair.slice(separator + 1),
  };
}

/**
 * 金额折算纯函数（零 Nest / 零 DB / 零 I/O）。
 *
 * 入参 token 为 null 或有限非正数时收敛为 0；两边都为 0 → NO_TOKEN_SAMPLE，
 * amount=null（绝不 0 元）。只在确有 token 的方向上要求价目：缺 key →
 * PRICE_MISSING，价目字段非法 → INVALID_PRICE；只有全部齐备才按
 * Σ(tokens/1e6×price) 折算，保留 6 位小数，currency 取价目值。
 * 两侧币种不一致视为坏价目（INVALID_PRICE），不把不同币种相加。
 *
 * key 形如 `${provider}/${model}/${direction}`；provider/model 可由第 4/5 参数
 * 显式传入，也可省略并在价目表里恰好只有一组 provider/model 时推断。
 */
export function convertToAmount(
  tokensIn: number | null | undefined,
  tokensOut: number | null | undefined,
  prices: Readonly<Record<string, PricingConfig>>,
  provider?: string,
  model?: string,
): AmountProjection {
  const inCount = convergeToken(tokensIn);
  const outCount = convergeToken(tokensOut);

  if (inCount === null || outCount === null) {
    return project(
      "INVALID_TOKEN_COUNT",
      null,
      null,
      inCount ?? 0,
      outCount ?? 0,
    );
  }
  if (inCount <= 0 && outCount <= 0) {
    return project("NO_TOKEN_SAMPLE", null, null, inCount, outCount);
  }

  const identity = resolveIdentity(prices, provider, model);
  if (!identity) {
    return project("PRICE_MISSING", null, null, inCount, outCount);
  }

  const needed: { direction: PriceDirection; tokens: number }[] = [];
  if (inCount > 0) needed.push({ direction: "in", tokens: inCount });
  if (outCount > 0) needed.push({ direction: "out", tokens: outCount });

  const configs: PricingConfig[] = [];
  for (const { direction } of needed) {
    const cfg = prices[
      priceIndexKey(identity.provider, identity.model, direction)
    ] as PricingConfig | undefined;
    if (!cfg) {
      return project("PRICE_MISSING", null, null, inCount, outCount);
    }
    if (pricingConfigDetail(cfg) !== null || cfg.direction !== direction) {
      return project("INVALID_PRICE", null, null, inCount, outCount);
    }
    configs.push(cfg);
  }
  if (configs.some((cfg) => cfg.currency !== configs[0].currency)) {
    return project("INVALID_PRICE", null, null, inCount, outCount);
  }

  const raw = needed.reduce(
    (sum, entry, index) =>
      sum +
      (entry.tokens / TOKENS_PER_MILLION) *
        configs[index].pricePerMillionTokens,
    0,
  );
  const amount = Number(raw.toFixed(6));
  return project("OK", amount, configs[0].currency, inCount, outCount);
}

/** Managed 价目配置的读写面：JSON value + valueType='json'，坏 JSON fail-open。 */
@Injectable()
export class PriceService {
  private readonly logger = new Logger(PriceService.name);

  constructor(private readonly config: SystemConfigService) {}

  /** 写前强校验：坏配置不得落库。 */
  async set(dto: SetPriceDto): Promise<PricingConfig> {
    const cfg: PricingConfig = {
      provider: dto.provider,
      model: dto.model,
      direction: dto.direction,
      pricePerMillionTokens: dto.pricePerMillionTokens,
      currency: dto.currency,
    };
    const detail = pricingConfigDetail(cfg);
    if (detail !== null) invalid(detail);

    await this.config.upsert({
      key: priceKey(cfg.provider, cfg.model, cfg.direction),
      value: JSON.stringify(cfg),
      description: `N20 showback price: ${cfg.provider}/${cfg.model}/${cfg.direction}`,
      valueType: "json",
    });
    return cfg;
  }

  /** 单条读：不存在或读取异常一律返回 null（缺价目不是 0 元）。 */
  async get(
    provider: string,
    model: string,
    direction: PriceDirection,
  ): Promise<PricingConfig | null> {
    const key = priceKey(provider, model, direction);
    try {
      const row = await this.config.findOne(key);
      return this.parseConfig(row?.value, key);
    } catch (err: unknown) {
      this.logger.warn(
        `[showback] 价目 ${key} 读取失败：${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return null;
    }
  }

  /** 前缀读：坏 JSON / 坏字段只跳过本行并 warn，不让一条脏配置击穿看板。 */
  async getByPrefix(
    prefix: string = PRICE_KEY_PREFIX,
  ): Promise<PricingConfig[]> {
    const rows = await this.config.getByPrefix(prefix);
    const result: PricingConfig[] = [];
    for (const row of rows) {
      const cfg = this.parseConfig(row.value, row.key);
      if (cfg !== null) result.push(cfg);
    }
    return result;
  }

  /** 删除一条价目；沿用 SystemConfigService.remove 的历史/审计语义。 */
  async remove(
    provider: string,
    model: string,
    direction: PriceDirection,
  ): Promise<{ deleted: boolean }> {
    if (typeof provider !== "string" || provider.trim() === "") {
      invalid("价目 provider 必须是非空字符串");
    }
    if (typeof model !== "string" || model.trim() === "") {
      invalid("价目 model 必须是非空字符串");
    }
    if (!PRICE_DIRECTIONS.includes(direction)) {
      invalid("价目 direction 必须是 in 或 out");
    }
    return this.config.remove(priceKey(provider, model, direction));
  }

  private parseConfig(
    value: string | null | undefined,
    key: string,
  ): PricingConfig | null {
    try {
      const parsed: unknown = JSON.parse(value ?? "null");
      const detail = pricingConfigDetail(parsed);
      if (detail !== null) {
        this.logger.warn(`[showback] 价目 ${key} 跳过：${detail}`);
        return null;
      }
      return parsed as PricingConfig;
    } catch {
      this.logger.warn(`[showback] 价目 ${key} JSON 损坏，跳过`);
      return null;
    }
  }
}
