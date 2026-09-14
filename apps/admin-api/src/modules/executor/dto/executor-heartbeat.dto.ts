import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";

/**
 * PK-03（DEEP_REVIEW 0ef3bbe）: POST /executors/heartbeat 的请求体 Swagger 文档 DTO。
 *
 * 注意：本类**仅用于 openapi schema 生成**——控制器 @Body() 仍用内联类型
 * （metatype = Object，全局 ValidationPipe 不对其做 whitelist 校验）。此处不挂
 * class-validator 装饰器，避免把 executor-node 心跳请求体误入
 * forbidNonWhitelisted 400 路径；指标白名单在 controller/service 侧显式裁剪。
 */
export class ExecutorHeartbeatDto {
  @ApiProperty({ description: "Executor registration address", example: "192.168.1.100:3002" })
  address: string;

  @ApiPropertyOptional({ description: "CPU usage percentage", example: 45.5 })
  cpuUsage?: number;

  @ApiPropertyOptional({ description: "Memory usage percentage", example: 62.3 })
  memUsage?: number;

  @ApiPropertyOptional({ description: "Disk usage percentage", example: 70.0 })
  diskUsage?: number;

  @ApiPropertyOptional({ description: "Network latency in ms", example: 2 })
  networkLatency?: number;

  @ApiPropertyOptional({ description: "Number of currently running tasks", example: 3 })
  runningTaskCount?: number;

  @ApiPropertyOptional({ description: "Total tasks executed", example: 150 })
  totalTaskCount?: number;

  @ApiPropertyOptional({ description: "Number of failed tasks", example: 5 })
  failedTaskCount?: number;

  @ApiPropertyOptional({
    description: "Restart timestamp (ISO 8601)",
    example: "2026-09-14T08:00:00.000Z",
    nullable: true,
  })
  restartedAt?: string | null;

  @ApiPropertyOptional({
    description: "Startup ID (process life identifier)",
    example: "uuid-of-this-executor-process-life",
    nullable: true,
  })
  startupId?: string | null;

  @ApiPropertyOptional({
    description: "CONSISTENCY-02: Currently running execution IDs",
    type: [String],
    example: ["exec-uuid-1", "exec-uuid-2"],
  })
  runningExecutionIds?: string[];

  @ApiPropertyOptional({ description: "Dead letter count", example: 0 })
  deadLetterCount?: number;

  @ApiPropertyOptional({
    description: "E9: Updated max concurrent tasks (hot-updated capacity)",
    example: 10,
  })
  maxConcurrentTasks?: number;

  @ApiPropertyOptional({
    description: "EXE-VER-1: Executor version (for min-version gate echo, not persisted)",
    example: "1.0.0",
  })
  version?: string;
}
