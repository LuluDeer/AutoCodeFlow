import React, { useEffect, useMemo } from 'react';
import { ConfigProvider, App, theme as antdTheme } from 'antd';
import type { ThemeConfig } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import enUS from 'antd/locale/en_US';
import { useTranslation } from 'react-i18next';
import '../i18n';
import { DESIGN_TOKENS, DARK_TOKENS, LIGHT_TOKENS, FONT_STACKS } from './tokens';
import {
  useThemeStore,
  selectResolvedTheme,
  applyThemeAttribute,
  subscribeSystemTheme,
} from './store';
// TOAST-01：把 App 上下文的 message 实例注册给 utils/toast（静态 message
// 不吃主题的收口，见 toast.ts 头注释）
import { registerMessageApi } from '../utils/toast';
// MODAL-01：同理把 App 上下文的 modal 实例注册给 utils/modal（静态
// Modal.confirm 不吃主题/locale，见 modal.ts 头注释）
import { registerModalApi } from '../utils/modal';

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

/** TOAST-01：App 上下文 message 实例 → utils/toast 注册桥（渲染零输出） */
function MessageApiBridge(): null {
  const { message } = App.useApp();
  useEffect(() => {
    registerMessageApi(message);
  }, [message]);
  return null;
}

/** MODAL-01：App 上下文 modal 实例 → utils/modal 注册桥（渲染零输出）。
 *  与 MessageApiBridge 同址挂载：静态 Modal.confirm 的确认框因此能吃到
 *  暗色主题与 i18n locale（此前是亮面 + 中文按钮混排）。 */
function ModalApiBridge(): null {
  const { modal } = App.useApp();
  useEffect(() => {
    registerModalApi(modal);
  }, [modal]);
  return null;
}

/** 主题 Provider 树（main.tsx 与测试共用） */
export function ThemedProviders({ children }: { children: React.ReactNode }) {
  const resolved = useThemeStore(selectResolvedTheme);
  // F-14（DEEP_REVIEW 0ef3bbe）：antd 内建文案（Pagination 空态 / DatePicker /
  // Modal 默认 okText 等）跟随 i18n 语言切换——此前恒 zhCN，英文界面下中外混杂。
  const { i18n } = useTranslation();
  const antdLocale = (i18n.language || 'zh').startsWith('en') ? enUS : zhCN;
  // O-18：buildAntdTheme 每次渲染都新建一个全新 ThemeConfig 对象（含 algorithm
  // 函数引用 + 全部 token），ConfigProvider 收到新引用即触发 antd 全量 token 重算。
  // 仅在 resolved 变化时重建主题对象，其余渲染周期复用同一引用，避免无谓重算。
  const antdTheme = useMemo(() => buildAntdTheme(resolved), [resolved]);
  return (
    <ConfigProvider locale={antdLocale} theme={antdTheme}>
      <App>
        <MessageApiBridge />
        <ModalApiBridge />
        {children}
      </App>
    </ConfigProvider>
  );
}
