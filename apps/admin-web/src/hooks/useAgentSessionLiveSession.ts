/**
 * Agent 会话详情的实时流（SSE）传输层——对齐 workbench/useWorkbenchLiveSession 的
 * 传输形态，但消费的是后端 `GET /agent/sessions/:id/stream`（agent-event-stream）。
 *
 * 后端帧（已核 admin-api agent-event-stream.service.ts + agent-event-stream.contract.ts）：
 *  - replay：具名 `event` 帧 `{ seq, kind, payload, createdAt }`（按 seq 递增，可能超限截断）
 *  - `synced`：`{ sessionId, lastSeq, status, activeStream, snapshot?, hasMore?, truncated? }`
 *    · `snapshot = { content?, reasoning?, phase? }` 是 mid-stream 刷新窗口的**累计**文本
 *  - `delta`：`{ type: token_delta|reasoning_delta|tool_call_delta|phase_changed|status_changed, ... }`
 *  - `resync_required`：`{ sessionId, reason }`（后端发完立刻断流，客户端必须带 fromSeq 重连）
 *  - `error` / `: ping`（心跳注释由 EventSource 自行维持，无需数据帧）
 *
 * 纪律（与 workbench 同款）：
 *  1. REST 快照仍由 useAgentSessionDetail 拥有；本 hook 只负责建流、解析、去重、重连。
 *  2. `reconnect:false` + 自管重连：断流/resync_required 都按 lastSeqRef 的 fromSeq 续传，
 *     绝不永久降级为轮询；轮询只是 SSE 不可用期间的兜底（由 detail hook 持有）。
 *  3. AbortController + close() 双重清理：卸载/切会话时中断在途 resync、停定时器、关连接。
 *  4. 可见性/卸载清理委托 createSseClient（标签页隐藏主动停流，切回按 fromSeq 续传）。
 */
import { useEffect, useRef, type MutableRefObject } from 'react';
import { getApiBaseUrl } from '../api/client';
import {
  createSseClient,
  sseReconnectBackoffMs,
  type SseClient,
  type SseClientStatus,
} from '../api/sse-client';

/** 与 workbench 流状态同一词表；`polling` 对应 workbench.stream.fallback 文案。 */
export type AgentSessionStreamStatus = 'connecting' | 'live' | 'polling' | 'reconnecting';

export type AgentResyncReason = 'synced' | 'resync_required' | 'error' | 'disconnect';

/** 归一化后的帧；`type` 永有值（具名事件名 + payload.type 二者取其一）。 */
export interface AgentLiveFrame {
  type: string;
  seq?: number;
  kind?: string;
  payload?: Record<string, unknown>;
  text?: string;
  name?: string;
  args?: unknown;
  phase?: string;
  status?: string;
  lastSeq?: number;
  activeStream?: boolean;
  snapshot?: { content?: string; reasoning?: string; phase?: string };
  hasMore?: boolean;
  truncated?: boolean;
  reason?: string;
  message?: string;
  sessionId?: string;
  [key: string]: unknown;
}

export interface AgentLiveToolCall {
  key: string;
  toolName: string;
  status: string;
  approvalId?: string | null;
}

export interface AgentLiveApproval {
  key: string;
  status: string;
  decidedBy?: string | null;
}

/**
 * 由增量帧折叠出的「实时尾段」。与 REST detail 分开保存：REST 是权威快照，
 * 本状态只表达**本次刷新窗口之后**的增量，resync 时由 synced.snapshot 覆盖式补回。
 */
export interface AgentLiveState {
  content: string;
  reasoning: string;
  phase: string | null;
  status: string | null;
  lastSeq: number;
  /** replay 被 LIMIT 截断（hasMore/truncated）；提示用户历史不全。 */
  truncated: boolean;
  lastKind: string | null;
  toolCalls: AgentLiveToolCall[];
  approvals: AgentLiveApproval[];
}

export const EMPTY_AGENT_LIVE_STATE: AgentLiveState = {
  content: '',
  reasoning: '',
  phase: null,
  status: null,
  lastSeq: 0,
  truncated: false,
  lastKind: null,
  toolCalls: [],
  approvals: [],
};

const SSE_EVENTS = ['event', 'delta', 'synced', 'resync_required', 'error'] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** SSE `data:` → 归一化帧。畸形帧返回 null（忽略而不中断整条流）。 */
export function parseAgentLiveFrame(data: string, eventName = 'message'): AgentLiveFrame | null {
  if (typeof data !== 'string' || data.trim() === '') return null;
  try {
    const parsed: unknown = JSON.parse(data);
    if (!isRecord(parsed)) return null;
    const type = str(parsed.type) ?? str(parsed.event) ?? eventName;
    return { ...parsed, type } as AgentLiveFrame;
  } catch {
    return null;
  }
}

function upsert<T extends { key: string }>(rows: T[], incoming: T): T[] {
  const idx = rows.findIndex((r) => r.key === incoming.key);
  if (idx < 0) return [...rows, incoming];
  const next = [...rows];
  next[idx] = { ...next[idx], ...incoming };
  return next;
}

/**
 * 纯函数：把一帧折叠进实时尾段。
 *  - durable `event` 帧按 seq 去重（replay 与实时帧可能重复到达）；
 *  - `synced.snapshot` **覆盖式**补回累计文本（不是追加，避免窗口文本翻倍）；
 *  - 工具调用/审批按 key 合并，供页面显示增量而不重复渲染整张表。
 */
export function applyAgentLiveFrame(current: AgentLiveState, frame: AgentLiveFrame): AgentLiveState {
  let next = current;

  if (typeof frame.seq === 'number' && frame.seq > 0) {
    if (frame.seq <= current.lastSeq) return current; // 同一帧不重复应用
    next = { ...next, lastSeq: frame.seq };
  }

  switch (frame.type) {
    case 'token_delta': {
      const text = str(frame.text);
      if (text) next = { ...next, content: next.content + text };
      break;
    }
    case 'reasoning_delta': {
      const text = str(frame.text);
      if (text) next = { ...next, reasoning: next.reasoning + text };
      break;
    }
    case 'phase_changed': {
      const phase = str(frame.phase);
      if (phase) next = { ...next, phase };
      break;
    }
    case 'status_changed': {
      const status = str(frame.status);
      if (status) next = { ...next, status };
      break;
    }
    case 'tool_call_delta': {
      const name = str(frame.name);
      if (name) {
        next = {
          ...next,
          toolCalls: upsert(next.toolCalls, {
            key: `delta:${name}`,
            toolName: name,
            status: 'in_flight',
          }),
        };
      }
      break;
    }
    case 'synced': {
      if (typeof frame.lastSeq === 'number' && frame.lastSeq > next.lastSeq) {
        next = { ...next, lastSeq: frame.lastSeq };
      }
      if (frame.snapshot) {
        const snap = frame.snapshot;
        next = {
          ...next,
          content: str(snap.content) ?? next.content,
          reasoning: str(snap.reasoning) ?? next.reasoning,
          phase: str(snap.phase) ?? next.phase,
        };
      }
      if (frame.truncated === true || frame.hasMore === true) {
        next = { ...next, truncated: true };
      }
      const status = str(frame.status);
      if (status) next = { ...next, status };
      break;
    }
    case 'event': {
      const kind = str(frame.kind) ?? '';
      const payload = isRecord(frame.payload) ? frame.payload : {};
      const phase = str(payload.phase);
      const status = str(payload.status);
      next = {
        ...next,
        lastKind: kind || next.lastKind,
        ...(phase ? { phase } : {}),
        ...(status ? { status } : {}),
      };
      if (kind === 'tool_call_recorded' || kind === 'tool_call_status_changed') {
        const key = str(payload.toolCallId) ?? str(payload.toolName) ?? `tc:${frame.seq ?? 0}`;
        next = {
          ...next,
          toolCalls: upsert(next.toolCalls, {
            key,
            toolName: str(payload.toolName) ?? 'unknown',
            status: str(payload.status) ?? 'unknown',
            approvalId: str(payload.approvalId) ?? null,
          }),
        };
      }
      if (kind === 'approval_decided' || kind === 'approval_requested') {
        const key = str(payload.approvalKey) ?? `apr:${frame.seq ?? 0}`;
        next = {
          ...next,
          approvals: upsert(next.approvals, {
            key,
            status: str(payload.status) ?? 'pending',
            decidedBy: str(payload.decidedBy) ?? null,
          }),
        };
      }
      break;
    }
    case 'resync_required':
    case 'error':
    default:
      break;
  }
  return next;
}

export interface UseAgentSessionLiveSessionOptions {
  sessionId: string | null;
  /** 仅 live 会话建流；终态/未选中不建。 */
  enabled: boolean;
  /** 续传游标：hook 在每帧后更新，重连时以 lastSeq 作为 fromSeq。 */
  lastSeqRef: MutableRefObject<number>;
  /** 每帧回调：调用方用 applyAgentLiveFrame 折叠进自己的快照。 */
  onFrame: (frame: AgentLiveFrame, signal: AbortSignal) => void;
  /** synced/resync_required/error 后的权威快照重读；signal 随会话生命周期中断。 */
  onResync: (reason: AgentResyncReason, signal: AbortSignal) => void;
  onStatus: (status: AgentSessionStreamStatus) => void;
}

/**
 * 建流 + 帧分发 + 自管重连。REST 读取与状态合并由调用方（useAgentSessionDetail）负责。
 */
export function useAgentSessionLiveSession({
  sessionId,
  enabled,
  lastSeqRef,
  onFrame,
  onResync,
  onStatus,
}: UseAgentSessionLiveSessionOptions): void {
  // 回调放 ref：effect 只随 sessionId/enabled 重建，避免每次渲染都重连。
  const handlers = useRef({ onFrame, onResync, onStatus });
  handlers.current = { onFrame, onResync, onStatus };

  useEffect(() => {
    const report = (s: AgentSessionStreamStatus) => handlers.current.onStatus(s);
    if (!sessionId || !enabled) {
      report('connecting');
      return;
    }

    const activeId = sessionId;
    // jsdom/SSR 无 EventSource：保持兜底轮询（status 停在 connecting），不建流。
    if (typeof EventSource === 'undefined') return;

    let alive = true;
    let attempt = 0;
    let client: SseClient | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    const ac = new AbortController();
    const signal = ac.signal;

    // 函数声明（提升）：connect 的回调与重连逻辑互相引用，避免 const 的 TDZ。
    function clearReconnect() {
      if (reconnectTimer !== undefined) {
        clearTimeout(reconnectTimer);
        reconnectTimer = undefined;
      }
    }

    function connect() {
      if (!alive || signal.aborted) return;
      client?.close();
      const events: Record<string, (e: MessageEvent) => void> = {};
      for (const name of SSE_EVENTS) {
        events[name] = (e: MessageEvent) => handleFrame(name, e.data);
      }
      client = createSseClient({
        baseUrl: getApiBaseUrl(),
        path: `/agent/sessions/${encodeURIComponent(activeId)}/stream`,
        // 每次建连（含重连）现场求值：游标取当前已见最大 seq，后端按 seq > fromSeq 重放。
        query: (): Record<string, string | number> => {
          const cursor = lastSeqRef.current;
          return cursor > 0 ? { fromSeq: cursor } : {};
        },
        reconnect: false, // 重连由本 hook 按 fromSeq 自管，断流不永久降级
        events,
        onMessage: (e: MessageEvent) => handleFrame('message', e.data),
        onStatus: (s: SseClientStatus) => {
          if (!alive || signal.aborted) return;
          if (s === 'live') {
            attempt = 0;
            clearReconnect();
            report('live');
          } else if (s === 'reconnecting') {
            report('reconnecting');
            scheduleReconnect('disconnect');
          } else {
            report('connecting');
          }
        },
      });
    }

    function scheduleReconnect(reason: AgentResyncReason) {
      if (!alive || signal.aborted) return;
      // 已有重连在途：不重复触发 REST 重读（inFlight 之外再加一道门）。
      if (reconnectTimer !== undefined) return;
      if (reason !== 'synced') {
        handlers.current.onResync(reason, signal);
      }
      const delay = reason === 'resync_required' ? 0 : sseReconnectBackoffMs(attempt);
      attempt += 1;
      report('reconnecting');
      clearReconnect();
      reconnectTimer = setTimeout(() => {
        reconnectTimer = undefined;
        if (!alive || signal.aborted) return;
        client?.close();
        client = null;
        connect();
      }, delay);
    }

    function handleFrame(eventName: string, data: string) {
      if (!alive || signal.aborted) return;
      const frame = parseAgentLiveFrame(data, eventName);
      if (!frame) return;

      if (eventName === 'synced' || frame.type === 'synced') {
        const lastSeq = typeof frame.lastSeq === 'number' ? frame.lastSeq : 0;
        lastSeqRef.current = Math.max(lastSeqRef.current, lastSeq);
        handlers.current.onFrame(frame, signal);
        // synced 是权威边界：重读一次 REST 快照，避免 replay 与实时帧错位。
        handlers.current.onResync('synced', signal);
        return;
      }

      if (frame.type === 'resync_required') {
        scheduleReconnect('resync_required');
        return;
      }

      if (frame.type === 'error') {
        scheduleReconnect('error');
        return;
      }

      const seq = typeof frame.seq === 'number' ? frame.seq : 0;
      if (seq > lastSeqRef.current) lastSeqRef.current = seq;
      handlers.current.onFrame(frame, signal);
      // 终态帧：关流，后续由 detail 的 isLive 判定停止轮询。
      const status = str(frame.status);
      if (status && ['succeeded', 'failed', 'aborted', 'budget_exceeded'].includes(status)) {
        client?.close();
      }
    }

    connect();

    return () => {
      alive = false;
      ac.abort();
      clearReconnect();
      client?.close();
      client = null;
      report('connecting');
    };
  }, [sessionId, enabled, lastSeqRef]);
}
