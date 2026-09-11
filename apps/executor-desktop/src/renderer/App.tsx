import React, { useState } from 'react';
import StatusWindow from './pages/StatusWindow';
import ConfigPage from './pages/ConfigPage';
import HistoryPage from './pages/HistoryPage';
import AppsPage from './pages/AppsPage';

type Tab = 'status' | 'config' | 'history' | 'apps';

export default function App() {
  // 根据 URL hash 判断是 wizard 还是主窗口
  const hash = window.location.hash.replace('#', '');

  if (hash === 'wizard') {
    // 动态加载 Wizard，避免循环依赖
    const Wizard = React.lazy(() => import('./pages/Wizard'));
    return (
        <React.Suspense fallback={<div className="app-loading" role="status" aria-live="polite">Loading...</div>}>

        <Wizard />
      </React.Suspense>
    );
  }

  return <MainWindow />;
}

function MainWindow() {
  const [tab, setTab] = useState<Tab>('status');

  // Listen for main-process tab-switch requests (tray menu)
  React.useEffect(() => {
    const api = (window as any).electronAPI;
    if (typeof api?.onSwitchTab === 'function') {
      const unsub = api.onSwitchTab((t: Tab) => setTab(t));
      return () => unsub?.();
    }
  }, []);

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

      {/* Tab 导航 */}
      <div className="tabs" role="tablist" aria-label="执行器页面">
        <button
          type="button"
          className={`tab${tab === 'status' ? ' active' : ''}`}
          onClick={() => setTab('status')}
          role="tab"
          aria-selected={tab === 'status'}
          aria-controls="status-panel"
          id="status-tab"
        >
          <span className="tab-icon">📡</span>
          状态监控
        </button>
        <button
          type="button"
          className={`tab${tab === 'config' ? ' active' : ''}`}
          onClick={() => setTab('config')}
          role="tab"
          aria-selected={tab === 'config'}
          aria-controls="config-panel"
          id="config-tab"
        >
          <span className="tab-icon">⚙️</span>
          配置
        </button>
        <button
          type="button"
          className={`tab${tab === 'history' ? ' active' : ''}`}
          onClick={() => setTab('history')}
          role="tab"
          aria-selected={tab === 'history'}
          aria-controls="history-panel"
          id="history-tab"
        >
          <span className="tab-icon">📋</span>
          历史
        </button>
        <button
          type="button"
          className={`tab${tab === 'apps' ? ' active' : ''}`}
          onClick={() => setTab('apps')}
          role="tab"
          aria-selected={tab === 'apps'}
          aria-controls="apps-panel"
          id="apps-tab"
        >
          <span className="tab-icon">📦</span>
          应用
        </button>
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
