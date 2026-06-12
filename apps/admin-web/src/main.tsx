import React from 'react';
import ReactDOM from 'react-dom/client';
import { RouterProvider } from 'react-router-dom';
import { ErrorBoundary, FallbackProps } from 'react-error-boundary';
import { ConfigProvider, App } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { router } from './router';
import './index.css';

const queryClient = new QueryClient();

// FE-02: global fallback — prevents a render error from leaving the user on a blank screen
function ErrorFallback({ error, resetErrorBoundary }: FallbackProps) {
  return (
    <div
      role="alert"
      style={{ padding: '32px', textAlign: 'center', fontFamily: 'sans-serif' }}
    >
      <h2>页面出错了</h2>
      <p style={{ color: '#888', marginBottom: '16px' }}>{(error as Error).message}</p>
      <button onClick={resetErrorBoundary}>重新加载</button>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary FallbackComponent={ErrorFallback}>
      <QueryClientProvider client={queryClient}>
        <ConfigProvider locale={zhCN}>
          <App>
            <RouterProvider router={router} />
          </App>
        </ConfigProvider>
      </QueryClientProvider>
    </ErrorBoundary>
  </React.StrictMode>,
);
