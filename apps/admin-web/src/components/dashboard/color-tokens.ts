/**
 * 仪表盘阈值色阶（UI-03 / UX-01）——纯函数与阈值常量的独立模块。
 *
 * 原先与组件同文件导出，是 react-refresh/only-export-components warning 的
 * 大头（组件文件混出常量/函数会破坏 fast refresh 边界）。色阶函数零 React
 * 依赖、外部消费方仅 __tests__/dashboard-color-tokens.ux01.test.ts，故独立
 * 成文件（消费方少，挪动最干净），组件文件恢复「仅导出组件」。
 *
 * 语义约定（与 theme/tokens.ts SEMANTIC_COLORS 同源）：
 *   · 警告档 = var(--color-warning)（亮 #D97706 / 暗 #F59E0B）——三处中间档
 *     此前误取 --color-ring（双主题均为品牌绿 #22C55E），高水位 CPU / 2 次
 *     失败 / P99 300ms 都渲染成绿色，告警语义完全丢失（UX-03）。
 *   · 危险档 = var(--color-destructive)；健康档 = var(--color-accent)。
 *   · 无样本/中性档 = var(--chart-axis-text)（UX-01：此前用表面色
 *     --color-secondary 当正文色，暗色卡面对比度仅 1.13:1，等于看不见）。
 */

/** 执行器热力条色阶阈值（导出供测试锚定）：≥85 红 / ≥65 黄 / 其余绿。
 *  阈值与 DashboardPage 既有 CPU 文字色阶（80/60）刻意分层：条形热力观感
 *  要求高水位更早预警。 */
export const HEAT_THRESHOLDS = { warning: 65, critical: 85 } as const;

/** 热力条阈值色阶：≥85 红 / ≥65 黄 / 其余绿（双主题同值，均为图形色非正文色）。 */
export function heatColor(usage: number | null | undefined): string {
  if (usage == null) return 'var(--color-border)';
  if (usage >= HEAT_THRESHOLDS.critical) return 'var(--color-destructive)';
  if (usage >= HEAT_THRESHOLDS.warning) return 'var(--color-warning)';
  return 'var(--color-accent)';
}

/** 调度延迟 P99 色阶阈值（导出供测试锚定）：≥1000ms 红 / ≥250ms 黄 / 其余绿。 */
export const LATENCY_THRESHOLDS = { warning: 250, critical: 1000 } as const;

/** 延迟阈值色阶：无样本走主题感知的 --chart-axis-text（亮 #475569 / 暗 #94A3B8）。 */
export function latencyColor(ms: number | null | undefined): string {
  if (ms == null) return 'var(--chart-axis-text)';
  if (ms >= LATENCY_THRESHOLDS.critical) return 'var(--color-destructive)';
  if (ms >= LATENCY_THRESHOLDS.warning) return 'var(--color-warning)';
  return 'var(--color-accent)';
}

/** 失败榜阈值色阶：≥3 次红 / 2 次黄 / 1 次灰（语义色与图表共源）。 */
export function failureCountColor(count: number): string {
  if (count >= 3) return 'var(--color-destructive)';
  if (count === 2) return 'var(--color-warning)';
  return 'var(--chart-axis-text)';
}
