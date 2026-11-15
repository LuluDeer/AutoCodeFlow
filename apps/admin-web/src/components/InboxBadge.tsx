/**
 * P1-4 · 顶栏「待办」入口徽标。
 *
 * 聚合部署审批 / Agent 待审批 / 等待输入 / 卡住会话 / 调度积压 / 队列停摆六类
 * 待办的轻量计数（只拉计数，不拉列表体）。点击进入 `/inbox` 统一收件箱。
 *
 * 诚实口径（沿用 PendingTakeoverBadge / BacklogBadge 的 R188–R203 纪律）：
 * - 任一计数源读不到 ⇒ 汇总为「未知」：不显示 0，也不用局部和谎报总数；
 * - 未知时徽标呈现可重试的错误态（红色文字按钮 + Tooltip）；
 * - 0 件时整体隐藏（不占顶栏位置）。
 */
import { useCallback, useEffect, useState } from 'react';
import { Badge, Button, Tooltip } from 'antd';
import { MailOutlined } from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { INBOX_REFRESH_EVENT, loadInboxCounts, summarizeInboxCounts } from '../api/inbox';
import '../i18n';

type LoadState =
  | { status: 'loading' }
  | { status: 'ready'; total: number | null }
  | { status: 'error' };

export default function InboxBadge() {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const [state, setState] = useState<LoadState>({ status: 'loading' });

  const reload = useCallback(async () => {
    setState({ status: 'loading' });
    try {
      const counts = await loadInboxCounts();
      setState({ status: 'ready', total: summarizeInboxCounts(counts) });
    } catch {
      // loadInboxCounts 内部已把各源吞成 null；此处只兜 Promise 级异常。
      setState({ status: 'error' });
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    void (async () => {
      setState({ status: 'loading' });
      try {
        const counts = await loadInboxCounts(controller.signal);
        if (!cancelled) setState({ status: 'ready', total: summarizeInboxCounts(counts) });
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
  }, [reload]);

  // 错误态：可见的可重试入口，不隐藏（隐藏会被误读成「没有待办」）。
  if (state.status === 'error') {
    return (
      <Tooltip title={t('inbox.badge.loadFailHint')}>
        <Button
          type="text"
          danger
          size="small"
          data-testid="inbox-badge-load-fail"
          onClick={() => void reload()}
        >
          <MailOutlined />
        </Button>
      </Tooltip>
    );
  }

  const total = state.status === 'ready' ? state.total : null;

  // 0 件隐藏；未知（null）也不挂假数字——点击进收件箱看分小节真实状态。
  if (state.status === 'ready' && total === 0) return null;

  const badgeContent = total === null ? '—' : total;

  return (
    <Tooltip title={t('inbox.badge.tooltip')}>
      <Badge count={badgeContent} size="small" data-testid="inbox-badge">
        <Button
          type="text"
          size="small"
          data-testid="inbox-badge-button"
          onClick={() => navigate('/inbox')}
        >
          <MailOutlined />
        </Button>
      </Badge>
    </Tooltip>
  );
}
