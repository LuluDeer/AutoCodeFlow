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
  /**
   * 后端 `executor_packages.status` 列（`ExecutorPackageStatus`：
   * `active` / `deprecated` / `uploading`）。
   *
   * 此前这里声明的是 `isLatest: boolean`——**后端从无此字段**（全仓 grep 只命中
   * 前端三处）。`ExecutorPackagesPage` 曾用它推导状态：`pkg.isLatest` 恒为
   * `undefined`，于是每个包都被显示成「已弃用」，而推送按钮的
   * `disabled={row.status !== 'active'}` 让**推送功能对全部安装包不可达**。
   * 真实取值本来就在同一个响应里（`findAll()` 原样返回 `status`），
   * 故此处改为如实声明该列。
   */
  status: 'active' | 'deprecated' | 'uploading';
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

/**
 * P1-10（UX-AUDIT-2026-09-21）：推送扇出结果。
 *
 * 后端 executor-package.service.ts 对**正在执行任务**的执行器不会立即推送，
 * 而是入队异步安装并返回 `queued: true` + `commandId`。旧前端类型只有
 * success/error，把 queued 行当成"未推送/失败"，多执行器扇出结果不可见。
 */
export interface PushResult {
  executorId: string;
  address: string;
  success: boolean;
  error?: string;
  /** 后端：执行器忙，安装已入队异步执行（不是失败，也不是立即成功） */
  queued?: boolean;
  /** 入队后由执行器异步执行的命令 id，用于后续查询状态 */
  commandId?: string;
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
