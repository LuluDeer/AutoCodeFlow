/**
 * UI-04 ④：调度延迟卡。
 *
 * 数据面：消费既有 GET /metrics/scheduler 的 CORE-06 字段——
 *   derived.p99TriggerLatencyMs / derived.avgTriggerLatencyMs（桶插值派生）
 *   + counters.lastTriggerLatencyMs（毛刺观测）。
 * 注记：CORE-06 后端直方图已存在（scheduler-metrics.service triggerLatencyBuckets），
 * 本卡为纯前端呈现，零后端改动；样本为 0 时 P99/均值均为 0，显式提示「暂无样本」
 * 而非误导性的 0ms。
 */
import { Typography, Tooltip } from 'antd';
import { FieldTimeOutlined } from '@ant-design/icons';
import { formatDuration } from '../../utils/timeFormat';
import type { SchedulerMetricsResponse } from '../../api/metrics';

const { Text } = Typography;

/** P99 色阶阈值（导出供测试锚定）：≥1000ms 红 / ≥250ms 黄 / 其余绿 */
export const LATENCY_THRESHOLDS = { warning: 250, critical: 1000 } as const;

export function latencyColor(ms: number | null | undefined): string {
  if (ms == null) return 'var(--color-secondary)';
  if (ms >= LATENCY_THRESHOLDS.critical) return 'var(--color-destructive)';
  if (ms >= LATENCY_THRESHOLDS.warning) return 'var(--color-ring)';
  return 'var(--color-accent)';
}

interface SchedulerLatencyCardProps {
  metrics: SchedulerMetricsResponse | undefined;
}

/** 三指标行：标签 + 值（formatDuration 复用既有工具） */
function LatencyStat({ label, value, color }: { label: React.ReactNode; value: number | null | undefined; color?: string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
      <Text type="secondary" style={{ fontSize: 12 }}>
        {label}
      </Text>
      <Text style={{ fontSize: 13, fontWeight: 600, color: color ?? 'var(--color-foreground)' }}>
        {value == null ? '—' : formatDuration(value)}
      </Text>
    </div>
  );
}

export default function SchedulerLatencyCard({ metrics }: SchedulerLatencyCardProps) {
  const hasSamples = (metrics?.counters?.triggerLatencyCount ?? 0) > 0;
  const p99 = metrics?.derived?.p99TriggerLatencyMs;
  const avg = metrics?.derived?.avgTriggerLatencyMs;
  const last = metrics?.counters?.lastTriggerLatencyMs;

  return (
    <div data-testid="scheduler-latency-card" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <LatencyStat
        label={
          <Tooltip title="定时触发 fire→入队延迟的 P99（桶插值估算，仅 fixed_rate/cron 任务计入）">
            <span>
              P99 <FieldTimeOutlined style={{ fontSize: 11 }} />
            </span>
          </Tooltip>
        }
        value={p99}
        color={latencyColor(p99)}
      />
      <LatencyStat label="平均" value={avg} color={latencyColor(avg)} />
      <LatencyStat label="最近一次" value={hasSamples ? last : null} color={latencyColor(last)} />
      <Text type="secondary" style={{ fontSize: 11 }}>
        {hasSamples
          ? `样本 ${metrics?.counters?.triggerLatencyCount} 次 · 进程内计数器（重启清零）`
          : '暂无定时触发样本（仅 fixed_rate/cron 任务计入）'}
      </Text>
    </div>
  );
}
