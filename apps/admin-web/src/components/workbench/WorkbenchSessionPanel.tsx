/* eslint-disable react-refresh/only-export-components --
 * 本文件默认导出面板组件，同时导出 isTerminalSession / sessionStatusLabel /
 * WorkbenchSessionView 供 WorkbenchPage 编排轮询与持状态；契约同源，
 * 拆文件只会制造一次无意义的间接层（对齐 MainLayout.tsx 的同款取舍）。 */
/**
 * UX-AUDIT / Writer B：工作台「运行我的草稿」结果的实时会话面板。
 *
 * 职责边界：
 *   · 本组件只消费 `getWorkbenchSession` 返回的视图数据并渲染，不发起创建请求；
 *   · 轮询在 WorkbenchPage 侧编排（2s 间隔、卸载清理、终态停止），
 *     本组件只展示「当前快照 + 终态提示」。
 *
 * 诚实文案：启动会话是**受限的起草会话**，不是发布 SOP；状态由后端推进，
 * 前端不硬编码/锁定为 pending。
 */
import { Alert, Card, Space, Tag, Typography } from 'antd';
import { useTranslation } from 'react-i18next';
import '../../i18n';


/** 与后端 status 取值对齐；未知状态照原样显示（不编造）。 */
const TERMINAL_STATUSES = new Set(['succeeded', 'failed', 'cancelled', 'waiting_input', 'completed']);

/** 状态 → 字面文案（字面 t() 分支，避免动态 t(key) 被 i18n 缺键守卫判不可判）。 */
export function sessionStatusLabel(t: (k: string) => string, status: string): string {
  switch (status) {
    case 'pending': return t('workbench.session.status.pending');
    case 'running': return t('workbench.session.status.running');
    case 'succeeded':
    case 'completed': return t('workbench.session.status.succeeded');
    case 'failed': return t('workbench.session.status.failed');
    case 'waiting_input': return t('workbench.session.status.waiting_input');
    case 'cancelled': return t('workbench.session.status.cancelled');
    default: return status;
  }
}

export interface WorkbenchSessionView {
  sessionId: string;
  kind: string;
  status: string;
  stepCount: number;
  steps: Array<{ seq: number; role: string; contentPreview: string; createdAt: string }>;
  toolCallCount: number;
  approvals: Record<string, number>;
  artifacts: Array<{ id: string; name: string; size: number; createdAt: string }>;
}

export function isTerminalSession(status: string): boolean {
  return TERMINAL_STATUSES.has(status);
}

export default function WorkbenchSessionPanel({ session }: { session: WorkbenchSessionView }) {
  const { t } = useTranslation();
  const statusLabel = sessionStatusLabel(t, session.status);

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
          <Typography.Text type="secondary">{t('workbench.session.steps', { count: session.stepCount })}</Typography.Text>
          {session.steps.length > 0 ? (
            <div style={{ marginTop: 4 }}>
              {session.steps.map((step) => (
                <Typography.Paragraph key={step.seq} style={{ marginBottom: 2, fontSize: 12 }}>
                  <Typography.Text code>{step.seq}</Typography.Text> · {step.role} · {step.contentPreview}
                </Typography.Paragraph>
              ))}
            </div>
          ) : null}
        </div>
        <div data-testid="workbench-session-tool-calls">
          {t('workbench.session.toolCalls', { count: session.toolCallCount })}
        </div>
        <div data-testid="workbench-session-approvals">
          {t('workbench.session.approvals', {
            pending: session.approvals.pending ?? 0,
            approved: session.approvals.approved ?? 0,
            denied: session.approvals.denied ?? 0,
          })}
        </div>
        <div data-testid="workbench-session-artifacts">
          <Typography.Text type="secondary">{t('workbench.session.artifacts', { count: session.artifacts.length })}</Typography.Text>
          {session.artifacts.length > 0 ? (
            <div style={{ marginTop: 4 }}>
              {session.artifacts.map((a) => (
                <div key={a.id} style={{ fontSize: 12 }}>{a.name} · {a.size}B</div>
              ))}
            </div>
          ) : null}
        </div>
      </Space>
    </Card>
  );
}
