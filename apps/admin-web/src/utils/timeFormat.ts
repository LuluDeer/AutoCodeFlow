type TimeInput = string | number | Date | null | undefined;

const FALLBACK = '—';

/** i18n 插值 t（可选：传参时输出走 key，缺省保持中文基线——测试锚定） */
type TFunc = (k: string, opts?: Record<string, unknown>) => string;

function toDate(value: TimeInput): Date | null {
  if (value == null) return null;

  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function formatRelativeTime(value: TimeInput, t?: TFunc): string {
  const date = toDate(value);
  if (!date) return FALLBACK;

  const diff = Date.now() - date.getTime();
  const mins = Math.floor(diff / 60000);

  if (mins < 1) return t ? t('time.relative.justNow') : '刚刚';
  if (mins < 60) return t ? t('time.relative.minsAgo', { n: mins }) : `${mins}分钟前`;
  if (mins < 1440) return t ? t('time.relative.hoursAgo', { n: Math.floor(mins / 60) }) : `${Math.floor(mins / 60)}小时前`;

  const days = Math.floor(mins / 1440);
  if (days < 30) return t ? t('time.relative.daysAgo', { n: days }) : `${days}天前`;

  return date.toLocaleDateString('zh-CN');
}

export function formatDuration(ms: number | null | undefined, t?: TFunc): string {
  if (ms == null) return FALLBACK;
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return t ? t('time.duration.sec', { n: (ms / 1000).toFixed(1) }) : `${(ms / 1000).toFixed(1)}秒`;

  const minutes = Math.floor(ms / 60000);
  const seconds = Math.floor((ms % 60000) / 1000);
  return t ? t('time.duration.minSec', { n: minutes, s: seconds }) : `${minutes}分${seconds}秒`;
}

export function formatDateTime(value: TimeInput): string {
  const date = toDate(value);
  return date ? date.toLocaleString('zh-CN') : FALLBACK;
}
