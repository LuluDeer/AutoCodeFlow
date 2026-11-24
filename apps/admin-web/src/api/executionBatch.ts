/**
 * 执行记录批量终止——客户端顺序编排（后端无批量 kill 端点）。
 *
 * 后端现状（CodeGraph 核实）：仅单条 `POST /tasks/:taskId/executions/:execId/kill`，
 * 不存在批量终止端点。故本模块在前端逐条顺序调用既有单条端点：
 *  - 前一条结束（成功或失败）再发下一条，不做并发；
 *  - 单项失败吸收进 `{ id, error }`，不中断后续条目；
 *  - `onProgress` 每条完成后回调 `(done, total)` 供进度反馈；
 *  - 结果顺序与入参一致。
 *
 * 诚实语义：绝不返回「整体成功」。调用方必须逐项检查 `error`，
 * 与任务批量端点（HTTP 200 + 逐项 {id,error}）的报告口径一致。
 */
import type { BatchItemResult } from './tasks';

export interface BatchKillRow {
  taskId: string;
  execId: string;
}

export type KillExecutionFn = (taskId: string, execId: string) => Promise<unknown>;

export async function runBatchKill(
  rows: BatchKillRow[],
  killExecution: KillExecutionFn,
  onProgress?: (done: number, total: number) => void,
): Promise<BatchItemResult[]> {
  const results: BatchItemResult[] = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    try {
      await killExecution(row.taskId, row.execId);
      results.push({ id: row.execId });
    } catch (err) {
      results.push({
        id: row.execId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    onProgress?.(i + 1, rows.length);
  }
  return results;
}
