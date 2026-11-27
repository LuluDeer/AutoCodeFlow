/**
 * 工作台方案卡 / 检查结果 / 确认按钮。从 WorkbenchPage 外提以守住 300 行天花板。
 * 纯展示 + 回调，状态由 useWorkbenchForm 持有；JSX 与文案逐字保留。
 */
import { Alert, Button, Card, Tag, Typography } from 'antd';
import { useTranslation } from 'react-i18next';
import type { PreviewPlanResult } from '../../api/workbench';

type Translate = import('i18next').TFunction;

function checkLabel(t: Translate, status: string): string {
  switch (status) {
    case 'ok':
      return t('workbench.check.ok');
    case 'warn':
      return t('workbench.check.warn');
    case 'fail':
      return t('workbench.check.fail');
    default:
      return status;
  }
}
const CHECK_COLOR = { ok: 'green', warn: 'orange', fail: 'red' } as const;

export interface WorkbenchPlanSectionProps {
  result: PreviewPlanResult;
  canConfirm: boolean;
  committing: boolean;
  commitError: string | null;
  onConfirm: () => void;
}

export default function WorkbenchPlanSection({
  result, canConfirm, committing, commitError, onConfirm,
}: WorkbenchPlanSectionProps) {
  const { t } = useTranslation();
  return (
    <Card title={t('workbench.preview.title')} style={{ marginBottom: 16 }}>
      <Typography.Title level={4}>{result.card.title}</Typography.Title>
      <p>{t('workbench.card.trigger', { text: result.card.triggerText })}</p>
      <div style={{ marginBottom: 8 }}>
        {t('workbench.card.hints')}
        {result.card.capabilityHints.map((hint, i) => (
          <Tag key={`${hint}-${i}`} color="blue">{hint}</Tag>
        ))}
      </div>
      <p>{t('workbench.card.acceptance', { text: result.card.acceptanceText })}</p>
      <p>{t('workbench.card.budget', { max: result.card.budget.maxTurns })}</p>
      <div style={{ marginBottom: 8 }}>
        {t('workbench.card.checks')}
        {result.checks.map((check, i) => (
          <Tag key={`${check.field}-${i}`} color={CHECK_COLOR[check.status]}>
            {checkLabel(t, check.status)} · {check.field} · {check.message}
          </Tag>
        ))}
      </div>
      {!result.eligible ? (
        <Alert
          type="warning"
          showIcon
          title={t('workbench.notEligible')}
          style={{ marginBottom: 12 }}
        />
      ) : null}
      <Button
        type="primary"
        loading={committing}
        disabled={!canConfirm || committing}
        onClick={onConfirm}
      >
        {t('workbench.confirm.action')}
      </Button>
      {!canConfirm && result.eligible ? (
        <Typography.Text type="secondary" style={{ marginLeft: 12 }}>
          {t('workbench.hasFail')}
        </Typography.Text>
      ) : null}
      {commitError ? (
        <Alert type="error" showIcon title={commitError} style={{ marginTop: 12 }} />
      ) : null}
    </Card>
  );
}
