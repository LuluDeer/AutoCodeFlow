/**
 * IA-INBOX 后覆盖迁移：通知铃只保留 /inbox 入口；原「全部失败」多值深链由
 * Dashboard 的失败 Top 卡承载，断言与 dashboard-failed-deeplink-multistatus 同款：
 * ① 失败 Top「全部失败」必须带 status=failed,timeout；
 * ② 最近失败「全部记录」刻意不带 status（全部 ≠ 全部失败）；
 * ③ 两条深链都做真实路由落点断言，不能只看按钮被调用过。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cloneElement } from 'react';
import '../i18n';
import { setLanguage } from '../i18n';
import NotificationBell from '../components/NotificationBell';
import DashboardPage from '../pages/DashboardPage';
import { metricsApi } from '../api/metrics';
import { tasksApi } from '../api/tasks';
import { useAuthStore } from '../store/auth';

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
const mockedMetrics = vi.mocked(metricsApi, true);

vi.mock('../api/tasks', () => ({
  tasksApi: { schedulerStats: vi.fn() },
}));
const mockedTasks = vi.mocked(tasksApi, true);

vi.mock('recharts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('recharts')>();
  return {
    ...actual,
    ResponsiveContainer: ({ children }: { children: React.ReactElement<Record<string, unknown>> }) =>
      cloneElement(children, { width: 200, height: 36 }),
  };
});

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
    matches: false, media: q, onchange: null,
    addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}
Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, value: 800 });
Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, value: 400 });

class NoopEventSource {
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) {}
  addEventListener() {}
  close() {}
}

const summaryFixture = {
  totalTasks: 3,
  todayRuns: 12,
  totalExecutors: 2,
  onlineExecutors: 2,
  executions: { total: 120, success: 110, failed: 10, running: 1 },
  successRate: 91.7,
  avgDurationMs: 3200,
};

const trendFixture = [
  { date: '2026-09-05', success: 5, failed: 1, timeout: 0 },
  { date: '2026-09-06', success: 8, failed: 0, timeout: 0 },
  { date: '2026-09-07', success: 3, failed: 2, timeout: 0 },
];

const executorsFixture = [
  {
    id: 'exec-1',
    appName: 'alpha',
    address: '10.0.0.1:3002',
    status: 'online',
    cpuUsage: 30,
    memUsage: 50,
    runningTaskCount: 1,
    lastHeartbeat: new Date().toISOString(),
  },
];

// 超时风暴现场：卡片里的行全是 timeout，单值 status=failed 会丢掉全部。
const failuresFixture = [
  { id: 'f1', taskId: 'task-a', taskName: '任务A', errorMessage: 'timed out', failureReason: 'timeout', exitCode: null, createdAt: '2026-09-07T10:00:00Z', duration: 1000 },
  { id: 'f2', taskId: 'task-b', taskName: '任务B', errorMessage: 'timed out', failureReason: 'timeout', exitCode: null, createdAt: '2026-09-07T11:00:00Z', duration: 1200 },
];

const schedulerMetricsFixture = {
  counters: {
    ticks: 100,
    tickDurationMsTotal: 500,
    lastTickDurationMs: 3,
    lastTickAt: new Date().toISOString(),
    triggersClaimed: 20,
    triggersSkippedLockHeld: 0,
    triggersSkippedDbClaim: 0,
    triggersSkippedInactive: 0,
    triggersSkippedBlockStrategy: 0,
    triggersSkippedMaintenance: 0,
    triggersFailed: 0,
    dependencyTriggersClaimed: 0,
    dependencyTriggersSkipped: 0,
    triggerLatencyCount: 15,
    triggerLatencySumMs: 1500,
    triggerLatencyBuckets: [10, 4, 1, 0, 0, 0, 0, 0],
    lastTriggerLatencyMs: 42,
    startedAt: new Date(Date.now() - 60_000).toISOString(),
  },
  derived: {
    avgTickDurationMs: 5,
    tickRatePerSec: 1.6,
    triggerClaimRatePerSec: 0.3,
    avgTriggerLatencyMs: 100,
    p99TriggerLatencyMs: 80,
  },
  queue: { waiting: 0, active: 1, delayed: 0, failed: 0, completed: 20 },
  scheduler: {
    healthy: true,
    isLeader: true,
    activeTimers: 2,
    activeCronTasks: 1,
    runningTaskCount: 1,
    totalScheduledTasks: 3,
    uptime: 60,
  },
  instance: { pid: 1234, hostname: 'test-host' },
};

const schedulerStatsFixture = {
  healthy: true,
  isLeader: true,
  activeTimers: 2,
  activeCronTasks: 1,
  runningTaskCount: 1,
  totalScheduledTasks: 3,
  uptime: 60,
};

function ExecutionsProbe() {
  const loc = useLocation();
  return <div data-testid="executions-probe">{loc.pathname + loc.search}</div>;
}

function renderDashboard(initialEntry = '/dashboard') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <Routes>
          <Route path="/dashboard" element={<DashboardPage />} />
          <Route path="/executions" element={<ExecutionsProbe />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function mockDashboard() {
  mockedMetrics.getSummary.mockResolvedValue(summaryFixture as never);
  mockedMetrics.getDailyTrend.mockResolvedValue(trendFixture as never);
  mockedMetrics.getExecutorStats.mockResolvedValue(executorsFixture as never);
  mockedMetrics.getRecentFailures.mockResolvedValue(failuresFixture as never);
  mockedMetrics.getSchedulerMetrics.mockResolvedValue(schedulerMetricsFixture as never);
  mockedTasks.schedulerStats.mockResolvedValue(schedulerStatsFixture as never);
}

function linkByText(text: string): HTMLAnchorElement {
  const anchors = screen
    .getAllByText(text)
    .map((n) => n.closest('a'))
    .filter((a): a is HTMLAnchorElement => !!a);
  expect(anchors.length, `未找到文案为「${text}」的深链`).toBeGreaterThan(0);
  return anchors[0];
}

/** URLSearchParams 把逗号编码成 %2C。 */
const MULTI = 'status=failed%2Ctimeout';

beforeEach(async () => {
  await setLanguage('zh');
  cleanup();
  vi.clearAllMocks();
  vi.stubGlobal('EventSource', NoopEventSource);
  useAuthStore.setState({ user: { id: 1, username: 'root', role: 'admin' } });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('NotificationBell — 单一 /inbox 入口', () => {
  it('点击铃只导航到 /inbox（失败深链不再在铃面板内）', () => {
    render(
      <MemoryRouter initialEntries={['/']}>
        <Routes>
          <Route path="/" element={<NotificationBell />} />
          <Route path="/inbox" element={<div data-testid="inbox-probe">inbox</div>} />
        </Routes>
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByTestId('notify-bell'));
    expect(screen.getByTestId('inbox-probe').textContent).toBe('inbox');
  });
});

describe('Dashboard 失败深链 — 多值 status=failed,timeout（迁移自通知铃）', () => {
  it('① 失败 Top「全部失败」href 字面全等 /executions?status=failed%2Ctimeout', async () => {
    mockDashboard();
    renderDashboard();

    await waitFor(() => expect(screen.getByTestId('failure-top-list')).toBeTruthy(), { timeout: 5000 });
    const link = linkByText('全部失败');
    expect(link.getAttribute('href')).toBe(`/executions?${MULTI}`);
    expect(link.getAttribute('href')).not.toMatch(/[?&]status=failed(&|$)/);
    expect(link.getAttribute('href')).not.toBe('/executions');
  });

  it('② 最近失败「全部记录」刻意不带 status（href 恰为 /executions）', async () => {
    mockDashboard();
    renderDashboard();

    await waitFor(() => expect(screen.getByText('全部记录')).toBeTruthy(), { timeout: 5000 });
    const link = linkByText('全部记录');
    expect(link.getAttribute('href')).toBe('/executions');
    expect(link.getAttribute('href')).not.toContain('status=');
  });

  it('③ 点击「全部失败」真导航到执行页，落点 query 含 status=failed,timeout', async () => {
    mockDashboard();
    renderDashboard();

    await waitFor(() => expect(screen.getByTestId('failure-top-list')).toBeTruthy(), { timeout: 5000 });
    fireEvent.click(linkByText('全部失败'));

    const probe = await screen.findByTestId('executions-probe');
    expect(probe.textContent).toBe(`/executions?${MULTI}`);
  });

  it('④ 点击「全部记录」真导航到裸 /executions（无 query）', async () => {
    mockDashboard();
    renderDashboard();

    await waitFor(() => expect(screen.getByText('全部记录')).toBeTruthy(), { timeout: 5000 });
    fireEvent.click(linkByText('全部记录'));

    const probe = await screen.findByTestId('executions-probe');
    expect(probe.textContent).toBe('/executions');
  });

  it('⑤ project 上下文并存：失败 Top 带 status+project，全部记录只带 project', async () => {
    const UUID = '11111111-2222-3333-4444-555555555555';
    mockDashboard();
    renderDashboard(`/dashboard?project=${UUID}`);

    await waitFor(() => expect(screen.getByTestId('failure-top-list')).toBeTruthy(), { timeout: 5000 });
    await waitFor(() => expect(screen.getByText('全部记录')).toBeTruthy(), { timeout: 5000 });

    expect(linkByText('全部失败').getAttribute('href')).toBe(`/executions?${MULTI}&project=${UUID}`);
    expect(linkByText('全部记录').getAttribute('href')).toBe(`/executions?project=${UUID}`);
  });
});
