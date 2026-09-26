import { client } from './client';

/**
 * P2 遗留补齐：Agent 会话查看面（对齐 admin-api agent.controller.ts，全
 * ADMIN-only）。会话/步骤/工具调用是中台 Agent 的全部行为留痕——没有这个
 * 视图，运维只能查库才能回答「中台 Agent 刚才做了什么、烧了多少令牌」。
 * resume 是唯一的写动作，走与服务端相同的终态守卫。
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
  budget: () => client.get('/agent/budget') as Promise<AgentBudget>,
};
