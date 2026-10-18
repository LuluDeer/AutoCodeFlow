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

  /**
   * §2.1（推广到 `GET /audit`）：**可选**的不透明游标。
   *
   * 只做加性过渡——不传它时行为与引入本字段之前**逐字节不变**（走 OFFSET 分支，
   * 响应里连 `nextCursor` 这个键都不出现）。传了它才切到 keyset 分支。
   *
   * 与 `TaskExecutionsQueryDto#cursor` 同一套 400 语义，但**解码器不同**：
   * `audit_logs.id` 是 `integer`（实测 `information_schema`：`integer`，
   * `nextval('audit_logs_id_seq')`），不是 uuid，故走
   * `decodeNumericKeysetCursor`。时间段的校验与 task 域**共用同一份实现**
   * （`splitCursorPayload`），两个端点对同一串时间分量给出完全相同的结论。
   *
   * 这里**刻意不做格式校验**（不挂 `@Matches`）：游标的合法性判定全部集中在纯
   * 函数里，由它抛 `VALIDATION_FAILED`（400，带可翻译 detail）。理由与 task 域
   * 两处逐字相同——管道抛的是字段名数组，前端只能渲染成"参数校验失败：cursor
   * must be …"，既没有"游标坏了、请从第一页重来"这句可操作指引，也让"游标非法"
   * 在监控里与"任意别的参数写错"混在一起无法区分。
   *
   * 八个过滤器（action/resource/resourceId/username/startTime/endTime/userId/
   * result）全部与游标条件是 AND 关系，可以任意组合——本端点没有 sortBy 那类
   * 会与游标冲突的排序参数（排序恒为 `createdAt DESC, id DESC`）。
   */
  @ApiPropertyOptional({
    description:
      "不透明的 keyset 游标（上一页响应的 data.nextCursor）。省略时走原有的 OFFSET 分页，响应与之前完全一致；传入时走 keyset 分支并在响应中追加 nextCursor。首次进入 keyset 模式传空值（?cursor=）。可与全部过滤器（action/resource/resourceId/username/startTime/endTime/userId/result）组合——它们与游标条件取交集。非法游标返回 400（VALIDATION_FAILED），不会静默退回第一页。",
  })
  @IsOptional()
  @IsString()
  cursor?: string;
}
