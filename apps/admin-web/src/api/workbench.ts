import { client } from './client';
import type { components } from '../types/generated/api-types';

type GeneratedSessionDetail = components['schemas']['WorkbenchSessionDetailResponseDto'];

/** 业务侧频率（界面只呈现中文标签，这里保留后端契约的英文枚举值）。 */
export type WorkbenchCadence = 'daily' | 'weekly' | 'monthly';

export interface PreviewPlanInput {
  goal: string;
  cadence: WorkbenchCadence;
  params?: Record<string, string>;
}

export interface PreviewCard {
  title: string;
  triggerText: string;
  capabilityHints: string[];
  acceptanceText: string;
  budget: { maxTurns: number };
}

export type PreviewCheckStatus = 'ok' | 'warn' | 'fail';

export interface PreviewCheck {
  field: string;
  status: PreviewCheckStatus;
  message: string;
}

export interface PreviewPlanResult {
  card: PreviewCard;
  checks: PreviewCheck[];
  eligible: boolean;
  cardHash: string;
  /** 方案卡当前的策略代际（16 hex）：commit 必须原样回填，作为策略未被改动的校验锚点。 */
  policyGeneration: string;
}

/**
 * POST /api/workbench/commit 入参（对齐 admin-api CommitPlanCardRequestDto）。
 *
 * 刻意不带 card 内容：服务端只用 goal/cadence/params 重建 card 并重算 hash，
 * 再与 expectedCardHash 比对；同时重算当前策略代际并与 expectedPolicyGeneration 比对，
 * 两者任一失配服务端都会拒绝（表单被改 / 策略在预览后变更）。
 * 前端必须把 preview 返回的 cardHash 与 policyGeneration 原样回填，
 * 且 goal/cadence/params 与预览时逐字一致。
 */
export interface CommitPlanInput {
  goal: string;
  cadence: WorkbenchCadence;
  params?: Record<string, string>;
  expectedCardHash: string;
  expectedPolicyGeneration: string;
}

/** POST /api/workbench/commit 响应（对齐 CommitResultDto）：只落 draft，不自动发布。 */
export interface CommitResult {
  sopId: string;
  slug: string;
  status: 'draft';
  /**
   * ADR-045 发布审批发起状态（稳定码，后端必填）：
   * submitted=已发起且带 approvalKey；failed=发起异常但 draft 已落；
   * not_requested=端口缺席/非 USER 上下文，本就未发起（非异常）。
   * 页面按此三态给出诚实提示，绝不用 approvalKey 缺席去猜「不需要审批」。
   */
  approvalStatus: 'submitted' | 'failed' | 'not_requested';
  /**
   * @deprecated 后端不再返回硬编码中文；界面改由 approvalStatus + i18n 文案驱动。
   * 仅为兼容旧客户端/fixture 保留为可选，新代码不得读取。
   */
  next?: string;
  /** 本次提交放行的策略代际（16 位 hex），供下游会话继承以做在途失效比对。 */
  policyGeneration?: string;
  /**
   * ADR-045：发布审批单 key（业务人员提交后由主管四眼批准、系统代理发布）。
   * 与后端 `CommitResultDto.approvalKey` 同源（`required: false`）——
   * **仅 approvalStatus==='submitted' 时有**；failed/not_requested 一律缺席。
   * 页面必须「有则渲染、无则整块不渲染」，绝不在缺席时编造「已提交审批」。
   */
  approvalKey?: string;
}

/**
 * 方案预览：client 的 baseURL 已含 /api（见 api/client.ts:14-29），
 * 因此这里只写相对路径，实际请求为 POST /api/workbench/preview。
 */
export function previewPlan(input: PreviewPlanInput): Promise<PreviewPlanResult> {
  return client.post<PreviewPlanResult>('/workbench/preview', input);
}

/**
 * 确认方案并落 SOP 草稿：相对路径 → POST /api/workbench/commit。
 * 失败由调用方 catch（拦截器已按错误码弹过 toast 的会去重，页面侧给内联兜底）。
 */
export function commitPlan(input: CommitPlanInput): Promise<CommitResult> {
  return client.post<CommitResult>('/workbench/commit', input);
}

/**
 * UX-AUDIT / Writer B 会话切片：创建「受限 SOP 起草会话」。
 * 契约 = admin-api `CreateWorkbenchSessionDto` / `WorkbenchSessionCreateResponseDto`，
 * 由 openapi.json → api-types.ts 生成链派生（禁止手写顶层类型，web-type-drift 棘轮）。
 */
export function createWorkbenchSession(
  input: components['schemas']['CreateWorkbenchSessionDto'],
): Promise<components['schemas']['WorkbenchSessionCreateResponseDto']> {
  return client.post('/workbench/sessions', input);
}

/** 读取受限会话的实时摘要（状态由后端 worker 推进，前端不锁定为 pending）。 */
export function getWorkbenchSession(id: string): Promise<GeneratedSessionDetail & {
  title?: string | null;
  conclusion?: unknown;
  errorMessage?: string | null;
  waitingFor?: string | null;
  createdAt?: unknown;
  updatedAt?: unknown;
  steps?: Array<{
    seq: number;
    role: string;
    content?: string | null;
    contentPreview?: string | null;
    createdAt?: unknown;
  }>;
  toolCalls?: Array<{
    id?: string;
    toolName: string;
    status: string;
    argsPreview?: string | null;
    outputPreview?: string | null;
    errorSummary?: string | null;
    createdAt?: unknown;
    stateChangedAt?: unknown;
  }>;
  approvalItems?: Array<{
    approvalKey: string;
    toolName: string;
    status: string;
    reason?: string | null;
    argsDigest?: string | null;
    decidedBy?: string | null;
    createdAt?: unknown;
    canDecide?: boolean;
    canWithdraw?: boolean;
    reviewUrl?: string | null;
  }>;
  artifacts: Array<{
    id: string;
    name: string;
    size: number;
    createdAt?: unknown;
    downloadUrl?: string | null;
    previewUrl?: string | null;
  }>;
}> {
  return client.get(`/workbench/sessions/${encodeURIComponent(id)}`);
}

/**
 * GET /api/workbench/sessions：刷新后的「我的会话」兜底。
 * 返回类型刻意内联，避免 web-type-drift 棘轮把新手写顶层类型判成新增欠账。
 */
export function listWorkbenchSessions(params?: { page?: number; pageSize?: number }): Promise<{
  items: Array<{
    sessionId: string;
    status: string;
    title: string | null;
    kind?: string | null;
    createdAt?: unknown;
    sopId?: string | null;
  }>;
  total: number;
}> {
  return client.get('/workbench/sessions', { params });
}

// ── Prompt-first 交互会话（后端新端点；generated schema 尚未落地） ──────────
// 入参/回执刻意用内联结构类型：api 层不反向依赖 pages/workbench 的过渡别名。

export function createWorkbenchChatSession(input: {
  prompt: string;
  title?: string;
  kind?: 'chat' | 'sop_authoring' | 'plan';
  context?: Record<string, unknown>;
}): Promise<{
  sessionId: string;
  status: string;
  kind: string;
  initialStepPersisted: boolean;
}> {
  return client.post('/workbench/chat-sessions', input);
}

export function postWorkbenchMessage(
  sessionId: string,
  input: { content: string; mode?: 'followup' | 'steer' },
): Promise<{ ok: boolean; sessionId?: string; status?: string; resumed?: boolean }> {
  return client.post(`/workbench/sessions/${encodeURIComponent(sessionId)}/messages`, input);
}

export function cancelWorkbenchSession(
  sessionId: string,
): Promise<{ ok: boolean; sessionId?: string; status?: string; resumed?: boolean }> {
  return client.post(`/workbench/sessions/${encodeURIComponent(sessionId)}/cancel`);
}

export function decideWorkbenchApproval(
  sessionId: string,
  approvalKey: string,
  input: { decision: 'grant' | 'deny' | 'withdraw'; note?: string },
): Promise<{ ok: boolean; sessionId?: string; status?: string; resumed?: boolean }> {
  return client.post(
    `/workbench/sessions/${encodeURIComponent(sessionId)}/approvals/${encodeURIComponent(approvalKey)}/decide`,
    input,
  );
}

/** 从后端给的 previewUrl/downloadUrl 解析出 (execId, name)。 */
export function parseWorkbenchArtifactUrl(
  artifact: { previewUrl?: string | null; downloadUrl?: string | null },
): { execId: string; name: string } | null {
  const url = artifact.previewUrl || artifact.downloadUrl;
  if (!url) return null;
  const match = url.match(/\/tasks\/executions\/([^/]+)\/artifacts\/([^/?#]+)/);
  if (!match) return null;
  return { execId: decodeURIComponent(match[1]), name: decodeURIComponent(match[2]) };
}

/** 从后端给的 previewUrl/downloadUrl 解析出 (execId, name)，再走有界预览端点。 */
export function fetchWorkbenchArtifactPreview(
  artifact: { name: string; previewUrl?: string | null; downloadUrl?: string | null },
  signal?: AbortSignal,
): Promise<{
  name: string;
  mimeType: string;
  size: number;
  truncated: boolean;
  kind: 'text' | 'image' | 'binary';
  content: string | null;
}> {
  const parsed = parseWorkbenchArtifactUrl(artifact);
  if (!parsed) return Promise.reject(new Error('invalid artifact preview url'));
  return client.get(
    `/tasks/executions/${encodeURIComponent(parsed.execId)}/artifacts/${encodeURIComponent(parsed.name)}/preview`,
    { params: { maxBytes: 65536 }, signal },
  ) as Promise<{
    name: string;
    mimeType: string;
    size: number;
    truncated: boolean;
    kind: 'text' | 'image' | 'binary';
    content: string | null;
  }>;
}

export const workbenchApi = {
  preview: previewPlan,
  commit: commitPlan,
  createSession: createWorkbenchSession,
  getSession: getWorkbenchSession,
  listSessions: listWorkbenchSessions,
  createChatSession: createWorkbenchChatSession,
  postMessage: postWorkbenchMessage,
  cancelSession: cancelWorkbenchSession,
  decideApproval: decideWorkbenchApproval,
  fetchArtifactPreview: fetchWorkbenchArtifactPreview,
};
