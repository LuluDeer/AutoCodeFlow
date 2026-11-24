/**
 * T3（P2）图表质感：Dashboard 主趋势图（执行量面积 + 日成功率折线）。
 *
 * 从 DashboardPage 外提（棘轮：页面只留一行组件调用）。修复点：Recharts
 * 默认 Tooltip 白底黑字，在暗色 OLED 面上像一块贴纸；本组件统一传
 * `CHART_COLORS.tooltip(isDark)`，并给数值补单位——成功率带 `%`，计数带
 * i18n 单位词条（不再出现没有量纲的裸数字）。
 */
import {
  AreaChart, Area, Line, XAxis, YAxis, CartesianGrid,
  Tooltip as RechartTooltip, Legend, ResponsiveContainer,
} from 'recharts';
import type { TrendSeriesPoint } from '../../utils/trendSeries';
import { CHART_COLORS } from '../../theme/tokens';

interface TrendChartProps {
  trendData: TrendSeriesPoint[];
  isDark: boolean;
  /** 由父页面注入，保持与卡片标题/图例同一翻译实例。 */
  t: (key: string) => string;
}

export default function TrendChart({ trendData, isDark, t }: TrendChartProps) {
  return (
    <ResponsiveContainer width="100%" height={200}>
      <AreaChart data={trendData} margin={{ top: 5, right: 16, left: 0, bottom: 0 }}>
        <defs>
          <linearGradient id="gradSuccess" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor={CHART_COLORS.success} stopOpacity={0.25} />
            <stop offset="95%" stopColor={CHART_COLORS.success} stopOpacity={0} />
          </linearGradient>
          <linearGradient id="gradFailed" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor={CHART_COLORS.failed} stopOpacity={0.25} />
            <stop offset="95%" stopColor={CHART_COLORS.failed} stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 3" stroke={CHART_COLORS.grid(isDark)} />
        <XAxis dataKey="date" tick={{ fontSize: 11, fill: CHART_COLORS.axisText(isDark) }} />
        <YAxis yAxisId="count" tick={{ fontSize: 11, fill: CHART_COLORS.axisText(isDark) }} allowDecimals={false} />
        <YAxis yAxisId="rate" orientation="right" domain={[0, 100]} unit="%" width={48} tick={{ fontSize: 11, fill: CHART_COLORS.axisText(isDark) }} />
        <RechartTooltip
          contentStyle={CHART_COLORS.tooltip(isDark)}
          formatter={(value, name, item) => (
            item?.dataKey === 'rate'
              ? [`${value}%`, name]
              : [`${value} ${t('dashboard.trend.tooltip.countUnit')}`, name]
          )}
        />
        <Legend wrapperStyle={{ fontSize: 12 }} />
        <Area yAxisId="count" type="monotone" dataKey="success" name={t('dashboard.trend.success')} stroke={CHART_COLORS.success} fill="url(#gradSuccess)" strokeWidth={2} />
        <Area yAxisId="count" type="monotone" dataKey="failed" name={t('dashboard.trend.failed')} stroke={CHART_COLORS.failed} fill="url(#gradFailed)" strokeWidth={2} />
        <Line yAxisId="rate" type="monotone" dataKey="rate" name={t('dashboard.trend.rate')} stroke={CHART_COLORS.cpu} strokeWidth={2} dot={false} connectNulls={false} />
      </AreaChart>
    </ResponsiveContainer>
  );
}
