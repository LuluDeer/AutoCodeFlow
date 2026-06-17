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
  name?: string;
  status?: string;
}

export interface PushResult {
  executorId: string;
  address: string;
  success: boolean;
  error?: string;
}

export const executorPackagesApi = {
  /** 获取执行器安装包列表 */
  list: (params?: ExecutorPackageListParams) =>
    client.get('/executor-packages', { params }) as Promise<{ items: ExecutorPackage[]; total: number }>,

  /** 获取最新版本列表（每种类型/平台各取最新） */
  listLatest: () =>
    client.get('/executor-packages/latest') as Promise<ExecutorPackage[]>,

  /** 获取单个安装包详情 */
  get: (id: string) =>
    client.get(`/executor-packages/${id}`) as Promise<ExecutorPackage>,

  /** 生成一次性安装 Token */
  generateInstallToken: (executorId?: string) =>
    client.post('/executor-packages/install-token', { executorId }) as Promise<InstallTokenResult>,

  /** 推送包到执行器节点（留空 executorIds = 推送所有在线执行器） */
  push: (id: string, executorIds?: string[]) =>
    client.post(`/executor-packages/${id}/push`, { executorIds }) as Promise<PushResult[]>,

  /** 上传新包 */
  upload: (formData: FormData) =>
    client.post('/executor-packages', formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
    }) as Promise<ExecutorPackage>,

  /** 获取安装脚本下载 URL */
  getInstallScriptUrl: (packageId: string, token: string): string => {
    const base = (client.defaults.baseURL ?? '').replace(/\/$/, '');
    return `${base}/executor-packages/${packageId}/install-script?token=${token}`;
  },

  /** 下载包文件 URL */
  getDownloadUrl: (packageId: string): string => {
    const base = (client.defaults.baseURL ?? '').replace(/\/$/, '');
    return `${base}/executor-packages/${packageId}/download`;
  },

  /** 删除执行器包 */
  remove: (id: string) =>
    client.delete(`/executor-packages/${id}`) as Promise<void>,

  /** 弃用包 */
  deprecate: (id: string) =>
    client.patch(`/executor-packages/${id}/deprecate`) as Promise<ExecutorPackage>,

  /** 激活包 */
  activate: (id: string) =>
    client.patch(`/executor-packages/${id}/activate`) as Promise<ExecutorPackage>,
};

// Named exports for convenience
export const listPackages = (params?: ExecutorPackageListParams) => executorPackagesApi.list(params);
export const uploadPackage = (formData: FormData) => executorPackagesApi.upload(formData);
export const deletePackage = (id: string) => executorPackagesApi.remove(id);
export const pushPackage = (id: string, executorIds?: string[]) => executorPackagesApi.push(id, executorIds);
export const deprecatePackage = (id: string) => executorPackagesApi.deprecate(id);
export const activatePackage = (id: string) => executorPackagesApi.activate(id);
export const downloadPackageUrl = (id: string) => executorPackagesApi.getDownloadUrl(id);
