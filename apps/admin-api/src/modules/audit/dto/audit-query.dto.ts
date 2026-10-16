import { ApiPropertyOptional } from "@nestjs/swagger";
import { IsISO8601, IsIn, IsInt, IsOptional, IsString } from "class-validator";
import { Type } from "class-transformer";
import { PaginationDto } from "../../../common/dto/pagination.dto";

/**
 * Query DTO for GET /audit.
 *
 * R4 P1-2: the audit page (apps/admin-web/src/pages/audit/index.tsx) sends
 * action/resource/username/startTime/endTime as query params. None of them
 * were declared on PaginationDto, so the global ValidationPipe
 * (whitelist + forbidNonWhitelisted) rejected every filtered request with
 * 400 ("property username should not exist", ...). All filter fields are
 * declared here so the whitelist accepts them and the service can apply them.
 */
export class AuditQueryDto extends PaginationDto {
  @ApiPropertyOptional({ description: "按操作动作过滤（模糊匹配）" })
  @IsOptional()
  @IsString()
  action?: string;

  @ApiPropertyOptional({ description: "按资源类型精确过滤" })
  @IsOptional()
  @IsString()
  resource?: string;

  /**
   * AUTH-05: exact-match filter on the resource identifier column. Together
   * with `resource` this forms the (resource, resourceId) pair filter — the
   * scoped-down replacement for the planned per-Project dimension filter
   * (the Project entity does not exist yet; AUTH-01 is unclaimed). Exact
   * match (no ILIKE) because resourceId values are opaque UUIDs/ids where a
   * partial match would be surprising; the service caps the bound value so a
   * hostile query string cannot carry arbitrary-length needles.
   */
  @ApiPropertyOptional({
    description: "按资源标识精确过滤（与 resource 组合使用）",
  })
  @IsOptional()
  @IsString()
  resourceId?: string;

  @ApiPropertyOptional({
    enum: ["success", "failure"],
    description: "按操作结果过滤",
  })
  @IsOptional()
  @IsIn(["success", "failure"])
  result?: "success" | "failure";

  @ApiPropertyOptional({
    type: Number,
    description: "按操作人用户 id 过滤",
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  userId?: number;

  @ApiPropertyOptional({ description: "按操作人用户名过滤" })
  @IsOptional()
  @IsString()
  username?: string;

  /** ISO 8601 timestamp; admin-web sends dayjs .toISOString() values. */
  @ApiPropertyOptional({
    description: "仅返回在该时刻及之后创建的日志（ISO 8601）",
  })
  @IsOptional()
  @IsISO8601()
  startTime?: string;

  /** ISO 8601 timestamp; admin-web sends dayjs .toISOString() values. */
  @ApiPropertyOptional({
    description: "仅返回在该时刻及之前创建的日志（ISO 8601）",
  })
  @IsOptional()
  @IsISO8601()
  endTime?: string;
}
