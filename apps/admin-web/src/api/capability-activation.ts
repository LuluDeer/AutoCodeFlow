import { client } from './client';
import type { components, operations } from '../types/generated/api-types';

/**
 * GET /api/capability-activation/stats 的返回结构（对齐 admin-api
 * capability-activation.service.ts 的 ActivationStats）——前端只做只读聚合展示。
 */

/** 单个能力的激活次数与成功 / 失败 / 拦截三态分布。 */
export interface ActivationStatsEntry {
  capabilityKey: string;
  count: number;
  success: number;
  failure: number;
  blocked: number;
}

/** 项目维度聚合：projectId 为空表示这次激活未归属任何项目。 */
export interface ActivationProjectStat {
  projectId: string | null;
  count: number;
}

/** 成本归责：金额不可得时 amount/currency 为 null 且 reason 非 OK（绝不显示 0 元）。 */
export type PriceReason =
  | 'OK'
  | 'NO_TOKEN_SAMPLE'
  | 'PRICE_MISSING'
  | 'INVALID_TOKEN_COUNT'
  | 'INVALID_PRICE';

export interface ActivationStatsDualBasis {
  basis: string;
  invocations: number;
  successfulDeliveries: number;
  skipped: number;
  note: string;
  tokenSample: { tokensIn: number; tokensOut: number } | null;
  currencyValue: number | null;
  priceReason: PriceReason;
  allocationNote: string;
  byCapability: Array<{ capabilityKey: string } & Record<string, unknown>>;
  byProject: Array<{ projectId: string | null } & Record<string, unknown>>;
}

/** 时间窗内的总量、按能力与按项目两张聚合表。 */
export interface ActivationStats {
  total: number;
  byCapability: ActivationStatsEntry[];
  byProject: ActivationProjectStat[];
  /** 成本归责双口径；零样本/缺价目时金额位为 null + reason（诚实标缺） */
  dualBasis?: ActivationStatsDualBasis;
}

/**
 * 用量统计：client 的 baseURL 已含 /api（见 api/client.ts），故只写相对路径；
 * 响应信封已由 client 解包，这里直接拿到 ActivationStats。
 * from / to 为可选的 ISO 时间字符串，缺省时后端按全量统计。
 */
export function getActivationStats(
  from?: string,
  to?: string,
): Promise<ActivationStats> {
  return client.get<ActivationStats>('/capability-activation/stats', {
    params: { from, to },
  });
}

/**
 * GET /api/capability-activation/quota-status 的查询参数。
 * 从 generated 的 operation 派生，避免 query 契约漂移（windowDays 1..90）。
 */
export type QuotaStatusQuery = NonNullable<
  operations['CapabilityActivationController_quotaStatus']['parameters']['query']
>;

export type QuotaScope = 'project' | 'capability';
export type QuotaUnit = 'invocations' | 'amount';
export type QuotaStatusLevel = 'ok' | 'warn' | 'exceeded';

/**
 * quota-status 单行。generated 目前只暴露 operation（响应 content 为 never），
 * 且 SetQuotaDto schema 尚未含 unit/amountHardLimit，故按 admin-api DTO 手写本行面，
 * 字段名逐一对齐；amountNote 为主控补充的可选中文说明，缺席时前端自行解释 priceReason。
 *
 * 金额不可得时 amount 必须是 null/undefined，绝不能按 0 回退（显示层同理）。
 */
export interface QuotaStatusRow {
  scope: QuotaScope;
  target: string;
  softLimit: number;
  hardLimit: number;
  usage: number;
  status: QuotaStatusLevel;
  windowDays: number;
  unit?: QuotaUnit;
  amount?: number | null;
  /** 主控/后端可能透出的币种；没有就不猜测货币符号。 */
  currency?: string;
  priceReason?: string;
  amountNote?: string;
  amountHardLimit?: number;
}

/**
 * 配额状态：client baseURL 已含 /api，只写相对路径。
 * windowDays 恒随请求下发（缺省 30），便于测试与审计都看到实际时间窗。
 */
export function getQuotaStatus(windowDays = 30): Promise<QuotaStatusRow[]> {
  const params: QuotaStatusQuery = { windowDays };
  return client.get<QuotaStatusRow[]>('/capability-activation/quota-status', {
    params,
  });
}

// ─── Showback token pricing ──────────────────────────────────────────────────
// N20 成本线：价目表读写面。generated 已含 SetPriceDto（PUT 请求体），但
// listPrices/setPrice 的响应 content 在 OpenAPI 里为 never——读面形状直接
// 从同一 schema 派生（去掉后端不落库的 note），不新增手写视图类型，避免
// web-type-drift 棘轮 + 合同字段漂移。

/** PUT /capability-activation/price 的请求体（合同派生，字段随生成物更新）。 */
export type SetPriceDto = components['schemas']['SetPriceDto'];

/** 价目单行（= SetPriceDto 去掉仅请求侧的可选 note；后端 PricingConfig 同形）。 */
export type PricingConfig = Omit<components['schemas']['SetPriceDto'], 'note'>;

/**
 * GET /capability-activation/price：列出全部价目（ADMIN-only，零价目返回 []）。
 * client baseURL 已含 /api；读取失败照常 reject，UI 必须显示错误而非空表。
 */
export function listPrices(signal?: AbortSignal): Promise<PricingConfig[]> {
  return signal
    ? client.get<PricingConfig[]>('/capability-activation/price', { signal })
    : client.get<PricingConfig[]>('/capability-activation/price');
}

/** PUT /capability-activation/price：按 provider/model/direction upsert 一条价目。 */
export function setPrice(dto: SetPriceDto): Promise<PricingConfig> {
  return client.put<PricingConfig>('/capability-activation/price', dto);
}
