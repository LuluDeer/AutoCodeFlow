import { client } from './client';

export interface Application {
  id: string;
  name: string;
  description?: string;
  version: string;
  runtime: string;
  status: string;
  gitRepo?: string;
  gitBranch?: string;
  gitCommit?: string;
  manifest?: Record<string, any>;
  env?: Record<string, string>;
  entrypoint?: string;
  createdAt: string;
  updatedAt: string;
}

export const applicationsApi = {
  list: () => client.get<any, Application[]>('/applications'),
  get: (id: string) => client.get<any, Application>(`/applications/${id}`),
  create: (data: Partial<Application>) => client.post<any, Application>('/applications', data),
  update: (id: string, data: Partial<Application>) => client.put<any, Application>(`/applications/${id}`, data),
  delete: (id: string) => client.delete(`/applications/${id}`),
  upload: (formData: FormData) =>
    client.post<any, Application>('/applications/upload', formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
    }),
  webhook: (payload: any) => client.post<any, any>('/applications/webhook', payload),
  syncTasks: (id: string) => client.post<any, { ok: boolean; registeredCount: number }>(`/applications/${id}/sync-tasks`),
};