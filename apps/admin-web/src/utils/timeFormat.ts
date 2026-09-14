import { currentLocale } from './locale';

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

  return date.toLocaleDateString(currentLocale());
}

/**
 * 时长（毫秒）→ 可读文案，带 i18n（分/秒为最小档，≥1 小时进小时档）。
 * F-35（DEEP_REVIEW 0ef3bbe）：补 ≥3600s 的小时档——此前 3725000ms 会渲染成
 * "62分5秒"，超长任务可读性差。
 */
export function formatDuration(ms: number | null | undefined, t?: TFunc): string {
  if (ms == null) return FALLBACK;
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return t ? t('time.duration.sec', { n: (ms / 1000).toFixed(1) }) : `${(ms / 1000).toFixed(1)}秒`;

  const minutes = Math.floor(ms / 60000);
  const seconds = Math.floor((ms % 60000) / 1000);
  if (minutes < 60) {
    return t ? t('time.duration.minSec', { n: minutes, s: seconds }) : `${minutes}分${seconds}秒`;
  }

  // F-35：小时档（≥3600s）——秒级精度对长任务无意义，降为小时+分
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  return t
    ? t('time.duration.hourMin', { h: hours, m: restMinutes })
    : `${hours}小时${restMinutes}分`;
}

/**
 * 时长（毫秒）→ 紧凑无 i18n 文案（"500ms" / "1.5s" / "1h2m"）。
 * F-35（DEEP_REVIEW 0ef3bbe）：收敛原先散落的两处逐字节重复实现
 * （ExecutionCompare.tsx / ExecutorDetailPage.tsx 历史列），并补小时档。
 * <1 小时输出与旧实现逐字一致（不回归），≥1 小时由 "3725.0s" 变为 "1h2m"。
 */
export function formatDurationShort(ms: number | null | undefined): string {
  if (ms == null) return FALLBACK;
  if (ms < 1000) return `${ms}ms`;

  const seconds = ms / 1000;
  if (seconds < 3600) return `${seconds.toFixed(1)}s`;

  const hours = Math.floor(seconds / 3600);
  const restMinutes = Math.floor((seconds % 3600) / 60);
  return `${hours}h${restMinutes}m`;
}

export function formatDateTime(value: TimeInput): string {
  const date = toDate(value);
  return date ? date.toLocaleString(currentLocale()) : FALLBACK;
}
