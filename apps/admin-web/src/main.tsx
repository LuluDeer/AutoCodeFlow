import React from 'react';
import ReactDOM from 'react-dom/client';
import { RouterProvider } from 'react-router-dom';
import { ErrorBoundary } from 'react-error-boundary';
import { QueryClientProvider } from '@tanstack/react-query';
import { router } from './router';
import ErrorFallback from './components/ErrorFallback';
import { ThemedProviders, wireThemeSync } from './theme/ThemeProviders';
// F-32（DEEP_REVIEW 0ef3bbe）：QueryClient 默认配置（含重试职责归一）抽到
// api/queryClient.ts，便于单测断言默认值；main.tsx 只负责挂载。
import { queryClient } from './api/queryClient';
import './index.css';
// UI-12：可见焦点样式与「跳到主要内容」链接（独立于 index.css，避免与其在途改动冲突）
import './styles/a11y-focus.css';

// UI-02：data-theme 属性 + system 态 matchMedia 订阅（模块加载期接线一次）
wireThemeSync();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary FallbackComponent={ErrorFallback}>
      <QueryClientProvider client={queryClient}>
        <ThemedProviders>
          <RouterProvider router={router} />
        </ThemedProviders>
      </QueryClientProvider>
    </ErrorBoundary>
  </React.StrictMode>,
);
