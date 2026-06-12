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

  @ApiPropertyOptional({ description: "按任务名称模糊搜索" })
  @IsOptional()
  @IsString()
  name?: string;

  @ApiPropertyOptional({ description: "按任务状态过滤" })
  @IsOptional()
  @IsString()
  status?: string;

  @ApiPropertyOptional({ description: "按运行时过滤 (python/node/shell)" })
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
  return {
    list,
    total,
    page,
    pageSize,
    totalPages: Math.ceil(total / pageSize),
  };
}
