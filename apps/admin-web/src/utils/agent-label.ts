/**
 * Agent 会话枚举 → i18n 展示标签的**读面唯一事实源**。
 *
 * UX-06 同批治理：AgentSessionsPage 此前直接渲染后端裸枚举——
 *  - 会话状态列：`<Tag>{status}</Tag>`（pending/running/waiting_input… 全裸），
 *    状态筛选下拉同样裸；
 *  - 会话类型列：列题 'kind'、单元格/抽屉 Tag 直接输出 ops_watch/incident…；
 *  - 工具调用：`<Tag>{c.status}</Tag>` 裸、tier 裸；步骤 role 裸；
 *  - 列题是 'role'/'tok'/'ms'/'tier'/'args' 这类原始串。
 *
 * 取值来源（与前端 api/agent.ts 的 AGENT_SESSION_STATUSES 同源）：
 *  - admin-api agent-session.entity.ts：AGENT_SESSION_STATUSES / AGENT_SESSION_KINDS
 *  - agent-tool-call.entity.ts：AGENT_TOOL_CALL_STATUSES / AGENT_TOOL_TIERS
 *  - agent-step.entity.ts：AGENT_STEP_ROLES
 *
 * 未知值回退**原始 token**（不显示"未知"）：保留可诊断信息——与
 * trigger-label.ts / failure-reason-label.ts 同策。后端新增取值而本表未跟时，
 * 页面露出的是可搜索的后端值，而不是渲染成 i18n 键名。
 */

/** AgentSession.status 的已知取值（会话状态机，见 agent-session.entity.ts）。 */
export const AGENT_STATUS_T_KEYS: Record<string, string> = {
  pending: 'agents.status.pending',
  running: 'agents.status.running',
  waiting_input: 'agents.status.waitingInput',
  succeeded: 'agents.status.succeeded',
  failed: 'agents.status.failed',
  aborted: 'agents.status.aborted',
  budget_exceeded: 'agents.status.budgetExceeded',
};

/** AgentSession.kind 的已知取值（会话类型 = 可用工具集白名单）。 */
export const AGENT_KIND_T_KEYS: Record<string, string> = {
  ops_watch: 'agents.kind.opsWatch',
  incident: 'agents.kind.incident',
  sop_authoring: 'agents.kind.sopAuthoring',
  sop_review: 'agents.kind.sopReview',
  app_scaffold: 'agents.kind.appScaffold',
  chat: 'agents.kind.chat',
};

/** AgentToolCall.status 的已知取值（边界闸门/熔断/审批留痕）。 */
export const AGENT_TOOL_STATUS_T_KEYS: Record<string, string> = {
  ok: 'agents.toolStatus.ok',
  denied: 'agents.toolStatus.denied',
  awaiting_approval: 'agents.toolStatus.awaitingApproval',
  timeout: 'agents.toolStatus.timeout',
  error: 'agents.toolStatus.error',
  circuit_open: 'agents.toolStatus.circuitOpen',
};

/** AgentStep.role 的已知取值（LLM 消息协议角色）。 */
export const AGENT_STEP_ROLE_T_KEYS: Record<string, string> = {
  system: 'agents.role.system',
  user: 'agents.role.user',
  assistant: 'agents.role.assistant',
  tool: 'agents.role.tool',
};

/** AgentToolCall.tier 的已知取值（工具风险层级：只读/写入/危险）。 */
export const AGENT_TOOL_TIER_T_KEYS: Record<string, string> = {
  read: 'agents.tier.read',
  write: 'agents.tier.write',
  dangerous: 'agents.tier.dangerous',
};

function labelOf(
  map: Record<string, string>,
  value: string | null | undefined,
  t: (key: string) => string,
): string {
  if (value === null || value === undefined || value === '') return '';
  const key = map[value];
  return key ? t(key) : value;
}

export function agentStatusLabel(
  status: string | null | undefined,
  t: (key: string) => string,
): string {
  return labelOf(AGENT_STATUS_T_KEYS, status, t);
}

export function agentKindLabel(
  kind: string | null | undefined,
  t: (key: string) => string,
): string {
  return labelOf(AGENT_KIND_T_KEYS, kind, t);
}

export function agentToolStatusLabel(
  status: string | null | undefined,
  t: (key: string) => string,
): string {
  return labelOf(AGENT_TOOL_STATUS_T_KEYS, status, t);
}

export function agentStepRoleLabel(
  role: string | null | undefined,
  t: (key: string) => string,
): string {
  return labelOf(AGENT_STEP_ROLE_T_KEYS, role, t);
}

export function agentToolTierLabel(
  tier: string | null | undefined,
  t: (key: string) => string,
): string {
  return labelOf(AGENT_TOOL_TIER_T_KEYS, tier, t);
}
