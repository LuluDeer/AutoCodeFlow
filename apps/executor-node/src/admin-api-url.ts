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

/**
 * 2026-10-30（生产故障 `package_fetch_failed: … Client network socket
 * disconnected before secure TLS connection was established`）：
 * 把 admin 下发的 `packageUrl` **同源改写**到本执行器自己配置的 admin 地址。
 *
 * ## 为什么必须改
 *
 * `packageUrl` 由 admin-api 用**全局单一** `API_BASE_URL` 拼出（
 * application.controller.ts:453）。一个中台同时服务两类执行器时这个值必然
 * 只能二选一：
 *   · 填公网域名 → 局域网执行器每次下包都要绕公网 VPS 再经 frp 隧道回来，
 *     TLS 握手 RTT 被放大到 180ms+，跨境/隧道链路上单次握手中断概率约 4.5%，
 *     于是「偶发下载失败」被记成任务失败（现场症状：手工重试往往就成功）；
 *   · 填内网地址 → 跨网执行器不可达。
 *
 * 执行器自己知道「我怎么访问中台」（`ADMIN_API_URL*`，也是它心跳/回调/pull
 * 实际在用的地址），所以下载也应该走同一条路——这正是用户问的
 * 「不是默认使用执行器内配置的 URL 吗」。
 *
 * ## 改写规则（保守，宁可不动）
 *
 * 仅当**全部**满足时改写，否则原样返回：
 *   1. packageUrl 是 http(s) 绝对 URL；
 *   2. 它的路径落在 `/uploads/` 下（只有这条路径由本中台自己托管；其他路径
 *      可能是外链/CDN，改写会破坏）；
 *   3. 解析出的 host 与「admin 基址的 host」**不同**（同源就无需改写）；
 *   4. 本执行器解析出的 admin 基址非空且是 http(s)。
 *
 * 只替换 scheme+host+port，**路径与查询串逐字节保留**（内容寻址路径里有
 * sha256，改一个字就 404）。
 *
 * 安全说明：改写目标是本执行器自己配置的管理端地址（不是 packageUrl 里
 * 攻击者可控的部分），且改写后的 URL 仍要过 ssrf-guard；不引入新的
 * SSRF 面——packageUrl 本身就是中台下发的可信值，host 部分被替换成更可信的
 * 本地配置。
 */
export function rewritePackageUrlToAdminBase(
  packageUrl: string,
  cfg: {
    adminApiUrlExternal?: string;
    adminApiUrlInternal?: string;
    adminApiUrl?: string;
  },
): string {
  try {
    const target = new URL(packageUrl);
    if (target.protocol !== 'http:' && target.protocol !== 'https:') {
      return packageUrl;
    }
    // 只接管本中台自托管的包下载路径
    if (!target.pathname.startsWith('/uploads/')) return packageUrl;

    const base = normalizeAdminApiBaseUrl(resolveAdminApiBaseUrl(cfg));
    if (!base) return packageUrl;

    const baseUrl = new URL(base);
    if (baseUrl.protocol !== 'http:' && baseUrl.protocol !== 'https:') {
      return packageUrl;
    }
    // 同源（协议+主机+端口都一致）→ 不改写，避免无意义的字符串往返
    if (baseUrl.origin === target.origin) return packageUrl;

    return `${baseUrl.origin}${target.pathname}${target.search}`;
  } catch {
    // packageUrl 非法 / 基址非法：交给下游的 ssrf-guard 与原错误路径处理
    return packageUrl;
  }
}
