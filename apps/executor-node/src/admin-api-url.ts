export function normalizeAdminApiBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, '');
  if (!trimmed) return '';
  return trimmed.endsWith('/api') ? trimmed.slice(0, -'/api'.length) : trimmed;
}

/**
 * 回调 / 任务侧 admin 基址的**优先级**：external > internal > default。
 *
 * 与 `apps/executor-python/admin_api.py::get_admin_api_base_url` 逐条对齐（该
 * 文件 docstring 即写 "Priority is external URL, then internal URL, then the
 * default URL."），也与本仓 `middleware/auth.ts::getAdminApiUrl` 同序。
 *
 * 为什么必须有单一实现：此前 `AUTOFLOW_ADMIN_API_URL` 的注入点
 * （routes/execute.ts）只读 `adminApiUrlInternal || adminApiUrl`，于是
 * `ADMIN_API_URL_EXTERNAL`（compose 与 .env.example 都在下发、admin-web 执行器
 * 配置页说明为「执行器回调优先使用的公网地址」）在执行器**自己**出站时生效
 * （auth.ts 走它），注入给**任务代码**的却是 internal 地址——同一进程对
 * "admin 在哪"给出两个答案。部署方填公网地址是想让跨网可达的回调走公网，
 * 任务侧拿到容器内网地址在该场景下必然不可达，且失败是**静默**的（任务只是
 * "回调没发出去"，终态仍由执行器补，用户看到的是中间进度丢失）。
 *
 * 落在本模块而非 config.ts：`config` 在 execute.spec / health.spec 等用例里被
 * `jest.mock('../config')` 整体替换（那些 mock 只提供部分字段），把函数挂在
 * config 上会让这些既有套件因缺函数而整片红。本模块**从未**被 mock，是放这类
 * "读 config 的纯派生"的既有位置。
 *
 * 热更友好：三个字段都在调用时现读 config（routes/config.ts 热更即改它们）。
 */
export function resolveAdminApiBaseUrl(cfg: {
  adminApiUrlExternal?: string;
  adminApiUrlInternal?: string;
  adminApiUrl?: string;
}): string {
  return cfg.adminApiUrlExternal || cfg.adminApiUrlInternal || cfg.adminApiUrl || '';
}

export function buildAdminApiUrl(baseUrl: string, path: string): string {
  const normalizedBase = normalizeAdminApiBaseUrl(baseUrl);
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  return `${normalizedBase}${normalizedPath}`;
}
