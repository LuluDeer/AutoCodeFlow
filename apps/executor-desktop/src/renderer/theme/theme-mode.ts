/**
 * ⑤ 暗色分面：主题模式纯决策层（无 React / 无 Electron 依赖，selftest 直接驱动）。
 *
 * 三态模式（light / dark / system），localStorage 键 `acf-theme-mode`；
 * `system` 跟随 `prefers-color-scheme`。已解析主题（light/dark）写到 <html>
 * 的 `data-theme` + `color-scheme`，tokens.css 按 `[data-theme='dark']` 翻令牌。
 *
 * 存储访问全部可注入（storage 参数），便于裸 Node selftest 用伪 Storage 驱动；
 * 默认回落 `window.localStorage`，隐私模式 / 禁用存储时静默回落 system。
 */

export type ThemeMode = 'light' | 'dark' | 'system';
export type ResolvedTheme = 'light' | 'dark';

export const THEME_STORAGE_KEY = 'acf-theme-mode';
export const THEME_MODES: readonly ThemeMode[] = ['light', 'dark', 'system'];

/** 模式归一：非法 / 缺省值回落 'system'（默认跟随系统）。 */
export function parseThemeMode(value: unknown): ThemeMode {
  return value === 'light' || value === 'dark' || value === 'system' ? value : 'system';
}

/** 模式 + 系统暗色偏好 → 已解析主题。 */
export function resolveTheme(mode: ThemeMode, prefersDark: boolean): ResolvedTheme {
  if (mode === 'light') return 'light';
  if (mode === 'dark') return 'dark';
  return prefersDark ? 'dark' : 'light';
}

/** 读取已存模式；存储不可用 / 损坏 → 'system'。 */
export function readStoredMode(storage: Storage | null): ThemeMode {
  return readStoredModeOrFallback(storage, 'system');
}

/**
 * 读取已存模式；localStorage 无键（首装 / 隐私清空）时回落后端镜像 config.theme。
 * 存储不可用同样回落 fallback，不抛错。
 */
export function readStoredModeOrFallback(storage: Storage | null, fallback: ThemeMode): ThemeMode {
  let raw: string | null;
  try {
    raw = storage?.getItem(THEME_STORAGE_KEY) ?? null;
  } catch {
    raw = null;
  }
  return raw === null ? fallback : parseThemeMode(raw);
}

/** 持久化模式；存储不可用时静默忽略（回落系统偏好不报错）。 */
export function writeStoredMode(mode: ThemeMode, storage: Storage | null): void {
  try {
    storage?.setItem(THEME_STORAGE_KEY, mode);
  } catch {
    // 隐私模式 / 存储被禁用：不阻塞界面，下次仍按 system 解析。
  }
}

/** 把已解析主题写到根元素：data-theme 选择器分面 + color-scheme 让原生控件跟随。 */
export function applyThemeAttribute(root: HTMLElement, resolved: ResolvedTheme): void {
  root.dataset.theme = resolved;
  root.style.colorScheme = resolved;
}
