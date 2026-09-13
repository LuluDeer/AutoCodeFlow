import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import ExecutorListPage from '../pages/ExecutorListPage';
import { executorsApi, type Executor } from '../api/executors';
import { useAuthStore } from '../store/auth';

vi.mock('../api/executors', () => ({
  executorsApi: {
    list: vi.fn(),
    getGroups: vi.fn().mockResolvedValue([]),
    reloadConfig: vi.fn(),
    rotateToken: vi.fn(),
  },
}));
const mockedExecutors = vi.mocked(executorsApi);

// antd Grid/响应式列在 jsdom 下的必需 polyfill（executor-ui07 同款）
if (!window.ResizeObserver) {
  window.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}
if (!window.matchMedia) {
  window.matchMedia = ((q: string) => ({
    matches: false,
    media: q,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

const NOW = Date.now();
const makeExecutor = (over: Partial<Executor>): Executor => ({
  id: 'ex-1',
  appName: 'alpha',
  address: '10.0.0.1:3002',
  status: 'online',
  cpuUsage: 30,
  memUsage: 50,
  runningTaskCount: 1,
  lastHeartbeat: new Date(NOW - 10_000).toISOString(),
  ...over,
});

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/executors']}>
        <Routes>
          <Route path="/executors" element={<ExecutorListPage />} />
          <Route path="/executors/:id" element={<div>executor-detail-mock</div>} />
          <Route path="/executors/install" element={<div>install-wizard-mock</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.mocked(mockedExecutors.list).mockReset();
  vi.mocked(mockedExecutors.getGroups).mockReset();
  localStorage.clear();
  useAuthStore.setState({ user: { id: 1, username: 'root', role: 'admin' } });
});
afterEach(() => cleanup());

describe('ExecutorListPage 徽标（UI-17：pull 模式 + 版本合规态）', () => {
  it('pull 执行器渲染 Pull 回连 Tag，push/缺省不渲染', async () => {
    vi.mocked(mockedExecutors.list).mockResolvedValue([
      makeExecutor({ id: 'ex-pull', appName: 'pull-exec', dispatchMode: 'pull' }),
      makeExecutor({ id: 'ex-push', appName: 'push-exec', dispatchMode: 'push' }),
      makeExecutor({ id: 'ex-legacy', appName: 'legacy-exec' }),
    ]);

    renderPage();
    await screen.findByText('pull-exec');

    expect(screen.getByText('Pull 回连')).toBeTruthy();
    expect(screen.queryByText('push-exec')).toBeTruthy();
    // push / 缺省均不渲染第二枚 Pull Tag（全局唯一：只有 pull-exec 那枚）
    expect(screen.getAllByText('Pull 回连')).toHaveLength(1);
  });

  it('versionCompliant=false 渲染版本过低 Tag，true/缺省不渲染', async () => {
    vi.mocked(mockedExecutors.list).mockResolvedValue([
      makeExecutor({ id: 'ex-old', appName: 'old-exec', executorVersion: '1.2.0', versionCompliant: false }),
      makeExecutor({ id: 'ex-ok', appName: 'ok-exec', executorVersion: '1.3.1', versionCompliant: true }),
      makeExecutor({ id: 'ex-na', appName: 'na-exec' }),
    ]);

    renderPage();
    await screen.findByText('old-exec');

    expect(screen.getByText('版本过低')).toBeTruthy();
    expect(screen.getAllByText('版本过低')).toHaveLength(1);
  });

  it('合规执行器同时持有 pull 徽标时两枚 Tag 并存', async () => {
    vi.mocked(mockedExecutors.list).mockResolvedValue([
      makeExecutor({ id: 'ex-both', appName: 'both-exec', dispatchMode: 'pull', versionCompliant: false }),
    ]);

    renderPage();
    await screen.findByText('both-exec');

    expect(screen.getByText('Pull 回连')).toBeTruthy();
    expect(screen.getByText('版本过低')).toBeTruthy();
  });
});
