/**
 * UI-16 第五批（收尾）：settings 三个 Tab + 安装向导的读请求错误态。
 *
 * 覆盖：
 *  1) ApiKeysSettings —— apiKeysApi.list 失败；
 *  2) EventSubscriptionsSettings —— eventSubscriptionsApi.list 失败；
 *  3) SecuritySettings.SessionsCard —— authApi.listSessions 失败；
 *  4) ExecutorInstallWizardPage —— executorPackagesApi.listLatest 失败（此前仅 toast）。
 *
 * 隔离方式对齐既有先例：mock api 层 + QueryClient(retry:false) + antd 浏览器 API shim。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import ApiKeysSettings from '../pages/settings/ApiKeysSettings';
import EventSubscriptionsSettings from '../pages/settings/EventSubscriptionsSettings';
import { SessionsCard } from '../pages/settings/SecuritySettings';
import ExecutorInstallWizardPage from '../pages/ExecutorInstallWizardPage';
import { apiKeysApi } from '../api/api-keys';
import { eventSubscriptionsApi } from '../api/event-subscriptions';
import { authApi } from '../api/auth';
import { executorPackagesApi } from '../api/executor-packages';

vi.mock('../api/api-keys', () => ({
  apiKeysApi: { list: vi.fn(), create: vi.fn(), revoke: vi.fn() },
}));
vi.mock('../api/event-subscriptions', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/event-subscriptions')>();
  return {
    ...actual,
    eventSubscriptionsApi: {
      list: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      remove: vi.fn(),
      listDeadLetters: vi.fn(),
      replayDeadLetter: vi.fn(),
    },
  };
});
vi.mock('../api/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/auth')>();
  return {
    ...actual,
    authApi: {
      ...actual.authApi,
      listSessions: vi.fn(),
      revokeSession: vi.fn(),
      revokeOtherSessions: vi.fn(),
    },
  };
});
vi.mock('../api/executor-packages', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/executor-packages')>();
  return {
    ...actual,
    executorPackagesApi: { ...actual.executorPackagesApi, listLatest: vi.fn() },
  };
});
vi.mock('../api/executors', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/executors')>();
  return {
    ...actual,
    executorsApi: { ...actual.executorsApi, list: vi.fn(), getInstallCmd: vi.fn() },
  };
});

// jsdom 缺失 antd 依赖的浏览器 API（既有先例 shim）
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

function renderPage(ui: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
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

describe('UI-16 第五批：settings 三 Tab + 安装向导读请求错误态', () => {
  it('ApiKeysSettings：列表失败展示错误块，重试重新请求', async () => {
    vi.mocked(apiKeysApi.list)
      .mockRejectedValueOnce(new Error('API Key 服务不可用'))
      .mockResolvedValueOnce([] as never);

    renderPage(<ApiKeysSettings />);

    expect(await screen.findByTestId('state-error')).toBeTruthy();
    expect(screen.getByText('API Key 列表加载失败')).toBeTruthy();
    expect(screen.getByText('API Key 服务不可用')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /重试/ }));

    await waitFor(() => {
      expect(apiKeysApi.list).toHaveBeenCalledTimes(2);
      expect(screen.queryByTestId('state-error')).toBeNull();
    });
  });

  it('EventSubscriptionsSettings：订阅列表失败展示错误块，重试重新请求', async () => {
    vi.mocked(eventSubscriptionsApi.list)
      .mockRejectedValueOnce(new Error('订阅服务不可用'))
      .mockResolvedValueOnce([] as never);

    renderPage(<EventSubscriptionsSettings />);

    expect(await screen.findByText('事件订阅列表加载失败')).toBeTruthy();
    expect(screen.getByText('订阅服务不可用')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /重试/ }));

    await waitFor(() => {
      expect(eventSubscriptionsApi.list).toHaveBeenCalledTimes(2);
      expect(screen.queryByText('事件订阅列表加载失败')).toBeNull();
    });
  });

  it('SessionsCard：会话列表失败展示错误块而非「暂无活跃会话」', async () => {
    vi.mocked(authApi.listSessions).mockRejectedValue(new Error('会话服务不可用'));

    renderPage(<SessionsCard />);

    expect(await screen.findByText('登录会话加载失败')).toBeTruthy();
    expect(screen.getByText('会话服务不可用')).toBeTruthy();
    expect(screen.queryByText('暂无活跃会话')).toBeNull();
  });

  it('ExecutorInstallWizardPage：安装包列表失败展示错误块，重试重新请求', async () => {
    vi.mocked(executorPackagesApi.listLatest)
      .mockRejectedValueOnce(new Error('安装包服务不可用'))
      .mockResolvedValueOnce([] as never);

    renderPage(<ExecutorInstallWizardPage />);

    expect(await screen.findByText('安装包列表加载失败')).toBeTruthy();
    expect(screen.getByText('安装包服务不可用')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /重试/ }));

    await waitFor(() => {
      expect(executorPackagesApi.listLatest).toHaveBeenCalledTimes(2);
      expect(screen.queryByText('安装包列表加载失败')).toBeNull();
    });
  });
});
