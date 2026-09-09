/**
 * OBS-04: 「分析报告 / 时间线」面板（纯展示组件，数据由父页面注入——
 * 便于在 ExecutionDetailPage 最小插入之外独立测试；本文件是 OBS-04 的
 * 核心新增面，不与并行会话足迹重叠）。
 *
 * 三段内容：
 * 1. 时间线（antd Steps）：pending → dispatch(running) → terminal，各段
 *    时刻直接渲染后端从 DB 时间戳映射的 ISO 串；at=null 显示「—」。
 * 2. AI 分析：execution.aiAnalysis 等宽/预换行文本，无内容时降级提示。
 * 3. 报告（execution_reports 当日聚合）：仅 report 行存在时渲染；
 *    null 为正常态（该表按日聚合、懒生成），显示提示行而非错误。
 */
import { Alert, Card, Descriptions, Steps, Typography } from 'antd';
import {
  CheckCircleOutlined,
  ClockCircleOutlined,
  MinusCircleOutlined,
  CloseCircleOutlined,
} from '@ant-design/icons';
import {
  buildExecutionTimeline,
  TIMELINE_PHASE_LABEL,
  type TimelineSource,
} from '../utils/execution-timeline';
import { formatDateTime, formatDuration } from '../utils/timeFormat';
import type { ExecutionReportPayload } from '../api/execution-reports';

/** TimelineSource 扩展：DB 记录耗时（毫秒），后端 execution 行原样携带 */
type PanelSource = TimelineSource & { duration?: number | null };

const { Text } = Typography;

const TERMINAL_OK = new Set(['success']);
const TERMINAL_BAD = new Set(['failed', 'timeout', 'killed', 'cancelled']);

/** 终态段图标/颜色：success 绿、failed 类红、运行中蓝、未知灰 */
function terminalMark(status?: string | null): {
  icon: React.ReactNode;
  color?: string;
} {
  if (TERMINAL_OK.has(status || '')) {
    return { icon: <CheckCircleOutlined />, color: '#52c41a' };
  }
  if (TERMINAL_BAD.has(status || '')) {
    return { icon: <CloseCircleOutlined />, color: '#ff4d4f' };
  }
  if (status === 'running' || status === 'pending') {
    return { icon: <ClockCircleOutlined />, color: '#1677ff' };
  }
  return { icon: <MinusCircleOutlined /> };
}

export interface ExecutionReportPanelProps {
  /** 后端 report 端点一次性载荷（可能尚在加载） */
  payload?: ExecutionReportPayload | null;
  /** 加载失败信息（非致命：面板降级为时间线骨架仍可用） */
  loadError?: string | null;
  loading?: boolean;
}

/** 当前时间线进度（Steps current）：终态=2，运行中=1，pending=0 */
function currentStep(source: TimelineSource): number {
  if (source.endTime) return 2;
  if (source.startTime) return 1;
  return 0;
}

export default function ExecutionReportPanel({
  payload,
  loadError,
  loading,
}: ExecutionReportPanelProps) {
  const source: PanelSource = payload?.execution ?? {};
  const entries = buildExecutionTimeline(source);
  const step = currentStep(source);
  const report = payload?.report ?? null;

  return (
    <div data-testid="execution-report-panel">
      <Card
        title="执行时间线"
        size="small"
        style={{ marginBottom: 16 }}
        loading={loading && !payload}
      >
        {loadError && (
          <Alert
            type="warning"
            showIcon
            title="报告数据加载失败，时间线由执行详情字段本地映射"
            description={loadError}
            style={{ marginBottom: 12 }}
          />
        )}
        <Steps
          direction="vertical"
          size="small"
          current={step}
          items={entries.map((e) => {
            const isTerminal = e.phase === 'finished';
            const mark = isTerminal ? terminalMark(source.status) : { icon: undefined as React.ReactNode, color: undefined as string | undefined };
            return {
              title: TIMELINE_PHASE_LABEL[e.phase],
              description: (
                <span data-testid={`timeline-${e.phase}`}>
                  {e.at ? formatDateTime(e.at) : '—'}
                  {e.detail ? (
                    <Text type="secondary" style={{ marginLeft: 8, fontSize: 12 }}>
                      {e.detail}
                    </Text>
                  ) : null}
                </span>
              ),
              ...(mark.color ? { icon: <span style={{ color: mark.color }}>{mark.icon}</span> } : {}),
            };
          })}
        />
        {source.duration != null && (
          <div style={{ marginTop: 12 }}>
            <Text type="secondary">DB 记录耗时：</Text>
            <Text code>{formatDuration(source.duration)}</Text>
          </div>
        )}
      </Card>

      <Card
        title="🤖 AI 故障分析"
        size="small"
        style={{ marginBottom: 16 }}
        styles={{ header: { background: 'linear-gradient(90deg, #e6f7ff, #f0f5ff)', color: '#1677ff' } }}
      >
        {payload?.execution?.aiAnalysis ? (
          <pre
            style={{
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              margin: 0,
              fontSize: 13,
              lineHeight: 1.7,
              fontFamily: "'Consolas', 'Monaco', 'Courier New', monospace",
            }}
          >
            {payload.execution.aiAnalysis}
          </pre>
        ) : (
          <Text type="secondary">
            暂无 AI 分析——失败/超时执行可在详情页工具栏点击「AI 分析」生成。
          </Text>
        )}
      </Card>

      <Card title="当日执行报告（execution_reports）" size="small">
        {report ? (
          <Descriptions
            column={{ xs: 1, sm: 2, md: 4 }}
            size="small"
            data-testid="report-row"
          >
            <Descriptions.Item label="报告日">{report.triggerDay}</Descriptions.Item>
            <Descriptions.Item label="成功">{report.successCount}</Descriptions.Item>
            <Descriptions.Item label="失败">{report.failCount}</Descriptions.Item>
            <Descriptions.Item label="超时">{report.timeoutCount}</Descriptions.Item>
            <Descriptions.Item label="取消">{report.cancelledCount}</Descriptions.Item>
            <Descriptions.Item label="运行中">{report.runningCount}</Descriptions.Item>
            <Descriptions.Item label="平均耗时">
              {formatDuration(report.avgDurationMs)}
            </Descriptions.Item>
            <Descriptions.Item label="最长耗时">
              {formatDuration(report.maxDurationMs)}
            </Descriptions.Item>
          </Descriptions>
        ) : (
          <Text type="secondary" data-testid="report-empty">
            当日暂无聚合报告——报告按天由平台统计任务生成，缺行属正常状态，不影响上方时间线与分析。
          </Text>
        )}
      </Card>
    </div>
  );
}
