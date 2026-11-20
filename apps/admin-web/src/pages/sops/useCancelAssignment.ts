import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { sopsApi, type SopAssignment } from '../../api/sops';
import { message } from '../../utils/toast';
import { showApiError } from '../../utils/error';
import { dispatchInboxRefresh, shouldRefreshOnCancelError } from './sop-deeplink';

/** A11Y-SOPS-01：可见标签与控件同 id，避免仅靠 placeholder 失去字段语义。 */
export const CANCEL_ASSIGNMENT_FIELD_ID = {
  reason: 'sops-cancel-assignment-reason',
} as const;

/** 与后端 `CancelSopAssignmentDto` `@MaxLength(500)` 对齐。 */
export const CANCEL_ASSIGNMENT_REASON_MAX = 500;

export interface UseCancelAssignmentOptions {
  onOptimisticUpdate: (assignment: SopAssignment) => void;
  onRefreshDetail: () => Promise<void>;
  onRefreshList: () => void;
}

/**
 * R289：单条指派取消状态机（从 `SopsPage` 外提，守体量棘轮）。
 *
 * - 取消成功：乐观更新当前行、派发 `INBOX_REFRESH_EVENT` 扣减顶栏计数、刷新详情与列表；
 * - 遇 `SOP_ASSIGNMENT_TERMINAL`（HTTP 400）或 `SOP_ASSIGNMENT_NOT_FOUND`（HTTP 404）：
 *   展示本地化错误、关闭弹窗并刷新最新状态与收件箱计数；
 * - 其余错误：保留弹窗与用户输入，允许重试。
 */
export function useCancelAssignment({
  onOptimisticUpdate,
  onRefreshDetail,
  onRefreshList,
}: UseCancelAssignmentOptions) {
  const { t } = useTranslation();
  const [target, setTarget] = useState<SopAssignment | null>(null);
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const open = useCallback((assignment: SopAssignment) => {
    setTarget(assignment);
    setReason('');
  }, []);

  const close = useCallback(() => {
    setTarget(null);
    setReason('');
  }, []);

  const submit = useCallback(async () => {
    if (!target) return;
    setSubmitting(true);
    try {
      const res = await sopsApi.cancelAssignment(target.id, { reason });
      message.success(t('sops.assignmentCancel.ok'));
      setTarget(null);
      setReason('');
      onOptimisticUpdate(res.assignment);
      dispatchInboxRefresh();
      await onRefreshDetail();
      onRefreshList();
    } catch (err: unknown) {
      showApiError(err, t('sops.assignmentCancel.fail'));
      if (shouldRefreshOnCancelError(err)) {
        setTarget(null);
        setReason('');
        dispatchInboxRefresh();
        await onRefreshDetail();
      }
    } finally {
      setSubmitting(false);
    }
  }, [target, reason, onOptimisticUpdate, onRefreshDetail, onRefreshList, t]);

  return { target, reason, setReason, submitting, open, close, submit };
}
