import { Controller, Get, Query, UseGuards } from "@nestjs/common";
import { ApiTags, ApiBearerAuth } from "@nestjs/swagger";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard";
import { MetricsService } from "./metrics.service";

@ApiTags("metrics")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller("metrics")
export class MetricsController {
  constructor(private readonly svc: MetricsService) {}

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
