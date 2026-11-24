/**
 * T3（P2）图表质感 UX 回归：TrendChart 的 Tooltip 双主题 + 单位。
 *
 * 旧实现 `<RechartTooltip />` 用 recharts 默认白底黑字，暗色面像一块贴纸；
 * 且悬浮数字无单位（成功率/次数分不清）。本用例锚定生产组件实际传入的
 * `contentStyle` 与 `formatter`，而不是只测常量（防止「令牌改了但没接线」）。
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import TrendChart from '../components/dashboard/TrendChart';
import { CHART_COLORS, DARK_TOKENS, LIGHT_TOKENS } from '../theme/tokens';

type TooltipFormatter = (value: number, name: string, item: { dataKey: string }) => [string, string];
let lastStyle: Record<string, string> | undefined;
let lastFormatter: TooltipFormatter | undefined;

vi.mock('recharts', () => ({
  ResponsiveContainer: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  AreaChart: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Area: () => <div data-testid="trend-area" />,
  Line: () => <div data-testid="trend-line" />,
  XAxis: () => null,
  YAxis: () => null,
  CartesianGrid: () => null,
  Legend: () => null,
  Tooltip: (props: { contentStyle: Record<string, string>; formatter: TooltipFormatter }) => {
    lastStyle = props.contentStyle;
    lastFormatter = props.formatter;
    return <div data-testid="chart-tooltip" />;
  },
}));

const point = { date: '01-01', success: 3, failed: 1, rate: 75 };

describe('T3 P2：趋势图 Tooltip 双主题 + 单位', () => {
  it('tooltip 工厂三色全部来自主题面令牌，文字色与 axisText 同源', () => {
    expect(CHART_COLORS.tooltip(true)).toEqual({
      backgroundColor: DARK_TOKENS.container,
      borderColor: DARK_TOKENS.border,
      color: DARK_TOKENS.textSecondary,
    });
    expect(CHART_COLORS.tooltip(false)).toEqual({
      backgroundColor: LIGHT_TOKENS.container,
      borderColor: LIGHT_TOKENS.border,
      color: LIGHT_TOKENS.textSecondary,
    });
    expect(CHART_COLORS.tooltip(true).color).toBe(CHART_COLORS.axisText(true));
    expect(CHART_COLORS.tooltip(false).color).toBe(CHART_COLORS.axisText(false));
  });

  it('暗色面渲染：Tooltip 收到暗色样式，rate 拼 %、计数拼单位词条', () => {
    render(<TrendChart trendData={[point]} isDark t={(key: string) => key} />);

    expect(screen.getByTestId('chart-tooltip')).toBeTruthy();
    expect(lastStyle).toEqual(CHART_COLORS.tooltip(true));
    expect(lastStyle?.backgroundColor).toBe(DARK_TOKENS.container);
    expect(lastFormatter?.(75, 'Success rate', { dataKey: 'rate' })).toEqual(['75%', 'Success rate']);
    expect(lastFormatter?.(3, 'Success', { dataKey: 'success' })).toEqual([
      '3 dashboard.trend.tooltip.countUnit', 'Success',
    ]);
  });

  it('亮色面渲染：Tooltip 收到亮色样式（不是暗色残留）', () => {
    render(<TrendChart trendData={[point]} isDark={false} t={(key: string) => key} />);

    expect(lastStyle).toEqual(CHART_COLORS.tooltip(false));
    expect(lastStyle?.backgroundColor).toBe(LIGHT_TOKENS.container);
  });
});
