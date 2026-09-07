/**
 * UI-04 ②：失败 Top 任务榜。
 *
 * 数据面：复用既有 GET /metrics/failures（最近 10 条失败执行，零新端点），
 * 前端按 taskId 聚合为「任务名 + 失败次数 + 最近失败时间」Top N 榜。
 * 交互：点击行跳任务详情页 /tasks/:id（详情页含该任务全部执行记录——
 * 侦察结论：/executions 列表页不支持 taskId query 过滤，跳详情页是一步到位
 * 的最小正确形态；失败率不展示——/metrics/failures 无总执行数分母，硬造
 * 会误导，缩水声明见 PLAN-CLAIMS）。
 */
import { Typography } from 'antd';
import { ThunderboltOutlined } from '@ant-design/icons';
import { formatRelativeTime } from '../../utils/timeFormat';

const { Text } = Typography;

/** 聚合后的榜单行 */
export interface FailureTopItem {
  taskId: string;
  taskName: string;
  /** 窗口内失败次数（/metrics/failures 最多 10 条 = 次数上限） */
  failCount: number;
  /** 最近一次失败时间（原始 ISO，榜单内排序用） */
  lastFailedAt: string;
  /** 最近一次失败原因（Tooltip 呈现） */
  lastError: string;
}

/** 按任务聚合失败记录：次数降序 → 最近失败时间降序；纯函数导出供测试 */
export function aggregateFailureTop(
  failures: { id: string; taskId: string; taskName: string; errorMessage: string; createdAt: string }[] | undefined,
  topN = 5,
): FailureTopItem[] {
  const byTask = new Map<string, FailureTopItem>();
  for (const f of failures ?? []) {
    const prev = byTask.get(f.taskId);
    if (!prev) {
      byTask.set(f.taskId, {
        taskId: f.taskId,
        taskName: f.taskName,
        failCount: 1,
        lastFailedAt: f.createdAt,
        lastError: f.errorMessage || '未知错误',
      });
      continue;
    }
    prev.failCount += 1;
    if (new Date(f.createdAt).getTime() > new Date(prev.lastFailedAt).getTime()) {
      prev.lastFailedAt = f.createdAt;
      prev.lastError = f.errorMessage || '未知错误';
    }
  }
  return Array.from(byTask.values())
    .sort((a, b) => b.failCount - a.failCount || new Date(b.lastFailedAt).getTime() - new Date(a.lastFailedAt).getTime())
    .slice(0, topN);
}

/** 阈值色阶：≥3 次红 / 2 次黄 / 1 次绿（语义色与图表共源） */
export function failureCountColor(count: number): string {
  if (count >= 3) return 'var(--color-destructive)';
  if (count === 2) return 'var(--color-ring)';
  return 'var(--chart-axis-text)';
}

interface FailureTopListProps {
  failures: Parameters<typeof aggregateFailureTop>[0];
  topN?: number;
  onOpenTask: (taskId: string) => void;
}

/** 榜单行高（紧凑榜） */
const ROW_GAP = 8;

export default function FailureTopList({ failures, topN = 5, onOpenTask }: FailureTopListProps) {
  const top = aggregateFailureTop(failures, topN);
  if (top.length === 0) {
    return (
      <div
        data-testid="failure-top-empty"
        style={{ textAlign: 'center', padding: '24px 0', color: 'var(--color-secondary)', fontSize: 12 }}
      >
        近期无失败任务
      </div>
    );
  }
  return (
    <div data-testid="failure-top-list" style={{ display: 'flex', flexDirection: 'column', gap: ROW_GAP }}>
      {top.map((item, idx) => (
        <div
          key={item.taskId}
          data-testid="failure-top-row"
          role="button"
          tabIndex={0}
          title={item.lastError}
          onClick={() => onOpenTask(item.taskId)}
          onKeyDown={e => {
            if (e.key === 'Enter' || e.key === ' ') onOpenTask(item.taskId);
          }}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '6px 10px',
            borderRadius: 6,
            background: 'var(--color-muted)',
            cursor: 'pointer',
            border: '1px solid var(--color-border)',
          }}
        >
          {/* 排名序号 */}
          <Text type="secondary" style={{ fontSize: 11, width: 16, flexShrink: 0 }}>
            {idx + 1}
          </Text>
          <ThunderboltOutlined style={{ color: failureCountColor(item.failCount), fontSize: 12 }} />
          {/* 任务名（截断） */}
          <Text
            ellipsis
            style={{ fontSize: 12, fontWeight: 500, flex: 1, minWidth: 0, color: 'var(--color-foreground)' }}
          >
            {item.taskName}
          </Text>
          {/* 失败次数徽标（色阶） */}
          <span
            data-testid="failure-top-count"
            style={{
              fontSize: 11,
              fontWeight: 600,
              color: failureCountColor(item.failCount),
              flexShrink: 0,
            }}
          >
            {item.failCount} 次
          </span>
          {/* 最近失败时间 */}
          <Text type="secondary" style={{ fontSize: 11, flexShrink: 0 }}>
            {formatRelativeTime(item.lastFailedAt)}
          </Text>
        </div>
      ))}
    </div>
  );
}
