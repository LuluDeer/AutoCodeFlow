import { Controller, Get, Res } from "@nestjs/common";
import type { Response } from "express";
import { ApiTags, ApiOperation, ApiOkResponse } from "@nestjs/swagger";
import { HealthService } from "./health.service";
import { Public } from "../../common/decorators/public.decorator";
import {
  DetailedHealthDto,
  HealthMetricsDto,
  HealthServicesDto,
  PublicHealthDto,
} from "../../common/dto/misc-2xx-response.dto";

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
    description:
      "公开健康检查。仅返回整体状态（healthy/degraded/unhealthy）与时间戳。详细指标（执行器数量、队列深度、任务计数）见 GET /health/detailed（需要 JWT）。",
    summary: "基础健康检查",
  })
  @ApiOkResponse({ type: PublicHealthDto })
  async health() {
    return this.healthService.getPublicHealth();
  }

  /**
   * R-25（DEEP_REVIEW 0ef3bbe）：详细健康指标端点——需 JWT 鉴权（无 @Public）。
   * 包含 db/redis/queue/executors/tasks/scheduler 五组件详情与 metrics。
   */
  @Get("detailed")
  @ApiOperation({
    description:
      "完整的详细健康状态与指标，包括数据库、Redis、消息队列、执行器与调度器。需要 JWT 认证。仅需公开状态时请用 GET /health。",
    summary: "详细健康检查（需认证）",
  })
  @ApiOkResponse({ type: DetailedHealthDto })
  async detailed() {
    return this.healthService.getFullHealth();
  }

  @Public()
  @Get("live")
  @ApiOperation({
    description:
      "简单的存活检查，返回服务是否在运行。用于 Kubernetes 存活探针。",
    summary: "存活检查",
  })
  @ApiOkResponse({
    type: PublicHealthDto,
    description: "{status:'healthy'}——恒 200",
  })
  async live() {
    return this.healthService.getLiveness();
  }

  @Public()
  @Get("ready")
  @ApiOperation({
    description:
      "检查服务是否已就绪、可接受请求。校验数据库与 Redis 连接。用于 Kubernetes 就绪探针。",
    summary: "就绪检查",
  })
  // A3（DEEP_REVIEW §七 · executor-protocol）：此前本端点**恒返 200**——不就绪
  // 只在 body 里写 `status:"not_ready"`。而 K8s readinessProbe / 主流 LB 只看
  // HTTP 状态码，等于 DB 与 Redis 全挂了也不会被摘流量，就绪探针形同虚设。
  // 现在按契约返回 503（payload 形状不变，仍经全局响应信封落在 `data` 下）。
  @ApiOkResponse({
    type: PublicHealthDto,
    description:
      "status=ready|not_ready + timestamp；503 由 passthrough 状态码承载",
  })
  async ready(@Res({ passthrough: true }) res: Response) {
    const readiness = await this.healthService.getReadiness();
    res.status(readiness.status === "ready" ? 200 : 503);
    return readiness;
  }

  // R-25（DEEP_REVIEW 0ef3bbe）：services/metrics 端点移除 @Public——
  // 它们暴露 executor 在线数、队列深度等内部指标，需 JWT 鉴权。
  @Get("services")
  @ApiOperation({
    description: "获取各核心服务的健康状态详情。需要 JWT 认证。",
    summary: "服务状态（需认证）",
  })
  @ApiOkResponse({ type: HealthServicesDto })
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
    description:
      "获取关键系统指标，包括任务数、执行器数、队列长度等。需要 JWT 认证。",
    summary: "系统指标（需认证）",
  })
  @ApiOkResponse({ type: HealthMetricsDto })
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
