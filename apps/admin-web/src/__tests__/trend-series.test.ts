/**
 * B3-①：趋势聚合纯函数回归（utils/trendSeries.ts）。
 *
 * 口径锚定：
 *   · 日期轴补零（与 buildTrendData 同源 recentDateKeys）；
 *   · 失败曲线并入 timeout；
 *   · 日成功率 = 成功 ÷（成功+失败+超时），零样本日 rate=null（断点，不画 0%）；
 *   · 非法/缺省计数按 0 处理，不产生 NaN；
 *   · TZ-01：recentDateKeys 按 UTC 建键，与后端 UTC 日键逐字对齐（否则
 *     UTC+8 凌晨本地键错配 → 今日曲线静默缺失）。
 */
import { describe, it, expect } from 'vitest';
import { buildTrendSeries, dailySuccessRate } from '../utils/trendSeries';
import { recentDateKeys } from '../components/dashboard/KpiSparkline';

/** UTC 日键（后端 DATE_TRUNC('day') + toISOString() 同为 UTC，不受进程 TZ 影响） */
const utcKey = (d: Date) =>
  `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;

const todayKey = () => utcKey(new Date());

const daysAgoKey = (n: number) => {
  const now = new Date();
  return utcKey(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - n)));
};

describe('recentDateKeys（UTC 日键，与后端 toISOString().slice(0,10) 对齐）', () => {
  it('TZ-01：UTC+8 凌晨（本地 11-25 01:00 = UTC 11-24 17:00）今日键为 2026-11-24，与后端 UTC 日键相等', () => {
    // 显式偏移的 Date 实例：getUTC* 不随进程 TZ 变化，正是修复点所在。
    const now = new Date('2026-11-25T01:00:00+08:00');
    expect(recentDateKeys(1, now)[0]).toBe('2026-11-24');
  });

  it('TZ-02：7 天窗口末键取 UTC 日，逐日连续不因本地时区偏移错位', () => {
    const now = new Date('2026-11-25T01:00:00+08:00');
    expect(recentDateKeys(7, now)).toEqual([
      '2026-11-18', '2026-11-19', '2026-11-20', '2026-11-21',
      '2026-11-22', '2026-11-23', '2026-11-24',
    ]);
  });
});

describe('dailySuccessRate', () => {
  it('按 成功/(成功+失败+超时) 计算百分比，保留 1 位小数', () => {
    expect(dailySuccessRate(3, 1, 2)).toBe(50); // 3/6
    expect(dailySuccessRate(7, 1, 0)).toBe(87.5);
    expect(dailySuccessRate(0, 2, 0)).toBe(0);
  });

  it('分母为 0（含全缺省）返回 null，不产出 0% 或 NaN', () => {
    expect(dailySuccessRate(0, 0, 0)).toBeNull();
    expect(dailySuccessRate(undefined, undefined, undefined)).toBeNull();
    expect(dailySuccessRate(null, null, null)).toBeNull();
  });

  it('timeout 计入失败分母（与告警 failed|timeout 口径一致）', () => {
    // 成功 3、失败 1、超时 2 ⇒ 分母 6，成功率 50%（超时不被当成功）
    expect(dailySuccessRate(3, 1, 2)).toBe(50);
  });
});

describe('buildTrendSeries', () => {
  it('稀疏行补齐完整日期轴，缺失日计数为 0、rate 为 null', () => {
    const rows = [
      { date: daysAgoKey(6), success: 5, failed: 1, timeout: 1 },
      { date: daysAgoKey(0), success: 3, failed: 2, timeout: 0 },
    ];
    const series = buildTrendSeries(rows, 7);
    expect(series).toHaveLength(7);
    expect(series[0]).toEqual({ date: daysAgoKey(6).slice(5), success: 5, failed: 2, rate: 71.4 });
    expect(series[6]).toEqual({ date: todayKey().slice(5), success: 3, failed: 2, rate: 60 });
    for (let i = 1; i <= 5; i++) {
      expect(series[i]).toEqual({ date: series[i].date, success: 0, failed: 0, rate: null });
    }
  });

  it('undefined 与空数组返回全零序列，rate 全 null（图表不空窗也不假报 0%）', () => {
    for (const input of [undefined, []] as const) {
      const series = buildTrendSeries(input, 7);
      expect(series).toHaveLength(7);
      expect(series.every(p => p.success === 0 && p.failed === 0 && p.rate === null)).toBe(true);
    }
  });

  it('乱序输入按日期轴对齐取值', () => {
    const series = buildTrendSeries(
      [
        { date: daysAgoKey(0), success: 1, failed: 0 },
        { date: daysAgoKey(2), success: 0, failed: 4, timeout: 1 },
      ],
      3,
    );
    expect(series.map(p => p.date)).toEqual([
      daysAgoKey(2).slice(5),
      daysAgoKey(1).slice(5),
      todayKey().slice(5),
    ]);
    expect(series[0].failed).toBe(5);
    expect(series[0].rate).toBe(0);
    expect(series[2].rate).toBe(100);
  });

  it('timeout 键缺省（旧载荷）按 0 处理，不产生 NaN', () => {
    const series = buildTrendSeries([{ date: todayKey(), success: 3, failed: 1 }], 7);
    expect(series[6]).toEqual({ date: todayKey().slice(5), success: 3, failed: 1, rate: 75 });
  });
});
