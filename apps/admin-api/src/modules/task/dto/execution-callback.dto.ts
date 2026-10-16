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
  @ApiProperty({ description: "产物文件名（裸文件名，不含任何路径分隔符）" })
  @IsString()
  @IsNotEmpty()
  @Matches(/^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/, {
    message:
      "artifact name must be a bare safe file name (letters/digits/._- only, no path separators)",
  })
  name: string;

  @ApiProperty({ description: "产物字节数" })
  @IsInt()
  @Min(0)
  size: number;

  @ApiProperty({ description: "产物内容的 sha256 十六进制摘要" })
  @IsString()
  @Matches(/^[0-9a-fA-F]{64}$/, { message: "sha256 must be a 64-hex digest" })
  sha256: string;
}

export class CallbackItemDto {
  @ApiProperty({
    example: "f47ac10b-58cc-4372-a567-0e02b2c3d479",
    description: "执行 ID（UUID）",
  })
  @IsString()
  @IsNotEmpty()
  @IsUUID(4)
  executionId: string;

  @ApiProperty({
    enum: ["success", "failed"],
    description: "执行结果",
  })
  @IsIn(["success", "failed"])
  status: "success" | "failed";

  @ApiPropertyOptional({ description: "执行器地址，用于按执行器校验 token" })
  @IsOptional()
  @IsString()
  executorAddress?: string;

  @ApiPropertyOptional({
    example: "3f2a1c9d8b7e6f504132a5b6c7d8e9f00a1b2c3d4e5f60718293a4b5c6d7e8f9",
    description:
      "ADR-017 阶段 3（protocol v6）：发起回调的执行器的稳定安装标识——" +
      "sha256(deviceId + ':' + installSalt)，64 位小写十六进制字符，与 register/heartbeat 同值。" +
      "它是本次回调的**行身份**：共享/旧版 token 不绑定任何行，且当 pull 模式的执行器共用同一地址后，" +
      "`executorAddress` 已无法唯一标识一行（ADR-017 §5）。admin 用它把回调归属到该执行实际派发到的那一行。" +
      "可选——旧版执行器、采集失败以及 SDK 调用方会省略；此时 admin 依次回落到凭据持有行、" +
      "再回落到地址相等（绝不因缺失而拒绝）。",
  })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  deviceFingerprint?: string;

  @ApiPropertyOptional({ description: "进程退出码" })
  @IsOptional()
  @IsInt()
  exitCode?: number;

  @ApiPropertyOptional({
    maxLength: 512_000,
    description: "原始日志输出（最大 500 KB）",
  })
  @IsOptional()
  @IsString()
  @MaxLength(512_000)
  logs?: string;

  @ApiPropertyOptional({
    maxLength: 4096,
    description: "失败时的错误信息（最大 4 KB）",
  })
  @IsOptional()
  @IsString()
  @MaxLength(4096)
  errorMessage?: string;

  @ApiPropertyOptional({
    // A3: OpenAPI 上只暴露执行器**可上报**的子集——`stale_recovered` 由 admin
    // 内部写入，不该出现在回调契约的文档面上（此前用的是全集）。
    enum: [EXECUTOR_REPORTABLE_FAILURE_REASONS],
    description: "结构化的失败原因",
  })
  @IsOptional()
  // A3: 收窄为执行器可上报集合（此前用全集，等于允许执行器上报 admin 内部专用的
  // `stale_recovered`）。取值清单由 packages/executor-protocol/protocol.json 钉死。
  @IsIn([...EXECUTOR_REPORTABLE_FAILURE_REASONS])
  failureReason?: ExecutionFailureReason;

  @ApiPropertyOptional({ description: "执行墙钟时长（毫秒）" })
  @IsOptional()
  @IsInt()
  @Min(0)
  durationMs?: number;

  @ApiPropertyOptional({
    type: [ArtifactManifestItemDto],
    description:
      "FEAT-05：执行产物清单（best-effort，最多 20 条）。文件字节通过产物上传端点单独上传；清单在终态回调时持久化到 task_executions.artifacts。",
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => ArtifactManifestItemDto)
  artifacts?: ArtifactManifestItemDto[];

  @ApiPropertyOptional({
    type: Object,
    additionalProperties: true,
    description:
      "python_task_multiversion（FR-12/AC-12a）：结构化的执行明细。当前承载解释器快照 { requested, resolved, reason, detail, pool }，使得 interpreter_unavailable 失败无需重跑任务即可定位。原样持久化到 task_executions.result。约束为对象，且序列化体积有上限（4 KB）。",
  })
  @IsOptional()
  @IsObject()
  // 回调体上限已经是 100 条 × 512KB 日志，这个字段本身必须自我约束，
  // 否则它就成了绕过日志上限、往 jsonb 里塞任意大对象的入口。
  @Validate(IsBoundedJsonObjectConstraint)
  result?: Record<string, unknown>;
}
