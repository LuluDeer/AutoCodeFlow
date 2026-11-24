/**
 * 执行记录批量终止结果的 toast 汇报（纯展示口径）。
 *
 * 后端执行侧无批量 kill 端点，前端按既有单条端点顺序编排；本模块只把
 * `BatchOutcome` 如实映射成成功 / 部分失败 / 全失败三档提示：
 *  - 全部成功 → success；
 *  - 全部失败 → error；
 *  - 部分失败 → warning，并带前 3 条失败原因（summarizeBatch 已截断）。
 * 绝不把部分失败包装成整体成功。
 */
import type { TFunction } from 'i18next';
import { message } from '../../utils/toast';
import type { BatchOutcome } from '../../api/tasks';

export function reportBatchKillOutcome(summary: BatchOutcome, t: TFunction): void {
  const { succeeded, failed, failures } = summary;
  const reasons = failures.map((f) => f.error).filter(Boolean).join('; ');
  if (failed === 0) {
    message.success(t('execs.batchKill.success', { count: succeeded }));
  } else if (succeeded === 0) {
    message.error(t('execs.batchKill.allFailed', { count: failed }));
  } else {
    message.warning(t('execs.batchKill.partial', { ok: succeeded, fail: failed, reasons }));
  }
}
