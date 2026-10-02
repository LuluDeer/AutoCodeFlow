/**
 * A6（第二轮审计）：Dashboard 主趋势图零执行日断点修复回归。
 *
 * 旧实现 `trendData = (trend ?? []).map(...)` 直接渲染 getDailyTrend 的原始行
 * ——该端点只返回**有执行的日**，零执行日在 X 轴上不可见，折线出现"从上周五
 * 直接跳到今天"的假断点。修复：buildTrendData 按「最近 days 天含今日」的完整
 * 日期轴补零（思路与 KpiSparkline.buildSparklineData 同源）。
 *
 * 纯函数锚定（页面渲染断言受 recharts tick 抽稀影响不稳定，见 dashboard-ui04
 * 既有取舍——图表形状类修复锚定输入→序列映射）。
 */
import { describe, it, expect } from 'vitest';
import { buildTrendData } from '../pages/DashboardPage';

/** 与 recentDateKeys 同构的「今天」键（YYYY-MM-DD，本地时区） */
const todayKey = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

const daysAgoKey = (n: number) => {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

describe('buildTrendData（A6 趋势补零）', () => {
  it('稀疏行补齐为完整日期轴：长度 = days，缺失日 success/failed = 0', () => {
    const rows = [
      { date: daysAgoKey(6), success: 5, failed: 1 },
      { date: daysAgoKey(0), success: 3, failed: 2 },
    ];
    const series = buildTrendData(rows, 7);
    expect(series).toHaveLength(7);
    // 首行 = 6 天前（有数据），末行 = 今天（有数据），中间 5 天全零
    expect(series[0]).toEqual({ date: daysAgoKey(6).slice(5), success: 5, failed: 1 });
    expect(series[6]).toEqual({ date: todayKey().slice(5), success: 3, failed: 2 });
    for (let i = 1; i <= 5; i++) {
      expect(series[i]).toEqual({ date: series[i].date, success: 0, failed: 0 });
    }
  });

  it('undefined（请求未回）与空数组：返回全零序列而非空数组（图表不空窗）', () => {
    for (const input of [undefined, []] as const) {
      const series = buildTrendData(input as never, 7);
      expect(series).toHaveLength(7);
      expect(series.every(p => p.success === 0 && p.failed === 0)).toBe(true);
    }
  });

  it('序列按时间升序（date 键保留 MM-DD 展示形态）', () => {
    const series = buildTrendData(
      [
        { date: daysAgoKey(0), success: 1, failed: 0 },
        { date: daysAgoKey(2), success: 0, failed: 4 },
      ],
      3,
    );
    expect(series.map(p => p.date)).toEqual([
      daysAgoKey(2).slice(5),
      daysAgoKey(1).slice(5),
      todayKey().slice(5),
    ]);
    // 乱序输入也按轴对齐取值
    expect(series[0]).toEqual({ date: series[0].date, success: 0, failed: 4 });
    expect(series[2]).toEqual({ date: series[2].date, success: 1, failed: 0 });
  });

  it('趋势窗口天数可变（14 天档同样补满）', () => {
    const series = buildTrendData([{ date: todayKey(), success: 2, failed: 0 }], 14);
    expect(series).toHaveLength(14);
  });

  // A-10（审计趋势口径）：TIMEOUT 并入失败曲线——告警口径为 failed|timeout
  // （alerts.yml AUTOFLOW_EXECUTION_FAILURE_RATE_HIGH/_STORM 的
  // status=~"failed|timeout"），此前超时被丢弃，超时风暴时失败曲线平稳而
  // 告警齐鸣。
  it('A-10：timeout 并入 failed 曲线（failed = failed + timeout）', () => {
    const rows = [
      { date: daysAgoKey(0), success: 3, failed: 1, timeout: 2 },
      { date: daysAgoKey(1), success: 5, failed: 0, timeout: 4 },
    ];
    const series = buildTrendData(rows, 7);
    expect(series[6]).toEqual({ date: todayKey().slice(5), success: 3, failed: 3 });
    expect(series[5]).toEqual({ date: daysAgoKey(1).slice(5), success: 5, failed: 4 });
  });

  it('A-10：timeout 键缺省（旧载荷/快照转发）时不产生 NaN，按 0 处理', () => {
    const series = buildTrendData([{ date: todayKey(), success: 3, failed: 1 }], 7);
    expect(series[6]).toEqual({ date: todayKey().slice(5), success: 3, failed: 1 });
  });
});
