/**
 * Agent 会话详情 SSE（useAgentSessionLiveSession）定向测试。
 *
 * 钉住四件事（对应后端 agent-event-stream + contract）：
 *  ① SSE 帧应用：delta / durable event / tool_call / approval 折叠正确；
 *  ② snapshot 合并：synced.snapshot 覆盖式补回 mid-stream 文本，重复 seq 帧不重放；
 *  ③ resync_required：带 lastSeq 的 fromSeq 主动重连，不永久降级轮询；
 *  ④ 卸载清理：AbortController.abort + client.close，卸载后帧不再落状态。
 */
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyAgentLiveFrame,
  EMPTY_AGENT_LIVE_STATE,
  parseAgentLiveFrame,
  useAgentSessionLiveSession,
  type AgentLiveState,
} from '../hooks/useAgentSessionLiveSession';

const { createSseClientMock } = vi.hoisted(() => ({
  createSseClientMock: vi.fn(),
}));

vi.mock('../api/sse-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/sse-client')>();
  return { ...actual, createSseClient: createSseClientMock };
});

type CapturedOptions = {
  path: string;
  reconnect: boolean;
  query: () => Record<string, string | number>;
  events: Record<string, (e: { data: string }) => void>;
  onMessage: (e: { data: string }) => void;
  onStatus: (s: string) => void;
};

function captured(): CapturedOptions[] {
  return createSseClientMock.mock.calls.map((args) => args[0] as CapturedOptions);
}

/** 送一帧进指定连接的具名事件处理器。 */
function send(opts: CapturedOptions, name: string, payload: unknown) {
  opts.events[name]({ data: JSON.stringify(payload) });
}

beforeEach(() => {
  createSseClientMock.mockReset();
  vi.useFakeTimers();
  // 让 hook 认为浏览器有 EventSource（工厂本身被 mock，不会真建连）。
  vi.stubGlobal('EventSource', class FakeEventSource {});
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('SSE 帧解析与增量应用（纯函数）', () => {
  it('① 帧应用：token/reasoning/phase 增量与工具/审批 durable 事件', () => {
    let live: AgentLiveState = EMPTY_AGENT_LIVE_STATE;
    live = applyAgentLiveFrame(live, { type: 'token_delta', text: 'hel' });
    live = applyAgentLiveFrame(live, { type: 'token_delta', text: 'lo' });
    live = applyAgentLiveFrame(live, { type: 'reasoning_delta', text: 'think' });
    live = applyAgentLiveFrame(live, { type: 'phase_changed', phase: 'verify' });
    // durable event：带 seq 的 step/tool/approval 帧
    live = applyAgentLiveFrame(live, {
      type: 'event', seq: 3, kind: 'tool_call_recorded',
      payload: { toolCallId: 'tc-1', toolName: 'task_restart', status: 'in_flight' },
    });
    live = applyAgentLiveFrame(live, {
      type: 'event', seq: 4, kind: 'approval_decided',
      payload: { approvalKey: 'apr-1', status: 'granted', decidedBy: 'admin' },
    });

    expect(live.content).toBe('hello');
    expect(live.reasoning).toBe('think');
    expect(live.phase).toBe('verify');
    expect(live.lastSeq).toBe(4);
    expect(live.toolCalls).toEqual([
      { key: 'tc-1', toolName: 'task_restart', status: 'in_flight', approvalId: null },
    ]);
    expect(live.approvals).toEqual([
      { key: 'apr-1', status: 'granted', decidedBy: 'admin' },
    ]);

    // 同一 seq 的重复帧：引用保持不变（不重复渲染同一帧）
    const dup = applyAgentLiveFrame(live, {
      type: 'event', seq: 4, kind: 'approval_decided',
      payload: { approvalKey: 'apr-2', status: 'denied' },
    });
    expect(dup).toBe(live);
  });

  it('② snapshot 合并：synced 覆盖式补回累计文本并置截断标记', () => {
    let live: AgentLiveState = applyAgentLiveFrame(EMPTY_AGENT_LIVE_STATE, {
      type: 'token_delta', text: 'stale-window-text',
    });
    live = applyAgentLiveFrame(live, {
      type: 'synced', lastSeq: 12, status: 'running', hasMore: true, truncated: true,
      snapshot: { content: 'full-accumulated', reasoning: 'full-reasoning', phase: 'plan' },
    });
    expect(live.content).toBe('full-accumulated');
    expect(live.reasoning).toBe('full-reasoning');
    expect(live.phase).toBe('plan');
    expect(live.status).toBe('running');
    expect(live.lastSeq).toBe(12);
    expect(live.truncated).toBe(true);
    // snapshot 之后的新 delta 继续追加，不覆盖快照
    live = applyAgentLiveFrame(live, { type: 'token_delta', text: '+new' });
    expect(live.content).toBe('full-accumulated+new');
  });

  it('解析畸形帧返回 null，具名事件名作为 type 兜底', () => {
    expect(parseAgentLiveFrame('not json')).toBeNull();
    expect(parseAgentLiveFrame('[]')).toBeNull();
    expect(parseAgentLiveFrame('{"seq":1,"kind":"step_appended"}', 'event')?.type).toBe('event');
  });
});

describe('useAgentSessionLiveSession 传输层', () => {
  function setup() {
    const lastSeqRef = { current: 0 };
    const onFrame = vi.fn();
    const onResync = vi.fn();
    const onStatus = vi.fn();
    createSseClientMock.mockImplementation(() => ({ close: vi.fn() }));
    const hook = renderHook(() => useAgentSessionLiveSession({
      sessionId: 'sess-A', enabled: true, lastSeqRef, onFrame, onResync, onStatus,
    }));
    return { lastSeqRef, onFrame, onResync, onStatus, ...hook };
  }

  it('建连对齐 agent stream path，游标为 0 时不带 fromSeq', () => {
    setup();
    expect(captured()).toHaveLength(1);
    const opts = captured()[0];
    expect(opts.path).toBe('/agent/sessions/sess-A/stream');
    expect(opts.reconnect).toBe(false);
    expect(opts.query()).toEqual({});
    expect(Object.keys(opts.events).sort()).toEqual(
      ['delta', 'error', 'event', 'resync_required', 'synced'],
    );
  });

  it('③ resync_required：按 lastSeq 以 fromSeq 主动重连，且触发权威重读', async () => {
    const { lastSeqRef, onResync, onStatus } = setup();
    const first = captured()[0];

    act(() => {
      // 先来 replay 帧 + synced 边界，推进游标到 9
      send(first, 'event', { seq: 7, kind: 'step_appended', payload: {} });
      send(first, 'synced', { sessionId: 'sess-A', lastSeq: 9, status: 'running', activeStream: true });
    });
    expect(lastSeqRef.current).toBe(9);
    expect(onResync).toHaveBeenCalledWith('synced', expect.any(AbortSignal));

    act(() => {
      send(first, 'resync_required', { sessionId: 'sess-A', reason: 'subscriber_queue_overflow' });
    });
    expect(onResync).toHaveBeenCalledWith('resync_required', expect.any(AbortSignal));
    expect(onStatus).toHaveBeenCalledWith('reconnecting');
    // resync_required 走 0ms 重连（非永久降级轮询）
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(captured()).toHaveLength(2);
    expect(captured()[1].query()).toEqual({ fromSeq: 9 });
  });

  it('④ 卸载清理：abort 在途信号 + close 连接，卸载后帧不再落状态', () => {
    const { onFrame, onResync, unmount } = setup();
    const opts = captured()[0];
    let seenSignal: AbortSignal | null = null;
    onResync.mockImplementation((_reason: unknown, signal: AbortSignal) => {
      seenSignal = signal;
    });

    act(() => { send(opts, 'synced', { lastSeq: 2, status: 'running' }); });
    expect(seenSignal).not.toBeNull();
    expect(seenSignal!.aborted).toBe(false);

    const close = createSseClientMock.mock.results[0].value.close as ReturnType<typeof vi.fn>;
    unmount();
    expect(close).toHaveBeenCalled();
    expect(seenSignal!.aborted).toBe(true);

    const frameCount = onFrame.mock.calls.length;
    act(() => { send(opts, 'delta', { type: 'token_delta', text: 'late' }); });
    expect(onFrame).toHaveBeenCalledTimes(frameCount);
  });

  it('未选中会话不建流', () => {
    renderHook(() => useAgentSessionLiveSession({
      sessionId: null, enabled: false, lastSeqRef: { current: 0 },
      onFrame: vi.fn(), onResync: vi.fn(), onStatus: vi.fn(),
    }));
    expect(captured()).toHaveLength(0);
  });
});
