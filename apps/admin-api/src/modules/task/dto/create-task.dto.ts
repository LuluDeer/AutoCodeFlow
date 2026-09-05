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
} from "class-validator";
import {
  TaskStatus,
  TaskTriggerType,
  TaskRuntime,
  BlockStrategy,
  MisfireStrategy,
  TaskPriority,
  ExecuteMode,
} from "../entities/task.entity";

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
      "Task execution timeout in seconds (legacy field; prefer timeoutSeconds)",
  })
  @IsInt()
  @Min(0)
  @IsOptional()
  timeout?: number;
  @ApiPropertyOptional({ description: "Task execution timeout in seconds" })
  @IsInt()
  @Min(0)
  @IsOptional()
  timeoutSeconds?: number;
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
}
