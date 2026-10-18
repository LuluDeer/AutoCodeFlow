import { ApiPropertyOptional } from "@nestjs/swagger";
import { Type } from "class-transformer";
import {
  IsISO8601,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Min,
} from "class-validator";
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

  /**
   * §2.1（推广到 GET /tasks/executions/all）：**可选**的不透明游标。
   *
   * 与 `TaskExecutionsQueryDto#cursor` 逐字同款（同一套编码/解码纯函数
   * `common/utils/keyset-cursor.util.ts`，同一套 400 语义）——本端点只是把它
   * 推广到"跨任务的全局执行列表"。
   *
   * 只做加性过渡——不传它时行为与引入本字段之前**逐字节不变**（走 OFFSET
   * 分支，响应里连 `nextCursor` 这个键都不出现）。传了它才切到 keyset 分支。
   *
   * 本端点**没有** sortBy / lastStatus 那类会与游标冲突的参数（排序恒为
   * `createdAt DESC, id DESC`），故无需像 `GET /tasks` 那样再做可组合性判定：
   * 六个过滤器（status/taskId/taskName/executorAddress/startTime/endTime）全部
   * 与游标条件是 AND 关系，可以任意组合。
   */
  @ApiPropertyOptional({
    description:
      "不透明的 keyset 游标（上一页响应的 data.nextCursor）。省略时走原有的 OFFSET 分页，响应与之前完全一致；传入时走 keyset 分支并在响应中追加 nextCursor。首次进入 keyset 模式传空值（?cursor=）。可与全部过滤器（status/taskId/taskName/executorAddress/startTime/endTime）组合——它们与游标条件取交集。非法游标返回 400（VALIDATION_FAILED），不会静默退回第一页。",
  })
  @IsOptional()
  @IsString()
  cursor?: string;
}

/**
 * `GET /tasks/executions/export` 的查询 DTO——**筛选条件 + 上限**。
 *
 * ## 为什么不直接复用 `AllExecutionsQueryDto`
 *
 * 复用的诱惑在于"过滤器一字不差"，但那正是本 DTO 必须独立的理由：导出端点与
 * 列表端点共享的是**过滤器**（由 service 侧唯一真值源
 * `applyAllExecutionsFilters` 保证），不共享的是**分页语义**。`PaginationDto`
 * 带着 `page` / `pageSize` / `name` / `status` / `runtime`（后者三个是任务域
 * 遗留的混装字段，见 pagination.dto.ts 头注 API-07），把它们挂到导出端点上会
 * 造成两处静默误导：
 *
 *   ① `page=3` 对导出**毫无意义**（导出恒从最新一行开始，全量流式），但契约上
 *      它存在且合法 → 调用方合理地以为"能分段导出第 3 页"，拿到的却是从头开始
 *      的全量，且没有任何信号说明它被忽略了（这正是 API-07 记录过的那类
 *      "静默忽略"缺陷，只是这次发生在导出面）。
 *   ② `pageSize` 与导出自己的 `limit` 是两套完全不同的量纲（一页 20 行 vs
 *      最多 5 万行），都挂上去必然有人传错，而传错的表现是"导出少了几万行"。
 *
 * 故这里只声明**导出真正消费**的字段：六个过滤器（与列表端点同源）+ 一个
 * `limit`。白名单（`forbidNonWhitelisted`）因此会把 `?page=3` 变成 400——
 * 对导出端点这是**正确**反应：调用方立刻知道"分页参数在这里不适用"，
 * 而不是拿到一份看起来正确、实际语义错位的文件。
 *
 * ## `limit` 为什么是"请求上限"而不是"分页大小"
 *
 * 它是安全阀而非分页：导出必须是一次连续的快照（分段导出会因期间新增/删除
 * 行而重叠或漏行——导出没有游标，无法续传）。缺省与硬顶都由 service 侧的
 * `EXECUTION_EXPORT_ROW_CAP` 决定，此处只允许**调小**（见 controller 注释：
 * 大于硬顶一律归一到硬顶，不报错）。
 */
export class ExportExecutionsQueryDto {
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

  /** ISO 8601 timestamp; 与列表端点同为 `createdAt` 范围（不是 startTime 列）。 */
  @ApiPropertyOptional({
    description: "仅返回在该时刻及之后创建的执行（ISO 8601）",
  })
  @IsOptional()
  @IsISO8601()
  startTime?: string;

  /** ISO 8601 timestamp; 与列表端点同为 `createdAt` 范围（不是 endTime 列）。 */
  @ApiPropertyOptional({
    description: "仅返回在该时刻及之前创建的执行（ISO 8601）",
  })
  @IsOptional()
  @IsISO8601()
  endTime?: string;

  /**
   * 本次导出的行数上限（安全阀，不是分页）。
   *
   * 只允许**调小**：超过服务端硬顶（50000）时归一到硬顶而不是报错——运维在
   * 事故中想要"尽快拿到最近 100 万条里的前若干万条"，此时回一个 400 是最糟
   * 的响应（他会以为导出坏了）。归一 + 文件末尾的截断注释行，把"你拿到的不是
   * 全量"如实写在文件里。
   */
  @ApiPropertyOptional({
    type: Number,
    description:
      "本次导出的行数上限（安全阀，不是分页）。可调小；超过服务端硬顶（50000）时按硬顶处理，并在 CSV 末尾追加 `# truncated at N rows` 注释行。",
    minimum: 1,
    maximum: 50_000,
    default: 50_000,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  limit?: number;
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
