import React, { useState } from 'react';
import StatusWindow from './pages/StatusWindow';
import ConfigPage from './pages/ConfigPage';
import HistoryPage from './pages/HistoryPage';

type Tab = 'status' | 'config' | 'history';

export default function App() {
  // 根据 URL hash 判断是 wizard 还是主窗口
  const hash = window.location.hash.replace('#', '');

  if (hash === 'wizard') {
    // 动态加载 Wizard，避免循环依赖
    const Wizard = React.lazy(() => import('./pages/Wizard'));
    return (
      <React.Suspense fallback={<div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', color: '#6e6e73', fontSize: 13 }}>Loading...</div>}>
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
      <div className="tabs">
        <div
          className={`tab${tab === 'status' ? ' active' : ''}`}
          onClick={() => setTab('status')}
        >
          <span className="tab-icon">📡</span>
          状态监控
        </div>
        <div
          className={`tab${tab === 'config' ? ' active' : ''}`}
          onClick={() => setTab('config')}
        >
          <span className="tab-icon">⚙️</span>
          配置
        </div>
        <div
          className={`tab${tab === 'history' ? ' active' : ''}`}
          onClick={() => setTab('history')}
        >
          <span className="tab-icon">📋</span>
          历史
        </div>
      </div>

      {/* 内容区 — 所有页面常驻 DOM，用 display 控制显隐，避免切 tab 时重新挂载导致闪烁 */}
      <div className="main-content">
        <div style={{ display: tab === 'status' ? 'contents' : 'none' }}><StatusWindow /></div>
        <div style={{ display: tab === 'config' ? 'contents' : 'none' }}><ConfigPage /></div>
        <div style={{ display: tab === 'history' ? 'contents' : 'none' }}><HistoryPage /></div>
      </div>
    </div>
  );
}
