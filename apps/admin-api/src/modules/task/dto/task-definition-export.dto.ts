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
  @ApiProperty({
    example: "Nightly DB sync",
    description: "任务名称",
  })
  name!: string;
  @ApiPropertyOptional() description?: string;
  @ApiProperty({ enum: TaskTriggerType })
  triggerType!: TaskTriggerType;
  @ApiPropertyOptional({
    description: "5 字段 cron 表达式（triggerType=cron 时生效）",
  })
  cronExpression?: string;
  @ApiPropertyOptional({ description: "IANA 时区，例如 Asia/Shanghai" })
  timezone?: string;
  @ApiPropertyOptional({ description: "固定频率间隔秒数" })
  fixedRate?: number;
  @ApiPropertyOptional({ enum: TaskRuntime })
  runtime?: TaskRuntime;
  @ApiPropertyOptional({
    description: '解释器版本 \\"major.minor\\"（python runtime）',
  })
  runtimeVersion?: string;
  @ApiPropertyOptional({
    type: [String],
    description: "执行器端依赖声明（pip/npm）",
  })
  requirements?: string[];
  @ApiPropertyOptional({
    type: "object",
    additionalProperties: { type: "string" },
    description: "上游任务依赖映射：{ 显示名: 上游任务id }",
  })
  dependencies?: Record<string, string>;
  @ApiPropertyOptional() entrypoint?: string;
  @ApiPropertyOptional() gitRepo?: string;
  @ApiPropertyOptional() gitBranch?: string;
  @ApiPropertyOptional() gitCommit?: string;
  @ApiPropertyOptional() currentVersion?: string;
  @ApiPropertyOptional({ description: "超时秒数（0 = 不限制）" })
  timeout?: number;
  @ApiPropertyOptional({
    description: "超时动作：kill / kill_retry / notify_only",
  })
  timeoutAction?: string;
  @ApiPropertyOptional({ description: "超时预警比例 0-90" })
  timeoutWarnRatio?: number;
  @ApiPropertyOptional({ description: "预估执行时长（秒）" })
  estimatedDurationSec?: number;
  @ApiPropertyOptional() maxRetry?: number;
  @ApiPropertyOptional() retryDelay?: number;
  @ApiPropertyOptional({
    type: [String],
    description: "可重试错误白名单",
  })
  retryableErrors?: string[];
  @ApiPropertyOptional({ description: "优先级：low/normal/high/critical" })
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
    type: "object",
    additionalProperties: true,
    description: "任务默认参数",
  })
  params?: Record<string, unknown>;
  @ApiPropertyOptional({
    enum: ["strict", "prefer"],
    nullable: true,
    description: "部署派发策略覆盖",
  })
  deploymentPolicy?: "strict" | "prefer" | null;
  @ApiPropertyOptional({ description: "钉定的执行器 id" })
  executorId?: string;
  @ApiPropertyOptional() executorAppName?: string;
  @ApiPropertyOptional() executorGroup?: string;
  @ApiPropertyOptional({ type: [String] }) executorTags?: string[];
  @ApiPropertyOptional({ type: [String] }) executorAffinityTags?: string[];
  @ApiPropertyOptional({ type: [String] }) executorAntiAffinityTags?: string[];
  @ApiPropertyOptional({ description: "GLUE 脚本源码" })
  glueSource?: string;
  @ApiPropertyOptional() glueLanguage?: string;
  @ApiPropertyOptional({ description: "绑定的应用 id" })
  applicationId?: string;
  @ApiPropertyOptional({ enum: TaskCodeSource })
  codeSource?: TaskCodeSource;
  @ApiPropertyOptional({
    type: [MaintenanceWindowDto],
    nullable: true,
    description: "任务级维护窗口",
  })
  maintenanceWindows?: MaintenanceWindowDto[];
  @ApiPropertyOptional({ description: "Markdown 运维手册" })
  runbook?: string;
  @ApiPropertyOptional({ description: "所属项目 id" })
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
    example: "1",
    description: "导出 schema 版本（当前为 1）",
  })
  schemaVersion!: string;
  @ApiProperty({
    type: String,
    format: "date-time",
    description: "导出生成时刻的 ISO-8601 时间戳",
  })
  exportedAt!: string;
  @ApiProperty({
    type: TaskDefinitionDto,
    description:
      "任务定义快照键。**绝不包含** secrets（SEC-02 红线：整键剔除，值与键名一律剔除）。",
  })
  task!: TaskDefinitionDto;
}
