import { useState } from 'react';
import { Button } from 'antd';
import { useTranslation } from 'react-i18next';
import { auditApi } from '../../api/audit';
import { getErrMsg } from '../../utils/error';
import { message } from '../../utils/toast';

/** consume 前失败才可重试；consume 后失败的 publish_failed 不渲染按钮。 */
const RETRYABLE = new Set([
  'dependency_unavailable',
  'policy_fingerprint_unavailable',
  'sop_not_found',
  'content_changed',
  'approval_not_consumed',
]);

export interface RetryReleaseButtonProps {
  approvalKey: string;
  reason: string;
  onDone?: () => void | Promise<void>;
}

function retryErrorText(err: unknown, fallback: string): string {
  if (err && typeof err === 'object') {
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
    if (typeof detail === 'string' && detail.trim()) return detail;
    if (Array.isArray(detail)) {
      const joined = detail
        .filter((x): x is string => typeof x === 'string' && !!x.trim())
        .join('; ');
      if (joined) return joined;
    }
    if (detail && typeof detail === 'object') {
      const inner = detail as Record<string, unknown>;
      if (typeof inner['message'] === 'string' && inner['message'].trim()) return inner['message'];
      if (typeof inner['detail'] === 'string' && inner['detail'].trim()) return inner['detail'];
    }
  }
  return getErrMsg(err, fallback);
}

export function RetryReleaseButton({
  approvalKey,
  reason,
  onDone,
}: RetryReleaseButtonProps) {
  const { t } = useTranslation();
  const [loading, setLoading] = useState(false);

  if (!RETRYABLE.has(reason)) return null;

  const handleRetry = async (): Promise<void> => {
    if (loading) return;
    setLoading(true);
    try {
      const res = await auditApi.retryRelease(approvalKey, reason);
      if (res?.published) {
        message.success(t('audit.retryRelease.published'));
      } else {
        message.success(
          t('audit.retryRelease.stillFailed', { reason: res?.reason ?? reason }),
        );
      }
      await onDone?.();
    } catch (err: unknown) {
      message.error(retryErrorText(err, t('audit.retryRelease.failed')));
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
      data-testid="retry-release-button"
      onClick={() => void handleRetry()}
    >
      {t('audit.retryRelease.button')}
    </Button>
  );
}

export default RetryReleaseButton;
