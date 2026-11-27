/**
 * ⑤ 暗色分面首帧防闪脚本（index.html 中先于 main.tsx 以 module 引用）。
 *
 * React 挂载前先按已存模式 + 系统偏好设定 <html> 的 data-theme / color-scheme，
 * 避免「先亮底一帧再切暗」的白闪。判定逻辑与 main.tsx 生效链路同源
 * （theme-mode 纯函数），本文件不碰 React、不发 IPC：config.theme 的快照由
 * preload 在 contextBridge 上同步注入，localStorage 缺失时用它兜底。
 */
import {
  applyThemeAttribute,
  parseThemeMode,
  readStoredModeOrFallback,
  resolveTheme,
} from './theme-mode';

let storage: Storage | null = null;
try {
  storage = window.localStorage;
} catch {
  storage = null;
}

const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
// P3 首帧防闪：preload 已在页面脚本前同步注入 config.theme 快照（electronAPI.bootTheme）。
// 优先级与 main.tsx 的 applyTheme 完全一致：localStorage 是 UI 真相源，快照只作
// **localStorage 缺失时**的 fallback（首装 / 手清存储 / 配置导入）——这样首帧与
// getConfig() 回来后的二次解析落同一态，不会再出现「亮一帧再翻暗」。
// 边界：localStorage 仍有旧值时以它为准（和 main.tsx 同源），手改磁盘 config 不会
// 覆盖用户本地偏好，直到配置导入流程写回 localStorage。
const bootMode = parseThemeMode(window.electronAPI?.bootTheme);
applyThemeAttribute(
  document.documentElement,
  resolveTheme(readStoredModeOrFallback(storage, bootMode), prefersDark),
);
