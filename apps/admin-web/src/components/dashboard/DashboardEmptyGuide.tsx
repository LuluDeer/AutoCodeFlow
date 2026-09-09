/**
 * UI-04 ⑤：空态引导。
 *
 * 数据面：metrics/summary.totalTasks === 0 时整页显示引导 Empty，
 * 「创建第一个任务」按钮跳 /tasks/new（路由已存在，TaskFormPage 挂载点）。
 * 摘要未加载完成（undefined）时不渲染——避免加载闪烁误导。
 */
import { Button, Empty, Typography } from 'antd';
import { RocketOutlined } from '@ant-design/icons';

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
      <Empty
        image={Empty.PRESENTED_IMAGE_SIMPLE}
        description={
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <Text strong style={{ fontSize: 14 }}>
              还没有任何任务
            </Text>
            <Text type="secondary" style={{ fontSize: 12 }}>
              创建第一个任务后，这里将展示执行量、成功率与调度健康度总览
            </Text>
          </div>
        }
      >
        <Button
          type="primary"
          data-testid="dashboard-empty-guide-create"
          icon={<RocketOutlined />}
          onClick={onCreateTask}
        >
          创建第一个任务
        </Button>
      </Empty>
    </div>
  );
}
