import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { agentApi, type AgentSession } from '../api/agent';
import { useAgentSessionDetail } from '../hooks/useAgentSessionDetail';

vi.mock('../api/agent', () => ({ agentApi: { detail: vi.fn(), listApprovals: vi.fn() } }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function response(id: string, status: string) {
  const session: AgentSession = {
    id, status, kind: 'chat', title: 'Same title', triggerSource: 'user:test', createdBy: 'user:test',
    parentSessionId: null, contextJson: null, scopeJson: {}, budgetJson: null, resultJson: null, summary: null,
    errorMessage: null, totalSteps: 0, totalTokensIn: 0, totalTokensOut: 0, totalToolCalls: 0, waitingFor: null,
    startedAt: null, finishedAt: null, createdAt: '', updatedAt: '',
  };
  return { session, steps: [], toolCalls: [], children: [] };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(agentApi.listApprovals).mockResolvedValue([]);
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.resetAllMocks(); vi.restoreAllMocks(); });

describe('selected Agent session', () => {
  it('tracks progress while visible, skips overlapping polls, and stops at a terminal result', async () => {
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    const next = deferred<ReturnType<typeof response>>();
    vi.mocked(agentApi.detail).mockResolvedValueOnce(response('A', 'pending')).mockReturnValueOnce(next.promise);
    const { result } = renderHook(() => useAgentSessionDetail('A'));
    await act(async () => {});
    expect(result.current.detail?.session.status).toBe('pending');
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    await act(async () => { await vi.advanceTimersByTimeAsync(15000); });
    expect(agentApi.detail).toHaveBeenCalledTimes(1);
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    await act(async () => { await vi.advanceTimersByTimeAsync(30000); });
    expect(agentApi.detail).toHaveBeenCalledTimes(2);
    expect(result.current.detail?.session.status).toBe('pending');
    await act(async () => next.resolve(response('A', 'succeeded')));
    expect(result.current.detail?.session.status).toBe('succeeded');
    await act(async () => { await vi.advanceTimersByTimeAsync(30000); });
    expect(agentApi.detail).toHaveBeenCalledTimes(2);
    expect(agentApi.listApprovals).toHaveBeenCalledTimes(2);
  });

  it('closing while a read or an action is in flight does not reopen the session', async () => {
    const read = deferred<ReturnType<typeof response>>();
    vi.mocked(agentApi.detail).mockReturnValue(read.promise);
    const { result, rerender } = renderHook(({ id }: { id: string | null }) => useAgentSessionDetail(id),
      { initialProps: { id: 'A' } as { id: string | null } });
    await act(async () => {});
    expect(result.current.approvalsState).toBe('ready');
    expect(result.current.detailState).toBe('loading');
    const refreshAfterAction = result.current.refresh;
    rerender({ id: null });
    await act(async () => { read.resolve(response('A', 'running')); await refreshAfterAction('A'); });
    expect(result.current.detail).toBeNull();
    expect(agentApi.detail).toHaveBeenCalledTimes(1);
  });

  it('silent poll failure keeps the last ready detail and the polling interval alive', async () => {
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    vi.mocked(agentApi.detail)
      .mockResolvedValueOnce(response('A', 'running'))
      .mockRejectedValueOnce(new Error('transient read failure'))
      .mockResolvedValueOnce(response('A', 'succeeded'));
    const { result } = renderHook(() => useAgentSessionDetail('A'));
    await act(async () => {});
    expect(result.current.detail?.session.status).toBe('running');
    expect(result.current.detailState).toBe('ready');

    // Second frame: the 15s silent poll rejects. The last ready value survives,
    // isLive stays true and the interval is not torn down.
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
    expect(agentApi.detail).toHaveBeenCalledTimes(2);
    expect(result.current.detail?.session.status).toBe('running');
    expect(result.current.detailState).toBe('ready');
    expect(result.current.detailError).toBeNull();

    // Third frame: the next tick succeeds and the fresh value lands.
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
    expect(agentApi.detail).toHaveBeenCalledTimes(3);
    expect(result.current.detail?.session.status).toBe('succeeded');
  });

  it('manual refresh failure still publishes an error state', async () => {
    vi.mocked(agentApi.detail)
      .mockResolvedValueOnce(response('A', 'running'))
      .mockRejectedValueOnce(new Error('manual failure'));
    const { result } = renderHook(() => useAgentSessionDetail('A'));
    await act(async () => {});
    expect(result.current.detail?.session.status).toBe('running');

    await act(async () => { await result.current.refresh('A'); });
    expect(result.current.detailState).toBe('error');
    expect(result.current.detail).toBeNull();
    expect(result.current.detailError).toBeInstanceOf(Error);
  });
});
