import {
  IsString,
  IsEnum,
  IsOptional,
  IsObject,
  IsUUID,
  IsInt,
  IsIn,
  IsISO8601,
  MaxLength,
  Min,
  Max,
  Validate,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from "class-validator";
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Type } from "class-transformer";
import { RunMode } from "../entities/app-deployment.entity";
import { AppDeploymentEventType } from "../entities/app-deployment-event.entity";

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
    description: "执行器 ID（留空则自动选择负载最低的在线执行器）",
  })
  @IsUUID()
  @IsOptional()
  executorId?: string;

  @ApiPropertyOptional({ enum: RunMode, default: RunMode.DAEMON })
  @IsEnum(RunMode)
  @IsOptional()
  runMode?: RunMode;

  @ApiPropertyOptional({
    description: `环境变量覆盖（≤${DEPLOYMENT_ENV_MAX_KEYS} 个键，每个值 ≤${DEPLOYMENT_ENV_VALUE_MAX_BYTES} 字节）`,
    // N-12（2026-10-07）：无 additionalProperties 时 swagger 发空 object schema，
    // openapi-typescript 渲染 Record<string, never>——前端拿到一个写不进任何键
    // 的 env 类型（契约比没有类型更坏）。显式声明值类型。
    type: "object",
    additionalProperties: { type: "string" },
  })
  @IsObject()
  // A-11: 键数 + 单值字节闸（见常量注释）。
  @Validate(DeploymentEnvSizeConstraint)
  @IsOptional()
  env?: Record<string, string>;

  @ApiPropertyOptional({
    description: "启动命令覆盖（留空则使用 manifest 的 entrypoint）",
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
    maxLength: 200,
    description: "可选的决策理由（≤200 字符），计入审计",
  })
  @IsString()
  @MaxLength(200)
  @IsOptional()
  reason?: string;
}

export class DeploymentHeartbeatDto {
  @ApiProperty({ description: "部署 ID" })
  @IsUUID()
  deploymentId: string;

  @ApiProperty({
    enum: ["running", "stopped", "failed"],
    description: "运行状态",
  })
  @IsString()
  @IsEnum(["running", "stopped", "failed"], {
    message: "status must be one of: running, stopped, failed",
  })
  status: string;

  // R17: pid is persisted/compared as a number — without @IsInt a string
  // like "123" (or an object) would pass validation and land in the row.
  @ApiPropertyOptional({
    type: Number,
    description: "进程 PID",
  })
  @IsOptional()
  @IsInt()
  pid?: number;

  @ApiPropertyOptional({
    description:
      "自由格式的进度信息（最长 2000 字符；写入 statusMessage 文本列并进入列表读面）",
  })
  @IsString()
  // A-11: 异常执行器可以借 message 无限写 statusMessage（text 列）并随
  // 列表读面回传——2KB 上限与 startCommand 闸同口径。
  @MaxLength(2000)
  @IsOptional()
  message?: string;
}

/**
 * R4（部署模型评审 §4.1A）：GET /app-deployments/applications/:appId/events
 * 查询参数（默认 50，上限 200，口径与 ListReleasesQueryDto 一致）。
 */
export class ListDeploymentEventsQueryDto {
  // @Max(10000)：对齐通用 PageQueryDto 的 NETOPT-3④ 口径——无封顶的 page
  // 可被 ?page=99999999 打深 OFFSET + 全量 COUNT 打满连接池（游标化调研
  // 2026-10-25 发现的漏网之口；本表规模下游标化暂不做，封顶是便宜几个
  // 量级的防御）。
  @ApiPropertyOptional({ default: 1, maximum: 10000 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(10000)
  page?: number = 1;

  @ApiPropertyOptional({ default: 50, maximum: 200 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  pageSize?: number = 50;

  /**
   * AppDeploymentEventType 九值取值域（varchar 裸 token，实测自实体枚举）。
   * Object.values 而非手抄九个字符串：枚举扩值时校验白名单自动跟随，不会
   * 出现「实体已有新值、DTO 还拒收」的静默 400。
   */
  @ApiPropertyOptional({
    enum: Object.values(AppDeploymentEventType),
    description:
      "按事件类型过滤（AppDeploymentEventType 九值单值；直等命中 (applicationId, eventType) 复合索引）",
  })
  @IsOptional()
  @IsIn(Object.values(AppDeploymentEventType))
  eventType?: AppDeploymentEventType;

  /** 半开区间含头：createdAt >= since（ISO 8601）。 */
  @ApiPropertyOptional({
    description: "起始时间（ISO 8601）；半开区间含头：createdAt >= since",
  })
  @IsOptional()
  @IsISO8601()
  since?: string;

  /** 半开区间不含尾：createdAt < until（ISO 8601）——按天滚窗可无缝衔接。 */
  @ApiPropertyOptional({
    description: "结束时间（ISO 8601）；半开区间不含尾：createdAt < until",
  })
  @IsOptional()
  @IsISO8601()
  until?: string;
}
