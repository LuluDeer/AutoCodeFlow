/**
 * 老板驾驶舱 · 成本诚实标缺。
 *
 * 只有 priceReason==='OK' 且 currencyValue!=null 才显示金额；否则（含读失败）
 * 一律显示「成本金额不可用（未折算）」+ 原因 + note，绝不退化成 0 / ¥0.00 / 正常。
 */
import { Card, Skeleton, Tooltip, Typography } from 'antd';
import { WalletOutlined } from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import { costReasonLabel } from '../../utils/cost-reason-label';
import { useActivationStatsBrief } from '../../api/queries';
import '../../i18n';

const { Text } = Typography;

export default function CostPostureCard() {
  const { t } = useTranslation();
  const stats = useActivationStatsBrief();
  const dual = stats.data?.dualBasis;

  const amount = !stats.isError && dual?.priceReason === 'OK' && dual.currencyValue != null
    ? dual.currencyValue
    : null;
  const reason = stats.isError ? 'READ_FAILED' : (dual?.priceReason ?? 'UNKNOWN');
  const note = stats.isError
    ? t('dashboard.cockpit.cost.readFailedNote')
    : (dual?.note ?? t('dashboard.cockpit.cost.noNote'));

  const hasStats = stats.data !== undefined;
  const unavailable = stats.isError
    || (!hasStats && !stats.isPending)
    || (hasStats && amount === null);

  const title = (
    <Text strong style={{ fontSize: 14 }}>
      <WalletOutlined style={{ color: 'var(--color-primary)', marginInlineEnd: 6 }} />
      {t('dashboard.cockpit.cost.title')}
    </Text>
  );

  let body;
  if (unavailable) {
    body = (
      <div data-testid="boss-cost-unavailable" style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <Text type="warning" style={{ fontSize: 16, fontWeight: 600 }}>
          {t('dashboard.cockpit.cost.unavailable')}
        </Text>
        <Tooltip title={note}>
          <Text type="secondary" style={{ fontSize: 11, display: 'block', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {t('dashboard.cockpit.cost.detail', { reason: costReasonLabel(reason, t), note })}
          </Text>
        </Tooltip>
      </div>
    );
  } else if (stats.isPending || !hasStats) {
    body = (
      <div data-testid="boss-cost-loading">
        <Skeleton active paragraph={{ rows: 2 }} title={false} />
      </div>
    );
  } else {
    body = (
      <Text style={{ fontSize: 28, fontWeight: 700, color: 'var(--color-success)' }} data-testid="boss-cost-amount">
        {t('dashboard.cockpit.cost.amount', { value: amount })}
      </Text>
    );
  }

  return (
    <div data-testid="boss-cost-card" style={{ height: '100%' }}>
      <Card size="small" variant="borderless" title={title} style={{ background: 'var(--color-muted)', height: '100%' }}>
        {body}
        <Text type="secondary" style={{ fontSize: 11, display: 'block', marginTop: 8 }}>
          {t('dashboard.cockpit.cost.window')}
        </Text>
      </Card>
    </div>
  );
}
