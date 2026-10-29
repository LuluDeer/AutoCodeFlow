import React from 'react';
import { createRoot } from 'react-dom/client';
import { UI_LANGUAGE_DEFAULT } from '../main/ui-language';
import { resolveRendererLocale, setRendererLanguageSetting } from './i18n';
// P3-2：错误消息剥 Electron/V8 包装前缀（本模块零依赖原则不受影响——
// ipc-error.ts 也是纯常量模块，与 i18n 同类）。
import { ipcErrorMessage } from './ipc-error';
import './styles/tokens.css';
import './styles/base.css';
import './styles/components.css';
import './styles/pages.css';
// UI V5：Config / Apps / History 的新样式独立成文件，便于并行改造与回滚；
// 必须排在 pages.css 之后，cfgx-* / appx-* / historyx-* 才能稳定覆盖遗留规则。
import './styles/pages/config-v5.css';
import './styles/pages/apps-v5.css';
import './styles/pages/history-v5.css';

// i18n-DESK-01：本文件是全渲染层唯一声明 electronAPI 的地方（各页面各自
// declare 自己的窄接口，同既有惯例）。
declare const window: Window & {
  electronAPI?: {
    getConfig?: () => Promise<Record<string, unknown>>;
  };
};

/**
 * i18n-DESK-01：**先取到已落盘的「界面语言」设置，再求值渲染层各模块**。
 *
 * 为什么必须这样写：12 个渲染层模块在**模块作用域**求值各自的文案表
 * （`const t = createCfgTexts(resolveRendererLocale(...))`），模块求值发生在
 * 任何 useEffect 之前；而设置只能经 IPC 异步读到。所以顺序必须是
 *   ① await config:get（既有通道，不新开通道）→ ② 灌进 i18n 的模块级设置
 *   → ③ **才**动态 import App / ErrorBoundary。
 * 若沿用静态 import，App/ErrorBoundary 会在本文件求值时就先求值，设置必然晚到
 * ——那正是「加了设置却不生效」的经典形态。
 *
 * 生效时机：语言**不是热切换**（模块作用域只求值一次）。改语言后由设置页在保存
 * 成功时 location.reload() 重载窗口，重载即重跑本函数、按新语言重新求值；
 * 未重载时界面语言保持不变（不会出现半页中文半页英文）。
 *
 * 读配置失败（文件损坏 / IPC 异常 / 旧版 preload 没有 getConfig）：按产品默认
 * **英文**渲染，而不是回落自动判定——UI_LANGUAGE_DEFAULT='en'（见
 * ui-language.ts；F-36 修正：本注释此前写「默认即中文」，与实现相反，系
 * 首版"非 en 即中文"判定方向的陈旧残留）。默认值取 zh 还是 en 属待拍板项
 * （docs/OPEN-DECISIONS.md D5），拍板前不改行为。
 */
async function bootstrap(): Promise<void> {
  const container = document.getElementById('root')!;

  try {
    const cfg = await window.electronAPI?.getConfig?.();
    setRendererLanguageSetting(cfg?.uiLanguage ?? UI_LANGUAGE_DEFAULT);
  } catch {
    setRendererLanguageSetting(UI_LANGUAGE_DEFAULT);
  }

  // <html lang> 与生效语言对齐（无障碍/字体回落/朗读器按它选语音）。index.html
  // 静态写的是 zh-CN，选了英文后必须同步，否则页面语言属性与实际文案不符。
  const locale = resolveRendererLocale(() => navigator.language);
  document.documentElement.lang = locale === 'en' ? 'en' : 'zh-CN';

  const [{ default: App }, { default: ErrorBoundary }] = await Promise.all([
    import('./App'),
    import('./components/ErrorBoundary'),
  ]);

  // NETOPT-6⑥：渲染树最外层包全局 ErrorBoundary——任一组件渲染期抛错时
  // 展示错误摘要 + 「重载渲染层」，而不是整树卸载白屏。
  createRoot(container).render(
    <ErrorBoundary>
      <App />
    </ErrorBoundary>,
  );
}

void bootstrap().catch((err: unknown) => {
  // 极端兜底：动态 chunk 加载/求值失败时 ErrorBoundary 自己都没进来，此处不走
  // i18n（它可能正是加载失败的那一块），直接写一段中文错误行，至少不留白屏。
  // P3-2：经 ipcErrorMessage 剥 Electron 包装前缀（chunk 经 Vite dev/HTTP 加载
  // 失败时的报错同样受益；本地模块加载错误无该前缀，原样返回）。
  const container = document.getElementById('root');
  if (container) {
    container.textContent = `界面加载失败：${ipcErrorMessage(err)}`;
  }
});
