import { Controller, Get } from "@nestjs/common";
import { ApiTags, ApiOperation, ApiResponse } from "@nestjs/swagger";
import { HealthService } from "./health.service";
import { Public } from "../../common/decorators/public.decorator";

@ApiTags("Health Check")
@Controller("health")
export class HealthController {
  constructor(private readonly healthService: HealthService) {}

  @Public()
  @Get()
  @ApiOperation({
    summary: "Full health check",
    description:
      "Check health of all core services including database, Redis, message queue, executors, and scheduler. Returns detailed health status and metrics.",
  })
  @ApiResponse({
    status: 200,
    description: "Health check result",
    schema: {
      example: {
        status: "healthy",
        timestamp: "2024-01-01T12:00:00Z",
        services: {
          database: { status: "healthy" },
          redis: { status: "healthy" },
          queue: { status: "healthy", size: 0 },
          executors: { status: "healthy", onlineCount: 3, totalCount: 3 },
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
          { name: "scheduler", status: "healthy" },
        ],
      },
    },
  })
  async health() {
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

  @Public()
  @Get("services")
  @ApiOperation({
    summary: "Service status",
    description: "Get health status details for each core service.",
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

  @Public()
  @Get("metrics")
  @ApiOperation({
    summary: "System metrics",
    description: "Get key system metrics including task count, executor count, queue size, etc.",
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
