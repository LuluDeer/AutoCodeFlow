import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import {
  IsIn,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from "class-validator";

/** preview 契约固定三档 cron；顺序即枚举顺序，前端按此发送。 */
export const PREVIEW_CADENCES = ["daily", "weekly", "monthly"] as const;
export type PreviewCadence = (typeof PREVIEW_CADENCES)[number];

/** POST /api/workbench/preview 入参（字段名固定，前端 agent 依赖）。 */
export class PreviewPlanCardRequestDto {
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
    description: "可选能力/预算参数；capabilityId 必须在内置白名单内",
    additionalProperties: { type: "string" },
  })
  @IsOptional()
  @IsObject()
  params?: Record<string, string>;
}

export class PlanCardBudgetDto {
  @ApiProperty({ description: "本方案卡允许的最大轮次（中台硬上限 20）" })
  maxTurns: number;
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
  @ApiProperty()
  title: string;

  @ApiProperty({
    description: "cron 回读出的确定性业务语句（每天/每周/每月 N 日）",
  })
  triggerText: string;

  @ApiProperty({ type: [String] })
  capabilityHints: string[];

  @ApiProperty()
  acceptanceText: string;

  @ApiProperty({ type: PlanCardBudgetDto })
  budget: PlanCardBudgetDto;
}

/** 响应契约：card + checks + eligible + cardHash（N7 留痕锚点）。 */
export class PlanCardPreviewResponseDto {
  @ApiProperty({ description: "是否通过确定性闸门；任一 fail 即 false" })
  eligible: boolean;

  @ApiProperty({ type: PlanCardDto })
  card: PlanCardDto;

  @ApiProperty({ type: [PlanCardCheckDto] })
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

  @ApiProperty({ description: "发布是独立审批动作，提交后仍需人工审阅" })
  next: string;

  @ApiProperty({
    description:
      "本次提交放行的策略代际（16 位十六进制），供下游会话继承以做在途失效比对",
    required: false,
  })
  policyGeneration?: string;
}
