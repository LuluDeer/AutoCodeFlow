/**
 * 工作台「运行我的草稿」——把业务用户自己提交的 SOP draft 实例化为一个
 * 严格限权的 Agent 会话，并入 agent-jobs 队列执行。
 *
 * 契约要点：
 * - 入参**没有 kind / scope / triggerSource** 字段：会话类型与作用域由服务端
 *   钉死为 `sop_authoring` + `{sops:[sopId]}`，业务用户无法凭请求体越权创建
 *   `ops_watch` / `incident` / `app_scaffold` 等管理面会话。
 * - `expectedCardHash` 与 commit 端同口径（16 位十六进制短 hash），用来把
 *   会话与当时提交的那张方案卡锚在一起（写入 context.cardHash）。
 */
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Type } from "class-transformer";
import {
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
} from "class-validator";

export class CreateWorkbenchSessionDto {
  @ApiProperty({
    description: "用户自己提交的 SOP draft 行 id（UUID）",
    format: "uuid",
  })
  @IsUUID("4")
  sopId: string;

  @ApiProperty({
    minLength: 1,
    maxLength: 500,
    example: "按草稿汇总昨日订单异常并推送日报",
  })
  @IsString()
  @Matches(/\S/, { message: "goal 不能为空" })
  @MaxLength(500)
  goal: string;

  @ApiProperty({
    description: "commit 回带的 cardHash（16 位十六进制）——方案卡锚点",
    pattern: "^[0-9a-fA-F]{16}$",
  })
  @IsString()
  @Matches(/^[0-9a-fA-F]{16}$/, {
    message: "expectedCardHash 必须是 16 位十六进制字符串",
  })
  expectedCardHash: string;

  @ApiPropertyOptional({
    description: "随会话携带的业务上下文（服务端脱敏后落库）",
    additionalProperties: true,
  })
  @IsOptional()
  @IsObject()
  context?: Record<string, unknown>;
}

/** 创建回执：最小但诚实——客户端据此轮询 sessionId。 */
export class WorkbenchSessionCreateResponseDto {
  @ApiProperty({
    description: "会话 id（用于 GET /workbench/sessions/:id 轮询）",
  })
  sessionId: string;

  @ApiProperty({ description: "会话初始状态（pending）" })
  status: string;

  @ApiPropertyOptional({ description: "会话可用工具数（若可判定）" })
  toolCount?: number;
}

/** GET /workbench/sessions 的查询面：只有 page/pageSize，禁止透传归属/角色字段。 */
export class ListWorkbenchSessionsQueryDto {
  @ApiPropertyOptional({ type: Number, minimum: 1, maximum: 10000 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(10000)
  page?: number;

  @ApiPropertyOptional({ type: Number, minimum: 1, maximum: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  pageSize?: number;
}

/** 「我的会话」列表行：只投影恢复所需的最小字段，不携带 scope/context。 */
export class WorkbenchSessionListItemDto {
  @ApiProperty({ format: "uuid" })
  sessionId: string;

  @ApiProperty()
  status: string;

  @ApiProperty({ nullable: true })
  title: string | null;

  @ApiProperty({ nullable: true })
  createdAt: Date | string | null;

  @ApiProperty({ nullable: true })
  sopId: string | null;
}

/** GET /workbench/sessions 响应信封。 */
export class WorkbenchSessionListResponseDto {
  @ApiProperty({ type: [WorkbenchSessionListItemDto] })
  items: WorkbenchSessionListItemDto[];

  @ApiProperty()
  total: number;
}

/** 会话步骤摘要（读回 DTO 的嵌套项，显式类以保证 openapi 出精确类型）。 */
export class WorkbenchSessionStepDto {
  @ApiProperty({ description: "步骤序号" })
  seq: number;

  @ApiProperty({ description: "步骤角色" })
  role: string;

  @ApiPropertyOptional({
    description: "步骤正文预览（最长 200 字）",
    nullable: true,
  })
  contentPreview: string | null;

  /** 完整正文（<=8000 字符）。contentPreview 保留兼容。 */
  @ApiPropertyOptional({
    description: "完整步骤正文（最长 8000 字符）",
    nullable: true,
  })
  content?: string | null;

  @ApiPropertyOptional({ description: "步骤创建时间", nullable: true })
  createdAt: Date | string | null;
}

/** 会话产物摘要（读回 DTO 的嵌套项）。 */
export class WorkbenchSessionArtifactDto {
  @ApiProperty({ description: "产物 id" })
  id: string;

  @ApiProperty({ description: "产物名称" })
  name: string;

  @ApiProperty({ description: "产物字节数" })
  size: number;

  @ApiPropertyOptional({ description: "产物创建时间", nullable: true })
  createdAt: Date | string | null;

  @ApiPropertyOptional({ nullable: true })
  downloadUrl: string | null;

  /** 预览直链（供 UI 直接打开，不需拼路径）。 */
  @ApiPropertyOptional({ description: "产物预览直链", nullable: true })
  previewUrl?: string | null;
}

/** 工具调用摘要：给审计面事实，不回传完整 args/result（只给预览）。 */
export class WorkbenchSessionToolCallDto {
  @ApiProperty()
  toolName: string;

  @ApiProperty()
  status: string;

  @ApiPropertyOptional({ nullable: true })
  errorSummary: string | null;

  @ApiPropertyOptional({ nullable: true })
  createdAt: Date | string | null;

  @ApiPropertyOptional({ description: "调用参数预览", nullable: true })
  argsPreview?: string | null;

  @ApiPropertyOptional({ description: "调用结果预览", nullable: true })
  outputPreview?: string | null;

  @ApiPropertyOptional({ description: "状态变更时刻", nullable: true })
  stateChangedAt?: Date | string | null;
}

/** 审批单摘要：沿用现有审批键/状态，不引入任何处置写能力。 */
export class WorkbenchSessionApprovalDto {
  @ApiProperty()
  approvalKey: string;

  @ApiProperty()
  toolName: string;

  @ApiProperty()
  status: string;

  @ApiPropertyOptional({ nullable: true })
  reason: string | null;

  @ApiPropertyOptional({ nullable: true })
  decidedBy: string | null;

  @ApiPropertyOptional({ nullable: true })
  createdAt: Date | string | null;

  @ApiPropertyOptional({ description: "审批参数摘要（哈希）", nullable: true })
  argsDigest?: string | null;

  @ApiPropertyOptional({ description: "当前管理员是否可批准/拒绝" })
  canDecide?: boolean;

  @ApiPropertyOptional({ description: "当前用户是否可撤回" })
  canWithdraw?: boolean;

  /** ADMIN 指向既有审批 UI；USER 恒 null（不绕开四眼）。 */
  @ApiPropertyOptional({ nullable: true })
  reviewUrl: string | null;
}

/** 读回 DTO：会话状态 + 步骤/审批摘要（不返回完整正文，避免大字段误传）。 */
export class WorkbenchSessionDetailResponseDto {
  @ApiProperty({ description: "会话 id" })
  sessionId: string;

  @ApiProperty({ description: "会话 kind（本端点恒为 sop_authoring）" })
  kind: string;

  @ApiProperty({ description: "会话状态" })
  status: string;

  @ApiPropertyOptional({ description: "发起人（user:<id>）", nullable: true })
  createdBy: string | null;

  @ApiProperty({
    description: "作用域（固定为 {sops:[sopId]}）",
    additionalProperties: true,
  })
  scope: Record<string, unknown>;

  @ApiPropertyOptional({ description: "会话标题", nullable: true })
  title?: string | null;

  @ApiPropertyOptional({
    description: "终态结论（结构化或文本）",
    nullable: true,
    oneOf: [{ type: "object" }, { type: "string" }],
  })
  conclusion?: unknown;

  @ApiPropertyOptional({ description: "失败/中止原因", nullable: true })
  errorMessage?: string | null;

  @ApiPropertyOptional({ description: "等待外部输入的说明", nullable: true })
  waitingFor?: string | null;

  @ApiPropertyOptional({ description: "创建时间", nullable: true })
  createdAt?: Date | string | null;

  @ApiPropertyOptional({ description: "更新时间", nullable: true })
  updatedAt?: Date | string | null;

  @ApiProperty({ description: "步骤总数（全部已落库步骤）" })
  stepCount: number;

  @ApiProperty({
    description: "最新步骤摘要（按 seq 升序取末尾若干条）",
    type: WorkbenchSessionStepDto,
    isArray: true,
  })
  steps: WorkbenchSessionStepDto[];

  @ApiProperty({ description: "工具调用总数" })
  toolCallCount: number;

  @ApiProperty({ type: [WorkbenchSessionToolCallDto] })
  toolCalls: WorkbenchSessionToolCallDto[];

  @ApiProperty({
    description: "审批单状态计数（pending/granted/consumed/denied/expired）",
    additionalProperties: { type: "number" },
  })
  approvals: Record<string, number>;

  @ApiProperty({ type: [WorkbenchSessionApprovalDto] })
  approvalItems: WorkbenchSessionApprovalDto[];

  @ApiProperty({
    description: "会话关联的产物（若可判定；无则空数组）",
    type: WorkbenchSessionArtifactDto,
    isArray: true,
  })
  artifacts: WorkbenchSessionArtifactDto[];
}
