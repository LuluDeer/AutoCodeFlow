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
  @ApiPropertyOptional() @IsString() @IsOptional() id?: string;
  @ApiProperty() @IsString() @IsNotEmpty() name: string;
  @ApiPropertyOptional() @IsString() @IsOptional() description?: string;
  @ApiPropertyOptional() @IsEnum(TaskStatus) @IsOptional() status?: TaskStatus;
  @ApiProperty() @IsEnum(TaskTriggerType) triggerType: TaskTriggerType;
  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  @Matches(
    /^(\*|([0-5]?\d))(\/(\d+))? (\*|([01]?\d|2[0-3]))(\/(\d+))? (\*|([012]?\d|3[01]))(\/(\d+))? (\*|(1[0-2]|0?[1-9]))(\/(\d+))? (\*|[0-7])(\/(\d+))?$/,
    { message: "cronExpression must be a valid cron expression (5 fields: min hour day month weekday)" },
  )
  cronExpression?: string;
  @ApiPropertyOptional() @IsInt() @Min(1) @IsOptional() fixedRate?: number;
  @ApiPropertyOptional()
  @IsEnum(TaskRuntime)
  @IsOptional()
  runtime?: TaskRuntime;
  @ApiPropertyOptional() @IsString() @IsOptional() runtimeVersion?: string;
  @ApiPropertyOptional({
    description: "Upstream task dependency map: { taskId: taskName }",
    type: "object",
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
  @ApiPropertyOptional() @IsInt() @Min(0) @IsOptional() timeout?: number;
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
  @ApiPropertyOptional() @IsString() @IsOptional() glueSource?: string;
  @ApiPropertyOptional() @IsString() @IsOptional() glueLanguage?: string;
  @ApiPropertyOptional() @IsString() @IsOptional() applicationId?: string;
}
