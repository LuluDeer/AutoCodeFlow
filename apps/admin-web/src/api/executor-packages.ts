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

/**
 * 执行器一键安装命令（GET /executors/install-cmd 返回）。
 * R4-D P1-3：后端已移除引用不存在 install.sh 的 curlCmd 字段，只保留 cmd。
 */
export interface InstallCmdResult {
  cmd: string;
  token: string;
  adminApiUrl: string;
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

  /**
   * 获取最新可用安装包列表。
   * 注：后端 GET /executor-packages/latest 需要 type 参数且仅返回单个最新包（或 null），
   * 无法一次取得全部类型；这里改为拉取 active 包列表（按 createdAt 倒序，最多 100 条），
   * 由调用方按 类型+平台 自行匹配最新。
   */
  listLatest: async (): Promise<ExecutorPackage[]> => {
    const res = await client.get<{ items?: ExecutorPackage[]; total?: number }>(
      '/executor-packages',
      { params: { page: 1, pageSize: 100, status: 'active' } },
    );
    return res.items ?? [];
  },

  /** 获取单个安装包详情 */
  get: (id: string) =>
    client.get(`/executor-packages/${id}`) as Promise<ExecutorPackage>,

  /** 推送包到执行器节点（留空 executorIds = 推送所有在线执行器） */
  push: (id: string, executorIds?: string[]) =>
    client.post(`/executor-packages/${id}/push`, { executorIds }) as Promise<PushResult[]>,

  /** 上传新包 */
  upload: (formData: FormData) =>
    client.post('/executor-packages', formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
    }) as Promise<ExecutorPackage>,

  /**
   * 下载包文件并触发浏览器保存。
   * download 路由位于 JwtAuthGuard 之后且 JWT 仅从 Authorization 头提取，
   * <a href> 无法携带鉴权头（会 401），因此用 axios blob 请求 + objectURL 下载。
   */
  download: async (id: string, filename?: string): Promise<void> => {
    const blob = await client.get<Blob>(`/executor-packages/${id}/download`, {
      responseType: 'blob',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename ?? `executor-package-${id}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
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
export const downloadPackage = (id: string, filename?: string) => executorPackagesApi.download(id, filename);
