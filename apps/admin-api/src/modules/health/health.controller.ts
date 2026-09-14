import { Controller, Get } from "@nestjs/common";
import { ApiTags, ApiOperation, ApiResponse } from "@nestjs/swagger";
import { HealthService } from "./health.service";
import { Public } from "../../common/decorators/public.decorator";

@ApiTags("Health Check")
@Controller("health")
export class HealthController {
  constructor(private readonly healthService: HealthService) {}

  /**
   * R-25（DEEP_REVIEW 0ef3bbe）：公开健康端点仅返回整体 status + timestamp，
   * 不再暴露 executor 在线数、队列深度、任务计数等内部运维指标——未认证用户
   * 可借此枚举集群规模与容量。详细指标移至需鉴权的 /health/detailed 端点。
   * LB 探活请使用 /health/live 与 /health/ready（已最小化）。
   */
  @Public()
  @Get()
  @ApiOperation({
    summary: "Basic health check",
    description:
      "Public health check. Returns only the overall status (healthy/degraded/unhealthy) and timestamp. " +
      "Detailed metrics (executor count, queue depth, task counts) are available at GET /health/detailed (requires JWT).",
  })
  @ApiResponse({
    status: 200,
    description: "Health check result",
    schema: {
      example: {
        status: "healthy",
        timestamp: "2024-01-01T12:00:00Z",
      },
    },
  })
  async health() {
    return this.healthService.getPublicHealth();
  }

  /**
   * R-25（DEEP_REVIEW 0ef3bbe）：详细健康指标端点——需 JWT 鉴权（无 @Public）。
   * 包含 db/redis/queue/executors/tasks/scheduler 五组件详情与 metrics。
   */
  @Get("detailed")
  @ApiOperation({
    summary: "Detailed health check (authenticated)",
    description:
      "Full detailed health status and metrics including database, Redis, message queue, executors, and scheduler. " +
      "Requires JWT authentication. Use GET /health for the public status-only endpoint.",
  })
  @ApiResponse({
    status: 200,
    description: "Detailed health check result",
    schema: {
      example: {
        status: "healthy",
        timestamp: "2024-01-01T12:00:00Z",
        services: {
          database: { status: "healthy" },
          redis: { status: "healthy" },
          queue: { status: "healthy", size: 0 },
          executors: { status: "healthy", onlineCount: 3, totalCount: 3 },
          tasks: {
            status: "healthy",
            activeCount: 8,
            totalCount: 10,
            runningCount: 2,
          },
          scheduler: { status: "healthy" },
        },
        metrics: {
          totalTasks: 10,
          activeTasks: 8,
          runningExecutions: 2,
          totalExecutors: 3,
          onlineExecutors: 3,
          queueSize: 0,
        },
        components: [
          { name: "database", status: "healthy" },
          { name: "redis", status: "healthy" },
          { name: "queue", status: "healthy" },
          { name: "executors", status: "healthy" },
          { name: "tasks", status: "healthy" },
          { name: "scheduler", status: "healthy" },
        ],
      },
    },
  })
  async detailed() {
    return this.healthService.getFullHealth();
  }

  @Public()
  @Get("live")
  @ApiOperation({
    summary: "Liveness check",
    description:
      "Simple liveness check, returns whether the service is running. Used for Kubernetes liveness probe.",
  })
  @ApiResponse({
    status: 200,
    description: "Service alive",
    schema: {
      example: { status: "healthy" },
    },
  })
  async live() {
    return this.healthService.getLiveness();
  }

  @Public()
  @Get("ready")
  @ApiOperation({
    summary: "Readiness check",
    description:
      "Check whether the service is ready to accept requests. Verifies DB and Redis connections. Used for Kubernetes readiness probe.",
  })
  @ApiResponse({
    status: 200,
    description: "Readiness check result",
    schema: {
      example: {
        status: "ready",
        timestamp: "2024-01-01T12:00:00Z",
        checks: [
          { name: "database", status: "pass" },
          { name: "redis", status: "pass" },
        ],
      },
    },
  })
  async ready() {
    return this.healthService.getReadiness();
  }

  // R-25（DEEP_REVIEW 0ef3bbe）：services/metrics 端点移除 @Public——
  // 它们暴露 executor 在线数、队列深度等内部指标，需 JWT 鉴权。
  @Get("services")
  @ApiOperation({
    summary: "Service status (authenticated)",
    description: "Get health status details for each core service. Requires JWT authentication.",
  })
  @ApiResponse({
    status: 200,
    description: "Service status list",
    schema: {
      example: {
        database: { status: "healthy" },
        redis: { status: "healthy" },
        queue: { status: "healthy", size: 0 },
        executors: { status: "healthy", onlineCount: 3, totalCount: 3 },
        scheduler: { status: "healthy" },
      },
    },
  })
  async services() {
    const [db, redis, queue, executors, scheduler] = await Promise.all([
      this.healthService.checkDatabase(),
      this.healthService.checkRedis(),
      this.healthService.checkQueue(),
      this.healthService.checkExecutors(),
      this.healthService.checkScheduler(),
    ]);
    return { database: db, redis, queue, executors, scheduler };
  }

  // R-25（DEEP_REVIEW 0ef3bbe）：metrics 端点移除 @Public——
  // 暴露队列深度/executor 在线数，需 JWT 鉴权。
  @Get("metrics")
  @ApiOperation({
    summary: "System metrics (authenticated)",
    description:
      "Get key system metrics including task count, executor count, queue size, etc. Requires JWT authentication.",
  })
  @ApiResponse({
    status: 200,
    description: "System metrics",
    schema: {
      example: {
        totalTasks: 10,
        activeTasks: 8,
        runningExecutions: 2,
        totalExecutors: 3,
        onlineExecutors: 3,
        queueSize: 0,
      },
    },
  })
  async metrics() {
    const [tasks, executors, queue] = await Promise.all([
      this.healthService.checkTasks(),
      this.healthService.checkExecutors(),
      this.healthService.checkQueue(),
    ]);
    return {
      totalTasks: tasks.totalCount,
      activeTasks: tasks.activeCount,
      runningExecutions: tasks.runningCount,
      totalExecutors: executors.totalCount,
      onlineExecutors: executors.onlineCount,
      queueSize: queue.size || 0,
    };
  }
}
