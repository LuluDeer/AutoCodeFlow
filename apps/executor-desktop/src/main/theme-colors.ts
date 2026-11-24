/**
 * 主进程 BrowserWindow 底色的单一事实源。
 *
 * 两个值必须与 renderer/styles/tokens.css 的 `--bg` 逐字相等：
 *   - 亮色：`:root` 块 `--bg: #f5f6f8`
 *   - 暗色：`[data-theme='dark']` 块 `--bg: #0f172a`
 * renderer.selftest.mjs 有跨文件守卫逐项比对，任何一侧漂移即红。
 *
 * frameless 窗口在部分 Windows 机器上 transparent 合成失败（WIN-DISPLAY /
 * 1.4.3 Hotfix），只能用实心底色；窗口底色与 CSS --bg 不一致会在首帧/边框
 * 出现色带（见 design-system/autocodeflow/pages/executor-desktop.md §7）。
 */

/** 亮色窗口底色（= tokens.css :root --bg）。 */
export const WINDOW_BG_LIGHT = '#f5f6f8';

/** 暗色窗口底色（= tokens.css [data-theme='dark'] --bg）。 */
export const WINDOW_BG_DARK = '#0f172a';

export type ResolvedTheme = 'light' | 'dark';

/**
 * 主题 → 窗口底色。新窗构造与既有窗 setBackgroundColor 共用同一判定，
 * 避免三处各自写三元表达式时漏改其中一处。
 */
export function windowBackground(theme: ResolvedTheme): string {
  return theme === 'dark' ? WINDOW_BG_DARK : WINDOW_BG_LIGHT;
}
