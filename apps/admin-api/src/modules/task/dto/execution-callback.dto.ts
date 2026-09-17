import {
  IsString,
  IsNotEmpty,
  IsIn,
  IsOptional,
  IsInt,
  IsArray,
  IsObject,
  Min,
  MaxLength,
  Matches,
  ArrayMaxSize,
  ValidateNested,
  IsUUID,
  Validate,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from "class-validator";
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Type } from "class-transformer";
import {
  ExecutionFailureReason,
  // A3: 执行器可上报子集（全集 − admin 内部专用），见 protocol.json。
  EXECUTOR_REPORTABLE_FAILURE_REASONS,
} from "../entities/task-execution.entity";

/**
 * `result` 的体积红线（序列化后的 UTF-8 字节数）。
 *
 * 为什么需要：`result` 是执行器自由形状的 jsonb 载荷。回调体本身虽然受
 * `CallbacksDto` 条数上限与 `logs` 的 512KB 限制约束，但这个字段若不加限，
 * 就等于开了一个"绕过日志上限写任意大 jsonb"的口子——jsonb 落库是实打实的
 * 磁盘与内存开销。4KB 对解释器快照（几个短字符串 + 池版本列表）绰绰有余。
 */
export const CALLBACK_RESULT_MAX_BYTES = 4096;

/** 单次回调 `result` 的深度上限（防御深层嵌套导致的序列化开销）。 */
export const CALLBACK_RESULT_MAX_DEPTH = 6;

function jsonBytes(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value) ?? "", "utf8");
  } catch {
    // 循环引用等不可序列化情形：交给约束判失败，不在这里抛。
    return Number.POSITIVE_INFINITY;
  }
}

function depthOf(value: unknown, depth = 0): number {
  if (depth > CALLBACK_RESULT_MAX_DEPTH) return depth;
  if (Array.isArray(value)) {
    return value.reduce<number>(
      (acc, v) => Math.max(acc, depthOf(v, depth + 1)),
      depth,
    );
  }
  if (value && typeof value === "object") {
    return Object.values(value as Record<string, unknown>).reduce<number>(
      (acc, v) => Math.max(acc, depthOf(v, depth + 1)),
      depth,
    );
  }
  return depth;
}

@ValidatorConstraint({ name: "isBoundedJsonObject", async: false })
export class IsBoundedJsonObjectConstraint implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      return false;
    }
    if (jsonBytes(value) > CALLBACK_RESULT_MAX_BYTES) return false;
    return depthOf(value) <= CALLBACK_RESULT_MAX_DEPTH;
  }

  defaultMessage(): string {
    return (
      `result must be a JSON object of at most ${CALLBACK_RESULT_MAX_BYTES} bytes ` +
      `and at most ${CALLBACK_RESULT_MAX_DEPTH} levels deep`
    );
  }
}

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
    // A3: OpenAPI 上只暴露执行器**可上报**的子集——`stale_recovered` 由 admin
    // 内部写入，不该出现在回调契约的文档面上（此前用的是全集）。
    enum: [...EXECUTOR_REPORTABLE_FAILURE_REASONS],
  })
  @IsOptional()
  // A3: 收窄为执行器可上报集合（此前用全集，等于允许执行器上报 admin 内部专用的
  // `stale_recovered`）。取值清单由 packages/executor-protocol/protocol.json 钉死。
  @IsIn([...EXECUTOR_REPORTABLE_FAILURE_REASONS])
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

  @ApiPropertyOptional({
    description:
      "python_task_multiversion (FR-12/AC-12a): structured execution detail. " +
      "Currently carries the interpreter snapshot { requested, resolved, reason, detail, pool } " +
      "so an interpreter_unavailable failure can be triaged without re-running the task. " +
      "Persisted verbatim to task_executions.result. " +
      "Constrained to an object with a bounded serialized size (4 KB).",
    type: Object,
    additionalProperties: true,
  })
  @IsOptional()
  @IsObject()
  // 回调体上限已经是 100 条 × 512KB 日志，这个字段本身必须自我约束，
  // 否则它就成了绕过日志上限、往 jsonb 里塞任意大对象的入口。
  @Validate(IsBoundedJsonObjectConstraint)
  result?: Record<string, unknown>;
}
