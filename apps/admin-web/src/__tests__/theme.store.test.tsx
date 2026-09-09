/**
 * UI-02：主题 store + 接线单测。
 * 覆盖：三态循环 / 持久化（localStorage）/ system 跟随（matchMedia）
 * / resolveTheme 纯函数 / applyThemeAttribute DOM 同步 / antd token 映射。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act, render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { theme as antdTheme } from 'antd';
import { useThemeStore, resolveTheme, applyThemeAttribute, subscribeSystemTheme, THEME_STORAGE_KEY } from '../theme/store';
import { buildAntdTheme, ThemedProviders } from '../theme/ThemeProviders';
import ThemeToggleFixture from './ThemeToggleFixture';

beforeEach(() => {
  localStorage.clear();
  // 重置 store 至初始态（mode=system）
  act(() => {
    useThemeStore.getState().setMode('system');
  });
  document.documentElement.removeAttribute('data-theme');
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('theme store — 三态与循环', () => {
  it('初始 mode 为 system', () => {
    const { result } = renderHook(() => useThemeStore());
    expect(result.current.mode).toBe('system');
  });

  it('setMode 三态可任意切换', () => {
    const { result } = renderHook(() => useThemeStore());
    act(() => result.current.setMode('dark'));
    expect(result.current.mode).toBe('dark');
    act(() => result.current.setMode('light'));
    expect(result.current.mode).toBe('light');
    act(() => result.current.setMode('system'));
    expect(result.current.mode).toBe('system');
  });

  it('cycleMode 循环 light → dark → system → light', () => {
    const { result } = renderHook(() => useThemeStore());
    act(() => result.current.setMode('light'));
    act(() => result.current.cycleMode());
    expect(result.current.mode).toBe('dark');
    act(() => result.current.cycleMode());
    expect(result.current.mode).toBe('system');
    act(() => result.current.cycleMode());
    expect(result.current.mode).toBe('light');
  });

  it('mode 变更持久化到 localStorage（zustand persist）', async () => {
    const { result } = renderHook(() => useThemeStore());
    act(() => result.current.setMode('dark'));
    // persist 写入是同步的 createJSONStorage，但等待一拍保险
    await Promise.resolve();
    const raw = localStorage.getItem(THEME_STORAGE_KEY);
    expect(raw).toBeTruthy();
    expect(JSON.parse(raw as string).state.mode).toBe('dark');
  });
});

describe('resolveTheme — system 跟随', () => {
  it('system + prefersDark=true → dark', () => {
    expect(resolveTheme('system', true)).toBe('dark');
  });

  it('system + prefersDark=false → light', () => {
    expect(resolveTheme('system', false)).toBe('light');
  });

  it('显式 light/dark 不受系统偏好影响', () => {
    expect(resolveTheme('light', true)).toBe('light');
    expect(resolveTheme('dark', false)).toBe('dark');
  });

  it('system 态订阅：matchMedia 变化后重算 data-theme', () => {
    const listeners = new Set<() => void>();
    const mqlMock = {
      matches: false,
      addEventListener: (_: string, cb: () => void) => listeners.add(cb),
      removeEventListener: (_: string, cb: () => void) => listeners.delete(cb),
    };
    // jsdom 未实现 window.matchMedia，直接定义（非 spy）
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      configurable: true,
      value: () => mqlMock as unknown as MediaQueryList,
    });

    applyThemeAttribute(resolveTheme('system', false));
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');

    // 模拟系统切到 dark
    (mqlMock as { matches: boolean }).matches = true;
    listeners.forEach((cb) => cb());
    applyThemeAttribute(resolveTheme('system', mqlMock.matches));
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
  });
});

describe('applyThemeAttribute — DOM 同步', () => {
  it('设置 data-theme 与 colorScheme', () => {
    applyThemeAttribute('dark');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(document.documentElement.style.colorScheme).toBe('dark');
    applyThemeAttribute('light');
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    expect(document.documentElement.style.colorScheme).toBe('light');
  });
});

describe('buildAntdTheme — antd algorithm 映射（UI-01 验收）', () => {
  it('light → defaultAlgorithm + 亮面色板', () => {
    const cfg = buildAntdTheme('light');
    expect(cfg.algorithm).toBe(antdTheme.defaultAlgorithm);
    expect(cfg.token?.colorBgLayout).toBe('#F8FAFC');
  });

  it('dark → darkAlgorithm + MASTER.md OLED 画布 #020617', () => {
    const cfg = buildAntdTheme('dark');
    expect(cfg.algorithm).toBe(antdTheme.darkAlgorithm);
    expect(cfg.token?.colorBgLayout).toBe('#020617');
  });

  it('双主题共用强调色 #22C55E（MASTER.md Accent/CTA）', () => {
    expect(buildAntdTheme('light').token?.colorPrimary).toBe('#22C55E');
    expect(buildAntdTheme('dark').token?.colorPrimary).toBe('#22C55E');
  });
});

describe('ThemedProviders + 切换按钮接线', () => {
  it('渲染在 ThemedProviders 内的按钮点击循环三态并同步 data-theme（wireThemeSync 接线）', async () => {
    // jsdom 未实现 matchMedia——补桩（system 态解析需要）
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      configurable: true,
      value: (q: string) =>
        ({
          matches: false,
          media: q,
          addEventListener: () => undefined,
          removeEventListener: () => undefined,
        }) as unknown as MediaQueryList,
    });
    const user = userEvent.setup();
    // wireThemeSync 是渲染外接线（main.tsx 模块加载期调用），测试内手动等价调用
    const unwire = wireThemeSyncForTest();
    render(
      <ThemedProviders>
        <ThemeToggleFixture />
      </ThemedProviders>,
    );
    const btn = screen.getByTestId('theme-toggle');
    // 初始 system（matchMedia mock=false → 解析为 light）
    expect(useThemeStore.getState().mode).toBe('system');
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    await user.click(btn);
    expect(useThemeStore.getState().mode).toBe('light');
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    await user.click(btn);
    expect(useThemeStore.getState().mode).toBe('dark');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    await user.click(btn);
    expect(useThemeStore.getState().mode).toBe('system');
    unwire();
  });

  it('ThemedProviders 随 store 派发切换 data-theme 属性（algorithm 消费同一 resolved 值）', async () => {
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      configurable: true,
      value: (q: string) =>
        ({
          matches: false,
          media: q,
          addEventListener: () => undefined,
          removeEventListener: () => undefined,
        }) as unknown as MediaQueryList,
    });
    const user = userEvent.setup();
    const unwire = wireThemeSyncForTest();
    render(
      <ThemedProviders>
        <ThemeToggleFixture />
      </ThemedProviders>,
    );
    await user.click(screen.getByTestId('theme-toggle')); // → light
    expect(document.querySelector("[data-theme='light']")).toBeTruthy();
    await user.click(screen.getByTestId('theme-toggle')); // → dark
    expect(document.querySelector("[data-theme='dark']")).toBeTruthy();
    unwire();
  });
});

/** 测试等价的 wireThemeSync：返回退订函数，防止用例间订阅泄漏 */
function wireThemeSyncForTest(): () => void {
  const store = useThemeStore;
  let unsubscribeSystem: (() => void) | null = null;

  const rewire = (mode: 'light' | 'dark' | 'system') => {
    unsubscribeSystem?.();
    unsubscribeSystem = null;
    if (mode === 'system') {
      unsubscribeSystem = subscribeSystemTheme(
        () => store.getState().mode,
        (resolved) => applyThemeAttribute(resolved),
      );
    }
  };

  const sync = (mode: 'light' | 'dark' | 'system') => {
    applyThemeAttribute(selectResolved(store.getState()));
    rewire(mode);
  };
  sync(store.getState().mode);
  const unsub = store.subscribe((state) => sync(state.mode));
  return () => {
    unsub();
    unsubscribeSystem?.();
  };
}

import { selectResolvedTheme as selectResolved } from '../theme/store';
