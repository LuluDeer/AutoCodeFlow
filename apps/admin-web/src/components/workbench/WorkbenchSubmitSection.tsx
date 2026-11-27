/**
 * 工作台提交结果 / 审批三态 / 草稿深链。从 WorkbenchPage 外提以守住 300 行天花板。
 * 纯展示 + 回调；会话动作由页面以 sessionAction 渲染槽接线，JSX 与文案逐字保留。
 */
import type { ReactNode } from 'react';
import { Alert, Card, Space, Tag, Typography } from 'antd';
import { useTranslation } from 'react-i18next';
import type { CommitResult } from '../../api/workbench';

export interface WorkbenchSubmitSectionProps {
  commitResult: CommitResult;
  approvalStatus: CommitResult['approvalStatus'];
  approvalKey: string;
  isAdmin: boolean;
  sessionAction: ReactNode;
}

export default function WorkbenchSubmitSection({
  commitResult, approvalStatus, approvalKey, isAdmin, sessionAction,
}: WorkbenchSubmitSectionProps) {
  const { t } = useTranslation();
  return (
    <Card title={t('workbench.confirm.title')} data-testid="workbench-commit-success" style={{ marginBottom: 16 }}>
      {approvalStatus === 'failed' ? (
        <Alert
          type="warning"
          showIcon
          title={t('workbench.commit.approvalFailed')}
          style={{ marginBottom: 12 }}
        />
      ) : approvalStatus === 'not_requested' ? (
        <Alert
          type="info"
          showIcon
          title={t('workbench.commit.approvalNotRequested')}
          style={{ marginBottom: 12 }}
        />
      ) : approvalStatus === 'submitted' ? (
        <Alert
          type="success"
          showIcon
          title={t('workbench.confirm.success')}
          style={{ marginBottom: 12 }}
        />
      ) : (
        <Alert
          type="warning"
          showIcon
          title={t('workbench.commit.approvalUnknown')}
          style={{ marginBottom: 12 }}
        />
      )}
      <Space orientation="vertical" size="small">
        <div>
          <Typography.Text type="secondary">{t('workbench.status.label')}</Typography.Text>
          <Tag color="orange">{t('workbench.status.draft')}</Tag>
        </div>
        <div>{t('workbench.sopId', { id: commitResult.sopId })}</div>
        <div data-testid="workbench-commit-slug">{t('workbench.slug', { slug: commitResult.slug })}</div>
        {approvalStatus === 'submitted' ? (
          <div>{t('workbench.approval.submittedNext')}</div>
        ) : null}
        {!isAdmin ? (
          // 业务用户：不链接 ADMIN-only 的 /sops，也不出现仅管理员可用的审批单深链。
          <div data-testid="workbench-submitted-for-review">{t('workbench.submittedForReview')}</div>
        ) : approvalStatus === 'submitted' ? (
          <a href={`/sops?sop=${encodeURIComponent(commitResult.sopId)}`}>{t('workbench.sopLink')}</a>
        ) : approvalStatus === 'failed' ? (
          <div>{t('workbench.approval.failedNoSopLink')}</div>
        ) : (
          <div>{t('workbench.sopLink.textOnly')}</div>
        )}
        {/* Writer B：受限起草会话——提交成功即可用，不发布 SOP。 */}
        {sessionAction}
        {isAdmin && approvalStatus === 'submitted' && approvalKey ? (
          <div data-testid="workbench-commit-approval" style={{ marginTop: 4 }}>
            <Alert
              type="info"
              showIcon
              title={t('workbench.approval.alert')}
              style={{ marginBottom: 8 }}
            />
            <div data-testid="workbench-approval-status">{t('workbench.approval.status')}</div>
            <div>
              {t('workbench.approval.keyLabel')}
              <Typography.Text code data-testid="workbench-approval-key">
                {approvalKey}
              </Typography.Text>
            </div>
            <a data-testid="workbench-approval-link" href="/inbox">
              {t('workbench.approval.link')}
            </a>
          </div>
        ) : null}
      </Space>
    </Card>
  );
}
