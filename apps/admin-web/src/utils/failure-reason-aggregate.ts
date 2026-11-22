/**
 * 失败原因聚合（2026-10-23）。
 *
 * ## 为什么需要
 *
 * 执行记录页只有「列表 + 状态筛选」。一次批量故障里，运维真正想知道的是
 * **「这 30 条失败是不是同一个原因」**——是全平台踩了同一个 `sandbox_unavailable`，
 * 还是分散在几十个任务各自的脚本错误。此前只能一条条点进详情看 `failureReason`。
 *
 * ## 口径（刻意保守，只做确定能算的事）
 *
 * - 只统计**当前这一页已加载的行**（前端聚合，不做全量聚合查询）——
 *   列表本就是分页的，拿"这一页的分布"冒充"全量分布"会是第二个
 *   「子集说成全量」缺陷（本项目已经踩过：executor 列表截断提示 P3-9）。
 *   故调用方必须把「基于当前页」写进 UI 文案。
 * - 只统计**失败类终态**（failed / timeout / killed，见下方 `FAILURE_REASON_BUCKET_STATUSES`）。success 不参与，
 *   running/pending 无失败原因。
 * - `failureReason` 为空的历史行归入 **`unknown` 桶**（不是丢掉）——
 *   丢掉会让「本页 10 条失败」和「聚合条显示 7 条」对不上，那比不聚合更糟。
 * - 返回按次数降序、同次数按原因名升序（稳定排序：避免每次渲染顺序抖动）。
 */

/**
 * 「按失败原因分桶」时纳入的**状态集**——不是「失败状态集」。
 *
 * ⚠️ 含 `killed` 是**刻意的产品口径**：本函数算的是「当前页的原因分布」，页面上
 * 看得见的 killed 行就该出现在分布里（理由见文件头「口径」段）。
 * 而后端 `FAILED_EXECUTION_STATUSES`
 * （`apps/admin-api/src/modules/task/entities/task-execution.entity.ts` = FAILED ∪ TIMEOUT）
 * 是**失败计数/告警**口径。两者语义不同，故**刻意不同名**：同名不同值最容易让下一个人
 * 以为「该对齐」而改错（R284）。**不要**把它改名回 `FAILED_EXECUTION_STATUSES`。
 */
export const FAILURE_REASON_BUCKET_STATUSES = ['failed', 'timeout', 'killed'] as const;

/** 无 failureReason 的历史行归入此桶。 */
export const UNKNOWN_REASON_BUCKET = 'unknown';

export interface FailureReasonBucket {
  /** 归一化后的原因 token（空值 → 'unknown'） */
  reason: string;
  count: number;
}

/**
 * 聚合失败原因分布。
 *
 * @param rows 当前页的执行记录（只需 status / failureReason）
 * @returns 按 count 降序、reason 升序的分桶；无失败行时返回空数组
 */
export function aggregateFailureReasons(
  rows: ReadonlyArray<{ status?: string | null; failureReason?: string | null }>,
): FailureReasonBucket[] {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const status = (row.status ?? '').toLowerCase();
    if (!(FAILURE_REASON_BUCKET_STATUSES as readonly string[]).includes(status)) continue;
    const raw = (row.failureReason ?? '').trim();
    const reason = raw === '' ? UNKNOWN_REASON_BUCKET : raw;
    counts.set(reason, (counts.get(reason) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason));
}
