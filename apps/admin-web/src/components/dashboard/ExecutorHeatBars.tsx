/**
 * UI-04 ③：执行器资源热力条。
 *
 * 数据面：复用既有 GET /metrics/executors（cpuUsage/memUsage 0-100），
 * 每执行器一行双条形（CPU + 内存），自绘 div 消费 theme tokens——
 * 色阶按阈值：≥85 红（--color-destructive）/ ≥65 黄（--color-ring，warning
 * 语义取 accent 环色）/ 其余绿（--color-accent）。阈值与 DashboardPage
 * 既有 CPU 文字色阶（80/60）刻意分层：条形热力观感要求高水位更早预警。
 * 交互：点击行跳执行器详情 /executors/:id。
 */
import { Typography } from 'antd';
import { ApiOutlined } from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
// UI-10：导入 i18n 实例（模块副作用完成初始化；树内用 useTranslation 读 key）
import '../../i18n';

const { Text } = Typography;

/** 色阶阈值（导出供测试锚定） */
export const HEAT_THRESHOLDS = { warning: 65, critical: 85 } as const;

/** 阈值色阶：≥85 红 / ≥65 黄 / 其余绿（双主题同值，均为图形色非正文色） */
export function heatColor(usage: number | null | undefined): string {
  if (usage == null) return 'var(--color-border)';
  if (usage >= HEAT_THRESHOLDS.critical) return 'var(--color-destructive)';
  if (usage >= HEAT_THRESHOLDS.warning) return 'var(--color-ring)';
  return 'var(--color-accent)';
}

/** 条形宽度百分比（0-100 钳制；null → 0） */
export function heatWidth(usage: number | null | undefined): number {
  if (usage == null) return 0;
  return Math.min(100, Math.max(0, usage));
}

export interface ExecutorHeatRow {
  id: string;
  appName: string;
  address: string;
  status: string;
  cpuUsage: number | null;
  memUsage: number | null;
  runningTaskCount: number;
}

interface ExecutorHeatBarsProps {
  executors: ExecutorHeatRow[];
  onOpenExecutor: (id: string) => void;
}

function BarTrack({ label, usage }: { label: string; usage: number | null }) {
  const color = heatColor(usage);
  const width = heatWidth(usage);
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, flex: 1, minWidth: 0 }}>
      <Text type="secondary" style={{ fontSize: 10, width: 24, flexShrink: 0 }}>
        {label}
      </Text>
      <div
        data-testid={`heat-track-${label}`}
        style={{
          flex: 1,
          height: 8,
          borderRadius: 4,
          background: 'var(--color-border)',
          overflow: 'hidden',
          opacity: 0.55,
        }}
      >
        <div
          data-testid={`heat-fill-${label}`}
          style={{
            width: `${width}%`,
            height: '100%',
            borderRadius: 4,
            background: color,
            transition: 'width 0.3s ease, background 0.3s ease',
          }}
        />
      </div>
      <Text style={{ fontSize: 10, width: 34, textAlign: 'right', flexShrink: 0, color: 'var(--color-secondary)' }}>
        {usage == null ? '—' : `${Math.round(usage)}%`}
      </Text>
    </div>
  );
}

/** 执行器资源热力条列表（每执行器一行：名称 + CPU 条 + 内存条） */
export default function ExecutorHeatBars({ executors, onOpenExecutor }: ExecutorHeatBarsProps) {
  const { t } = useTranslation();
  if (executors.length === 0) {
    return (
      <div
        data-testid="executor-heat-empty"
        style={{ textAlign: 'center', padding: '24px 0', color: 'var(--color-secondary)', fontSize: 12 }}
      >
        {t('heatBars.empty')}
      </div>
    );
  }
  return (
    <div data-testid="executor-heat-list" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {executors.map(ex => (
        <div
          key={ex.id}
          data-testid="executor-heat-row"
          role="button"
          tabIndex={0}
          title={t('heatBars.rowTitle', {
            address: ex.address,
            status: t(ex.status === 'online' ? 'heatBars.status.online' : ex.status === 'busy' ? 'heatBars.status.busy' : 'heatBars.status.offline'),
          })}
          onClick={() => onOpenExecutor(ex.id)}
          onKeyDown={e => {
            if (e.key === 'Enter' || e.key === ' ') onOpenExecutor(ex.id);
          }}
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 4,
            padding: '8px 10px',
            borderRadius: 6,
            background: 'var(--color-muted)',
            border: '1px solid var(--color-border)',
            cursor: 'pointer',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <ApiOutlined style={{ fontSize: 12, color: 'var(--color-accent)' }} />
            <Text ellipsis style={{ fontSize: 12, fontWeight: 500, flex: 1, minWidth: 0, color: 'var(--color-foreground)' }}>
              {ex.appName}
            </Text>
            <Text type="secondary" style={{ fontSize: 11, flexShrink: 0 }}>
              {t('heatBars.running', { count: ex.runningTaskCount })}
            </Text>
          </div>
          <div style={{ display: 'flex', gap: 12 }}>
            <BarTrack label={t('heatBars.cpuLabel')} usage={ex.cpuUsage} />
          </div>
          <div style={{ display: 'flex', gap: 12 }}>
            <BarTrack label={t('heatBars.memLabel')} usage={ex.memUsage} />
          </div>
        </div>
      ))}
    </div>
  );
}
