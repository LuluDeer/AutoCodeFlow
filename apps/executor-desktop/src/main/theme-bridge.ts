/**
 * ⑤ 暗色分面：主进程侧主题决策层（解析纯函数无 Electron 运行时依赖；
 * 注册函数仅 `import type` 引用 Electron 类型，编译期擦除，裸 Node selftest 可驱动）。
 *
 * 渲染层 localStorage（`acf-theme-mode`）是 UI 真相源；本模块把三态模式
 * （light / dark / system）解析成已解析主题（light / dark），供窗口底色镜像
 * 与 config.theme 后端键复用。`system` 跟随传入的系统暗色偏好（主进程侧
 * 取自 `nativeTheme.shouldUseDarkColors`）。
 */

import { sanitizeConfigInput } from './config-sanitize';

/** 注册面最小结构类型：只依赖 handle 闸，不绑定 Electron 完整 IpcMain 类型
 *  （主进程传入的是 sender 闸包装后的 GuardedIpcMain，结构上满足本接口）。 */
interface ThemeIpcMain {
  handle: (channel: string, listener: (...args: unknown[]) => unknown) => void;
}

export type ThemeMode = 'light' | 'dark' | 'system';
export type ResolvedTheme = 'light' | 'dark';

export const THEME_MODES: readonly ThemeMode[] = ['light', 'dark', 'system'];

/** 模式归一：非法 / 缺省 / 非字符串回落 'system'（默认跟随系统）。 */
export function parseThemeMode(value: unknown): ThemeMode {
  return value === 'light' || value === 'dark' || value === 'system' ? value : 'system';
}

/** 模式 + 系统暗色偏好 → 已解析主题。 */
export function resolveThemeMode(mode: ThemeMode, prefersDark: boolean): ResolvedTheme {
  if (mode === 'light') return 'light';
  if (mode === 'dark') return 'dark';
  return prefersDark ? 'dark' : 'light';
}

/** 原始存储值（可能坏值 / 缺省）+ 系统偏好 → 已解析主题；一步归一+解析。 */
export function resolveStoredTheme(raw: unknown, prefersDark: boolean): ResolvedTheme {
  return resolveThemeMode(parseThemeMode(raw), prefersDark);
}

/** 渲染层运行时上报的已解析主题归一：非 'dark' 一律按 'light' 兜底。 */
export function coerceResolvedTheme(value: unknown): ResolvedTheme {
  return value === 'dark' ? 'dark' : 'light';
}

/** 主题 IPC 接线依赖（只暴露最小面，避免整棵窗口管理器 / 配置仓储进本模块）。 */
export interface ThemeBridgeDeps {
  /** 把已解析主题镜像到现存窗口底色。 */
  setResolvedTheme: (theme: ResolvedTheme) => void;
  /** 把归一后的三态模式落盘 config.theme（后端镜像，不经执行器重启决策）。 */
  saveThemeConfig: (theme: ThemeMode) => void;
}

/**
 * 注册主题两个 IPC 通道：
 *  · `theme:apply` 运行中即时更新现存窗口底色；
 *  · `theme:save` 消毒归一后落盘后端镜像 config.theme。
 * 从 ipc-handlers.ts 外提，压住巨型注册函数的函数体棘轮。
 */
export function registerThemeHandlers(ipcMain: ThemeIpcMain, deps: ThemeBridgeDeps): void {
  ipcMain.handle('theme:apply', (_event, theme: unknown) => {
    const resolved = coerceResolvedTheme(theme);
    deps.setResolvedTheme(resolved);
    return { ok: true, theme: resolved };
  });

  ipcMain.handle('theme:save', (_event, mode: unknown) => {
    const clean = sanitizeConfigInput({ theme: mode });
    const persisted = typeof clean.theme === 'string' ? parseThemeMode(clean.theme) : 'system';
    deps.saveThemeConfig(persisted);
    return { ok: true, theme: persisted };
  });
}
