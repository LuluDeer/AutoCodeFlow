/**
 * UI-04 ①：KPI 指标卡内嵌迷你趋势线（sparkline）。
 *
 * 数据面：复用既有 GET /metrics/trend?days=1（24h 执行量按日桶，零新端点——
 * 后端 getDailyTrend 以日为最小聚合粒度，24h 内通常 1~2 个点；点少时 recharts
 * 仍可渲染单点折线，空数组时渲染占位空态而非空白）。
 * 色面：消费 theme/tokens CHART_COLORS 语义色（--chart-* 同源），双主题不破。
 */
import { Line, LineChart, ResponsiveContainer, YAxis } from 'recharts';
import { useTranslation } from 'react-i18next';
// UI-10：导入 i18n 实例（模块副作用完成初始化；树内用 useTranslation 读 key）
import '../../i18n';

/** 迷你折线在 KPI 卡内的高度（px）——不参与响应式宽度 */
export const SPARKLINE_HEIGHT = 36;

/** 生成与「最近 7 天含今日」对齐的日期键（YYYY-MM-DD），供空桶补零 */
export function recentDateKeys(days: number, now: Date = new Date()): string[] {
  const keys: string[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
    keys.push(
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`,
    );
  }
  return keys;
}

/**
 * 把 trend 响应补零为固定长度序列（缺失日期=0），保证 sparkline 形状稳定；
 * 纯函数导出供测试锚定。
 */
export function buildSparklineData(
  trend: { date: string; success: number; failed: number }[] | undefined,
  days = 7,
): { day: string; value: number }[] {
  const keys = recentDateKeys(days);
  const byDate = new Map<string, { success: number; failed: number }>();
  for (const row of trend ?? []) {
    const key = String(row.date).slice(0, 10);
    const prev = byDate.get(key) ?? { success: 0, failed: 0 };
    byDate.set(key, { success: prev.success + (row.success ?? 0), failed: prev.failed + (row.failed ?? 0) });
  }
  return keys.map(key => {
    const entry = byDate.get(key);
    return { day: key, value: (entry?.success ?? 0) + (entry?.failed ?? 0) };
  });
}

interface KpiSparklineProps {
  /** 指标语义色（CHART_COLORS 集合内取值，双主题可读） */
  color: string;
  /** 是否有可绘制的数据（false → 渲染占位空态） */
  hasData: boolean;
  data: { day: string; value: number }[];
  /** 空态占位文案（缺省走 i18n key kpiSpark.empty） */
  emptyText?: string;
}

/**
 * KPI 卡内嵌迷你趋势线。jsdom/无布局环境下 ResponsiveContainer 拿不到宽度，
 * 以固定 height + width="99%" 兜底；测试经 mock ResponsiveContainer 注入尺寸。
 */
export default function KpiSparkline({ color, hasData, data, emptyText }: KpiSparklineProps) {
  const { t } = useTranslation();
  if (!hasData || data.length === 0) {
    return (
      <div
        data-testid="kpi-sparkline-empty"
        style={{
          height: SPARKLINE_HEIGHT,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: 11,
          color: 'var(--color-secondary)',
          opacity: 0.7,
        }}
      >
        {emptyText ?? t('kpiSpark.empty')}
      </div>
    );
  }
  return (
    <div data-testid="kpi-sparkline" style={{ width: '100%', height: SPARKLINE_HEIGHT }} aria-hidden>
      <ResponsiveContainer width="99%" height={SPARKLINE_HEIGHT}>
        <LineChart data={data} margin={{ top: 4, right: 2, left: 2, bottom: 0 }}>
          {/* 隐藏坐标轴：sparkline 只留形状，不给轴噪音 */}
          <YAxis hide domain={[0, 'auto']} />
          <Line
            type="monotone"
            dataKey="value"
            stroke={color}
            strokeWidth={1.5}
            dot={false}
            isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
