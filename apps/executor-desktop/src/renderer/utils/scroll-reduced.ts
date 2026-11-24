/**
 * prefers-reduced-motion 的渲染层判据（JS 显式行为专用）。
 *
 * CSS 的 `@media (prefers-reduced-motion: reduce)` 只能收口样式声明，管不到
 * `scrollIntoView({ behavior: 'smooth' })` 这类**显式传值**——后者会覆盖
 * `scroll-behavior: auto !important`。故调用点在传 `behavior` 前先问一次系统偏好。
 *
 * 无 `matchMedia` 的环境（老 webview / node 单测替身）回退 false，保持既有
 * smooth 行为，不引入新的依赖或副作用。
 */
export function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}
