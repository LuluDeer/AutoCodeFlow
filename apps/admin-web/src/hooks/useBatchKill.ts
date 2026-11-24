/**
 * 执行记录批量终止 hook（客户端顺序编排，后端无批量 kill 端点）。
 *
 * 职责：在途进度态（done/total）+ 顺序编排调用 + 结果汇总；
 * 成功 / 失败的提示文案、写后失效、选中态收口等副作用由页面经 onSettled 注入。
 * 诚实语义：hook 不返回「整体成功」，结果逐项带 error（见 api/executionBatch）。
 */
import { useState } from 'react';
import { runBatchKill, type BatchKillRow, type KillExecutionFn } from '../api/executionBatch';
import { summarizeBatch, type BatchItemResult, type BatchOutcome } from '../api/tasks';

export interface BatchKillProgress {
  done: number;
  total: number;
}

export interface UseBatchKillOptions {
  /** 取出本次要终止的行（taskId + execId）；页面从当前页选中集解析。 */
  getRows: () => BatchKillRow[];
  /** 单条终止调用（通常注入 tasksApi.killExecution）。 */
  kill: KillExecutionFn;
  /** 编排结束回调：结果与汇总由页面决定提示 / 失效 / 清选中。 */
  onSettled?: (results: BatchItemResult[], summary: BatchOutcome) => void;
}

export interface UseBatchKillResult {
  progress: BatchKillProgress | null;
  busy: boolean;
  run: () => Promise<BatchOutcome | null>;
}

export function useBatchKill({ getRows, kill, onSettled }: UseBatchKillOptions): UseBatchKillResult {
  const [progress, setProgress] = useState<BatchKillProgress | null>(null);
  const busy = progress !== null;

  const run = async (): Promise<BatchOutcome | null> => {
    const rows = getRows();
    if (rows.length === 0 || busy) return null;
    setProgress({ done: 0, total: rows.length });
    try {
      const results = await runBatchKill(rows, kill, (done, total) =>
        setProgress({ done, total }),
      );
      const summary = summarizeBatch(results);
      onSettled?.(results, summary);
      return summary;
    } finally {
      setProgress(null);
    }
  };

  return { progress, busy, run };
}
