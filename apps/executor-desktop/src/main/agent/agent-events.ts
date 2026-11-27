/**
 * Agent 托管的实时事件契约与澄清媒体引用类型（纯模块，无 Electron 依赖）。
 *
 * 由 agent-host / runtime / loop 产出，经 agent-worker stdout 协议流向主进程，
 * 再分别广播给工作台窗口（workbench:agentEvent）与桌面渲染层（agent:live-event），
 * 并在 reportProgress 心跳中附带最近事件摘要上报中台。
 */

export const AGENT_LIVE_EVENT_TYPES = [
  'phase',
  'plan',
  'file',
  'trial',
  'browser',
  'gui',
  'screenshot',
  'verify',
  'status',
  'error',
] as const;

export type AgentLiveEventType = (typeof AGENT_LIVE_EVENT_TYPES)[number];

export interface AgentLiveEvent {
  assignmentId: string;
  type: AgentLiveEventType;
  summary: string;
  detail?: string;
  timestamp: string;
}

export interface ClarificationMediaRef {
  kind: string;
  url: string;
  note?: string;
}

const VALID_EVENT_TYPES: ReadonlySet<string> = new Set(AGENT_LIVE_EVENT_TYPES);

/** 构造已截断/消毒的实时事件载荷（防超长输出撑爆协议行）。 */
export function createAgentLiveEvent(
  assignmentId: string,
  type: AgentLiveEventType,
  summary: string,
  detail?: string,
  timestamp: string = new Date().toISOString(),
): AgentLiveEvent {
  const cleanSummary = summary.slice(0, 300);
  const cleanDetail = typeof detail === 'string' && detail.length > 0 ? detail.slice(0, 1_000) : undefined;
  return {
    assignmentId,
    type,
    summary: cleanSummary,
    ...(cleanDetail !== undefined ? { detail: cleanDetail } : {}),
    timestamp,
  };
}

/** fail-closed 形状校验：worker 协议与跨进程边界共用。 */
export function isAgentLiveEvent(value: unknown): value is AgentLiveEvent {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const e = value as Record<string, unknown>;
  if (typeof e.assignmentId !== 'string' || e.assignmentId.length === 0) return false;
  if (typeof e.type !== 'string' || !VALID_EVENT_TYPES.has(e.type)) return false;
  if (typeof e.summary !== 'string') return false;
  if (e.detail !== undefined && typeof e.detail !== 'string') return false;
  if (typeof e.timestamp !== 'string' || e.timestamp.length === 0) return false;
  return true;
}
