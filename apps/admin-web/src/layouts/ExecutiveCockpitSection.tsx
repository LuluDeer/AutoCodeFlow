import { Col, Row, Typography } from 'antd';
import { useTranslation } from 'react-i18next';
import ApprovalQueueCard from '../components/dashboard/ApprovalQueueCard';
import CostPostureCard from '../components/dashboard/CostPostureCard';
import NorthStarCard from '../components/dashboard/NorthStarCard';
import TtfvCard from '../components/dashboard/TtfvCard';
import '../i18n';

const { Text } = Typography;

/**
 * Dashboard 的「经营/成本」分区：与 Ops Pulse 明确分层，避免 14 张卡平铺。
 * ADMIN-only 卡（成本、北极星、TTFV）对 USER 不渲染空壳。
 */
export function ExecutiveCockpitSection({ isAdmin }: { isAdmin: boolean }) {
  const { t } = useTranslation();
  return (
    <section data-testid="boss-cockpit" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <Text strong style={{ fontSize: 15 }}>{t('dashboard.cockpit.title')}</Text>
      <Row gutter={[16, 16]} align="stretch">
        <Col xs={24} sm={12} xl={6}><ApprovalQueueCard /></Col>
        {isAdmin && (
          <>
            <Col xs={24} sm={12} xl={6}><CostPostureCard /></Col>
            <Col xs={24} sm={12} xl={6}><NorthStarCard /></Col>
            <Col xs={24} sm={12} xl={6}><TtfvCard /></Col>
          </>
        )}
      </Row>
    </section>
  );
}
