import {
  ApiProperty,
  ApiPropertyOptional,
  getSchemaPath,
} from "@nestjs/swagger";
import {
  BlockStrategy,
  ExecuteMode,
  MisfireStrategy,
  TaskCodeSource,
  TaskRuntime,
  TaskStatus,
  TaskTriggerType,
} from "../entities/task.entity";
import {
  ExecutionFailureReason,
  ExecutionStatus,
} from "../entities/task-execution.entity";

/**
 * ARCH-23 / N-12：任务域**响应体 DTO**（Task Management 是 openapi response
 * schema 覆盖率最大的缺口面——31/36 端点此前只有 description 没有 schema，
 * 前端 gen:api-types 生成不出类型）。
 *
 * 约定与 auth/application 批次一致：
 * - 字段与 service 实际返回逐一对齐（含可空性），不描述"理论上的形状"；
 * - 不建模全局 {code,message,data} envelope（ResponseInterceptor 对所有
 *   端点统一包裹，DTO 只描述 data 载荷）；
 * - 实体类不直接当响应 DTO 用——Task/TaskExecution 实体带大量内部注释与
 *   TypeORM 装饰器，且 swagger 对实体的反射会把它钉成"实体=契约"，此后
 *   任何内部列都自动进契约（Package 模块 filePath 教训：泄漏面被固化）。
 *
 * 三个如实标注的口径：
 * - POST 默认 201：pause/resume/trigger/kill/analyze/rollback 等写端点
 *   均**无** @HttpCode → 实际 HTTP 状态是 201（历史 @ApiResponse 声明 200
 *   是漂移，本批按实际状态落契约；envelope.code 同步为 201）。
 * - GET /tasks 支持 ?fields= 投影（F-10）：投影下列表项只是 TaskResponseDto
 *   的子集——契约按默认全量投影描述，fields 是可选收缩而非独立形状。
 * - 分页响应 list/items 双键（R-21：acf-cli 读 list、admin-web 读 items，
 *   收敛前两键并存），DTO 如实双列。
 */

/** Task 实体的完整响应形态（详情/创建/更新/pause/resume/快照回滚等）。 */
export class TaskResponseDto {
  @ApiProperty({ format: "uuid" })
  id: string;

  @ApiProperty({ description: "任务名（全局唯一）" })
  name: string;

  @ApiProperty({
    nullable: true,
    description: "任务描述",
  })
  description: string | null;

  @ApiProperty({
    enum: TaskStatus,
    description: "已删除的行永不返回（软删除）",
  })
  status: TaskStatus;

  @ApiProperty({ enum: TaskTriggerType })
  triggerType: TaskTriggerType;

  @ApiProperty({
    nullable: true,
    description: "5 字段 cron 表达式（cron 任务）",
  })
  cronExpression: string | null;

  @ApiProperty({
    nullable: true,
    description: "用于 cron 计算的 IANA 时区",
  })
  timezone: string | null;

  @ApiProperty({
    nullable: true,
    description: "固定频率间隔，单位毫秒（fixed_rate 任务）",
  })
  fixedRate: number | null;

  @ApiProperty({ enum: TaskRuntime })
  runtime: TaskRuntime;

  @ApiProperty({
    nullable: true,
    description: "声明的解释器版本（多版本 WS1）",
  })
  runtimeVersion: string | null;

  @ApiProperty({
    nullable: true,
    additionalProperties: { type: "string" },
    description: "执行器在运行前安装的依赖规格（打包类任务）",
  })
  dependencies: Record<string, string> | null;

  @ApiProperty({
    description: "G6 失败边：上游依赖进入失败终态时也触发本任务（补偿/清理链）",
  })
  runOnUpstreamFailure: boolean;

  @ApiProperty({
    nullable: true,
    description: "包内的入口文件",
  })
  entrypoint: string | null;

  @ApiProperty({
    nullable: true,
    type: [String],
    description: "Python/node 依赖列表（uv pip install / npm install）",
  })
  requirements: string[] | null;

  @ApiProperty({
    nullable: true,
    description: "Git 仓库 URL（git 源任务）",
  })
  gitRepo: string | null;

  @ApiProperty({ nullable: true })
  gitBranch: string | null;

  @ApiProperty({
    nullable: true,
    description: "当前检出的提交",
  })
  gitCommit: string | null;

  @ApiProperty({
    nullable: true,
    description: "最新的配置快照版本标签",
  })
  currentVersion: string | null;

  @ApiProperty({ description: "执行超时秒数（0 = 不限）" })
  timeout: number;

  @ApiProperty({ description: "派发/执行失败后的重试次数上限" })
  maxRetry: number;

  @ApiProperty({ description: "重试间隔秒数" })
  retryDelay: number;

  @ApiProperty({
    nullable: true,
    type: [String],
    description:
      "可重试的失败关键词子串，不区分大小写；null/空 = 所有失败都重试",
  })
  retryableErrors: string[] | null;

  @ApiProperty({ enum: BlockStrategy })
  blockStrategy: BlockStrategy;

  @ApiProperty({ enum: MisfireStrategy })
  misfireStrategy: MisfireStrategy;

  @ApiProperty({
    enum: ["low", "normal", "high", "critical"],
    description: "以 PG 枚举标签的形态存储（并返回）；写入时会把数字输入归一化",
  })
  priority: "low" | "normal" | "high" | "critical";

  @ApiProperty({ enum: ExecuteMode })
  executeMode: ExecuteMode;

  @ApiProperty({
    nullable: true,
    description: "调度器最近一次将该任务入队的时间",
  })
  lastTriggerTime: Date | null;

  @ApiProperty({ nullable: true })
  alarmEmail: string | null;

  @ApiProperty({
    nullable: true,
    type: [String],
    description: "失败/超时告警使用的告警渠道名",
  })
  alarmChannels: string[] | null;

  @ApiProperty({
    nullable: true,
    additionalProperties: true,
    description: "默认运行参数（纯运行时参数，不含凭据）",
  })
  params: Record<string, unknown> | null;

  @ApiProperty({
    nullable: true,
    description: "按名称固定到某个执行器应用",
  })
  executorAppName: string | null;

  @ApiProperty({
    nullable: true,
    format: "uuid",
    description: "该任务运行所依赖的应用（zip 包）",
  })
  applicationId: string | null;

  @ApiProperty({
    enum: [Object.values(TaskCodeSource), null],
    description:
      "显式的代码来源通道（null = 历史遗留行，读取时按联合语义处理）",
  })
  codeSource: TaskCodeSource | null;

  @ApiProperty({
    nullable: true,
    format: "uuid",
    description: "所属项目（null = 未分配/默认项目视图）",
  })
  projectId: string | null;

  @ApiPropertyOptional({
    nullable: true,
    type: "object",
    properties: {
      id: { type: "string", format: "uuid" },
      name: { type: "string" },
    },
    description:
      "项目关联——当前读取路径不会加载它（普通仓储查询从不 join 该关联）",
  })
  project?: { id: string; name: string } | null;

  @ApiProperty({
    nullable: true,
    description:
      "创建者用户 ID（null = 无归属的历史遗留行；鉴权按仅管理员可见处理）",
  })
  ownerUserId: number | null;

  @ApiProperty({
    nullable: true,
    additionalProperties: { type: "string" },
    description:
      "任务密钥，始终打码：叶子值恒为 '******'（SEC-02）；明文永不出服务端",
  })
  secrets: Record<string, string> | null;

  @ApiProperty({
    nullable: true,
    description: "执行器分组过滤条件（与标签按 AND 组合）",
  })
  executorGroup: string | null;

  @ApiProperty({
    nullable: true,
    type: [String],
    description: "必需的执行器标签（AND 子集语义）",
  })
  executorTags: string[] | null;

  @ApiProperty({
    nullable: true,
    type: [String],
    description: "亲和标签——命中任意一个即保留该执行器为候选（OR）",
  })
  executorAffinityTags: string[] | null;

  @ApiProperty({
    nullable: true,
    type: [String],
    description: "反亲和标签——命中任意一个即排除该执行器",
  })
  executorAntiAffinityTags: string[] | null;

  @ApiProperty({
    enum: ["strict", "prefer", null],
    description: "任务级部署约束；null = 跟随全局 executor.deploymentPolicy",
  })
  deploymentPolicy: "strict" | "prefer" | null;

  @ApiProperty({
    nullable: true,
    format: "uuid",
    description: "固定的执行器 ID（与广播互斥；不回退到执行器集群）",
  })
  executorId: string | null;

  @ApiProperty({
    nullable: true,
    description: "内联 GLUE 脚本源码（管理员可编辑）",
  })
  glueSource: string | null;

  @ApiProperty({
    nullable: true,
    description: "GLUE 语言：python/javascript/shell",
  })
  glueLanguage: string | null;

  @ApiProperty({
    nullable: true,
    type: "array",
    items: {
      type: "object",
      properties: {
        start: { type: "string" },
        end: { type: "string" },
        description: { type: "string" },
      },
      required: ["start", "end"],
    },
    description: "维护窗口：5 字段 cron 的起止时间对，半开区间 [start, end)",
  })
  maintenanceWindows: Array<{
    start: string;
    end: string;
    description?: string;
  }> | null;

  @ApiProperty({
    nullable: true,
    description: "失败时展示的 Markdown 运维手册，同时供告警路由消费",
  })
  runbook: string | null;

  @ApiProperty({
    nullable: true,
    type: "string",
    description:
      "超时后的动作（默认 kill；kill_retry 重新入队一次；notify_only 跳过管理端 kill）",
  })
  timeoutAction: string | null;

  @ApiProperty({
    nullable: true,
    description:
      "超时告警（WARNING）通知阈值，按超时时间的百分比计（0-90，null = 关闭）",
  })
  timeoutWarnRatio: number | null;

  @ApiProperty({
    nullable: true,
    description: "预期持续时间，单位秒（负载评分输入；0/null = 未知）",
  })
  estimatedDurationSec: number | null;

  @ApiProperty()
  createdAt: Date;

  @ApiProperty()
  updatedAt: Date;

  @ApiProperty({
    nullable: true,
    description: "软删除列（所有读取均过滤掉）",
  })
  deletedAt: Date | null;

  @ApiPropertyOptional({
    nullable: true,
    description:
      "R7 实测出现性差异：save() 回程（create/update/pause/resume/rollbackToVersion）会把 select:false 列 hydrated 成 null 带出；findOne/列表等 select 读取不含该键。值恒 null 或掩码形态——明文只在 webhook enable/rotate 的一次性回显",
  })
  webhookSecret?: string | null;
}

/** task_executions 实体的完整响应形态（详情/AI 分析/触发/回滚 execution 载荷）。 */
export class TaskExecutionResponseDto {
  @ApiProperty({ format: "uuid" })
  id: string;

  @ApiProperty({ format: "uuid" })
  taskId: string;

  @ApiProperty({ description: "派发时刻的任务名快照" })
  taskName: string;

  @ApiProperty({ enum: ExecutionStatus })
  status: ExecutionStatus;

  @ApiPropertyOptional({
    nullable: true,
    type: "object",
    additionalProperties: true,
    description: "任务关联——当前读取路径不会加载它",
  })
  task?: unknown;

  @ApiProperty({
    nullable: true,
    description: "该次执行被派发到的执行器地址",
  })
  executorAddress: string | null;

  /**
   * ADR-017 阶段 3：派发到的那台执行器行的 `executors.id`（行身份）。
   *
   * 为什么必须随 `executorAddress` 一起暴露：阶段 3 起 pull 执行器**允许同地址
   * 多行并存**（两个内网各有一台 `192.168.1.100:8002`），`executorAddress` 不再
   * 唯一指代一行——前端只靠地址解析执行器名会在撞址时显示成别人的机器。
   *
   * 名字解析**刻意留在前端**（admin-web 的 useExecutorNames，id 优先/地址兜底）：
   * 两个最热的列表端点走 PERF-03 读投影，服务端 join 名称会把该纪律作废，且会
   * 与前端既有钩子形成两个可能漂移的事实源。故读面只多暴露这一列 uuid。
   */
  @ApiProperty({ nullable: true, format: "uuid" })
  executorId: string | null;

  @ApiProperty({
    nullable: true,
    description: "累积的日志文本（仅单次执行读取返回——列表读取排除该列）",
  })
  logs: string | null;

  @ApiProperty({
    nullable: true,
    description: "日志后端的标记：'db' 或对象存储",
  })
  logStorage: string | null;

  @ApiProperty({
    nullable: true,
    description: "日志存放于 S3 兼容对象存储（默认 RustFS）时的对象键",
  })
  logObjectKey: string | null;

  @ApiProperty({
    nullable: true,
    additionalProperties: true,
    description: "任务返回的结构化结果载荷",
  })
  result: Record<string, unknown> | null;

  @ApiProperty({
    nullable: true,
    additionalProperties: true,
    description: "实际派发出去的合并后运行参数",
  })
  params: Record<string, unknown> | null;

  @ApiProperty({
    nullable: true,
    description: "首次派发/到达执行器的时间",
  })
  startTime: Date | null;

  @ApiProperty({ nullable: true })
  endTime: Date | null;

  @ApiProperty({
    nullable: true,
    description: "挂钟耗时毫秒数（endTime - startTime）",
  })
  duration: number | null;

  @ApiProperty({ description: "截至目前已消耗的重试次数" })
  retryCount: number;

  @ApiProperty({ nullable: true })
  errorMessage: string | null;

  @ApiProperty({
    enum: [Object.values(ExecutionFailureReason), null],
    description: "归类后的失败标记（执行器可上报的子集 + 管理端内部标记）",
  })
  failureReason: ExecutionFailureReason | null;

  @ApiProperty({
    nullable: true,
    description: "进程退出码（执行器能给出时才有）",
  })
  exitCode: number | null;

  @ApiProperty({
    nullable: true,
    description: "AI 失败分析文本（空字符串 = 无分析）",
  })
  aiAnalysis: string | null;

  @ApiProperty({
    nullable: true,
    type: "array",
    items: {
      type: "object",
      properties: {
        name: { type: "string" },
        size: { type: "number" },
        sha256: { type: "string" },
      },
      required: ["name", "size", "sha256"],
    },
    description: "该次执行上传的产物",
  })
  artifacts: Array<{ name: string; size: number; sha256: string }> | null;

  @ApiProperty({
    nullable: true,
    description: "manual/cron/webhook/api/dependency——本次运行的触发方式",
  })
  triggerType: string | null;

  @ApiProperty({
    nullable: true,
    description: "本次运行重放所固定的配置快照版本",
  })
  taskVersion: string | null;

  @ApiProperty({
    nullable: true,
    description: "随派发链路传递的 W3C trace-id",
  })
  traceId: string | null;

  @ApiProperty({
    nullable: true,
    description: "打包类运行解析出的包 URL",
  })
  resolvedPackageUrl: string | null;

  @ApiProperty({
    nullable: true,
    description: "打包类运行解析出的包版本",
  })
  resolvedPackageVersion: string | null;

  @ApiProperty()
  createdAt: Date;

  @ApiProperty({
    nullable: true,
    description: "依赖门禁触发本次执行的时间",
  })
  depsFiredAt: Date | null;

  @ApiProperty({
    nullable: true,
    format: "uuid",
    description: "该执行排队/运行所属的互斥组",
  })
  mutexGroupId: string | null;

  @ApiProperty({ description: "乐观锁版本列" })
  version: number;
}

/**
 * 执行列表行 = 实体去掉两个重型 text 列（logs/aiAnalysis，PERF-03 读投影
 * EXECUTION_LIST_EXCLUDED_COLUMNS）。result 保留：列表端点会返回它；统计端点
 * 的 recentExecutions 在列表投影上再挖掉 result（FIX-5.2）——该变体在此如实
 * 标注为可空，两种读面共用本类。
 */
export class ExecutionListItemDto extends TaskExecutionResponseDto {
  @ApiPropertyOptional({
    nullable: true,
    additionalProperties: true,
    description: "列表读取会返回该列；统计端点的 recentExecutions 完全不含该列",
  })
  result: Record<string, unknown> | null;

  @ApiPropertyOptional({
    nullable: true,
    description: "列表/统计读取会排除该列（PERF-03）——请改用日志端点获取",
  })
  logs: string | null;

  @ApiPropertyOptional({
    nullable: true,
    description: "列表/统计读取会排除该列（PERF-03）",
  })
  aiAnalysis: string | null;
}

/** task_versions 行（快照回滚的历史版本）。 */
export class TaskVersionDto {
  @ApiProperty({ format: "uuid" })
  id: string;

  @ApiProperty({ format: "uuid" })
  taskId: string;

  @ApiProperty({ description: "可读标签，形如 'v3'" })
  version: string;

  @ApiProperty({ nullable: true })
  gitCommit: string | null;

  @ApiProperty({
    additionalProperties: true,
    description: "完整任务配置快照（供 rollbackToVersion 消费）",
  })
  snapshot: Record<string, unknown>;

  @ApiProperty({ nullable: true })
  createdBy: string | null;

  @ApiProperty({ nullable: true })
  description: string | null;

  @ApiProperty()
  createdAt: Date;
}

/** 分页信封：list/items 双键并存（R-21，CLI 读 list、web 读 items）。 */
export class PaginatedTaskListDto {
  @ApiProperty({ type: [TaskResponseDto] })
  list: TaskResponseDto[];

  @ApiProperty({ type: [TaskResponseDto] })
  items: TaskResponseDto[];

  @ApiProperty()
  total: number;

  @ApiProperty()
  page: number;

  @ApiProperty()
  pageSize: number;

  @ApiProperty()
  totalPages: number;

  /**
   * 仅当请求带 `cursor` 时出现（keyset 分支）：`null` = 已到末页。
   *
   * PLAN-BACKEND-ARCHITECTURE §2.1 的**加性**扩展——既有 6 个字段的类型与名字
   * 一个都没动（四端消费：admin-web / acf-cli / mcp-server / 执行器机器面）。
   *
   * 出现条件与 `PaginatedExecutionListDto#nextCursor` 逐字相同：
   *   · 不带 `cursor` → OFFSET 分支，该键**根本不出现**（旧路径逐字节不变）；
   *   · 带 `cursor` → keyset 分支，该键必然出现（字符串 = 下一页；null = 末页）。
   *
   * 之所以是 `@ApiPropertyOptional` 而不是 `@ApiProperty({ nullable: true })`：
   * 契约必须能表达"**键可能不存在**"，否则与 OFFSET 分支的真实响应不符——而
   * OFFSET 分支正是当前四端唯一在用的路径。
   */
  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description:
      "keyset 分页的下一页游标；null = 已到末页。仅当请求带 cursor 参数时出现（此时走 keyset 分支）；不带 cursor 的请求走 OFFSET 分支，响应中不含该键。游标与默认排序（createdAt DESC, id DESC）绑定：与 sortBy 或 lastStatus 同时给出会返回 400。",
  })
  nextCursor?: string | null;
}

/**
 * 执行列表信封：`GET /tasks/:id/executions` 与 `GET /tasks/executions/all`
 * 共用（载荷同为执行行）。
 *
 * PLAN-BACKEND-ARCHITECTURE §2.1（游标分页·加性过渡）：本类**只新增**了可选的
 * `nextCursor`，既有 6 个字段的类型与名字一个都没动——它们被四端消费
 * （admin-web / acf-cli / mcp-server / 执行器机器面）。
 *
 * `nextCursor` 的**出现条件**（重要，别按"恒下发"理解）：
 *   · 请求不带 `cursor` → 走 OFFSET 分支，该键**根本不出现**（响应与引入游标
 *     之前逐字节一致）。故 `required` 里**没有**它。
 *   · 请求带 `cursor` → 走 keyset 分支，该键必然出现：字符串 = 下一页游标，
 *     `null` = 已到末页。调用方据"键是否存在"即可判断服务端是否在 keyset 模式，
 *     据"是否为 null"判断是否翻完。
 *
 * 注意 `total`：keyset 分支下**仍然是真实总数**（复用同条件的 COUNT，见
 * task.service 里 `getExecutionsByKeyset` / `getAllExecutionsByKeyset` 的注释），
 * 不返回 -1/近似值——`total` 的类型断言不能撒谎，否则所有按 `total` 渲染
 * "共 N 条"的四端都会显示错值。
 */
export class PaginatedExecutionListDto {
  @ApiProperty({ type: [ExecutionListItemDto] })
  list: ExecutionListItemDto[];

  @ApiProperty({ type: [ExecutionListItemDto] })
  items: ExecutionListItemDto[];

  @ApiProperty()
  total: number;

  @ApiProperty()
  page: number;

  @ApiProperty()
  pageSize: number;

  @ApiProperty()
  totalPages: number;

  /**
   * 仅当请求带 `cursor` 时出现（keyset 分支）：`null` = 已到末页。
   *
   * 之所以是 `@ApiPropertyOptional` 而不是 `@ApiProperty({ nullable: true })`：
   * 它必须能在 OpenAPI 里表达"**键可能不存在**"。若声明成必填，契约会与 OFFSET
   * 分支的真实响应（无此键）不符——而 OFFSET 分支是当前四端唯一在用的路径。
   */
  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description:
      "keyset 分页的下一页游标；null = 已到末页。仅当请求带 cursor 参数时出现（此时走 keyset 分支）；不带 cursor 的请求走 OFFSET 分支，响应中不含该键。",
  })
  nextCursor?: string | null;
}

/** GET /tasks/executions/:execId/logs 行分页读面（无 envelope 之下的 data）。 */
export class ExecutionLogsPageResponseDto {
  @ApiProperty({
    type: [String],
    description: "从 fromLine 起的原始日志行（给定级别过滤时生效）",
  })
  lines: string[];

  @ApiProperty({ description: "（过滤后）行集合的真实总数" })
  totalLines: number;

  @ApiProperty({
    description: "fromLine + lines.length < totalLines 时为 true",
  })
  hasMore: boolean;
}

/** GET /tasks/:id/executions/:execId/report（OBS-04 一次性三合一载荷）。 */
export class ExecutionTimelineEntryDto {
  @ApiProperty({ enum: ["created", "started", "finished"] })
  phase: "created" | "started" | "finished";

  @ApiProperty({
    nullable: true,
    description: "ISO 时间戳，该阶段从未发生时为 null",
  })
  at: string | null;

  @ApiPropertyOptional({ description: "例如 'trigger=manual'" })
  detail?: string;
}

/** execution_reports 当日聚合行（与单次执行仅按日期粗粒度关联）。 */
export class ExecutionReportSummaryDto {
  @ApiProperty()
  id: number;

  @ApiProperty({ description: "DATE 列——该聚合行所属的日期" })
  triggerDay: Date;

  @ApiProperty()
  runningCount: number;

  @ApiProperty()
  successCount: number;

  @ApiProperty()
  failCount: number;

  @ApiProperty()
  timeoutCount: number;

  @ApiProperty()
  cancelledCount: number;

  @ApiProperty()
  avgDurationMs: number;

  @ApiProperty()
  maxDurationMs: number;

  @ApiProperty()
  minDurationMs: number;

  @ApiProperty()
  updateTime: Date;

  @ApiProperty()
  createdAt: Date;
}

export class ExecutionReportResponseDto {
  @ApiProperty({ type: TaskExecutionResponseDto })
  execution: TaskExecutionResponseDto;

  @ApiProperty({ type: [ExecutionTimelineEntryDto] })
  timeline: ExecutionTimelineEntryDto[];

  @ApiProperty({
    nullable: true,
    type: ExecutionReportSummaryDto,
    description: "当日聚合行；不存在时为 null（正常状态，前端自行降级）",
  })
  report: ExecutionReportSummaryDto | null;
}

/** GET /tasks/:id/stats（FIX-5.1：successRate/succeeded/failed 为全量口径）。 */
export class ExecutionStatsResponseDto {
  @ApiProperty({
    type: [ExecutionListItemDto],
    description: "最近 20 次执行（列表投影去掉 result）",
  })
  recentExecutions: ExecutionListItemDto[];

  @ApiProperty({ description: "最近 20 次窗口内的成功百分比（仅供参考）" })
  recentSuccessRate: number;

  @ApiProperty({
    description: "全部运行的成功百分比（自 FIX-5.1 起为权威口径）",
  })
  successRate: number;

  @ApiProperty({ description: "历史累计 SUCCESS 次数" })
  succeeded: number;

  @ApiProperty({
    description: "历史累计 FAILED + TIMEOUT 次数（被 kill/取消的不计入）",
  })
  failed: number;

  @ApiProperty({ description: "最近窗口内的平均耗时毫秒数（无数据时为 0）" })
  avgDuration: number;

  @ApiProperty()
  totalRuns: number;
}

/** GET /tasks/scheduler/stats。 */
export class SchedulerStatsResponseDto {
  @ApiProperty()
  healthy: boolean;

  @ApiProperty({ description: "LeaderGate：仅 leader 负责调度" })
  isLeader: boolean;

  @ApiProperty()
  activeTimers: number;

  @ApiProperty()
  activeCronTasks: number;

  @ApiProperty()
  runningTaskCount: number;

  @ApiProperty()
  totalScheduledTasks: number;

  @ApiProperty({ description: "process.uptime() 秒数" })
  uptime: number;
}

/** POST /tasks/:id/suggest-schedule（AI 建议可能走降级文案，fallback=true）。 */
export class SuggestScheduleResponseDto {
  @ApiProperty({ format: "uuid" })
  taskId: string;

  @ApiProperty({ nullable: true })
  currentCron: string | null;

  @ApiProperty({ description: "推荐的 5 字段 cron 表达式" })
  suggestedCron: string;

  @ApiProperty()
  reasoning: string;

  @ApiPropertyOptional({
    description: "LLM 路径失败、已返回启发式建议时为 true",
  })
  fallback?: boolean;
}

/** 批量端点单个失败项（.catch 吞错形态；成功项是完整实体——见各端点 anyOf）。 */
export class BatchErrorItemDto {
  @ApiProperty({ description: "请求中指定的任务 ID" })
  id: string;

  @ApiProperty({ description: "err.message——部分失败的标记" })
  error: string;
}

/** DELETE /tasks/:id（软删语义）。 */
export class DeleteTaskResponseDto {
  @ApiProperty()
  deleted: boolean;
}

/** POST /tasks/:id/executions/:execId/kill。 */
export class KillExecutionResponseDto {
  @ApiProperty()
  success: boolean;

  @ApiProperty()
  message: string;
}

/** POST /tasks/:id/rollback（gitCommit 代码回滚）。 */
export class GitRollbackResponseDto {
  @ApiProperty({ type: TaskExecutionResponseDto })
  execution: TaskExecutionResponseDto;

  @ApiProperty({
    nullable: true,
    description: "回滚前仓库所在的提交",
  })
  rolledBackFrom: string | null;

  @ApiProperty({ description: "回滚到的提交" })
  rolledBackTo: string;
}

/** GET /tasks/:id/webhook —— secret 永不回传。 */
export class WebhookStatusResponseDto {
  @ApiProperty()
  enabled: boolean;

  @ApiProperty({ description: "带签名的入站触发 URL" })
  url: string;
}

/** POST /tasks/:id/webhook/{enable,rotate} —— 明文 secret 一次性回显。 */
export class WebhookSecretResponseDto {
  @ApiProperty()
  url: string;

  @ApiProperty({ description: "明文密钥仅回显一次；需要重发时用 rotate" })
  secret: string;
}

/** POST /tasks/:id/webhook/disable。 */
export class WebhookDisableResponseDto {
  @ApiProperty()
  enabled: boolean;
}

/** GET /tasks/:id/versions/:v1/compare/:v2 的逐键差分项。 */
export class VersionDiffEntryDto {
  @ApiProperty({ description: "version1 中的值（任意 JSON）" })
  old: unknown;

  @ApiProperty({ description: "version2 中的值（任意 JSON）" })
  new: unknown;
}

/**
 * 版本差分响应：Record<field, {old,new}>——openapi 用 additionalProperties
 * 表达动态键，$ref 指向 VersionDiffEntryDto。
 */
export const VersionDiffResponseSchema = {
  type: "object" as const,
  additionalProperties: { $ref: getSchemaPath(VersionDiffEntryDto) },
};

/** 批量端点数组载荷的 anyOf 项（成功实体 | {id,error}）。 */
export const batchArrayOf = (successDto: unknown) => ({
  type: "array" as const,
  items: {
    oneOf: [
      { $ref: getSchemaPath(successDto as never) },
      { $ref: getSchemaPath(BatchErrorItemDto) },
    ],
  },
});
