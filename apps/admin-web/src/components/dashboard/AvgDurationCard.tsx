import { Card, Typography } from 'antd';
import { ClockCircleOutlined, ThunderboltOutlined } from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import { formatDuration } from '../../utils/timeFormat';
import { CHART_COLORS } from '../../theme/tokens';
import KpiSparkline, { type buildSparklineData } from './KpiSparkline';
import '../../i18n';

const { Text } = Typography;

export interface AvgDurationCardProps {
  avgDurationMs?: number;
  todayRuns: number;
  runningCount: number;
  sparkHasData: boolean;
  sparkData: ReturnType<typeof buildSparklineData>;
}

/**
 * 控制台「平均执行时长」卡片：
 * 与左侧「执行成功率」保持同等视觉结构（主值 + 真实执行样本辅佐 + 口径说明 + 7d sparkline），
 * 仅消费既有 summary/trend 真实数据，不伪造后端指标。
 */
export default function AvgDurationCard({
  avgDurationMs,
  todayRuns,
  runningCount,
  sparkHasData,
  sparkData,
}: AvgDurationCardProps) {
  const { t } = useTranslation();
  return (
    <Card
      size="small"
      variant="borderless"
      title={<Text strong style={{ fontSize: 14 }}>{t('dashboard.avgDuration')}</Text>}
      style={{ height: '100%' }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 16, minHeight: 80 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <ClockCircleOutlined style={{ fontSize: 24, color: CHART_COLORS.cpu }} />
          <Text style={{ fontSize: 28, fontWeight: 700, color: CHART_COLORS.cpu, lineHeight: 1.2 }}>
            {formatDuration(avgDurationMs, t)}
          </Text>
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
            <ThunderboltOutlined style={{ color: CHART_COLORS.success }} />
            <Text>{`${t('dashboard.kpi.todayRuns')} ${todayRuns}`}</Text>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <ClockCircleOutlined style={{ color: CHART_COLORS.concurrent }} />
            <Text>{`${t('dashboard.kpi.running')} ${runningCount}`}</Text>
          </div>
        </div>
      </div>
      <Text type="secondary" style={{ fontSize: 11, display: 'block', marginTop: 2 }}>
        {t('dashboard.avgHint')}
      </Text>
      <KpiSparkline color={CHART_COLORS.cpu} hasData={sparkHasData} data={sparkData} />
    </Card>
  );
}
