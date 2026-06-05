import { client } from './client';

export interface Executor {
  id: string;
  appName: string;
  address: string;
  status: string;
  type?: string;
  version?: string;
  cpuUsage: number;
  memUsage: number;
  diskUsage?: number;
  networkLatency?: number;
  runningTaskCount: number;
  totalTaskCount?: number;
  failedTaskCount?: number;
  lastHeartbeat: string;
  groupName?: string | null;
  tags?: string[] | null;
  description?: string | null;
  maxConcurrentTasks?: number | null;
}

export interface ExecutorMetrics {
  executor: { id: string; address: string; status: string };
  sevenDayStats: {
    totalExecutions: number;
    successful: number;
    failed: number;
    successRate: string;
    averageDurationMs: string;
  };
  current: {
    runningTaskCount: number;
    cpuUsage?: number;
    memUsage?: number;
  };
}

export interface ExecutorExecution {
  id: string;
  taskId: string;
  taskName?: string;
  status: string;
  startTime?: string;
  endTime?: string;
  duration?: number;
  errorMessage?: string;
  createdAt: string;
}

export const executorsApi = {
  list: () => client.get<any, Executor[]>('/executors'),
  get: (id: string) => client.get<any, Executor>(`/executors/${id}`),
  update: (id: string, data: Partial<Executor>) => client.patch<any, Executor>(`/executors/${id}`, data),
  getGroups: () => client.get<any, string[]>('/executors/groups'),
  getTags: () => client.get<any, string[]>('/executors/tags'),
  rotateToken: (id: string) => client.post<any, { token: string; expiresAt: string }>(`/executors/${id}/rotate-token`),
  reloadConfig: (id: string, data: any) => client.post<any, any>(`/executors/${id}/reload-config`, data),
  getExecutions: (id: string, params?: { page?: number; limit?: number }) =>
    client.get<any, { total: number; items: ExecutorExecution[] }>(`/executors/${id}/executions`, { params }),
  getMetrics: (id: string) => client.get<any, ExecutorMetrics>(`/executors/${id}/metrics`),
};
