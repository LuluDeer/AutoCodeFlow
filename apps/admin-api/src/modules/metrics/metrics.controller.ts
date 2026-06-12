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
    return this.svc.getDailyTrend(days ? parseInt(days, 10) : 7);
  }

  @Get("executors")
  getExecutorStats() {
    return this.svc.getExecutorStats();
  }

  @Get("failures")
  getRecentFailures() {
    return this.svc.getRecentFailures();
  }
}
