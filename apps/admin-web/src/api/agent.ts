import { client } from './client';

/**
 * P2 遗留补齐：Agent 会话查看面（对齐 admin-api agent.controller.ts，全
 * ADMIN-only）。会话/步骤/工具调用是中台 Agent 的全部行为留痕——没有这个
 * 视图，运维只能查库才能回答「中台 Agent 刚才做了什么、烧了多少令牌」。
 * resume 是唯一的写动作，走与服务端相同的终态守卫。
 *
 * A1 审批闭环（审计轮 #11 → 实施轮 #12 前端半边）：审批单的列出与处置
 * （grant/deny）。服务端条件写钉住 pending——并发处置撞上时后到者收 409
 * （AGENT_APPROVAL_ALREADY_DECIDED，错误词条已生成进 locales/generated）。
 */

export const AGENT_SESSION_STATUSES = [
  'pending',
  'running',
  'waiting_input',
  'succeeded',
  'failed',
  'aborted',
  'budget_exceeded',
] as const;
export type AgentSessionStatus = (typeof AGENT_SESSION_STATUSES)[number];

export interface AgentBudget {
  maxSteps: number;
  maxTokens: number;
  wallClockMs: number;
  maxToolCalls: number;
}

export interface AgentSession {
  id: string;
  kind: string;
  status: AgentSessionStatus | string;
  title: string | null;
  triggerSource: string;
  parentSessionId: string | null;
  contextJson: Record<string, unknown> | null;
  scopeJson: Record<string, unknown> | null;
  budgetJson: AgentBudget | null;
  resultJson: Record<string, unknown> | null;
  summary: string | null;
  errorMessage: string | null;
  totalSteps: number;
  totalTokensIn: number;
  totalTokensOut: number;
  totalToolCalls: number;
  waitingFor: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AgentStep {
  id: string;
  sessionId: string;
  seq: number;
  role: string;
  content: string | null;
  reasoning: string | null;
  toolCallsJson: unknown[] | null;
  toolCallId: string | null;
  tokensIn: number;
  tokensOut: number;
  latencyMs: number;
  provider: string | null;
  model: string | null;
  summary: string | null;
  createdAt: string;
}

export interface AgentToolCall {
  id: string;
  sessionId: string;
  stepId: string | null;
  toolName: string;
  tier: string;
  argsJson: Record<string, unknown> | null;
  resultJson: Record<string, unknown> | null;
  resultTruncated: boolean;
  status: string;
  errorMessage: string | null;
  approvalId: string | null;
  durationMs: number;
  createdAt: string;
}

/** 审批单状态（admin-api agent-approval.entity.ts 的 AGENT_APPROVAL_STATUSES）。 */
export const AGENT_APPROVAL_STATUSES = ['pending', 'granted', 'consumed', 'denied'] as const;
export type AgentApprovalStatus = (typeof AGENT_APPROVAL_STATUSES)[number];

/** 审批单（agent_approvals 行；字段对齐 admin-api AgentApproval 实体）。 */
export interface AgentApproval {
  id: string;
  /** 申请幂等键（= agent_tool_calls.approvalId，`apr-<sessionId>-<ts>`）。 */
  approvalKey: string;
  sessionId: string;
  toolName: string;
  /** 边界闸门给出的审批理由（原样透传给审批人）。 */
  reason: string;
  status: AgentApprovalStatus | string;
  /** 处置人。null = 尚未处置。 */
  decidedBy: string | null;
  decidedAt: string | null;
  /** 领取（副作用真的开始执行）时刻。null = 未执行，或该列上线前的历史行。 */
  consumedAt: string | null;
  createdAt: string;
}

/** 审批单处置响应（agent.controller decideApproval）。 */
export interface AgentApprovalDecision {
  ok: boolean;
  approval: {
    approvalKey: string;
    status: AgentApprovalStatus | string;
    decidedBy: string | null;
    decidedAt: string | null;
    consumedAt: string | null;
  };
  /** grant 且会话挂起在 waiting_input 时，服务端已自动重新入队。 */
  resumed: boolean;
}

export const agentApi = {
  list: (params?: { kind?: string; status?: string; page?: number; pageSize?: number }) =>
    client.get('/agent/sessions', { params }) as Promise<{
      items: AgentSession[];
      total: number;
    }>,
  detail: (id: string) =>
    client.get(`/agent/sessions/${id}`) as Promise<{
      session: AgentSession;
      steps: AgentStep[];
      toolCalls: AgentToolCall[];
      children: AgentSession[];
    }>,
  /** 恢复挂起/失败会话（服务端终态守卫：succeeded/aborted 不可恢复）。 */
  resume: (id: string) =>
    client.post(`/agent/sessions/${id}/resume`) as Promise<{ ok: boolean; reason?: string }>,
  /** 会话的全部审批单（按 createdAt 升序）。 */
  listApprovals: (id: string) =>
    client.get(`/agent/sessions/${id}/approvals`) as Promise<AgentApproval[]>,
  /** 批准审批单（会话挂起在 waiting_input 时服务端自动恢复）。 */
  grantApproval: (id: string, approvalKey: string) =>
    client.post(`/agent/sessions/${id}/approvals/${approvalKey}/grant`) as Promise<AgentApprovalDecision>,
  /** 拒绝审批单。 */
  denyApproval: (id: string, approvalKey: string) =>
    client.post(`/agent/sessions/${id}/approvals/${approvalKey}/deny`) as Promise<AgentApprovalDecision>,
  budget: () => client.get('/agent/budget') as Promise<AgentBudget>,
};
