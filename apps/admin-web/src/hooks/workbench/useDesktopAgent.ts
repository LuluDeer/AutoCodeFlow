import { useCallback, useEffect, useState } from 'react';
import {
  getDesktopBridge,
  normalizeAgentEvent,
  normalizeAgentEvents,
  normalizeDesktopContext,
  type DesktopAgentEvent,
  type DesktopBridge,
  type DesktopContext,
} from '../../api/desktop-bridge';

const MAX_EVENTS = 8;

/** 只识别明确的终态摘要；未知文案按「仍在处理」展示，便于用户取消。 */
const TERMINAL_SUMMARY = /(结束|完成|已取消|取消|失败|转人工|succeed|complete|finish|cancel|failed|error|done)/i;

type UnknownRecord = Record<string, unknown>;
function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isTerminalEvent(event: DesktopAgentEvent): boolean {
  return event.type === 'error' || TERMINAL_SUMMARY.test(event.summary);
}

/**
 * 事件是增量流：任何非终态事件都意味着对应 assignment 仍在本机处理；
 * 终态事件只熄灭同一个 assignment（不同 assignment 的历史终态不误伤当前单）。
 */
function reduceActiveAssignmentId(current: string | null, event: DesktopAgentEvent): string | null {
  if (isTerminalEvent(event)) return current === event.assignmentId ? null : current;
  return event.assignmentId;
}

function activeAssignmentIdFromReplay(events: readonly DesktopAgentEvent[]): string | null {
  let active: string | null = null;
  for (const event of events) active = reduceActiveAssignmentId(active, event);
  return active;
}

export interface UseDesktopAgentResult {
  bridge: DesktopBridge | null;
  context: DesktopContext;
  events: readonly DesktopAgentEvent[];
  activeAssignmentId: string | null;
  running: boolean;
  cancelling: boolean;
  cancelError: boolean;
  cancelAssignment: () => Promise<void>;
}

/**
 * 只在桌面桥存在时读取上下文、回放最近事件并订阅实时事件。
 * 所有过桥 payload 在进入 state 前都经过字段白名单与长度截断。
 */
export function useDesktopAgent(): UseDesktopAgentResult {
  const [bridge] = useState<DesktopBridge | null>(() => getDesktopBridge());
  const [context, setContext] = useState<DesktopContext>({});
  const [events, setEvents] = useState<DesktopAgentEvent[]>([]);
  const [activeAssignmentId, setActiveAssignmentId] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [cancelError, setCancelError] = useState(false);

  useEffect(() => {
    if (!bridge) return;
    let alive = true;

    try {
      Promise.resolve(bridge.getDesktopContext())
        .then((value) => { if (alive) setContext(normalizeDesktopContext(value)); })
        .catch(() => { if (alive) setContext({}); });
    } catch {
      if (alive) setContext({});
    }

    try {
      Promise.resolve(bridge.getRecentAgentEvents())
        .then((value) => {
          if (!alive) return;
          const replay = normalizeAgentEvents(value).slice(-MAX_EVENTS);
          setEvents(replay);
          setActiveAssignmentId(activeAssignmentIdFromReplay(replay));
        })
        .catch(() => {
          if (!alive) return;
          setEvents([]);
          setActiveAssignmentId(null);
        });
    } catch {
      setEvents([]);
      setActiveAssignmentId(null);
    }

    const listener = (payload: unknown) => {
      if (!alive) return;
      const event = normalizeAgentEvent(payload);
      if (!event) return;
      setActiveAssignmentId((prev) => reduceActiveAssignmentId(prev, event));
      setEvents((prev) => [...prev, event].slice(-MAX_EVENTS));
    };

    let unsubscribe: (() => void) | null = null;
    try {
      const maybeUnsubscribe = bridge.onAgentEvent(listener);
      if (typeof maybeUnsubscribe === 'function') unsubscribe = maybeUnsubscribe;
    } catch {
      unsubscribe = null;
    }

    return () => {
      alive = false;
      if (typeof unsubscribe === 'function') unsubscribe();
    };
  }, [bridge]);

  const cancelAssignment = useCallback(async () => {
    if (!bridge || !activeAssignmentId || cancelling) return;
    setCancelling(true);
    setCancelError(false);
    try {
      const result = await Promise.resolve(bridge.cancelAgentAssignment(activeAssignmentId));
      const ok = typeof result === 'boolean'
        ? result
        : !isRecord(result) || result.ok !== false;
      if (ok) setActiveAssignmentId(null);
      else setCancelError(true);
    } catch {
      setCancelError(true);
    } finally {
      setCancelling(false);
    }
  }, [bridge, activeAssignmentId, cancelling]);

  return {
    bridge,
    context,
    events,
    activeAssignmentId,
    running: activeAssignmentId !== null,
    cancelling,
    cancelError,
    cancelAssignment,
  };
}
