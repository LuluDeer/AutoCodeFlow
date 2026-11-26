import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import {
  IsIn,
  IsNotEmpty,
  IsString,
  MaxLength,
  MinLength,
} from "class-validator";

import type {
  PlanCardCheckDto,
  PreviewCadence,
} from "../../workbench/dto/preview-plan-card.dto";
// PlanCardDto 必须值导入：swagger 反射靠运行时元数据解析 @ApiProperty 的隐式类型，
// type-only import 在 emit 后消失 ⇒ card 回落成空壳 Function schema（openapi 空壳守卫抓到）。
import {
  PlanCardDto,
  PREVIEW_CADENCES,
} from "../../workbench/dto/preview-plan-card.dto";
import type { ProjectRole } from "../../project/entities/project-member.entity";
import { IM_PLATFORMS } from "../entities/im-identity.entity";
import type { ImInjectionFinding } from "../injection-guard";

/**
 * N6 · Intake 编排入参（未来 IM webhook adapter 的 POST body）。
 *
 * DTO 只做形态校验：平台枚举 / sender 长度 / 业务语言非空且 ≤500（与
 * workbench.buildPreview 的 goal 上限同口径）/ cadence 三档。注入扫描、
 * 身份绑定语义、ProjectRole 判定都在 service 层——单测以内存替身直调 service，
 * 不能只靠 class-validator。
 *
 * 枚举一律复用既有导出常量（IM_PLATFORMS / PREVIEW_CADENCES），不手抄字面量
 * 数组——check-enum-consumers 的「手抄清单」启发式会把含 wecom/feishu 的数组
 * 误判成 AlertChannel 清单，复用常量从根上避开该误报。
 */
export class ImIntakeDto {
  @ApiProperty({ enum: IM_PLATFORMS, example: "wecom" })
  @IsString()
  @IsIn([...IM_PLATFORMS])
  platform: string;

  @ApiProperty({ minLength: 1, maxLength: 128, example: "zhangsan" })
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  imSenderId: string;

  @ApiProperty({
    description: "业务语言描述（作为方案卡 goal），如「每月5号导出销售报表」",
    minLength: 1,
    maxLength: 500,
    example: "每月5号导出销售报表",
  })
  @IsString()
  @IsNotEmpty({ message: "message 不能为空" })
  @MaxLength(500)
  message: string;

  @ApiProperty({ enum: PREVIEW_CADENCES, example: "monthly" })
  @IsString()
  @IsIn([...PREVIEW_CADENCES])
  cadence: PreviewCadence;
}

/** Intake 出参里的身份投影：绑定通过后的最小可用字段集。 */
export class ImIntakeIdentityDto {
  @ApiProperty({ description: "绑定的平台 user id（已验非空）" })
  platformUserId: number;

  @ApiPropertyOptional({
    description: "项目归属；null = 平台级绑定，跳过角色校验",
  })
  projectId: string | null;

  @ApiPropertyOptional({ description: "绑定时登记的项目角色；null = 未授予" })
  projectRole: ProjectRole | null;
}

/** Intake 出参里的注入扫描摘要（不携带超长 evidence 以外的原文）。 */
export class ImIntakeScanDto {
  @ApiProperty({ description: "是否通过注入扫描（CRITICAL 命中即 false）" })
  safe: boolean;

  @ApiProperty({
    description: "命中项列表（rule/severity/evidence）",
    isArray: true,
  })
  findings: ImInjectionFinding[];
}

/**
 * Intake 出参。card/checks/eligible/cardHash/policyGeneration 与 workbench
 * preview 逐字段对齐，前端 / 未来 IM adapter 可直接复用；identity / scan 是
 * 本编排新增的溯源投影。Intake **只预览**：不落 SOP、不落 activation。
 */
export class ImIntakeResultDto {
  @ApiProperty({
    type: [Object],
    description: "方案卡确定性校验项（同 workbench preview）",
  })
  checks: PlanCardCheckDto[];

  @ApiProperty({ description: "方案卡主体" })
  card: PlanCardDto;

  @ApiProperty({ description: "是否通过确定性闸门；任一 fail 即 false" })
  eligible: boolean;

  @ApiProperty({
    description: "card 规范化 JSON 的 sha256 短前缀（16 位 hex）",
  })
  cardHash: string;

  @ApiProperty({ description: "策略代际指纹（16 位 hex，编译期快照口径）" })
  policyGeneration: string;

  @ApiProperty({ type: ImIntakeIdentityDto })
  identity: ImIntakeIdentityDto;

  @ApiProperty({ type: ImIntakeScanDto })
  scan: ImIntakeScanDto;
}
