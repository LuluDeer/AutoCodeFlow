import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import {
  BlockStrategy,
  ExecuteMode,
  MisfireStrategy,
  TaskCodeSource,
  TaskRuntime,
  TaskTriggerType,
} from "../entities/task.entity";
import { MaintenanceWindowDto } from "./maintenance-window.dto";

/**
 * E-1（任务定义导入/导出）：导出响应体的 OpenAPI 契约形状。
 *
 * 本类**只做 schema 文档**（导出响应 /tasks/:id/export 与导入请求体共用
 * 形状），不做运行时校验——导入面的校验复用 CreateTaskDto 全量写校验
 * （见 ImportTaskDto），导出物本身由 task-definition.util.ts 白名单装配。
 *
 * 红线：本类**刻意没有 secrets / webhookSecret / id / status 属性**——
 * 它们不是任务定义，且 secrets 是 SEC-02 绝不外传面（值与键名 alike，
 * 整键剔除）。
 */
export class TaskDefinitionDto {
  @ApiProperty({ description: "Task name", example: "Nightly DB sync" })
  name!: string;
  @ApiPropertyOptional() description?: string;
  @ApiProperty({ enum: TaskTriggerType })
  triggerType!: TaskTriggerType;
  @ApiPropertyOptional({ description: "5-field cron (triggerType=cron)" })
  cronExpression?: string;
  @ApiPropertyOptional({ description: "IANA timezone, e.g. Asia/Shanghai" })
  timezone?: string;
  @ApiPropertyOptional({ description: "Fixed-rate interval seconds" })
  fixedRate?: number;
  @ApiPropertyOptional({ enum: TaskRuntime })
  runtime?: TaskRuntime;
  @ApiPropertyOptional({
    description: 'Interpreter version "major.minor" (python runtime)',
  })
  runtimeVersion?: string;
  @ApiPropertyOptional({
    description: "Executor-side dependency specs (pip/npm)",
    type: [String],
  })
  requirements?: string[];
  @ApiPropertyOptional({
    description:
      "Upstream task dependency map: { displayName: upstreamTaskId }",
    type: "object",
    additionalProperties: { type: "string" },
  })
  dependencies?: Record<string, string>;
  @ApiPropertyOptional() entrypoint?: string;
  @ApiPropertyOptional() gitRepo?: string;
  @ApiPropertyOptional() gitBranch?: string;
  @ApiPropertyOptional() gitCommit?: string;
  @ApiPropertyOptional() currentVersion?: string;
  @ApiPropertyOptional({ description: "Timeout seconds (0 = no limit)" })
  timeout?: number;
  @ApiPropertyOptional({
    description: "Timeout action: kill / kill_retry / notify_only",
  })
  timeoutAction?: string;
  @ApiPropertyOptional({ description: "Timeout warning ratio 0-90" })
  timeoutWarnRatio?: number;
  @ApiPropertyOptional({ description: "Estimated duration seconds" })
  estimatedDurationSec?: number;
  @ApiPropertyOptional() maxRetry?: number;
  @ApiPropertyOptional() retryDelay?: number;
  @ApiPropertyOptional({
    description: "Retryable error whitelist",
    type: [String],
  })
  retryableErrors?: string[];
  @ApiPropertyOptional({ description: "low/normal/high/critical" })
  priority?: number | string;
  @ApiPropertyOptional({ enum: ExecuteMode })
  executeMode?: ExecuteMode;
  @ApiPropertyOptional({ enum: BlockStrategy })
  blockStrategy?: BlockStrategy;
  @ApiPropertyOptional({ enum: MisfireStrategy })
  misfireStrategy?: MisfireStrategy;
  @ApiPropertyOptional() alarmEmail?: string;
  @ApiPropertyOptional({ type: [String] }) alarmChannels?: string[];
  @ApiPropertyOptional({
    description: "Default task params",
    type: "object",
    additionalProperties: true,
  })
  params?: Record<string, unknown>;
  @ApiPropertyOptional({
    description: "Deployment dispatch policy override",
    enum: ["strict", "prefer"],
    nullable: true,
  })
  deploymentPolicy?: "strict" | "prefer" | null;
  @ApiPropertyOptional({ description: "Pinned executor id" })
  executorId?: string;
  @ApiPropertyOptional() executorAppName?: string;
  @ApiPropertyOptional() executorGroup?: string;
  @ApiPropertyOptional({ type: [String] }) executorTags?: string[];
  @ApiPropertyOptional({ type: [String] }) executorAffinityTags?: string[];
  @ApiPropertyOptional({ type: [String] }) executorAntiAffinityTags?: string[];
  @ApiPropertyOptional({ description: "GLUE script source" })
  glueSource?: string;
  @ApiPropertyOptional() glueLanguage?: string;
  @ApiPropertyOptional({ description: "Bound application id" })
  applicationId?: string;
  @ApiPropertyOptional({ enum: TaskCodeSource })
  codeSource?: TaskCodeSource;
  @ApiPropertyOptional({
    description: "Task-level maintenance windows",
    type: [MaintenanceWindowDto],
    nullable: true,
  })
  maintenanceWindows?: MaintenanceWindowDto[];
  @ApiPropertyOptional({ description: "Markdown runbook" })
  runbook?: string;
  @ApiPropertyOptional({ description: "Owning project id" })
  projectId?: string;
}

/**
 * GET /tasks/:id/export 的响应体 = POST /tasks/import 的请求体（E-1 对称）。
 * schemaVersion 钉在 "1"；task 为定义快照键（**永远不含 secrets**——SEC-02
 * 红线，导出整键剔除、导入即使携带也被忽略并在 warnings 提示重配）。
 */
export class TaskExportPayloadDto {
  @ApiProperty({
    enum: ["1"],
    description: "Export schema version (currently 1)",
    example: "1",
  })
  schemaVersion!: string;
  @ApiProperty({
    type: String,
    format: "date-time",
    description: "ISO-8601 timestamp when the export was produced",
  })
  exportedAt!: string;
  @ApiProperty({
    type: TaskDefinitionDto,
    description:
      "Task definition snapshot keys. Secrets are NEVER included (SEC-02 red line: the whole key is stripped, values and key alike).",
  })
  task!: TaskDefinitionDto;
}
