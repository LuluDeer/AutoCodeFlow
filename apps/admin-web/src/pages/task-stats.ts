/**
 * F-27（DEEP_REVIEW 0ef3bbe）：任务统计卡的派生指标（纯函数层，便于单测）。
 *
 * 后端 GET /tasks/:id/stats 只回 totalRuns 与 successRate（百分比，已四舍五入），
 * 失败次数需前端派生：totalRuns × (1 - successRate/100)。
 * 原实现直接 toFixed(1) 保留一位小数 → 出现「失败 1.4 次」的语义错误
 * （次数是离散量）。现统一 Math.round 归一为整数。
 */
export function failedRunCount(totalRuns: number, successRate: number): number {
  if (!Number.isFinite(totalRuns) || totalRuns <= 0) return 0;
  // 成功率缺失/非法时不做猜测（否则会把"未知"渲染成"全部失败"）
  if (!Number.isFinite(successRate)) return 0;
  return Math.round(totalRuns * (1 - successRate / 100));
}
