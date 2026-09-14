import { ApiPropertyOptional } from "@nestjs/swagger";
import { Type } from "class-transformer";
import { IsInt, IsOptional, IsString, Max, Min } from "class-validator";

export class PaginationDto {
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
