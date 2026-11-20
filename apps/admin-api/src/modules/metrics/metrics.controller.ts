import { Controller, Get, Query, Res, UseGuards } from "@nestjs/common";
import { Response } from "express";
// LANG-ERR-01：用户/抓取方可见的错误走稳定码
import { AppError } from "../../common/errors/app-error";
import {
  ApiTags,
  ApiBearerAuth,
  ApiOperation,
  ApiQuery,
  ApiResponse,
  ApiOkResponse,
} from "@nestjs/swagger";
import { Public } from "../../common/decorators/public.decorator";
import { MetricsScraperAuthGuard } from "./metrics-scraper-auth.guard";
import { MetricsService } from "./metrics.service";
// ARCH-23 / N-12（2026-10-07 批）：metrics JSON 读面响应契约。
import {
  MetricsExecutorStatsRowDto,
  MetricsRecentFailureDto,
  MetricsSchedulerResponseDto,
  MetricsSummaryResponseDto,
  MetricsTrendRowDto,
} from "./dto/metrics-response.dto";
import { PrometheusMetricsService } from "./prometheus-metrics.service";

@ApiTags("metrics")
@ApiBearerAuth()
// 全局 JwtAuthGuard（APP_GUARD）先于控制器守卫执行，必须 @Public 跳过它，
// 认证完全交给 MetricsScraperAuthGuard（共享令牌命中放行；否则其内部回落
// 走屏蔽 IS_PUBLIC 的真实 JWT 校验——未配置令牌时行为与改造前一致）。
@Public()
@UseGuards(MetricsScraperAuthGuard)
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
    description:
      "Prometheus 文本 exposition 格式：调度器计数器（autoflow_scheduler_*）、BullMQ 队列深度 gauge（autoflow_queue_*）以及进程默认指标（CPU/内存/GC）。需要 JWT；可用 METRICS_PROMETHEUS_ENABLED=false 完全关闭该端点。",
    summary: "Prometheus 指标端点",
  })
  @ApiResponse({
    status: 200,
    description: "Prometheus 文本 exposition 格式",
    content: { "text/plain": { schema: { type: "string" } } },
  })
  @ApiResponse({
    status: 404,
    description: "端点已通过 METRICS_PROMETHEUS_ENABLED=false 关闭",
  })
  async getPrometheusMetrics(@Res() res: Response): Promise<void> {
    if (!this.prometheusSvc.enabled) {
      throw new AppError("METRICS_ENDPOINT_DISABLED");
    }
    const body = await this.prometheusSvc.render();
    res.setHeader("Content-Type", this.prometheusSvc.contentType);
    res.end(body);
  }

  @Get("summary")
  // R287：`@Query("projectId") projectId?: string` 会被 Swagger 推断成
  // `required: true`（具名 @Query 拿不到 TS 的 `?`）；运行期缺省=统计全部项目。
  @ApiQuery({ name: "projectId", required: false, type: String })
  @ApiOkResponse({ type: MetricsSummaryResponseDto })
  getSummary(@Query("projectId") projectId?: string) {
    return this.svc.getSummary(projectId);
  }

  @Get("trend")
  // R287：两者运行期都可选（days 缺省 7 并钳 1..90；projectId 缺省不限项目）。
  @ApiQuery({ name: "days", required: false, type: String })
  @ApiQuery({ name: "projectId", required: false, type: String })
  @ApiOkResponse({ type: [MetricsTrendRowDto] })
  getDailyTrend(
    @Query("days") days?: string,
    @Query("projectId") projectId?: string,
  ) {
    // Cap at 90 days to prevent full-table scans from unconstrained caller input
    const parsed = days ? parseInt(days, 10) : 7;
    const safeDays = Number.isNaN(parsed)
      ? 7
      : Math.min(Math.max(parsed, 1), 90);
    return this.svc.getDailyTrend(safeDays, projectId);
  }

  @Get("executors")
  @ApiOkResponse({ type: [MetricsExecutorStatsRowDto] })
  getExecutorStats() {
    return this.svc.getExecutorStats();
  }

  @Get("failures")
  // R287：缺省走不带 where 的 repo.find 路径，属可选过滤器。
  @ApiQuery({ name: "projectId", required: false, type: String })
  @ApiOkResponse({ type: [MetricsRecentFailureDto] })
  getRecentFailures(@Query("projectId") projectId?: string) {
    return this.svc.getRecentFailures(projectId);
  }

  /** R4-§5.5: 调度可观测性（tick / trigger 计数器 + BullMQ 队列深度） */
  @Get("scheduler")
  @ApiOkResponse({ type: MetricsSchedulerResponseDto })
  getSchedulerMetrics() {
    return this.svc.getSchedulerMetrics();
  }
}
