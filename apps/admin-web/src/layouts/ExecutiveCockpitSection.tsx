import { Col, Row, Typography } from 'antd';
import { useTranslation } from 'react-i18next';
import ApprovalQueueCard from '../components/dashboard/ApprovalQueueCard';
import NorthStarCard from '../components/dashboard/NorthStarCard';
import '../i18n';

const { Text } = Typography;

/**
 * Dashboard 的「经营驾驶舱」分区：与 Ops Pulse 明确分层，避免 14 张卡平铺。
 *
 * 重定位后砍为两卡（task-13 切片 C1）：
 *   · ApprovalQueueCard — 全员可见；
 *   · NorthStarCard    — 仅 ADMIN，北极星叙事锚点（data-testid=north-star-card
 *     被 e2e/north-star-real-backend.spec.ts 依赖，不可改动）。
 * CostPostureCard / TtfvCard 不再由驾驶舱渲染：TtfvCard 组件已整体删除；
 * CostPostureCard 文件保留（costReasonLabel 抽到 utils/cost-reason-label.ts，
 * 供用量页消费），但其 testid 不再出现在 boss-cockpit 内。
 */
export function ExecutiveCockpitSection({ isAdmin }: { isAdmin: boolean }) {
  const { t } = useTranslation();
  return (
    <section data-testid="boss-cockpit" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <Text strong style={{ fontSize: 15 }}>{t('dashboard.cockpit.title')}</Text>
      <Row gutter={[16, 16]} align="stretch">
        <Col xs={24} md={12}><ApprovalQueueCard /></Col>
        {isAdmin && <Col xs={24} md={12}><NorthStarCard /></Col>}
      </Row>
    </section>
  );
}
