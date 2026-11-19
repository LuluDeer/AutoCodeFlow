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
  SECTION_PAGE_SIZE,
  NOTICE_TESTID,
  isInboxAllClear,
  isSectionVisible,
  noticeTitle,
  emptySectionReason,
  sectionCountLabel,
  sectionNotices,
  sectionWindowLabel,
  deploymentsApi,
  agentApi,
  isSelfDeployment,
  loadInbox,
  sortInboxItemsByWaitingSince,
  type InboxItem,
  type InboxSectionKey,
  type InboxSectionState,
  type InboxSections,
} from '../api/inbox';

const { Text, Paragraph } = Typography;

/** 页面渲染顺序（与 api/inbox.ts 的小节键一一对应）。 */
const SECTION_ORDER: InboxSectionKey[] = [
  'deployments',
  'agentApprovals',
  'agentWaiting',
  // R279：紧跟等待输入——两者是「Agent 会话出了状况」的连续视角（还在等 / 已终止）。
  'agentFailures',
  // R280：「升级到人工」是 Agent 串出状况后的**第三站**（机器答不了，要你上）。
  'sopClarifications',
  'stalled',
  'backlogged',
  'queueStall',
  'recentFailures',
];

const SECTION_TAG_COLOR: Record<InboxSectionKey, string> = {
  deployments: 'orange',
  agentApprovals: 'gold',
  agentWaiting: 'blue',
  agentFailures: 'red',
  sopClarifications: 'purple',
  stalled: 'red',
  backlogged: 'volcano',
  queueStall: 'magenta',
  recentFailures: 'default',
};

/**
 * 只读参考小节（不提供处置动作，只给详情深链）。
 *
 * R279：`agentFailures` 也是只读——失败会话的处置（改配置 / 改预算 / 重跑）在会话
 * 详情页做，不在收件箱点按钮：同一行可能是配置问题、也可能是个例，收件箱不该替
 * 运营猜是哪一个（brief D4）。放行动作只有「去会话详情」。
 *
 * R280：`sopClarifications` 同样只读——答复澄清要看到 SOP 版本/上下文（该页的
 * 答复弹窗），本页只给「去哪个 SOP 看」的深链，不在这里猜答复方式。
 */
const READONLY_SECTIONS: ReadonlySet<InboxSectionKey> = new Set([
  'recentFailures',
  'agentFailures',
  'sopClarifications',
]);

function dispatchInboxRefresh(): void {
  window.dispatchEvent(new Event(INBOX_REFRESH_EVENT));
}

/** 副标题本地化组合：提交者前缀 / 工具名 + 理由；API 层只回原始字段。 */
/**
 * 主标题的本地化组合（API 层只回原始字段）。
 *
 * R280：澄清行的标题是执行器的**原始疑问**，可能是空串（`question` 未记录）——
 * 空标题会被读成「标题渲染坏了」，所以这里显式说「未记录原文」而不是留白。
 */
function inboxTitleText(item: InboxItem, t: ReturnType<typeof useTranslation>['t']): string {
  if (item.section === 'sopClarifications' && !item.title.trim()) {
    return t('inbox.sop.noQuestion');
  }
  return item.title;
}

function inboxSubtitleText(item: InboxItem, t: ReturnType<typeof useTranslation>['t']): string | undefined {
  if (item.section === 'deployments' && item.subtitle) {
    return t('inbox.subtitle.requester', { name: item.subtitle });
  }
  if (item.section === 'agentApprovals') {
    const reason = item.approval?.reason;
    return item.subtitle ? `${item.subtitle}${reason ? ` · ${reason}` : ''}` : undefined;
  }
  // R279/D4：失败原因**必须一眼可见**。会话没记 errorMessage 时明确说出来——
  // 留白会被读成「没有原因」和「读取失败」中不确切的那一个。
  if (item.section === 'agentFailures') return item.subtitle ?? t('inbox.failed.noReason');
  // R280：`SOP 名 · 第 N 轮`。SOP 名读不到（`sopName: null`）⇒ 「（未命名 SOP）」，
  // **绝不退回 uuid**——一串十六进制对运营没有任何信息量，还会被误读成「已定位」。
  if (item.section === 'sopClarifications') {
    const c = item.clarification;
    if (!c) return item.subtitle;
    const name = c.sopName ?? t('inbox.sop.unnamed');
    return `${name} · ${t('inbox.sop.round', { round: c.round })}`;
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

/**
 * 空列表时的措辞（四种形态的唯一翻译出口，判定在 `api/inbox.emptySectionReason`）。
 *
 * ①「本类暂无待办」只有在**确认清零**时才说；②③ 是「有 N 条但不在下方」的两种成因
 * （口径差 / 未被装配出来），④ 是「读不到」——四种说成一句话就是结论错。
 */
function emptySectionText(section: InboxSectionState, t: ReturnType<typeof useTranslation>['t']): string {
  const reason = emptySectionReason(section);
  switch (reason.kind) {
    case 'unknown':
      return t('inbox.empty.unknownSection');
    case 'budgetExcluded':
      return t('inbox.failed.pendingBeyondRows', { n: reason.n });
    case 'beyondRows':
      // 措辞按小节选：失败会话那边是「预算耗尽」，澄清这边是「行没装配出来」——
      // 同一句数字、两种成因，说错成因等于给运营一条错线索。
      return section.key === 'sopClarifications'
        ? t('inbox.sop.pendingBeyondRows', { n: reason.n })
        : t('inbox.empty.pendingBeyondRows', { n: reason.n });
    default:
      return t('inbox.empty.section');
  }
}

interface InboxRowProps {
  item: InboxItem;
  canWrite: boolean;
  actingId: string | null;
  userId: number | null | undefined;
  onApprove: (item: InboxItem) => void;
  onReject: (item: InboxItem) => void;
  onDeny: (item: InboxItem) => void;
  onResume: (item: InboxItem) => void;
}

/**
 * 一行待办的版式（标题 / 时间 / 副标题 + 右侧动作）。
 *
 * 为什么是模块级组件而不是页面里的局部闭包：页面组件体是 `check:size-caps` 的
 * 度量单元（单函数 > 300 行 ⇒ 红）。R279 加第八个小节后它已到 296 行——离红线
 * 只剩 4 行，下一个加个小节的人会先撞墙再拆，那时改动面已经更大。
 * 外提的是**纯版式**：动作回调仍由页面注入，`InboxRowActions` 的权限/动作块一行未动。
 */
function InboxRow({ item, canWrite, actingId, userId, onApprove, onReject, onDeny, onResume }: InboxRowProps) {
  const { t } = useTranslation();
  const subtitle = inboxSubtitleText(item, t);
  const title = inboxTitleText(item, t);
  return (
    <div
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
            {title}
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
          userId={userId}
          onApprove={onApprove}
          onReject={onReject}
          onDeny={onDeny}
          onResume={onResume}
        />
      </Space>
    </div>
  );
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

  const anyError = sections ? SECTION_ORDER.some((key) => sections[key].status === 'error') : false;
  // R278/D3 + R279：「清零」必须是被证实的事实。四条判据（全 ready / 计数已知 /
  // 队列未停摆 / 没有「只计入总数却没行」的待办）收在 api/inbox.isInboxAllClear
  // 里——页面只读一个布尔，判定不再散落在组件体里（check:size-caps 是结构闸）。
  const allClear = sections ? isInboxAllClear(sections) : false;
  const queueStall = sections?.queueStall.snapshot;

  // 行的 JSX 已外提为模块级 `InboxRow`（与 `InboxRowActions` 同理）：这里是
  // 「把已有动作回调绑到当前身份/权限上」的唯一接线点，不再持有 40 行版式。
  const renderRow = (item: InboxItem) => (
    <InboxRow
      key={item.id}
      item={item}
      canWrite={canWrite}
      actingId={actingId}
      userId={user?.id}
      onApprove={handleApprove}
      onReject={openReject}
      onDeny={handleDeny}
      onResume={handleResume}
    />
  );

  const renderSection = (key: InboxSectionKey) => {
    const section = sections?.[key];
    if (!section) return null;
    // R279/D1：`agentFailures` 的 0 是**事实**（隐藏）；null 是**读不到**（保留并显示「—」）。
    // 判定在 api/inbox.isSectionVisible，其余七个小节恒为 true（既有交付面不动）。
    if (!isSectionVisible(section)) return null;

    const title = (
      <Space size={8}>
        <Tag color={SECTION_TAG_COLOR[key]}>{t(`inbox.section.${key}`)}</Tag>
        <Text type="secondary" style={{ fontSize: 12 }} data-testid={`inbox-count-${key}`}>
          {sectionCountLabel(section, t)}
          {sectionWindowLabel(section, t)}
        </Text>
      </Space>
    );

    return (
      <Card key={key} size="small" title={title} style={{ marginBottom: 16 }} data-testid={`inbox-section-${key}`}>
        {/* R278/D2+D3：截断 / 未知 / 降级 / 上限四条告警的判定全在 api/inbox.ts 的纯函数里。 */}
        {sectionNotices(section, SECTION_PAGE_SIZE).map((notice) => (
          <Alert
            key={notice}
            type="warning"
            showIcon
            style={{ marginBottom: 8 }}
            data-testid={NOTICE_TESTID[notice](key)}
            title={noticeTitle(notice, section, t)}
          />
        ))}
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
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description={
              // 总数读不到 / 降级 ⇒ 不能把空列表说成「本类暂无待办」。
              // 注：`agentFailures` 的专属措辞由标题上方的 unknown 告警承担
              // （`noticeTitle` 对失败小节返回 inbox.failed.unknownHint）——同一件事
              // 在同一个卡片里说两遍不会更清楚，只会把两条告警挤在一起。
              // R279 补充：还有第五种情形 —— **计数>0 但一行都没有**（`budget_exceeded`
              // 只进计数、不进行列表）。这时既不能说「暂无」（有 N 条待处理），也不能
              // 只说「读不到」（读到了，是 5）。所以这一格单独说清「几条、为什么不在下方」，
              // 否则 `isInboxAllClear` 因为这个差值判「未清零」，而页面上看不到原因。
              emptySectionText(section, t)
            }
          />
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

      {allClear ? (
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
