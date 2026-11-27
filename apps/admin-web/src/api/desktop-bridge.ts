/**
 * admin-web 侧唯一的桌面工作台桥接入口。
 *
 * 纪律：
 *  - 只读取 `window.workbenchApi`，不 import electron、不走 axios；
 *  - SSR / 普通浏览器 / 方法不全一律返回 null，调用方保持原 Web 行为；
 *  - 过桥数据一律按不可信输入归一化后再进入 React 状态。
 */

export type DesktopAgentEventType =
  | 'phase'
  | 'plan'
  | 'file'
  | 'trial'
  | 'browser'
  | 'gui'
  | 'screenshot'
  | 'verify'
  | 'status'
  | 'error';

export const DESKTOP_AGENT_EVENT_TYPES: readonly DesktopAgentEventType[] = [
  'phase', 'plan', 'file', 'trial', 'browser', 'gui', 'screenshot', 'verify', 'status', 'error',
];

export interface DesktopAgentEvent {
  assignmentId: string;
  type: DesktopAgentEventType;
  summary: string;
  detail?: string;
  timestamp: string;
}

export interface DesktopContext {
  executorName?: string;
  agentEnabled?: boolean;
  platformConfigured?: boolean;
}

export interface DesktopPickedFile {
  name: string;
  size?: number;
  mimeType?: string;
  /** 仅用于本地展示；任何情况下都不进入 prompt/context/请求体。 */
  textPreview?: string;
}

export interface DesktopCancelResult {
  ok?: boolean;
}

/**
 * 本模块消费的窄桥面；桥上其余方法一律不在本模块的依赖与转发范围内。
 */
export interface DesktopBridge {
  pickLocalFiles: () => Promise<readonly DesktopPickedFile[]>;
  getDesktopContext: () => Promise<DesktopContext>;
  getRecentAgentEvents: () => Promise<readonly DesktopAgentEvent[]>;
  onAgentEvent: (listener: (event: unknown) => void) => () => void;
  cancelAgentAssignment: (assignmentId?: string) => Promise<DesktopCancelResult>;
}

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 返回可用的桌面桥；非 Electron、SSR、桥方法不全都返回 null。
 * 逐方法 typeof 探测，避免「半个桥」进入业务路径后运行时炸裂。
 */
export function getDesktopBridge(): DesktopBridge | null {
  if (typeof window === 'undefined') return null;
  const candidate = (window as Window & { workbenchApi?: unknown }).workbenchApi;
  if (!isRecord(candidate)) return null;
  if (
    typeof candidate.pickLocalFiles !== 'function' ||
    typeof candidate.getDesktopContext !== 'function' ||
    typeof candidate.getRecentAgentEvents !== 'function' ||
    typeof candidate.onAgentEvent !== 'function' ||
    typeof candidate.cancelAgentAssignment !== 'function'
  ) {
    return null;
  }
  return candidate as unknown as DesktopBridge;
}

/** 桌面上下文只认三个白名单字段，其余字段（含凭据/路径）就地丢弃。 */
export function normalizeDesktopContext(value: unknown): DesktopContext {
  if (!isRecord(value)) return {};
  const out: DesktopContext = {};
  if (typeof value.executorName === 'string') {
    out.executorName = value.executorName.trim().slice(0, 120);
  }
  if (typeof value.agentEnabled === 'boolean') out.agentEnabled = value.agentEnabled;
  if (typeof value.platformConfigured === 'boolean') out.platformConfigured = value.platformConfigured;
  return out;
}

/** 文件选择器只投影 name/size/mimeType/textPreview；路径永不进入前端状态。 */
export function normalizePickedFiles(value: unknown): DesktopPickedFile[] {
  if (!Array.isArray(value)) return [];
  const out: DesktopPickedFile[] = [];
  for (const raw of value) {
    if (!isRecord(raw)) continue;
    const name = typeof raw.name === 'string' ? raw.name.trim().slice(0, 255) : '';
    if (!name) continue;
    const file: DesktopPickedFile = { name };
    if (typeof raw.size === 'number' && Number.isFinite(raw.size) && raw.size >= 0) {
      file.size = raw.size;
    }
    if (typeof raw.mimeType === 'string' && raw.mimeType.length <= 100) {
      file.mimeType = raw.mimeType;
    }
    if (typeof raw.textPreview === 'string') {
      file.textPreview = raw.textPreview.slice(0, 64 * 1024);
    }
    out.push(file);
    if (out.length >= 20) break;
  }
  return out;
}

/** Agent 事件白名单校验：非法字段、非法类型、缺失必填字段全部丢弃。 */
export function normalizeAgentEvent(value: unknown): DesktopAgentEvent | null {
  if (!isRecord(value)) return null;
  const assignmentId = typeof value.assignmentId === 'string' ? value.assignmentId.trim().slice(0, 120) : '';
  const type = typeof value.type === 'string' && DESKTOP_AGENT_EVENT_TYPES.includes(value.type as DesktopAgentEventType)
    ? value.type as DesktopAgentEventType
    : null;
  const summary = typeof value.summary === 'string' ? value.summary.trim().slice(0, 300) : '';
  const timestamp = typeof value.timestamp === 'string' ? value.timestamp.trim().slice(0, 80) : '';
  if (!assignmentId || !type || !summary || !timestamp) return null;

  // detail 是可选纯文本字段；出现非字符串形态即视为不可信 payload，整条丢弃。
  if (
    'detail' in value &&
    value.detail !== undefined &&
    (typeof value.detail !== 'string' || value.detail.trim() === '')
  ) {
    return null;
  }

  const event: DesktopAgentEvent = { assignmentId, type, summary, timestamp };
  if (typeof value.detail === 'string' && value.detail.trim() !== '') {
    event.detail = value.detail.slice(0, 1000);
  }
  return event;
}

/** 回放/实时流统一走同一道白名单，避免历史事件成为绕过口。 */
export function normalizeAgentEvents(value: unknown): DesktopAgentEvent[] {
  if (!Array.isArray(value)) return [];
  const out: DesktopAgentEvent[] = [];
  for (const raw of value) {
    const event = normalizeAgentEvent(raw);
    if (event) out.push(event);
  }
  return out;
}
