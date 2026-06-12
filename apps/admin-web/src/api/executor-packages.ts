import { client } from './client';

export interface ExecutorPackage {
  id: string;
  name: string;
  version: string;
  type: 'node' | 'python' | 'universal';
  platform: string;
  fileSize: number;
  sha256: string;
  changelog: string;
  isLatest: boolean;
  downloadCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface InstallTokenResult {
  token: string;
  expiresIn: number;
  expiresAt: string;
}

export interface ExecutorPackageListParams {
  page?: number;
  pageSize?: number;
  type?: string;
  platform?: string;
}

export const executorPackagesApi = {
  /** 获取执行器安装包列表 */
  list: (params?: ExecutorPackageListParams) =>
    client.get<any, { items: ExecutorPackage[]; total: number }>('/executor-packages', { params }),

  /** 获取最新版本列表（每种类型/平台各取最新） */
  listLatest: () =>
    client.get<any, ExecutorPackage[]>('/executor-packages/latest'),

  /** 获取单个安装包详情 */
  get: (id: string) =>
    client.get<any, ExecutorPackage>(`/executor-packages/${id}`),

  /** 生成一次性安装 Token */
  generateInstallToken: (executorId?: string) =>
    client.post<any, InstallTokenResult>('/executor-packages/install-token', { executorId }),

  /** 获取安装脚本下载 URL */
  getInstallScriptUrl: (packageId: string, token: string): string => {
    const base = (client.defaults.baseURL ?? '').replace(/\/$/, '');
    return `${base}/executor-packages/${packageId}/install-script?token=${token}`;
  },
};
