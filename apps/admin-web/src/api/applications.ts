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
  /** DEP-04: 开启后新部署冻结为待审批，需第二人批准后才派发 */
  approvalRequired?: boolean;
  createdAt: string;
  updatedAt: string;
}

/** DEP-04: 审批痕迹（approvalMeta 列的读面形状）。 */
export interface DeploymentApprovalMeta {
  requestedBy?: number | null;
  requestedByName?: string | null;
  requestedAt?: string;
  actedBy?: number | null;
  actedByName?: string | null;
  actedAt?: string;
  reason?: string | null;
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
  /** DEP-04: 审批推进状态（null=非审批路径） */
  approvalStatus?: 'pending_approval' | 'approved' | 'rejected' | 'cancelled' | null;
  approvalMeta?: DeploymentApprovalMeta | null;
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
  id?: string;
  sourceDeploymentId?: string | null;
  createdAt?: string;
  snapshot?: unknown;
  deployCount?: number;
  deploymentId: string | null;
  version: string | null;
  commit: string | null;
  status: string;
  deployedAt: string | null;
  executorAddress: string | null;
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
  rollback: (appId: string, targetId: string) =>
    client.post<{ ok: boolean; rolledBackTo: string | null; total: number; succeeded: number; failed: number }>(
      `/applications/${appId}/rollback/${targetId}`,
    ),
};

export const deploymentsApi = {
  list: (applicationId?: string, page = 1, pageSize = 20, approvalStatus?: string) =>
    client.get<{ data: AppDeployment[]; total: number }>('/app-deployments', {
      params: {
        ...(applicationId ? { applicationId } : {}),
        ...(approvalStatus ? { approvalStatus } : {}),
        page,
        pageSize,
      },
    }),
  get: (id: string) => client.get<AppDeployment>(`/app-deployments/${id}`),
  deploy: (appId: string, dto: CreateDeploymentDto) =>
    client.post<AppDeployment>(`/app-deployments/applications/${appId}/deploy`, dto),
  upgrade: (id: string) =>
    client.post<AppDeployment>(`/app-deployments/${id}/upgrade`),
  stop: (id: string) =>
    client.post<AppDeployment>(`/app-deployments/${id}/stop`),
  // DEP-04: 审批三动作（后端 @Roles(ADMIN) + 第二人规则）
  approve: (id: string, reason?: string) =>
    client.post<AppDeployment>(`/app-deployments/${id}/approval/approve`, reason ? { reason } : {}),
  reject: (id: string, reason?: string) =>
    client.post<AppDeployment>(`/app-deployments/${id}/approval/reject`, reason ? { reason } : {}),
  cancel: (id: string) =>
    client.post<AppDeployment>(`/app-deployments/${id}/approval/cancel`),
};
