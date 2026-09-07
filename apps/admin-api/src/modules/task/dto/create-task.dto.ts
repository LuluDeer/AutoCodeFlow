import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsEnum,
  IsInt,
  IsEmail,
  IsObject,
  Min,
  Max,
  IsArray,
  ArrayMaxSize,
  IsUUID,
  Matches,
  ValidateNested,
  IsIn,
} from "class-validator";
import { Type } from "class-transformer";
import { MaintenanceWindowDto } from "./maintenance-window.dto";
import {
  TaskStatus,
  TaskTriggerType,
  TaskRuntime,
  BlockStrategy,
  MisfireStrategy,
  TaskPriority,
  ExecuteMode,
} from "../entities/task.entity";
import { TIMEOUT_ACTIONS, TimeoutAction } from "../timeout-policy.util";

export class CreateTaskDto {
  // R6: id 是 UUID 主键——客户端自带任意字符串会在插入时触发 PG 22P02/23505
  // 类 500，校验必须在 DTO 边界完成（非法 id → 400）。
  @ApiPropertyOptional() @IsUUID("4") @IsOptional() id?: string;
  @ApiProperty() @IsString() @IsNotEmpty() name: string;
  @ApiPropertyOptional() @IsString() @IsOptional() description?: string;
  @ApiPropertyOptional() @IsEnum(TaskStatus) @IsOptional() status?: TaskStatus;
  @ApiProperty() @IsEnum(TaskTriggerType) triggerType: TaskTriggerType;
  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  @Matches(
    /^(\*|([0-5]?\d))(\/(\d+))? (\*|([01]?\d|2[0-3]))(\/(\d+))? (\*|([012]?\d|3[01]))(\/(\d+))? (\*|(1[0-2]|0?[1-9]))(\/(\d+))? (\*|[0-7])(\/(\d+))?$/,
    {
      message:
        "cronExpression must be a valid cron expression (5 fields: min hour day month weekday)",
    },
  )
  cronExpression?: string;
  @ApiPropertyOptional({
    description: "IANA timezone for cron schedules, e.g. Asia/Shanghai",
  })
  @IsString()
  @IsOptional()
  timezone?: string;
  @ApiPropertyOptional() @IsInt() @Min(1) @IsOptional() fixedRate?: number;
  /**
   * FEAT-06: 任务级维护窗口。每条 { start, end, description? }，start/end
   * 均为 5 字段 cron——start 最近触达开窗、end 最近触达关窗（半开区间，
   * 语义见 maintenance-window.util.ts）。结构校验（≤10 条、cron 表达式
   * 结构合法）在 DTO 边界完成；窗口命中时的调度跳过在 scheduler.enqueue。
   * PATCH 语义（N28）：字段缺省 = 保留旧值；显式 null / [] = 清空。
   */
  @ApiPropertyOptional({
    description:
      "Task-level maintenance windows: scheduled triggers falling inside a window are skipped (manual/API triggers unaffected). Each entry {start, end, description?} with 5-field crons; the window opens at the latest start-cron touch and closes at the latest end-cron touch. Max 10 entries.",
    type: [MaintenanceWindowDto],
    maxItems: 10,
  })
  @IsArray()
  @ArrayMaxSize(10)
  @ValidateNested({ each: true })
  @Type(() => MaintenanceWindowDto)
  @IsOptional()
  maintenanceWindows?: MaintenanceWindowDto[] | null;
  @ApiPropertyOptional()
  @IsEnum(TaskRuntime)
  @IsOptional()
  runtime?: TaskRuntime;
  @ApiPropertyOptional() @IsString() @IsOptional() runtimeVersion?: string;
  /**
   * W-21: executor-side dependency specs. Structure validated at the DTO
   * boundary (array of non-empty bounded strings, ≤50); semantic enforcement
   * stays in the executors (python: option-like/blank specs rejected before
   * uv; node: npm naming rules S16) — plus the service-level leading-'-'
   * guard here mirrors their first check so bad specs 400 at create time
   * instead of burning a queued execution.
   */
  @ApiPropertyOptional({
    description:
      'Dependency specs installed by the executor before the task runs — pip requirements (python runtime, per-task uv venv) or npm packages (node runtime). Ignored by glue-script tasks. Example: ["requests>=2.31", "rich==13.7.1"]',
    type: [String],
  })
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  @IsNotEmpty({ each: true })
  @IsOptional()
  requirements?: string[];
  @ApiPropertyOptional({
    description: "Upstream task dependency map: { taskId: taskName }",
    type: "object",
    additionalProperties: { type: "string" },
    example: { "uuid-of-task-a": "task-a-name" },
  })
  @IsObject()
  @IsOptional()
  dependencies?: Record<string, string>;
  @ApiPropertyOptional() @IsString() @IsOptional() entrypoint?: string;
  @ApiPropertyOptional() @IsString() @IsOptional() gitRepo?: string;
  @ApiPropertyOptional() @IsString() @IsOptional() gitBranch?: string;
  @ApiPropertyOptional() @IsString() @IsOptional() gitCommit?: string;
  @ApiPropertyOptional() @IsString() @IsOptional() currentVersion?: string;
  @ApiPropertyOptional({
    description:
      "Task execution timeout in seconds (legacy field; prefer timeoutSeconds). 0 = no limit; bounded to the executor's 1..86400 window (executor-node rejects larger values with 400 on every attempt).",
  })
  @IsInt()
  @Min(0)
  @Max(86400)
  @IsOptional()
  timeout?: number;
  @ApiPropertyOptional({
    description:
      "Task execution timeout in seconds. 0 = no limit; bounded to the executor's 1..86400 window (normalized to `timeout`, which executor-node rejects above 86400 with 400).",
  })
  @IsInt()
  @Min(0)
  @Max(86400)
  @IsOptional()
  timeoutSeconds?: number;
  /**
   * CORE-04: 超时后动作。kill（缺省/null）= 既有树杀语义；kill_retry =
   * 树杀 + 按既有重试预算 re-enqueue；notify_only = admin 不额外下发终止
   * 指令、只保证超时告警（执行器自身硬超时仍在，进程仍会被执行器杀掉——
   * notify_only ≠ 不超时，语义边界见 timeout-policy.util.ts / 文档）。
   * PATCH 语义（N28 同源）：缺省 = 保留旧值；显式 null = 回到缺省 kill。
   */
  @ApiPropertyOptional({
    description:
      "CORE-04: what happens when the task times out. kill (default) = executor tree-kills the process (existing behavior); kill_retry = also kill, but admin re-enqueues a fresh execution using the task's retry budget; notify_only = admin sends the timeout alert and issues no extra kill command (the executor's own hard timeout still applies). Omit on PATCH to keep the current value; explicit null resets to kill.",
    enum: TIMEOUT_ACTIONS,
  })
  @IsIn(TIMEOUT_ACTIONS as unknown as string[])
  @IsOptional()
  timeoutAction?: TimeoutAction | null;
  /**
   * CORE-04: 超时预警阈值（占 timeout 的百分数，整数 0-90，可空）。
   * 运行时长达到 timeout×ratio/100 时发一次 WARNING 预警通知（每个执行
   * 至多一次）；null/缺省 = 未启用（存量任务零新通知）。
   */
  @ApiPropertyOptional({
    description:
      "CORE-04: timeout warning threshold as a percentage of the timeout (integer 0-90). A single WARNING notification is sent once the running time reaches timeout × ratio/100 (at most once per execution). Omit/null = disabled.",
  })
  @IsInt()
  @Min(0)
  @Max(90)
  @IsOptional()
  timeoutWarnRatio?: number | null;
  // TASK-02: cap retries to prevent runaway queue exhaustion
  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10)
  maxRetry?: number;
  @ApiPropertyOptional() @IsInt() @Min(0) @IsOptional() retryDelay?: number;
  @ApiPropertyOptional() @IsArray() @IsOptional() retryableErrors?: string[];
  @ApiPropertyOptional()
  @IsEnum(TaskPriority)
  @IsOptional()
  priority?: TaskPriority;
  @ApiPropertyOptional()
  @IsEnum(ExecuteMode)
  @IsOptional()
  executeMode?: ExecuteMode;
  @ApiPropertyOptional()
  @IsEnum(BlockStrategy)
  @IsOptional()
  blockStrategy?: BlockStrategy;
  @ApiPropertyOptional()
  @IsEnum(MisfireStrategy)
  @IsOptional()
  misfireStrategy?: MisfireStrategy;
  @ApiPropertyOptional() @IsEmail() @IsOptional() alarmEmail?: string;
  @ApiPropertyOptional() @IsArray() @IsOptional() alarmChannels?: string[];
  @ApiPropertyOptional() @IsObject() @IsOptional() params?: Record<string, any>;
  /**
   * SEC-02: 任务级 secrets（凭据键值对，独立于 params 的普通运行参数）。
   * 服务端存储加密（AES-256-GCM，SEC_SECRETS_KEY；未配置降级明文并 warn），
   * API 读取永久脱敏（叶子值回 ******），派发时解密与 params 合并注入执行器
   * env（AUTOFLOW_<KEY>，与既有 params 注入同通道）。PATCH 语义：缺省=保留，
   * 显式 null=清空；已存储的密文不可经 API 回读，更新即整体替换。
   */
  @ApiPropertyOptional({
    description:
      "Task-level secrets (credential key/value pairs, stored encrypted at rest with AES-256-GCM when SEC_SECRETS_KEY is configured; plaintext fallback with a warning otherwise). Read paths are always masked. Dispatched to the executor env as AUTOFLOW_<KEY> merged over params.",
    type: "object",
    additionalProperties: { type: "string" },
    example: { API_TOKEN: "sk-live-...", DB_PASSWORD: "hunter2" },
  })
  @IsObject()
  @IsOptional()
  secrets?: Record<string, unknown> | null;
  @ApiPropertyOptional() @IsString() @IsOptional() executorAppName?: string;
  @ApiPropertyOptional() @IsString() @IsOptional() executorGroup?: string;
  @ApiPropertyOptional() @IsArray() @IsOptional() executorTags?: string[];
  @ApiPropertyOptional({
    description:
      "Pin the task to a specific executor: dispatch targets ONLY this executor (bypasses group/tags filtering); fails fast if it is offline. Mutually exclusive with executeMode=broadcast.",
  })
  @IsUUID()
  @IsOptional()
  executorId?: string;
  @ApiPropertyOptional() @IsString() @IsOptional() glueSource?: string;
  @ApiPropertyOptional() @IsString() @IsOptional() glueLanguage?: string;
  @ApiPropertyOptional() @IsString() @IsOptional() applicationId?: string;
  @ApiPropertyOptional({
    description:
      "FEAT-11: markdown runbook — troubleshooting knowledge shown on the task detail page and attached to failure notifications/alerts.",
  })
  @IsString()
  @IsOptional()
  runbook?: string;
}
