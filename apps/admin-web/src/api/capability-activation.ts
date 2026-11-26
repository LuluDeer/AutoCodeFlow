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

/** 时间窗内的总量、按能力与按项目两张聚合表。 */
export interface ActivationStats {
  total: number;
  byCapability: ActivationStatsEntry[];
  byProject: ActivationProjectStat[];
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
