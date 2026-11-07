/**
 * REFACTOR-EXEC-02：重试链面板（原 ExecutionDetailPage「重试链」Tab 内容原样迁出）。
 * CORE-02 的构建逻辑仍在 pages/retry-chain.ts 纯函数中——本组件只负责展示。
 */
import { Card, Tag, Typography, Alert, theme, Tooltip } from 'antd';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import '../i18n';
import type { RetryChainLink } from '../pages/retry-chain';
// P3 审计：执行状态 → Tag color 映射收敛到单一事实源（原本地 RETRY_STATUS_COLOR 迁出）
import { EXECUTION_TAG_COLOR } from '../utils/status-color';
// ADR-017 阶段 3（决策 §7 读面富化）：执行器可读名解析（id 优先、地址回落）。
import { useExecutorNames } from '../hooks/useExecutorNames';
// R169：读失败必须如实呈现，不能渲染成「没有重试额度 / 没有重试记录」。
import StateError from './StateError';

const { Text } = Typography;

const TRIGGER_LABEL = (t: (k: string) => string): Record<string, string> => ({
  manual: t('execDetail.trigger.manual'), cron: t('execDetail.trigger.cron'), fixed_rate: t('execDetail.trigger.fixedRate'),
  dependency: t('execDetail.trigger.dependency'), misfire: t('execDetail.trigger.misfire'),
  webhook: t('execDetail.trigger.webhook'), // FEAT-21
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

export default function ExecutionRetryChain({ taskId, data, taskMaxRetry, retryChain, pendingRetry, loadError, onRetry }: {
  taskId: string;
  data: { id?: string; retryCount?: number } | undefined;
  taskMaxRetry: number;
  retryChain: RetryChainLink[];
  pendingRetry: RetryChainLink | null;
  /**
   * R169：**次查询**（任务详情 / 兄弟执行列表）的读取错误。
   *
   * ## 为什么必须传进来（修的是一个**假事实**）
   *
   * 本面板的「重试预算」与「手动重试入口」都依赖 `taskMaxRetry`，而它来自
   * `useTaskDetail`。**那个查询失败时 `taskData` 是 undefined ⇒ `taskMaxRetry` 落到 0**
   * ⇒ 整个预算 Tag 与「手动重试」卡**直接不渲染**（`taskMaxRetry > 0 &&`），
   * 重试链列表也只剩空态文案。用户看到的是「**这个任务没有重试额度、也没有重试记录**」——
   * 而真相是「**我们没读到**」。**「没有」与「没读到」方向相反**：前者意味着不必再抢救，
   * 后者应当重试或报障 ⇒ 这个页面恰恰是排障最常落地的页面。
   *
   * 修法：次查询的错误**上抛到本组件**，只要有错就渲染 `StateError`（含重试），
   * **不再**渲染基于 `taskMaxRetry === 0` 推出来的「没有额度」结论。
   */
  loadError?: unknown;
  /** 重试回调（重新拉取次查询）；不传则不渲染重试按钮。 */
  onRetry?: () => void;
}) {
  const { t } = useTranslation();
  // F-15（DEEP_REVIEW 0ef3bbe）：语义色/边框走 antd token，暗色主题自适应。
  const { token: antdToken } = theme.useToken();
  const triggerLabels = TRIGGER_LABEL(t);
  const failureReasonMap = FAILURE_REASON_MAP(t);
  // ADR-017 阶段 3（决策 §7）：重试链每行都要解析执行器名（自拉一次清单共用）。
  const { nameOf } = useExecutorNames();

  // R169：次查询读失败 ⇒ **只说「没读到」，不推「没有」**。
  // 预算 Tag / 手动重试卡都依赖 `taskMaxRetry`（来自任务详情查询），它失败时会落到 0
  // ⇒ 若照常渲染，用户会看到「没有重试额度 + 没有重试记录」这个**假事实**（见 props 注释）。
  if (loadError) {
    return (
      <StateError
        error={loadError}
        onRetry={onRetry}
        title={t('execDetail.retry.loadFail')}
      />
    );
  }

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
              <Tag color={EXECUTION_TAG_COLOR[link.status] || 'default'}>{t('execDetail.retry.attempt', { n: link.retryCount })}</Tag>
              {link.execId === data?.id ? (
                <Text strong>{t('execDetail.retry.currentExec')}</Text>
              ) : (
                <Link to={`/tasks/${taskId}/executions/${link.execId}`}>
                  {link.execId.slice(0, 8)}…
                </Link>
              )}
              <Text type="secondary" style={{ fontSize: 12 }}>
                {link.triggerType ? triggerLabels[link.triggerType] ?? link.triggerType : '-'}
                {/* ADR-017 阶段 3（决策 §7）：执行器显示可读名（id 优先、地址回落），
                    与执行详情卡/列表页同口径。地址是诊断身份，作为 tooltip 保留。 */}
                {nameOf(link) ?? link.executorAddress
                  ? (
                    <Tooltip title={link.executorAddress || undefined}>
                      <span>{` · ${nameOf(link) ?? link.executorAddress}`}</span>
                    </Tooltip>
                  )
                  : ''}
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
