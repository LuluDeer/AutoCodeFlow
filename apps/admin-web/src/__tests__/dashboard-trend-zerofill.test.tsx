/**
 * A6（第二轮审计）：Dashboard 主趋势图零执行日断点修复回归。
 *
 * 旧实现 `trendData = (trend ?? []).map(...)` 直接渲染 getDailyTrend 的原始行
 * ——该端点只返回**有执行的日**，零执行日在 X 轴上不可见，折线出现"从上周五
 * 直接跳到今天"的假断点。修复：生产序列由 `utils/trendSeries.ts::buildTrendSeries`
 * 按「最近 days 天含今日」的完整日期轴补零（思路与 KpiSparkline.buildSparklineData
 * 同源）。本测试锚定**生产实际调用的函数**：旧版误锚 `DashboardPage.buildTrendData`
 * （死代码，零生产调用），那是一条永远绿的假回归。
 *
 * 纯函数锚定（页面渲染断言受 recharts tick 抽稀影响不稳定，见 dashboard-ui04
 * 既有取舍——图表形状类修复锚定输入→序列映射）。
 */
import { describe, it, expect } from 'vitest';
import { buildTrendSeries } from '../utils/trendSeries';

/** 与 recentDateKeys（KpiSparkline，生产函数用 UTC 日桶）同构的键。
 *  后端 metrics.service.getDailyTrend 按 UTC 截断、PG 默认 UTC，故这里必须用
 *  UTC 口径；曾用本地 getDate() 导致 UTC+8 凌晨 00:00–08:00 跨日窗口错位。 */
const keyOf = (d: Date) =>
  `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;

const todayKey = () => keyOf(new Date());

const daysAgoKey = (n: number) =>
  keyOf(new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate() - n)));

describe('buildTrendSeries（A6 趋势补零，生产函数）', () => {
  it('稀疏行补齐为完整日期轴：长度 = days，缺失日 success/failed = 0、rate = null', () => {
    const rows = [
      { date: daysAgoKey(6), success: 5, failed: 1 },
      { date: daysAgoKey(0), success: 3, failed: 2 },
    ];
    const series = buildTrendSeries(rows, 7);
    expect(series).toHaveLength(7);
    // 首行 = 6 天前（有数据），末行 = 今天（有数据），中间 5 天全零
    expect(series[0]).toEqual({ date: daysAgoKey(6).slice(5), success: 5, failed: 1, rate: 83.3 });
    expect(series[6]).toEqual({ date: todayKey().slice(5), success: 3, failed: 2, rate: 60 });
    for (let i = 1; i <= 5; i++) {
      expect(series[i]).toEqual({ date: series[i].date, success: 0, failed: 0, rate: null });
    }
  });

  it('undefined（请求未回）与空数组：返回全零序列而非空数组（图表不空窗）', () => {
    for (const input of [undefined, []] as const) {
      const series = buildTrendSeries(input as never, 7);
      expect(series).toHaveLength(7);
      expect(series.every(p => p.success === 0 && p.failed === 0 && p.rate === null)).toBe(true);
    }
  });

  it('序列按时间升序（date 键保留 MM-DD 展示形态）', () => {
    const series = buildTrendSeries(
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
    expect(series[0]).toEqual({ date: series[0].date, success: 0, failed: 4, rate: 0 });
    expect(series[2]).toEqual({ date: series[2].date, success: 1, failed: 0, rate: 100 });
  });

  it('趋势窗口天数可变（14 天档同样补满）', () => {
    const series = buildTrendSeries([{ date: todayKey(), success: 2, failed: 0 }], 14);
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
    const series = buildTrendSeries(rows, 7);
    expect(series[6]).toEqual({ date: todayKey().slice(5), success: 3, failed: 3, rate: 50 });
    expect(series[5]).toEqual({ date: daysAgoKey(1).slice(5), success: 5, failed: 4, rate: 55.6 });
  });

  it('A-10：timeout 键缺省（旧载荷/快照转发）时不产生 NaN，按 0 处理', () => {
    const series = buildTrendSeries([{ date: todayKey(), success: 3, failed: 1 }], 7);
    expect(series[6]).toEqual({ date: todayKey().slice(5), success: 3, failed: 1, rate: 75 });
  });

  // T4：新增 rate 断言——补零日与零成功率日必须可区分，否则折线把「无样本」
  // 画成「0% 成功」的谎报会回归。
  it('rate：零样本日为 null、全失败日为 0，与计数同源', () => {
    const series = buildTrendSeries([
      { date: daysAgoKey(2), success: 0, failed: 0, timeout: 0 },
      { date: daysAgoKey(1), success: 0, failed: 4, timeout: 1 },
      { date: daysAgoKey(0), success: 9, failed: 1, timeout: 0 },
    ], 3);
    expect(series.map(p => p.rate)).toEqual([null, 0, 90]);
    // 分母含 timeout：9 成 1 败 0 超 → 90；4 败 1 超 → 0（不是把 timeout 丢掉后的「无样本」）
    expect(series.map(p => p.failed)).toEqual([0, 5, 1]);
  });
});
