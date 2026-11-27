/**
 * 老板驾驶舱 · 待我审批入口。
 *
 * 诚实三态：读不到 / degraded → 未知（绝不显示 0）；读到 0 → 暂无；读到 N → 数字 + 收件箱入口。
 * 计数与摘要分开取：摘要列表的 items.length 永远不顶替独立 pendingApprovals 计数。
 */
import { Button, Card, Skeleton, Tooltip, Typography } from 'antd';
import { AuditOutlined } from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import type { AgentPendingApprovalRow } from '../../api/agent';
import { useInboxCounts, usePendingApprovals } from '../../api/queries';
import '../../i18n';

const { Text } = Typography;
const SUMMARY_LIMIT = 5;

export default function ApprovalQueueCard() {
  const { t } = useTranslation();
  const nav = useNavigate();
  const counts = useInboxCounts();
  const pending = usePendingApprovals(SUMMARY_LIMIT);

  const title = (
    <Text strong style={{ fontSize: 14 }}>
      <AuditOutlined style={{ color: 'var(--color-primary)', marginInlineEnd: 6 }} />
      {t('dashboard.cockpit.approval.title')}
    </Text>
  );

  const items = pending.data?.items ?? [];
  const hasCounts = counts.data !== undefined;
  const unknown = counts.isError
    || (hasCounts && (counts.data?.pendingApprovals == null || counts.data?.degraded === true))
    || (!hasCounts && !counts.isPending);

  const summary = items.length > 0 ? (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2, marginTop: 8 }}>
      <Text type="secondary" style={{ fontSize: 11 }}>
        {t('dashboard.cockpit.approval.queueHint', { count: Math.min(items.length, SUMMARY_LIMIT) })}
      </Text>
      {items.slice(0, SUMMARY_LIMIT).map((item: AgentPendingApprovalRow) => (
        <Tooltip key={item.approvalKey} title={item.reason ?? t('dashboard.cockpit.approval.noReason')}>
          <Text
            type="secondary"
            style={{ fontSize: 11, display: 'block', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}
            data-testid="boss-approval-item"
          >
            {t('dashboard.cockpit.approval.queueItem', {
              tool: item.toolName,
              reason: item.reason ?? t('dashboard.cockpit.approval.noReason'),
            })}
          </Text>
        </Tooltip>
      ))}
    </div>
  ) : null;

  let body;
  if (unknown) {
    body = (
      <Tooltip title={t('dashboard.cockpit.approval.unknownTooltip')}>
        <Text type="warning" style={{ fontSize: 18, fontWeight: 700 }} data-testid="boss-approval-unknown">
          {t('dashboard.cockpit.approval.unknown')}
        </Text>
      </Tooltip>
    );
  } else if (counts.isPending || !hasCounts) {
    body = (
      <div data-testid="boss-approval-loading">
        <Skeleton active paragraph={{ rows: 2 }} title={false} />
      </div>
    );
  } else if (counts.data.pendingApprovals === 0) {
    body = (
      <Text type="secondary" style={{ fontSize: 18, fontWeight: 600 }} data-testid="boss-approval-empty">
        {t('dashboard.cockpit.approval.empty')}
      </Text>
    );
  } else {
    body = (
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
        <Text style={{ fontSize: 28, fontWeight: 700, color: 'var(--color-warning)' }} data-testid="boss-approval-count">
          {t('dashboard.cockpit.approval.count', { count: counts.data.pendingApprovals })}
        </Text>
        <Button
          type="primary"
          size="small"
          data-testid="boss-approval-link"
          onClick={() => nav('/inbox')}
        >
          {t('dashboard.cockpit.approval.openInbox')}
        </Button>
      </div>
    );
  }

  return (
    <div data-testid="boss-approval-card" style={{ height: '100%' }}>
      <Card size="small" variant="borderless" title={title} style={{ background: 'var(--color-muted)', height: '100%' }}>
        {body}
        {summary}
      </Card>
    </div>
  );
}
