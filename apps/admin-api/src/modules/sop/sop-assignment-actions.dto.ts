import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsOptional, IsString, MaxLength } from "class-validator";

import {
  SOP_ASSIGNMENT_STATUSES,
  SopAssignmentStatus,
} from "./entities/sop-assignment.entity";
import { SopAssignmentDto } from "./dto/sop-response.dto";

/** 单条指派取消原因的最大字符数（服务端与前端弹窗对齐）。 */
export const CANCEL_ASSIGNMENT_REASON_MAX_LENGTH = 500;

/**
 * R289 · `POST /sop/assignments/:assignmentId/cancel` 请求体。
 *
 * 整个请求体可选（前端不填理由时可发 `{}` 或空体）；若提供非空 `reason`，
 * 服务端经 `trim()` + `sanitizeSecrets` 脱敏后写入审计日志 `detail`，不覆写
 * 指派行的 `resultJson`。
 */
export class CancelSopAssignmentDto {
  @ApiPropertyOptional({
    description:
      "取消原因（可选，最多 500 字符；经脱敏后写入审计日志，不覆盖执行结果）",
    maxLength: CANCEL_ASSIGNMENT_REASON_MAX_LENGTH,
  })
  @IsOptional()
  @IsString()
  @MaxLength(CANCEL_ASSIGNMENT_REASON_MAX_LENGTH)
  reason?: string;
}

/**
 * R289 · `POST /sop/assignments/:assignmentId/cancel` 响应契约。
 *
 * 必须使用具名 DTO（而非内联匿名对象），满足 OpenAPI 响应 schema 覆盖率棘轮
 * 以及前端 `api/sops.ts` 直接从 `api-types.ts` 派生类型的硬约束。
 */
export class SopCancelAssignmentResponseDto {
  @ApiProperty({
    type: SopAssignmentDto,
    description: "取消后的指派最新快照（status 恒为 cancelled）",
  })
  assignment: SopAssignmentDto;

  @ApiProperty({
    enum: SOP_ASSIGNMENT_STATUSES,
    description:
      "取消前的指派状态（assigned | in_progress | blocked | stalled）",
  })
  previousStatus: SopAssignmentStatus;
}
