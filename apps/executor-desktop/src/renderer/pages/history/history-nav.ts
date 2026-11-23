/**
 * 历史台账纯逻辑辅助：键盘上下导航、日期分桶、耗时/状态/错误摘要计算。
 */

export interface HistoryRecordLike {
  executionId: string;
  taskId: string;
  taskName: string;
  startTime: number;
  endTime?: number;
  status?: 'running' | 'success' | 'failed';
  exitCode?: number;
  errorMessage?: string;
}

/** 键盘上下导航：ArrowDown/ArrowUp/Home/End 返回目标下标，其余返回 null。 */
export function nextHistoryIndex(key: string, currentIndex: number, total: number): number | null {
  if (total <= 0) return null;
  if (key === 'ArrowDown') return Math.min(total - 1, currentIndex + 1);
  if (key === 'ArrowUp') return Math.max(0, currentIndex - 1);
  if (key === 'Home') return 0;
  if (key === 'End') return total - 1;
  return null;
}

/** 开始时间缺省值（避免 NaN 参与排序导致台账顺序抖动）。 */
export function startOf(r: HistoryRecordLike): number {
  return typeof r.startTime === 'number' && Number.isFinite(r.startTime) ? r.startTime : 0;
}

/** 一次执行所属的日期桶（本地时区自然日）：今天=0、昨天=1、近 7 天=2、更早=3。 */
export function dateBucketOf(latestStart: number, nowMs: number): number {
  if (!latestStart) return 3;
  const startOfDay = (ms: number) => {
    const d = new Date(ms);
    return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  };
  const dayDiff = Math.round((startOfDay(nowMs) - startOfDay(latestStart)) / 86_400_000);
  if (dayDiff <= 0) return 0;
  if (dayDiff === 1) return 1;
  if (dayDiff <= 6) return 2;
  return 3;
}

export function formatDuration(ms?: number): string {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

export function statusTone(status?: string): string {
  if (status === 'success') return 'is-success';
  if (status === 'failed') return 'is-failed';
  if (status === 'running') return 'is-running';
  return 'is-unknown';
}

export function taskKeyOf(r: HistoryRecordLike): string {
  return r.taskName || r.taskId || r.executionId;
}

export function isStaleRunning(run: HistoryRecordLike, nowMs: number, staleThresholdMs: number): boolean {
  return run.status === 'running' && startOf(run) > 0 && nowMs - startOf(run) > staleThresholdMs;
}

export function rowErrorSummary(
  run: HistoryRecordLike,
  formatExitCode: (code: number) => string,
): string {
  if (run.errorMessage) return run.errorMessage.replace(/\s+/g, ' ').trim();
  if (run.status === 'failed' && run.exitCode !== undefined) return formatExitCode(run.exitCode);
  return '';
}
