import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import {
  IsBoolean,
  IsIn,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from "class-validator";

/** preview 契约固定五档触发周期；顺序即枚举顺序，前端按此发送。 */
export const PREVIEW_CADENCES = [
  "once",
  "hourly",
  "daily",
  "weekly",
  "monthly",
] as const;
export type PreviewCadence = (typeof PREVIEW_CADENCES)[number];

/** POST /api/workbench/preview 入参（字段名固定，前端 agent 依赖）。 */
export class PreviewPlanCardRequestDto {
  @ApiProperty({
    description: "业务目标描述",
    minLength: 1,
    maxLength: 500,
    example: "汇总昨日订单异常并推送日报",
  })
  @IsString()
  @IsNotEmpty({ message: "goal 不能为空" })
  @MaxLength(500)
  goal: string;

  @ApiProperty({
    description: "触发频率档位（once/hourly/daily/weekly/monthly）",
    enum: PREVIEW_CADENCES,
    example: "daily",
  })
  @IsIn(PREVIEW_CADENCES)
  cadence: PreviewCadence;

  @ApiPropertyOptional({
    description: "可选能力/预算参数；capabilityId 必须在内置白名单内",
    additionalProperties: { type: "string" },
  })
  @IsOptional()
  @IsObject()
  params?: Record<string, string>;

  @ApiPropertyOptional({
    description: "是否启用大模型辅助方案规划（可选；不影响确定性方案卡哈希）",
    default: false,
  })
  @IsOptional()
  @IsBoolean()
  useAi?: boolean;
}

export class PlanCardBudgetDto {
  @ApiProperty({ description: "本方案卡允许的最大轮次（中台硬上限 20）" })
  maxTurns: number;

  @ApiPropertyOptional({
    description:
      "相对预算单位（RU）；无 token 样本，仅按轮次与能力提示投影，不折算真实成本",
  })
  relativeUnits?: number;

  @ApiPropertyOptional({
    description: "相对预算口径说明与钳制理由（无 token 样本、不折算真实成本）",
  })
  budgetBasis?: string;
}

export class PlanCardCheckDto {
  @ApiProperty()
  field: string;

  @ApiProperty({ enum: ["ok", "warn", "fail"] })
  status: "ok" | "warn" | "fail";

  @ApiProperty()
  message: string;
}

export class PlanCardDto {
  @ApiProperty({ description: "方案卡标题" })
  title: string;

  @ApiProperty({
    description:
      "触发频率回读出的确定性业务语句（手动触发一次/每小时执行一次/每天/每周/每月 N 日）",
  })
  triggerText: string;

  @ApiProperty({ description: "能力白名单提示列表", type: [String] })
  capabilityHints: string[];

  @ApiProperty({ description: "确定性验收说明" })
  acceptanceText: string;

  @ApiProperty({ description: "方案卡预算配置", type: PlanCardBudgetDto })
  budget: PlanCardBudgetDto;
}

/** 大模型辅助规划建议（仅作展示增强，不参与 cardHash 计算）。 */
export class PlanCardAiSuggestionsDto {
  @ApiProperty({ description: "大模型生成的方案概要" })
  summary: string;

  @ApiProperty({ description: "大模型建议的执行步骤列表", type: [String] })
  suggestedSteps: string[];

  @ApiProperty({ description: "大模型识别的风险提示列表", type: [String] })
  riskNotes: string[];

  @ApiPropertyOptional({ description: "大模型建议的标题" })
  title?: string;

  @ApiPropertyOptional({
    description: "经白名单过滤后的大模型能力建议列表",
    type: [String],
  })
  capabilityHints?: string[];

  @ApiPropertyOptional({ description: "大模型建议的验收说明" })
  acceptanceText?: string;

  @ApiPropertyOptional({ description: "实际命中的模型名称" })
  model?: string;

  @ApiPropertyOptional({ description: "实际命中的模型提供方标识" })
  provider?: string;
}

/** 响应契约：card + checks + eligible + cardHash（N7 留痕锚点）。 */
export class PlanCardPreviewResponseDto {
  @ApiProperty({ description: "是否通过确定性闸门；任一 fail 即 false" })
  eligible: boolean;

  @ApiProperty({ description: "确定性生成的方案卡", type: PlanCardDto })
  card: PlanCardDto;

  @ApiProperty({ description: "确定性校验项列表", type: [PlanCardCheckDto] })
  checks: PlanCardCheckDto[];

  @ApiProperty({
    description: "card 规范化 JSON 的 sha256 短前缀（16 位十六进制）",
  })
  cardHash: string;

  @ApiProperty({
    description:
      "策略代际指纹（16 位十六进制）——能力/预算策略变更后需重新 preview",
  })
  policyGeneration: string;

  @ApiPropertyOptional({
    enum: ["ai", "deterministic"],
    description:
      "规划模式：ai 表示已附加大模型建议，deterministic 表示纯确定性规划",
  })
  plannerMode?: "ai" | "deterministic";

  @ApiPropertyOptional({
    type: PlanCardAiSuggestionsDto,
    description: "大模型辅助生成的步骤与风险建议（仅启用且模型可用时返回）",
  })
  aiSuggestions?: PlanCardAiSuggestionsDto;
}

/**
 * POST /api/workbench/commit 入参（N7 确认留痕）。
 *
 * 刻意**不含 card 内容**：服务端只凭 goal/cadence/params 用 buildPreview 同源
 * 逻辑重建 card 并重算 hash，再与 expectedCardHash 比对——客户端无法把别处的
 * 卡片内容塞进落库路径。
 */
export class CommitPlanCardRequestDto {
  @ApiProperty({
    minLength: 1,
    maxLength: 500,
    example: "汇总昨日订单异常并推送日报",
  })
  @IsString()
  @IsNotEmpty({ message: "goal 不能为空" })
  @MaxLength(500)
  goal: string;

  @ApiProperty({ enum: PREVIEW_CADENCES, example: "daily" })
  @IsIn(PREVIEW_CADENCES)
  cadence: PreviewCadence;

  @ApiPropertyOptional({
    description: "必须与 preview 时的 params 完全一致，否则重建 hash 不匹配",
    additionalProperties: { type: "string" },
  })
  @IsOptional()
  @IsObject()
  params?: Record<string, string>;

  @ApiProperty({
    description: "preview 返回的 cardHash（16 位十六进制）——确认留痕锚点",
    pattern: "^[0-9a-fA-F]{16}$",
  })
  @IsString()
  @Matches(/^[0-9a-fA-F]{16}$/, {
    message: "expectedCardHash 必须是 16 位十六进制字符串",
  })
  expectedCardHash: string;

  @ApiProperty({
    description:
      "preview 返回的 policyGeneration（16 位十六进制）——策略代际锚点",
    pattern: "^[0-9a-fA-F]{16}$",
  })
  @IsString()
  @Matches(/^[0-9a-fA-F]{16}$/, {
    message: "expectedPolicyGeneration 必须是 16 位十六进制字符串",
  })
  expectedPolicyGeneration: string;
}

/** commit 成功响应：只落 draft 态，不自动发布。 */
export class CommitResultDto {
  @ApiProperty({ description: "落库的 SOP 行 id" })
  sopId: string;

  @ApiProperty({ description: "确定性 slug：workbench-<cardHash 前 8>" })
  slug: string;

  @ApiProperty({ enum: ["draft"] })
  status: "draft";

  @ApiProperty({
    enum: ["submitted", "failed", "not_requested"],
    description:
      "ADR-045 发布审批发起状态（稳定码，非中文）：submitted=已发起并返回 approvalKey；" +
      "failed=发起异常（端口未装配/策略指纹不可读等）但 draft 已落；" +
      "not_requested=审批端口缺席或非 USER 上下文，未发起（非异常）",
  })
  approvalStatus: "submitted" | "failed" | "not_requested";

  /**
   * @deprecated 后端不再返回硬编码中文；前端改用 approvalStatus 稳定码 + i18n 文案。
   * 仅为兼容尚未升级的调用方/fixture 保留可选字段，生产路径不再赋值。
   */
  @ApiPropertyOptional({
    description: "已废弃：改用 approvalStatus + 前端 i18n，生产路径不再返回",
    deprecated: true,
    required: false,
  })
  next?: string;

  @ApiProperty({
    description:
      "ADR-045：发布审批单 key（业务人员提交后由主管四眼批准、系统代理发布）；仅 approvalStatus=submitted 时有",
    required: false,
  })
  approvalKey?: string;

  @ApiProperty({
    description:
      "本次提交放行的策略代际（16 位十六进制），供下游会话继承以做在途失效比对",
    required: false,
  })
  policyGeneration?: string;
}
