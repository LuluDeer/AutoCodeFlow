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

  @ApiProperty({ description: "1..128 个 [a-z0-9-] 字符，全局唯一" })
  slug: string;

  @ApiProperty()
  title: string;

  @ApiProperty({
    nullable: true,
    description: "最近发布的版本标签，null = 从未发布",
  })
  currentVersion: string | null;

  @ApiProperty({ enum: ["draft", "published", "deprecated"] })
  status: "draft" | "published" | "deprecated";

  @ApiProperty({
    nullable: true,
    format: "uuid",
    description: "该 SOP 运行时对应的应用 zip 包",
  })
  applicationId: string | null;

  @ApiProperty({
    nullable: true,
    additionalProperties: true,
    description: "解析后的 front-matter（capabilities/权限档案的权威来源）",
  })
  frontMatterJson: Record<string, unknown> | null;

  @ApiProperty({ nullable: true })
  bodyMarkdown: string | null;

  @ApiProperty({ description: "'user:<id>' 或 'agent:<sessionId>'" })
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

  @ApiProperty({ description: "例如 '1.2.3'" })
  version: string;

  @ApiProperty({ additionalProperties: true })
  frontMatterJson: Record<string, unknown>;

  @ApiProperty()
  bodyMarkdown: string;

  @ApiProperty({ nullable: true })
  changelog: string | null;

  @ApiProperty({
    description: "对 front-matter + body 计算的 sha；交付对账锚点",
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

  @ApiProperty({ description: "本次指派锁定的 SOP 版本" })
  sopVersion: string;

  @ApiProperty({ nullable: true, format: "uuid" })
  targetExecutorId: string | null;

  @ApiProperty({
    nullable: true,
    description: "驱动该指派的对话/Agent 会话",
  })
  targetAgentSessionId: string | null;

  @ApiProperty({ enum: SOP_ASSIGNMENT_STATUSES })
  status: SopAssignmentStatus;

  @ApiProperty({ description: "当前澄清轮次（从 0 开始的计数器）" })
  clarificationRound: number;

  @ApiProperty()
  maxRounds: number;

  @ApiProperty({
    nullable: true,
    additionalProperties: true,
    description: "执行器上报的交付结果",
  })
  resultJson: Record<string, unknown> | null;

  @ApiProperty({
    nullable: true,
    format: "uuid",
    description: "负责处理澄清的 sop_review 对话会话",
  })
  parentSessionId: string | null;

  @ApiProperty({
    nullable: true,
    description: "首次成功轮询领取的时间",
  })
  pulledAt: Date | null;

  @ApiProperty({
    nullable: true,
    description: "最近一次进度心跳（停滞检测输入）",
  })
  lastProgressAt: Date | null;

  @ApiProperty({ additionalProperties: true, nullable: true })
  progressJson: Record<string, unknown> | null;

  @ApiProperty({ description: "最终报告的投递尝试次数（complete 幂等键）" })
  attempt: number;

  @ApiProperty({
    nullable: true,
    description: "最近一次澄清回复推送（至少一次投递游标）",
  })
  lastReplyDeliveredAt: Date | null;

  @ApiProperty({
    nullable: true,
    additionalProperties: true,
    description: "领取时刻的 agentCapabilities 快照",
  })
  capabilitySnapshotJson: Record<string, unknown> | null;

  @ApiProperty({
    nullable: true,
    description: "领取时生效的权限档案",
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
    nullable: true,
    description: "执行器生成的幂等键（重试时去重）",
  })
  clientClarificationId: string | null;

  @ApiProperty({ format: "uuid" })
  assignmentId: string;

  @ApiProperty()
  round: number;

  @ApiProperty({ description: "来自执行器的不可信陈述 —— 入库时已净化" })
  question: string;

  @ApiProperty({ nullable: true, additionalProperties: true })
  questionContextJson: Record<string, unknown> | null;

  @ApiProperty({ nullable: true })
  answer: string | null;

  @ApiProperty({ enum: SOP_CLARIFICATION_RESOLUTIONS, nullable: true })
  resolution: SopClarificationResolution | null;

  @ApiProperty({
    nullable: true,
    description: "仅在 sop_amended 回复时设置",
  })
  newSopVersion: string | null;

  @ApiProperty({
    nullable: true,
    type: "array",
    description: "截图/录屏引用（仅平台路径）",
  })
  mediaRefsJson: SopClarificationMediaRef[] | null;

  @ApiProperty({
    nullable: true,
    format: "uuid",
    description: "作答该澄清的 sop_review 会话",
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

  @ApiProperty({ description: "'executor:<id>' 或 'user:<id>'" })
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

  @ApiProperty({ description: "租约声明的能力域（短租约，不是快照）" })
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

/**
 * POST /sop/:id/assignments/cancel —— 归档前置：取消未结束指派。
 *
 * 必须有具名 DTO 而不是内联 `{ description }`：响应 schema 覆盖率棘轮
 * （`check-openapi-response-schema.mjs`）只认**有 schema 的响应**，内联描述
 * 会让该端点计成"缺口"，进而让基线倒挂（实测 CI 上棘轮 step 因此变红）。
 */
export class SopCancelAssignmentsResponseDto {
  @ApiProperty({
    description: "实际取消的条数（0 = 本来就没有未结束指派）",
    example: 2,
  })
  cancelled: number;
}

/** POST /sop/assignments/:id/clarifications/:cid/reply —— 人工与中台 Agent 同闸答复。 */
export class ClarificationReplyResponseDto {
  @ApiProperty({ description: "成功时恒为 true（失败均为 4xx）" })
  ok: true;

  @ApiPropertyOptional({
    description: "当 resolution=sop_amended 时设置（发布产出了新的不可变版本）",
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
    description: "SOP 全量快照（对账锚点 = contentHash）",
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
    type: CollabAssignmentItemDto,
    description: "仅在 sop_amended 时出现 —— 供继续执行的修订后 SOP 载荷",
  })
  newSop?: CollabAssignmentItemDto;
}

/** POST /agent-collab/poll —— 长轮询（≤25s）返回的混合载荷。 */
export class CollabPollResponseDto {
  @ApiProperty({
    type: "array",
    items: {
      oneOf: [
        { $ref: getSchemaPath(CollabAssignmentItemDto) },
        { $ref: getSchemaPath(CollabClarificationReplyItemDto) },
      ],
    },
    description: "混合条目：指派（首次领取/重发）与澄清回复",
  })
  items: Array<CollabAssignmentItemDto | CollabClarificationReplyItemDto>;

  @ApiProperty({
    type: "object",
    properties: {
      permissionPolicy: { type: "string", example: "standard" },
      allowedProfiles: { type: "array", items: { type: "string" } },
    },
    required: ["permissionPolicy", "allowedProfiles"],
    description: "每次轮询都会下发的企业策略（执行器本地配置无法覆盖）",
  })
  sopPolicy: { permissionPolicy: string; allowedProfiles: string[] };
}

/** POST /agent-collab/clarifications —— 执行器 Agent 回问的受理回执。 */
export class CollabClarifyResponseDto {
  @ApiProperty({
    description: "提供了 clientClarificationId 时用它，否则用行 id",
  })
  clarificationId: string;

  @ApiProperty()
  round: number;

  @ApiProperty({
    description:
      "true = maxRounds 已耗尽，升级为人工通知（不会启动 sop_review 会话）",
  })
  escalated: boolean;
}

/** POST /agent-collab/llm —— 中台代跑推理（key 不出服务端）。 */
export class CollabLlmRelayResponseDto {
  @ApiProperty({
    description: "提供方被禁用/不可用时为空字符串（fail-open，执行器降级）",
  })
  content: string;

  @ApiProperty({
    nullable: true,
    description: "工具往返不向执行器暴露（恒为 null）",
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
    description: "平台路径 /api/sop/media/<id> —— mediaRefs 唯一合法形式",
  })
  mediaPath: string;
}

/** POST /agent-collab/assignments/:id/candidate-package —— 候选包建包回执。 */
export class CollabCandidatePackageResponseDto {
  @ApiProperty({ format: "uuid" })
  packageId: string;

  @ApiProperty({ description: "形如 'sop-<slug>' 的包名" })
  name: string;

  @ApiProperty({ description: "SOP 版本 + Agent 构建元数据（幂等重复投递）" })
  version: string;
}

/** POST /agent-collab/assignments/:id/complete —— 交付落账回执（验收在中台 Agent）。 */
export class CollabCompleteResponseDto {
  @ApiProperty({ description: "false = 重复尝试/幂等重放被忽略" })
  accepted: boolean;
}
