/**
 * UX-AUDIT / Writer B：工作台受限起草会话的状态编排（创建 + 轮询 + 错误 + 刷新恢复）。
 *
 * 恢复事实源优先级：URL query `session` > localStorage；两者都缺时才回落到
 * 「我的会话」列表（GET /workbench/sessions）由用户显式选择。锚点/commitResult
 * 也落盘，刷新后运行按钮不再完全依赖内存表单态。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import * as workbenchApiModule from '../api/workbench';
import type { CommitResult } from '../api/workbench';
import {
  isTerminalSession,
  type WorkbenchSessionView,
} from '../components/workbench/WorkbenchSessionPanel';

/** 命名空间取值兼容旧测试的部分 mock：缺失导出就是 undefined，而不是抛"No export is defined"。 */
type WorkbenchApiModule = typeof workbenchApiModule;
function pickApi<K extends keyof WorkbenchApiModule>(key: K): WorkbenchApiModule[K] | undefined {
  return Object.prototype.hasOwnProperty.call(workbenchApiModule, key)
    ? workbenchApiModule[key]
    : undefined;
}
const createWorkbenchSession = pickApi('createWorkbenchSession');
const getWorkbenchSession = pickApi('getWorkbenchSession');
const listWorkbenchSessions = pickApi('listWorkbenchSessions');

/** 会话轮询间隔（毫秒）。终态或卸载即停止。 */
const SESSION_POLL_MS = 2000;
const SESSION_QUERY_KEY = 'session';
const SESSION_STORAGE_KEY = 'workbench.sessionId';
const ANCHOR_STORAGE_KEY = 'workbench.anchor';
const COMMIT_STORAGE_KEY = 'workbench.commitResult';

export interface WorkbenchAnchor {
  sopId: string;
  goal: string;
  expectedCardHash: string;
}

export interface WorkbenchSessionListItem {
  sessionId: string;
  status: string;
  title: string | null;
  createdAt?: unknown;
  sopId: string | null;
}

type SessionListState = 'idle' | 'loading' | 'ready' | 'error';

export interface UseWorkbenchSessionResult {
  sessionId: string | null;
  session: WorkbenchSessionView | null;
  error: string | null;
  starting: boolean;
  sessions: WorkbenchSessionListItem[];
  sessionsState: SessionListState;
  sessionsError: string | null;
  start: () => Promise<void>;
  restore: (id: string) => void;
  reloadSessions: () => void;
  reset: () => void;
}

function isSessionId(value: unknown): value is string {
  // 服务端 UUID 是生产形态；保留 fixture/旧链路的不透明 id（同源 agentSessionUrl 同口径）。
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
    // 隐私模式/配额耗尽：URL query 仍是优先恢复路径，不把它变成致命错误。
  }
}

function removeStorage(key: string): void {
  try {
    window.localStorage.removeItem(key);
  } catch {
    // 同上。
  }
}

/** URL query 优先；非法/空 query 才回落 localStorage。 */
export function readSessionId(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    const url = new URL(window.location.href);
    const fromUrl = url.searchParams.get(SESSION_QUERY_KEY);
    if (isSessionId(fromUrl)) return fromUrl;
  } catch {
    // 畸形 URL：继续尝试 localStorage。
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
    // 历史 API 不可用时仍保留 localStorage 兜底。
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
      // 同上。
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

/**
 * @param getAnchor 返回创建会话所需的 (sopId, goal, cardHash)；无锚点时返回 null。
 */
export function useWorkbenchSession(
  getAnchor: () => WorkbenchAnchor | null,
): UseWorkbenchSessionResult {
  const { t } = useTranslation();
  const [sessionId, setSessionId] = useState<string | null>(() => readSessionId());
  const [session, setSession] = useState<WorkbenchSessionView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [sessions, setSessions] = useState<WorkbenchSessionListItem[]>([]);
  const [sessionsState, setSessionsState] = useState<SessionListState>('idle');
  const [sessionsError, setSessionsError] = useState<string | null>(null);
  const startingRef = useRef(false);

  const reloadSessions = useCallback(() => {
    if (typeof listWorkbenchSessions !== 'function') return;
    let alive = true;
    setSessionsState('loading');
    setSessionsError(null);
    void (async () => {
      try {
        const list = await listWorkbenchSessions({ page: 1, pageSize: 20 });
        if (!alive) return;
        setSessions(list.items);
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

  useEffect(() => {
    if (!sessionId || typeof getWorkbenchSession !== 'function') return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const next = await getWorkbenchSession(sessionId);
        if (!alive) return;
        setSession(next);
        if (isTerminalSession(next.status)) return; // 终态：不再排下一次
      } catch (err: unknown) {
        if (!alive) return;
        const status = err as { __status?: number; status?: number; response?: { status?: number } } | null;
        const code = status?.__status ?? status?.status ?? status?.response?.status;
        if (code === 403 || code === 404) {
          // 失效/越权恢复：明确清掉本地锚点，绝不继续轮询别人的会话。
          clearSessionId();
          setSession(null);
          setSessionId(null);
          setError(t('workbench.session.createFail.notFound'));
          return;
        }
        // 其它读失败保留上一份快照；下次继续。
      }
      if (alive) timer = setTimeout(poll, SESSION_POLL_MS);
    };
    void poll();
    return () => { alive = false; if (timer) clearTimeout(timer); };
  }, [sessionId, t]);

  const errorText = useCallback((err: unknown): string => {
    const status = err as { __status?: number; status?: number; response?: { status?: number } } | null;
    const code = status?.__status ?? status?.status ?? status?.response?.status;
    // 字面 t() 分支（动态 t(key) 会被 i18n 缺键守卫判不可判）。
    if (code === 403) return t('workbench.session.createFail.forbidden');
    if (code === 400) return t('workbench.session.createFail.notDraft');
    if (code === 404) return t('workbench.session.createFail.notFound');
    if (code === 503) return t('workbench.session.createFail.unavailable');
    return t('workbench.session.createFailed', { reason: t('common.operateFailed') });
  }, [t]);

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

  const restore = useCallback((id: string) => {
    if (!isSessionId(id)) return;
    persistSessionId(id);
    setSessionId(id);
    setSession(null);
    setError(null);
  }, []);

  const reset = useCallback(() => {
    clearSessionId();
    setSessionId(null);
    setSession(null);
    setError(null);
  }, []);

  return {
    sessionId,
    session,
    error,
    starting,
    sessions,
    sessionsState,
    sessionsError,
    start,
    restore,
    reloadSessions,
    reset,
  };
}

/** 供页面判断锚点齐备（commitResult / result / submittedInput 三者齐全且已 submitted）。 */
export function sessionAnchor(
  commit: CommitResult | null,
  cardHash: string | undefined,
  goal: string | undefined,
): WorkbenchAnchor | null {
  if (!commit || !cardHash || !goal) return null;
  return { sopId: commit.sopId, goal, expectedCardHash: cardHash };
}
