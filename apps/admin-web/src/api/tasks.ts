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
  executorAppName?: string | null;
  executorGroup?: string | null;
  executorTags?: string[] | null;
  dependencies?: Record<string, string> | null;
  createdAt: string;
  updatedAt: string;
}

export interface TaskExecution {
  id: string;
  taskId: string;
  taskName: string;
  status: string;
  triggerType: string;
  startTime?: string;
  endTime?: string;
  duration?: number;
  logs?: string;
  errorMessage?: string;
  aiAnalysis?: string;
  createdAt: string;
}

export const tasksApi = {
  list: (params?: { page?: number; pageSize?: number }) =>
    client.get<any, any>('/tasks', { params }),
  get: (id: string) => client.get<any, Task>(`/tasks/${id}`),
  create: (data: Partial<Task>) => client.post<any, Task>('/tasks', data),
  update: (id: string, data: Partial<Task>) => client.patch<any, Task>(`/tasks/${id}`, data),
  delete: (id: string) => client.delete(`/tasks/${id}`),
  trigger: (id: string, params?: Record<string, any>) =>
    client.post(`/tasks/${id}/trigger`, { params }),
  executions: (id: string, p?: { page?: number; pageSize?: number }) =>
    client.get<any, any>(`/tasks/${id}/executions`, { params: p }),
  execution: (taskId: string, execId: string) =>
    client.get<any, TaskExecution>(`/tasks/${taskId}/executions/${execId}`),
  rollback: (id: string, gitCommit: string, params?: Record<string, any>) =>
    client.post(`/tasks/${id}/rollback`, { gitCommit, params }),
  rollbackToVersion: (taskId: string, versionId: string) =>
    client.post<any, any>(`/tasks/${taskId}/versions/${versionId}/rollback`),
  compareVersions: (taskId: string, versionId1: string, versionId2: string) =>
    client.get<any, any>(`/tasks/${taskId}/versions/${versionId1}/compare/${versionId2}`),
  versions: (id: string) => client.get<any, any>(`/tasks/${id}/versions`),
  pause: (id: string) => client.post<any, { success: boolean; message: string }>(`/tasks/${id}/pause`),
  resume: (id: string) => client.post<any, { success: boolean; message: string }>(`/tasks/${id}/resume`),
  batchTrigger: (taskIds: string[]) => client.post('/tasks/batch/trigger', { taskIds }),
  batchPause: (taskIds: string[]) => client.post('/tasks/batch/pause', { taskIds }),
  batchResume: (taskIds: string[]) => client.post('/tasks/batch/resume', { taskIds }),
  batchDelete: (taskIds: string[]) => client.post('/tasks/batch/delete', { taskIds }),
  updateGlue: (id: string, source: string, language?: string) =>
    client.put(`/tasks/${id}/glue`, { source, language }),
  schedulerStats: () =>
    client.get<any, { healthy: boolean; activeTimers: number; activeCronTasks: number; runningTaskCount: number; totalScheduledTasks: number; uptime: number }>('/tasks/scheduler/stats'),
};
