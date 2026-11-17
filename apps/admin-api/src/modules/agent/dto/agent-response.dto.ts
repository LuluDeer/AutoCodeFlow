import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import {
  AGENT_SESSION_KINDS,
  AGENT_SESSION_STATUSES,
  AgentSessionStatus,
} from "../entities/agent-session.entity";
import type { AgentBudget } from "../entities/agent-session.entity";
import { AGENT_STEP_ROLES, AgentStepRole } from "../entities/agent-step.entity";
import {
  AGENT_TOOL_CALL_STATUSES,
  AGENT_TOOL_TIERS,
  AgentToolCallStatus,
  AgentToolTier,
} from "../entities/agent-tool-call.entity";

/**
 * ARCH-23 / N-12：Agent HTTP 面（tag "Agent"，全部 ADMIN-only）的响应体
 * DTO——此前 0/5 有 schema。字段与 service 实际返回逐一对齐；POST 无
 * @HttpCode 的端点实际状态 201（create/resume）。
 */

/** agent_sessions 行（运行/挂起/终态全生命周期字段）。 */
export class AgentSessionDto {
  @ApiProperty({ format: "uuid" })
  id: string;

  @ApiProperty({ enum: AGENT_SESSION_KINDS as unknown as string[] })
  kind: string;

  @ApiProperty({ enum: AGENT_SESSION_STATUSES as unknown as string[] })
  status: AgentSessionStatus;
  @ApiProperty({ nullable: true })
  title: string | null;

  @ApiProperty({
    description: "'user:<id>' / 'cron:<name>' / 'event:<type>'（触发来源）",
  })
  triggerSource: string;

  @ApiProperty({
    nullable: true,
    description:
      "发起人（G4 四眼原则的数据基础）：'user:<username>' / 'system:<cron|event>'；" +
      "存量行 null = 未知",
  })
  createdBy: string | null;

  @ApiProperty({
    nullable: true,
    format: "uuid",
    description: "子会话血缘（sop_review 会话在此串联）",
  })
  parentSessionId: string | null;

  @ApiProperty({
    nullable: true,
    additionalProperties: true,
    description: "会话目标/上下文对象",
  })
  contextJson: Record<string, unknown> | null;

  @ApiProperty({
    nullable: true,
    additionalProperties: true,
    description: "资源范围约束（03 §5.3）；为空 = 无资源访问权限",
  })
  scopeJson: Record<string, unknown> | null;

  @ApiProperty({
    nullable: true,
    type: "object",
    properties: {
      maxSteps: { type: "number" },
      maxTokens: { type: "number" },
      wallClockMs: { type: "number" },
      maxToolCalls: { type: "number" },
    },
    description: "入队时取的预算快照（审计看到的是当时被允许的额度）",
  })
  budgetJson: AgentBudget | null;

  @ApiProperty({
    nullable: true,
    additionalProperties: true,
    description: "成功时的最终结构化结果",
  })
  resultJson: Record<string, unknown> | null;

  @ApiProperty({
    nullable: true,
    description: "由 LLM 撰写的收尾摘要",
  })
  summary: string | null;

  @ApiProperty({ nullable: true })
  errorMessage: string | null;

  @ApiProperty()
  totalSteps: number;

  @ApiProperty()
  totalTokensIn: number;

  @ApiProperty()
  totalTokensOut: number;

  @ApiProperty()
  totalToolCalls: number;

  @ApiProperty({
    nullable: true,
    description: "会话当前等待的事项（审批/澄清/...）",
  })
  waitingFor: string | null;

  @ApiProperty({ nullable: true })
  startedAt: Date | null;

  @ApiProperty({ nullable: true })
  finishedAt: Date | null;

  @ApiProperty()
  createdAt: Date;

  @ApiProperty()
  updatedAt: Date;
}

/** agent_steps 行（推理轨迹逐帧）。 */
export class AgentStepDto {
  @ApiProperty({ format: "uuid" })
  id: string;

  @ApiProperty({ format: "uuid" })
  sessionId: string;

  @ApiProperty({ description: "会话内从 1 开始的序号" })
  seq: number;

  @ApiProperty({ enum: AGENT_STEP_ROLES as unknown as string[] })
  role: AgentStepRole;

  @ApiProperty({ nullable: true })
  content: string | null;

  @ApiProperty({
    nullable: true,
    description: "提供方暴露的推理通道内容",
  })
  reasoning: string | null;

  @ApiProperty({
    nullable: true,
    type: "array",
    items: { type: "object", additionalProperties: true },
    description: "助手工具调用请求原文",
  })
  toolCallsJson: unknown[] | null;

  @ApiProperty({ nullable: true })
  toolCallId: string | null;

  @ApiProperty()
  tokensIn: number;

  @ApiProperty()
  tokensOut: number;

  @ApiProperty()
  latencyMs: number;

  @ApiProperty({ nullable: true })
  provider: string | null;

  @ApiProperty({ nullable: true })
  model: string | null;

  @ApiProperty({
    nullable: true,
    description: "压缩后的步骤摘要（保留分级）",
  })
  summary: string | null;

  @ApiProperty()
  createdAt: Date;
}

/** agent_tool_calls 行（工具面全审计）。 */
export class AgentToolCallDto {
  @ApiProperty({ format: "uuid" })
  id: string;

  @ApiProperty({ format: "uuid" })
  sessionId: string;

  @ApiProperty({ nullable: true, format: "uuid" })
  stepId: string | null;

  @ApiProperty()
  toolName: string;

  @ApiProperty({ enum: AGENT_TOOL_TIERS })
  tier: AgentToolTier;

  @ApiProperty({ nullable: true, additionalProperties: true })
  argsJson: Record<string, unknown> | null;

  @ApiProperty({
    nullable: true,
    additionalProperties: true,
    description: "resultTruncated 为真时被单次调用大小上限截断",
  })
  resultJson: Record<string, unknown> | null;

  @ApiProperty()
  resultTruncated: boolean;

  @ApiProperty({ enum: AGENT_TOOL_CALL_STATUSES })
  status: AgentToolCallStatus;

  @ApiProperty({ nullable: true })
  errorMessage: string | null;

  @ApiProperty({
    nullable: true,
    format: "uuid",
    description: "awaiting_approval / granted 流程的审批记录",
  })
  approvalId: string | null;

  @ApiProperty()
  durationMs: number;

  /**
   * 本行 status 最后一次变更的时刻（迁移 083 / C2）。
   *
   * 存量行（迁移前写入的记录）是 NULL——那是「不知道」，不是「没变过」；
   * 消费方不要拿 createdAt 替它，也不要按非空用：崩溃点判定正是建立在这条
   * 事实的诚实性上。
   *
   * 语义只留在这里（JSDoc），**没有写进 `@ApiProperty` 的 description**：
   * 本仓 API-I18N 纪律是「源码只写中文，英文集中在
   * `scripts/api-i18n/data/openapi-en-map.json`，以中文原文为键」。缺映射时
   * `swagger:export` 的注入步骤会整步失败、CI 的 check:api-i18n 变红。要把这段
   * 语义送上文档面时，请连同英文映射一起补。
   */
  @ApiProperty({ nullable: true })
  stateChangedAt: Date | null;

  @ApiProperty()
  createdAt: Date;
}

/** GET /agent/sessions —— 裸分页 {items,total}（与 /sop 同形态，无页元数据）。 */
export class AgentSessionListResponseDto {
  @ApiProperty({ type: [AgentSessionDto] })
  items: AgentSessionDto[];

  @ApiProperty()
  total: number;
}

/** GET /agent/sessions/:id —— 详情四合一。 */
export class AgentSessionDetailResponseDto {
  @ApiProperty({ type: AgentSessionDto })
  session: AgentSessionDto;

  @ApiProperty({
    type: [AgentStepDto],
    description: "按 seq 排序的推理轨迹",
  })
  steps: AgentStepDto[];

  @ApiProperty({ type: [AgentToolCallDto] })
  toolCalls: AgentToolCallDto[];

  @ApiProperty({
    type: [AgentSessionDto],
    description: "子会话（parentSessionId = 本会话）",
  })
  children: AgentSessionDto[];
}

/** POST /agent/sessions —— 入队回执（会话本体经轮询/详情消费）。 */
export class AgentSessionCreateResponseDto {
  @ApiProperty({ format: "uuid" })
  id: string;

  @ApiProperty({ description: "创建时恒为 'pending'" })
  status: AgentSessionStatus;
}

/**
 * POST /agent/sessions/:id/resume —— 恢复回执。**soft-fail 形态**：终态会话
 * 不抛错，返回 {ok:false, reason}（200）；running 会话才 409（B-8 双跑拒绝）。
 */
export class AgentSessionResumeResponseDto {
  @ApiProperty({ description: "false = 会话已终态，应新建一个会话" })
  ok: boolean;

  @ApiPropertyOptional({ description: "ok=false 时出现" })
  reason?: string;
}

/** GET /agent/budget —— 当前生效预算（config 可覆盖，缺省回退内建值）。 */
export class AgentBudgetResponseDto {
  @ApiProperty()
  maxSteps: number;

  @ApiProperty()
  maxTokens: number;

  @ApiProperty()
  wallClockMs: number;

  @ApiProperty()
  maxToolCalls: number;
}

/**
 * R211：`GET /agent/sessions/queue-stall` 的响应契约。
 *
 * ⚠️ 这三个"不完整"位**各有方向**（判据文档 §3.5），不能合并：
 * · `degraded`        —— 可能**误报**（结构性量读失败）⇒ 前端显示「未知」；
 * · `degradedCounts`  —— 可能**漏报**（计数类读失败）⇒ 不改变结论，只是「数字可能更大」；
 * · `workersKnown`    —— `workers === 0` **是不是事实**（false ⇒ 那只是回落值）。
 *
 * 在此之前该端点**没有任何 response schema**（`openapi.json` 里只有 `{"200":{"description":""}}`）
 * ⇒ 前端只能手写类型、且新增字段在契约面**完全不可见**。这里补上即消除该盲区。
 */
export class AgentQueueStallResponseDto {
  @ApiProperty({ description: "是否停摆（有活排队但结构上没人能消费）" })
  stalled: boolean;

  @ApiProperty({
    nullable: true,
    enum: ["paused", "no-worker"],
    description:
      "成因；不停摆时为 null。两者的处置不同（前者 resume，后者查进程）",
  })
  reason: string | null;

  @ApiProperty({
    description:
      "在排队等消费的 job 数（waiting + delayed + prioritized，不含 active）",
  })
  pendingJobs: number;

  @ApiProperty({
    description:
      "是否有**可能导致误报**的观测失败（active/workers/paused 读失败）——前端据此显示「未知」，既不敢报也不敢说正常",
  })
  degraded: boolean;

  @ApiProperty({
    description:
      "是否有**可能导致漏报**的计数类观测失败（waiting/delayed/prioritized）——**不改变结论**，只在已报停摆时说明「在排队数可能更大」",
  })
  degradedCounts: boolean;

  @ApiProperty({
    description:
      "workers 是否读到了。false 时 snapshot 里的 workers=0 **不是事实**，只是回落值",
  })
  workersKnown: boolean;
}

/**
 * R211：`GET /agent/sessions/queue-idle` 的响应契约（同上：此前无 response schema）。
 */
export class AgentQueueIdleResponseDto {
  @ApiProperty({ description: "是否空转（worker 在册却不再消费新 job）" })
  idleStuck: boolean;

  @ApiProperty({
    description: "最老 waiting job 的年龄（毫秒）；无 job 或读失败时为 0",
  })
  oldestAgeMs: number;

  @ApiProperty({
    description: "判定用的阈值（毫秒）—— 由墙钟预算 × 并发槽位数 + 一拍推导",
  })
  thresholdMs: number;

  @ApiProperty({
    description: "当前 waiting 计数（读失败时为 0 且 degraded 为 true）",
  })
  waitingCount: number;

  @ApiProperty({ description: "最老 job 是否「曾开始过又回到 waiting」" })
  retried: boolean;

  @ApiProperty({
    nullable: true,
    enum: ["queue-stall"],
    description:
      "本条判据让位给别的判据时说明成因；null = 本判据是这一格的最终结论",
  })
  suppressedBy: string | null;

  @ApiProperty({
    description:
      "是否读不到观测量——此时 idleStuck 恒 false（**不完整的判定**）",
  })
  degraded: boolean;

  @ApiProperty({
    description: "阈值推导依据（运营问「这个数哪来的」时的答案）",
    type: "object",
    properties: {
      wallClockMs: { type: "number" },
      concurrency: { type: "number" },
      tickMs: { type: "number" },
      thresholdMs: { type: "number" },
      formula: { type: "string" },
    },
  })
  basis: {
    wallClockMs: number;
    concurrency: number;
    tickMs: number;
    thresholdMs: number;
    formula: string;
  };
}

/**
 * R221：`GET /agent/sessions/backlogged` 的响应契约。
 *
 * 此前该端点**没有 response schema**（`openapi.json` 里只有 `{"200":{"description":""}}`）
 * ⇒ 前端只能手写类型、且新增字段在契约面完全不可见。与 R211 补的 stall/idle 同款盲区。
 */
export class AgentBacklogResponseDto {
  @ApiProperty({
    type: [String],
    description:
      "判定为「积压」的会话 id（pending 但队列里没有任何指向它的 job）",
  })
  sessionIds: string[];

  @ApiProperty({ description: "积压条数（= sessionIds.length）" })
  count: number;

  @ApiProperty({
    description:
      "本次实际对账了多少条 pending 会话（诊断用：为 0 说明没有 pending）",
  })
  probed: number;

  @ApiProperty({
    description:
      "是否因上限截断（pending 会话数 > BACKLOG_PROBE_LIMIT 或预算耗尽）。⚠️ 截断时数字带「下界」语义：实际可能更多",
  })
  truncated: boolean;
}
