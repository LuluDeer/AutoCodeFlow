import { ApiPropertyOptional } from "@nestjs/swagger";
import { IsOptional, IsString, MaxLength } from "class-validator";

/**
 * F-53（UIAUDIT 后端轮 P2-2）：高危操作的可选原因 body。
 *
 * 覆盖两个此前用内联类型 `{ reason?: string }` 的端点——metatype=Object 使
 * 全局 whitelist+forbidNonWhitelisted 纪律失效（多余字段静默收下、reason
 * 本身无类型/长度校验直落审计 detail jsonb）：
 *
 *   · POST /executors/:id/rotate-token（AUTH-05，审计 executor.rotate_token）
 *   · DELETE /executors/:id（AUTH-05，审计 executor.delete）
 *
 * 长度上限 200 对齐同类 reason 字段的既有先例：AUTH-05 的前端契约
 * （ExecutorDetailPage.tsx 头注「对齐 admin-api DTO 契约：≤200 字符」——
 * 此前只有前端单侧限长，本 DTO 把该契约在后端落地）与 DEP-04 的
 * ApprovalActionDto（@MaxLength(200)）。
 */
export class ExecutorActionReasonDto {
  @ApiPropertyOptional({
    maxLength: 200,
    description: "可选的操作原因（≤200 字符），计入审计",
    example: "decommissioned host",
  })
  @IsString()
  @MaxLength(200)
  @IsOptional()
  reason?: string;
}
