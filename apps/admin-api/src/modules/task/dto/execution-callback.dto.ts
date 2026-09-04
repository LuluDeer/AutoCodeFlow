import {
  IsString,
  IsNotEmpty,
  IsIn,
  IsOptional,
  IsInt,
  Min,
  MaxLength,
  IsUUID,
} from "class-validator";
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { ExecutionFailureReason } from "../entities/task-execution.entity";

export class CallbackItemDto {
  @ApiProperty({
    description: "Execution ID (UUID)",
    example: "f47ac10b-58cc-4372-a567-0e02b2c3d479",
  })
  @IsString()
  @IsNotEmpty()
  @IsUUID(4)
  executionId: string;

  @ApiProperty({
    description: "Execution outcome",
    enum: ["success", "failed"],
  })
  @IsIn(["success", "failed"])
  status: "success" | "failed";

  @ApiPropertyOptional({
    description: "Executor address for per-executor token validation",
  })
  @IsOptional()
  @IsString()
  executorAddress?: string;

  @ApiPropertyOptional({ description: "Process exit code" })
  @IsOptional()
  @IsInt()
  exitCode?: number;

  @ApiPropertyOptional({
    description: "Raw log output (max 500 KB)",
    maxLength: 512_000,
  })
  @IsOptional()
  @IsString()
  @MaxLength(512_000)
  logs?: string;

  @ApiPropertyOptional({
    description: "Error message on failure (max 4 KB)",
    maxLength: 4096,
  })
  @IsOptional()
  @IsString()
  @MaxLength(4096)
  errorMessage?: string;

  @ApiPropertyOptional({
    description: "Structured failure reason",
    enum: ExecutionFailureReason,
  })
  @IsOptional()
  @IsIn(Object.values(ExecutionFailureReason))
  failureReason?: ExecutionFailureReason;

  @ApiPropertyOptional({
    description: "Wall-clock execution duration in milliseconds",
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  durationMs?: number;
}
