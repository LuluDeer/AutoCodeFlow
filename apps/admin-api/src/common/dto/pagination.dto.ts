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
  // NETOPT-3④: page 加上限——page 只进 `OFFSET (page-1)*pageSize`，无上限时
  // `?page=99999999` 会生成深 OFFSET + getManyAndCount 全量 COUNT，两个都是
  // 全表游走，可钉满连接池。UI 翻页远用不到 1 万页（pageSize≤100 → 覆盖
  // 100 万行），防御性封顶即可。pageSize 上限既有（@Max(100)）。
  @ApiPropertyOptional({ default: 1, maximum: 10000 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(10000)
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
  @ApiPropertyOptional({ description: "按任务名模糊搜索" })
  @IsOptional()
  @IsString()
  name?: string;

  @ApiPropertyOptional({ description: "按任务状态过滤" })
  @IsOptional()
  @IsString()
  status?: string;

  @ApiPropertyOptional({ description: "按 runtime 过滤（python/node/shell）" })
  @IsOptional()
  @IsString()
  runtime?: string;
}

/**
 * 分页信封的**加性**扩展开关（PLAN-BACKEND-ARCHITECTURE §2.1 游标分页）。
 *
 * 现状：信封恒为 `{list, items, total, page, pageSize, totalPages}`，被**四端**
 * 消费——admin-web / acf-cli / mcp-server / 执行器机器面。直接换成 keyset 形态
 * 会一次性打断四端，且本仓大量既有用例压在现行为上。
 *
 * 故本轮只做**加性过渡**：
 *   · 不带 `cursor` 的请求 → 走原有 OFFSET 分支，响应**逐字节不变**
 *     （`nextCursor` 这个键**根本不出现**）；
 *   · 带 `cursor` 的请求 → 走 keyset 分支，响应**追加** `nextCursor`。
 *
 * ## 为什么旧路径不是"恒下发 null"而是"键不出现"
 *
 * "加性字段恒下发 null" 看似更整齐，但它会让 OFFSET 分支的响应体**多一个键**：
 * 逐字节比对（`toEqual` 严格比较键集合、快照断言、以及下游四端里任何
 * "键集合"式校验）都会红。硬要求是旧路径逐字节不变，所以这里用 `undefined`
 * 让 JSON 序列化把键**整个丢掉**（`JSON.stringify` 不输出 `undefined` 值），
 * 旧路径的线上响应与改动前完全相同；新路径（keyset）显式传 `null` 或字符串，
 * 键必然出现。
 *
 * @param options.nextCursor keyset 分支的下一页游标。`undefined` = 调用方走
 *   OFFSET 分支（键不下发）；`null` = 走 keyset 但已到末页（键下发 null）。
 *   **两者语义不同，不要为了"少一个分支"把它们合并**——那正是上面在防的事。
 */
export function paginate<T>(
  list: T[],
  total: number,
  page: number,
  pageSize: number,
  options?: { nextCursor?: string | null },
) {
  // R-21（DEEP_REVIEW 0ef3bbe）: paginate 同时下发 list/items 双键——契约漂移
  // 土壤，但**本轮不改**（DEFERRED-CROSS-SCOPE）：收敛为单键会破坏范围外消费方。
  // 已核实 items 消费方（apps/admin-web/src/pages|components|api、scripts）与
  // list 消费方（packages/acf-cli、packages/mcp-server，均读 `data.list`）并存，
  // 且后二者不在本域（apps/admin-api）内、无法同步改。删除任一键都会造成跨包
  // 静默回归（如 acf-cli `task list` 会退化为空表）。故保持双键不变，待各 SDK/
  // CLI 统一到 items 后另轮收敛（届时同步删 list）。
  const envelope: PaginatedEnvelope<T> = {
    list,
    items: list,
    total,
    page,
    pageSize,
    totalPages: Math.ceil(total / pageSize),
  };
  // §2.1：只在调用方明确要求时追加——`undefined` 保持键不出现（旧路径零变化）。
  if (options?.nextCursor !== undefined) {
    envelope.nextCursor = options.nextCursor;
  }
  return envelope;
}

/** `paginate` 的返回形状：既有 6 键 + 可选 `nextCursor`（§2.1）。 */
export interface PaginatedEnvelope<T> {
  list: T[];
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
  /** 仅 keyset 分支下发；OFFSET 分支这个键不存在（见 paginate 注释）。 */
  nextCursor?: string | null;
}
