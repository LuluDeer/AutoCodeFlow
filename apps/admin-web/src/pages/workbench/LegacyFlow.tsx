/**
 * Legacy plan preview/commit/run flow, retained for existing behavior and
 * test contracts. Kept as a separate component so WorkbenchPage stays focused
 * on the 3-pane shell. All props are injected by the page; no new i18n keys or
 * test IDs are introduced here.
 */
import type { PreviewPlanResult, WorkbenchCadence } from '../../api/workbench';
import { Alert, Button, Input, Select, Space } from 'antd';
import { useTranslation } from 'react-i18next';
import type { WorkbenchSessionView } from '../../components/workbench/WorkbenchSessionPanel';
import WorkbenchPlanSection from '../../components/workbench/WorkbenchPlanSection';
import WorkbenchRecordsSection from '../../components/workbench/WorkbenchRecordsSection';
import WorkbenchSessionAction from '../../components/workbench/WorkbenchSessionAction';
import WorkbenchSubmitSection from '../../components/workbench/WorkbenchSubmitSection';
import {
  WorkbenchSessionListCard,
  WorkbenchSessionRestoreCard,
} from '../../components/workbench/WorkbenchSessionPanel';

type Translate = import('i18next').TFunction;

const cadenceOptions = (t: Translate): Array<{ value: WorkbenchCadence; label: string }> => [
  { value: 'daily', label: t('workbench.cadence.daily') },
  { value: 'weekly', label: t('workbench.cadence.weekly') },
  { value: 'monthly', label: t('workbench.cadence.monthly') },
];

export interface LegacyFlowProps {
  goal: string;
  setGoal: (value: string) => void;
  cadence: WorkbenchCadence;
  setCadence: (value: WorkbenchCadence) => void;
  paramText: string;
  setParamText: (value: string) => void;
  result: PreviewPlanResult | null;
  canConfirm: boolean;
  committing: boolean;
  commitError: string | null;
  handleConfirm: () => void;
  commitResult: Parameters<typeof WorkbenchSubmitSection>[0]['commitResult'] | null;
  approvalStatus: Parameters<typeof WorkbenchSubmitSection>[0]['approvalStatus'];
  approvalKey: string;
  isAdmin: boolean;
  error: string | null;
  previewing: boolean;
  handlePreview: () => void;
  records: Parameters<typeof WorkbenchRecordsSection>[0]['records'];
  sessionError: string | null;
  startingSession: boolean;
  sessionId: string | null;
  session: WorkbenchSessionView | null;
  activeAnchor: unknown;
  startSession: () => void;
  sessions: Parameters<typeof WorkbenchSessionListCard>[0]['sessions'];
  sessionsState: string;
  sessionsError: string | null;
  restoreSession: (id: string) => void;
  reloadSessions: () => void;
}

export default function LegacyFlow({
  goal, setGoal, cadence, setCadence, paramText, setParamText,
  result, canConfirm, committing, commitError, handleConfirm,
  commitResult, approvalStatus, approvalKey, isAdmin,
  error, previewing, handlePreview, records,
  sessionError, startingSession, sessionId, session, activeAnchor, startSession,
  sessions, sessionsState, sessionsError, restoreSession, reloadSessions,
}: LegacyFlowProps) {
  const { t } = useTranslation();
  return (
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
      <Button type="primary" loading={previewing} onClick={handlePreview}>
        {t('workbench.preview.action')}
      </Button>
      {error ? <Alert type="error" showIcon title={error} /> : null}
      {result ? (
        <WorkbenchPlanSection
          result={result}
          canConfirm={canConfirm}
          committing={committing}
          commitError={commitError}
          onConfirm={handleConfirm}
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
              error={sessionError}
              starting={startingSession}
              sessionId={sessionId}
              session={session}
              onStart={startSession}
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
          onStart={startSession}
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
    </Space>
  );
}
