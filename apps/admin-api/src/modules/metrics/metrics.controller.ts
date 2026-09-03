import {
  Controller,
  Get,
  NotFoundException,
  Query,
  Res,
  UseGuards,
} from "@nestjs/common";
import { Response } from "express";
import {
  ApiTags,
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
} from "@nestjs/swagger";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard";
import { MetricsService } from "./metrics.service";
import { PrometheusMetricsService } from "./prometheus-metrics.service";

@ApiTags("metrics")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller("metrics")
export class MetricsController {
  constructor(
    private readonly svc: MetricsService,
    private readonly prometheusSvc: PrometheusMetricsService,
  ) {}

  /**
   * R7: Prometheus 抓取端点（GET /api/metrics，text exposition format）。
   * 必须走 @Res() 直写（library mode，同 executor install.sh 先例）——
   * 全局 ResponseInterceptor 会把返回值包成 {code,message,data} JSON，
   * 破坏 Prometheus 文本格式；Content-Type 用 registry.contentType。
   * 鉴权与 /metrics/scheduler 一致（类级 JwtAuthGuard）。
   * METRICS_PROMETHEUS_ENABLED=false → 404：用于多实例部署下避免各实例
   * 重复暴露/被重复抓取，或安全收紧时整体关闭指标端点。
   */
  @Get()
  @ApiOperation({
    summary: "Prometheus metrics endpoint",
    description:
      "Prometheus text exposition format: scheduler counters (autoflow_scheduler_*), BullMQ queue depth gauges (autoflow_queue_*) and process default metrics (CPU/memory/GC). Requires JWT; disable entirely with METRICS_PROMETHEUS_ENABLED=false.",
  })
  @ApiResponse({
    status: 200,
    description: "Prometheus text exposition format",
  })
  @ApiResponse({
    status: 404,
    description: "Endpoint disabled via METRICS_PROMETHEUS_ENABLED=false",
  })
  async getPrometheusMetrics(@Res() res: Response): Promise<void> {
    if (!this.prometheusSvc.enabled) {
      throw new NotFoundException(
        "Prometheus metrics endpoint is disabled (METRICS_PROMETHEUS_ENABLED=false)",
      );
    }
    const body = await this.prometheusSvc.render();
    res.setHeader("Content-Type", this.prometheusSvc.contentType);
    res.end(body);
  }

  @Get("summary")
  getSummary() {
    return this.svc.getSummary();
  }

  @Get("trend")
  getDailyTrend(@Query("days") days?: string) {
    // Cap at 90 days to prevent full-table scans from unconstrained caller input
    const parsed = days ? parseInt(days, 10) : 7;
    const safeDays = Number.isNaN(parsed)
      ? 7
      : Math.min(Math.max(parsed, 1), 90);
    return this.svc.getDailyTrend(safeDays);
  }

  @Get("executors")
  getExecutorStats() {
    return this.svc.getExecutorStats();
  }

  @Get("failures")
  getRecentFailures() {
    return this.svc.getRecentFailures();
  }

  /** R4-§5.5: 调度可观测性（tick / trigger 计数器 + BullMQ 队列深度） */
  @Get("scheduler")
  getSchedulerMetrics() {
    return this.svc.getSchedulerMetrics();
  }
}
