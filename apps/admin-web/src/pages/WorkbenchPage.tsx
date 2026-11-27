import { useCallback, useRef, useState } from 'react';
import { Alert, Button, Card, Input, Select, Space, Typography } from 'antd';
import { useTranslation } from 'react-i18next';
import type { WorkbenchCadence } from '../api/workbench';
import WorkbenchPlanSection from '../components/workbench/WorkbenchPlanSection';
import WorkbenchRecordsSection from '../components/workbench/WorkbenchRecordsSection';
import WorkbenchSessionAction from '../components/workbench/WorkbenchSessionAction';
import WorkbenchSubmitSection from '../components/workbench/WorkbenchSubmitSection';
import {
  WorkbenchSessionListCard,
  WorkbenchSessionRestoreCard,
} from '../components/workbench/WorkbenchSessionPanel';
import { useWorkbenchForm } from '../hooks/workbench-form';
import {
  readWorkbenchAnchor,
  sessionAnchor,
  useWorkbenchSession,
  type WorkbenchAnchor,
} from '../hooks/useWorkbenchSession';

type Translate = import('i18next').TFunction;

const cadenceOptions = (t: Translate): Array<{ value: WorkbenchCadence; label: string }> => [
  { value: 'daily', label: t('workbench.cadence.daily') },
  { value: 'weekly', label: t('workbench.cadence.weekly') },
  { value: 'monthly', label: t('workbench.cadence.monthly') },
];

export default function WorkbenchPage() {
  const { t } = useTranslation();
  // 惰性转发 session.reset：form hook 必须先于会话 hook 调用（要先拿到
  // commitResult/result/submittedInput 算锚点），点击预览时才解引用当前 reset。
  const sessionResetRef = useRef<() => void>(() => {});
  const {
    goal, setGoal,
    cadence, setCadence,
    paramText, setParamText,
    result, submittedInput,
    error, previewing, handlePreview,
    canConfirm, committing, commitError, commitResult, handleConfirm,
    records, approvalStatus, approvalKey, isAdmin,
  } = useWorkbenchForm({ onPreviewStart: () => sessionResetRef.current() });

  // Writer B：刷新后表单与 preview/commitResult 内存态都没了：优先用落盘锚点，
  // URL/localStorage 中的 sessionId 则由 hook 自己恢复，运行按钮与会话面板因此不依赖内存。
  const [restoredAnchor] = useState<WorkbenchAnchor | null>(() => readWorkbenchAnchor());
  const activeAnchor = sessionAnchor(commitResult, result?.cardHash, submittedInput?.goal) ?? restoredAnchor;
  const sessionCtl = useWorkbenchSession(useCallback(() => activeAnchor, [activeAnchor]));
  sessionResetRef.current = sessionCtl.reset;
  const {
    sessionId, session, error: sessionError, starting: startingSession,
    start: startSession, restore: restoreSession,
    sessions, sessionsState, sessionsError, reloadSessions,
  } = sessionCtl;

  return (
    <div data-testid="workbench-page">
      <Typography.Title level={3}>{t('workbench.page.title')}</Typography.Title>
      <Typography.Paragraph type="secondary">
        {t('workbench.page.desc')}
      </Typography.Paragraph>

      <Card title={t('workbench.card.business')} style={{ marginBottom: 16 }}>
        <Space orientation="vertical" size="middle" style={{ width: '100%' }}>
          <div>
            <div style={{ marginBottom: 4 }}>{t('workbench.field.goal')}</div>
            <Input
              placeholder={t('workbench.goal.placeholder')}
              value={goal}
              onChange={(e) => setGoal(e.target.value)}
            />
          </div>
          <div>
            <div style={{ marginBottom: 4 }}>{t('workbench.field.cadence')}</div>
            <Select<WorkbenchCadence>
              value={cadence}
              onChange={setCadence}
              options={cadenceOptions(t)}
              style={{ width: 200 }}
            />
          </div>
          <div>
            <div style={{ marginBottom: 4 }}>{t('workbench.field.params')}</div>
            <Input
              placeholder={t('workbench.params.placeholder')}
              value={paramText}
              onChange={(e) => setParamText(e.target.value)}
            />
          </div>
          <Button type="primary" loading={previewing} onClick={() => void handlePreview()}>
            {t('workbench.preview.action')}
          </Button>
        </Space>
      </Card>

      {error ? <Alert type="error" showIcon title={error} style={{ marginBottom: 16 }} /> : null}

      {result ? (
        <WorkbenchPlanSection
          result={result}
          canConfirm={canConfirm}
          committing={committing}
          commitError={commitError}
          onConfirm={() => void handleConfirm()}
        />
      ) : null}

      {commitResult ? (
        <WorkbenchSubmitSection
          commitResult={commitResult}
          approvalStatus={approvalStatus}
          approvalKey={approvalKey}
          isAdmin={isAdmin}
          sessionAction={approvalStatus === 'submitted' ? (
            <WorkbenchSessionAction
              error={sessionError} starting={startingSession} sessionId={sessionId}
              session={session} onStart={() => void startSession()}
            />
          ) : null}
        />
      ) : null}

      {!commitResult && (sessionId || session || activeAnchor) ? (
        <WorkbenchSessionRestoreCard
          sessionId={sessionId}
          session={session}
          error={sessionError}
          starting={startingSession}
          onStart={() => void startSession()}
        />
      ) : null}
      <WorkbenchSessionListCard
        sessions={sessions}
        state={sessionsState}
        error={sessionsError}
        onRestore={restoreSession}
        onReload={reloadSessions}
      />

      <WorkbenchRecordsSection records={records} />
    </div>
  );
}
