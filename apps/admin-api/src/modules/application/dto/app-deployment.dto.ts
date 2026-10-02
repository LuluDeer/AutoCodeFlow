import {
  IsString,
  IsEnum,
  IsOptional,
  IsObject,
  IsUUID,
  IsInt,
  MaxLength,
  Validate,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from "class-validator";
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { RunMode } from "../entities/app-deployment.entity";

/**
 * A-11: env 载荷体积红线。
 *
 * 为什么需要：env 是执行器自由形状的 jsonb 载荷，此前仅 IsObject 把关——
 * 异常/被污染的调用方可以塞进任意大的 jsonb，随部署行进列表读面（每个 GET
 * 都要反序列化一遍）。键数 50 + 单值 4KB 对环境变量形态的载荷绰绰有余
 * （与 task/dto/execution-callback.dto.ts 的 CALLBACK_RESULT_MAX_BYTES 同一口径）。
 */
export const DEPLOYMENT_ENV_MAX_KEYS = 50;
export const DEPLOYMENT_ENV_VALUE_MAX_BYTES = 4096;

@ValidatorConstraint({ name: "deploymentEnvSize", async: false })
export class DeploymentEnvSizeConstraint implements ValidatorConstraintInterface {
  // 非对象形态交给 @IsObject/@IsOptional 把关，本约束只管体积。
  validate(value: unknown): boolean {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      return true;
    }
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length > DEPLOYMENT_ENV_MAX_KEYS) return false;
    return entries.every(
      ([key, val]) =>
        typeof val === "string" &&
        Buffer.byteLength(key, "utf8") <= DEPLOYMENT_ENV_VALUE_MAX_BYTES &&
        Buffer.byteLength(val, "utf8") <= DEPLOYMENT_ENV_VALUE_MAX_BYTES,
    );
  }

  defaultMessage(): string {
    return (
      `env must have at most ${DEPLOYMENT_ENV_MAX_KEYS} keys, and every key/value ` +
      `string must be at most ${DEPLOYMENT_ENV_VALUE_MAX_BYTES} bytes`
    );
  }
}

export class CreateDeploymentDto {
  @ApiPropertyOptional({
    description:
      "Executor ID (leave empty to auto-select the online executor with lowest load)",
  })
  @IsUUID()
  @IsOptional()
  executorId?: string;

  @ApiPropertyOptional({ enum: RunMode, default: RunMode.DAEMON })
  @IsEnum(RunMode)
  @IsOptional()
  runMode?: RunMode;

  @ApiPropertyOptional({
    description: `Environment variable overrides (≤${DEPLOYMENT_ENV_MAX_KEYS} keys, each value ≤${DEPLOYMENT_ENV_VALUE_MAX_BYTES} bytes)`,
  })
  @IsObject()
  // A-11: 键数 + 单值字节闸（见常量注释）。
  @Validate(DeploymentEnvSizeConstraint)
  @IsOptional()
  env?: Record<string, string>;

  @ApiPropertyOptional({
    description:
      "Startup command override (leave empty to use manifest entrypoint)",
  })
  @IsString()
  // A-11: startCommand 随部署行落库并进列表读面——上限对齐 message 闸。
  @MaxLength(2000)
  @IsOptional()
  startCommand?: string;
}

/** DEP-04: 审批动作请求体（approve/reject 共用；reason 可选 ≤200，拒绝时
 *  建议携带——随 approvalMeta/statusMessage 留痕，语义对齐 AUTH-05）。 */
export class ApprovalActionDto {
  @ApiPropertyOptional({
    description: "Optional decision reason (≤200 chars), recorded in audit",
    maxLength: 200,
  })
  @IsString()
  @MaxLength(200)
  @IsOptional()
  reason?: string;
}

export class DeploymentHeartbeatDto {
  @ApiProperty({ description: "Deployment ID" })
  @IsUUID()
  deploymentId: string;

  @ApiProperty({
    description: "Runtime status",
    enum: ["running", "stopped", "failed"],
  })
  @IsString()
  @IsEnum(["running", "stopped", "failed"], {
    message: "status must be one of: running, stopped, failed",
  })
  status: string;

  // R17: pid is persisted/compared as a number — without @IsInt a string
  // like "123" (or an object) would pass validation and land in the row.
  @ApiPropertyOptional({ description: "Process PID", type: Number })
  @IsOptional()
  @IsInt()
  pid?: number;

  @ApiPropertyOptional({
    description:
      "Free-form progress message (max 2000 chars; lands in the " +
      "statusMessage text column and the list read surface)",
  })
  @IsString()
  // A-11: 异常执行器可以借 message 无限写 statusMessage（text 列）并随
  // 列表读面回传——2KB 上限与 startCommand 闸同口径。
  @MaxLength(2000)
  @IsOptional()
  message?: string;
}
