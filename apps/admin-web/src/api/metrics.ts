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
  createdAt: string;
  duration: number;
}

export const metricsApi = {
  getSummary: () => apiClient.get<MetricsSummary>('/metrics/summary'),
  getDailyTrend: (days = 7) => apiClient.get<DailyTrend[]>(`/metrics/trend?days=${days}`),
  getExecutorStats: () => apiClient.get<ExecutorStat[]>('/metrics/executors'),
  getRecentFailures: () => apiClient.get<RecentFailure[]>('/metrics/failures'),
};
