import { ApiPropertyOptional } from "@nestjs/swagger";
import { Transform } from "class-transformer";
import { IsOptional, IsString, MaxLength } from "class-validator";
import { PageQueryDto } from "../../../common/dto/pagination.dto";

/**
 * GET /users 的查询参数：分页（PageQueryDto）+ 可选 search。
 *
 * 沿革：API-07 曾把 GET /users 从携带**任务专用**过滤字段的 PaginationDto
 * 收窄为 PageQueryDto——彼时 name/status/runtime 被 OpenAPI 公示却从未被
 * 消费（传了静默无效）。本 DTO 重新引入的 search 是**真实被消费**的过滤
 * 字段：username / email ILIKE 模糊匹配（users.service.findAll 对 LIKE
 * 元字符做转义，见 audit.service escapeLikePattern 同款先例），服务前端
 * 用户管理页的**全量**搜索——原先前端只在前端当前页数据里 filter，
 * 用户数超过一页时搜索结果不完整。
 */
export class ListUsersDto extends PageQueryDto {
  @ApiPropertyOptional({
    description: "Fuzzy search by username or email (case-insensitive)",
    maxLength: 100,
  })
  @IsOptional()
  // 去空白：query 串里首尾空格几乎总是误触，trim 后空串在 service 层按
  // 「无过滤」处理（不做无意义的 `%%` 全匹配）。
  @Transform(({ value }) => (typeof value === "string" ? value.trim() : value))
  @IsString()
  @MaxLength(100)
  search?: string;
}
