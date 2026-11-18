/**
 * P1-4 · 待办收件箱（统一入口）。
 *
 * 把原本分散在部署审批页、Agent 会话页、卡住徽标、积压徽标、队列停摆徽标里的
 * 待办收成一个页面：值班人一眼看到「现在有几件事在等我」，并能在本页直接
 * 批准 / 拒绝 / 接管恢复，或深链到原对象页看详情。
 *
 * 小节口径与诚实态见 `api/inbox.ts`：
 * - 每小节独立装载，失败小节保留 error 态可重试，不渲染成 0 条；
 * - 写动作走既有后端接口（ADMIN 门控 + 第二人规则由后端兜底），前端按 RBAC
 *   禁用无权限按钮；
 * - 最近失败只读跳转，不在本页处置。
 */
import { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Empty,
  Input,
  Modal,
  Space,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import { Link } from 'react-router-dom';
import { ReloadOutlined } from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import PageHeader from '../components/PageHeader';
import StateError from '../components/StateError';
import { Modal as ConfirmModal } from '../utils/modal';
import { message } from '../utils/toast';
import { showApiError } from '../utils/error';
import { agentApprovalStatusLabel } from '../utils/agent-label';
import { formatRelativeTime } from '../utils/timeFormat';
import { useAuthStore, isAdminUser } from '../store/auth';
import {
  INBOX_REFRESH_EVENT,
  deploymentsApi,
  agentApi,
  isSelfDeployment,
  loadInbox,
  sortInboxItemsByWaitingSince,
  type InboxItem,
  type InboxSectionKey,
  type InboxSections,
} from '../api/inbox';

const { Text, Paragraph } = Typography;

/** 页面渲染顺序（与 api/inbox.ts 的小节键一一对应）。 */
const SECTION_ORDER: InboxSectionKey[] = [
  'deployments',
  'agentApprovals',
  'agentWaiting',
  'stalled',
  'backlogged',
  'queueStall',
  'recentFailures',
];

const SECTION_TAG_COLOR: Record<InboxSectionKey, string> = {
  deployments: 'orange',
  agentApprovals: 'gold',
  agentWaiting: 'blue',
  stalled: 'red',
  backlogged: 'volcano',
  queueStall: 'magenta',
  recentFailures: 'default',
};

/** 只读参考小节（不提供处置动作）。 */
const READONLY_SECTIONS: ReadonlySet<InboxSectionKey> = new Set(['recentFailures']);

function dispatchInboxRefresh(): void {
  window.dispatchEvent(new Event(INBOX_REFRESH_EVENT));
}

/** 副标题本地化组合：提交者前缀 / 工具名 + 理由；API 层只回原始字段。 */
function inboxSubtitleText(item: InboxItem, t: ReturnType<typeof useTranslation>['t']): string | undefined {
  if (item.section === 'deployments' && item.subtitle) {
    return t('inbox.subtitle.requester', { name: item.subtitle });
  }
  if (item.section === 'agentApprovals') {
    const reason = item.approval?.reason;
    return item.subtitle ? `${item.subtitle}${reason ? ` · ${reason}` : ''}` : undefined;
  }
  return item.subtitle;
}

interface InboxRowActionsProps {
  item: InboxItem;
  canWrite: boolean;
  actingId: string | null;
  userId: number | null | undefined;
  onApprove: (item: InboxItem) => void;
  onReject: (item: InboxItem) => void;
  onDeny: (item: InboxItem) => void;
  onResume: (item: InboxItem) => void;
}

/** Agent 放行前须到审批页签核对工具参数；其余动作按小节、权限及可用性展示。 */
function InboxRowActions({
  item,
  canWrite,
  actingId,
  userId,
  onApprove,
  onReject,
  onDeny,
  onResume,
}: InboxRowActionsProps) {
  const { t } = useTranslation();

  if (READONLY_SECTIONS.has(item.section)) {
    return item.detailUrl ? (
      <Link to={item.detailUrl}>
        <Button size="small">{t('inbox.action.viewDetail')}</Button>
      </Link>
    ) : null;
  }

  const self = isSelfDeployment(item.deployment, userId ?? null);
  const writeDisabled = !canWrite || self || actingId === item.id;

  switch (item.section) {
    case 'deployments':
      return (
        <Space size={4} wrap>
          <Tooltip title={self ? t('inbox.selfApprovalHint') : undefined}>
            <Button
              size="small"
              type="primary"
              disabled={writeDisabled}
              loading={actingId === item.id}
              onClick={() => onApprove(item)}
            >
              {t('inbox.action.approve')}
            </Button>
          </Tooltip>
          <Button
            size="small"
            danger
            disabled={writeDisabled}
            loading={actingId === item.id}
            onClick={() => onReject(item)}
          >
            {t('inbox.action.reject')}
          </Button>
          {item.detailUrl && (
            <Link to={item.detailUrl}>
              <Button size="small">{t('inbox.action.viewDetail')}</Button>
            </Link>
          )}
        </Space>
      );
    case 'agentApprovals':
      return (
        <Space size={4} wrap>
          {item.detailUrl && <Link to={item.detailUrl}>{t('inbox.action.reviewApproval')}</Link>}
          <Button
            size="small"
            danger
            disabled={!canWrite || actingId === item.id}
            loading={actingId === item.id}
            onClick={() => onDeny(item)}
          >
            {t('inbox.action.deny')}
          </Button>
        </Space>
      );
    case 'agentWaiting':
    case 'stalled':
    case 'backlogged':
      return (
        <Space size={4} wrap>
          {item.canResume && (
            <Button
              size="small"
              type="primary"
              disabled={!canWrite || actingId === item.id}
              loading={actingId === item.id}
              onClick={() => onResume(item)}
            >
              {t('inbox.action.resume')}
            </Button>
          )}
          {item.detailUrl && <Link to={item.detailUrl}>{t('inbox.action.viewSession')}</Link>}
        </Space>
      );
    default:
      return null;
  }
}

export default function InboxPage() {
  const { t } = useTranslation();
  const user = useAuthStore((s) => s.user);
  const canWrite = isAdminUser(user);

  const [sections, setSections] = useState<InboxSections | null>(null);
  const [loading, setLoading] = useState(true);
  const [actingId, setActingId] = useState<string | null>(null);
  const [rejectTarget, setRejectTarget] = useState<InboxItem | null>(null);
  const [rejectReason, setRejectReason] = useState('');

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const next = await loadInbox();
      setSections(next);
    } catch (err) {
      showApiError(err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  // ── 写动作 ────────────────────────────────────────────────────────────────

  const confirmThen = (title: string, action: () => Promise<void>) => {
    ConfirmModal.confirm({
      title,
      okText: t('inbox.action.confirm'),
      cancelText: t('inbox.action.cancel'),
      onOk: async () => {
        try {
          await action();
        } catch (err) {
          showApiError(err);
          // 竞争后的 409 表示此行已变化：关闭旧确认框并重取，其他错误留在原位重试。
          if ((err as { __status?: number } | null)?.__status !== 409) throw err;
        }
        dispatchInboxRefresh();
        await reload();
      },
    });
  };

  const handleApprove = (item: InboxItem) => {
    const dep = item.deployment;
    if (!dep) return;
    confirmThen(t('inbox.approveConfirm.title', { title: item.title }), async () => {
      await deploymentsApi.approve(dep.id);
      message.success(t('inbox.success.approved'));
    });
  };

  const openReject = (item: InboxItem) => {
    setRejectTarget(item);
    setRejectReason('');
  };

  const confirmReject = async () => {
    const dep = rejectTarget?.deployment;
    if (!dep) return;
    setActingId(rejectTarget.id);
    try {
      await deploymentsApi.reject(dep.id, rejectReason.trim() || undefined);
      message.success(t('inbox.success.rejected'));
      dispatchInboxRefresh();
      setRejectTarget(null);
      await reload();
    } catch (err) {
      showApiError(err);
    } finally {
      setActingId(null);
    }
  };

  const handleDeny = ({ session, approval, title }: InboxItem) => {
    if (!session || !approval) return;
    confirmThen(t('inbox.denyConfirm.title', { title, tool: approval.toolName }), async () => {
      const result = await agentApi.denyApproval(session.id, approval.approvalKey);
      if (result.ok && result.approval.status === 'denied') {
        message.success(t('inbox.success.denied'));
      } else {
        message.warning(t('inbox.approvalState', { status: agentApprovalStatusLabel(result.approval.status, t) }));
      }
    });
  };

  const handleResume = ({ canResume, session, title }: InboxItem) => {
    if (!canResume || !session) return;
    confirmThen(t('inbox.resumeConfirm.title', { title }), async () => {
      const result = await agentApi.resume(session.id);
      if (result.ok) message.success(t('inbox.success.resumed'));
      else message.warning(result.reason || t('inbox.resumeNotQueued'));
    });
  };

  // ── 渲染 ────────────────────────────────────────────────────────────────────

  const totalReadyItems = sections
    ? SECTION_ORDER.reduce((acc, key) => acc + (sections[key].status === 'ready' ? sections[key].items.length : 0), 0)
    : 0;
  const anyError = sections ? SECTION_ORDER.some((key) => sections[key].status === 'error') : false;
  const allReady = sections ? SECTION_ORDER.every((key) => sections[key].status === 'ready') : false;
  const queueStall = sections?.queueStall.snapshot;

  const renderRow = (item: InboxItem) => {
    const subtitle = inboxSubtitleText(item, t);
    return (
    <div
      key={item.id}
      data-testid={`inbox-row-${item.section}`}
      style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'flex-start',
        gap: 12,
        flexWrap: 'wrap',
        padding: '10px 0',
        borderBottom: '1px solid var(--ant-color-border-secondary, #f0f0f0)',
      }}
    >
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
          <Text strong style={{ fontSize: 13 }}>
            {item.title}
          </Text>
          <Text type="secondary" style={{ fontSize: 12 }}>
            {item.section === 'stalled' ? t('inbox.inspectProgress') : item.waitingSince
              ? formatRelativeTime(item.waitingSince, t)
              : t('inbox.noTimeInfo')}
          </Text>
        </div>
        {subtitle && (
          <Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: 2 }}>
            {subtitle}
          </Text>
        )}
      </div>
      <Space wrap>
        <InboxRowActions
          item={item}
          canWrite={canWrite}
          actingId={actingId}
          userId={user?.id}
          onApprove={handleApprove}
          onReject={openReject}
          onDeny={handleDeny}
          onResume={handleResume}
        />
      </Space>
    </div>
    );
  };

  const renderSection = (key: InboxSectionKey) => {
    const section = sections?.[key];
    if (!section) return null;

    const title = (
      <Space size={8}>
        <Tag color={SECTION_TAG_COLOR[key]}>{t(`inbox.section.${key}`)}</Tag>
        <Text type="secondary" style={{ fontSize: 12 }}>
          {section.status === 'ready' ? `· ${section.items.length}` : ''}
        </Text>
      </Space>
    );

    return (
      <Card key={key} size="small" title={title} style={{ marginBottom: 16 }} data-testid={`inbox-section-${key}`}>
        {section.status === 'error' ? (
          <>
            <StateError
              error={section.error}
              title={key === 'agentApprovals' && section.items.length ? t('inbox.approvalsIncomplete') : t('inbox.loadFailed')}
              onRetry={() => void reload()}
            />
            {sortInboxItemsByWaitingSince(section.items).map(renderRow)}
          </>
        ) : key === 'queueStall' ? (
          queueStall ? (
            <Alert
              type={queueStall.stalled ? 'error' : queueStall.degraded ? 'warning' : 'success'}
              showIcon
              title={queueStall.stalled ? t('inbox.queueStall.stalled') : t('inbox.queueStall.ok')}
              description={
                <div>
                  {queueStall.reason && <Paragraph style={{ margin: '4px 0' }}>{queueStall.reason}</Paragraph>}
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    {t('inbox.queueStall.pendingJobs', { n: queueStall.pendingJobs })}
                    {queueStall.degraded ? ` · ${t('inbox.queueStall.degraded')}` : ''}
                  </Text>
                  <div style={{ marginTop: 8 }}>
                    <Link to="/agent-sessions">
                      {t('inbox.queueStall.viewSessions')}
                    </Link>
                  </div>
                </div>
              }
            />
          ) : (
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('inbox.empty.section')} />
          )
        ) : section.items.length === 0 ? (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('inbox.empty.section')} />
        ) : (
          sortInboxItemsByWaitingSince(section.items).map(renderRow)
        )}
      </Card>
    );
  };

  return (
    <div data-testid="inbox-page">
      <PageHeader
        title={t('inbox.title')}
        description={t('inbox.description')}
        extra={
          <Button icon={<ReloadOutlined />} onClick={() => void reload()} loading={loading}>
            {t('inbox.action.refresh')}
          </Button>
        }
      />

      {allReady && totalReadyItems === 0 && !queueStall?.stalled ? (
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description={
            <div>
              <Text strong>{t('inbox.empty.title')}</Text>
              <br />
              <Text type="secondary" style={{ fontSize: 12 }}>
                {t('inbox.empty.description')}
              </Text>
            </div>
          }
        />
      ) : (
        SECTION_ORDER.map(renderSection)
      )}

      {anyError && (
        <Text type="secondary" style={{ fontSize: 12 }}>
          {t('inbox.partialErrorHint')}
        </Text>
      )}

      <Modal
        open={!!rejectTarget}
        title={t('inbox.rejectConfirm.title')}
        okText={t('inbox.rejectConfirm.okText')}
        cancelText={t('inbox.action.cancel')}
        confirmLoading={actingId === rejectTarget?.id}
        onCancel={() => setRejectTarget(null)}
        onOk={() => void confirmReject()}
      >
        <Paragraph style={{ marginTop: 8 }}>
          {rejectTarget ? rejectTarget.title : ''}
        </Paragraph>
        <Input.TextArea
          rows={3}
          value={rejectReason}
          onChange={(e) => setRejectReason(e.target.value)}
          placeholder={t('inbox.rejectConfirm.reasonPlaceholder')}
        />
      </Modal>
    </div>
  );
}
