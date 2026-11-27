/**
 * Workbench session orchestration: creation, live SSE timeline, error/recovery,
 * and refresh restoration.
 *
 * Recovery source priority: URL query `session` > localStorage; when both are
 * missing the user picks from "my sessions" (GET /workbench/sessions).
 *
 * Live updates use SSE (`createSseClient` + short-lived ticket) with dynamic
 * `fromSeq` resume. REST polling is a fallback that starts ONLY when the stream
 * reports a reconnect/error state, and stops again once the stream is live.
 * Every effect owns its client and aborts it on cleanup, so switching sessions
 * can never leave two streams behind.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import * as workbenchApiModule from '../api/workbench';
import type { CommitResult } from '../api/workbench';
import type { WorkbenchSessionView } from '../components/workbench/WorkbenchSessionPanel';
import type { WorkbenchStreamStatus } from '../pages/workbench/stream';
import { useWorkbenchLiveSession } from './workbench/useWorkbenchLiveSession';
import type {
  WorkbenchApprovalDecision,
  WorkbenchCreateChatInput,
  WorkbenchMessageMode,
  WorkbenchSessionDetail,
  WorkbenchSessionListItem,
} from '../pages/workbench/types-public';

/** Namespace lookups tolerate partial mocks: a missing export is undefined, never a throw. */
type WorkbenchApiModule = typeof workbenchApiModule;
function pickApi<K extends keyof WorkbenchApiModule>(key: K): WorkbenchApiModule[K] | undefined {
  return Object.prototype.hasOwnProperty.call(workbenchApiModule, key)
    ? workbenchApiModule[key]
    : undefined;
}
const createWorkbenchSession = pickApi('createWorkbenchSession');
const getWorkbenchSession = pickApi('getWorkbenchSession');
const listWorkbenchSessions = pickApi('listWorkbenchSessions');
const createWorkbenchChatSession = pickApi('createWorkbenchChatSession');
const postWorkbenchMessage = pickApi('postWorkbenchMessage');
const cancelWorkbenchSession = pickApi('cancelWorkbenchSession');
const decideWorkbenchApproval = pickApi('decideWorkbenchApproval');

const SESSION_QUERY_KEY = 'session';
const SESSION_STORAGE_KEY = 'workbench.sessionId';
const ANCHOR_STORAGE_KEY = 'workbench.anchor';
const COMMIT_STORAGE_KEY = 'workbench.commitResult';

export interface WorkbenchAnchor {
  sopId: string;
  goal: string;
  expectedCardHash: string;
}

type SessionListState = 'idle' | 'loading' | 'ready' | 'error';

export interface UseWorkbenchSessionResult {
  sessionId: string | null;
  session: WorkbenchSessionView | null;
  detail: WorkbenchSessionDetail | null;
  streamStatus: WorkbenchStreamStatus;
  error: string | null;
  actionError: string | null;
  starting: boolean;
  startingChat: boolean;
  sessions: WorkbenchSessionListItem[];
  sessionsState: SessionListState;
  sessionsError: string | null;
  start: () => Promise<void>;
  startChat: (input: WorkbenchCreateChatInput) => Promise<void>;
  sendMessage: (content: string, mode?: WorkbenchMessageMode) => Promise<void>;
  cancel: () => Promise<void>;
  decideApproval: (
    approvalKey: string,
    decision: WorkbenchApprovalDecision,
    note?: string,
  ) => Promise<void>;
  restore: (id: string) => void;
  reloadSessions: () => void;
  reset: () => void;
}

function isSessionId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value);
}

function readStorage(key: string): string | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Private mode / quota exhaustion: URL query is still the primary path.
  }
}

function removeStorage(key: string): void {
  try {
    window.localStorage.removeItem(key);
  } catch {
    // Same as above.
  }
}

export function readSessionId(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    const url = new URL(window.location.href);
    const fromUrl = url.searchParams.get(SESSION_QUERY_KEY);
    if (isSessionId(fromUrl)) return fromUrl;
  } catch {
    // Malformed URL: fall through to localStorage.
  }
  const stored = readStorage(SESSION_STORAGE_KEY);
  return isSessionId(stored) ? stored : null;
}

export function persistSessionId(id: string): void {
  if (!isSessionId(id) || typeof window === 'undefined') return;
  try {
    const url = new URL(window.location.href);
    url.searchParams.set(SESSION_QUERY_KEY, id);
    window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
  } catch {
    // History API unavailable: localStorage fallback still applies.
  }
  writeStorage(SESSION_STORAGE_KEY, id);
}

export function clearSessionId(): void {
  if (typeof window !== 'undefined') {
    try {
      const url = new URL(window.location.href);
      if (url.searchParams.has(SESSION_QUERY_KEY)) {
        url.searchParams.delete(SESSION_QUERY_KEY);
        window.history.replaceState(
          window.history.state,
          '',
          `${url.pathname}${url.search}${url.hash}`,
        );
      }
    } catch {
      // Same as above.
    }
  }
  removeStorage(SESSION_STORAGE_KEY);
}

export function readWorkbenchAnchor(): WorkbenchAnchor | null {
  const raw = readStorage(ANCHOR_STORAGE_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<WorkbenchAnchor> | null;
    if (!parsed) return null;
    if (
      typeof parsed.sopId !== 'string'
      || typeof parsed.goal !== 'string'
      || typeof parsed.expectedCardHash !== 'string'
      || !parsed.sopId || !parsed.goal || !parsed.expectedCardHash
    ) return null;
    return {
      sopId: parsed.sopId,
      goal: parsed.goal,
      expectedCardHash: parsed.expectedCardHash,
    };
  } catch {
    return null;
  }
}

export function persistWorkbenchAnchor(anchor: WorkbenchAnchor): void {
  writeStorage(ANCHOR_STORAGE_KEY, JSON.stringify(anchor));
}

export function clearWorkbenchAnchor(): void {
  removeStorage(ANCHOR_STORAGE_KEY);
}

export function readWorkbenchCommit(): CommitResult | null {
  const raw = readStorage(COMMIT_STORAGE_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<CommitResult> | null;
    if (!parsed || typeof parsed.sopId !== 'string' || typeof parsed.slug !== 'string') return null;
    const status = parsed.approvalStatus;
    if (status !== 'submitted' && status !== 'failed' && status !== 'not_requested') return null;
    return {
      sopId: parsed.sopId,
      slug: parsed.slug,
      status: 'draft',
      approvalStatus: status,
      ...(typeof parsed.policyGeneration === 'string' ? { policyGeneration: parsed.policyGeneration } : {}),
      ...(typeof parsed.approvalKey === 'string' ? { approvalKey: parsed.approvalKey } : {}),
    };
  } catch {
    return null;
  }
}

export function persistWorkbenchCommit(result: CommitResult): void {
  writeStorage(COMMIT_STORAGE_KEY, JSON.stringify({
    sopId: result.sopId,
    slug: result.slug,
    status: 'draft',
    approvalStatus: result.approvalStatus,
    ...(result.policyGeneration ? { policyGeneration: result.policyGeneration } : {}),
    ...(result.approvalKey ? { approvalKey: result.approvalKey } : {}),
  }));
}

export function clearWorkbenchCommit(): void {
  removeStorage(COMMIT_STORAGE_KEY);
}

function asIso(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (value instanceof Date) return value.toISOString();
  return null;
}

type SessionSnapshot = Awaited<ReturnType<NonNullable<typeof getWorkbenchSession>>>;

function normalizeDetail(sessionId: string, raw: SessionSnapshot): WorkbenchSessionDetail {
  return {
    sessionId,
    title: raw.title ?? null,
    kind: raw.kind ?? 'chat',
    status: raw.status ?? 'pending',
    conclusion: raw.conclusion,
    errorMessage: raw.errorMessage ?? null,
    waitingFor: raw.waitingFor ?? null,
    createdAt: asIso(raw.createdAt),
    updatedAt: asIso(raw.updatedAt),
    stepCount: raw.stepCount,
    steps: (raw.steps ?? []).map((s) => ({
      seq: s.seq,
      role: s.role,
      content: s.content ?? null,
      contentPreview: s.contentPreview ?? null,
      createdAt: asIso(s.createdAt),
    })),
    toolCallCount: raw.toolCallCount,
    toolCalls: (raw.toolCalls ?? []).map((c) => {
      // Generated schema does not declare `id` yet, but the API may send one.
      const call = c as typeof c & { id?: string };
      return {
        id: call.id,
        toolName: call.toolName,
        status: call.status,
        argsPreview: call.argsPreview ?? null,
        outputPreview: call.outputPreview ?? null,
        errorSummary: call.errorSummary ?? null,
        createdAt: asIso(call.createdAt),
        stateChangedAt: asIso(call.stateChangedAt),
      };
    }),
    approvals: (raw as { approvals?: Record<string, number> }).approvals ?? {},
    approvalItems: (raw.approvalItems ?? []).map((a) => ({
      approvalKey: a.approvalKey,
      toolName: a.toolName,
      status: a.status,
      reason: a.reason ?? null,
      argsDigest: a.argsDigest ?? null,
      decidedBy: a.decidedBy ?? null,
      createdAt: asIso(a.createdAt),
      canDecide: a.canDecide ?? false,
      canWithdraw: a.canWithdraw ?? false,
      reviewUrl: a.reviewUrl ?? null,
    })),
    artifacts: (raw.artifacts ?? []).map((a) => ({
      id: a.id,
      name: a.name,
      size: a.size,
      createdAt: asIso(a.createdAt),
      downloadUrl: a.downloadUrl ?? null,
      previewUrl: a.previewUrl ?? null,
    })),
  };
}

/** Keep the legacy session panel fed from the same live snapshot. */
function projectToView(detail: WorkbenchSessionDetail): WorkbenchSessionView {
  return {
    sessionId: detail.sessionId,
    kind: detail.kind,
    status: detail.status,
    stepCount: detail.stepCount ?? detail.steps.length,
    steps: detail.steps.map((s) => ({
      seq: s.seq,
      role: s.role,
      contentPreview: s.content ?? s.contentPreview ?? null,
      createdAt: s.createdAt,
    })),
    toolCallCount: detail.toolCallCount ?? detail.toolCalls.length,
    toolCalls: detail.toolCalls.map((c) => ({
      toolName: c.toolName,
      status: c.status,
      errorSummary: c.errorSummary,
      createdAt: c.createdAt,
    })),
    approvals: detail.approvals ?? {},
    approvalItems: detail.approvalItems.map((a) => ({
      approvalKey: a.approvalKey,
      toolName: a.toolName,
      status: a.status,
      reason: a.reason,
      decidedBy: a.decidedBy,
      createdAt: a.createdAt,
      reviewUrl: a.reviewUrl,
    })),
    artifacts: detail.artifacts.map((a) => ({
      id: a.id,
      name: a.name,
      size: a.size,
      createdAt: a.createdAt,
      downloadUrl: a.downloadUrl,
    })),
  };
}

function errorCode(err: unknown): number | undefined {
  const obj = err as { __status?: number; status?: number; response?: { status?: number } } | null;
  return obj?.__status ?? obj?.status ?? obj?.response?.status;
}

/**
 * @param getAnchor Returns the (sopId, goal, cardHash) needed by the legacy
 * draft-session flow; null when no draft anchor exists.
 */
export function useWorkbenchSession(
  getAnchor: () => WorkbenchAnchor | null,
): UseWorkbenchSessionResult {
  const { t } = useTranslation();
  const [sessionId, setSessionId] = useState<string | null>(() => readSessionId());
  const [detail, setDetailState] = useState<WorkbenchSessionDetail | null>(null);
  const [session, setSession] = useState<WorkbenchSessionView | null>(null);
  const [streamStatus, setStreamStatus] = useState<WorkbenchStreamStatus>('connecting');
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [startingChat, setStartingChat] = useState(false);
  const [sessions, setSessions] = useState<WorkbenchSessionListItem[]>([]);
  const [sessionsState, setSessionsState] = useState<SessionListState>('idle');
  const [sessionsError, setSessionsError] = useState<string | null>(null);
  const startingRef = useRef(false);
  const detailRef = useRef<WorkbenchSessionDetail | null>(null);
  const lastSeqRef = useRef(0);

  const setDetail = useCallback((next: WorkbenchSessionDetail | null) => {
    detailRef.current = next;
    setDetailState(next);
    setSession(next ? projectToView(next) : null);
  }, []);

  const reloadSessions = useCallback(() => {
    if (typeof listWorkbenchSessions !== 'function') return;
    let alive = true;
    setSessionsState('loading');
    setSessionsError(null);
    void (async () => {
      try {
        const list = await listWorkbenchSessions({ page: 1, pageSize: 50 });
        if (!alive) return;
        setSessions(list.items as WorkbenchSessionListItem[]);
        setSessionsState('ready');
      } catch {
        if (!alive) return;
        setSessions([]);
        setSessionsState('error');
        setSessionsError(t('sopFromVideo.sessions.loadFail'));
      }
    })();
    return () => { alive = false; };
  }, [t]);

  useEffect(() => {
    const stop = reloadSessions();
    return stop;
  }, [reloadSessions]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const onPopState = () => setSessionId(readSessionId());
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  // SSE primary + polling fallback owned by a dedicated collaborator hook.
  const fetchDetail = useCallback(async (id: string): Promise<WorkbenchSessionDetail | null> => {
    if (typeof getWorkbenchSession !== 'function') return null;
    return normalizeDetail(id, await getWorkbenchSession(id));
  }, []);

  const onUnauthorized = useCallback(() => {
    clearSessionId();
    setDetail(null);
    setSessionId(null);
    setError(t('workbench.session.createFail.notFound'));
  }, [setDetail, t]);

  useWorkbenchLiveSession({
    sessionId,
    detailRef,
    lastSeqRef,
    setDetail,
    setStreamStatus,
    fetchDetail,
    onUnauthorized,
  });

  const errorText = useCallback((err: unknown): string => {
    const code = errorCode(err);
    if (code === 403) return t('workbench.session.createFail.forbidden');
    if (code === 400) return t('workbench.session.createFail.notDraft');
    if (code === 404) return t('workbench.session.createFail.notFound');
    if (code === 503) return t('workbench.session.createFail.unavailable');
    return t('workbench.session.createFailed', { reason: t('common.operateFailed') });
  }, [t]);

  const actionErrorText = useCallback((err: unknown): string => {
    const code = errorCode(err);
    if (code === 403) return t('workbench.action.forbidden');
    if (code === 404) return t('workbench.session.createFail.notFound');
    return t('workbench.action.failed');
  }, [t]);

  /** controller 以 ok:false 拒绝终态会话追加消息（不抛错）——必须显式报错。 */
  const isTerminalRejection = (result: unknown): boolean => {
    if (!result || typeof result !== 'object') return false;
    const obj = result as { ok?: unknown; action?: unknown; reason?: unknown; status?: unknown };
    if (obj.ok !== false) return false;
    if (obj.action === 'rejected_terminal' || obj.reason === 'rejected_terminal') return true;
    const reason = typeof obj.reason === 'string' ? obj.reason.toLowerCase() : '';
    return reason.includes('terminal') || reason.includes('closed');
  };

  const start = useCallback(async () => {
    const anchor = getAnchor();
    if (!anchor || startingRef.current || typeof createWorkbenchSession !== 'function') return;
    startingRef.current = true;
    setStarting(true);
    setError(null);
    try {
      const created = await createWorkbenchSession(anchor);
      if (!isSessionId(created.sessionId)) throw new Error('invalid session id');
      persistSessionId(created.sessionId);
      persistWorkbenchAnchor(anchor);
      setSessionId(created.sessionId);
      reloadSessions();
    } catch (err: unknown) {
      setError(errorText(err));
    } finally {
      startingRef.current = false;
      setStarting(false);
    }
  }, [getAnchor, errorText, reloadSessions]);

  const startChat = useCallback(async (input: WorkbenchCreateChatInput) => {
    if (startingRef.current || typeof createWorkbenchChatSession !== 'function') return;
    startingRef.current = true;
    setStartingChat(true);
    setActionError(null);
    try {
      const created = await createWorkbenchChatSession(input);
      if (!isSessionId(created.sessionId)) throw new Error('invalid session id');
      persistSessionId(created.sessionId);
      setSessionId(created.sessionId);
      reloadSessions();
    } catch (err: unknown) {
      setActionError(actionErrorText(err));
    } finally {
      startingRef.current = false;
      setStartingChat(false);
    }
  }, [actionErrorText, reloadSessions]);

  const refreshActive = useCallback(async () => {
    if (!detailRef.current || typeof getWorkbenchSession !== 'function') return;
    try {
      const raw = await getWorkbenchSession(detailRef.current.sessionId);
      setDetail(normalizeDetail(detailRef.current.sessionId, raw));
    } catch {
      // SSE will deliver the authoritative state; avoid a duplicate error toast.
    }
  }, [setDetail]);

  const sendMessage = useCallback(async (content: string, mode: WorkbenchMessageMode = 'followup') => {
    if (!detailRef.current || typeof postWorkbenchMessage !== 'function') return;
    setActionError(null);
    try {
      const result = await postWorkbenchMessage(detailRef.current.sessionId, { content, mode });
      if (isTerminalRejection(result)) {
        setActionError(t('workbench.session.terminalReject'));
        return;
      }
      await refreshActive();
    } catch (err: unknown) {
      setActionError(actionErrorText(err));
    }
  }, [actionErrorText, refreshActive, t]);

  const cancel = useCallback(async () => {
    if (!detailRef.current || typeof cancelWorkbenchSession !== 'function') return;
    setActionError(null);
    try {
      await cancelWorkbenchSession(detailRef.current.sessionId);
      await refreshActive();
    } catch (err: unknown) {
      setActionError(actionErrorText(err));
    }
  }, [actionErrorText, refreshActive]);

  const decideApproval = useCallback(async (
    approvalKey: string,
    decision: WorkbenchApprovalDecision,
    note?: string,
  ) => {
    if (!detailRef.current || typeof decideWorkbenchApproval !== 'function') return;
    setActionError(null);
    try {
      const result = await decideWorkbenchApproval(detailRef.current.sessionId, approvalKey, { decision, note });
      // applied=false ⇒ 后端回 ok:false（审批单不存在/会话不匹配/已处置）。
      // 不刷新成假成功：如实把失败写进 actionError（见 sendMessage 的同类处理）。
      if (result && result.ok === false) {
        const backendReason = (result as { reason?: unknown }).reason;
        const reason = typeof backendReason === 'string' ? backendReason.trim() : '';
        // 后端 reason 原样展示；无 reason 时复用既有审批失败文案，不改 locales。
        setActionError(reason || t('agents.approval.decideFailed', { key: approvalKey }));
        return;
      }
      await refreshActive();
    } catch (err: unknown) {
      setActionError(actionErrorText(err));
    }
  }, [actionErrorText, refreshActive, t]);

  const restore = useCallback((id: string) => {
    if (!isSessionId(id)) return;
    persistSessionId(id);
    setSessionId(id);
    setDetail(null);
    setError(null);
    setActionError(null);
    lastSeqRef.current = 0;
  }, [setDetail]);

  const reset = useCallback(() => {
    clearSessionId();
    setSessionId(null);
    setDetail(null);
    setError(null);
    setActionError(null);
    lastSeqRef.current = 0;
  }, [setDetail]);

  return {
    sessionId,
    session,
    detail,
    streamStatus,
    error,
    actionError,
    starting,
    startingChat,
    sessions,
    sessionsState,
    sessionsError,
    start,
    startChat,
    sendMessage,
    cancel,
    decideApproval,
    restore,
    reloadSessions,
    reset,
  };
}

/** For page logic that needs to know if a preview/commit anchor is complete. */
export function sessionAnchor(
  commit: CommitResult | null,
  cardHash: string | undefined,
  goal: string | undefined,
): WorkbenchAnchor | null {
  if (!commit || !cardHash || !goal) return null;
  return { sopId: commit.sopId, goal, expectedCardHash: cardHash };
}
