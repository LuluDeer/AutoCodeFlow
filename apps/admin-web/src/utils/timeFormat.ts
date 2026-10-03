import i18n from '../i18n';
import { currentLocale } from './locale';

type TimeInput = string | number | Date | null | undefined;

const FALLBACK = '—';

/** i18n 插值 t（可选：传参时用调用方的 t；缺省回落 i18n 单例——跟随当前
 *  语言，测试环境默认 zh，与旧「中文基线内联」输出逐字一致）。 */
type TFunc = (k: string, opts?: Record<string, unknown>) => string;

/** 缺省 t：i18n 单例（非组件文件直引单例，与 api/tasks.ts 同模式）。 */
const fallbackT: TFunc = (k, opts) => i18n.t(k, opts);

function toDate(value: TimeInput): Date | null {
  if (value == null) return null;

  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function formatRelativeTime(value: TimeInput, t?: TFunc): string {
  const date = toDate(value);
  if (!date) return FALLBACK;

  const T = t ?? fallbackT;
  const diff = Date.now() - date.getTime();
  const mins = Math.floor(diff / 60000);

  if (mins < 1) return T('time.relative.justNow');
  if (mins < 60) return T('time.relative.minsAgo', { n: mins });
  if (mins < 1440) return T('time.relative.hoursAgo', { n: Math.floor(mins / 60) });

  const days = Math.floor(mins / 1440);
  if (days < 30) return T('time.relative.daysAgo', { n: days });

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

  const T = t ?? fallbackT;
  if (ms < 60000) return T('time.duration.sec', { n: (ms / 1000).toFixed(1) });

  const minutes = Math.floor(ms / 60000);
  const seconds = Math.floor((ms % 60000) / 1000);
  if (minutes < 60) {
    return T('time.duration.minSec', { n: minutes, s: seconds });
  }

  // F-35：小时档（≥3600s）——秒级精度对长任务无意义，降为小时+分
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  return T('time.duration.hourMin', { h: hours, m: restMinutes });
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

/**
 * 绝对时间（原始时区按 ISO 语义解析，输出本地时区）→ 完整日期时间，
 * locale 跟随**应用语言**（currentLocale()：zh→zh-CN，en→en-US），不跟随浏览器
 * locale——裸调 toLocaleString() 在英文浏览器跑中文界面时会渲染成 MM/DD/YYYY，
 * 与界面语言割裂。空/非法值统一兜底 FALLBACK。
 *
 * 本文件是 src/utils 之外唯一的时间格式化出口：src/pages 与 src/components
 * 禁止裸调 toLocaleString/toLocaleDateString（源码守卫
 * __tests__/time-format-source-guard.test.ts）；「仅时刻」形态（趋势图同日
 * tooltip、挂钟）为数不多的就地豁免，理由见各调用点注释。
 */
export function formatDateTime(value: TimeInput): string {
  const date = toDate(value);
  return date ? date.toLocaleString(currentLocale()) : FALLBACK;
}
