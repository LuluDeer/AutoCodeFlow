import { Controller, Get } from "@nestjs/common";
import { ApiTags, ApiOperation, ApiResponse } from "@nestjs/swagger";
import { HealthService } from "./health.service";
import { Public } from "../../common/decorators/public.decorator";

@ApiTags("健康检查")
@Controller("health")
export class HealthController {
  constructor(private readonly healthService: HealthService) {}

  @Public()
  @Get()
  @ApiOperation({
    summary: "完整健康检查",
    description:
      "检查所有核心服务的健康状态，包括数据库、Redis、消息队列、执行器和调度器。返回详细的健康状态和指标。",
  })
  @ApiResponse({
    status: 200,
    description: "健康检查结果",
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
    summary: "存活检查",
    description:
      "简单的存活检查，仅返回服务是否运行。用于 Kubernetes liveness probe。",
  })
  @ApiResponse({
    status: 200,
    description: "服务存活",
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
    summary: "就绪检查",
    description:
      "检查服务是否准备好接收请求。验证数据库和 Redis 连接。用于 Kubernetes readiness probe。",
  })
  @ApiResponse({
    status: 200,
    description: "就绪检查结果",
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
    summary: "服务状态",
    description: "获取各个核心服务的健康状态详情。",
  })
  @ApiResponse({
    status: 200,
    description: "服务状态列表",
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
    summary: "系统指标",
    description: "获取系统关键指标，包括任务数、执行器数、队列大小等。",
  })
  @ApiResponse({
    status: 200,
    description: "系统指标",
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
