/**
 * R106（SEC-NAV-PIN）：**导航白名单判定** —— 纯函数，不 import electron。
 *
 * ## 原来的判据为什么不够
 *
 * `window-manager.ts` 的 `will-navigate` 此前是：
 *
 * ```ts
 * const allowed = devUrl ? url.startsWith(devUrl) : url.startsWith('file://');
 * ```
 *
 * 生产分支 `startsWith('file://')` 等于**放行任意本地文件**。而导航发生后 **preload 桥仍然挂着**
 * （`contextBridge` 是按 webContents 挂的，不随页面变），于是「导航到一个本地 HTML」= 「该页面拿到
 * 整套 `electronAPI`」。当前渲染层没有任何设置 `location` 的能力（R102-A1 的 D 轴守卫也会拦住新增），
 * 所以这不是**可直接利用**的洞 —— 但它是「靠没人用」，不是「用不了」。
 *
 * ## 判据
 *
 * - 开发：仍是 `devUrl` 前缀（那是 Vite dev server，天然单一来源）；
 * - 生产：只允许**本应用入口页本身**（`pathToFileURL(RENDERER_INDEX)`），忽略 `#hash` 与 `?query`
 *   （SPA 路由用 hash，属于同一页面）；
 * - 其它一切（`file://` 其它路径、`http(s):`、`javascript:`、`data:`、解析失败）**一律拒绝** —— fail-closed。
 *
 * 比较用 `URL` 归一后的字符串而不是原始文本：`file:///C:/x/../y` 与 Windows 大小写差异都会被归一，
 * 避免「文本不等但实际同一文件」被误杀，也避免「文本相同但实际不同」被误放。
 */

export interface NavigationPolicy {
  /** 开发模式的 dev server 基址（`VITE_DEV_SERVER_URL`）；为空表示生产形态。 */
  readonly devUrl?: string | null;
  /** 生产形态下唯一允许的页面：入口 index.html 的 `file://` URL。 */
  readonly rendererFileUrl?: string | null;
}

/** 去掉 hash / query 后的归一 URL 字符串；解析失败返回 null。 */
function normalized(url: string): string | null {
  try {
    const u = new URL(url);
    u.hash = '';
    u.search = '';
    return u.toString();
  } catch {
    return null;
  }
}

/**
 * 是否允许导航到 `rawUrl`。**fail-closed**：任何不确定的情况都返回 false。
 */
export function isAllowedNavigation(
  rawUrl: string,
  policy: NavigationPolicy,
): boolean {
  if (typeof rawUrl !== 'string' || rawUrl.length === 0) return false;
  const devUrl = policy.devUrl ?? null;
  if (devUrl) {
    // dev 形态：只认 dev server 前缀（生产分支不应在这种情况下生效）。
    return rawUrl.startsWith(devUrl);
  }
  const renderer = policy.rendererFileUrl ?? null;
  if (!renderer) return false;
  const target = normalized(rawUrl);
  const base = normalized(renderer);
  if (target === null || base === null) return false;
  if (!target.startsWith('file://')) return false;
  return target === base;
}
