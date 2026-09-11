/**
 * UI-16：页内错误态补齐（UI-08 缩水项）。
 *
 * 断言纪律（行为断言，非快照）：
 * - 列表请求失败时页面内出现 StateError（role=alert + data-testid），且标题
 *   指明是哪一块数据；写操作失败仍走 toast，不在本文件范围。
 * - 点击「重试」会重新发起同一条加载请求（不是只刷新 UI）。
 * - 加载成功时错误块不出现（避免残留上一次错误态）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import TaskListPage from '../pages/TaskListPage';
import AppDeploymentPage from '../pages/AppDeploymentPage';
import { tasksApi } from '../api/tasks';
import { deploymentsApi } from '../api/applications';
import { executorsApi } from '../api/executors';

vi.mock('../api/tasks', () => ({
  tasksApi: {
    list: vi.fn(),
    get: vi.fn(),
    create: vi.fn(),
    delete: vi.fn(),
    trigger: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    batchTrigger: vi.fn(),
    batchPause: vi.fn(),
    batchResume: vi.fn(),
    batchDelete: vi.fn(),
  },
}));
vi.mock('../api/applications', () => ({
  deploymentsApi: {
    list: vi.fn(),
    deploy: vi.fn(),
    stop: vi.fn(),
    upgrade: vi.fn(),
    approve: vi.fn(),
    reject: vi.fn(),
    cancel: vi.fn(),
  },
  applicationsApi: { upgradeAll: vi.fn() },
}));
vi.mock('../api/executors', () => ({
  executorsApi: { list: vi.fn() },
}));

const g = globalThis as Record<string, unknown>;
if (!g.ResizeObserver) {
  g.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
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

const mockedTasks = vi.mocked(tasksApi, true);
const mockedDeployments = vi.mocked(deploymentsApi, true);
const mockedExecutors = vi.mocked(executorsApi, true);

function renderWithQuery(ui: React.ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
});

describe('UI-16 TaskListPage 页内错误态', () => {
  it('列表请求失败：页内出现错误块（含标题与错误信息），不再只弹 toast', async () => {
    mockedTasks.list.mockRejectedValue(new Error('任务服务不可用'));
    renderWithQuery(<TaskListPage />);

    const alert = await screen.findByTestId('state-error');
    expect(alert).toBeTruthy();
    expect(alert.getAttribute('role')).toBe('alert');
    expect(screen.getByText('任务列表加载失败')).toBeTruthy();
    expect(screen.getByText('任务服务不可用')).toBeTruthy();
  });

  it('点击重试重新发起列表请求', async () => {
    mockedTasks.list.mockRejectedValueOnce(new Error('网络抖动'));
    mockedTasks.list.mockResolvedValueOnce({ items: [], total: 0, page: 1, pageSize: 20 });
    renderWithQuery(<TaskListPage />);

    await screen.findByTestId('state-error');
    fireEvent.click(screen.getByRole('button', { name: /重试/ }));

    await waitFor(() => expect(mockedTasks.list).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByTestId('state-error')).toBeNull());
  });

  it('加载成功不渲染错误块', async () => {
    mockedTasks.list.mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 20 });
    renderWithQuery(<TaskListPage />);
    await waitFor(() => expect(mockedTasks.list).toHaveBeenCalled());
    expect(screen.queryByTestId('state-error')).toBeNull();
  });
});

describe('UI-16 AppDeploymentPage 页内错误态', () => {
  it('部署列表加载失败：页内错误块 + 重试重新拉取', async () => {
    mockedDeployments.list.mockRejectedValueOnce(new Error('部署服务 500'));
    mockedExecutors.list.mockRejectedValueOnce(new Error('部署服务 500'));
    render(<AppDeploymentPage applicationId="app-1" />);

    const alert = await screen.findByTestId('state-error');
    expect(screen.getByText('部署列表加载失败')).toBeTruthy();
    expect(screen.getByText('部署服务 500')).toBeTruthy();
    // 失败态不展示「该应用尚未部署」空态（避免与错误态互相掩盖）
    expect(screen.queryByText('该应用尚未部署')).toBeNull();
    expect(alert).toBeTruthy();

    mockedDeployments.list.mockResolvedValueOnce({ data: [], total: 0 });
    mockedExecutors.list.mockResolvedValueOnce([]);
    fireEvent.click(screen.getByRole('button', { name: /重试/ }));

    await waitFor(() => expect(mockedDeployments.list).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByTestId('state-error')).toBeNull());
  });

  it('加载成功不渲染错误块', async () => {
    mockedDeployments.list.mockResolvedValue({ data: [], total: 0 });
    mockedExecutors.list.mockResolvedValue([]);
    render(<AppDeploymentPage applicationId="app-1" />);
    await waitFor(() => expect(screen.getByText('该应用尚未部署')).toBeTruthy());
    expect(screen.queryByTestId('state-error')).toBeNull();
  });
});
