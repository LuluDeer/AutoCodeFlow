/**
 * ⑤ 暗色分面首帧防闪脚本（index.html 中先于 main.tsx 以 module 引用）。
 *
 * React 挂载前先按已存模式 + 系统偏好设定 <html> 的 data-theme / color-scheme，
 * 避免「先亮底一帧再切暗」的白闪。判定逻辑与 main.tsx 生效链路同源
 * （theme-mode 纯函数），本文件不碰 React、不碰 IPC。
 */
import { applyThemeAttribute, readStoredMode, resolveTheme } from './theme-mode';

let storage: Storage | null = null;
try {
  storage = window.localStorage;
} catch {
  storage = null;
}

const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
applyThemeAttribute(document.documentElement, resolveTheme(readStoredMode(storage), prefersDark));
