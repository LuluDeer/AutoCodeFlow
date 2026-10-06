import {
  ApiProperty,
  ApiPropertyOptional,
  getSchemaPath,
} from "@nestjs/swagger";
import {
  SopClarificationMediaRef,
  SopClarificationResolution,
} from "../entities/sop-clarification.entity";
import {
  SOP_ASSIGNMENT_STATUSES,
  SopAssignmentStatus,
} from "../entities/sop-assignment.entity";
import { SOP_CLARIFICATION_RESOLUTIONS } from "../entities/sop-clarification.entity";

/**
 * ARCH-23 / N-12：SOP 管理面（tag "sop"）与 Agent 协作面（tag "SopCollab"）
 * 的**响应体 DTO**——两域此前 0/22 有 schema（N-12 缺口榜 #3/#4）。
 *
 * 约定与 task/auth 批次一致：字段与 service 实际返回逐一对齐（含可空性）、
 * 不建模全局 {code,message,data} envelope、实体类不直接当响应 DTO。
 * 两个如实口径：
 * - GET /sop 与 GET /agent/sessions 的分页是 **{items,total} 裸形态**——没有
 *   page/pageSize/totalPages 元数据（与 tasks 的 paginate() 双键信封不同源）。
 *   前端/SDK 若按 tasks 信封消费会拿不到 total 之外的字段（listAll 陷阱的
 *   契约侧根源），在此如实钉住。
 * - POST 无 @HttpCode 的端点实际状态 201（reply/draft/publish/assign/
   sessions create/resume）；SopCollab 全部端点显式 @HttpCode（200/201）。
 */

/** sop_entities.sops 行的响应形态（列表/详情/起草/编辑）。 */
export class SopResponseDto {
  @ApiProperty({ format: "uuid" })
  id: string;

  @ApiProperty({ description: "1..128 [a-z0-9-], globally unique" })
  slug: string;

  @ApiProperty()
  title: string;

  @ApiProperty({
    description: "Latest published version label, null = never published",
    nullable: true,
  })
  currentVersion: string | null;

  @ApiProperty({ enum: ["draft", "published", "deprecated"] })
  status: "draft" | "published" | "deprecated";

  @ApiProperty({
    description: "App zip the SOP runs against",
    nullable: true,
    format: "uuid",
  })
  applicationId: string | null;

  @ApiProperty({
    description:
      "Parsed front-matter (capabilities/permission profile source of truth)",
    nullable: true,
    additionalProperties: true,
  })
  frontMatterJson: Record<string, unknown> | null;

  @ApiProperty({ nullable: true })
  bodyMarkdown: string | null;

  @ApiProperty({ description: "'user:<id>' or 'agent:<sessionId>'" })
  createdBy: string;

  @ApiProperty()
  createdAt: Date;

  @ApiProperty()
  updatedAt: Date;
}

/** sop_versions 行（不可变发布快照）。 */
export class SopVersionDto {
  @ApiProperty({ format: "uuid" })
  id: string;

  @ApiProperty({ format: "uuid" })
  sopId: string;

  @ApiProperty({ description: "e.g. '1.2.3'" })
  version: string;

  @ApiProperty({ additionalProperties: true })
  frontMatterJson: Record<string, unknown>;

  @ApiProperty()
  bodyMarkdown: string;

  @ApiProperty({ nullable: true })
  changelog: string | null;

  @ApiProperty({
    description:
      "sha over front-matter + body; the delivery reconciliation anchor",
  })
  contentHash: string;

  @ApiProperty()
  publishedBy: string;

  @ApiProperty()
  publishedAt: Date;

  @ApiProperty()
  createdAt: Date;
}

/** sop_assignments 行（SOP 指派工单）。 */
export class SopAssignmentDto {
  @ApiProperty({ format: "uuid" })
  id: string;

  @ApiProperty({ format: "uuid" })
  sopId: string;

  @ApiProperty({ description: "Pinned SOP version for this assignment" })
  sopVersion: string;

  @ApiProperty({ nullable: true, format: "uuid" })
  targetExecutorId: string | null;

  @ApiProperty({
    description: "Chat/agent session driving the assignment",
    nullable: true,
  })
  targetAgentSessionId: string | null;

  @ApiProperty({ enum: SOP_ASSIGNMENT_STATUSES })
  status: SopAssignmentStatus;

  @ApiProperty({ description: "Current clarification round (0-based counter)" })
  clarificationRound: number;

  @ApiProperty()
  maxRounds: number;

  @ApiProperty({
    description: "Executor-reported delivery result",
    nullable: true,
    additionalProperties: true,
  })
  resultJson: Record<string, unknown> | null;

  @ApiProperty({
    description: "sop_review chat session handling clarifications",
    nullable: true,
    format: "uuid",
  })
  parentSessionId: string | null;

  @ApiProperty({ description: "First successful poll claim", nullable: true })
  pulledAt: Date | null;

  @ApiProperty({
    description: "Last progress heartbeat (stall detection input)",
    nullable: true,
  })
  lastProgressAt: Date | null;

  @ApiProperty({ additionalProperties: true, nullable: true })
  progressJson: Record<string, unknown> | null;

  @ApiProperty({
    description:
      "Delivery attempts of the final report (complete idempotency key)",
  })
  attempt: number;

  @ApiProperty({
    description: "Last clarification-reply push (at-least-once cursor)",
    nullable: true,
  })
  lastReplyDeliveredAt: Date | null;

  @ApiProperty({
    description: "agentCapabilities snapshot at pull time",
    nullable: true,
    additionalProperties: true,
  })
  capabilitySnapshotJson: Record<string, unknown> | null;

  @ApiProperty({
    description: "Permission profile in force at pull",
    nullable: true,
  })
  permissionProfileAtPull: string | null;

  @ApiProperty()
  assignedBy: string;

  @ApiProperty()
  createdAt: Date;

  @ApiProperty()
  updatedAt: Date;
}

/** sop_clarifications 行。 */
export class SopClarificationDto {
  @ApiProperty({
    description: "Executor-generated idempotency key (dedupe on retry)",
    nullable: true,
  })
  clientClarificationId: string | null;

  @ApiProperty({ format: "uuid" })
  assignmentId: string;

  @ApiProperty()
  round: number;

  @ApiProperty({
    description: "Untrusted executor statement — sanitized at ingest",
  })
  question: string;

  @ApiProperty({ nullable: true, additionalProperties: true })
  questionContextJson: Record<string, unknown> | null;

  @ApiProperty({ nullable: true })
  answer: string | null;

  @ApiProperty({ enum: SOP_CLARIFICATION_RESOLUTIONS, nullable: true })
  resolution: SopClarificationResolution | null;

  @ApiProperty({ description: "Set on sop_amended replies", nullable: true })
  newSopVersion: string | null;

  @ApiProperty({
    description: "Screenshot/recording references (platform paths only)",
    nullable: true,
    type: "array",
  })
  mediaRefsJson: SopClarificationMediaRef[] | null;

  @ApiProperty({
    description: "sop_review session that answered it",
    nullable: true,
    format: "uuid",
  })
  reviewSessionId: string | null;

  @ApiProperty()
  createdAt: Date;

  @ApiProperty()
  updatedAt: Date;
}

/** agent_media 行（截图/录屏回传的清单读面）。 */
export class AgentMediaDto {
  @ApiProperty({ format: "uuid" })
  id: string;

  @ApiProperty({ format: "uuid" })
  assignmentId: string;

  @ApiProperty()
  name: string;

  @ApiProperty({ nullable: true })
  mime: string | null;

  @ApiProperty()
  sizeBytes: number;

  @ApiProperty({ description: "'executor:<id>' or 'user:<id>'" })
  uploadedBy: string;

  @ApiProperty()
  createdAt: Date;
}

/** GET /sop/assignable-executors 的行（P7c 租约投影，剥离能力快照防误导）。 */
export class SopCapableExecutorDto {
  @ApiProperty({ format: "uuid" })
  id: string;

  @ApiProperty()
  appName: string;

  @ApiProperty()
  address: string;

  @ApiProperty()
  status: string;

  @ApiProperty({ nullable: true })
  lastHeartbeat: Date | null;

  @ApiProperty({
    description:
      "Lease-declared capability domains (short-lived lease, not a snapshot)",
  })
  agentCapabilities: string[];
}

/** GET /sop —— 裸分页 {items,total}（无页元数据，如实钉住）。 */
export class SopListResponseDto {
  @ApiProperty({ type: [SopResponseDto] })
  items: SopResponseDto[];

  @ApiProperty()
  total: number;
}

/** GET /sop/assignments/:id —— 指派详情（含澄清对话全量，按轮次升序）。 */
export class SopAssignmentDetailResponseDto {
  @ApiProperty({ type: SopAssignmentDto })
  assignment: SopAssignmentDto;

  @ApiProperty({ type: [SopClarificationDto] })
  clarifications: SopClarificationDto[];
}

/** POST /sop/assignments/:id/clarifications/:cid/reply —— 人工与中台 Agent 同闸答复。 */
export class ClarificationReplyResponseDto {
  @ApiProperty({ description: "Always true on success (failures are 4xx)" })
  ok: true;

  @ApiPropertyOptional({
    description:
      "Set when resolution=sop_amended (publish produced a new immutable version)",
  })
  newSopVersion?: string;
}

/** POST /sop/:id/publish —— 发布 = 工作副本定稿为不可变版本快照。 */
export class SopPublishResponseDto {
  @ApiProperty({ type: SopResponseDto })
  sop: SopResponseDto;

  @ApiProperty({ type: SopVersionDto })
  version: SopVersionDto;
}

// ── SopCollab（tag "SopCollab"）：执行器 Agent ↔ 中台 通信面（@Public 机器鉴权）──

/** poll.items[0] 之 kind=assignment：首次领取/重发时下发的 SOP 全量载荷。 */
export class CollabAssignmentItemDto {
  @ApiProperty({ enum: ["assignment"] })
  kind: "assignment";

  @ApiProperty({ format: "uuid" })
  assignmentId: string;

  @ApiProperty({
    description: "Full SOP snapshot (reconciliation anchor = contentHash)",
    type: "object",
    properties: {
      slug: { type: "string" },
      title: { type: "string" },
      version: { type: "string" },
      contentHash: { type: "string" },
      frontMatter: { type: "object", additionalProperties: true },
      bodyMarkdown: { type: "string" },
    },
    required: [
      "slug",
      "title",
      "version",
      "contentHash",
      "frontMatter",
      "bodyMarkdown",
    ],
  })
  sop: {
    slug: string;
    title: string;
    version: string;
    contentHash: string;
    frontMatter: Record<string, unknown>;
    bodyMarkdown: string;
  };

  @ApiProperty()
  maxRounds: number;

  @ApiProperty()
  clarificationRound: number;
}

/** poll.items[0] 之 kind=clarification_reply：已落定的澄清回复（至少一次投递）。 */
export class CollabClarificationReplyItemDto {
  @ApiProperty({ enum: ["clarification_reply"] })
  kind: "clarification_reply";

  @ApiProperty({ format: "uuid" })
  assignmentId: string;

  @ApiProperty({ format: "uuid" })
  clarificationId: string;

  @ApiProperty({ nullable: true })
  clientClarificationId: string | null;

  @ApiProperty()
  round: number;

  @ApiProperty({ enum: SOP_CLARIFICATION_RESOLUTIONS })
  resolution: SopClarificationResolution;

  @ApiProperty({ nullable: true })
  answer: string | null;

  @ApiProperty({ nullable: true })
  newSopVersion: string | null;

  @ApiPropertyOptional({
    description:
      "Only on sop_amended — the amended SOP payload for continued execution",
    type: CollabAssignmentItemDto,
  })
  newSop?: CollabAssignmentItemDto;
}

/** POST /agent-collab/poll —— 长轮询（≤25s）返回的混合载荷。 */
export class CollabPollResponseDto {
  @ApiProperty({
    description:
      "Mixed items: assignments (first pull / resend) and clarification replies",
    type: "array",
    items: {
      oneOf: [
        { $ref: getSchemaPath(CollabAssignmentItemDto) },
        { $ref: getSchemaPath(CollabClarificationReplyItemDto) },
      ],
    },
  })
  items: Array<CollabAssignmentItemDto | CollabClarificationReplyItemDto>;

  @ApiProperty({
    description:
      "Enterprise policy pushed EVERY poll (executor local config cannot override)",
    type: "object",
    properties: {
      permissionPolicy: { type: "string", example: "standard" },
      allowedProfiles: { type: "array", items: { type: "string" } },
    },
    required: ["permissionPolicy", "allowedProfiles"],
  })
  sopPolicy: { permissionPolicy: string; allowedProfiles: string[] };
}

/** POST /agent-collab/clarifications —— 执行器 Agent 回问的受理回执。 */
export class CollabClarifyResponseDto {
  @ApiProperty({
    description: "clientClarificationId when provided, else the row id",
  })
  clarificationId: string;

  @ApiProperty()
  round: number;

  @ApiProperty({
    description:
      "true = maxRounds exhausted, escalated to human notifications (no sop_review session will start)",
  })
  escalated: boolean;
}

/** POST /agent-collab/llm —— 中台代跑推理（key 不出服务端）。 */
export class CollabLlmRelayResponseDto {
  @ApiProperty({
    description:
      "Empty string when the provider is disabled/unavailable (fail-open, executor degrades)",
  })
  content: string;

  @ApiProperty({
    description: "Tool round-trips are NOT exposed to executors (null)",
    nullable: true,
  })
  toolCalls: unknown[] | null;

  @ApiProperty({
    type: "object",
    properties: { tokensIn: { type: "number" }, tokensOut: { type: "number" } },
    required: ["tokensIn", "tokensOut"],
  })
  usage: { tokensIn: number; tokensOut: number };

  @ApiProperty()
  model: string;
}

/** POST /agent-collab/assignments/:id/media —— 回传媒体的引用形态（mediaRefs 唯一合法引用）。 */
export class CollabMediaUploadResponseDto {
  @ApiProperty({ format: "uuid" })
  id: string;

  @ApiProperty()
  name: string;

  @ApiProperty({ nullable: true })
  mime: string | null;

  @ApiProperty()
  sizeBytes: number;

  @ApiProperty({
    description:
      "Platform path /api/agent-collab/media/<id> — the ONLY valid mediaRefs form",
  })
  mediaPath: string;
}

/** POST /agent-collab/assignments/:id/candidate-package —— 候选包建包回执。 */
export class CollabCandidatePackageResponseDto {
  @ApiProperty({ format: "uuid" })
  packageId: string;

  @ApiProperty({ description: "'sop-<slug>'" })
  name: string;

  @ApiProperty({
    description: "SOP version + agent build metadata (idempotent re-delivery)",
  })
  version: string;
}

/** POST /agent-collab/assignments/:id/complete —— 交付落账回执（验收在中台 Agent）。 */
export class CollabCompleteResponseDto {
  @ApiProperty({
    description: "false = duplicate attempt / idempotent replay ignored",
  })
  accepted: boolean;
}
