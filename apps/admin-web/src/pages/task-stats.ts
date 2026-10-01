/**
 * F-27（DEEP_REVIEW 0ef3bbe）+ FIX-5.1（统计口径收口）：任务统计卡失败次数。
 *
 * 后端 GET /tasks/:id/stats 现以一条 GROUP BY 返回**全量**计数
 * （successRate/succeeded/failed 均为全量口径；failed = FAILED + TIMEOUT，
 * killed/cancelled 是人工/调度动作不计入任务自身失败率；近窗成功率保留为
 * recentSuccessRate 供趋势参考）。前端不再用 totalRuns × (1 − successRate/100)
 * 派生失败数——旧派生把「全量 totalRuns」与「近 20 次 successRate」两个窗口
 * 混在一起（历史 500 败 + 最近 20 全成 → 显示「失败 0 次」），本函数现只做
 * 后端权威计数的归一（缺失/非法回 0，整数化，钳非负）。
 */
export function failedRunCount(stats: { failed?: number | null }): number {
  const failed = stats?.failed;
  if (!Number.isFinite(failed as number)) return 0;
  return Math.max(0, Math.round(failed as number));
}
