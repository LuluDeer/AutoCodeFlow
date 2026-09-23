import React, { useEffect, useState } from 'react';
import StatusWindow from './pages/StatusWindow';
import ConfigPage from './pages/ConfigPage';
import HistoryPage from './pages/HistoryPage';
import AppsPage from './pages/AppsPage';
import { TAB_SWITCH_EVENT } from './tab-switch';

type Tab = 'status' | 'config' | 'history' | 'apps';

/** Tab 顺序——roving tabindex 与 ←/→ 循环导航共用同一事实源。 */
const TAB_ORDER: Tab[] = ['status', 'config', 'history', 'apps'];

/** Tab 持久化键：重开窗口记住上次停留的 Tab（与既有 localStorage 惯例一致）。 */
const TAB_STORAGE_KEY = 'autoflow-executor-tab';

interface TabMeta {
  key: Tab;
  id: string;
  panel: string;
  icon: string;
  label: string;
}

const TABS: TabMeta[] = [
  { key: 'status', id: 'status-tab', panel: 'status-panel', icon: '📡', label: '状态监控' },
  { key: 'config', id: 'config-tab', panel: 'config-panel', icon: '⚙️', label: '配置' },
  { key: 'history', id: 'history-tab', panel: 'history-panel', icon: '📋', label: '历史' },
  { key: 'apps', id: 'apps-tab', panel: 'apps-panel', icon: '📦', label: '应用' },
];

/** 读取持久化的上次 Tab；非法/缺失值回落 status（不得渲染未知 Tab）。 */
function readInitialTab(): Tab {
  try {
    const v = window.localStorage.getItem(TAB_STORAGE_KEY);
    if (v && (TAB_ORDER as string[]).includes(v)) return v as Tab;
  } catch {
    /* localStorage 不可用（隐私模式等）时静默回落默认 */
  }
  return 'status';
}

// F-21（DEEP_REVIEW 0ef3bbe）：React.lazy 必须在模块顶层创建，避免每次 App 渲染
// 生成新组件类型导致 Wizard 子树在 StrictMode 双渲染或未来加 state 时反复重挂、输入丢失。
// 动态 import 本身仍保留代码分割（避免与 ConfigPage 等形成循环依赖）。
const Wizard = React.lazy(() => import('./pages/Wizard'));

export default function App() {
  // 根据 URL hash 判断是 wizard 还是主窗口
  const hash = window.location.hash.replace('#', '');

  if (hash === 'wizard') {
    return (
        <React.Suspense fallback={<div className="app-loading" role="status" aria-live="polite">Loading...</div>}>
        <Wizard />
      </React.Suspense>
    );
  }

  return <MainWindow />;
}

function MainWindow() {
  // 初始态从 localStorage 恢复（重开窗口记住上次 Tab），而非恒为 status。
  const [tab, setTab] = useState<Tab>(readInitialTab);

  // 持久化：每次切换即落盘；读取在 readInitialTab 已做合法性校验。
  useEffect(() => {
    try {
      window.localStorage.setItem(TAB_STORAGE_KEY, tab);
    } catch {
      /* 持久化失败不阻断切换 */
    }
  }, [tab]);

  // Listen for main-process tab-switch requests (tray menu)
  useEffect(() => {
    const api = (window as any).electronAPI;
    if (typeof api?.onSwitchTab === 'function') {
      // 白名单校验：主进程传来非法 tab 时不切换，避免所有面板被隐藏
      const unsub = api.onSwitchTab((t: string) => {
        if ((TAB_ORDER as string[]).includes(t)) setTab(t as Tab);
      });
      return () => unsub?.();
    }
  }, []);

  // 页内跨 Tab 跳转（应用页「无应用日志」→ 历史页看执行日志）。
  // 与托盘路径同款白名单校验：detail 非法时忽略，不切（否则所有面板被隐藏）。
  useEffect(() => {
    const onSwitch = (e: Event) => {
      const t = (e as CustomEvent).detail;
      if (typeof t === 'string' && (TAB_ORDER as string[]).includes(t)) {
        setTab(t as Tab);
      }
    };
    window.addEventListener(TAB_SWITCH_EVENT, onSwitch);
    return () => window.removeEventListener(TAB_SWITCH_EVENT, onSwitch);
  }, []);

  /** 选中某 Tab；focus=true 时把焦点跟随到该 Tab 按钮（roving tabindex 约定）。 */
  const selectTab = (next: Tab, focus = false) => {
    setTab(next);
    if (focus) {
      const meta = TABS.find((t) => t.key === next);
      if (meta) document.getElementById(meta.id)?.focus();
    }
  };

  /**
   * Roving tabindex 键盘导航（WAI-ARIA Tabs 模式）：
   * ←/→ 在 Tab 间循环切换并把焦点跟随到新 Tab；Home/End 跳到首/末。
   * 焦点只停在「当前选中 Tab」上（tabIndex 0），其余为 -1——Tab 键进入 tablist
   * 直接落在当前 Tab，再用方向键穿梭，符合读屏/键盘用户预期。
   */
  const onTabListKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const idx = TAB_ORDER.indexOf(tab);
    let next: Tab | null = null;
    if (e.key === 'ArrowRight') {
      next = TAB_ORDER[(idx + 1) % TAB_ORDER.length];
    } else if (e.key === 'ArrowLeft') {
      next = TAB_ORDER[(idx - 1 + TAB_ORDER.length) % TAB_ORDER.length];
    } else if (e.key === 'Home') {
      next = TAB_ORDER[0];
    } else if (e.key === 'End') {
      next = TAB_ORDER[TAB_ORDER.length - 1];
    }
    if (next) {
      e.preventDefault();
      selectTab(next, true);
    }
  };

  return (
    <div className="app">
      {/* 无边框窗口标题栏——拖拽区域 + 窗口控制 */}
      <div className="titlebar">
        <span className="titlebar-title">AutoCodeFlow Executor</span>
        <div className="titlebar-right">
          <button
            className="titlebar-btn"
            onClick={() => (window as any).electronAPI?.minimizeWindow?.()}
            title="最小化"
            aria-label="最小化窗口"
          >─</button>
          <button
            className="titlebar-btn titlebar-btn-close"
            onClick={() => (window as any).electronAPI?.closeWindow?.()}
            title="关闭"
            aria-label="关闭窗口"
          >✕</button>
        </div>
      </div>

      {/* Tab 导航：roving tabindex + ←/→/Home/End 键盘穿梭 */}
      <div
        className="tabs"
        role="tablist"
        aria-label="执行器页面"
        onKeyDown={onTabListKeyDown}
      >
        {TABS.map((meta) => {
          const active = tab === meta.key;
          return (
            <button
              key={meta.key}
              type="button"
              className={`tab${active ? ' active' : ''}`}
              onClick={() => selectTab(meta.key)}
              role="tab"
              aria-selected={active}
              aria-controls={meta.panel}
              id={meta.id}
              // roving tabindex：仅当前选中 Tab 可被 Tab 键聚焦
              tabIndex={active ? 0 : -1}
            >
              <span className="tab-icon">{meta.icon}</span>
              {meta.label}
            </button>
          );
        })}
      </div>

      {/* 内容区 — 所有页面常驻 DOM，用 display 控制显隐，避免切 tab 时重新挂载导致闪烁 */}
      <div className="main-content">
        <div id="status-panel" role="tabpanel" aria-labelledby="status-tab" hidden={tab !== 'status'} className={tab === 'status' ? 'tab-panel is-active' : 'tab-panel'}><StatusWindow /></div>
        <div id="config-panel" role="tabpanel" aria-labelledby="config-tab" hidden={tab !== 'config'} className={tab === 'config' ? 'tab-panel is-active' : 'tab-panel'}><ConfigPage /></div>
        <div id="history-panel" role="tabpanel" aria-labelledby="history-tab" hidden={tab !== 'history'} className={tab === 'history' ? 'tab-panel is-active' : 'tab-panel'}><HistoryPage /></div>
        <div id="apps-panel" role="tabpanel" aria-labelledby="apps-tab" hidden={tab !== 'apps'} className={tab === 'apps' ? 'tab-panel is-active' : 'tab-panel'}><AppsPage /></div>
      </div>
    </div>
  );
}
