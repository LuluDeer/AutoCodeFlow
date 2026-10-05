import React, { useEffect, useState } from 'react';
import StatusWindow from './pages/StatusWindow';
import ConfigPage from './pages/ConfigPage';
import HistoryPage from './pages/HistoryPage';
import AppsPage from './pages/AppsPage';
import Icon from './components/Icon';
import { TAB_SWITCH_EVENT } from './tab-switch';
// V4-5（I-07 门面四件第一件）：Tab 标题 / titlebar / 关窗提示 / 加载占位走
// 双语表（zh 值与原硬编码逐字一致，zh 系统渲染零变化）。
import { createCfgTexts, resolveRendererLocale } from './i18n';

/** 壳层文案：模块级解析一次 locale（与 ConfigPage 同口径——渲染层无热切语言，
 *   重挂载时按 navigator.language 重取）。 */
const shellT = createCfgTexts(resolveRendererLocale(() => navigator.language));

type Tab = 'status' | 'config' | 'history' | 'apps';

/**
 * Tab 顺序——roving tabindex 与 ←/→ 循环导航共用同一事实源。
 * V4-1（I-02）：按使用频率重排为 状态 → 历史 → 应用 → 配置（低频配置靠边，
 * 排障主路径前移）；Ctrl+1..4 与 tooltip 文案随本数组自动跟随。
 * localStorage 持久化的是 tab key 而非位次，旧值无损。
 */
const TAB_ORDER: Tab[] = ['status', 'history', 'apps', 'config'];

/** Tab 持久化键：重开窗口记住上次停留的 Tab（与既有 localStorage 惯例一致）。 */
const TAB_STORAGE_KEY = 'autoflow-executor-tab';

/**
 * C-04：主窗 X 首次关闭提示的一次性标记（key 只看存在与否，值恒 '1'）。
 * 主窗 X 实际是隐藏进托盘（window-all-closed 为 no-op、app 常驻），首次
 * 点击必须教育一次，否则不懂托盘的用户会以为已退出。
 */
const CLOSE_TIP_STORAGE_KEY = 'acf-close-tip-shown';

/**
 * 是否已提示过关闭行为。读失败（隐私模式等 localStorage 不可用）当作
 * 已提示处理——降级为「不提示直接关」，宁可少打扰也不要每次关闭都拦一下。
 */
function readCloseTipShown(): boolean {
  try {
    return window.localStorage.getItem(CLOSE_TIP_STORAGE_KEY) === '1';
  } catch {
    return true;
  }
}

/** 落一次性标记；写失败静默（气泡显隐由 state 兜住，本次交互不受影响）。 */
function markCloseTipShown(): void {
  try {
    window.localStorage.setItem(CLOSE_TIP_STORAGE_KEY, '1');
  } catch {
    /* localStorage 不可用时静默降级 */
  }
}

interface TabMeta {
  key: Tab;
  id: string;
  panel: string;
  label: string;
}

const TABS: TabMeta[] = [
  { key: 'status', id: 'status-tab', panel: 'status-panel', label: shellT('shell.tab.status') },
  { key: 'history', id: 'history-tab', panel: 'history-panel', label: shellT('shell.tab.history') },
  { key: 'apps', id: 'apps-tab', panel: 'apps-panel', label: shellT('shell.tab.apps') },
  { key: 'config', id: 'config-tab', panel: 'config-panel', label: shellT('shell.tab.config') },
];

function TabIcon({ kind }: { kind: Tab }) {
  // 收口到公共 Icon 组件（与页内图标同一套 24 viewBox 线条语言）
  const map: Record<Tab, Parameters<typeof Icon>[0]['name']> = {
    status: 'activity',
    config: 'gear',
    history: 'clock',
    apps: 'box',
  };
  return <Icon name={map[kind]} className="tab-icon" />;
}

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
        // chunk 加载瞬间闪一句英文 Loading 会造成混语观感——占位文案走双语表
        // （zh 值「加载中...」与原硬编码逐字一致，见 UX走查⑤ 守卫）。
        <React.Suspense fallback={<div className="app-loading" role="status" aria-live="polite">{shellT('shell.loading')}</div>}>
        <Wizard />
      </React.Suspense>
    );
  }

  return <MainWindow />;
}

function MainWindow() {
  // 初始态从 localStorage 恢复（重开窗口记住上次 Tab），而非恒为 status。
  const [tab, setTab] = useState<Tab>(readInitialTab);
  const [maximized, setMaximized] = useState(false);
  // C-04：主窗 X 首次关闭的一次性托盘驻留气泡（显隐仅由 state 控制；
  // 「是否提示过」以 localStorage 标记为准，见 readCloseTipShown）。
  const [showCloseTip, setShowCloseTip] = useState(false);

  useEffect(() => {
    const api = (window as any).electronAPI;
    let mounted = true;
    if (typeof api?.getWindowState === 'function') {
      void api.getWindowState()
        .then((state: { maximized?: boolean }) => { if (mounted) setMaximized(state?.maximized === true); })
        .catch(() => {});
    }
    const off = typeof api?.onWindowMaximizeChange === 'function'
      ? api.onWindowMaximizeChange((value: boolean) => setMaximized(value))
      : null;
    return () => { mounted = false; if (typeof off === 'function') off(); };
  }, []);

  function toggleMaximize() {
    const action = (window as any).electronAPI?.toggleMaximizeWindow;
    if (typeof action !== 'function') return;
    void action()
      .then((state: { maximized?: boolean }) => setMaximized(state?.maximized === true))
      .catch(() => {});
  }

  /**
   * 主窗关闭按钮统一入口（C-04）。X 的真实语义是隐藏进托盘（app 常驻）：
   * 首次点击拦截本次关闭、弹一次性气泡并同时落 localStorage 标记——这样
   * 气泡出现期间用户改点最小化/再点 X 等任何离开路径都视为已教育，直接
   * 放行且此后不再提示。已标记则行为与从前一致（直接关闭）。
   */
  function requestClose() {
    if (readCloseTipShown()) {
      (window as any).electronAPI?.closeWindow?.();
      return;
    }
    markCloseTipShown();
    setShowCloseTip(true);
  }

  /** 「知道了」：收起气泡并执行本次被拦截的关闭。 */
  function confirmClose() {
    setShowCloseTip(false);
    (window as any).electronAPI?.closeWindow?.();
  }

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

  // Ctrl+1..4（Cmd 同）直达对应 Tab：长期多任务使用的键盘动线；数字越界忽略。
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return;
      const idx = Number(e.key) - 1;
      if (!Number.isInteger(idx) || idx < 0 || idx >= TAB_ORDER.length) return;
      e.preventDefault();
      setTab(TAB_ORDER[idx]);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  // 页内跨 Tab 跳转（应用页「无应用日志」→ 历史页看执行日志）。
  // 与托盘路径同款白名单校验：detail 非法时忽略，不切（否则所有面板被隐藏）。
  // V4 后续优化：detail 支持对象形态 { tab, historyStatusFilter }（过滤字段由
  // HistoryPage 自行监听同一事件消费），纯字符串形态保持兼容。
  useEffect(() => {
    const onSwitch = (e: Event) => {
      const raw: unknown = (e as CustomEvent).detail;
      const t = typeof raw === 'string'
        ? raw
        : raw && typeof raw === 'object' && typeof (raw as { tab?: unknown }).tab === 'string'
          ? (raw as { tab: string }).tab
          : undefined;
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

  /**
   * 顶栏双击最大化（V4-1 顶栏合并）：双击空白区（brand/tabs 间隙）切换最大化，
   * 双击命中按钮（tab/窗控）不触发——否则快速双击 tab 会被当成标题栏双击。
   */
  function handleTopbarDoubleClick(e: React.MouseEvent) {
    if ((e.target as HTMLElement).closest('button')) return;
    toggleMaximize();
  }

  return (
    <div className="app">
      {/* 单行顶栏（≥900px）：brand + tabs + 窗控同排，纵向 90px→48px 让给日志工作区；
          窄窗（<900px）CSS 折行回两行。拖拽区 = brand 与 tabs 容器空白（按钮 no-drag）；
          双击空白区切换最大化（Windows 标题栏惯例，无边框下自行补上） */}
      <div className="topbar" onDoubleClick={handleTopbarDoubleClick}>
        <div className="topbar-brand">
          <span className="titlebar-mark" aria-hidden="true">
            <Icon name="zap" />
          </span>
          <span className="titlebar-title">AutoCodeFlow</span>
          <span className="titlebar-edition">{shellT('shell.edition')}</span>
        </div>
        <div className="topbar-tabs">
          {/* Tab 导航：roving tabindex + ←/→/Home/End 键盘穿梭 */}
          <div
            className="tabs"
            role="tablist"
            aria-label={shellT('shell.tablistAria')}
            onKeyDown={onTabListKeyDown}
          >
            {TABS.map((meta, idx) => {
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
                  title={`${meta.label}（Ctrl+${idx + 1}）`}
                  // roving tabindex：仅当前选中 Tab 可被 Tab 键聚焦
                  tabIndex={active ? 0 : -1}
                >
                  <TabIcon kind={meta.key} />
                  {meta.label}
                </button>
              );
            })}
          </div>
        </div>
        <div className="topbar-controls">
          <button
            className="titlebar-btn"
            onClick={() => (window as any).electronAPI?.minimizeWindow?.()}
            title={shellT('shell.winMinTitle')}
            aria-label={shellT('shell.winMinAria')}
          >
            <svg className="titlebar-control-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true" focusable="false"><path d="M5 12h14" /></svg>
          </button>
          <button
            className="titlebar-btn"
            onClick={toggleMaximize}
            title={maximized ? shellT('shell.winRestoreTitle') : shellT('shell.winMaxTitle')}
            aria-label={maximized ? shellT('shell.winRestoreAria') : shellT('shell.winMaxAria')}
          >
            <svg className="titlebar-control-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" aria-hidden="true" focusable="false">
              {maximized ? <><path d="M8 7V4h11v11h-3" /><rect x="5" y="9" width="11" height="11" rx="1" /></> : <rect x="5" y="5" width="14" height="14" rx="1" />}
            </svg>
          </button>
          <button
            className="titlebar-btn titlebar-btn-close"
            onClick={requestClose}
            title={shellT('shell.winCloseTitle')}
            aria-label={shellT('shell.winCloseAria')}
          >
            <svg className="titlebar-control-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true" focusable="false"><path d="m6 6 12 12M18 6 6 18" /></svg>
          </button>
        </div>
      </div>

      {/* C-04：首次点 X 的一次性托盘驻留提示（非打断式：status + aria-live=polite；
          标记在气泡出现时已落盘，气泡期间再点 X / 最小化均直接放行）。
          V4-1（G-04）：文案改实——X 的语义是窗口关闭 + 应用驻留托盘（下次打开
          重建窗口），不是「最小化」，首次教育必须说准。 */}
      {showCloseTip && (
        <div className="close-tip" role="status" aria-live="polite">
          <p className="close-tip-line">{shellT('shell.closeTipLine1')}</p>
          <p className="close-tip-line">{shellT('shell.closeTipLine2')}</p>
          <button type="button" className="btn btn-sm btn-primary" onClick={confirmClose}>
            {shellT('shell.closeTipGotIt')}
          </button>
        </div>
      )}

      {/* 内容区 — 所有页面常驻 DOM，用 display 控制显隐，避免切 tab 时重新挂载导致闪烁。
          面板 DOM 序随 V4-1 Tab 重排（状态→历史→应用→配置），显隐由 hidden 控制。 */}
      <div className="main-content">
        <div id="status-panel" role="tabpanel" aria-labelledby="status-tab" hidden={tab !== 'status'} className={tab === 'status' ? 'tab-panel is-active' : 'tab-panel'}><StatusWindow active={tab === 'status'} /></div>
        <div id="history-panel" role="tabpanel" aria-labelledby="history-tab" hidden={tab !== 'history'} className={tab === 'history' ? 'tab-panel is-active' : 'tab-panel'}><HistoryPage active={tab === 'history'} /></div>
        <div id="apps-panel" role="tabpanel" aria-labelledby="apps-tab" hidden={tab !== 'apps'} className={tab === 'apps' ? 'tab-panel is-active' : 'tab-panel'}><AppsPage /></div>
        <div id="config-panel" role="tabpanel" aria-labelledby="config-tab" hidden={tab !== 'config'} className={tab === 'config' ? 'tab-panel is-active' : 'tab-panel'}><ConfigPage /></div>
      </div>
    </div>
  );
}
