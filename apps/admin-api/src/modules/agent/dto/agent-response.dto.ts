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

  @ApiProperty({ description: "'user:<id>' / 'cron:<name>' / 'event:<type>'" })
  triggerSource: string;

  @ApiProperty({
    description: "Sub-session lineage (sop_review sessions chain here)",
    nullable: true,
    format: "uuid",
  })
  parentSessionId: string | null;

  @ApiProperty({
    description: "Session goal/context object",
    nullable: true,
    additionalProperties: true,
  })
  contextJson: Record<string, unknown> | null;

  @ApiProperty({
    description:
      "Resource scope constraint (03 §5.3); empty = no resource access",
    nullable: true,
    additionalProperties: true,
  })
  scopeJson: Record<string, unknown> | null;

  @ApiProperty({
    description:
      "Budget snapshot taken at enqueue (audit sees what was allowed THEN)",
    nullable: true,
    type: "object",
    properties: {
      maxSteps: { type: "number" },
      maxTokens: { type: "number" },
      wallClockMs: { type: "number" },
      maxToolCalls: { type: "number" },
    },
  })
  budgetJson: AgentBudget | null;

  @ApiProperty({
    description: "Final structured result on success",
    nullable: true,
    additionalProperties: true,
  })
  resultJson: Record<string, unknown> | null;

  @ApiProperty({ description: "LLM-written closing summary", nullable: true })
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
    description:
      "What the session is waiting on (approval / clarification / ...)",
    nullable: true,
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

  @ApiProperty({ description: "1-based sequence within the session" })
  seq: number;

  @ApiProperty({ enum: AGENT_STEP_ROLES as unknown as string[] })
  role: AgentStepRole;

  @ApiProperty({ nullable: true })
  content: string | null;

  @ApiProperty({
    description: "Provider reasoning channel when surfaced",
    nullable: true,
  })
  reasoning: string | null;

  @ApiProperty({
    description: "Assistant tool-call requests verbatim",
    nullable: true,
    type: "array",
    items: { type: "object", additionalProperties: true },
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
    description: "Compacted step summary (retention tiering)",
    nullable: true,
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
    description: "Truncated by the per-call size cap when resultTruncated",
    nullable: true,
    additionalProperties: true,
  })
  resultJson: Record<string, unknown> | null;

  @ApiProperty()
  resultTruncated: boolean;

  @ApiProperty({ enum: AGENT_TOOL_CALL_STATUSES })
  status: AgentToolCallStatus;

  @ApiProperty({ nullable: true })
  errorMessage: string | null;

  @ApiProperty({
    description: "Approval record for awaiting_approval / granted flows",
    nullable: true,
    format: "uuid",
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

  @ApiProperty({ type: [AgentStepDto], description: "Reasoning trace by seq" })
  steps: AgentStepDto[];

  @ApiProperty({ type: [AgentToolCallDto] })
  toolCalls: AgentToolCallDto[];

  @ApiProperty({
    type: [AgentSessionDto],
    description: "Sub-sessions (parentSessionId = this)",
  })
  children: AgentSessionDto[];
}

/** POST /agent/sessions —— 入队回执（会话本体经轮询/详情消费）。 */
export class AgentSessionCreateResponseDto {
  @ApiProperty({ format: "uuid" })
  id: string;

  @ApiProperty({ description: "Always 'pending' at creation" })
  status: AgentSessionStatus;
}

/**
 * POST /agent/sessions/:id/resume —— 恢复回执。**soft-fail 形态**：终态会话
 * 不抛错，返回 {ok:false, reason}（200）；running 会话才 409（B-8 双跑拒绝）。
 */
export class AgentSessionResumeResponseDto {
  @ApiProperty({
    description: "false = terminal session, create a new one instead",
  })
  ok: boolean;

  @ApiPropertyOptional({ description: "Present when ok=false" })
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
