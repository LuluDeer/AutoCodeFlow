/**
 * 工作台交互式会话 DTO。
 *
 * 与 `workbench-session.dto.ts`（SOP 草稿运行面）刻意分开：
 * 本组端点支持 prompt-first（无需先 commit SOP），会话 kind 由服务端从 prompt
 * 形态推导（chat / sop_authoring / plan），triggerSource 恒为 `workbench`。
 * 请求体没有 kind / scope / createdBy / triggerSource 字段——ValidationPipe
 * whitelist 保证客户端无法越权指定。kind 一律由服务端从 prompt 推导。
 */
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import {
  IsEnum,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from "class-validator";
import { Type } from "class-transformer";

/** 审批处置动作。grant/deny 需 ADMIN 且四眼；withdraw 允许创建者本人。 */
export const WORKBENCH_APPROVAL_DECISIONS = [
  "grant",
  "deny",
  "withdraw",
] as const;
export type WorkbenchApprovalDecision =
  (typeof WORKBENCH_APPROVAL_DECISIONS)[number];

/** 会话消息模式：followup 普通续问；steer 在等待期注入。 */
export const WORKBENCH_MESSAGE_MODES = ["followup", "steer"] as const;
export type WorkbenchMessageMode = (typeof WORKBENCH_MESSAGE_MODES)[number];

/** POST /workbench/chat-sessions 请求体：一句 prompt 即可开会话。 */
export class CreateWorkbenchChatSessionDto {
  @ApiProperty({
    description: "用户给工作台的初始指令（作为首条 user AgentStep 落库）",
    minLength: 1,
    maxLength: 4000,
    example: "帮我分析昨天的订单异常并起草一份日报 SOP",
  })
  @IsString()
  @IsNotEmpty({ message: "prompt 不能为空" })
  @Matches(/\S/, { message: "prompt 不能为纯空白" })
  @MaxLength(4000)
  prompt: string;

  @ApiPropertyOptional({
    description: "会话标题（可选；缺省由服务端按 prompt 截取）",
    maxLength: 255,
  })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  title?: string;

  @ApiPropertyOptional({
    description: "可选业务上下文（服务端脱敏后落 session.contextJson）",
    additionalProperties: true,
  })
  @IsOptional()
  @IsObject()
  context?: Record<string, unknown>;
}

/** chat-session 创建回执。 */
export class WorkbenchChatSessionResponseDto {
  @ApiProperty({ description: "会话 id（SSE / 消息 / 取消端点使用）" })
  sessionId: string;

  @ApiProperty({ description: "会话初始状态（pending）" })
  status: string;

  @ApiProperty({
    enum: ["chat", "sop_authoring", "plan"],
    description: "实际会话类型",
  })
  kind: string;

  @ApiProperty({ description: "首条 user 消息是否已落库" })
  initialStepPersisted: boolean;
}

/** POST /workbench/sessions/:id/messages 请求体。 */
export class PostWorkbenchMessageDto {
  @ApiProperty({
    description: "追加的对话正文（落 role=user AgentStep）",
    maxLength: 4000,
  })
  @IsString()
  @IsNotEmpty({ message: "content 不能为空" })
  @Matches(/\S/, { message: "content 不能为纯空白" })
  @MaxLength(4000)
  content: string;

  @ApiPropertyOptional({
    description:
      "投送模式；followup=普通续问，steer=等待期注入（默认 followup）",
    enum: WORKBENCH_MESSAGE_MODES,
    default: "followup",
  })
  @IsOptional()
  @IsEnum(WORKBENCH_MESSAGE_MODES)
  mode?: WorkbenchMessageMode;
}

/** 通用写操作回执（消息 / 取消 / 审批均用）。 */
export class WorkbenchSessionActionResponseDto {
  @ApiProperty({ description: "操作是否成功" })
  ok: boolean;

  @ApiPropertyOptional({ description: "会话 id" })
  sessionId?: string;

  @ApiPropertyOptional({ description: "当前会话状态" })
  status?: string;

  @ApiPropertyOptional({ description: "是否触发了会话恢复入队" })
  resumed?: boolean;

  @ApiPropertyOptional({
    description: "动作结果码；终态追消息被拒时为 rejected_terminal",
    enum: ["rejected_terminal"],
  })
  action?: "rejected_terminal";

  @ApiPropertyOptional({
    description: "失败/拒绝原因（可直接展示）；ok=false 时给出",
  })
  reason?: string;
}

/** POST /workbench/sessions/:id/approvals/:approvalKey/decide 请求体。 */
export class DecideWorkbenchApprovalDto {
  @ApiProperty({
    description:
      "处置动作：grant/deny 仅 ADMIN 且四眼（申请人不可批自己的单）；withdraw 仅创建者本人撤回待批单",
    enum: WORKBENCH_APPROVAL_DECISIONS,
  })
  @IsEnum(WORKBENCH_APPROVAL_DECISIONS)
  decision: WorkbenchApprovalDecision;

  @ApiPropertyOptional({
    description:
      "处置附言（可选；不参与服务端判定，仅供前端展示/排查，最长 500 字）",
    maxLength: 500,
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

/** GET /workbench/sessions 的增强查询面（pageSize 上限 50）。 */
export class ListWorkbenchInteractiveSessionsQueryDto {
  @ApiPropertyOptional({ type: Number, minimum: 1, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({ type: Number, minimum: 1, maximum: 50, default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  pageSize?: number;
}

/**
 * POST /workbench/sessions/:id/convert-to-sop 请求体（切片 E1：workbench → SOP 直连）。
 *
 * 刻意**不含 goal / card / slug**：goal 与 cardHash 由服务端从会话
 * contextJson 读取（createSession 时写入的 commit 锚点）；卡片内容一律由
 * 服务端按 goal/cadence/params 确定性重建——客户端无法塞入未经验证的卡片。
 */
export class ConvertWorkbenchSessionToSopDto {
  @ApiProperty({
    description: "与 commit 时一致的执行节奏（用于服务端确定性重建方案卡）",
    enum: ["once", "hourly", "daily", "weekly", "monthly"],
  })
  @IsIn(["once", "hourly", "daily", "weekly", "monthly"])
  cadence: "once" | "hourly" | "daily" | "weekly" | "monthly";

  @ApiPropertyOptional({
    description:
      "与 preview/commit 时完全一致的参数（缺失或漂移都会导致重建 hash 不匹配）",
    additionalProperties: { type: "string" },
  })
  @IsOptional()
  @IsObject()
  params?: Record<string, string>;
}

/** convert-to-sop 回执：新 SOP 草稿的定位信息（绝不自动发布）。 */
export class WorkbenchSessionConvertResponseDto {
  @ApiProperty({
    description: "新草稿 slug（由 goal 归一化生成；冲突自动追加 -2/-3…）",
  })
  slug: string;

  @ApiProperty({ description: "新落库 SOP 草稿行 id" })
  sopId: string;

  @ApiProperty({ enum: ["draft"], description: "恒为 draft——转换绝不发布" })
  status: "draft";

  @ApiProperty({ description: "恒为 false——本端点不触碰发布闸" })
  published: boolean;

  @ApiProperty({
    description: "SOP 页深链（/sops?sop=<sopId>，SopsPage 现行深链契约）",
  })
  deeplink: string;
}
