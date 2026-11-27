/* eslint-disable react-refresh/only-export-components --
 * 本文件默认导出面板组件，同时导出 isTerminalSession / sessionStatusLabel /
 * WorkbenchSessionView 供 WorkbenchPage 编排轮询与持状态；契约同源，
 * 拆文件只会制造一次无意义的间接层（对齐 MainLayout.tsx 的同款取舍）。 */
/**
 * UX-AUDIT / Writer B：工作台「运行我的草稿」结果的实时会话面板。
 *
 * 职责边界：
 *   · 本组件只消费 `getWorkbenchSession` 返回的视图数据并渲染，不发起创建/审批请求；
 *   · 轮询在 useWorkbenchSession 侧编排（2s 间隔、卸载清理、终态停止）；
 *   · 工具调用、审批项、产物均为白名单投影，不使用 args/result 全量正文。
 *
 * 诚实文案：启动会话是受限的起草会话，不是发布 SOP；状态由后端推进，
 * 前端不硬编码/锁定为 pending。
 */
import { Alert, Button, Card, Collapse, Space, Tag, Typography } from 'antd';
import { useTranslation } from 'react-i18next';
import '../../i18n';
import { sessionStatusLabel } from './statusLabel';

/** 与后端 status 取值对齐；未知状态照原样显示（不编造）。 */
const TERMINAL_STATUSES = new Set(['succeeded', 'failed', 'cancelled', 'waiting_input', 'completed']);

/** 兼容既有调用方：状态文案实现已统一收敛到 statusLabel.ts。 */
export { sessionStatusLabel };

export interface WorkbenchSessionView {
  sessionId: string;
  kind: string;
  status: string;
  stepCount: number;
  steps: Array<{ seq: number; role: string; contentPreview?: string | null; createdAt?: unknown }>;
  toolCallCount: number;
  toolCalls?: Array<{
    toolName: string;
    status: string;
    errorSummary?: string | null;
    createdAt?: unknown;
  }>;
  approvals: Record<string, number>;
  approvalItems?: Array<{
    approvalKey: string;
    toolName: string;
    status: string;
    reason?: string | null;
    decidedBy?: string | null;
    createdAt?: unknown;
    reviewUrl?: string | null;
  }>;
  artifacts: Array<{
    id: string;
    name: string;
    size: number;
    createdAt?: unknown;
    downloadUrl?: string | null;
  }>;
}

export function isTerminalSession(status: string): boolean {
  return TERMINAL_STATUSES.has(status);
}

/** 刷新恢复专用卡片：与 WorkbenchSessionAction 同构，但不依赖页面内表单锚点。 */
export function WorkbenchSessionRestoreCard({
  sessionId, session, error, starting, onStart,
}: {
  sessionId: string | null;
  session: WorkbenchSessionView | null;
  error: string | null;
  starting: boolean;
  onStart: () => void;
}) {
  const { t } = useTranslation();
  return (
    <Card
      size="small"
      title={<Typography.Text strong>{t('workbench.session.started')}</Typography.Text>}
      data-testid="workbench-session-restore-card"
      style={{ marginBottom: 16 }}
    >
      <div style={{ marginTop: 8 }}>
        <Typography.Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 6 }}>
          {t('workbench.runDraftHint')}
        </Typography.Text>
        <Button
          type="primary"
          data-testid="workbench-run-draft"
          loading={starting}
          disabled={!!sessionId}
          onClick={onStart}
        >
          {t('workbench.runDraft')}
        </Button>
        {error ? (
          <Alert
            type="error"
            showIcon
            style={{ marginTop: 8 }}
            title={error}
            action={
              <Button size="small" data-testid="workbench-session-retry" onClick={onStart}>
                {t('workbench.session.retry')}
              </Button>
            }
          />
        ) : null}
        {session ? <WorkbenchSessionPanel session={session} /> : null}
      </div>
    </Card>
  );
}

/** URL/localStorage 均失效时的显式恢复入口；只列服务端按当前用户过滤后的会话。 */
export function WorkbenchSessionListCard({
  sessions, state, error, onRestore, onReload,
}: {
  sessions: Array<{ sessionId: string; status: string; title?: string | null }>;
  state: string;
  error: string | null;
  onRestore: (id: string) => void;
  onReload: () => void;
}) {
  const { t } = useTranslation();
  if (sessions.length === 0 && state !== 'error') return null;
  return (
    <Card
      size="small"
      title={<Typography.Text strong>{t('sopFromVideo.sessions.pick')}</Typography.Text>}
      data-testid="workbench-session-list"
      style={{ marginBottom: 16 }}
    >
      {error ? (
        <Alert
          type="error"
          showIcon
          style={{ marginBottom: 8 }}
          title={error}
          action={
            <Button size="small" onClick={onReload}>
              {t('security.session.refresh')}
            </Button>
          }
        />
      ) : null}
      <Space orientation="vertical" size="small" style={{ width: '100%' }}>
        {sessions.map((item) => (
          <Button
            key={item.sessionId}
            type="text"
            data-testid="workbench-session-restore"
            onClick={() => onRestore(item.sessionId)}
          >
            {t('workbench.session.id', { id: item.sessionId })}
            {' · '}
            {t('workbench.session.status', { status: sessionStatusLabel(t, item.status) })}
          </Button>
        ))}
      </Space>
    </Card>
  );
}

export default function WorkbenchSessionPanel({ session }: { session: WorkbenchSessionView }) {
  const { t } = useTranslation();
  const statusLabel = sessionStatusLabel(t, session.status);
  const toolCalls = session.toolCalls ?? [];
  const approvalItems = session.approvalItems ?? [];

  return (
    <Card
      size="small"
      title={<Typography.Text strong>{t('workbench.session.started')}</Typography.Text>}
      data-testid="workbench-session-panel"
      style={{ marginTop: 12 }}
    >
      <Space orientation="vertical" size="small" style={{ width: '100%' }}>
        <div data-testid="workbench-session-id">{t('workbench.session.id', { id: session.sessionId })}</div>
        <div data-testid="workbench-session-status">
          {t('workbench.session.status', { status: statusLabel })}
          <Tag style={{ marginLeft: 8 }}>{statusLabel}</Tag>
        </div>
        {isTerminalSession(session.status) && (
          <Alert
            type={session.status === 'failed' ? 'warning' : 'info'}
            showIcon
            title={t('workbench.session.terminal', { status: statusLabel })}
          />
        )}
        <div data-testid="workbench-session-steps">
          <Collapse
            ghost
            size="small"
            items={[{
              key: 'steps',
              label: (
                <Space size={6} wrap>
                  <Typography.Text type="secondary">
                    {t('workbench.session.steps', { count: session.stepCount })}
                  </Typography.Text>
                  <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                    {t('workbench.session.stepsSummaryHint')}
                  </Typography.Text>
                </Space>
              ),
              children: session.steps.length > 0 ? (
                <div style={{ marginTop: 4 }}>
                  {session.steps.map((step) => (
                    <Typography.Paragraph key={step.seq} style={{ marginBottom: 2, fontSize: 12 }}>
                      <Typography.Text code>{step.seq}</Typography.Text> · {step.role} · {step.contentPreview}
                    </Typography.Paragraph>
                  ))}
                </div>
              ) : null,
            }]}
          />
        </div>
        <div data-testid="workbench-session-tool-calls">
          {t('workbench.session.toolCalls', { count: session.toolCallCount })}
          {toolCalls.length > 0 ? (
            <div style={{ marginTop: 4 }}>
              {toolCalls.map((call, i) => (
                <div
                  key={`${call.toolName}-${i}`}
                  data-testid="workbench-session-tool-call"
                  style={{ fontSize: 12 }}
                >
                  <Typography.Text code>{call.toolName}</Typography.Text>
                  {' · '}
                  <Tag>{call.status}</Tag>
                  {' · '}
                  <span data-testid="workbench-session-tool-error">{call.errorSummary || '-'}</span>
                </div>
              ))}
            </div>
          ) : null}
        </div>
        <div data-testid="workbench-session-approvals">
          {t('workbench.session.approvals', {
            pending: session.approvals.pending ?? 0,
            approved: session.approvals.approved ?? 0,
            denied: session.approvals.denied ?? 0,
          })}
          {approvalItems.length > 0 ? (
            <div style={{ marginTop: 4 }}>
              {approvalItems.map((item) => (
                <div
                  key={item.approvalKey}
                  data-testid="workbench-session-approval-item"
                  style={{ fontSize: 12 }}
                >
                  <Typography.Text code>{item.toolName}</Typography.Text>
                  {' · '}
                  <Tag>{item.status}</Tag>
                  {' · '}
                  <Typography.Text code>{item.approvalKey}</Typography.Text>
                  {item.reason ? ` · ${item.reason}` : ''}
                  {item.reviewUrl ? (
                    <Typography.Link
                      href={item.reviewUrl}
                      data-testid="workbench-session-approval-link"
                      style={{ marginLeft: 8 }}
                    >
                      {item.status}
                    </Typography.Link>
                  ) : null}
                </div>
              ))}
            </div>
          ) : null}
        </div>
        <div data-testid="workbench-session-artifacts">
          <Typography.Text type="secondary">{t('workbench.session.artifacts', { count: session.artifacts.length })}</Typography.Text>
          {session.artifacts.length > 0 ? (
            <div style={{ marginTop: 4 }}>
              {session.artifacts.map((a) => (
                <div key={a.id} style={{ fontSize: 12 }}>
                  {a.downloadUrl ? (
                    <Typography.Link
                      href={a.downloadUrl}
                      download={a.name}
                      data-testid="workbench-session-artifact-link"
                    >
                      {a.name}
                    </Typography.Link>
                  ) : (
                    <span>{a.name}</span>
                  )}
                  {' · '}
                  {a.size}B
                </div>
              ))}
            </div>
          ) : null}
        </div>
      </Space>
    </Card>
  );
}
