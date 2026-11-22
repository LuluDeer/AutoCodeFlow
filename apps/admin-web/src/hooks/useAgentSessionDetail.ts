import { useCallback, useEffect, useRef, useState } from 'react';
import { agentApi, type AgentApproval } from '../api/agent';
import { useRaceGuard } from '../utils/raceGuard';

type Detail = Awaited<ReturnType<typeof agentApi.detail>>;
type ReadState<T> = { status: 'loading' } | { status: 'ready'; value: T } | { status: 'error'; error: unknown };
type Snapshot = { id: string; detail: ReadState<Detail>; approvals: ReadState<AgentApproval[]> };
const loading = { status: 'loading' } as const;
const liveStatuses = new Set(['pending', 'running', 'waiting_input']);

/** Fetch by selected ID, never by list position. Each side of the drawer has its
 * own result (a slow detail read must not hold up approvals, or vice versa).
 * A route change invalidates outstanding reads and mutation-triggered refreshes. */
export function useAgentSessionDetail(id: string | null) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const guard = useRaceGuard();
  const selected = useRef<string | null>(null);
  const inFlight = useRef(false);

  const refresh = useCallback(async (requested: string, silent = false) => {
    const target = selected.current;
    if (!target || target.toLowerCase() !== requested.toLowerCase() || (silent && inFlight.current)) return;
    const seq = guard.next();
    inFlight.current = true;
    if (!silent) setSnapshot({ id: target, detail: loading, approvals: loading });
    const publish = (patch: Partial<Pick<Snapshot, 'detail' | 'approvals'>>) => {
      if (!guard.isLatest(seq)) return;
      setSnapshot(prev => prev?.id === target ? { ...prev, ...patch } : prev);
    };
    const readDetail = async () => {
      try {
        const value = await agentApi.detail(target);
        // A collection endpoint or a malformed response is not a session. Do
        // not render an unrelated record or expose its actions under this URL.
        if (value?.session?.id?.toLowerCase() !== target.toLowerCase()) {
          publish({ detail: { status: 'error', error: null } });
        } else {
          publish({ detail: { status: 'ready', value } });
        }
      } catch (error) {
        publish({ detail: { status: 'error', error } });
      }
    };
    const readApprovals = async () => {
      try {
        const value = await agentApi.listApprovals(target);
        publish({ approvals: { status: 'ready', value } });
      } catch (error) {
        publish({ approvals: { status: 'error', error } });
      }
    };
    await Promise.all([readDetail(), readApprovals()]);
    if (guard.isLatest(seq)) inFlight.current = false;
  }, [guard]);

  useEffect(() => {
    selected.current = id;
    if (id) void refresh(id);
    else setSnapshot(null);
    return () => { selected.current = null; guard.next(); inFlight.current = false; };
  }, [id, refresh, guard]);

  // Never paint the previous session, even for the render before the effect runs.
  const current = snapshot?.id === id ? snapshot : null;
  const detail = current?.detail.status === 'ready' ? current.detail.value : null;
  const approvals = current?.approvals.status === 'ready' ? current.approvals.value : [];
  const isLive = liveStatuses.has(detail?.session.status ?? '');
  useEffect(() => {
    if (!id || !isLive) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void refresh(id, true);
    }, 15_000);
    return () => window.clearInterval(timer);
  }, [id, isLive, refresh]);

  return {
    detail, approvals, refresh,
    detailState: current?.detail.status ?? 'loading',
    detailError: current?.detail.status === 'error' ? current.detail.error : null,
    approvalsState: current?.approvals.status ?? 'loading',
  };
}
