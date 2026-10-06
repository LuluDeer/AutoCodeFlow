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

  @ApiProperty({ description: "Task name (globally unique)" })
  name: string;

  @ApiProperty({ description: "Task description", nullable: true })
  description: string | null;

  @ApiProperty({
    enum: TaskStatus,
    description: "deleted rows are never returned (soft-delete)",
  })
  status: TaskStatus;

  @ApiProperty({ enum: TaskTriggerType })
  triggerType: TaskTriggerType;

  @ApiProperty({
    description: "5-field cron expression (cron tasks)",
    nullable: true,
  })
  cronExpression: string | null;

  @ApiProperty({
    description: "IANA timezone for cron evaluation",
    nullable: true,
  })
  timezone: string | null;

  @ApiProperty({
    description: "Fixed-rate interval in ms (fixed_rate tasks)",
    nullable: true,
  })
  fixedRate: number | null;

  @ApiProperty({ enum: TaskRuntime })
  runtime: TaskRuntime;

  @ApiProperty({
    description: "Declared interpreter version (multiversion WS1)",
    nullable: true,
  })
  runtimeVersion: string | null;

  @ApiProperty({
    description:
      "Dependency specs installed by the executor before running (packaged tasks)",
    nullable: true,
    additionalProperties: { type: "string" },
  })
  dependencies: Record<string, string> | null;

  @ApiProperty({ description: "Entry file inside the package", nullable: true })
  entrypoint: string | null;

  @ApiProperty({
    description: "Python/node dependency list (uv pip install / npm install)",
    nullable: true,
    type: [String],
  })
  requirements: string[] | null;

  @ApiProperty({
    description: "Git repo URL (git-source tasks)",
    nullable: true,
  })
  gitRepo: string | null;

  @ApiProperty({ nullable: true })
  gitBranch: string | null;

  @ApiProperty({ description: "Currently checked-out commit", nullable: true })
  gitCommit: string | null;

  @ApiProperty({
    description: "Latest config-snapshot version label",
    nullable: true,
  })
  currentVersion: string | null;

  @ApiProperty({ description: "Execution timeout in seconds (0 = unlimited)" })
  timeout: number;

  @ApiProperty({ description: "Retry budget for failed dispatch/execution" })
  maxRetry: number;

  @ApiProperty({ description: "Delay between retries in seconds" })
  retryDelay: number;

  @ApiProperty({
    description:
      "Case-insensitive substrings of failure eligible for retry; null/empty = retry every failure",
    nullable: true,
    type: [String],
  })
  retryableErrors: string[] | null;

  @ApiProperty({ enum: BlockStrategy })
  blockStrategy: BlockStrategy;

  @ApiProperty({ enum: MisfireStrategy })
  misfireStrategy: MisfireStrategy;

  @ApiProperty({
    description:
      "Stored (and returned) as the PG enum label; numeric input is normalized on write",
    enum: ["low", "normal", "high", "critical"],
  })
  priority: "low" | "normal" | "high" | "critical";

  @ApiProperty({ enum: ExecuteMode })
  executeMode: ExecuteMode;

  @ApiProperty({
    description: "Last time the scheduler enqueued this task",
    nullable: true,
  })
  lastTriggerTime: Date | null;

  @ApiProperty({ nullable: true })
  alarmEmail: string | null;

  @ApiProperty({
    description: "Alarm channel names for failure/timeout alerts",
    nullable: true,
    type: [String],
  })
  alarmChannels: string[] | null;

  @ApiProperty({
    description:
      "Default run parameters (plain runtime params, no credentials)",
    nullable: true,
    additionalProperties: true,
  })
  params: Record<string, unknown> | null;

  @ApiProperty({
    description: "Pin to an executor app by name",
    nullable: true,
  })
  executorAppName: string | null;

  @ApiProperty({
    description: "Application (zip package) this task runs from",
    nullable: true,
    format: "uuid",
  })
  applicationId: string | null;

  @ApiProperty({
    description:
      "Explicit code-source channel (null = legacy row, union semantics apply on read)",
    enum: [...Object.values(TaskCodeSource), null],
  })
  codeSource: TaskCodeSource | null;

  @ApiProperty({
    description: "Owning project (null = unassigned/default-project view)",
    nullable: true,
    format: "uuid",
  })
  projectId: string | null;

  @ApiPropertyOptional({
    description:
      "Project relation — NOT loaded by current read paths (plain repo reads never join it)",
    nullable: true,
    type: "object",
    properties: {
      id: { type: "string", format: "uuid" },
      name: { type: "string" },
    },
  })
  project?: { id: string; name: string } | null;

  @ApiProperty({
    description:
      "Creator user id (null = unowned legacy row; guards treat as admin-only)",
    nullable: true,
  })
  ownerUserId: number | null;

  @ApiProperty({
    description:
      "Task secrets, ALWAYS masked: leaf values are '******' (SEC-02); plaintext never leaves the server",
    nullable: true,
    additionalProperties: { type: "string" },
  })
  secrets: Record<string, string> | null;

  @ApiProperty({
    description: "Executor group filter (AND with tags)",
    nullable: true,
  })
  executorGroup: string | null;

  @ApiProperty({
    description: "Required executor tags (AND subset semantics)",
    nullable: true,
    type: [String],
  })
  executorTags: string[] | null;

  @ApiProperty({
    description:
      "Affinity tags — ANY match keeps the executor in candidates (OR)",
    nullable: true,
    type: [String],
  })
  executorAffinityTags: string[] | null;

  @ApiProperty({
    description: "Anti-affinity tags — ANY match excludes the executor",
    nullable: true,
    type: [String],
  })
  executorAntiAffinityTags: string[] | null;

  @ApiProperty({
    description:
      "Task-level deployment constraint; null = follow global executor.deploymentPolicy",
    enum: ["strict", "prefer", null],
  })
  deploymentPolicy: "strict" | "prefer" | null;

  @ApiProperty({
    description:
      "Pinned executor id (exclusive with broadcast; no fallback to fleet)",
    nullable: true,
    format: "uuid",
  })
  executorId: string | null;

  @ApiProperty({
    description: "Inline GLUE script source (admin-editable)",
    nullable: true,
  })
  glueSource: string | null;

  @ApiProperty({
    description: "GLUE language: python/javascript/shell",
    nullable: true,
  })
  glueLanguage: string | null;

  @ApiProperty({
    description:
      "Maintenance windows: 5-field cron start/end pairs, half-open [start, end)",
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
  })
  maintenanceWindows: Array<{
    start: string;
    end: string;
    description?: string;
  }> | null;

  @ApiProperty({
    description:
      "Markdown runbook shown on failure + consumed by alert routing",
    nullable: true,
  })
  runbook: string | null;

  @ApiProperty({
    description:
      "Post-timeout action (kill default; kill_retry re-enqueues once; notify_only skips admin-side kill)",
    nullable: true,
    type: "string",
  })
  timeoutAction: string | null;

  @ApiProperty({
    description:
      "Timeout WARNING notification threshold as % of timeout (0-90, null = off)",
    nullable: true,
  })
  timeoutWarnRatio: number | null;

  @ApiProperty({
    description:
      "Expected duration in seconds (load-score input; 0/null = unknown)",
    nullable: true,
  })
  estimatedDurationSec: number | null;

  @ApiProperty()
  createdAt: Date;

  @ApiProperty()
  updatedAt: Date;

  @ApiProperty({
    description: "Soft-delete column (filtered out of all reads)",
    nullable: true,
  })
  deletedAt: Date | null;
}

/** task_executions 实体的完整响应形态（详情/AI 分析/触发/回滚 execution 载荷）。 */
export class TaskExecutionResponseDto {
  @ApiProperty({ format: "uuid" })
  id: string;

  @ApiProperty({ format: "uuid" })
  taskId: string;

  @ApiProperty({ description: "Task name snapshot at dispatch time" })
  taskName: string;

  @ApiProperty({ enum: ExecutionStatus })
  status: ExecutionStatus;

  @ApiPropertyOptional({
    description: "Task relation — NOT loaded by current read paths",
    nullable: true,
    type: "object",
    additionalProperties: true,
  })
  task?: unknown;

  @ApiProperty({
    description: "Executor address the execution was dispatched to",
    nullable: true,
  })
  executorAddress: string | null;

  @ApiProperty({
    description:
      "Accumulated log text (single-execution reads only — list reads exclude it)",
    nullable: true,
  })
  logs: string | null;

  @ApiProperty({
    description: "'db' or object-store marker for the log backend",
    nullable: true,
  })
  logStorage: string | null;

  @ApiProperty({
    description: "Object key when logs live in S3/MinIO",
    nullable: true,
  })
  logObjectKey: string | null;

  @ApiProperty({
    description: "Structured result payload returned by the task",
    nullable: true,
    additionalProperties: true,
  })
  result: Record<string, unknown> | null;

  @ApiProperty({
    description: "Merged run parameters actually dispatched",
    nullable: true,
    additionalProperties: true,
  })
  params: Record<string, unknown> | null;

  @ApiProperty({
    description: "First dispatch/arrival on the executor",
    nullable: true,
  })
  startTime: Date | null;

  @ApiProperty({ nullable: true })
  endTime: Date | null;

  @ApiProperty({
    description: "wall-clock ms (endTime - startTime)",
    nullable: true,
  })
  duration: number | null;

  @ApiProperty({ description: "Retry budget consumed so far" })
  retryCount: number;

  @ApiProperty({ nullable: true })
  errorMessage: string | null;

  @ApiProperty({
    description:
      "Classified failure token (executor-reportable subset + admin-internal tokens)",
    enum: [...Object.values(ExecutionFailureReason), null],
  })
  failureReason: ExecutionFailureReason | null;

  @ApiProperty({
    description: "Process exit code when the executor surfaced one",
    nullable: true,
  })
  exitCode: number | null;

  @ApiProperty({
    description: "AI failure analysis text (empty string = no analysis)",
    nullable: true,
  })
  aiAnalysis: string | null;

  @ApiProperty({
    description: "Artifacts uploaded by the execution",
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
  })
  artifacts: Array<{ name: string; size: number; sha256: string }> | null;

  @ApiProperty({
    description:
      "manual/cron/webhook/api/dependency — how this run was triggered",
    nullable: true,
  })
  triggerType: string | null;

  @ApiProperty({
    description: "Pinned config-snapshot version this run replayed",
    nullable: true,
  })
  taskVersion: string | null;

  @ApiProperty({
    description: "W3C trace-id propagated through dispatch",
    nullable: true,
  })
  traceId: string | null;

  @ApiProperty({
    description: "Resolved package URL for packaged runs",
    nullable: true,
  })
  resolvedPackageUrl: string | null;

  @ApiProperty({
    description: "Resolved package version for packaged runs",
    nullable: true,
  })
  resolvedPackageVersion: string | null;

  @ApiProperty()
  createdAt: Date;

  @ApiProperty({
    description: "When the dependency gate fired this execution",
    nullable: true,
  })
  depsFiredAt: Date | null;

  @ApiProperty({
    description: "Mutex group the execution is queued/running under",
    nullable: true,
    format: "uuid",
  })
  mutexGroupId: string | null;

  @ApiProperty({ description: "Optimistic-lock version column" })
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
    description:
      "List reads return it; stats recentExecutions exclude this column entirely",
    nullable: true,
    additionalProperties: true,
  })
  result: Record<string, unknown> | null;

  @ApiPropertyOptional({
    description:
      "Excluded from list/stats reads (PERF-03) — fetch via the logs endpoints",
    nullable: true,
  })
  logs: string | null;

  @ApiPropertyOptional({
    description: "Excluded from list/stats reads (PERF-03)",
    nullable: true,
  })
  aiAnalysis: string | null;
}

/** task_versions 行（快照回滚的历史版本）。 */
export class TaskVersionDto {
  @ApiProperty({ format: "uuid" })
  id: string;

  @ApiProperty({ format: "uuid" })
  taskId: string;

  @ApiProperty({ description: "Human label like 'v3'" })
  version: string;

  @ApiProperty({ nullable: true })
  gitCommit: string | null;

  @ApiProperty({
    description: "Full task config snapshot (feeds rollbackToVersion)",
    additionalProperties: true,
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
}

/** GET /tasks 与 GET /tasks/:id/executions 共用信封（载荷不同）。 */
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
}

/** GET /tasks/executions/:execId/logs 行分页读面（无 envelope 之下的 data）。 */
export class ExecutionLogsPageResponseDto {
  @ApiProperty({
    type: [String],
    description:
      "Raw log lines from fromLine (level filter applies when given)",
  })
  lines: string[];

  @ApiProperty({ description: "True total count of the (filtered) line set" })
  totalLines: number;

  @ApiProperty({ description: "fromLine + lines.length < totalLines" })
  hasMore: boolean;
}

/** GET /tasks/:id/executions/:execId/report（OBS-04 一次性三合一载荷）。 */
export class ExecutionTimelineEntryDto {
  @ApiProperty({ enum: ["created", "started", "finished"] })
  phase: "created" | "started" | "finished";

  @ApiProperty({
    description: "ISO timestamp, null when the phase never happened",
    nullable: true,
  })
  at: string | null;

  @ApiPropertyOptional({ description: "e.g. 'trigger=manual'" })
  detail?: string;
}

/** execution_reports 当日聚合行（与单次执行仅按日期粗粒度关联）。 */
export class ExecutionReportSummaryDto {
  @ApiProperty()
  id: number;

  @ApiProperty({ description: "DATE column — the aggregate's day" })
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
    description:
      "Same-day aggregate row; null when none exists (normal state, frontend degrades)",
    nullable: true,
    type: ExecutionReportSummaryDto,
  })
  report: ExecutionReportSummaryDto | null;
}

/** GET /tasks/:id/stats（FIX-5.1：successRate/succeeded/failed 为全量口径）。 */
export class ExecutionStatsResponseDto {
  @ApiProperty({
    type: [ExecutionListItemDto],
    description: "Last 20 executions (list projection minus result)",
  })
  recentExecutions: ExecutionListItemDto[];

  @ApiProperty({
    description: "Success % over the last-20 window (reference only)",
  })
  recentSuccessRate: number;

  @ApiProperty({
    description: "Success % over ALL runs (authoritative since FIX-5.1)",
  })
  successRate: number;

  @ApiProperty({ description: "All-time SUCCESS count" })
  succeeded: number;

  @ApiProperty({
    description:
      "All-time FAILED + TIMEOUT count (killed/cancelled not counted)",
  })
  failed: number;

  @ApiProperty({
    description: "Mean duration ms over the recent window (0 when none)",
  })
  avgDuration: number;

  @ApiProperty()
  totalRuns: number;
}

/** GET /tasks/scheduler/stats。 */
export class SchedulerStatsResponseDto {
  @ApiProperty()
  healthy: boolean;

  @ApiProperty({ description: "LeaderGate: only the leader schedules" })
  isLeader: boolean;

  @ApiProperty()
  activeTimers: number;

  @ApiProperty()
  activeCronTasks: number;

  @ApiProperty()
  runningTaskCount: number;

  @ApiProperty()
  totalScheduledTasks: number;

  @ApiProperty({ description: "process.uptime() seconds" })
  uptime: number;
}

/** POST /tasks/:id/suggest-schedule（AI 建议可能走降级文案，fallback=true）。 */
export class SuggestScheduleResponseDto {
  @ApiProperty({ format: "uuid" })
  taskId: string;

  @ApiProperty({ nullable: true })
  currentCron: string | null;

  @ApiProperty({ description: "Recommended 5-field cron expression" })
  suggestedCron: string;

  @ApiProperty()
  reasoning: string;

  @ApiPropertyOptional({
    description:
      "True when the LLM path failed and a heuristic suggestion was returned",
  })
  fallback?: boolean;
}

/** 批量端点单个失败项（.catch 吞错形态；成功项是完整实体——见各端点 anyOf）。 */
export class BatchErrorItemDto {
  @ApiProperty({ description: "The requested task id" })
  id: string;

  @ApiProperty({ description: "err.message — partial-failure marker" })
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
    description: "Commit the repo was on before rollback",
    nullable: true,
  })
  rolledBackFrom: string | null;

  @ApiProperty({ description: "Commit rolled back to" })
  rolledBackTo: string;
}

/** GET /tasks/:id/webhook —— secret 永不回传。 */
export class WebhookStatusResponseDto {
  @ApiProperty()
  enabled: boolean;

  @ApiProperty({ description: "Signed inbound trigger URL" })
  url: string;
}

/** POST /tasks/:id/webhook/{enable,rotate} —— 明文 secret 一次性回显。 */
export class WebhookSecretResponseDto {
  @ApiProperty()
  url: string;

  @ApiProperty({
    description: "Plaintext secret shown ONCE; rotate to re-issue",
  })
  secret: string;
}

/** POST /tasks/:id/webhook/disable。 */
export class WebhookDisableResponseDto {
  @ApiProperty()
  enabled: boolean;
}

/** GET /tasks/:id/versions/:v1/compare/:v2 的逐键差分项。 */
export class VersionDiffEntryDto {
  @ApiProperty({ description: "Value in version1 (any JSON)" })
  old: unknown;

  @ApiProperty({ description: "Value in version2 (any JSON)" })
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
