/**
 * UI-16 第四批：三个 P2 页面的读请求失败错误态（页内 StateError + 重试）。
 *
 * 覆盖：
 *  1) NotificationSettingsPage —— 渠道列表（client.get /notification/channels）失败；
 *  2) NotificationSettingsPage —— 静默规则列表（silencesApi.list）失败；
 *  3) settings/index 系统配置 Tab —— configApi.findAll 失败；
 *  4) settings/index AI 配置 Tab —— aiApi.getConfig 失败；
 *  5) DashboardPage —— metricsApi.getSummary 失败（任一指标失败即整页错误块）。
 *
 * 隔离方式对齐既有先例：mock api 层 + QueryClient(retry:false) + antd 浏览器 API shim。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { cloneElement, type ReactElement, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import NotificationSettingsPage from '../pages/NotificationSettingsPage';
import SettingsPage from '../pages/settings/index';
import DashboardPage from '../pages/DashboardPage';
import { client } from '../api/client';
import { configApi } from '../api/config';
import { aiApi } from '../api/ai';
import { metricsApi } from '../api/metrics';
import { tasksApi } from '../api/tasks';
import { silencesApi } from '../api/notifications';
import { useAuthStore } from '../store/auth';

// 保留 getApiBaseUrl 等真实导出（DashboardPage 的 SSE hook 依赖它拼接 URL），只替换 client
vi.mock('../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/client')>();
  return {
    ...actual,
    client: { get: vi.fn(), patch: vi.fn(), post: vi.fn(), delete: vi.fn() },
  };
});
vi.mock('../api/notifications', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/notifications')>();
  return { ...actual, silencesApi: { list: vi.fn(), create: vi.fn(), remove: vi.fn() } };
});
vi.mock('../api/config', () => ({
  configApi: {
    findAll: vi.fn(),
    getExecutorToken: vi.fn(),
    generateExecutorToken: vi.fn(),
    upsert: vi.fn(),
    remove: vi.fn(),
    rollback: vi.fn(),
    getHistory: vi.fn(),
  },
}));
vi.mock('../api/ai', () => ({
  aiApi: {
    getConfig: vi.fn(),
    saveConfig: vi.fn(),
    testConfig: vi.fn(),
    analyzeApp: vi.fn(),
    suggestSchedule: vi.fn(),
  },
}));
vi.mock('../api/metrics', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/metrics')>();
  return {
    ...actual,
    metricsApi: {
      getSummary: vi.fn(),
      getDailyTrend: vi.fn(),
      getExecutorStats: vi.fn(),
      getRecentFailures: vi.fn(),
      getSchedulerMetrics: vi.fn(),
    },
  };
});
vi.mock('../api/tasks', () => ({
  tasksApi: { schedulerStats: vi.fn() },
}));
// recharts ResponsiveContainer 依赖布局测量（既有先例：注入显式宽高）
vi.mock('recharts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('recharts')>();
  return {
    ...actual,
    ResponsiveContainer: ({ children }: { children: ReactElement }) =>
      cloneElement(children, { width: 200, height: 36 } as never),
  };
});

// jsdom 缺失 antd / SSE 依赖的浏览器 API（既有先例 shim）
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
class NoopEventSource {
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) {}
  addEventListener() {}
  close() {}
}
vi.stubGlobal('EventSource', NoopEventSource);

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
  useAuthStore.setState({ user: { id: 1, username: 'root', role: 'admin' } });
  // settings 页非目标 Tab 的默认成功响应（避免无关请求失败干扰断言）
  vi.mocked(configApi.getExecutorToken).mockResolvedValue({ hasToken: false, token: null } as never);
  vi.mocked(configApi.findAll).mockResolvedValue([] as never);
  vi.mocked(aiApi.getConfig).mockResolvedValue({ provider: 'disabled', hasApiKey: false } as never);
  vi.mocked(tasksApi.schedulerStats).mockResolvedValue({ healthy: true, totalScheduledTasks: 0 } as never);
});

afterEach(() => {
  cleanup();
});

describe('UI-16 第四批：P2 页面读请求错误态', () => {
  it('NotificationSettingsPage：渠道列表失败展示错误块，重试重新请求', async () => {
    vi.mocked(client.get)
      .mockRejectedValueOnce(new Error('通知服务不可用'))
      .mockResolvedValueOnce([] as never);

    renderPage(<NotificationSettingsPage />);

    expect(await screen.findByTestId('state-error')).toBeTruthy();
    expect(screen.getByText('通知渠道加载失败')).toBeTruthy();
    expect(screen.getByText('通知服务不可用')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /重试/ }));

    await waitFor(() => {
      expect(client.get).toHaveBeenCalledTimes(2);
      expect(screen.queryByTestId('state-error')).toBeNull();
    });
  });

  it('NotificationSettingsPage：静默规则列表失败展示错误块而非「暂无静默规则」', async () => {
    vi.mocked(client.get).mockResolvedValue([] as never);
    vi.mocked(silencesApi.list).mockRejectedValue(new Error('静默服务不可用'));

    renderPage(<NotificationSettingsPage />);
    await waitFor(() => expect(client.get).toHaveBeenCalled());

    fireEvent.click(await screen.findByRole('tab', { name: '静默规则' }));

    expect(await screen.findByText('静默规则加载失败')).toBeTruthy();
    expect(screen.getByText('静默服务不可用')).toBeTruthy();
    expect(screen.queryByText('暂无静默规则')).toBeNull();
  });

  it('settings 系统配置 Tab：加载失败展示错误块，重试重新请求', async () => {
    vi.mocked(configApi.findAll)
      .mockRejectedValueOnce(new Error('配置服务不可用'))
      .mockResolvedValueOnce([] as never);

    renderPage(<SettingsPage />);
    fireEvent.click(await screen.findByRole('tab', { name: '系统配置' }));

    expect(await screen.findByText('系统配置加载失败')).toBeTruthy();
    expect(screen.getByText('配置服务不可用')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /重试/ }));

    await waitFor(() => {
      expect(configApi.findAll).toHaveBeenCalledTimes(2);
      expect(screen.queryByText('系统配置加载失败')).toBeNull();
    });
  });

  it('settings AI 配置 Tab：加载失败展示错误块而非永久 Spin', async () => {
    vi.mocked(aiApi.getConfig).mockRejectedValue(new Error('AI 服务不可用'));

    renderPage(<SettingsPage />);
    fireEvent.click(await screen.findByRole('tab', { name: /AI 配置/ }));

    expect(await screen.findByText('AI 配置加载失败')).toBeTruthy();
    expect(screen.getByText('AI 服务不可用')).toBeTruthy();
  });

  it('DashboardPage：任一指标失败展示错误块，重试重新请求', async () => {
    vi.mocked(metricsApi.getSummary)
      .mockRejectedValueOnce(new Error('指标服务不可用'))
      .mockResolvedValue({} as never);
    vi.mocked(metricsApi.getDailyTrend).mockResolvedValue([] as never);
    vi.mocked(metricsApi.getExecutorStats).mockResolvedValue([] as never);
    vi.mocked(metricsApi.getRecentFailures).mockResolvedValue([] as never);
    vi.mocked(metricsApi.getSchedulerMetrics).mockResolvedValue({} as never);

    renderPage(<DashboardPage />);

    expect(await screen.findByText('控制台数据加载失败')).toBeTruthy();
    expect(screen.getByText('指标服务不可用')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /重试/ }));

    await waitFor(() => {
      expect(metricsApi.getSummary).toHaveBeenCalledTimes(2);
      expect(screen.queryByText('控制台数据加载失败')).toBeNull();
    });
  });
});
