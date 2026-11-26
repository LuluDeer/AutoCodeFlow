import { ApiPropertyOptional } from "@nestjs/swagger";
import { Type } from "class-transformer";
import { IsISO8601, IsIn, IsInt, IsOptional, IsString } from "class-validator";
import { PageQueryDto } from "../../../common/dto/pagination.dto";
import {
  ACTIVATION_OUTCOMES,
  ACTIVATION_RESULTS,
} from "../entities/activation-log.entity";

/**
 * N15：GET /api/capability-activation 的过滤 + 分页参数。
 *
 * 继承 `PageQueryDto`（只有 page/pageSize），不继承带任务域字段的
 * `PaginationDto`——本端点不消费 name/status/runtime，挂上去会重演 API-07
 * 的「契约上写着但被静默忽略」问题。
 *
 * 过滤全部为**精确匹配**（capabilityKey/sessionId/userId/projectId/username/
 * result）+ createdAt 闭区间（from/to）。与 audit 查询同款：过滤器与分页正交。
 */
export class ActivationQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ description: "按能力 key 精确过滤" })
  @IsOptional()
  @IsString()
  capabilityKey?: string;

  @ApiPropertyOptional({ description: "按会话 id 精确过滤" })
  @IsOptional()
  @IsString()
  sessionId?: string;

  @ApiPropertyOptional({ type: Number, description: "按平台用户 id 精确过滤" })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  userId?: number;

  @ApiPropertyOptional({ description: "按项目 id 精确过滤" })
  @IsOptional()
  @IsString()
  projectId?: string;

  @ApiPropertyOptional({ description: "按平台用户名精确过滤" })
  @IsOptional()
  @IsString()
  username?: string;

  @ApiPropertyOptional({ enum: [...ACTIVATION_RESULTS] })
  @IsOptional()
  @IsIn([...ACTIVATION_RESULTS])
  result?: (typeof ACTIVATION_RESULTS)[number];

  @ApiPropertyOptional({
    enum: [...ACTIVATION_OUTCOMES],
    description:
      "N5 业务结果归因过滤：confirmed=已确认 / unconfirmed=未确认；映射 confirmed 列",
  })
  @IsOptional()
  @IsIn([...ACTIVATION_OUTCOMES])
  outcome?: (typeof ACTIVATION_OUTCOMES)[number];

  @ApiPropertyOptional({ description: "仅返回 createdAt >= from（ISO 8601）" })
  @IsOptional()
  @IsISO8601()
  from?: string;

  @ApiPropertyOptional({ description: "仅返回 createdAt <= to（ISO 8601）" })
  @IsOptional()
  @IsISO8601()
  to?: string;
}

/** GET /api/capability-activation/stats 的时间窗过滤（与列表 from/to 同语义）。 */
export class ActivationStatsQueryDto {
  @ApiPropertyOptional({ description: "仅统计 createdAt >= from（ISO 8601）" })
  @IsOptional()
  @IsISO8601()
  from?: string;

  @ApiPropertyOptional({ description: "仅统计 createdAt <= to（ISO 8601）" })
  @IsOptional()
  @IsISO8601()
  to?: string;
}
