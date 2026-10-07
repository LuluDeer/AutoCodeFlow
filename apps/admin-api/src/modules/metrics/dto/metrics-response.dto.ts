import { ApiProperty } from "@nestjs/swagger";

/**
 * ARCH-23 / N-12（2026-10-07 批）：metrics 域（tag "metrics"）响应体 DTO
 * ——JSON 读面 5 端点 + Prometheus 文本面 1 端点 + 两个 SSE 流此前 0 覆盖。
 * 字段与 MetricsService 实际返回逐一对齐。
 */

/** GET /metrics/summary —— 近 AGGREGATION_WINDOW_DAYS 窗口的仪表盘汇总。 */
export class MetricsSummaryResponseDto {
  @ApiProperty()
  totalTasks: number;

  @ApiProperty()
  totalExecutors: number;

  @ApiProperty({ description: "Executors with status=online" })
  onlineExecutors: number;

  @ApiProperty({ description: "Executions created since local midnight" })
  todayRuns: number;

  @ApiProperty({
    description: "Status counts over the aggregation window",
    type: "object",
    properties: {
      total: { type: "number" },
      success: { type: "number" },
      failed: { type: "number" },
      running: { type: "number" },
    },
    required: ["total", "success", "failed", "running"],
  })
  executions: {
    total: number;
    success: number;
    failed: number;
    running: number;
  };

  @ApiProperty({ description: "Percent (two decimals), 0 when no runs" })
  successRate: number;

  @ApiProperty({
    description: "Mean duration ms of successful runs in the window",
  })
  avgDurationMs: number;
}

/** GET /metrics/trend —— 按天聚合行（仅 success/failed/timeout 三类计数）。 */
export class MetricsTrendRowDto {
  @ApiProperty({
    description: "Local day bucket (ISO yyyy-mm-dd of createdAt)",
  })
  date: string;

  @ApiProperty()
  success: number;

  @ApiProperty()
  failed: number;

  @ApiProperty()
  timeout: number;
}

/** GET /metrics/executors —— 执行器负载行（轻投影，非完整实体）。 */
export class MetricsExecutorStatsRowDto {
  @ApiProperty({ format: "uuid" })
  id: string;

  @ApiProperty()
  appName: string;

  @ApiProperty()
  address: string;

  @ApiProperty({ enum: ["online", "offline"] })
  status: "online" | "offline";

  @ApiProperty({ nullable: true })
  cpuUsage: number | null;

  @ApiProperty({ nullable: true })
  memUsage: number | null;

  @ApiProperty()
  runningTaskCount: number;

  @ApiProperty({ nullable: true })
  lastHeartbeat: Date | null;
}

/** GET /metrics/failures —— 最近 10 条失败（FIX-5.2 同款轻投影 + 退出码透出）。 */
export class MetricsRecentFailureDto {
  @ApiProperty({ format: "uuid" })
  id: string;

  @ApiProperty({ format: "uuid" })
  taskId: string;

  @ApiProperty()
  taskName: string;

  @ApiProperty({ nullable: true })
  errorMessage: string | null;

  @ApiProperty({ description: "Classified failure token", nullable: true })
  failureReason: string | null;

  @ApiProperty({
    description: "Raw exit code reported by the executor (observable backfill)",
    nullable: true,
  })
  exitCode: number | null;

  @ApiProperty()
  createdAt: Date;

  @ApiProperty({ nullable: true })
  duration: number | null;
}

/** GET /metrics/scheduler —— 调度器运行面（counters/derived 快照 + 队列深度）。 */
export class MetricsSchedulerResponseDto {
  @ApiProperty({
    description:
      "Raw scheduler metric counters snapshot (SchedulerMetricsSnapshot)",
    additionalProperties: { type: "number" },
  })
  counters: Record<string, number>;

  @ApiProperty({
    description: "Derived ratios/rates computed from counters",
    additionalProperties: { type: "number" },
  })
  derived: Record<string, number>;

  @ApiProperty({
    description:
      "BullMQ queue depth (null value = Redis unavailable, NOT an empty queue)",
    type: "object",
    properties: {
      waiting: { type: "number", nullable: true },
      active: { type: "number", nullable: true },
      delayed: { type: "number", nullable: true },
      failed: { type: "number", nullable: true },
      completed: { type: "number", nullable: true },
    },
    required: ["waiting", "active", "delayed", "failed", "completed"],
  })
  queue: {
    waiting: number | null;
    active: number | null;
    delayed: number | null;
    failed: number | null;
    completed: number | null;
  };

  @ApiProperty({
    description: "Scheduler liveness snapshot (getStats)",
    type: "object",
    additionalProperties: true,
  })
  scheduler: Record<string, unknown>;

  @ApiProperty({
    description: "Emitting process identity",
    type: "object",
    properties: { pid: { type: "number" }, hostname: { type: "string" } },
    required: ["pid", "hostname"],
  })
  instance: { pid: number; hostname: string };
}
