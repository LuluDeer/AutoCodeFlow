import React from 'react';
import ReactDOM from 'react-dom/client';
import { RouterProvider } from 'react-router-dom';
import { ErrorBoundary } from 'react-error-boundary';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { router } from './router';
import ErrorFallback from './components/ErrorFallback';
import { ThemedProviders, wireThemeSync } from './theme/ThemeProviders';
import './index.css';

const queryClient = new QueryClient();

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
