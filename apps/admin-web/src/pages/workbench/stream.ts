/**
 * Pure helpers for applying workbench session snapshots and SSE frames.
 *
 * Kept separate from React so the delta semantics can be unit-tested without
 * mounting a page. Every reducer is immutable and ignores malformed frames.
 */
import type {
  WorkbenchApprovalItem,
  WorkbenchSessionDetail,
  WorkbenchStep,
  WorkbenchToolCall,
} from './types';

export type WorkbenchStreamStatus = 'connecting' | 'live' | 'polling';

export interface WorkbenchDeltaFrame {
  type: string;
  seq?: number;
  step?: unknown;
  toolCall?: unknown;
  approval?: unknown;
  artifact?: unknown;
  text?: string;
  delta?: string;
  phase?: string;
  status?: string;
  message?: string;
  session?: unknown;
  snapshot?: unknown;
  [key: string]: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function mergeStep(steps: WorkbenchStep[], incoming: WorkbenchStep): WorkbenchStep[] {
  const idx = steps.findIndex((s) => s.seq === incoming.seq);
  if (idx < 0) return [...steps, incoming].sort((a, b) => a.seq - b.seq);
  const next = [...steps];
  next[idx] = { ...next[idx], ...incoming };
  return next;
}

function parseStep(value: unknown): WorkbenchStep | null {
  if (!isRecord(value) || typeof value.seq !== 'number' || typeof value.role !== 'string') return null;
  const content = asString(value.content);
  const preview = asString(value.contentPreview);
  return {
    seq: value.seq,
    role: value.role,
    ...(content !== null ? { content } : {}),
    ...(preview !== null ? { contentPreview: preview } : {}),
    ...(typeof value.createdAt === 'string' ? { createdAt: value.createdAt } : {}),
  };
}

function mergeToolCall(items: WorkbenchToolCall[], incoming: WorkbenchToolCall): WorkbenchToolCall[] {
  const key = (item: WorkbenchToolCall) => item.id ?? item.toolName;
  const idx = items.findIndex((item) => key(item) === key(incoming));
  if (idx < 0) return [...items, incoming];
  const next = [...items];
  next[idx] = { ...next[idx], ...incoming };
  return next;
}

function parseToolCall(value: unknown): WorkbenchToolCall | null {
  if (!isRecord(value) || typeof value.toolName !== 'string') return null;
  return {
    id: asString(value.id) ?? undefined,
    toolName: value.toolName,
    status: asString(value.status) ?? 'unknown',
    argsPreview: asString(value.argsPreview),
    outputPreview: asString(value.outputPreview),
    errorSummary: asString(value.errorSummary),
    createdAt: asString(value.createdAt),
    stateChangedAt: asString(value.stateChangedAt),
  };
}

function parseApproval(value: unknown): WorkbenchApprovalItem | null {
  if (!isRecord(value) || typeof value.approvalKey !== 'string') return null;
  return {
    approvalKey: value.approvalKey,
    toolName: asString(value.toolName) ?? 'tool',
    status: asString(value.status) ?? 'pending',
    reason: asString(value.reason),
    argsDigest: asString(value.argsDigest),
    decidedBy: asString(value.decidedBy),
    createdAt: asString(value.createdAt),
    canDecide: value.canDecide === true,
    canWithdraw: value.canWithdraw === true,
    reviewUrl: asString(value.reviewUrl),
  };
}

function mergeApproval(items: WorkbenchApprovalItem[], incoming: WorkbenchApprovalItem): WorkbenchApprovalItem[] {
  const idx = items.findIndex((item) => item.approvalKey === incoming.approvalKey);
  if (idx < 0) return [incoming, ...items];
  const next = [...items];
  next[idx] = { ...next[idx], ...incoming };
  return next;
}

function frameText(frame: WorkbenchDeltaFrame): string {
  return frame.text ?? frame.delta ?? '';
}

/**
 * Apply durable frames / deltas to the current snapshot.
 * Unknown frame types are ignored: a resync must follow for real gaps.
 */
export function applyWorkbenchFrame(
  current: WorkbenchSessionDetail,
  frame: WorkbenchDeltaFrame,
): WorkbenchSessionDetail {
  let next = current;
  const step = parseStep(frame.step);
  if (step) {
    next = { ...next, steps: mergeStep(next.steps, step) };
  }

  const toolCall = parseToolCall(frame.toolCall);
  if (toolCall) {
    next = { ...next, toolCalls: mergeToolCall(next.toolCalls, toolCall) };
  }

  const approval = parseApproval(frame.approval);
  if (approval) {
    next = { ...next, approvalItems: mergeApproval(next.approvalItems, approval) };
  }

  const text = frameText(frame);
  if (text && frame.type.includes('delta')) {
    const seq = typeof frame.seq === 'number'
      ? frame.seq
      : (next.steps.length > 0 ? next.steps[next.steps.length - 1].seq : 0) + 1;
    const role = frame.type.startsWith('reasoning') ? 'reasoning' : 'assistant';
    const previous = next.steps.find((s) => s.seq === seq);
    const content = `${previous?.content ?? ''}${text}`;
    next = { ...next, steps: mergeStep(next.steps, { seq, role, content }) };
  }

  if (frame.type.includes('phase') && frame.phase) {
    next = { ...next, phase: frame.phase };
  }

  if (frame.status) {
    next = { ...next, status: frame.status };
  }

  const snapshot = parseSessionSnapshot(frame.session ?? frame.snapshot);
  if (snapshot) {
    next = { ...next, ...snapshot };
  }

  return next;
}

/** Parse partial session projections carried by status/phase frames. */
export function parseSessionSnapshot(value: unknown): Partial<WorkbenchSessionDetail> | null {
  if (!isRecord(value)) return null;
  const out: Partial<WorkbenchSessionDetail> = {};
  const sink = out as unknown as Record<string, unknown>;
  for (const key of ['sessionId', 'title', 'status', 'phase', 'errorMessage', 'waitingFor', 'createdAt', 'updatedAt'] as const) {
    const text = asString(value[key]);
    if (text !== null) sink[key] = text;
  }
  if (isRecord(value.approvals)) out.approvals = value.approvals as Record<string, number>;
  if ('conclusion' in value) out.conclusion = value.conclusion;
  const steps = Array.isArray(value.steps) ? value.steps.map(parseStep).filter((s): s is WorkbenchStep => s !== null) : [];
  if (steps.length > 0) out.steps = steps;
  const toolCalls = Array.isArray(value.toolCalls)
    ? value.toolCalls.map(parseToolCall).filter((t): t is WorkbenchToolCall => t !== null)
    : [];
  if (toolCalls.length > 0) out.toolCalls = toolCalls;
  const approvalItems = Array.isArray(value.approvalItems)
    ? value.approvalItems.map(parseApproval).filter((a): a is WorkbenchApprovalItem => a !== null)
    : [];
  if (approvalItems.length > 0) out.approvalItems = approvalItems;
  return Object.keys(out).length > 0 ? out : null;
}

/** Payload parser shared by the unnamed `message` frame and named events. */
export function parseWorkbenchFrame(data: string): WorkbenchDeltaFrame | null {
  if (!data.trim()) return null;
  try {
    const parsed: unknown = JSON.parse(data);
    if (!isRecord(parsed)) return null;
    const type = asString(parsed.type) ?? asString(parsed.event) ?? 'message';
    return { ...parsed, type };
  } catch {
    return null;
  }
}

export function maxObservedSeq(detail: WorkbenchSessionDetail): number {
  const stepSeq = detail.steps.reduce((max, step) => Math.max(max, step.seq), 0);
  return stepSeq;
}
