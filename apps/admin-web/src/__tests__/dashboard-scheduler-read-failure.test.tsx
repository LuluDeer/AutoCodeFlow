/**
 * R171（P2-3）：**调度两路读失败不得被渲染成「没有数据 / 没有问题」**。
 *
 * ## 缺陷现场（`DashboardPage`）
 *
 * 页面的错误信号 `dashboardError = summaryError ?? trendError ?? execError ?? failError`
 * 只拼了四路，**漏掉调度两路**（`useSchedulerMetrics` / `useSchedulerStats`）。后果两条，
 * 都出现在同一个刷新失败的页面上：
 *
 *   ① 「调度延迟」卡：`metrics === undefined` ⇒ `hasSamples=false` ⇒ 卡面写
 *      「暂无定时触发样本」。那是「确实没有样本」的文案，而事实是**没读到**。
 *   ② 页头健康 Tag：`{schedulerStats && <Tag …>}` ⇒ 失败时 Tag **整块消失**。
 *      页头比平时更干净，读者只能得出「没有健康问题」——这比显示「未知」更糟。
 *
 * 修法：两路 error 并进 `dashboardError`（→ 页内 StateError + 覆盖六路的 refetch），
 * 健康 Tag 在「读不到」时渲染**明确的未知态**，延迟卡给失败文案。
 *
 * ## 本 spec 钉住三条
 *
 * ① `schedulerStats` 失败 ⇒ 页头出现「调度器健康：未知（读取失败）」Tag（**不是消失**），
 *    且页内错误块出现；
 * ② `schedulerMetrics` 失败 ⇒ 延迟卡显示「读取失败…」而**不**显示「暂无定时触发样本」，
 *    且页内错误块出现；
 * ③ 控制组：两路都成功 ⇒ 健康 Tag + 样本数 + **没有**错误块（证明①②不是恒显示的假绿）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cloneElement } from 'react';
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
  tasksApi: {
    schedulerStats: vi.fn(),
  },
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
Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, value: 800 });
Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, value: 400 });

// UI-14：DashboardPage 挂 useMetricsStream（SSE）——jsdom 无 EventSource，用 noop 桩。
class NoopEventSource {
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) {}
  addEventListener() {}
  close() {}
}

const daysAgo = (n: number) => {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

const summaryFixture = {
  totalTasks: 3,
  todayRuns: 12,
  totalExecutors: 2,
  onlineExecutors: 2,
  executions: { total: 120, success: 110, failed: 10, running: 1 },
  successRate: 91.7,
  avgDurationMs: 3200,
};
const trendFixture = [{ date: daysAgo(0), success: 3, failed: 2, timeout: 0 }];
const schedulerMetricsFixture = {
  counters: { triggerLatencyCount: 15, lastTriggerLatencyMs: 42, triggerLatencyBuckets: [10, 4, 1, 0, 0, 0, 0, 0] },
  derived: { avgTriggerLatencyMs: 100, p99TriggerLatencyMs: 80 },
  queue: { waiting: 0, active: 1, delayed: 0, failed: 0, completed: 20 },
  scheduler: { healthy: true, isLeader: true, activeTimers: 2, activeCronTasks: 1, runningTaskCount: 1, totalScheduledTasks: 3, uptime: 60 },
  instance: { pid: 1234, hostname: 'test-host' },
};
const schedulerStatsFixture = {
  healthy: true,
  activeTimers: 2,
  activeCronTasks: 1,
  runningTaskCount: 1,
  totalScheduledTasks: 3,
  uptime: 60,
};

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/dashboard']}>
        <Routes>
          <Route path="/dashboard" element={<DashboardPage />} />
          <Route path="/tasks/:id" element={<div>task-detail-mock</div>} />
          <Route path="/executors/:id" element={<div>executor-detail-mock</div>} />
          <Route path="/tasks/new" element={<div>task-new-mock</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function mockHealthy() {
  mockedMetrics.getSummary.mockResolvedValue(summaryFixture as never);
  mockedMetrics.getDailyTrend.mockResolvedValue(trendFixture as never);
  mockedMetrics.getExecutorStats.mockResolvedValue([] as never);
  mockedMetrics.getRecentFailures.mockResolvedValue([] as never);
  mockedMetrics.getSchedulerMetrics.mockResolvedValue(schedulerMetricsFixture as never);
  mockedTasks.schedulerStats.mockResolvedValue(schedulerStatsFixture as never);
}

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.stubGlobal('EventSource', NoopEventSource);
  useAuthStore.setState({ user: { id: 1, username: 'root', role: 'admin' } });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('R171 P2-3：调度两路读失败的可区分性', () => {
  it('① schedulerStats 失败 ⇒ 健康 Tag 显示「未知（读取失败）」而不是消失，且页内报错', async () => {
    mockHealthy();
    mockedTasks.schedulerStats.mockRejectedValue(new Error('502 Bad Gateway'));

    renderPage();

    const tag = await screen.findByText(/调度器健康：未知（读取失败）/);
    expect(tag).toBeTruthy();
    // 页内错误块（dashboardError 已并入这一路）
    expect(screen.getByTestId('state-error')).toBeTruthy();
    // 旧行为的证据：失败时页头**没有**任何调度 Tag
    expect(screen.queryByText(/调度器 健康/)).toBeNull();
  });

  it('② schedulerMetrics 失败 ⇒ 延迟卡说「读取失败」，不冒充「暂无定时触发样本」', async () => {
    mockHealthy();
    mockedMetrics.getSchedulerMetrics.mockRejectedValue(new Error('502 Bad Gateway'));

    renderPage();

    expect(await screen.findByText(/无法确认是否有定时触发样本/)).toBeTruthy();
    expect(screen.queryByText(/暂无定时触发样本/)).toBeNull();
    expect(screen.getByTestId('state-error')).toBeTruthy();
  });

  it('③ 控制组：两路都成功 ⇒ 健康 Tag + 样本数 + 没有错误块', async () => {
    mockHealthy();

    renderPage();

    expect(await screen.findByText(/调度器 健康/)).toBeTruthy();
    expect(await screen.findByText(/样本 15 次/)).toBeTruthy();
    expect(screen.queryByTestId('state-error')).toBeNull();
    expect(screen.queryByText(/调度器健康：未知/)).toBeNull();
  });
});
