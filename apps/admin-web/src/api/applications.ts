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

/**
 * DEP-01：统一发布追溯行（GET /applications/:id/releases）。
 * 一行 = 一次版本发布：版本快照（application_versions）+ 该版本最近一次部署
 * （app_deployments）两语义面合并。与后端 dto/app-release.dto.ts 逐字段对齐。
 */
export interface AppReleaseRow {
  /** application_versions.id；纯部署历史（无版本快照行）时 null */
  id: string | null;
  version: string | null;
  /** 部署当时的包地址（snapshot.packageUrl，不回退应用当前值）；无快照 null */
  packageUrl: string | null;
  gitCommit: string | null;
  /** 该版本最近一次部署完成时刻（deployedAt ?? createdAt 最大值）；无部署 null */
  deployedAt: string | null;
  latestDeploymentId: string | null;
  /** 最近一次部署状态（pending/deploying/running/stopped/failed/upgrading）；无部署 null */
  deploymentStatus: string | null;
  /** 该版本累计部署次数（同版本多实例/多次部署各计一次） */
  deploymentCount: number;
  executorAddress: string | null;
  /** 执行模式 once/daemon/scheduled；无部署 null */
  runMode: string | null;
  /** 触发方式（推导语义：upgrade/manual/unknown）；无部署 null */
  triggerType: 'upgrade' | 'manual' | 'unknown' | null;
  /** 操作人：application_versions.createdBy——当前恒 null（来源缺失如实标注） */
  operator: string | null;
  operatorSource: 'application_versions.createdBy';
  operatorMissingReason: string;
  sourceDeploymentId: string | null;
  /** application_versions.status（released/deploying/failed）；纯部署行时为部署状态字符串 */
  status: string;
  /** 版本行创建时刻（快照诞生时间）；纯部署行时为 deployedAt */
  createdAt: string | null;
  /** 部署记录合成行（从未保存版本快照的历史数据，deployedVersion=null 归一 version=null） */
  synthetic: boolean;
}

export interface AppReleasesPage {
  data: AppReleaseRow[];
  total: number;
  page: number;
  pageSize: number;
}

export const applicationsApi = {
  list: (signal?: AbortSignal) =>
    signal
      ? client.get<Application[]>('/applications', { signal })
      : client.get<Application[]>('/applications'),
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
  // DEP-01：统一发布追溯视图（版本 × 最近一次部署），分页（pageSize 默认 50、上限 200）
  getReleases: (id: string, page = 1, pageSize = 50) =>
    client.get<AppReleasesPage>(`/applications/${id}/releases`, {
      params: { page, pageSize },
    }),
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
