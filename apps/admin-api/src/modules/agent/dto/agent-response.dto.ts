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
