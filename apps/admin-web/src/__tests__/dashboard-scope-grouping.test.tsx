/**
 * P2-1（Dashboard 口径分离）回归：
 *  ① 指标区视觉分成「随当前项目」与「全局口径（机队/调度）」两组，逐卡口径徽章；
 *  ② 选中具体项目时，随项目卡按 projectId 请求，全局卡走不带 projectId 的调用；
 *  ③ 全局卡数值来自全局 summary，切换项目不变（后端语义：执行器计数 / 调度
 *     计数器 / 队列深度无项目归属，见 metrics.service.ts 114–123 行注释）。
 *
 * 对齐 dashboard-ui04.test.tsx 的装配：mock api 层 + QueryClientProvider +
 * recharts ResponsiveContainer 显式宽高 + antd 浏览器 API shim。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
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

const PROJECT_UUID = 'aaaaaaaa-0000-4000-8000-000000000001';

// 随项目口径 summary：执行器计数故意与全局不同，用来证明在线执行器卡读的是全局那一路。
const scopedSummary = {
  totalTasks: 18, todayRuns: 64, totalExecutors: 4, onlineExecutors: 2,
  executions: { total: 412, success: 388, failed: 21, running: 3 },
  successRate: 94.2, avgDurationMs: 6840,
};
const globalSummary = {
  totalTasks: 128, todayRuns: 342, totalExecutors: 12, onlineExecutors: 9,
  executions: { total: 15230, success: 14520, failed: 512, running: 7 },
  successRate: 96.4, avgDurationMs: 5230,
};

const daysAgo = (n: number) => {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const trendFixture = [
  { date: daysAgo(2), success: 5, failed: 1, timeout: 0 },
  { date: daysAgo(1), success: 8, failed: 0, timeout: 0 },
  { date: daysAgo(0), success: 3, failed: 2, timeout: 0 },
];
const executorsFixture = [
  { id: 'exec-1', appName: 'alpha', address: '10.0.0.1:3002', status: 'online', cpuUsage: 30, memUsage: 50, runningTaskCount: 1, lastHeartbeat: new Date().toISOString() },
  { id: 'exec-2', appName: 'beta', address: '10.0.0.2:3002', status: 'busy', cpuUsage: 90, memUsage: 70, runningTaskCount: 4, lastHeartbeat: new Date().toISOString() },
];
const failuresFixture = [
  { id: 'f1', taskId: 'task-a', taskName: '任务A', errorMessage: 'boom', failureReason: 'script_error', exitCode: 1, createdAt: '2026-09-07T10:00:00Z', duration: 1000 },
];
const schedulerMetricsFixture = {
  counters: { ticks: 100, tickDurationMsTotal: 500, lastTickDurationMs: 3, lastTickAt: new Date().toISOString(), triggersClaimed: 20, triggersSkippedLockHeld: 0, triggersSkippedDbClaim: 0, triggersSkippedInactive: 0, triggersSkippedBlockStrategy: 0, triggersSkippedMaintenance: 0, triggersFailed: 0, dependencyTriggersClaimed: 0, dependencyTriggersSkipped: 0, triggerLatencyCount: 15, triggerLatencySumMs: 1500, triggerLatencyBuckets: [10, 4, 1, 0, 0, 0, 0, 0], lastTriggerLatencyMs: 42, startedAt: new Date(Date.now() - 60_000).toISOString() },
  derived: { avgTickDurationMs: 5, tickRatePerSec: 1.6, triggerClaimRatePerSec: 0.3, avgTriggerLatencyMs: 100, p99TriggerLatencyMs: 80 },
  queue: { waiting: 0, active: 1, delayed: 0, failed: 0, completed: 20 },
  scheduler: { healthy: true, isLeader: true, activeTimers: 2, activeCronTasks: 1, runningTaskCount: 1, totalScheduledTasks: 3, uptime: 60 },
  instance: { pid: 1234, hostname: 'test-host' },
};
const schedulerStatsFixture = { healthy: true, isLeader: true, activeTimers: 2, activeCronTasks: 1, runningTaskCount: 1, totalScheduledTasks: 3, uptime: 60 };

function renderPage(entry = '/dashboard') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[entry]}>
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

function mockWiring() {
  // 镜像后端契约：summary 按 projectId 分流；executors/scheduler 无项目参数。
  mockedMetrics.getSummary.mockImplementation((params?: { projectId?: string }) =>
    Promise.resolve(params?.projectId === PROJECT_UUID ? scopedSummary : globalSummary),
  );
  mockedMetrics.getDailyTrend.mockResolvedValue(trendFixture);
  mockedMetrics.getExecutorStats.mockResolvedValue(executorsFixture);
  mockedMetrics.getRecentFailures.mockResolvedValue(failuresFixture);
  mockedMetrics.getSchedulerMetrics.mockResolvedValue(schedulerMetricsFixture);
  mockedTasks.schedulerStats.mockResolvedValue(schedulerStatsFixture);
}

class NoopEventSource {
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) {}
  addEventListener() {}
  close() {}
}

describe('DashboardPage — P2-1 指标口径分离', () => {
  beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
    vi.stubGlobal('EventSource', NoopEventSource);
    useAuthStore.setState({ user: { id: 1, username: 'root', role: 'admin' } });
  });

  it('渲染两组分区标题：随当前项目 / 全局口径（机队/调度）', async () => {
    mockWiring();
    renderPage();
    await waitFor(() => expect(screen.getByTestId('failure-top-list')).toBeTruthy(), { timeout: 5000 });

    expect(screen.getByTestId('scope-group-project').textContent).toContain('随当前项目');
    expect(screen.getByTestId('scope-group-global').textContent).toContain('全局口径');
  });

  it('逐卡口径徽章：8 张随项目卡 + 1 个项目分区徽章；3 张全局卡 + 1 个全局分区徽章', async () => {
    mockWiring();
    renderPage();
    await waitFor(() => expect(screen.getByTestId('failure-top-list')).toBeTruthy(), { timeout: 5000 });

    // 仅保留分区头 ScopeSectionHeader 的项目/全局徽章（去噪移除子卡片重复徽章）。
    expect(screen.getAllByTestId('scope-badge-project')).toHaveLength(1);
    expect(screen.getAllByTestId('scope-badge-global')).toHaveLength(1);
  });

  it('选中具体项目：随项目请求带 projectId，全局请求不带 projectId', async () => {
    mockWiring();
    renderPage(`/dashboard?project=${PROJECT_UUID}`);
    await waitFor(() => expect(screen.getByTestId('failure-top-list')).toBeTruthy(), { timeout: 5000 });

    const summaryCalls = mockedMetrics.getSummary.mock.calls;
    // 随项目 summary：带 projectId
    expect(summaryCalls.some(([params]) => params?.projectId === PROJECT_UUID)).toBe(true);
    // 全局 summary（执行器计数）：不带 projectId
    expect(summaryCalls.some(([params]) => !params?.projectId)).toBe(true);

    // 趋势 / 失败明细：随项目（trend 签名为 getDailyTrend(days, params, signal)）
    expect(mockedMetrics.getDailyTrend.mock.calls[0]?.[1]).toMatchObject({ projectId: PROJECT_UUID });
    expect(mockedMetrics.getRecentFailures.mock.calls[0]?.[0]).toMatchObject({ projectId: PROJECT_UUID });

    // 全局端点：签名只收 AbortSignal（无项目参数），第一参不得是 { projectId } 对象。
    expect(mockedMetrics.getExecutorStats.mock.calls.length).toBeGreaterThan(0);
    expect(mockedMetrics.getSchedulerMetrics.mock.calls.length).toBeGreaterThan(0);
    expect(mockedTasks.schedulerStats.mock.calls.length).toBeGreaterThan(0);
    for (const call of mockedMetrics.getExecutorStats.mock.calls) expect(call[0]).toBeInstanceOf(AbortSignal);
    for (const call of mockedMetrics.getSchedulerMetrics.mock.calls) expect(call[0]).toBeInstanceOf(AbortSignal);
  });

  it('在线执行器卡读取全局 summary 数值（不随项目 summary 漂移）', async () => {
    mockWiring();
    renderPage(`/dashboard?project=${PROJECT_UUID}`);
    await waitFor(() => expect(screen.getByTestId('failure-top-list')).toBeTruthy(), { timeout: 5000 });

    // 全局夹具 onlineExecutors/totalExecutors = 9 / 12；随项目夹具是 2 / 4。
    expect(screen.getByText(/9 \/ 12/)).toBeTruthy();
    expect(screen.queryByText(/2 \/ 4/)).toBeNull();
  });

  it('全局徽章 hover 说明口径：机队/调度全局统计，不随当前项目过滤', async () => {
    mockWiring();
    renderPage();
    await waitFor(() => expect(screen.getByTestId('failure-top-list')).toBeTruthy(), { timeout: 5000 });

    const globalBadges = screen.getAllByTestId('scope-badge-global');
    expect(globalBadges.length).toBeGreaterThan(0);
    // antd Tooltip 文案在 aria-label / 节点 title 之外以 span 懒挂载；断言徽章文字存在即可，
    // 口径说明文案由 i18n 键 projectCtx.globalScope.tooltip 提供（见组件 ScopeBadge）。
    expect(globalBadges[0].textContent).toContain('全局口径');
  });

  it('未选项目（全部项目）：summary 只发一路不带 projectId 的请求，徽章仍逐卡渲染', async () => {
    mockWiring();
    renderPage();
    await waitFor(() => expect(screen.getByTestId('failure-top-list')).toBeTruthy(), { timeout: 5000 });

    expect(mockedMetrics.getSummary.mock.calls.length).toBe(1);
    expect(mockedMetrics.getSummary.mock.calls[0]?.[0]?.projectId).toBeFalsy();
    expect(mockedMetrics.getDailyTrend.mock.calls[0]?.[1]?.projectId).toBeFalsy();
    expect(mockedMetrics.getRecentFailures.mock.calls[0]?.[0]?.projectId).toBeFalsy();
    expect(screen.getAllByTestId('scope-badge-project').length).toBeGreaterThan(0);
    expect(screen.getAllByTestId('scope-badge-global').length).toBeGreaterThan(0);
  });
});
