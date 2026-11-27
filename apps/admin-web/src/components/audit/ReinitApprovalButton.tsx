import { useState } from 'react';
import { Button } from 'antd';
import { useTranslation } from 'react-i18next';
import { auditApi } from '../../api/audit';
import { getErrMsg } from '../../utils/error';
import { message } from '../../utils/toast';

export interface ReinitApprovalButtonProps {
  sopId: string;
  cardHash: string;
  contentHash: string;
  onDone?: () => void | Promise<void>;
}

/** 400（contentHash 不符）时后端 detail 是唯一有用的信息，原样透出。 */
function responseDetail(err: unknown): string | null {
  if (!err || typeof err !== 'object') return null;
  const obj = err as Record<string, unknown>;
  const response = obj['response'];
  const body =
    response && typeof response === 'object'
      ? (response as Record<string, unknown>)['data']
      : undefined;
  const detail =
    obj['detail'] ??
    (body && typeof body === 'object'
      ? (body as Record<string, unknown>)['detail']
      : undefined);
  if (typeof detail === 'string') return detail.trim() || null;
  if (Array.isArray(detail)) {
    const joined = detail
      .filter((x): x is string => typeof x === 'string' && !!x.trim())
      .join('; ');
    return joined || null;
  }
  return null;
}

/** 403 走专用提示，不把框架样板串（Forbidden resource）暴露给用户。 */
function isForbidden(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const obj = err as Record<string, unknown>;
  const response = obj['response'];
  if (response && typeof response === 'object') {
    const meta = response as Record<string, unknown>;
    if (meta['status'] === 403) return true;
    const data = meta['data'];
    if (data && typeof data === 'object') {
      const body = data as Record<string, unknown>;
      if (body['statusCode'] === 403) return true;
      if (String(body['errorCode'] ?? '').toUpperCase() === 'FORBIDDEN') return true;
    }
  }
  return String(obj['errorCode'] ?? '').toUpperCase() === 'FORBIDDEN';
}

/**
 * 审批发起失败审计行的管理员恢复入口（R92 跨角色闭环最后一跳）。
 *
 * 只负责「重新建单」：不 decide / consume / publish，仍需主管四眼批准。
 * success 后由 onDone 刷新审计列表。bump 不传——失败审计 detail 没有该字段。
 */
export default function ReinitApprovalButton({
  sopId,
  cardHash,
  contentHash,
  onDone,
}: ReinitApprovalButtonProps) {
  const { t } = useTranslation();
  const [loading, setLoading] = useState(false);

  const handleReinit = async (): Promise<void> => {
    if (loading) return;
    setLoading(true);
    try {
      await auditApi.requestReleaseRetry({ sopId, cardHash, contentHash });
      message.success(t('audit.reinitApproval.success'));
      await onDone?.();
    } catch (err: unknown) {
      if (isForbidden(err)) {
        message.error(t('audit.reinitApproval.noPermission'));
      } else {
        message.error(responseDetail(err) ?? getErrMsg(err, t('audit.reinitApproval.failed')));
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <Button
      type="primary"
      size="small"
      loading={loading}
      disabled={loading}
      data-testid="reinit-approval-button"
      onClick={() => void handleReinit()}
    >
      {t('audit.reinitApproval.button')}
    </Button>
  );
}
