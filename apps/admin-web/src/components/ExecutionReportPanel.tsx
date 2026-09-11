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
import { useTranslation } from 'react-i18next';
import '../i18n';
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
  const { t } = useTranslation();
  const source: PanelSource = payload?.execution ?? {};
  const entries = buildExecutionTimeline(source);
  const step = currentStep(source);
  const report = payload?.report ?? null;

  return (
    <div data-testid="execution-report-panel">
      <Card
        title={t('reportPanel.title')}
        size="small"
        style={{ marginBottom: 16 }}
        loading={loading && !payload}
      >
        {loadError && (
          <Alert
            type="warning"
            showIcon
            title={t('reportPanel.loadFail')}
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
            <Text type="secondary">{t('reportPanel.dbDuration')}</Text>
            <Text code>{formatDuration(source.duration)}</Text>
          </div>
        )}
      </Card>

      <Card
        title={t('reportPanel.aiTitle')}
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
            {t('reportPanel.aiEmpty')}
          </Text>
        )}
      </Card>

      <Card title={t('reportPanel.reportTitle')} size="small">
        {report ? (
          <Descriptions
            column={{ xs: 1, sm: 2, md: 4 }}
            size="small"
            data-testid="report-row"
          >
            <Descriptions.Item label={t('reportPanel.col.reportDay')}>{report.triggerDay}</Descriptions.Item>
            <Descriptions.Item label={t('reportPanel.col.success')}>{report.successCount}</Descriptions.Item>
            <Descriptions.Item label={t('reportPanel.col.fail')}>{report.failCount}</Descriptions.Item>
            <Descriptions.Item label={t('reportPanel.col.timeout')}>{report.timeoutCount}</Descriptions.Item>
            <Descriptions.Item label={t('reportPanel.col.cancelled')}>{report.cancelledCount}</Descriptions.Item>
            <Descriptions.Item label={t('reportPanel.col.running')}>{report.runningCount}</Descriptions.Item>
            <Descriptions.Item label={t('reportPanel.col.avgDuration')}>
              {formatDuration(report.avgDurationMs)}
            </Descriptions.Item>
            <Descriptions.Item label={t('reportPanel.col.maxDuration')}>
              {formatDuration(report.maxDurationMs)}
            </Descriptions.Item>
          </Descriptions>
        ) : (
          <Text type="secondary" data-testid="report-empty">
              {t('reportPanel.reportEmpty')}
            </Text>
        )}
      </Card>
    </div>
  );
}
