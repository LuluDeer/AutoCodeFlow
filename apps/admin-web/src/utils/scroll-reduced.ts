/**
 * T1（P2，WCAG 2.3.3 Animation from Interactions）：JS 显式
 * `behavior: 'smooth'` 不受 index.css 的 `@media (prefers-reduced-motion: reduce)`
 * 兜底约束——CSSOM 规范下显式传入的滚动行为优先于 `scroll-behavior: auto`。
 * 故所有显式平滑滚动调用点先读系统偏好，开启减弱动效时改用 `'auto'`。
 *
 * 无 `matchMedia`（旧 jsdom / SSR）时回退 `false`，维持既有平滑行为。
 * 可注入 view 供测试与已持有 doc.defaultView 的调用方使用。
 */
export function prefersReducedMotion(
  view: Window | null | undefined = typeof window === 'undefined' ? undefined : window,
): boolean {
  if (typeof view?.matchMedia !== 'function') return false;
  return view.matchMedia('(prefers-reduced-motion: reduce)').matches;
}
