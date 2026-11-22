/**
 * P1-4 · 顶栏「待办」入口徽标。
 *
 * 聚合部署审批 / Agent 待审批 / 等待输入 / **Agent 会话失败** / 卡住会话 /
 * 调度积压 / 队列停摆的轻量计数（只拉计数，不拉列表体）。点击进入 `/inbox`。
 *
 * ## R279：「会话失败 N」是第三个独立口径
 *
 * 失败会话**不进**会话去重求和（同一会话可能窗口内先 failed、修好后被重跑成
 * 其他状态，相加会重复计；且「先判断为什么失败」与「等你点同意」不是同一件事）。
 * 但它必须**单独可见**——否则「没建模的东西永远不出现」，运营根本不知道有这么回事。
 *
 * ## R278/D1：两个口径，措辞不同，都不能省
 *
 * 用户心智是「**有几件活**等我处置」＝审批单数，不是会话数。旧实现只有一个
 * `total`（按 waiting_input **会话**计），而列表按**审批单**行计——同一会话
 * 两张单时两者必然不等（U1：徽标 3、列表 7）。
 *
 * 现在：
 * - `待审批 N 单` —— 审批单数（服务端 `pendingApprovals`），**独立计数源**；
 * - `等待输入 M 会话` —— 会话数（服务端 `waitingSessions`），仍是会话口径；
 * - 徽标数字仍取**会话去重求和**（`summarizeInboxCounts` 把审批单排除在求和之外，
 *   避免同一会话被算两次），两个单位各自单独显示，不混成一个数。
 *
 * 诚实口径（沿用 PendingTakeoverBadge / BacklogBadge 的 R188–R203 纪律）：
 * - 任一计数源读不到 ⇒ 显示「—」（未知），不显示 0，也不用局部和谎报总数；
 * - 未知时徽标呈现可重试的错误态（红色文字按钮 + Tooltip）；
 * - 0 件时整体隐藏（不占顶栏位置）。
 */
import { useCallback, useEffect, useState } from 'react';
import { Badge, Button, Space, Tooltip } from 'antd';
import { MailOutlined } from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { INBOX_REFRESH_EVENT, loadInboxCounts, splitInboxCounts } from '../api/inbox';
import '../i18n';

type LoadState =
  | { status: 'loading' }
  | {
      status: 'ready';
      total: number | null;
      approvals: number | null;
      waiting: number | null;
      failed: number | null;
      /** R280：待人工答复的 SOP 澄清（独立计数源，不进求和）。 */
      sopClarifications: number | null;
      /** R286：阻塞工单（独立计数源，不进求和；`null` = 读不到 ⇒ 「—」）。 */
      sopBlocked: number | null;
    }
  | { status: 'error' };

/** 未知计数的统一占位（语言无关的 em dash；与下文字典词条成对，不可写成 0）。 */
const UNKNOWN = '—';

export default function InboxBadge() {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const [state, setState] = useState<LoadState>({ status: 'loading' });

  const applyCounts = useCallback((counts: Awaited<ReturnType<typeof loadInboxCounts>>) => {
    const { total, approvals, waiting, failed, sopClarifications, sopBlocked } = splitInboxCounts(counts);
    setState({ status: 'ready', total, approvals, waiting, failed, sopClarifications, sopBlocked });
  }, []);

  const reload = useCallback(async () => {
    setState({ status: 'loading' });
    try {
      applyCounts(await loadInboxCounts());
    } catch {
      // loadInboxCounts 内部已把整体失败吞成「全 null」；此处只兜 Promise 级异常。
      setState({ status: 'error' });
    }
  }, [applyCounts]);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    void (async () => {
      setState({ status: 'loading' });
      try {
        const counts = await loadInboxCounts(controller.signal);
        if (!cancelled) applyCounts(counts);
      } catch {
        if (!cancelled) setState({ status: 'error' });
      }
    })();
    const onRefresh = () => void reload();
    window.addEventListener(INBOX_REFRESH_EVENT, onRefresh);
    return () => {
      cancelled = true;
      controller.abort();
      window.removeEventListener(INBOX_REFRESH_EVENT, onRefresh);
    };
  }, [reload, applyCounts]);

  // 错误态：可见的可重试入口，不隐藏（隐藏会被误读成「没有待办」）。
  if (state.status === 'error') {
    return (
      <Tooltip title={t('inbox.badge.loadFailHint')}>
        <Button
          type="text"
          danger
          size="small"
          aria-label={t('inbox.badge.tooltip')}
          data-testid="inbox-badge-load-fail"
          onClick={() => void reload()}
        >
          <MailOutlined />
        </Button>
      </Tooltip>
    );
  }

  const total = state.status === 'ready' ? state.total : null;
  const approvals = state.status === 'ready' ? state.approvals : null;
  const waiting = state.status === 'ready' ? state.waiting : null;
  const failed = state.status === 'ready' ? state.failed : null;
  const sopClarifications = state.status === 'ready' ? state.sopClarifications : null;
  const sopBlocked = state.status === 'ready' ? state.sopBlocked : null;

  // 0 件隐藏；未知（null）也不挂假数字——点击进收件箱看分小节真实状态。
  // R278：审批单数未知（null 且总数已归零）时同样不占顶栏；未知态在 /inbox 页
  // 内以「—」+ 降级提示呈现（D3），顶栏位置不被一个不可知的数字长期占据。
  //
  // R279：失败会话数是**独立计数源**（不进求和）⇒ 它非 0/非未知时徽标必须出来，
  // 哪怕其余待办全清零。判断「要不要显示」时它是与审批单并列的第二个出场地。
  // R280：待答复澄清也是**独立计数源** ⇒ 与审批单/失败数并列的第三个出场地。
  if (state.status === 'ready' && total === 0) {
    const noApprovals = approvals === null || approvals === 0;
    const noFailures = failed === null || failed === 0;
    const noSopClarifications = sopClarifications === null || sopClarifications === 0;
    // R286：阻塞工单是第四个出场地——非 0/非未知时徽标必须出来。
    const noSopBlocked = sopBlocked === null || sopBlocked === 0;
    if (noApprovals && noFailures && noSopClarifications && noSopBlocked) return null;
  }

  const badgeContent = total === null ? UNKNOWN : total;
  // 三个单位分别显示：审批单是「件活」，会话是「条卡住的会话」，失败是「条已终止的
  // 会话」——措辞不可互换，也不可相加成「一共 N 件」。
  const approvalsText = t('inbox.badge.approvals', { n: approvals === null ? UNKNOWN : approvals });
  const waitingText = t('inbox.badge.waiting', { n: waiting === null ? UNKNOWN : waiting });
  // `0` = 事实为零 ⇒ 这一格不占位（与小节隐藏同款纪律）；`null` = 读不到 ⇒ 必须显示
  // 「会话失败 —」，否则「没读到的失败数」会被自己藏起来——那正是本轮要消灭的形态。
  const failedText = failed === 0 ? '' : t('inbox.badge.failedSessions', { n: failed === null ? UNKNOWN : failed });
  // R280：`0` = 事实为零 ⇒ 不占位；`null` = 读不到 ⇒ 必须显示「待答复澄清 —」。
  const sopText = sopClarifications === 0
    ? ''
    : t('inbox.badge.sopClarifications', { n: sopClarifications === null ? UNKNOWN : sopClarifications });
  // R286：`0` = 事实为零 ⇒ 不占位；`null` = 读不到 ⇒ 必须显示「阻塞工单 —」。
  const sopBlockedText = sopBlocked === 0
    ? ''
    : t('inbox.badge.sopBlocked', { n: sopBlocked === null ? UNKNOWN : sopBlocked });
  const known = approvals !== null && waiting !== null && failed !== null
    && sopClarifications !== null && sopBlocked !== null;
  const unitText = [approvalsText, waitingText, failedText, sopText, sopBlockedText].filter(Boolean).join(' · ');

  return (
    <Tooltip title={`${t('inbox.badge.tooltip')} · ${unitText}`}>
      <Space size={4} align="center" data-testid="inbox-badge" data-degraded={known ? undefined : 'true'}>
        <Badge count={badgeContent} size="small">
          <Button
            type="text"
            size="small"
            aria-label={`${t('inbox.badge.tooltip')} · ${unitText}`}
            data-testid="inbox-badge-button"
            onClick={() => navigate('/inbox')}
          >
            <MailOutlined />
          </Button>
        </Badge>
        <span className="inbox-badge-units" data-testid="inbox-badge-units" style={{ fontSize: 12, whiteSpace: 'nowrap' }}>
          <span data-testid="inbox-badge-approvals">{approvalsText}</span>
          <span data-testid="inbox-badge-sep" aria-hidden="true">{t('common.listSep.space')}</span>
          <span data-testid="inbox-badge-waiting">{waitingText}</span>
          {failedText && (
            <>
              <span data-testid="inbox-badge-sep2" aria-hidden="true">{t('common.listSep.space')}</span>
              <span data-testid="inbox-badge-failed">{failedText}</span>
            </>
          )}
          {sopText && (
            <>
              <span data-testid="inbox-badge-sep3" aria-hidden="true">{t('common.listSep.space')}</span>
              <span data-testid="inbox-badge-sop-clarifications">{sopText}</span>
            </>
          )}
          {sopBlockedText && (
            <>
              <span data-testid="inbox-badge-sep4" aria-hidden="true">{t('common.listSep.space')}</span>
              <span data-testid="inbox-badge-sop-blocked">{sopBlockedText}</span>
            </>
          )}
        </span>
      </Space>
    </Tooltip>
  );
}