import type { TaskExecution } from '../../api/tasks';

export type LiveExecutionStatus =
  | 'pending'
  | 'running'
  | 'waiting'
  | 'success'
  | 'failed'
  | 'timeout'
  | 'killed'
  | 'cancelled';

/** 每个任务最近一次执行的状态（按 createdAt/startedAt 取最新一条）。 */
export function latestExecutionByTask(
  executions: TaskExecution[] | undefined,
): Map<string, LiveExecutionStatus> {
  const result = new Map<string, LiveExecutionStatus>();
  if (!executions) return result;
  const sorted = [...executions].sort((a, b) => {
    const at = Date.parse(a.createdAt ?? '') || 0;
    const bt = Date.parse(b.createdAt ?? '') || 0;
    return at - bt;
  });
  for (const exec of sorted) {
    const status = String(exec.status ?? '') as LiveExecutionStatus;
    if (status) result.set(exec.taskId, status);
  }
  return result;
}
