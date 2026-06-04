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
  params?: Record<string, any>;
  maxRetry: number;
  timeout: number;
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
  rollback: (id: string, gitCommit: string) =>
    client.post(`/tasks/${id}/rollback`, { gitCommit }),
};
