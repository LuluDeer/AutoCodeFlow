/**
 * W5 覆盖迁移（IA-INBOX 后）：通知铃只是单一 /inbox 入口，不再承载失败速览面板。
 *
 * 原 W5 的三件事改由 Dashboard 承载并在此钉住：
 *   · 「没读到」与「确实没有」必须分开：ReadFailedCard 不渲染空态；
 *   · 读失败后的重试走 Dashboard 页级 StateError（refetch 六路，含最近失败）；
 *   · 读到空数组才显示「近期无失败记录」。
 *
 * 铃自身只保留一条断言：点击导航到 /inbox。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cloneElement } from 'react';
import '../i18n';
import { setLanguage } from '../i18n';
import NotificationBell from '../components/NotificationBell';
import RecentFailuresCard from '../components/dashboard/RecentFailuresCard';
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

function renderDashboard() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/dashboard']}>
        <Routes>
          <Route path="/dashboard" element={<DashboardPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function renderCard(props: {
  failures: unknown[] | undefined;
  failError: unknown;
}) {
  return render(
    <MemoryRouter>
      <RecentFailuresCard
        failures={props.failures as never}
        failError={props.failError}
        onOpenExecution={vi.fn()}
      />
    </MemoryRouter>,
  );
}

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
  it('点击铃只导航到 /inbox（不再打开失败面板）', () => {
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

describe('Dashboard RecentFailuresCard — W5 读失败/重试/空态', () => {
  it('读失败 → danger 文案在场，绝不渲染「近期无失败记录」空态', async () => {
    renderCard({ failures: undefined, failError: new Error('502 Bad Gateway') });

    const card = await screen.findByTestId('recent-failures-read-failed');
    expect(card.textContent).toContain('读取失败——近期失败记录无法确认，请点刷新重试');
    expect(card.textContent).not.toContain('近期无失败记录');
    expect(screen.queryByTestId('recent-failures-empty')).toBeNull();
  });

  it('读到空数组 → 真·空态，且不再显示读失败文案', async () => {
    renderCard({ failures: [], failError: null });

    const card = await screen.findByTestId('recent-failures-empty');
    expect(card.textContent).toContain('近期无失败记录');
    expect(card.textContent).not.toContain('读取失败');
    expect(screen.queryByTestId('recent-failures-read-failed')).toBeNull();
  });

  it('读失败后点 Dashboard 重试 → 重新拉取最近失败，空态恢复', async () => {
    mockedMetrics.getSummary.mockResolvedValue(summaryFixture as never);
    mockedMetrics.getDailyTrend.mockResolvedValue([] as never);
    mockedMetrics.getExecutorStats.mockResolvedValue([] as never);
    mockedMetrics.getSchedulerMetrics.mockResolvedValue(schedulerMetricsFixture as never);
    mockedTasks.schedulerStats.mockResolvedValue(schedulerStatsFixture as never);
    mockedMetrics.getRecentFailures
      .mockRejectedValueOnce(new Error('502 Bad Gateway'))
      .mockResolvedValueOnce([] as never);

    renderDashboard();

    expect(await screen.findByTestId('recent-failures-read-failed')).toBeTruthy();
    fireEvent.click(await screen.findByRole('button', { name: /重试/ }));

    await waitFor(() =>
      expect(mockedMetrics.getRecentFailures.mock.calls.length).toBeGreaterThanOrEqual(2),
    );
    await waitFor(() => expect(screen.queryByTestId('recent-failures-read-failed')).toBeNull());
    expect(await screen.findByTestId('recent-failures-empty')).toBeTruthy();
  });
});
