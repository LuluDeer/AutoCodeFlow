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
  manifest?: Record<string, unknown>;
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
  executorId?: string;
  runMode?: 'once' | 'daemon' | 'scheduled';
  env?: Record<string, string>;
  startCommand?: string;
}

export interface VersionHistoryEntry {
  deploymentId: string;
  version: string | null;
  commit: string | null;
  status: string;
  deployedAt: string | null;
  executorAddress: string;
}

export const applicationsApi = {
  list: () => client.get<Application[]>('/applications'),
  get: (id: string) => client.get<Application>(`/applications/${id}`),
  create: (data: Partial<Application>) => client.post<Application>('/applications', data),
  update: (id: string, data: Partial<Application>) =>
    client.put<Application>(`/applications/${id}`, data),
  delete: (id: string) => client.delete<void>(`/applications/${id}`),
  upload: (formData: FormData) =>
    client.post<Application>('/applications/upload', formData),
  webhook: (payload: unknown) => client.post<{ ok: boolean }>('/applications/webhook', payload),
  syncTasks: (id: string) =>
    client.post<{ ok: boolean; registeredCount: number }>(`/applications/${id}/sync-tasks`),
  upgradeAll: (id: string) =>
    client.post<{ ok: boolean; total: number; succeeded: number; failed: number }>(`/applications/${id}/upgrade-all`),
  getVersionHistory: (id: string) =>
    client.get<VersionHistoryEntry[]>(`/applications/${id}/versions`),
  rollback: (appId: string, deploymentId: string) =>
    client.post<{ ok: boolean; rolledBackTo: string | null; total: number; succeeded: number; failed: number }>(
      `/applications/${appId}/rollback/${deploymentId}`,
    ),
};

export const deploymentsApi = {
  list: (applicationId?: string, page = 1, pageSize = 20) =>
    client.get<{ data: AppDeployment[]; total: number }>('/app-deployments', {
      params: { ...(applicationId ? { applicationId } : {}), page, pageSize },
    }),
  get: (id: string) => client.get<AppDeployment>(`/app-deployments/${id}`),
  deploy: (appId: string, dto: CreateDeploymentDto) =>
    client.post<AppDeployment>(`/app-deployments/applications/${appId}/deploy`, dto),
  upgrade: (id: string) =>
    client.post<AppDeployment>(`/app-deployments/${id}/upgrade`),
  stop: (id: string) =>
    client.post<AppDeployment>(`/app-deployments/${id}/stop`),
};
