import {
  IsString,
  IsNotEmpty,
  IsIn,
  IsOptional,
  IsInt,
  IsArray,
  Min,
  MaxLength,
  Matches,
  ArrayMaxSize,
  ValidateNested,
  IsUUID,
} from "class-validator";
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Type } from "class-transformer";
import { ExecutionFailureReason } from "../entities/task-execution.entity";

/**
 * FEAT-05：执行器任务结束回调随附的单个产物清单条目。
 * name 为执行器 artifacts/ 目录下的裸文件名（不含任何路径分隔符）——admin 侧
 * 下载端点据此拼接 uploads/artifacts/<execId>/<name>，并在落盘/读取时二次
 * 校验防路径穿越。size 为字节数，sha256 为文件内容十六进制摘要（供完整性核对）。
 */
export class ArtifactManifestItemDto {
  @ApiProperty({ description: "Artifact file name (bare, no path separators)" })
  @IsString()
  @IsNotEmpty()
  @Matches(/^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/, {
    message:
      "artifact name must be a bare safe file name (letters/digits/._- only, no path separators)",
  })
  name: string;

  @ApiProperty({ description: "Artifact size in bytes" })
  @IsInt()
  @Min(0)
  size: number;

  @ApiProperty({ description: "sha256 hex digest of the artifact bytes" })
  @IsString()
  @Matches(/^[0-9a-fA-F]{64}$/, { message: "sha256 must be a 64-hex digest" })
  sha256: string;
}

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

  @ApiPropertyOptional({
    description:
      "FEAT-05: execution artifacts manifest (best-effort, max 20 entries). " +
      "File bytes are uploaded separately via the artifact upload endpoint; " +
      "the manifest is persisted to task_executions.artifacts on the terminal callback.",
    type: [ArtifactManifestItemDto],
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => ArtifactManifestItemDto)
  artifacts?: ArtifactManifestItemDto[];
}
