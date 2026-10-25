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
import { useTranslation } from 'react-i18next';
import { formatLatencyMs } from '../../utils/timeFormat';
import type { SchedulerMetricsResponse } from '../../api/metrics';
// UI-10：导入 i18n 实例（模块副作用完成初始化；树内用 useTranslation 读 key）
import '../../i18n';
// UX-03/UX-01：色阶阈值常量与 latencyColor 挪至 ./color-tokens（react-refresh
// 收敛：组件文件仅保留组件导出；色阶纯函数零 React 依赖，外部消费方仅色阶测试）。
import { latencyColor } from './color-tokens';

const { Text } = Typography;

interface SchedulerLatencyCardProps {
  metrics: SchedulerMetricsResponse | undefined;
}

/** 三指标行：标签 + 值（formatLatencyMs 专用档：直方图派生浮点不裸奔，
 *  P3-② 审计——此前「平均 6.716883116883117ms」17 位小数直接糊在卡面上） */
function LatencyStat({ label, value, color, t }: { label: React.ReactNode; value: number | null | undefined; color?: string; t?: (k: string, o?: Record<string, unknown>) => string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
      <Text type="secondary" style={{ fontSize: 12 }}>
        {label}
      </Text>
      <Text style={{ fontSize: 13, fontWeight: 600, color: color ?? 'var(--color-foreground)' }}>
        {value == null ? '—' : formatLatencyMs(value, t)}
      </Text>
    </div>
  );
}

export default function SchedulerLatencyCard({ metrics }: SchedulerLatencyCardProps) {
  const { t } = useTranslation();
  const hasSamples = (metrics?.counters?.triggerLatencyCount ?? 0) > 0;
  const p99 = metrics?.derived?.p99TriggerLatencyMs;
  const avg = metrics?.derived?.avgTriggerLatencyMs;
  const last = metrics?.counters?.lastTriggerLatencyMs;

  return (
    <div data-testid="scheduler-latency-card" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <LatencyStat
        label={
          <Tooltip title={t('schedLatency.p99.tooltip')}>
            <span>
              P99 <FieldTimeOutlined style={{ fontSize: 11 }} />
            </span>
          </Tooltip>
        }
        value={p99}
        color={latencyColor(p99)}
      />
      <LatencyStat label={t('schedLatency.avg')} value={avg} color={latencyColor(avg)} t={t} />
      <LatencyStat label={t('schedLatency.last')} value={hasSamples ? last : null} color={latencyColor(last)} t={t} />
      <Text type="secondary" style={{ fontSize: 11 }}>
        {hasSamples
          ? t('schedLatency.samples', { count: metrics?.counters?.triggerLatencyCount })
          : t('schedLatency.noSamples')}
      </Text>
    </div>
  );
}
