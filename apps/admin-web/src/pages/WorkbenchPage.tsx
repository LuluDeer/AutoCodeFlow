import { useCallback, useRef, useState } from 'react';
import { Button, Card } from 'antd';
import { useTranslation } from 'react-i18next';
import WorkbenchInspector from '../components/workbench/WorkbenchInspector';
import WorkbenchSessionRail from '../components/workbench/WorkbenchSessionRail';
import { useIsMobile } from '../hooks/useIsMobile';
import { useWorkbenchForm } from '../hooks/workbench-form';
import {
  readWorkbenchAnchor,
  sessionAnchor,
  useWorkbenchSession,
  type WorkbenchAnchor,
} from '../hooks/useWorkbenchSession';
import LegacyFlow from './workbench/LegacyFlow';
import WorkbenchCenter from './workbench/WorkbenchCenter';
import WorkbenchShell from './workbench/WorkbenchShell';
import type { ComposerDraft } from '../components/workbench/WorkbenchComposer';
import type { ComposerCadence } from './workbench/types-public';

type Starter = { prompt: string; kind: 'chat' | 'sop_authoring' | 'plan'; cadence: ComposerCadence; token: number };
const EMPTY_STARTER: Starter = { prompt: '', kind: 'chat', cadence: 'once', token: 0 };
const TERMINAL = ['succeeded', 'completed', 'failed', 'cancelled'];

export default function WorkbenchPage() {
  const { t } = useTranslation();
  const isMobile = useIsMobile();
  const [railOpen, setRailOpen] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(!isMobile);
  const [legacyOpen, setLegacyOpen] = useState(true);
  const [actingKey, setActingKey] = useState<string | null>(null);
  const [starter, setStarter] = useState<Starter>(EMPTY_STARTER);

  // Lazy forward of session.reset: the form hook must run first (it computes
  // the commit anchor needed by the session hook).
  const sessionResetRef = useRef<() => void>(() => {});
  const form = useWorkbenchForm({ onPreviewStart: () => sessionResetRef.current() });
  const [restoredAnchor] = useState<WorkbenchAnchor | null>(() => readWorkbenchAnchor());
  const activeAnchor = sessionAnchor(
    form.commitResult,
    form.result?.cardHash,
    form.submittedInput?.goal,
  ) ?? restoredAnchor;
  const sessionCtl = useWorkbenchSession(useCallback(() => activeAnchor, [activeAnchor]));
  sessionResetRef.current = sessionCtl.reset;

  const { detail, streamStatus, sessionId, session } = sessionCtl;
  const running = Boolean(detail && !TERMINAL.includes(detail.status));
  const isLive = streamStatus === 'live' && running;

  const handleNew = () => {
    sessionCtl.reset();
    setStarter((prev) => ({ ...EMPTY_STARTER, token: prev.token + 1 }));
    if (isMobile) setRailOpen(false);
  };

  const handleStarter = (value: Omit<Starter, 'token'>) => {
    setStarter((prev) => ({ ...value, token: prev.token + 1 }));
    if (isMobile) setRailOpen(false);
  };

  const handleSend = (draft: ComposerDraft) => {
    const context: Record<string, unknown> = {};
    if (draft.cadence !== 'once') context.cadence = draft.cadence;
    if (Object.keys(draft.params).length > 0) context.params = draft.params;
    if (draft.attachmentNames.length > 0) context.attachments = draft.attachmentNames;
    if (!sessionId || detail && TERMINAL.includes(detail.status)) {
      void sessionCtl.startChat({
        prompt: draft.prompt,
        kind: starter.kind === 'chat' ? undefined : starter.kind,
        ...(Object.keys(context).length > 0 ? { context } : {}),
      });
    } else {
      void sessionCtl.sendMessage(draft.prompt, 'followup');
    }
  };

  const handleDecide = (key: string, decision: 'grant' | 'deny' | 'withdraw') => {
    setActingKey(key);
    void sessionCtl.decideApproval(key, decision).finally(() => setActingKey(null));
  };

  const handleRetry = (text: string) => {
    if (sessionId) void sessionCtl.sendMessage(text, 'followup');
  };

  const rail = (
    <WorkbenchSessionRail
      sessions={sessionCtl.sessions}
      state={sessionCtl.sessionsState}
      error={sessionCtl.sessionsError}
      activeId={sessionId}
      onNew={handleNew}
      onStarter={handleStarter}
      onRestore={(id) => { sessionCtl.restore(id); if (isMobile) setRailOpen(false); }}
      onReload={sessionCtl.reloadSessions}
    />
  );

  const inspector = (
    <WorkbenchInspector
      detail={detail}
      actingKey={actingKey}
      onDecide={handleDecide}
      verification={{ cardHash: form.result?.cardHash, policyGeneration: form.result?.policyGeneration }}
    />
  );

  const center = (
    <WorkbenchCenter
      detail={detail}
      live={isLive}
      running={running}
      sending={sessionCtl.startingChat}
      actingKey={actingKey}
      starterPrompt={starter.prompt}
      starterCadence={starter.cadence}
      seedToken={starter.token}
      onSend={handleSend}
      onCancel={() => void sessionCtl.cancel()}
      onDecide={handleDecide}
      onRetry={handleRetry}
    />
  );

  return (
    <div data-testid="workbench-page" style={{ padding: 16, minHeight: 0 }}>
      <WorkbenchShell
        isMobile={isMobile}
        railOpen={railOpen}
        inspectorOpen={inspectorOpen}
        rail={rail}
        center={center}
        inspector={inspector}
        error={sessionCtl.error ?? sessionCtl.actionError}
        fallback={streamStatus === 'polling' && Boolean(detail)}
        onOpenRail={() => setRailOpen(true)}
        onCloseRail={() => setRailOpen(false)}
        onToggleInspector={() => setInspectorOpen((v) => !v)}
        onCloseInspector={() => setInspectorOpen(false)}
      />

      <Card
        size="small"
        title={
          <Button
            type="link"
            size="small"
            onClick={() => setLegacyOpen((v) => !v)}
            data-testid="workbench-legacy-toggle"
          >
            {t('workbench.legacy.title')} {legacyOpen ? '▲' : '▼'}
          </Button>
        }
        style={{ marginTop: 16 }}
      >
        {legacyOpen ? (
          <LegacyFlow
            goal={form.goal}
            setGoal={form.setGoal}
            cadence={form.cadence}
            setCadence={form.setCadence}
            paramText={form.paramText}
            setParamText={form.setParamText}
            result={form.result}
            canConfirm={form.canConfirm}
            committing={form.committing}
            commitError={form.commitError}
            handleConfirm={() => void form.handleConfirm()}
            commitResult={form.commitResult}
            approvalStatus={form.approvalStatus}
            approvalKey={form.approvalKey}
            isAdmin={form.isAdmin}
            error={form.error}
            previewing={form.previewing}
            handlePreview={() => void form.handlePreview()}
            records={form.records}
            sessionError={sessionCtl.error}
            startingSession={sessionCtl.starting}
            sessionId={sessionId}
            session={session}
            activeAnchor={activeAnchor}
            startSession={() => void sessionCtl.start()}
            sessions={sessionCtl.sessions}
            sessionsState={sessionCtl.sessionsState}
            sessionsError={sessionCtl.sessionsError}
            restoreSession={sessionCtl.restore}
            reloadSessions={sessionCtl.reloadSessions}
          />
        ) : null}
      </Card>
    </div>
  );
}
