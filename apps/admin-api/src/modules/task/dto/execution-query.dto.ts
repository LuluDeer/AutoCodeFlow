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

  /**
   * §2.1（本轮）：**可选**的不透明游标。
   *
   * 只做加性过渡——不传它时行为与引入本字段之前**逐字节不变**（走 OFFSET 分支，
   * 响应里连 `nextCursor` 这个键都不出现）。传了它才切到 keyset 分支。
   *
   * 这里**刻意不做格式校验**（不挂 `@Matches` / 自定义 validator）：游标的合法性
   * 判定（base64url → ISO 时间 → uuid 形状）全部集中在纯函数
   * `decodeExecutionCursor`（common/utils/keyset-cursor.util.ts）里，由它抛
   * `VALIDATION_FAILED`（400，带可翻译错误码）。
   *
   * 为什么不交给 class-validator：管道抛的是 `VALIDATION_FAILED` + 字段名数组，
   * 前端只能渲染成"参数校验失败：cursor must be …"，既没有"游标坏了、请从第一页
   * 重来"这句可操作的指引，也让"游标非法"在监控里与"任意别的参数写错"混在一起
   * 无法区分。语义上它也确实是**领域状态**不合法（编码后的排序键），不是普通
   * 参数格式错误。
   */
  @ApiPropertyOptional({
    description:
      "不透明的 keyset 游标（上一页响应的 data.nextCursor）。省略时走原有的 OFFSET 分页，响应与之前完全一致；传入时走 keyset 分支并在响应中追加 nextCursor。非法游标返回 400（VALIDATION_FAILED），不会静默退回第一页。",
  })
  @IsOptional()
  @IsString()
  cursor?: string;
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
