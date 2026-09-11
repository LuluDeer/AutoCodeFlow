import React from 'react';
import ReactDOM from 'react-dom/client';
import { RouterProvider } from 'react-router-dom';
import { ErrorBoundary } from 'react-error-boundary';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { router } from './router';
import ErrorFallback from './components/ErrorFallback';
import { ThemedProviders, wireThemeSync } from './theme/ThemeProviders';
import './index.css';
// UI-12：可见焦点样式与「跳到主要内容」链接（独立于 index.css，避免与其在途改动冲突）
import './styles/a11y-focus.css';

/**
 * ARCH-26: TanStack Query 全局默认（渐进引入——新页面/改造页消费 src/api/queries.ts
 * 薄层 hooks 自动继承；既有 ahooks useRequest 页面保持原样，全站推广留后续轮）。
 * - staleTime 30s：对齐原 Dashboard 各卡 30s 轮询节奏，切页回来 30s 内不再重复拉取；
 * - retry 2：瞬时网络抖动自动重试，与 axios 拦截器的错误 toast 兜底并存（重试
 *   仍失败才 toast）；
 * - refetchOnWindowFocus 关闭：管理台多 Tab 并开场景下，聚焦瞬间全 key 重取
 *   会造成请求风暴，轮询/失效策略已覆盖数据新鲜度；
 * - refetchOnReconnect 保留默认 true：断网恢复后自动拉取最新数据。
 */
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      retry: 2,
      refetchOnWindowFocus: false,
    },
  },
});

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
