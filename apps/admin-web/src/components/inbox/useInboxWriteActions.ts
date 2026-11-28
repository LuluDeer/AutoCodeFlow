import { useState } from 'react';
import { message } from '../../utils/toast';
import { Modal as ConfirmModal } from '../../utils/modal';
import { showApiError } from '../../utils/error';
import { agentApprovalStatusLabel } from '../../utils/agent-label';
import { useTranslation } from 'react-i18next';
import {
  INBOX_REFRESH_EVENT,
  agentApi,
  deploymentsApi,
  type InboxItem,
} from '../../api/inbox';

type ActingAction = 'approve' | 'reject' | 'grant' | 'deny' | 'resume';
type T = ReturnType<typeof useTranslation>['t'];

/** 收件箱写动作与二次确认状态：从页面抽出，保持 InboxPage 函数体不膨胀。 */
export function useInboxWriteActions(reload: () => Promise<void>) {
  const { t } = useTranslation();
  const [actingId, setActingId] = useState<string | null>(null);
  const [actingAction, setActingAction] = useState<ActingAction | null>(null);
  const [rejectTarget, setRejectTarget] = useState<InboxItem | null>(null);
  const [rejectReason, setRejectReason] = useState('');

  const confirmThen = (title: string, action: () => Promise<void>, danger = false) => {
    confirmThenWith(t, title, action, {
      danger,
      onDone: () => {
        window.dispatchEvent(new Event(INBOX_REFRESH_EVENT));
        void reload();
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
    setActingAction('reject');
    try {
      await deploymentsApi.reject(dep.id, rejectReason.trim() || undefined);
      message.success(t('inbox.success.rejected'));
      window.dispatchEvent(new Event(INBOX_REFRESH_EVENT));
      setRejectTarget(null);
      await reload();
    } catch (err) {
      showApiError(err);
    } finally {
      setActingId(null);
      setActingAction(null);
    }
  };

  const handleGrant = (item: InboxItem) => grantPublishApproval(item, t, confirmThen);

  const handleDeny = ({ session, approval, title }: InboxItem) => {
    if (!session || !approval) return;
    confirmThen(
      t('inbox.denyConfirm.title', { title, tool: approval.toolName }),
      async () => {
        const result = await agentApi.denyApproval(session.id, approval.approvalKey);
        // 生成合同里 approval 是快照行，可能为 null（理论路径：行已被并发清理）
        const snapshot = result.approval;
        if (result.ok && snapshot?.status === 'denied') {
          message.success(t('inbox.success.denied'));
        } else {
          message.warning(t('inbox.approvalState', {
            status: agentApprovalStatusLabel(
              typeof snapshot?.status === 'string' ? snapshot.status : null,
              t,
            ),
          }));
        }
      },
      true,
    );
  };

  const handleResume = ({ canResume, session, title }: InboxItem) => {
    if (!canResume || !session) return;
    confirmThen(t('inbox.resumeConfirm.title', { title }), async () => {
      const result = await agentApi.resume(session.id);
      if (result.ok) message.success(t('inbox.success.resumed'));
      else message.warning(result.reason || t('inbox.resumeNotQueued'));
    });
  };

  return {
    actingId,
    actingAction,
    rejectTarget,
    rejectReason,
    setRejectReason,
    setRejectTarget,
    confirmReject,
    handleApprove,
    openReject,
    handleGrant,
    handleDeny,
    handleResume,
  };
}

function confirmThenWith(
  t: T,
  title: string,
  action: () => Promise<void>,
  options: { danger?: boolean; onDone: () => void },
): void {
  ConfirmModal.confirm({
    title,
    okText: t('inbox.action.confirm'),
    cancelText: t('inbox.action.cancel'),
    okButtonProps: options.danger ? { danger: true } : undefined,
    onOk: async () => {
      try {
        await action();
      } catch (err) {
        showApiError(err);
        if ((err as { __status?: number } | null)?.__status !== 409) throw err;
      }
      options.onDone();
    },
  });
}

function grantPublishApproval(
  item: InboxItem,
  t: T,
  confirm: (title: string, action: () => Promise<void>) => void,
): void {
  const { session, approval } = item;
  if (!session || !approval) return;
  confirm(t('agents.approval.confirmTitle', { tool: approval.toolName }), async () => {
    const result = await agentApi.grantApproval(session.id, approval.approvalKey);
    // 生成合同里 approval 是快照行，可能为 null（理论路径：行已被并发清理）
    const snapshot = result.approval;
    if (result.ok && snapshot?.status === 'granted') {
      message.success(t('agents.approval.grantOk', { key: approval.approvalKey }));
    } else {
      message.warning(t('inbox.approvalState', {
        status: agentApprovalStatusLabel(
          typeof snapshot?.status === 'string' ? snapshot.status : null,
          t,
        ),
      }));
    }
  });
}
