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

  @ApiProperty({ description: "status=online 的执行器数量" })
  onlineExecutors: number;

  @ApiProperty({ description: "本地零点以来创建的执行数" })
  todayRuns: number;

  @ApiProperty({
    type: "object",
    properties: {
      total: { type: "number" },
      success: { type: "number" },
      failed: { type: "number" },
      running: { type: "number" },
    },
    required: ["total", "success", "failed", "running"],
    description: "聚合窗口内的状态计数",
  })
  executions: {
    total: number;
    success: number;
    failed: number;
    running: number;
  };

  @ApiProperty({ description: "百分比（保留两位小数），无执行时为 0" })
  successRate: number;

  @ApiProperty({ description: "窗口内成功执行的平均耗时（毫秒）" })
  avgDurationMs: number;
}

/** GET /metrics/trend —— 按天聚合行（仅 success/failed/timeout 三类计数）。 */
export class MetricsTrendRowDto {
  @ApiProperty({ description: "本地日期分桶（createdAt 的 ISO yyyy-mm-dd）" })
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

  @ApiProperty({
    nullable: true,
    description: "归类后的失败原因标识",
  })
  failureReason: string | null;

  @ApiProperty({
    nullable: true,
    description: "执行器上报的原始退出码（可观测性回填）",
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
    additionalProperties: { type: "number" },
    description: "原始调度器指标计数器快照（SchedulerMetricsSnapshot）",
  })
  counters: Record<string, number>;

  @ApiProperty({
    additionalProperties: { type: "number" },
    description: "由计数器推导出的比率/速率",
  })
  derived: Record<string, number>;

  @ApiProperty({
    type: "object",
    properties: {
      waiting: { type: "number", nullable: true },
      active: { type: "number", nullable: true },
      delayed: { type: "number", nullable: true },
      failed: { type: "number", nullable: true },
      completed: { type: "number", nullable: true },
    },
    required: ["waiting", "active", "delayed", "failed", "completed"],
    description:
      "BullMQ 队列深度（值为 null 表示 Redis 不可用，**不是**空队列）",
  })
  queue: {
    waiting: number | null;
    active: number | null;
    delayed: number | null;
    failed: number | null;
    completed: number | null;
  };

  @ApiProperty({
    type: "object",
    additionalProperties: true,
    description: "调度器存活快照（getStats）",
  })
  scheduler: Record<string, unknown>;

  @ApiProperty({
    type: "object",
    properties: { pid: { type: "number" }, hostname: { type: "string" } },
    required: ["pid", "hostname"],
    description: "上报进程的身份标识",
  })
  instance: { pid: number; hostname: string };
}
