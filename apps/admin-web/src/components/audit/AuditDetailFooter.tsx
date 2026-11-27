import { theme } from 'antd';
import RetryReleaseButton from './RetryReleaseButton';
import ReinitApprovalButton from './ReinitApprovalButton';

export interface AuditDetailFooterProps {
  action?: string;
  detail?: Record<string, unknown>;
  onRetryDone: () => void | Promise<void>;
}

/**
 * 审计详情弹窗内容：JSON 展示 + 可重试发布审计行的恢复入口。
 *
 * 从审计页外提既是体量棘轮要求（index.tsx 已顶格），也让“什么时候允许重试”
 * 的判据与页面渲染解耦；判定只认审计行 action + detail 的 approvalKey/reason。
 */
export default function AuditDetailFooter({
  action,
  detail,
  onRetryDone,
}: AuditDetailFooterProps) {
  const { token } = theme.useToken();
  const approvalKey = detail?.approvalKey;
  const reason = detail?.reason;
  const sopId = detail?.sopId;
  const cardHash = detail?.cardHash;
  const contentHash = detail?.contentHash;
  const canRetry =
    action === 'sop_publish.release_failed' &&
    typeof approvalKey === 'string' &&
    typeof reason === 'string';
  // R92：审批发起失败（没有可重试的 granted 单）走重新建单，字段缺一不可。
  const canReinit =
    action === 'sop_publish.approval_request_failed' &&
    typeof sopId === 'string' &&
    typeof cardHash === 'string' &&
    typeof contentHash === 'string';

  return (
    <>
      {/* UI 打磨：长 detail JSON 限高内滚，避免弹窗被撑出视口 */}
      <pre style={{ background: token.colorFillQuaternary, padding: 16, borderRadius: 4, fontSize: 13, overflowX: 'auto', maxHeight: 480, overflowY: 'auto' }}>
        {detail ? JSON.stringify(detail, null, 2) : ''}
      </pre>
      {canRetry && (
        <RetryReleaseButton
          approvalKey={approvalKey as string}
          reason={reason as string}
          onDone={onRetryDone}
        />
      )}
      {canReinit && (
        <ReinitApprovalButton
          sopId={sopId as string}
          cardHash={cardHash as string}
          contentHash={contentHash as string}
          onDone={onRetryDone}
        />
      )}
    </>
  );
}
