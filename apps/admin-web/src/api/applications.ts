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

export interface AppDeployment {
  id: string;
  applicationId: string;
  application?: Application;
  executorId: string | null;
  executorAddress: string;
  status: 'pending' | 'deploying' | 'running' | 'stopped' | 'failed' | 'upgrading';
  runMode: 'once' | 'daemon' | 'scheduled';
  deployedCommit: string | null;
  deployedVersion: string | null;
  startCommand: string | null;
  env: Record<string, string> | null;
  pid: number | null;
  lastHeartbeat: string | null;
  statusMessage: string | null;
  deployedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateDeploymentDto {
  executorId: string;
  runMode?: 'once' | 'daemon' | 'scheduled';
  env?: Record<string, string>;
  startCommand?: string;
}

export const applicationsApi = {
  list: () => client.get<any, Application[]>('/applications'),
  get: (id: string) => client.get<any, Application>(`/applications/${id}`),
  create: (data: Partial<Application>) => client.post<any, Application>('/applications', data),
  update: (id: string, data: Partial<Application>) => client.put<any, Application>(`/applications/${id}`, data),
  delete: (id: string) => client.delete(`/applications/${id}`),
  upload: (formData: FormData) =>
    client.post<any, Application>('/applications/upload', formData),
  webhook: (payload: any) => client.post<any, any>('/applications/webhook', payload),
  syncTasks: (id: string) => client.post<any, { ok: boolean; registeredCount: number }>(`/applications/${id}/sync-tasks`),
};

export const deploymentsApi = {
  list: (applicationId?: string) =>
    client.get<any, AppDeployment[]>('/app-deployments', { params: applicationId ? { applicationId } : {} }),
  get: (id: string) => client.get<any, AppDeployment>(`/app-deployments/${id}`),
  deploy: (appId: string, dto: CreateDeploymentDto) =>
    client.post<any, AppDeployment>(`/app-deployments/applications/${appId}/deploy`, dto),
  upgrade: (id: string) => client.post<any, AppDeployment>(`/app-deployments/${id}/upgrade`),
  stop: (id: string) => client.post<any, AppDeployment>(`/app-deployments/${id}/stop`),
};