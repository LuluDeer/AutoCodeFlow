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
  /**
   * §2.1（推广到 `GET /executor-packages`）：**可选**的不透明 keyset 游标。
   *
   * 三态语义（**不许混成一个**，与 `tasksApi.allExecutions` 逐字同规）：
   *   · `undefined`（或键不存在）→ 请求里**没有** `cursor` 参数 → 后端走原有
   *     OFFSET 分页，响应与加游标分页之前**逐字节一致**（连 `nextCursor` 都不出现）；
   *   · `''`（空串）→ 序列化成 `cursor=` → 后端识别为「keyset 起点」，从最新
   *     一行开始翻（响应含 `nextCursor`）。注意 `if (cursor)` 会把 `''` 当没传，
   *     正好踩掉起点语义（见 `list` 里的显式归一）；
   *   · 非空串 → 上一页响应的 `nextCursor`，**当作不透明令牌原样回传**，禁止解析；
   *     非法游标后端返回 400（VALIDATION_FAILED），不会静默退回第一页。
   */
  cursor?: string;
}

/**
 * `GET /executor-packages` 的响应形状。
 *
 * ⚠️ 本端点返回**裸 `{items,total}`**，不是 `paginate()` 双键信封（与 tasks 域
 * 不同源，见后端 `ExecutorPackageService.findAll` 头注）。keyset 分支也**不改变**
 * 这个形状，只**追加** `nextCursor`——刻意如此：`items` 同时被包表
 * （`listPackages`）与安装向导的 `listLatest` 消费，改成信封会让 `res.items`
 * 变 undefined、包表恒空。
 *
 * `nextCursor` 因此是 `?:` 而非 `| null`：`undefined`（键缺失 = 走的 OFFSET
 * 路径）与 `null`（keyset 路径且已翻完）是两种不同语义，读侧必须分开处理。
 */
export interface ExecutorPackageListResult {
  items: ExecutorPackage[];
  total: number;
  /** keyset 分支专有：字符串 = 下一页令牌，`null` = 末页。OFFSET 分支该键不存在。 */
  nextCursor?: string | null;
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
  /** 遗留 P1-10：后端 per-executor 状态（queued/success/error），优先于布尔字段 */
  status?: 'queued' | 'success' | 'error';
}

export const executorPackagesApi = {
  /**
   * 获取执行器安装包列表（OFFSET / keyset 双路径）。
   *
   * `cursor` 的三态语义见 `ExecutorPackageListParams#cursor`。第 ① 条（不带
   * cursor）**不依赖 axios 的序列化细节**：下面显式把值为 `undefined` 的
   * cursor 键删掉——"不带参数"是本函数自己的保证，而不是某个库版本的未成文
   * 行为。「旧路径逐字节不变」是硬要求，不该押在别人身上。
   *
   * 注意判据是 `=== undefined` 而不是 `!params.cursor`——后者会把空串一起删掉，
   * keyset 起点就永远进不去。
   */
  list: (params?: ExecutorPackageListParams) => {
    let query = params;
    if (query && query.cursor === undefined) {
      const { cursor: _omit, ...rest } = query;
      void _omit;
      query = rest;
    }
    return client.get('/executor-packages', { params: query }) as Promise<ExecutorPackageListResult>;
  },

  /**
   * 获取最新可用安装包列表（安装向导 step 2 的候选来源）。
   *
   * 注：后端 GET /executor-packages/latest 需要 type 参数且仅返回单个最新包（或 null），
   * 无法一次取得全部类型；这里改为拉取 active 包列表（按 createdAt 倒序，最多 100 条），
   * 由调用方按 类型+平台 自行匹配最新。
   *
   * ⚠️ **不得改成走 keyset**：本函数走的是同一个 `GET /executor-packages` 端点，
   * 但它要的是"最新 100 个 active 包"这一**固定切片**，不是"翻页"。它**不传
   * cursor**，故后端仍走 OFFSET 分支、响应形态与加游标之前**逐字节一致**。
   * 给它加 cursor 会让返回集变成"游标之后的一页"，向导的候选列表就随上一次
   * 翻页而变——那是本页游标化的副作用泄漏到别的功能。已有用例钉住这条
   * （executor-packages-keyset-paging.test.tsx）。
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

  /**
   * 上传新包。B-12：可选 onUploadProgress 透传 axios 上传进度事件，
   * 页面据此渲染真实进度条（此前大文件上传期间零反馈）。
   */
  upload: (
    formData: FormData,
    onUploadProgress?: (progressEvent: { loaded: number; total?: number }) => void,
  ) =>
    client.post('/executor-packages', formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
      onUploadProgress,
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
export const uploadPackage = (
  formData: FormData,
  onUploadProgress?: (progressEvent: { loaded: number; total?: number }) => void,
) => executorPackagesApi.upload(formData, onUploadProgress);
export const deletePackage = (id: string) => executorPackagesApi.remove(id);
export const pushPackage = (id: string, executorIds?: string[]) => executorPackagesApi.push(id, executorIds);
export const deprecatePackage = (id: string) => executorPackagesApi.deprecate(id);
export const activatePackage = (id: string) => executorPackagesApi.activate(id);
export const downloadPackage = (id: string, filename?: string) => executorPackagesApi.download(id, filename);
