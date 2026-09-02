import { client } from './client';

export interface Executor {
  id: string;
  appName: string;
  address: string;
  status: string;
  type?: string;
  executorVersion?: string;
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

export interface SharedTokenResult {
  token: string | null;
  hasToken: boolean;
}

export const executorsApi = {
  getSharedToken: () =>
    client.get('/config/executor-shared-token') as Promise<SharedTokenResult>,
  generateSharedToken: () =>
    client.post('/config/executor-shared-token/generate') as Promise<{ token: string }>,
  list: () => client.get('/executors') as Promise<Executor[]>,
  get: (id: string) => client.get(`/executors/${id}`) as Promise<Executor>,
  update: (id: string, data: Partial<Executor>) =>
    client.patch(`/executors/${id}`, data) as Promise<Executor>,
  getGroups: () => client.get('/executors/groups') as Promise<string[]>,
  getTags: () => client.get('/executors/tags') as Promise<string[]>,
  rotateToken: (id: string) =>
    client.post(`/executors/${id}/rotate-token`) as Promise<{ token: string; expiresAt: string }>,
  reloadConfig: (id: string, data: {
    maxConcurrentTasks?: number;
    taskTimeoutSeconds?: number;
    heartbeatIntervalSeconds?: number;
    adminApiUrl?: string;
    adminApiUrlInternal?: string;
    adminApiUrlExternal?: string;
  }) =>
    client.post(`/executors/${id}/reload-config`, data) as Promise<void>,
  setOffline: (id: string) =>
    client.post(`/executors/${id}/set-offline`) as Promise<Executor>,
  getExecutions: (id: string, params?: { page?: number; pageSize?: number }) =>
    client.get(`/executors/${id}/executions`, { params }) as Promise<{ total: number; items: ExecutorExecution[] }>,
  getMetrics: (id: string) =>
    client.get(`/executors/${id}/metrics`) as Promise<ExecutorMetrics>,
};
