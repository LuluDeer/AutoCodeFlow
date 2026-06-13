import { client } from './client';

export interface Task {
  id: string;
  name: string;
  description?: string;
  runtime: string;
  entrypoint: string;
  status: string;
  triggerType: string;
  fixedRate?: number;
  cronExpression?: string;
  params?: Record<string, string | number | boolean>;
  maxRetry: number;
  timeout: number;
  applicationId?: string | null;
  executeMode?: string | null;
  executorAppName?: string | null;
  executorGroup?: string | null;
  executorTags?: string[] | null;
  dependencies?: Record<string, string> | null;
  gitRepo?: string | null;
  gitBranch?: string | null;
  gitCommit?: string | null;
  glueSource?: string | null;
  glueLanguage?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TaskExecution {
  id: string;
  taskId: string;
  taskName: string;
  status: string;
  triggerType: string;
  executorAddress?: string | null;
  startTime?: string;
  endTime?: string;
  duration?: number;
  logs?: string;
  errorMessage?: string;
  aiAnalysis?: string;
  retryCount?: number;
  taskVersion?: string | null;
  createdAt: string;
}

export interface TaskVersion {
  id: string;
  taskId: string;
  version: string;
  gitCommit?: string | null;
  snapshot: Record<string, unknown>;
  createdBy?: string | null;
  description?: string | null;
  createdAt: string;
}

export interface VersionDiff {
  [key: string]: { old: unknown; new: unknown };
}

export interface PageResult<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export const tasksApi = {
  list: (params?: { page?: number; pageSize?: number; name?: string; status?: string; runtime?: string; applicationId?: string }) =>
    client.get('/tasks', { params }) as Promise<PageResult<Task>>,
  get: (id: string) =>
    client.get(`/tasks/${id}`) as Promise<Task>,
  create: (data: Partial<Task>) =>
    client.post('/tasks', data) as Promise<Task>,
  update: (id: string, data: Partial<Task>) =>
    client.patch(`/tasks/${id}`, data) as Promise<Task>,
  delete: (id: string) => client.delete(`/tasks/${id}`),
  trigger: (id: string, params?: Record<string, any>) =>
    client.post(`/tasks/${id}/trigger`, { params }),
  executions: (id: string, p?: { page?: number; pageSize?: number }) =>
    client.get(`/tasks/${id}/executions`, { params: p }) as Promise<PageResult<TaskExecution>>,
  execution: (taskId: string, execId: string) =>
    client.get(`/tasks/${taskId}/executions/${execId}`) as Promise<TaskExecution>,
  rollback: (id: string, gitCommit: string, params?: Record<string, any>) =>
    client.post(`/tasks/${id}/rollback`, { gitCommit, params }),
  rollbackToVersion: (taskId: string, versionId: string) =>
    client.post(`/tasks/${taskId}/versions/${versionId}/rollback`) as Promise<Task>,
  compareVersions: (taskId: string, versionId1: string, versionId2: string) =>
    client.get(`/tasks/${taskId}/versions/${versionId1}/compare/${versionId2}`) as Promise<VersionDiff>,
  versions: (id: string) =>
    client.get(`/tasks/${id}/versions`) as Promise<TaskVersion[]>,
  pause: (id: string) =>
    client.post(`/tasks/${id}/pause`) as Promise<{ success: boolean; message: string }>,
  resume: (id: string) =>
    client.post(`/tasks/${id}/resume`) as Promise<{ success: boolean; message: string }>,
  batchTrigger: (taskIds: string[]) => client.post('/tasks/batch/trigger', { taskIds }),
  batchPause: (taskIds: string[]) => client.post('/tasks/batch/pause', { taskIds }),
  batchResume: (taskIds: string[]) => client.post('/tasks/batch/resume', { taskIds }),
  batchDelete: (taskIds: string[]) => client.post('/tasks/batch/delete', { taskIds }),
  stats: (id: string) =>
    client.get(`/tasks/${id}/stats`) as Promise<{ recentExecutions: TaskExecution[]; successRate: number; avgDuration: number; totalRuns: number }>,
  updateGlue: (id: string, source: string, language?: string) =>
    client.put(`/tasks/${id}/glue`, { source, language }),
  allExecutions: (params?: { page?: number; pageSize?: number; status?: string; taskId?: string; taskName?: string }) =>
    client.get('/tasks/executions/all', { params }) as Promise<PageResult<TaskExecution>>,
  killExecution: (taskId: string, execId: string) =>
    client.post(`/tasks/${taskId}/executions/${execId}/kill`) as Promise<{ success: boolean; message: string }>,
  analyzeExecution: (taskId: string, execId: string) =>
    client.post(`/tasks/${taskId}/executions/${execId}/analyze`) as Promise<{ aiAnalysis: string }>,
  schedulerStats: () =>
    client.get('/tasks/scheduler/stats') as Promise<{ healthy: boolean; activeTimers: number; activeCronTasks: number; runningTaskCount: number; totalScheduledTasks: number; uptime: number }>,
};
