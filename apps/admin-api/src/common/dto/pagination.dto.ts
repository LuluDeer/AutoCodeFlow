import { ApiPropertyOptional } from "@nestjs/swagger";
import { Type } from "class-transformer";
import { IsInt, IsOptional, IsString, Max, Min } from "class-validator";

/**
 * 纯分页基类：**只有** page / pageSize，不含任何业务过滤字段。
 *
 * API-07（本轮体验审查）：`PaginationDto` 历史上把三个**任务专用**过滤字段
 * （name / status / runtime）混进了"分页"这个通用概念里，于是它们被 6 个 DTO
 * 继承、出现在**所有**分页端点的 OpenAPI 参数表上——包括根本不消费它们的
 * 端点。最典型的是 `GET /users`：契约上写着
 *   `name` —— "Fuzzy search by task name"
 * 而 `usersService.findAll` 只取 page/pageSize，**完全忽略 name**。
 *
 * 危害不是"多几个无用参数"：`?name=alice` 会**静默返回未过滤的全量用户列表**
 * 且 HTTP 200。调用方（acf-cli / mcp-server / 手工调 API 的运维）无法分辨
 * "没有匹配" 与 "过滤没生效"，会拿到错误结论。整个响应没有任何信号说明它被
 * 忽略了。
 *
 * 修法：把分页与业务过滤分层——需要过滤的 DTO 继续继承 `PaginationDto`
 * （行为不变），不消费这些过滤器的端点改继承本类，契约因此如实。
 * 这是**纯契约收窄**：被移除的字段本来就被忽略，删掉不改变任何运行时行为。
 */
export class PageQueryDto {
  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page = 1;

  @ApiPropertyOptional({ default: 20, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize = 20;
}

/**
 * 分页 + **任务域**过滤字段。
 *
 * 保留原名与形状以兼容既有 6 个 DTO（audit / config-history / executions /
 * executor-package / list-tasks / users 的调用点），但**新端点不应再继承它**
 * 除非确实消费这些过滤器——那正是 API-07 的成因。新代码优先继承
 * `PageQueryDto`。
 */
export class PaginationDto extends PageQueryDto {
  @ApiPropertyOptional({ description: "Fuzzy search by task name" })
  @IsOptional()
  @IsString()
  name?: string;

  @ApiPropertyOptional({ description: "Filter by task status" })
  @IsOptional()
  @IsString()
  status?: string;

  @ApiPropertyOptional({ description: "Filter by runtime (python/node/shell)" })
  @IsOptional()
  @IsString()
  runtime?: string;
}

export function paginate<T>(
  list: T[],
  total: number,
  page: number,
  pageSize: number,
) {
  // R-21（DEEP_REVIEW 0ef3bbe）: paginate 同时下发 list/items 双键——契约漂移
  // 土壤，但**本轮不改**（DEFERRED-CROSS-SCOPE）：收敛为单键会破坏范围外消费方。
  // 已核实 items 消费方（apps/admin-web/src/pages|components|api、scripts）与
  // list 消费方（packages/acf-cli、packages/mcp-server，均读 `data.list`）并存，
  // 且后二者不在本域（apps/admin-api）内、无法同步改。删除任一键都会造成跨包
  // 静默回归（如 acf-cli `task list` 会退化为空表）。故保持双键不变，待各 SDK/
  // CLI 统一到 items 后另轮收敛（届时同步删 list）。
  return {
    list,
    items: list,
    total,
    page,
    pageSize,
    totalPages: Math.ceil(total / pageSize),
  };
}
