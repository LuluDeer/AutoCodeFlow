import type { components } from '../types/generated/api-types';
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
  /** G4 发起人：'user:<username>' / 'system:<cron|event>'；null = 存量未知。 */
  createdBy: string | null;
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
export const AGENT_APPROVAL_STATUSES = [
  'pending',
  'granted',
  'consumed',
  'denied',
  // PK-19：超过 TTL 未处置的单由维护扫描标 expired（与 denied 区分「谁关的」）
  'expired',
] as const;
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
  list: (params?: {
    kind?: string;
    status?: string;
    page?: number;
    pageSize?: number;
    stalled?: number | string;
    stalledMinutes?: number | string;
  }) =>
    client.get('/agent/sessions', { params }) as Promise<{
      items: AgentSession[];
      total: number;
    }>,
  /**
   * R198：**待接管数**（`waiting_input` 会话的全量计数）。
   *
   * ⚠️ 为什么单独一个方法、而不在调用处写 `list({ status:'waiting_input', pageSize:1 })`：
   * ① 语义独立（「待接管数」是一个**运营指标**，不是一次列表查询）；
   * ② **不污染 `list` 的调用计数** —— 既有若干测试断言「`agentApi.list` 被调了几次」，
   *    复用 `list` 会让那些断言被一个**用途完全不同**的请求打乱（R198 实测：
   *    3 个 agent-sessions 用例从绿变红，报 `called 2 times, but got 5 times`）。
   *    ⇒ 一个用途一个方法，调用计数才有意义。
   * ③ 走同一个后端端点（`pageSize: 1` 只取 `total`），**不需要后端改动**。
   */
  /**
   * R199：**卡住数**（`running` 且最近一步 step 已超过阈值的会话计数）。
   *
   * 判据见 `docs/observability/agent-stalled-criterion.md`（先定判据再写代码）。
   * ⚠️ 与 `pendingTakeoverCount` 同款理由：**独立方法**，不混进 `list` 的调用计数。
   */
  /**
   * R203：**调度积压数**（`pending` 却永远不会被执行 —— `queue.add` 失败 / job 已终结）。
   *
   * 判据见 `docs/observability/agent-backlog-criterion.md`；后端端点 R202 落地。
   * ⚠️ 与 `stalledCount` / `pendingTakeoverCount` 同款理由：**独立方法**（R386）——
   * 不混进 `list` 的调用计数，否则会静默打乱既有断言。
   *
   * ⚠️ **必须把 `truncated` 一起返回**（R395）：对账有上限（后端 200 条），
   * 若截断了却只给 `count`，调用方看到「3」会以为「一共就 3 条」——
   * 而实际可能有几百条。⇒ 这是「同一符号两个语义」，必须显式区分。
   */
  /**
   * R205：**队列是否停摆**（有活排队但结构上没人能消费）。
   *
   * 判据见 `docs/observability/agent-queue-stall-criterion.md`；后端端点 R205 落地。
   * ⚠️ `degraded` 必须一起拿：某个观测量读失败时后端会返回 `stalled: false`，
   * 但那个判定**不完整** ⇒ 前端要显示「未知」而不是「正常」（防假事实）。
   */
  queueStall: () =>
    client.get('/agent/sessions/queue-stall') as Promise<{
      stalled: boolean;
      reason: string | null;
      pendingJobs: number;
      /** ⚠️ R211：**可能误报**（结构性量读失败）⇒ 前端显示「未知」，既不敢报也不敢说正常。 */
      degraded: boolean;
      /** ⚠️ R211：**可能漏报**（计数类读失败）⇒ 不改变结论，只在已报停摆时补一句。 */
      degradedCounts: boolean;
      /** ⚠️ R211：`workers === 0` 是否**是事实**（false ⇒ 那只是回落值）。 */
      workersKnown: boolean;
    }>,
  /**
   * R207：**队列是否空转**（worker 在册却不再消费新 job）。
   *
   * 判据见 `docs/observability/agent-queue-idle-criterion.md`；后端端点 R207 落地。
   * ⚠️ 与 `queueStall` **互补**（不是重复）：停摆问「有没有人能消费」，空转问
   * 「有人、却不再消费」。判定顺序上停摆优先 ⇒ `suppressedBy === 'queue-stall'`
   * 时本徽标**必须不显示**（否则同一现象会点亮两个徽标，运营的注意力是稀缺资源）。
   * ⚠️ `degraded` 必须一起拿：读失败时后端返回 `idleStuck: false`，但那是
   * **不完整的判定** ⇒ 前端要显示「未知」而不是「正常」。
   */
  queueIdle: () =>
    client.get('/agent/sessions/queue-idle') as Promise<{
      idleStuck: boolean;
      oldestAgeMs: number;
      thresholdMs: number;
      waitingCount: number;
      retried: boolean;
      suppressedBy: 'queue-stall' | null;
      degraded: boolean;
    }>,
  backloggedCount: () =>
    client.get('/agent/sessions/backlogged') as Promise<{
      sessionIds: string[];
      count: number;
      probed: number;
      truncated: boolean;
    }>,
  stalledCount: (minutes?: number) =>
    client
      .get('/agent/sessions', {
        params: {
          stalled: 1,
          ...(minutes ? { stalledMinutes: minutes } : {}),
          page: 1,
          pageSize: 1,
        },
      })
      .then((r) => (r as { total: number }).total),
  pendingTakeoverCount: () =>
    client
      .get('/agent/sessions', { params: { status: 'waiting_input', page: 1, pageSize: 1 } })
      .then((r) => (r as { total: number }).total),
  detail: (id: string) =>
    client.get(`/agent/sessions/${id}`) as Promise<{
      session: AgentSession;
      steps: AgentStep[];
      toolCalls: AgentToolCall[];
      children: AgentSession[];
    }>,
  /**
   * 新建一个 Agent 会话（POST /agent/sessions）。
   *
   * 观测审计 P2：设计文档一直把「人工触发 = Admin Web 对话」列为已实现，
   * 而客户端此前没有 create——`chat` 类型只能 curl/脚本创建、其指标恒 0。
   * 这里补上最小必要入口（kind + title + 可选 context 对象）。
   */
  create: (body: {
    kind: string;
    title?: string;
    context?: Record<string, unknown>;
    scope?: Record<string, unknown>;
  }) =>
    client.post('/agent/sessions', body) as Promise<{ id: string; status: string }>,
  /** 恢复挂起/失败会话（服务端终态守卫：succeeded/aborted 不可恢复）。 */
  /** G5 排障：导出会话完整转录（会话 + 步骤 + 工具调用 + 审批单）。 */
  exportSession: (id: string) =>
    client.get(`/agent/sessions/${id}/export`) as Promise<Record<string, unknown>>,
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
  /**
   * R278/U1：**全库待审批单**（一次请求，取代「先拉 50 个会话再逐个 listApprovals」）。
   *
   * ⚠️ 与 `stalledCount` / `pendingTakeoverCount` / `backloggedCount` 同款理由：
   * **独立方法**，不混进 `list` / `listApprovals` 的调用计数——既有测试断言那两个
   * 方法被调了几次，复用会让断言被一个用途完全不同的请求打乱。
   *
   * ⚠️ 契约（admin-api `agent-inbox.service`，brief §四）：
   * - `total` / `sessionTotal` 为 `null` = **读不到（未知）**，绝不等于 0；
   * - `truncated` = `returned < total`；**`total` 未知时为 `false`**——「是否截断」
   *   本身不可知，那件事由 `degraded` 表达（两者各自只说自己的事，不互相顶替）；
   * - `degraded` = 任一子查询失败（HTTP 仍 200）；整体不可用时后端给 503。
   */
  listPendingApprovals: (limit?: number) =>
    client.get('/agent/approvals/pending', { params: limit ? { limit } : undefined }) as Promise<AgentPendingApprovalsResponse>,
  /**
   * R278/U1：**收件箱计数一次拿全**（取代 5 个分散请求：deployments / waiting /
   * stalled / backlogged / queue-stall 各发一次）。
   *
   * ⚠️ 失败语义：单字段 `null` = 该计数读不到（未知），**不是 0**；
   * `degraded: true` = 至少一个子查询失败。整体不可用时后端给 503，前端走 catch ⇒
   * 该小节计数为 `null`，仍不伪装成 0。
   */
  inboxCounts: (signal?: AbortSignal) =>
    client.get('/agent/inbox/counts', signal ? { signal } : undefined) as Promise<AgentInboxCountsResponse>,
  /**
   * R279：**窗口内的失败会话行**（收件箱「Agent 会话失败」小节的数据源）。
   *
   * ⚠️ `status=failed` **刻意只取 `failed`**：`budget_exceeded` 的处置路径不同
   * （要改预算/换模型再重跑，不是「看看错在哪」），所以不进本小节的**行**；
   * 但它**计入** `inbox/counts.failedSessions`（运营先要知道「有几条要处理」）。
   * 两侧口径的这个差异是设计决定，不是遗漏 —— 改单边会让「计数 5、列表 3」
   * 变成两个都不解释的数字。把对齐冲动写在这里，比写在提交信息里活得久。
   *
   * ⚠️ 与 `stalledCount` / `pendingTakeoverCount` / `backloggedCount` 同款理由：
   * **独立方法**，不混进 `list` 的调用计数（既有测试断言那个方法被调了几次）。
   *
   * ⚠️ `since` 是后端新增的**可选** query：缺省 = 不筛（旧行为不变）；本模块总是显式传，
   * 因为收件箱只关心「今天要处理的」窗口，窗口外的东西在会话列表里查得到。
   */
  listFailedSessions: (params?: { since?: string; page?: number; pageSize?: number }) =>
    client.get('/agent/sessions', {
      params: { status: 'failed', ...(params ?? {}) },
    }) as Promise<{ items: AgentSession[]; total: number }>,
};

/**
 * R278 收件箱聚合的两个**合同派生**类型。
 *
 * 为什么不再手写：`scripts/check-web-type-drift.mjs` 是「手写 API 类型只减不增」
 * 的棘轮——手写副本与生成物同名同义却互不约束，后端改字段名时 tsc 照样绿、
 * 前端静默读到 `undefined`。这三个 DTO 已由 admin-api 的 `@ApiOkResponse` 导出进
 * `openapi.json` ⇒ 一律 `components['schemas'][…]` 派生（按定义不算手写）。
 *
 * 字段语义以**生成物**为准（与 `agent-inbox.dto.ts` 逐字一致）：
 * - `total` / `sessionTotal` = `number | null`，`null` 是**读不到**，绝不等于 0；
 * - `truncated = returned < total`；**`total === null` 时为 `false`**——
 *   「是否截断」本身不可知，那件事由 `degraded` 表达（brief §四 裁决）；
 * - `degraded` = 任一子查询失败，HTTP 仍 200。
 */
export type AgentPendingApprovalRow = components['schemas']['AgentPendingApprovalItemDto'];
export type AgentPendingApprovalsResponse = components['schemas']['AgentPendingApprovalsResponseDto'];
export type AgentInboxCountsResponse = components['schemas']['AgentInboxCountsResponseDto'];
