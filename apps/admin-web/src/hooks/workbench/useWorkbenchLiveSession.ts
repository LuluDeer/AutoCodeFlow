/**
 * Live workbench session transport: SSE primary with dynamic `fromSeq` resume,
 * REST polling fallback only on stream failure, and per-session cleanup.
 *
 * This collaborator owns a single effect for one `sessionId`. Switching the
 * session unmounts the effect, which closes the old stream and stops polling —
 * two streams for one page are therefore impossible by construction.
 */
import { useEffect, type MutableRefObject } from 'react';
import { getApiBaseUrl } from '../../api/client';
import { createSseClient, type SseClient, type SseClientStatus } from '../../api/sse-client';
import { isTerminalSession } from '../../components/workbench/WorkbenchSessionPanel';
import {
  applyWorkbenchFrame,
  maxObservedSeq,
  parseWorkbenchFrame,
  type WorkbenchStreamStatus,
} from '../../pages/workbench/stream';
import type { WorkbenchSessionDetail } from '../../pages/workbench/types-public';

export interface WorkbenchLiveSessionOptions {
  sessionId: string | null;
  detailRef: MutableRefObject<WorkbenchSessionDetail | null>;
  lastSeqRef: MutableRefObject<number>;
  setDetail: (next: WorkbenchSessionDetail | null) => void;
  setStreamStatus: (status: WorkbenchStreamStatus) => void;
  fetchDetail: (id: string) => Promise<WorkbenchSessionDetail | null>;
  onUnauthorized: () => void;
}

const SSE_EVENTS = [
  'synced',
  'resync_required',
  'phase_changed',
  'status_changed',
  'tool_call_delta',
  'token_delta',
  'reasoning_delta',
] as const;

const POLL_INTERVAL_MS = 2000;

export function useWorkbenchLiveSession({
  sessionId,
  detailRef,
  lastSeqRef,
  setDetail,
  setStreamStatus,
  fetchDetail,
  onUnauthorized,
}: WorkbenchLiveSessionOptions): void {
  useEffect(() => {
    if (!sessionId) {
      setDetail(null);
      lastSeqRef.current = 0;
      return;
    }

    let alive = true;
    let client: SseClient | null = null;
    let pollTimer: ReturnType<typeof setTimeout> | undefined;
    let polling = false;
    const activeId = sessionId;

    const applySnapshot = (next: WorkbenchSessionDetail | null) => {
      if (!alive || !next) return;
      if (next.steps.length > 0) lastSeqRef.current = Math.max(lastSeqRef.current, maxObservedSeq(next));
      setDetail(next);
    };

    const stopPolling = () => {
      polling = false;
      if (pollTimer !== undefined) clearTimeout(pollTimer);
      pollTimer = undefined;
    };

    const startPolling = () => {
      if (!alive || polling) return;
      polling = true;
      setStreamStatus('polling');
      const poll = async () => {
        if (!alive || !polling) return;
        try {
          const next = await fetchDetail(activeId);
          if (!alive || !polling) return;
          applySnapshot(next);
          if (next && isTerminalSession(next.status)) { stopPolling(); return; }
        } catch {
          // Keep the last snapshot; retry on the next tick.
        }
        if (alive && polling) pollTimer = setTimeout(() => void poll(), POLL_INTERVAL_MS);
      };
      void poll();
    };

    const handleFrame = (data: string) => {
      if (!alive) return;
      const frame = parseWorkbenchFrame(data);
      if (!frame) return;
      if (frame.type === 'synced' || frame.type === 'resync_required') {
        void fetchDetail(activeId).then(applySnapshot).catch(() => { /* poll owns retries */ });
        return;
      }
      if (typeof frame.seq === 'number') lastSeqRef.current = Math.max(lastSeqRef.current, frame.seq);
      const previous = detailRef.current;
      if (!previous) return;
      const next = applyWorkbenchFrame(previous, frame);
      setDetail(next);
      if (isTerminalSession(next.status)) client?.close();
    };

    const bootstrap = async () => {
      try {
        applySnapshot(await fetchDetail(activeId));
      } catch (err: unknown) {
        if (!alive) return;
        const obj = err as { __status?: number; status?: number; response?: { status?: number } } | null;
        const code = obj?.__status ?? obj?.status ?? obj?.response?.status;
        if (code === 403 || code === 404) {
          onUnauthorized();
          return;
        }
        startPolling();
        return;
      }
      if (!alive || !detailRef.current || isTerminalSession(detailRef.current.status)) return;
      // jsdom/SSR has no EventSource: the REST snapshot above is the only read,
      // so existing tests still observe exactly one getWorkbenchSession call.
      if (typeof EventSource === 'undefined') return;

      const events: Record<string, (e: MessageEvent) => void> = {};
      for (const name of SSE_EVENTS) events[name] = (e) => handleFrame(e.data);

      client = createSseClient({
        baseUrl: getApiBaseUrl(),
        path: `/workbench/sessions/${encodeURIComponent(activeId)}/stream`,
        query: () => {
          // Omitting the key is semantically different from sending -1: the
          // stream starts from the beginning only when no resume cursor exists.
          const params: Record<string, string | number> = {};
          if (lastSeqRef.current > 0) params.fromSeq = lastSeqRef.current + 1;
          return params;
        },
        reconnect: false,
        onStatus: (s: SseClientStatus) => {
          if (!alive) return;
          if (s === 'live') {
            setStreamStatus('live');
            stopPolling();
          } else if (s === 'reconnecting') {
            setStreamStatus('polling');
            startPolling();
          } else {
            setStreamStatus('connecting');
          }
        },
        onMessage: (e) => handleFrame(e.data),
        events,
      });
    };

    void bootstrap();

    return () => {
      alive = false;
      stopPolling();
      client?.close();
      client = null;
    };
  }, [sessionId, detailRef, lastSeqRef, setDetail, setStreamStatus, fetchDetail, onUnauthorized]);
}
