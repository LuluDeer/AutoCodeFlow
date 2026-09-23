import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
// python_task_multiversion（WS2）：解释器清单条目 DTO 与心跳共用一份定义
// （两处上报同一形状，分开定义必然漂移）。
import { ExecutorInterpreterDto } from "./executor-heartbeat.dto";

/**
 * PK-03（DEEP_REVIEW 0ef3bbe）: POST /executors/register 的请求体 Swagger 文档 DTO。
 *
 * 注意：本类**仅用于 openapi schema 生成**——控制器 @Body() 仍用内联类型
 * （metatype = Object，全局 ValidationPipe 不对其做 whitelist 校验）。此处不挂
 * class-validator 装饰器，避免把 executor-node 注册请求体误入
 * forbidNonWhitelisted 400 路径；字段白名单在 controller/service 侧显式裁剪。
 */
export class ExecutorRegisterDto {
  @ApiProperty({
    description: "Executor application name",
    example: "executor-node",
  })
  appName: string;

  @ApiProperty({
    description: "Executor registration address",
    example: "192.168.1.100:3002",
  })
  address: string;

  @ApiPropertyOptional({ description: "Executor type", example: "node" })
  type?: string;

  @ApiPropertyOptional({ description: "Executor version", example: "1.0.0" })
  version?: string;

  @ApiPropertyOptional({
    description:
      "PROTOCOL-VER (B-3/U-2): 执行器线缆协议版本（与实现版本 version 解耦）。中台按兼容矩阵分支：低于 supportedMin 只 warn + 兜底，不拒绝注册。",
    example: 1,
  })
  protocolVersion?: number;

  @ApiPropertyOptional({
    description: "Declared capabilities",
    type: [String],
    example: ["docker", "shell"],
  })
  capabilities?: string[];

  @ApiPropertyOptional({
    description: "Declared runtime environments",
    type: [String],
    example: ["nodejs", "python3"],
  })
  runtime?: string[];

  @ApiPropertyOptional({ description: "Max concurrent tasks", example: 10 })
  maxConcurrentTasks?: number;

  @ApiPropertyOptional({
    description: "Max concurrent (legacy alias)",
    example: 10,
  })
  maxConcurrent?: number;

  @ApiPropertyOptional({
    description: "Executor group name",
    example: "production",
    nullable: true,
  })
  groupName?: string | null;

  @ApiPropertyOptional({
    description: "Executor tags",
    type: [String],
    example: ["nodejs", "prod"],
    nullable: true,
  })
  tags?: string[] | null;

  @ApiPropertyOptional({
    description: "Executor description",
    example: "Production Node.js executor",
    nullable: true,
  })
  description?: string | null;

  @ApiPropertyOptional({
    description: "Restart timestamp (ISO 8601)",
    example: "2026-09-14T08:00:00.000Z",
    nullable: true,
  })
  restartedAt?: string | null;

  @ApiPropertyOptional({
    description:
      "Startup ID (process life identifier for idempotent re-registration)",
    example: "uuid-of-this-executor-process-life",
    nullable: true,
  })
  startupId?: string | null;

  @ApiPropertyOptional({
    description: "Dispatch mode ('push' | 'pull'; defaults to push)",
    example: "pull",
    enum: ["push", "pull"],
  })
  dispatchMode?: string;

  @ApiPropertyOptional({
    description:
      "python_task_multiversion: interpreter cache-pool inventory. Omitted → keep the stored value; [] → reported and the pool is empty; invalid structure → the whole field is rejected.",
    type: () => [ExecutorInterpreterDto],
  })
  interpreters?: ExecutorInterpreterDto[];

  @ApiPropertyOptional({
    description:
      "ARCH-36 (ADR-017 phase 2): stable install identity — sha256(deviceId + ':' + installSalt) as 64 lowercase hex chars. Omitted/invalid → keep the stored value. Collected and observed only; it does NOT participate in row lookup (registration still keys on address).",
    example: "3f2a1c9d8b7e6f504132a5b6c7d8e9f00a1b2c3d4e5f60718293a4b5c6d7e8f9",
    nullable: true,
  })
  deviceFingerprint?: string | null;
}
