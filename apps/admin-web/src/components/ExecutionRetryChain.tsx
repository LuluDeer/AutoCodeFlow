/**
 * REFACTOR-EXEC-02：重试链面板（原 ExecutionDetailPage「重试链」Tab 内容原样迁出）。
 * CORE-02 的构建逻辑仍在 pages/retry-chain.ts 纯函数中——本组件只负责展示。
 */
import { Card, Tag, Typography, Alert, theme } from 'antd';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import '../i18n';
import type { RetryChainLink } from '../pages/retry-chain';

const { Text } = Typography;

// UI-05: 重试链状态 Tag（随重试链 Card 迁入重试 Tab，渲染逻辑与 CORE-02 一致）
const RETRY_STATUS_COLOR: Record<string, string> = {
  pending: 'default', running: 'processing', success: 'green',
  failed: 'red', timeout: 'orange', killed: 'volcano', cancelled: 'default',
};

const TRIGGER_LABEL = (t: (k: string) => string): Record<string, string> => ({
  manual: t('execDetail.trigger.manual'), cron: t('execDetail.trigger.cron'), fixed_rate: t('execDetail.trigger.fixedRate'),
  dependency: t('execDetail.trigger.dependency'), misfire: t('execDetail.trigger.misfire'),
});

const FAILURE_REASON_MAP = (t: (k: string) => string): Record<string, { label: string }> => ({
  package_fetch_failed: { label: t('execDetail.failure.packageFetchFailed') },
  git_fetch_failed: { label: t('execDetail.failure.gitFetchFailed') },
  dependency_install_failed: { label: t('execDetail.failure.dependencyInstallFailed') },
  runtime_missing: { label: t('execDetail.failure.runtimeMissing') },
  sandbox_unavailable: { label: t('execDetail.failure.sandboxUnavailable') },
  interpreter_unavailable: { label: t('execDetail.failure.interpreterUnavailable') },
  script_error: { label: t('execDetail.failure.scriptError') },
  timeout: { label: t('execDetail.failure.timeout') },
  executor_offline: { label: t('execDetail.failure.executorOffline') },
  executor_restart: { label: t('execDetail.failure.executorRestart') },
  stale_recovered: { label: t('execDetail.failure.staleRecovered') },
  killed: { label: t('execDetail.failure.killed') },
  application_missing: { label: t('execDetail.failure.applicationMissing') },
  never_dispatched: { label: t('execDetail.failure.neverDispatched') },
  unknown: { label: t('execDetail.failure.unknown') },
});

export default function ExecutionRetryChain({ taskId, data, taskMaxRetry, retryChain, pendingRetry }: {
  taskId: string;
  data: { id?: string; retryCount?: number } | undefined;
  taskMaxRetry: number;
  retryChain: RetryChainLink[];
  pendingRetry: RetryChainLink | null;
}) {
  const { t } = useTranslation();
  // F-15（DEEP_REVIEW 0ef3bbe）：语义色/边框走 antd token，暗色主题自适应。
  const { token: antdToken } = theme.useToken();
  const triggerLabels = TRIGGER_LABEL(t);
  const failureReasonMap = FAILURE_REASON_MAP(t);

  return (
    <>
      {/* CORE-02: 重试链 Card 原样迁入（构建逻辑/展示字段零改动） */}
      {retryChain.length > 0 && (
        <Card
          title={t('execDetail.retry.chainTitle')}
          style={{ marginBottom: 16 }}
          extra={
            taskMaxRetry > 0 ? (
              <Tag>
                {t('execDetail.retry.budget', { attempt: (data?.retryCount ?? 0) + 1, total: taskMaxRetry + 1 })}
                {taskMaxRetry - (data?.retryCount ?? 0) > 0
                  ? t('execDetail.retry.remaining', { count: taskMaxRetry - (data?.retryCount ?? 0) })
                  : t('execDetail.retry.exhausted')}
              </Tag>
            ) : undefined
          }
        >
          {retryChain.map((link) => (
            <div
              key={link.execId}
              data-testid="retry-chain-item"
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '6px 0',
                borderBottom: `1px solid ${antdToken.colorBorderSecondary}`,
                flexWrap: 'wrap',
              }}
            >
              <Tag color={RETRY_STATUS_COLOR[link.status] || 'default'}>{t('execDetail.retry.attempt', { n: link.retryCount })}</Tag>
              {link.execId === data?.id ? (
                <Text strong>{t('execDetail.retry.currentExec')}</Text>
              ) : (
                <Link to={`/tasks/${taskId}/executions/${link.execId}`}>
                  {link.execId.slice(0, 8)}…
                </Link>
              )}
              <Text type="secondary" style={{ fontSize: 12 }}>
                {link.triggerType ? triggerLabels[link.triggerType] ?? link.triggerType : '-'}
                {link.executorAddress ? ` · ${link.executorAddress}` : ''}
              </Text>
              {link.failureReason && (
                <Tag>{failureReasonMap[link.failureReason]?.label ?? link.failureReason}</Tag>
              )}
              {link.errorMessage && (
                // flex 子项内 ellipsis 生效需 minWidth:0 + flex 收缩，
                // 否则长错误按内容撑破重试链卡片
                <Text type="danger" style={{ fontSize: 12, flex: '1 1 auto', minWidth: 0 }} ellipsis>
                  {link.errorMessage}
                </Text>
              )}
            </div>
          ))}
          {pendingRetry && (
            <Alert
              type="info"
              showIcon
              style={{ marginTop: 12 }}
              title={t('execDetail.retry.pendingAlert', { attempt: pendingRetry.retryCount })}
            />
          )}
        </Card>
      )}
      {retryChain.length === 0 && (
        <Card>
          <Text type="secondary">{t('execDetail.retry.empty')}</Text>
        </Card>
      )}
      {taskMaxRetry > 0 && (
        <Card size="small">
          <Text type="secondary">
            {t('execDetail.retry.manualHint')}
          </Text>
        </Card>
      )}
    </>
  );
}
