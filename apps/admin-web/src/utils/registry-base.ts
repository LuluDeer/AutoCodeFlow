/**
 * 私有仓库（npm / PyPI）安装命令的**基址推导**（2026-10-23）。
 *
 * ## 先说清楚什么是对的
 *
 * 「包注册中心」页把安装命令写成
 * `pip config set global.index-url <base>/pypi/simple/`、
 * `npm config set registry <base>/npm/`。
 *
 * `<base>` 的**正确默认值是 `window.location.origin`**——因为 `/pypi/` 与
 * `/npm/` 两块反代挂在 **admin-web 的 nginx** 上（`apps/admin-web/nginx.conf`
 * 的 `location ^~ /pypi/`、`^~ /npm/`，与 `infra/nginx/default.conf` 同步），
 * 和 SPA 同源。标准 Docker 部署下浏览器 origin 恰好就是那台 nginx。
 *
 * > 反面教材（本轮真实踩过）：一开始想「从 `VITE_API_URL_EXTERNAL` 去掉
 * > `/api` 推导」，那样得到的是 admin-api 的地址（如 `:3105`）——而
 * > **admin-api 根本不提供 /pypi、/npm**（grep 两个 nginx 配置即可确认）。
 * > 这种"推导"会把本来正确的同源地址改成必然 404 的地址。教训：先确认
 * > 路由挂在哪个服务上，再决定基址从哪来。
 *
 * ## 需要覆盖的两种真实部署
 *
 * 下面两种形态里「同源」不成立，且**只有部署方知道正确地址**：
 *
 *  1. **仓库另挂主机**：前端在 `acf.example.com`，而 /pypi、/npm 反代在
 *     `registry.example.com`（或独立 nginx）。此时命令必须指向后者。
 *  2. **前端由 CDN / 对象存储托管**：SPA 静态资源在 CDN，没有 nginx 反代，
 *     /pypi 与 /npm 在前端域名下根本不存在。
 *
 * 两者都用 `VITE_REGISTRY_BASE_URL` 显式指定（构建期注入）。
 *
 * ## 开发模式（`pnpm dev`）说明
 *
 * Vite 只代理 `/api`（见 `vite.config.ts` 的 `server.proxy`），不代理 `/pypi`。
 * 也就是说**开发态下这条命令本来就不可用**（浏览器 origin 是 :5176，那里没有
 * 仓库路由）——这不是本模块要修的缺陷，而是「开发态没有仓库反代」的既知限制。
 * 需要在本机验证安装命令时，请走 `docker compose` 的 nginx（:8088）。
 */

/** 构建期可注入的显式覆盖（绝对 URL）。 */
const EXPLICIT = (import.meta.env.VITE_REGISTRY_BASE_URL ?? '').trim();

/**
 * 解析仓库命令基址。`origin` 注入以便测试（浏览器里传 `location.origin`）。
 *
 * 返回值**不带尾部斜杠**；调用方自行拼 `/npm/` 或 `/pypi/simple/`。
 */
export function resolveRegistryBase(
  origin: string,
  explicit: string = EXPLICIT,
): string {
  const explicitUrl = explicit.trim();
  if (explicitUrl) return explicitUrl.replace(/\/+$/, '');
  return origin.trim().replace(/\/+$/, '');
}

/** 便捷封装：浏览器里直接取基址。 */
export function registryBaseUrl(): string {
  const origin =
    typeof window !== 'undefined' && window.location ? window.location.origin : '';
  return resolveRegistryBase(origin);
}
