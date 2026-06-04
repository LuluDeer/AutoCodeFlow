import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsNotEmpty, IsOptional, IsString, IsInt, Min } from 'class-validator';
import { TaskTriggerType, TaskRuntime } from '../entities/task.entity';

export class CreateTaskDto {
  @ApiProperty() @IsString() @IsNotEmpty() name: string;
  @ApiPropertyOptional() @IsOptional() @IsString() description?: string;
  @ApiProperty({ enum: TaskTriggerType }) @IsEnum(TaskTriggerType) triggerType: TaskTriggerType;
  @ApiPropertyOptional() @IsOptional() @IsString() cronExpression?: string;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(1) fixedRate?: number;
  @ApiPropertyOptional({ enum: TaskRuntime }) @IsOptional() @IsEnum(TaskRuntime) runtime?: TaskRuntime;
  @ApiPropertyOptional() @IsOptional() @IsString() runtimeVersion?: string;
  @ApiPropertyOptional() @IsOptional() dependencies?: Record<string, string>;
  @ApiPropertyOptional() @IsOptional() @IsString() entrypoint?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() gitRepo?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() gitBranch?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() gitCommit?: string;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) timeout?: number;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) maxRetry?: number;
  @ApiPropertyOptional() @IsOptional() params?: Record<string, any>;
  @ApiPropertyOptional() @IsOptional() @IsString() executorAppName?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() alarmEmail?: string;
  @ApiPropertyOptional() @IsOptional() alarmChannels?: string[];
}
