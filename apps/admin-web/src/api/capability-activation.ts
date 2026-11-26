import { client } from './client';

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
