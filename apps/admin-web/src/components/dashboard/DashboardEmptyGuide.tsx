/**
 * UI-04 ⑤：空态引导。
 *
 * 数据面：metrics/summary.totalTasks === 0 时整页显示引导 Empty，
 * 「创建第一个任务」按钮跳 /tasks/new（路由已存在，TaskFormPage 挂载点）。
 * 摘要未加载完成（undefined）时不渲染——避免加载闪烁误导。
 *
 * BRAND（2026-11-02）：插图从 antd 的 `PRESENTED_IMAGE_SIMPLE`（一张通用灰脸）换成
 * 品牌狐狸。空态是用户第一次见到产品的地方之一，用一只狐狸比一张占位图更能让人
 * 记住「这是谁」；它仍是装饰（标题与副标题已经说清了状态），所以 alt 留空。
 */
import { Button, Typography } from 'antd';
import { RocketOutlined } from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import BrandFox from '../BrandFox';
// UI-10：导入 i18n 实例（模块副作用完成初始化；树内用 useTranslation 读 key）
import '../../i18n';

const { Text } = Typography;

interface DashboardEmptyGuideProps {
  /** 任务总数（undefined = 摘要未加载，不渲染引导） */
  totalTasks: number | undefined;
  onCreateTask: () => void;
}

/**
 * 显隐判定纯函数（导出供测试锚定）：
 * 仅 totalTasks 严格等于 0 时显示引导——undefined（未加载）不显示。
 */
export function shouldShowEmptyGuide(totalTasks: number | undefined): boolean {
  return totalTasks === 0;
}

export default function DashboardEmptyGuide({ totalTasks, onCreateTask }: DashboardEmptyGuideProps) {
  const { t } = useTranslation();
  if (!shouldShowEmptyGuide(totalTasks)) return null;
  return (
    <div
      data-testid="dashboard-empty-guide"
      style={{
        display: 'flex',
        justifyContent: 'center',
        padding: '48px 0',
        background: 'var(--color-muted)',
        borderRadius: 10,
        border: '1px dashed var(--color-border)',
      }}
    >
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 4,
        }}
      >
        <BrandFox size={96} style={{ marginBottom: 8 }} />
        <Text strong style={{ fontSize: 14 }}>
          {t('dashGuide.title')}
        </Text>
        <Text type="secondary" style={{ fontSize: 12 }}>
          {t('dashGuide.subtitle')}
        </Text>
        <Button
          type="primary"
          data-testid="dashboard-empty-guide-create"
          icon={<RocketOutlined />}
          onClick={onCreateTask}
          style={{ marginTop: 12 }}
        >
          {t('dashGuide.createFirst')}
        </Button>
      </div>
    </div>
  );
}
