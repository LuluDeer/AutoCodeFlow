import { client as apiClient } from './client';

export interface MetricsSummary {
  totalTasks: number;
  todayRuns?: number;
  totalExecutors: number;
  onlineExecutors: number;
  executions: { total: number; success: number; failed: number; running: number };
  successRate: number;
  avgDurationMs: number;
}

export interface DailyTrend {
  date: string;
  success: number;
  failed: number;
}

export interface ExecutorStat {
  id: string;
  appName: string;
  address: string;
  status: string;
  cpuUsage: number;
  memUsage: number;
  runningTaskCount: number;
  lastHeartbeat: string;
}

export interface RecentFailure {
  id: string;
  taskId: string;
  taskName: string;
  errorMessage: string;
  /** 后端 /metrics/failures 已透出（metrics.service.ts select）：失败分类 */
  failureReason?: string | null;
  /** 回调上报的原始退出码；null = 旧数据未采集 */
  exitCode?: number | null;
  createdAt: string;
  duration: number;
}

/** GET /metrics/scheduler —— R4-§5.5 调度可观测性快照（UI-04 ④消费） */
export interface SchedulerCounters {
  ticks: number;
  tickDurationMsTotal: number;
  lastTickDurationMs: number;
  lastTickAt: string | null;
  triggersClaimed: number;
  triggersSkippedLockHeld: number;
  triggersSkippedDbClaim: number;
  triggersSkippedInactive: number;
  triggersSkippedBlockStrategy: number;
  triggersSkippedMaintenance: number;
  triggersFailed: number;
  dependencyTriggersClaimed: number;
  dependencyTriggersSkipped: number;
  /** CORE-06：定时触发 fire→入队延迟直方图（与 TRIGGER_LATENCY_BUCKETS_MS 对齐） */
  triggerLatencyCount: number;
  triggerLatencySumMs: number;
  triggerLatencyBuckets: number[];
  lastTriggerLatencyMs: number;
  startedAt: string;
}

export interface SchedulerDerived {
  avgTickDurationMs: number;
  tickRatePerSec: number;
  triggerClaimRatePerSec: number;
  avgTriggerLatencyMs: number;
  p99TriggerLatencyMs: number;
}

export interface SchedulerMetricsResponse {
  counters: SchedulerCounters;
  derived: SchedulerDerived;
  queue: {
    waiting: number | null;
    active: number | null;
    delayed: number | null;
    failed: number | null;
    completed: number | null;
  };
  scheduler: {
    healthy: boolean;
    isLeader: boolean;
    activeTimers: number;
    activeCronTasks: number;
    runningTaskCount: number;
    totalScheduledTasks: number;
    uptime: number;
  };
  instance: { pid: number; hostname: string };
}

export const metricsApi = {
  getSummary: () => apiClient.get<MetricsSummary>('/metrics/summary'),
  getDailyTrend: (days = 7) => apiClient.get<DailyTrend[]>(`/metrics/trend?days=${days}`),
  getExecutorStats: () => apiClient.get<ExecutorStat[]>('/metrics/executors'),
  getRecentFailures: () => apiClient.get<RecentFailure[]>('/metrics/failures'),
  getSchedulerMetrics: () => apiClient.get<SchedulerMetricsResponse>('/metrics/scheduler'),
};
