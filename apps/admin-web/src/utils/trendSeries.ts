/**
 * B3-①：Dashboard 主趋势图序列聚合纯函数（无 React 依赖，独立成文件便于单测）。
 *
 * 数据源：既有 GET /metrics/trend?days=N（后端按 createdAt 日桶 GROUP BY，
 * 仅透出 success / failed / timeout 三类计数；killed / cancelled / 在途行不在
 * 该端点口径内，见 admin-api metrics.service.getDailyTrend）。前端不发新请求、
 * 不做列表采样，只在同一行计数上派生日成功率。
 *
 * 口径诚实声明：
 *   · 日成功率分母 = 成功 + 失败 + 超时（与告警 failed|timeout 口径对齐）；
 *     取消 / 已终止不计入分母。
 *   · 当日三类计数全为 0（含今日尚无终态样本）⇒ rate = null（折线断点，
 *     绝不画成 0% 制造「成功率为零」的假象）。
 *   · 超时并入失败计数曲线（与 DashboardPage.buildTrendData 的 A-10 口径一致）。
 */
import { recentDateKeys } from '../components/dashboard/KpiSparkline';

/** 与后端 MetricsTrendRowDto 同形的最小面（timeout 缺省兼容旧载荷）。 */
export interface TrendCountRow {
  date: string;
  success: number;
  failed: number;
  timeout?: number;
}

/** 主趋势图单点：date 为 MM-DD 展示键；rate 为 0–100 百分比，无样本日为 null。 */
export interface TrendSeriesPoint {
  date: string;
  success: number;
  failed: number;
  rate: number | null;
}

/**
 * 单日成功率（0–100，保留 1 位小数）。分母 ≤ 0 返回 null——零执行日不参与
 * 成功率曲线（避免 0/0 出 NaN，也避免把「无样本」画成「0% 成功」）。
 */
export function dailySuccessRate(
  success: number | null | undefined,
  failed: number | null | undefined,
  timeout: number | null | undefined,
): number | null {
  const s = Number(success) || 0;
  const f = Number(failed) || 0;
  const to = Number(timeout) || 0;
  const total = s + f + to;
  if (total <= 0) return null;
  return Math.round((s / total) * 1000) / 10;
}

/**
 * 后端 trend 行 → 固定日期轴的完整序列（零执行日补零）。
 * 与 DashboardPage.buildTrendData 同源补零思路；失败曲线并入 timeout，
 * 额外派生日成功率 rate。
 */
export function buildTrendSeries(
  trend: readonly TrendCountRow[] | undefined,
  days: number,
): TrendSeriesPoint[] {
  const byDate = new Map<string, TrendCountRow>();
  for (const row of trend ?? []) {
    byDate.set(String(row.date).slice(0, 10), row);
  }
  return recentDateKeys(days).map((key) => {
    const row = byDate.get(key);
    const success = row?.success ?? 0;
    const failed = (row?.failed ?? 0) + (row?.timeout ?? 0);
    return {
      date: key.slice(5),
      success,
      failed,
      rate: dailySuccessRate(row?.success, row?.failed, row?.timeout),
    };
  });
}
