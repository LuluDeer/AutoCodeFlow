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
import { Alert, Button, Card, Descriptions, Space, Steps, Tag, Typography, theme } from 'antd';
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
  TIMELINE_PHASE_LABELS,
  type TimelineSource,
} from '../utils/execution-timeline';
import { failureReasonLabel } from '../utils/failure-reason-label';
import { formatDateTime, formatDuration } from '../utils/timeFormat';
import type { ExecutionReportPayload } from '../api/execution-reports';

/** TimelineSource 扩展：DB 记录耗时（毫秒），后端 execution 行原样携带 */
type PanelSource = TimelineSource & { duration?: number | null };

const { Text } = Typography;

const TERMINAL_OK = new Set(['success']);
const TERMINAL_BAD = new Set(['failed', 'timeout', 'killed', 'cancelled']);

/** 终态段图标/颜色：success 绿、failed 类红、运行中蓝、未知灰。
 * F-15（DEEP_REVIEW 0ef3bbe）：硬编码色改为 antd theme token（双主题自适应）。 */
function terminalMark(status: string | undefined | null, token: ReturnType<typeof theme.useToken>['token']): {
  icon: React.ReactNode;
  color?: string;
} {
  if (TERMINAL_OK.has(status || '')) {
    return { icon: <CheckCircleOutlined />, color: token.colorSuccess };
  }
  if (TERMINAL_BAD.has(status || '')) {
    return { icon: <CloseCircleOutlined />, color: token.colorError };
  }
  if (status === 'running' || status === 'pending') {
    return { icon: <ClockCircleOutlined />, color: token.colorPrimary };
  }
  return { icon: <MinusCircleOutlined /> };
}

export interface ExecutionReportPanelProps {
  /** 后端 report 端点一次性载荷（可能尚在加载） */
  payload?: ExecutionReportPayload | null;
  /** 加载失败信息（非致命：面板降级为时间线骨架仍可用） */
  loadError?: string | null;
  loading?: boolean;
  /** B3-②：重试链长度（页页由 buildRetryChain 派生）；缺省不渲染链元信息 */
  chainLength?: number;
  /** B3-②：跳转重试链 Tab 回调（无回调则不渲染「查看重试链」入口） */
  onShowRetry?: () => void;
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
  chainLength,
  onShowRetry,
}: ExecutionReportPanelProps) {
  const { t } = useTranslation();
  // F-15（DEEP_REVIEW 0ef3bbe）：语义色/背景走 antd token，暗色主题自适应。
  const { token } = theme.useToken();
  const raw = payload?.execution ?? {};
  const source: PanelSource = raw;
  const entries = buildExecutionTimeline(source);
  const step = currentStep(source);
  const report = payload?.report ?? null;

  // B3-②：失败点与重试链元信息——report 载荷携完整 execution 行（见后端
  // getExecutionReport），字段可能缺省/类型漂移，这里防御式归一为字符串/数字。
  const failureReason = typeof raw.failureReason === 'string' ? raw.failureReason : null;
  const errorMessage = typeof raw.errorMessage === 'string' ? raw.errorMessage : null;
  const retryCount = typeof raw.retryCount === 'number' ? raw.retryCount : null;
  const attempt = (retryCount ?? 0) + 1;
  const chainTotal = typeof chainLength === 'number' && chainLength > 0 ? chainLength : attempt;
  const showChainMeta = typeof chainLength === 'number' && chainLength > 1;

  return (
    <div data-testid="execution-report-panel">
      <Card
        title={t('reportPanel.title')}
        size="small"
        style={{ marginBottom: 16 }}
        loading={loading && !payload}
        extra={
          <Space size={8}>
            {showChainMeta && (
              <Text type="secondary" style={{ fontSize: 12 }} data-testid="timeline-attempt-meta">
                {t('reportPanel.attemptMeta', { attempt, total: chainTotal })}
              </Text>
            )}
            {onShowRetry && (
              <Button
                type="link"
                size="small"
                onClick={onShowRetry}
                data-testid="timeline-view-retry"
              >
                {t('reportPanel.viewRetryChain')}
              </Button>
            )}
          </Space>
        }
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
          orientation="vertical"
          size="small"
          current={step}
          items={entries.map((e) => {
            const isTerminal = e.phase === 'finished';
            const mark = isTerminal ? terminalMark(source.status, token) : { icon: undefined as React.ReactNode, color: undefined as string | undefined };
            const isBad = isTerminal && TERMINAL_BAD.has(source.status || '');
            return {
              title: TIMELINE_PHASE_LABELS(t)[e.phase],
              // B3-②：失败终态段步骤级错误高亮（红），与图标颜色双编码
              ...(isBad ? { status: 'error' as const } : {}),
              content: (
                <span data-testid={`timeline-${e.phase}`}>
                  {e.at ? formatDateTime(e.at) : '—'}
                  {e.detail ? (
                    <Text type="secondary" style={{ marginLeft: 8, fontSize: 12 }}>
                      {e.detail}
                    </Text>
                  ) : null}
                  {e.phase === 'started' && e.durationMs != null && (
                    <Text type="secondary" style={{ marginLeft: 8, fontSize: 12 }}>
                      {t('timeline.queueWait')} {formatDuration(e.durationMs, t)}
                    </Text>
                  )}
                  {e.phase === 'finished' && e.durationMs != null && (
                    <Text type="secondary" style={{ marginLeft: 8, fontSize: 12 }}>
                      {t('timeline.runDuration')} {formatDuration(e.durationMs, t)}
                    </Text>
                  )}
                  {isBad && (failureReason || errorMessage) && (
                    <div data-testid="timeline-failure-point" style={{ marginTop: 4 }}>
                      {failureReason && (
                        <Tag color="volcano">{failureReasonLabel(failureReason, t)}</Tag>
                      )}
                      {errorMessage && (
                        <Text type="danger" style={{ fontSize: 12, wordBreak: 'break-word' }}>
                          {errorMessage}
                        </Text>
                      )}
                    </div>
                  )}
                </span>
              ),
              ...(mark.color ? { icon: <span style={{ color: mark.color }}>{mark.icon}</span> } : {}),
            };
          })}
        />
        {source.duration != null && (
          <div style={{ marginTop: 12 }}>
            <Text type="secondary">{t('reportPanel.dbDuration')}</Text>
            <Text code>{formatDuration(source.duration, t)}</Text>
          </div>
        )}
      </Card>

      <Card
        title={t('reportPanel.aiTitle')}
        size="small"
        style={{ marginBottom: 16 }}
        styles={{ header: { background: `linear-gradient(90deg, ${token.colorPrimaryBg}, ${token.colorPrimaryBgHover})`, color: token.colorPrimary } }}
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
              {formatDuration(report.avgDurationMs, t)}
            </Descriptions.Item>
            <Descriptions.Item label={t('reportPanel.col.maxDuration')}>
              {formatDuration(report.maxDurationMs, t)}
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
