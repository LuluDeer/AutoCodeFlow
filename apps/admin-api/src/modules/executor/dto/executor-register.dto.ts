import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";

/**
 * PK-03（DEEP_REVIEW 0ef3bbe）: POST /executors/register 的请求体 Swagger 文档 DTO。
 *
 * 注意：本类**仅用于 openapi schema 生成**——控制器 @Body() 仍用内联类型
 * （metatype = Object，全局 ValidationPipe 不对其做 whitelist 校验）。此处不挂
 * class-validator 装饰器，避免把 executor-node 注册请求体误入
 * forbidNonWhitelisted 400 路径；字段白名单在 controller/service 侧显式裁剪。
 */
export class ExecutorRegisterDto {
  @ApiProperty({ description: "Executor application name", example: "executor-node" })
  appName: string;

  @ApiProperty({ description: "Executor registration address", example: "192.168.1.100:3002" })
  address: string;

  @ApiPropertyOptional({ description: "Executor type", example: "node" })
  type?: string;

  @ApiPropertyOptional({ description: "Executor version", example: "1.0.0" })
  version?: string;

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

  @ApiPropertyOptional({ description: "Max concurrent (legacy alias)", example: 10 })
  maxConcurrent?: number;

  @ApiPropertyOptional({ description: "Executor group name", example: "production", nullable: true })
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
    description: "Startup ID (process life identifier for idempotent re-registration)",
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
}
