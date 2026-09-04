type TimeInput = string | number | Date | null | undefined;

const FALLBACK = '—';

function toDate(value: TimeInput): Date | null {
  if (value == null) return null;

  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function formatRelativeTime(value: TimeInput): string {
  const date = toDate(value);
  if (!date) return FALLBACK;

  const diff = Date.now() - date.getTime();
  const mins = Math.floor(diff / 60000);

  if (mins < 1) return '刚刚';
  if (mins < 60) return `${mins}分钟前`;
  if (mins < 1440) return `${Math.floor(mins / 60)}小时前`;

  const days = Math.floor(mins / 1440);
  if (days < 30) return `${days}天前`;

  return date.toLocaleDateString('zh-CN');
}

export function formatDuration(ms: number | null | undefined): string {
  if (ms == null) return FALLBACK;
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}秒`;

  const minutes = Math.floor(ms / 60000);
  const seconds = Math.floor((ms % 60000) / 1000);
  return `${minutes}分${seconds}秒`;
}

export function formatDateTime(value: TimeInput): string {
  const date = toDate(value);
  return date ? date.toLocaleString('zh-CN') : FALLBACK;
}
