/**
 * F-26 / F-35（DEEP_REVIEW 0ef3bbe）回归：
 *  - locale 单一来源 currentLocale()：默认 zh 与旧硬编码 'zh-CN' 输出一致，
 *    切到 en 时跟随；
 *  - 相对时间实现收敛（ExecutorDetailPage 的重复实现已删，统一 formatRelativeTime）；
 *  - 时长格式统一：formatDuration（i18n 版）与 formatDurationShort（紧凑版）
 *    均补 ≥3600s 的小时档，且 <1 小时输出与旧实现逐字一致（不回归）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  formatDateTime,
  formatDuration,
  formatDurationShort,
  formatRelativeTime,
} from '../utils/timeFormat';
import { currentLocale } from '../utils/locale';
import i18n from '../i18n';

afterEach(async () => {
  vi.useRealTimers();
  await i18n.changeLanguage('zh');
});

describe('F-26 currentLocale（locale 单一来源）', () => {
  it('默认语言 zh → zh-CN（与旧硬编码逐字一致，零回归）', () => {
    expect(i18n.language).toBe('zh');
    expect(currentLocale()).toBe('zh-CN');
  });

  it('切到 en → en-US（不再把英文界面渲染成中文日期）', async () => {
    await i18n.changeLanguage('en');
    expect(currentLocale()).toBe('en-US');
  });

  it('formatDateTime 跟随 currentLocale', () => {
    const iso = '2026-01-02T03:04:05Z';
    expect(formatDateTime(iso)).toBe(new Date(iso).toLocaleString('zh-CN'));
  });
});

describe('F-26 formatRelativeTime（合并后唯一实现）', () => {
  const t = (k: string, o?: Record<string, unknown>) => {
    const n = o?.n ?? o?.h ?? o?.m;
    return n === undefined ? k : `${k}:${String(n)}`;
  };

  it.each([
    [30, 'time.relative.justNow'],
    [5 * 60, 'time.relative.minsAgo'],
    [3 * 3600, 'time.relative.hoursAgo'],
    [3 * 86400, 'time.relative.daysAgo'],
  ])('按差值分档：%i 秒前 → %s', (secondsAgo, key) => {
    const now = new Date('2026-01-10T12:00:00Z');
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const value = new Date(now.getTime() - secondsAgo * 1000).toISOString();
    expect(formatRelativeTime(value, t)).toContain(key);
  });

  it('超过 30 天回落为绝对日期（走 currentLocale）', () => {
    const now = new Date('2026-03-10T12:00:00Z');
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const old = new Date(now.getTime() - 40 * 86400 * 1000);
    expect(formatRelativeTime(old.toISOString(), t)).toBe(old.toLocaleDateString('zh-CN'));
  });

  it('非法/空值 → 占位符', () => {
    expect(formatRelativeTime(null)).toBe('—');
    expect(formatRelativeTime('not-a-date')).toBe('—');
  });
});

describe('F-35 formatDuration（i18n 版 + 小时档）', () => {
  const t = (k: string, o?: Record<string, unknown>) =>
    `${k}(${Object.entries(o ?? {}).map(([a, b]) => `${a}=${String(b)}`).join(',')})`;

  it('毫秒/秒档保持既有输出', () => {
    expect(formatDuration(500)).toBe('500ms');
    expect(formatDuration(1500)).toBe('1.5秒');
    expect(formatDuration(1500, t)).toBe('time.duration.sec(n=1.5)');
  });

  it('分钟档保持既有输出', () => {
    expect(formatDuration(62_000)).toBe('1分2秒');
    expect(formatDuration(62_000, t)).toBe('time.duration.minSec(n=1,s=2)');
  });

  it('≥3600s 走新增小时档（原先会渲染成 62分5秒）', () => {
    expect(formatDuration(3_725_000)).toBe('1小时2分');
    expect(formatDuration(3_725_000, t)).toBe('time.duration.hourMin(h=1,m=2)');
  });

  it('null → 占位符', () => {
    expect(formatDuration(null)).toBe('—');
  });
});

describe('F-35 formatDurationShort（收敛重复的内联实现 + 小时档）', () => {
  it('<1 小时与旧内联实现逐字一致', () => {
    expect(formatDurationShort(500)).toBe('500ms');
    expect(formatDurationShort(1500)).toBe('1.5s');
    expect(formatDurationShort(90_000)).toBe('90.0s');
  });

  it('≥1 小时由 "3725.0s" 变为小时档', () => {
    expect(formatDurationShort(3_725_000)).toBe('1h2m');
  });

  it('null → 占位符', () => {
    expect(formatDurationShort(undefined)).toBe('—');
  });
});
