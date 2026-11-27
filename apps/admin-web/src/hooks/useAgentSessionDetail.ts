import { useCallback, useEffect, useRef, useState } from 'react';
import { agentApi, type AgentApproval } from '../api/agent';
import { useRaceGuard } from '../utils/raceGuard';
import {
  applyAgentLiveFrame,
  EMPTY_AGENT_LIVE_STATE,
  useAgentSessionLiveSession,
  type AgentLiveFrame,
  type AgentLiveState,
  type AgentSessionStreamStatus,
} from './useAgentSessionLiveSession';

type Detail = Awaited<ReturnType<typeof agentApi.detail>>;
type ReadState<T> = { status: 'loading' } | { status: 'ready'; value: T } | { status: 'error'; error: unknown };
type Snapshot = { id: string; detail: ReadState<Detail>; approvals: ReadState<AgentApproval[]> };
const loading = { status: 'loading' } as const;
const liveStatuses = new Set(['pending', 'running', 'waiting_input']);

/** Fetch by selected ID, never by list position. Each side of the drawer has its
 * own result (a slow detail read must not hold up approvals, or vice versa).
 * A route change invalidates outstanding reads and mutation-triggered refreshes.
 *
 * `silent` means the 15s background poll or an SSE `synced` boundary: a failed/
 * malformed read is discarded and the last ready snapshot is kept for the next
 * tick — the same semantics as `AgentSessionsPage.load({ silent: true })`. Only
 * first paint and manual refresh publish an error state.
 *
 * SSE (`useAgentSessionLiveSession`) owns incremental token/reasoning/phase and
 * tool/approval deltas; REST stays the authoritative snapshot. The 15s poll is
 * kept as fallback but suppressed while the SSE stream is `live`, so the same
 * frame is never rendered twice (replay frames are additionally deduped by seq
 * inside `applyAgentLiveFrame`). */
export function useAgentSessionDetail(id: string | null) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [live, setLive] = useState<AgentLiveState>(EMPTY_AGENT_LIVE_STATE);
  const [streamStatus, setStreamStatus] = useState<AgentSessionStreamStatus>('connecting');
  const guard = useRaceGuard();
  const selected = useRef<string | null>(null);
  const inFlight = useRef(false);
  const lastSeqRef = useRef(0);

  const refresh = useCallback(async (requested: string, silent = false) => {
    const target = selected.current;
    if (!target || target.toLowerCase() !== requested.toLowerCase() || (silent && inFlight.current)) return;
    const seq = guard.next();
    inFlight.current = true;
    if (!silent) {
      setSnapshot({ id: target, detail: loading, approvals: loading });
      // 首屏/手动刷新重建权威快照：清空上一轮 SSE 尾段（含可能残留的终态
      // status 帧），避免 stale live.status 盖住新的 REST 状态。
      setLive(EMPTY_AGENT_LIVE_STATE);
    }
    const publish = (patch: Partial<Pick<Snapshot, 'detail' | 'approvals'>>) => {
      if (!guard.isLatest(seq)) return;
      setSnapshot(prev => prev?.id === target ? { ...prev, ...patch } : prev);
    };
    const readDetail = async () => {
      try {
        const value = await agentApi.detail(target);
        // A collection endpoint or a malformed response is not a session. Do
        // not render an unrelated record or expose its actions under this URL.
        // During a silent poll, drop the bad response and keep the last ready
        // detail: writing an error here would clear `detail`, flip `isLive` to
        // false and tear down the polling interval permanently. First paint /
        // manual refresh still surfaces the error as before.
        if (value?.session?.id?.toLowerCase() !== target.toLowerCase()) {
          if (!silent) publish({ detail: { status: 'error', error: null } });
        } else {
          publish({ detail: { status: 'ready', value } });
        }
      } catch (error) {
        if (!silent) publish({ detail: { status: 'error', error } });
      }
    };
    const readApprovals = async () => {
      try {
        const value = await agentApi.listApprovals(target);
        publish({ approvals: { status: 'ready', value } });
      } catch (error) {
        // Silent-poll failures keep the previous approvals value; next tick retries.
        if (!silent) publish({ approvals: { status: 'error', error } });
      }
    };
    await Promise.all([readDetail(), readApprovals()]);
    if (guard.isLatest(seq)) inFlight.current = false;
  }, [guard]);

  const handleFrame = useCallback((frame: AgentLiveFrame, signal: AbortSignal) => {
    if (signal.aborted) return;
    setLive(prev => {
      const next = applyAgentLiveFrame(prev, frame);
      // synced 边界后 REST 快照会带回权威 toolCalls/approvals；清掉这里的增量行
      // 避免同一条调用在「增量横幅」与「权威表」里重复出现。
      if (frame.type === 'synced') {
        return { ...next, toolCalls: [], approvals: [] };
      }
      return next;
    });
  }, []);

  const handleResync = useCallback((_reason: unknown, signal: AbortSignal) => {
    const target = selected.current;
    if (!target || signal.aborted) return;
    void refresh(target, true);
  }, [refresh]);

  useEffect(() => {
    selected.current = id;
    lastSeqRef.current = 0;
    setLive(EMPTY_AGENT_LIVE_STATE);
    setStreamStatus('connecting');
    if (id) void refresh(id);
    else setSnapshot(null);
    return () => { selected.current = null; guard.next(); inFlight.current = false; };
  }, [id, refresh, guard]);

  // Never paint the previous session, even for the render before the effect runs.
  const current = snapshot?.id === id ? snapshot : null;
  const detail = current?.detail.status === 'ready' ? current.detail.value : null;
  const approvals = current?.approvals.status === 'ready' ? current.approvals.value : [];
  // 实时 status 帧可先把会话标成终态，SSE effect 据此停流；REST 未达时回落快照状态。
  const effectiveStatus = live.status ?? detail?.session.status ?? '';
  const isLive = liveStatuses.has(effectiveStatus);

  useAgentSessionLiveSession({
    sessionId: id,
    enabled: Boolean(id) && isLive,
    lastSeqRef,
    onFrame: handleFrame,
    onResync: handleResync,
    onStatus: setStreamStatus,
  });

  // 15s 轮询兜底：SSE live 时停掉无效轮询（synced/resync 已负责权威重读），
  // 断流（connecting/polling/reconnecting）时恢复，避免同一帧被两条通道重复消费。
  useEffect(() => {
    if (!id || !isLive || streamStatus === 'live') return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void refresh(id, true);
    }, 15_000);
    return () => window.clearInterval(timer);
  }, [id, isLive, refresh, streamStatus]);

  return {
    detail, approvals, refresh,
    detailState: current?.detail.status ?? 'loading',
    detailError: current?.detail.status === 'error' ? current.detail.error : null,
    approvalsState: current?.approvals.status ?? 'loading',
    // 实时增量（token/reasoning/phase/tool/approval）与传输状态，供页面横幅消费。
    live,
    streamStatus,
    isLive,
  };
}
