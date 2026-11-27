import { Button, Tag, Tooltip, Typography, theme } from 'antd';
import { ThunderboltOutlined } from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import type { TriggerSummary } from './dagTrigger';

const { Text } = Typography;

export function DagTriggerBar({
  isAdmin,
  triggering,
  taskCount,
  summary,
  onTrigger,
}: {
  isAdmin: boolean;
  triggering: boolean;
  taskCount: number;
  summary: TriggerSummary | null;
  onTrigger: () => void;
}) {
  const { t } = useTranslation();
  const { token } = theme.useToken();
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <Tooltip title={isAdmin ? t('depGraph.triggerRootsHint', { count: taskCount }) : t('taskList.adminOnly')}>
          <Button
            data-testid="dag-trigger-chain"
            icon={<ThunderboltOutlined />}
            loading={triggering}
            disabled={triggering || taskCount === 0 || !isAdmin}
            onClick={onTrigger}
          >
            {t('depGraph.triggerRoots', { count: taskCount })}
          </Button>
        </Tooltip>
      </div>
      {summary && (
        <div
          data-testid="dag-trigger-summary"
          style={{ marginTop: 8, padding: 8, border: `1px solid ${token.colorBorderSecondary}`, borderRadius: 6 }}
        >
          <Text type="secondary" style={{ fontSize: 12 }}>{t('depGraph.dagRunId')}: </Text>
          <Text code copyable style={{ fontSize: 12 }}>{summary.dagRunId}</Text>
          <div style={{ marginTop: 6 }}>
            <Tag color="green">{t('depGraph.rootTriggered', { count: summary.rootCount })}</Tag>
            <Tag color="orange">{t('depGraph.skippedDependents', { count: summary.skippedCount })}</Tag>
            <Tag>{t('depGraph.rootExecutions', { count: summary.executionCount })}</Tag>
          </div>
        </div>
      )}
    </div>
  );
}
