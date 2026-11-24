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
import { CheckCircleOutlined, CloseCircleOutlined, ThunderboltOutlined } from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import { formatRelativeTime } from '../../utils/timeFormat';
import { CHART_COLORS } from '../../theme/tokens';
// UI-10：导入 i18n 实例（模块副作用完成初始化；树内用 useTranslation 读 key）
import '../../i18n';
// UX-03：failureCountColor 挪至 ./color-tokens（react-refresh 收敛：组件文件
// 仅保留组件导出；色阶纯函数零 React 依赖，外部消费方仅色阶测试）。
import { failureCountColor } from './color-tokens';

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

/** 按任务聚合失败记录：次数降序 → 最近失败时间降序；仅本文件使用，不再导出
 *  （src 内无导入方；行为经由 FailureTopList 渲染结果被测试覆盖）。
 *  unknownError 为无错误原文时的兜底文案（N-04 收尾：改为必传——唯一调用方
 *  传 t('failureTop.unknown')，缺省中文兜底会绕过语言切换）。 */
function aggregateFailureTop(
  failures: { id: string; taskId: string; taskName: string; errorMessage: string; createdAt: string }[] | undefined,
  topN: number,
  unknownError: string,
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
        lastError: f.errorMessage || unknownError,
      });
      continue;
    }
    prev.failCount += 1;
    if (new Date(f.createdAt).getTime() > new Date(prev.lastFailedAt).getTime()) {
      prev.lastFailedAt = f.createdAt;
      prev.lastError = f.errorMessage || unknownError;
    }
  }
  return Array.from(byTask.values())
    .sort((a, b) => b.failCount - a.failCount || new Date(b.lastFailedAt).getTime() - new Date(a.lastFailedAt).getTime())
    .slice(0, topN);
}

interface FailureTopListProps {
  failures: Parameters<typeof aggregateFailureTop>[0];
  topN?: number;
  onOpenTask: (taskId: string) => void;
  /** READ-HONESTY：榜单数据源读失败。此时空态是「没读到」，绝不能冒充「近期无失败」的绿色健康态。 */
  readFailed?: boolean;
}

/** 榜单行高（紧凑榜） */
const ROW_GAP = 8;

export default function FailureTopList({ failures, topN = 5, onOpenTask, readFailed = false }: FailureTopListProps) {
  const { t } = useTranslation();
  const top = aggregateFailureTop(failures, topN, t('failureTop.unknown'));
  // READ-HONESTY：读失败优先于空数组判定——「0 条」与「没读到」是两件事，
  // 后者必须说读取失败并给出重试提示，不渲染绿色对勾健康态。
  if (readFailed) {
    return (
      <div
        data-testid="failure-top-read-failed"
        style={{
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          textAlign: 'center',
          padding: '24px 0',
          fontSize: 12,
        }}
      >
        <CloseCircleOutlined style={{ fontSize: 28, color: CHART_COLORS.failed, marginBottom: 8 }} />
        <Text type="danger">{t('failureTop.readFailed')}</Text>
      </div>
    );
  }
  if (top.length === 0) {
    return (
      <div
        data-testid="failure-top-empty"
        style={{
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          textAlign: 'center',
          padding: '24px 0',
          color: 'var(--chart-axis-text)',
          fontSize: 12,
        }}
      >
        <CheckCircleOutlined style={{ fontSize: 28, color: CHART_COLORS.success, marginBottom: 8 }} />
        <div>{t('failureTop.empty')}</div>
      </div>
    );
  }
  return (
    <div data-testid="failure-top-list" style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: ROW_GAP }}>
      {top.map((item, idx) => (
        <div
          key={item.taskId}
          data-testid="failure-top-row"
          role="button"
          tabIndex={0}
          title={item.lastError}
          onClick={() => onOpenTask(item.taskId)}
          onKeyDown={e => {
            if (e.key === 'Enter' || e.key === ' ') {
              // T2（P3）：Space 默认滚动页面（role=button 不自带按钮默认行为），
              // 与 TaskDependencyGraph 的键盘导航同款先阻止默认再触发。
              if (e.key === ' ') e.preventDefault();
              onOpenTask(item.taskId);
            }
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
            {t('failureTop.count', { count: item.failCount })}
          </span>
          {/* 最近失败时间 */}
          <Text type="secondary" style={{ fontSize: 11, flexShrink: 0 }}>
            {formatRelativeTime(item.lastFailedAt, t)}
          </Text>
        </div>
      ))}
    </div>
  );
}
