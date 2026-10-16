import { ApiPropertyOptional } from "@nestjs/swagger";
import { IsISO8601, IsIn, IsOptional, IsString } from "class-validator";
import { PaginationDto } from "../../../common/dto/pagination.dto";
import { LOG_LEVEL_VALUES } from "../log-level.util";

/**
 * N7: GET /tasks/:id/executions previously typed @Query() with the TS
 * intersection `PaginationDto & { status?: string }`. emitDecoratorMetadata
 * compiles non-trivial intersection types to `Object`, so the global
 * ValidationPipe (whitelist + forbidNonWhitelisted) had no metatype to work
 * with and every undeclared query key passed straight through to the
 * service. An explicit DTO class restores the whitelist.
 */
export class TaskExecutionsQueryDto extends PaginationDto {
  @ApiPropertyOptional({ description: "按执行状态过滤" })
  @IsOptional()
  @IsString()
  status?: string;
}

/**
 * N7: same root cause as TaskExecutionsQueryDto — declares every filter
 * field actually consumed by TaskService.getAllExecutions. Date fields are
 * ISO 8601 strings (admin-web sends dayjs .toISOString()), matching the
 * AuditQueryDto convention.
 */
export class AllExecutionsQueryDto extends PaginationDto {
  @ApiPropertyOptional({ description: "按执行状态过滤" })
  @IsOptional()
  @IsString()
  status?: string;

  @ApiPropertyOptional({ description: "按任务 id 过滤" })
  @IsOptional()
  @IsString()
  taskId?: string;

  @ApiPropertyOptional({ description: "按任务名模糊搜索" })
  @IsOptional()
  @IsString()
  taskName?: string;

  @ApiPropertyOptional({ description: "按执行器地址模糊过滤" })
  @IsOptional()
  @IsString()
  executorAddress?: string;

  /** ISO 8601 timestamp; admin-web sends dayjs .toISOString() values. */
  @ApiPropertyOptional({
    description: "仅返回在该时刻及之后创建的执行（ISO 8601）",
  })
  @IsOptional()
  @IsISO8601()
  startTime?: string;

  /** ISO 8601 timestamp; admin-web sends dayjs .toISOString() values. */
  @ApiPropertyOptional({
    description: "仅返回在该时刻及之前创建的执行（ISO 8601）",
  })
  @IsOptional()
  @IsISO8601()
  endTime?: string;
}

/**
 * OBS-03: GET /tasks/:id/executions/:execId/logs 及其兼容别名
 * （/tasks/executions/:execId/logs）的查询 DTO。
 *
 * - level：枚举校验（ERROR/WARN/INFO/DEBUG，严格大写），由全局
 *   ValidationPipe（whitelist + forbidNonWhitelisted）强制执行；
 * - fromLine/limit：沿用既有"字符串透传 + controller 内 parseInt||0 /
 *   Math.min(…, 2000)"的宽松解析语义（无 DTO 之前的宽容行为不变），
 *   这里声明仅为通过白名单，避免既有调用方被 forbidNonWhitelisted 400。
 *
 * 行为变化说明（相对无 DTO 时期）：携带未声明的额外 query 键会从"静默
 * 忽略"变为 400——与 N7（TaskExecutionsQueryDto）在 GET
 * /tasks/:id/executions 上引入白名单时接受的同一取舍一致。
 */
export class ExecutionLogsQueryDto {
  @ApiPropertyOptional({ description: "起始行号，缺省 0" })
  @IsOptional()
  @IsString()
  fromLine?: string;

  @ApiPropertyOptional({ description: "每页行数，缺省 500，最大 2000" })
  @IsOptional()
  @IsString()
  limit?: string;

  @ApiPropertyOptional({
    enum: LOG_LEVEL_VALUES,
    description:
      "按推断出的日志级别过滤日志行（SQL 层等值匹配）；级别未知（NULL）的行被排除",
  })
  @IsOptional()
  @IsIn(LOG_LEVEL_VALUES as unknown as string[])
  level?: string;
}
