import type { components } from '../types/generated/api-types';
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
  /** A-10：超时计数（与 alerts.yml 告警口径 failed|timeout 对齐；Dashboard 失败曲线并入该值） */
  timeout: number;
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

/** R328 · 北极星双口径周报：单周聚合行（严格值/代理值共用同一形状，故三个计数字段均可选）。 */
// R328：北极星类型一律从 openapi 生成物派生（合同派生，不进 web-type-drift 手写棘轮）。
// 严格周（active_installs/confirmed_events）与代理周（executions）字段不同，NorthStarWeek
// 取二者 union，供只需 week_start 的视图代码复用。
export type NorthStarWeek =
  | components['schemas']['AgentNorthStarConfirmedWeekDto']
  | components['schemas']['AgentNorthStarProxyWeekDto'];

/** GET /agent/north-star/metrics —— 字段与后端 AgentNorthStarResponseDto / 脚本 buildPayload 逐字对齐。 */
export type NorthStarReport = components['schemas']['AgentNorthStarResponseDto'];

export const metricsApi = {
  // NETOPT-10-3: optional AbortSignal so polling hooks can cancel in-flight
  // requests on unmount (mirrors executors.ts ternary pattern).
  // P1-2：projectId 可选；省略 = 全部项目（全局口径），与任务/执行/应用面同一套契约。
  getSummary: (params?: { projectId?: string }, signal?: AbortSignal) =>
    signal
      ? apiClient.get<MetricsSummary>('/metrics/summary', { signal, params })
      : apiClient.get<MetricsSummary>('/metrics/summary', { params }),
  getDailyTrend: (days = 7, params?: { projectId?: string }, signal?: AbortSignal) =>
    signal
      ? apiClient.get<DailyTrend[]>(`/metrics/trend?days=${days}`, { signal, params })
      : apiClient.get<DailyTrend[]>(`/metrics/trend?days=${days}`, { params }),
  getExecutorStats: (signal?: AbortSignal) =>
    signal
      ? apiClient.get<ExecutorStat[]>('/metrics/executors', { signal })
      : apiClient.get<ExecutorStat[]>('/metrics/executors'),
  getRecentFailures: (params?: { projectId?: string }, signal?: AbortSignal) =>
    signal
      ? apiClient.get<RecentFailure[]>('/metrics/failures', { signal, params })
      : apiClient.get<RecentFailure[]>('/metrics/failures', { params }),
  getSchedulerMetrics: (signal?: AbortSignal) =>
    signal
      ? apiClient.get<SchedulerMetricsResponse>('/metrics/scheduler', { signal })
      : apiClient.get<SchedulerMetricsResponse>('/metrics/scheduler'),
  // R327/R328: GET /agent/north-star/metrics（ADMIN/JWT）——北极星双口径看板数据源。
  // 路径不带 /api 前缀（client baseURL 已含）；signal/params 条件写法与 getSummary 同范式。
  getNorthStar: (params?: { as_of?: string }, signal?: AbortSignal) =>
    signal
      ? apiClient.get<NorthStarReport>('/agent/north-star/metrics', { signal, params })
      : apiClient.get<NorthStarReport>('/agent/north-star/metrics', { params }),
};
