import React from 'react';
import { ConfigProvider, App, theme as antdTheme } from 'antd';
import type { ThemeConfig } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import { DESIGN_TOKENS, DARK_TOKENS, LIGHT_TOKENS, FONT_STACKS } from './tokens';
import {
  useThemeStore,
  selectResolvedTheme,
  applyThemeAttribute,
  subscribeSystemTheme,
} from './store';

/**
 * UI-01：设计系统 antd token 映射。
 * 亮/暗两面共用同一份常量源（src/theme/tokens.ts），强调色 #22C55E
 * （MASTER.md Accent/CTA）双主题同源；背景/边框/文字随 algorithm 切换。
 * 独立于 main.tsx（渲染入口）导出，便于测试直接消费。
 */
export function buildAntdTheme(resolved: 'light' | 'dark'): ThemeConfig {
  const isDark = resolved === 'dark';
  const face = isDark ? DARK_TOKENS : LIGHT_TOKENS;
  return {
    algorithm: isDark ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm,
    token: {
      // MASTER.md Accent/CTA——antd 主色与强调色共源
      colorPrimary: DESIGN_TOKENS.accent,
      colorLink: DESIGN_TOKENS.accent,
      colorInfo: DESIGN_TOKENS.accent,
      colorSuccess: DESIGN_TOKENS.accent,
      colorError: DESIGN_TOKENS.destructive,
      colorBgLayout: face.background,
      colorBgContainer: face.container,
      colorBgElevated: isDark ? DESIGN_TOKENS.muted : '#FFFFFF',
      colorBorder: face.border,
      colorBorderSecondary: face.border,
      colorText: face.text,
      colorTextSecondary: face.textSecondary,
      colorTextTertiary: face.textSecondary,
      borderRadius: 8,
      fontFamily: FONT_STACKS.body,
      // MASTER §Typography：代码/日志/等宽场景（Typography.Text code 等）跟随
      fontFamilyCode: FONT_STACKS.mono,
    },
  };
}

/**
 * UI-02：主题接线（模块加载期一次，非组件层）——
 * ① data-theme 属性随 store 派发同步（CSS 变量消费方）；
 * ② system 态订阅 matchMedia 变化实时重算；
 * ③ React.StrictMode 双渲染安全（store 订阅只注册一次）。
 */
export function wireThemeSync(): void {
  const store = useThemeStore;
  let unsubscribeSystem: (() => void) | null = null;

  const rewireSystemSubscription = (mode: 'light' | 'dark' | 'system') => {
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
    applyThemeAttribute(selectResolvedTheme(store.getState()));
    rewireSystemSubscription(mode);
  };

  // 初次同步（含 system 初值），此后随每次 setMode/cycleMode 派发
  sync(store.getState().mode);
  store.subscribe((state) => sync(state.mode));
}

/** 主题 Provider 树（main.tsx 与测试共用） */
export function ThemedProviders({ children }: { children: React.ReactNode }) {
  const resolved = useThemeStore(selectResolvedTheme);
  return (
    <ConfigProvider locale={zhCN} theme={buildAntdTheme(resolved)}>
      <App>{children}</App>
    </ConfigProvider>
  );
}
