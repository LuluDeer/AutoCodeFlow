import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { ErrorBoundary } from '@/components/error-boundary';
import '@fontsource-variable/inter';
import '@fontsource-variable/jetbrains-mono';
import './styles.css';
import { bridge } from '@/lib/ipc';
import { resolveLocale, setLocale } from '@/lib/i18n';

/**
 * 语言在首帧之前确定（与 V1 同口径：改语言后重载窗口，不做热切换）。
 * config 读不到时按系统语言兜底，不阻塞渲染。
 */
async function bootstrap() {
  try {
    const cfg = await bridge.getConfig();
    setLocale(resolveLocale(cfg.uiLanguage, navigator.language));
  } catch {
    setLocale(resolveLocale('auto', navigator.language));
  }

  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <ErrorBoundary variant="root">
        <App />
      </ErrorBoundary>
    </React.StrictMode>,
  );
}

void bootstrap();
