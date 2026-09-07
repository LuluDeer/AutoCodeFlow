import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';

/**
 * UI-02：明暗主题切换 store。
 *
 * 三态：'light' | 'dark' | 'system'（system=跟随 prefers-color-scheme，
 * 并监听系统变化实时生效）。持久化到 localStorage `autoflow-theme`，
 * 与 index.html 头部的 THEME_INIT_SCRIPT 约定同一键名（防首帧闪白）。
 *
 * resolvedMode 是消费方（main.tsx 的 algorithm 选择、index.css 的
 * data-theme 同步）唯一应依赖的推导值；mode 是用户意愿。
 */

export type ThemeMode = 'light' | 'dark' | 'system';
/** 推导后的实际主题（DOM data-theme / antd algorithm 消费） */
export type ResolvedTheme = 'light' | 'dark';

interface ThemeState {
  /** 用户意愿三态 */
  mode: ThemeMode;
  /** matchMedia 是否已绑定 system 监听（订阅去重） */
  _subscribed: boolean;
  setMode: (mode: ThemeMode) => void;
  /** 循环切换 light → dark → system → light（头部按钮用） */
  cycleMode: () => void;
  setSubscribed: (subscribed: boolean) => void;
}

export const THEME_STORAGE_KEY = 'autoflow-theme';

/** system 态下读取系统偏好；非 jsdom 环境缺省 light */
export function systemPrefersDark(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return false;
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

/** mode + 系统偏好 → 实际主题（纯函数，可测） */
export function resolveTheme(mode: ThemeMode, prefersDark: boolean): ResolvedTheme {
  if (mode === 'system') return prefersDark ? 'dark' : 'light';
  return mode;
}

/**
 * data-theme 属性同步（main.tsx 渲染外调用——store 订阅派发）。
 * colorScheme 同步让浏览器原生控件（滚动条/表单）跟随。
 */
export function applyThemeAttribute(resolved: ResolvedTheme): void {
  if (typeof document === 'undefined') return;
  document.documentElement.setAttribute('data-theme', resolved);
  (document.documentElement.style as CSSStyleDeclaration & { colorScheme: string }).colorScheme =
    resolved;
}

/** system 态订阅：matchMedia change → 重算 data-theme。返回退订函数。 */
export function subscribeSystemTheme(
  getMode: () => ThemeMode,
  onResolve: (resolved: ResolvedTheme) => void,
): () => void {
  if (typeof window === 'undefined' || !window.matchMedia) return () => undefined;
  const mql = window.matchMedia('(prefers-color-scheme: dark)');
  const handler = () => {
    if (getMode() === 'system') onResolve(resolveTheme('system', mql.matches));
  };
  // 现代 API 优先，旧 Safari 回退 addListener
  if (typeof mql.addEventListener === 'function') {
    mql.addEventListener('change', handler);
    return () => mql.removeEventListener('change', handler);
  }
  const legacy = mql as unknown as {
    addListener?: (cb: () => void) => void;
    removeListener?: (cb: () => void) => void;
  };
  legacy.addListener?.(handler);
  return () => legacy.removeListener?.(handler);
}

export const useThemeStore = create<ThemeState>()(
  persist(
    (set, get) => ({
      mode: 'system',
      _subscribed: false,
      setMode: (mode) => set({ mode }),
      cycleMode: () => {
        const order: ThemeMode[] = ['light', 'dark', 'system'];
        const next = order[(order.indexOf(get().mode) + 1) % order.length];
        set({ mode: next });
      },
      setSubscribed: (subscribed) => set({ _subscribed: subscribed }),
    }),
    {
      name: THEME_STORAGE_KEY,
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({ mode: state.mode }),
    },
  ),
);

/** 便捷选择器：当前实际主题 */
export const selectResolvedTheme = (state: ThemeState): ResolvedTheme =>
  resolveTheme(state.mode, systemPrefersDark());
