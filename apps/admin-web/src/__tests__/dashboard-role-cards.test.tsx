/**
 * Dashboard 按角色渲染首屏 —— 第 2 级：组件级（RTL + API 层 mock）。
 *
 * 契约（task-13 切片 C1 驾驶舱瘦身）：ApprovalQueueCard 对所有角色渲染；
 * NorthStarCard 仅 role=admin 渲染；驾驶舱不再渲染 CostPostureCard /
 * TtfvCard（ttfv 组件已删除，cost 卡 testid 不应出现在 boss-cockpit 内）；
 * user 分支不触发 north-star 请求；
 * role 首帧未就绪（user=undefined）按非 admin 处理，不闪 403；
 * 后端权限面（ADR-044/045）保留 403，本套件只证明前端隐藏分支。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  render, screen, waitFor, cleanup,
} from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cloneElement } from 'react';
import DashboardPage from '../pages/DashboardPage';
import { metricsApi, type NorthStarReport } from '../api/metrics';
import { tasksApi } from '../api/tasks';
import { agentApi } from '../api/agent';
import * as activationApi from '../api/capability-activation';
import { useAuthStore } from '../store/auth';
import { setLanguage, STORAGE_KEY } from '../i18n';

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
      getNorthStar: vi.fn(),
    },
  };
});
const mockedMetrics = vi.mocked(metricsApi, true);

vi.mock('../api/tasks', () => ({
  tasksApi: { schedulerStats: vi.fn() },
}));
const mockedTasks = vi.mocked(tasksApi, true);

vi.mock('../api/agent', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/agent')>();
  return {
    ...actual,
    agentApi: {
      ...actual.agentApi,
      inboxCounts: vi.fn(),
      listPendingApprovals: vi.fn(),
    },
  };
});
const mockedAgent = vi.mocked(agentApi, true);

vi.mock('../api/capability-activation', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/capability-activation')>();
  return {
    ...actual,
    getActivationStats: vi.fn(),
  };
});
const mockedGetActivationStats = vi.mocked(activationApi.getActivationStats, true);

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
g.EventSource = NoopEventSource;

const daysAgo = (n: number) => {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

const summaryFixture = {
  totalTasks: 3, todayRuns: 12, totalExecutors: 2, onlineExecutors: 2,
  executions: { total: 120, success: 110, failed: 10, running: 1 },
  successRate: 91.7, avgDurationMs: 3200,
};
const trendFixture = [
  { date: daysAgo(2), success: 5, failed: 1, timeout: 0 },
  { date: daysAgo(1), success: 8, failed: 0, timeout: 0 },
  { date: daysAgo(0), success: 3, failed: 2, timeout: 0 },
];
const executorsFixture = [{
  id: 'exec-1', appName: 'alpha', address: '10.0.0.1:3002', status: 'online',
  cpuUsage: 30, memUsage: 50, runningTaskCount: 1, lastHeartbeat: new Date().toISOString(),
}];
const failuresFixture = [
  { id: 'f1', taskId: 'task-a', taskName: '任务A', errorMessage: 'boom',
    failureReason: 'script_error', exitCode: 1, createdAt: '2026-09-07T10:00:00Z', duration: 1000 },
];
const schedulerMetricsFixture = {
  counters: {
    ticks: 100, tickDurationMsTotal: 500, lastTickDurationMs: 3,
    lastTickAt: new Date().toISOString(), triggersClaimed: 20,
    triggersSkippedLockHeld: 0, triggersSkippedDbClaim: 0, triggersSkippedInactive: 0,
    triggersSkippedBlockStrategy: 0, triggersSkippedMaintenance: 0, triggersFailed: 0,
    dependencyTriggersClaimed: 0, dependencyTriggersSkipped: 0,
    triggerLatencyCount: 15, triggerLatencySumMs: 1500,
    triggerLatencyBuckets: [10, 4, 1, 0, 0, 0, 0, 0], lastTriggerLatencyMs: 42,
    startedAt: new Date(Date.now() - 60_000).toISOString(),
  },
  derived: {
    avgTickDurationMs: 5, tickRatePerSec: 1.6, triggerClaimRatePerSec: 0.3,
    avgTriggerLatencyMs: 100, p99TriggerLatencyMs: 80,
  },
  queue: { waiting: 0, active: 1, delayed: 0, failed: 0, completed: 20 },
  scheduler: {
    healthy: true, isLeader: true, activeTimers: 2, activeCronTasks: 1,
    runningTaskCount: 1, totalScheduledTasks: 3, uptime: 60,
  },
  instance: { pid: 1234, hostname: 'test-host' },
};
const schedulerStatsFixture = {
  healthy: true, isLeader: true, activeTimers: 2, activeCronTasks: 1,
  runningTaskCount: 1, totalScheduledTasks: 3, uptime: 60,
};
const northStarFixture = {
  as_of: '2026-11-20T10:30:00.000Z',
  business_confirmed: {
    weeks: [{ week_start: '2026-11-16', active_installs: 7, confirmed_events: 42 }],
    totals: { active_install_weeks: 7, confirmed_events: 42 },
  },
  business_results_proxy: {
    weeks: [{ week_start: '2026-11-16', executions: 99 }],
    totals: { executions: 99 },
  },
  promotionEligibility: {
    eligible: true, reasons: [], reasonDetails: [], weeks: 1, activeInstallWeeks: 7,
    thresholds: { minWeeks: 4, minActiveInstallWeeks: 20 },
  },
  ttfv: {
    dataStatus: 'gate_off', medianMinutes: null, activation24h: null, sampleSize: 0,
    asOf: '2026-11-20T10:30:00.000Z', note: '遥测未启用，暂无 TTFV 样本',
  },
  warnings: [],
} as unknown as NorthStarReport;

const countsFixture = (pendingApprovals: number | null, degraded = false) => ({
  pendingApprovals, waitingSessions: 2, stalled: 0, backlogged: 0,
  backlogTruncated: false, deployments: 0, queueStall: 0,
  failedSessions: 1, failedWindowHours: 24, degraded,
});
const statsFixture = {
  total: 12,
  byCapability: [{ capabilityKey: 'browser', count: 12, success: 11, failure: 1, blocked: 0 }],
  byProject: [{ projectId: 'proj-a', count: 12 }],
  dualBasis: {
    basis: 'per-activation', invocations: 12, successfulDeliveries: 11, skipped: 0,
    note: '无 token 样本，金额不可折算。', tokenSample: null, currencyValue: null,
    priceReason: 'NO_TOKEN_SAMPLE', allocationNote: '无 token 样本，不折算金额。',
    byCapability: [], byProject: [],
  },
};

/** admin / user / 首帧未就绪（user=undefined）三种角色态。 */
function setRole(role: 'admin' | 'user' | 'unready') {
  const user = role === 'unready'
    ? (undefined as never)
    : ({ id: role === 'admin' ? 1 : 2, username: role, role } as never);
  useAuthStore.setState({ user });
}

function renderDashboard() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/dashboard']}>
        <Routes>
          <Route path="/dashboard" element={<DashboardPage />} />
          <Route path="/inbox" element={<div data-testid="inbox-probe">inbox</div>} />
          <Route path="/tasks/:id" element={<div>task-detail-mock</div>} />
          <Route path="/executors/:id" element={<div>executor-detail-mock</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function mockAll() {
  mockedMetrics.getSummary.mockResolvedValue(summaryFixture);
  mockedMetrics.getDailyTrend.mockResolvedValue(trendFixture);
  mockedMetrics.getExecutorStats.mockResolvedValue(executorsFixture);
  mockedMetrics.getRecentFailures.mockResolvedValue(failuresFixture);
  mockedMetrics.getSchedulerMetrics.mockResolvedValue(schedulerMetricsFixture);
  mockedMetrics.getNorthStar.mockResolvedValue(northStarFixture);
  mockedTasks.schedulerStats.mockResolvedValue(schedulerStatsFixture);
  mockedAgent.inboxCounts.mockResolvedValue(countsFixture(3) as never);
  mockedAgent.listPendingApprovals.mockResolvedValue({
    items: [], total: 3, sessionTotal: 2, truncated: false, degraded: false,
  } as never);
  mockedGetActivationStats.mockResolvedValue(statsFixture as never);
}

/** 除容器 testid 外再查内容锚点，防止「只换 testid 但卡还在」假绿。 */
function expectNoAdminCards() {
  expect(screen.queryByTestId('boss-cost-card')).toBeNull();
  expect(screen.queryByTestId('north-star-card')).toBeNull();
  expect(screen.queryByTestId('boss-ttfv-card')).toBeNull();
  expect(document.querySelector('[data-testid="north-star-strict"]')).toBeNull();
  expect(document.querySelector('[data-testid="boss-ttfv-card"]')).toBeNull();
  expect(document.querySelector('[data-testid="boss-cost-amount"]')).toBeNull();
  expect(document.querySelector('[data-testid="boss-cost-unavailable"]')).toBeNull();
}

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
  localStorage.setItem(STORAGE_KEY, 'zh');
  void setLanguage('zh');
  setRole('admin');
  mockAll();
});

afterEach(() => {
  cleanup();
  useAuthStore.setState({ user: null });
});

describe('Dashboard 按角色渲染首屏（第 2 级组件级）', () => {
  it('1. role=admin ⇒ 两卡渲染（审批 + 北极星），成本/TTFV 卡不再上驾驶舱', async () => {
    setRole('admin');
    renderDashboard();
    expect(await screen.findByTestId('boss-cockpit')).toBeTruthy();
    expect(screen.getByTestId('boss-approval-card')).toBeTruthy();
    expect(screen.getByTestId('north-star-card')).toBeTruthy();
    // 瘦身契约：cost / ttfv 卡在 admin 首屏也一律缺席（含内容锚防假绿）。
    expect(screen.queryByTestId('boss-cost-card')).toBeNull();
    expect(screen.queryByTestId('boss-cost-amount')).toBeNull();
    expect(screen.queryByTestId('boss-cost-unavailable')).toBeNull();
    expect(screen.queryByTestId('boss-ttfv-card')).toBeNull();
    const cockpit = screen.getByTestId('boss-cockpit');
    expect(cockpit.querySelectorAll('[data-testid="north-star-card"]')).toHaveLength(1);
  });

  it('2. role=user ⇒ 仅审批卡可见，北极星卡不存在', async () => {
    setRole('user');
    renderDashboard();
    expect(await screen.findByTestId('boss-approval-card')).toBeTruthy();
    await waitFor(() => expect(screen.getByTestId('boss-approval-count')).toBeTruthy());
    expectNoAdminCards();
  });

  it('3. role=user ⇒ stats/north-star 请求 0 发，审批请求正常发', async () => {
    setRole('user');
    renderDashboard();
    await screen.findByTestId('boss-approval-count');
    await waitFor(() => {
      expect(mockedAgent.inboxCounts).toHaveBeenCalled();
      expect(mockedAgent.listPendingApprovals).toHaveBeenCalled();
    });
    expect(mockedMetrics.getNorthStar).not.toHaveBeenCalled();
    expect(mockedGetActivationStats).not.toHaveBeenCalled();
    expectNoAdminCards();
  });

  it('4. user=undefined 首帧 ⇒ 不误渲染北极星卡、不闪 403，审批卡仍可见', async () => {
    setRole('unready');
    renderDashboard();
    const cockpit = screen.getByTestId('boss-cockpit');
    // 首帧同步断言：admin 卡一次都不出现，且驾驶舱内没有 403 文本。
    expect(cockpit.querySelector('[data-testid="boss-cost-card"]')).toBeNull();
    expect(cockpit.querySelector('[data-testid="north-star-card"]')).toBeNull();
    expect(cockpit.querySelector('[data-testid="boss-ttfv-card"]')).toBeNull();
    expect(cockpit.textContent ?? '').not.toContain('403');
    expect(screen.getByTestId('boss-approval-card')).toBeTruthy();
    await waitFor(() => expect(mockedAgent.inboxCounts).toHaveBeenCalled());
    expectNoAdminCards();
  });

  it('5. role=user 审批卡读到 N ⇒ count 可见、link 可跳 inbox，隐藏卡不破坏可用卡', async () => {
    setRole('user');
    renderDashboard();
    const count = await screen.findByTestId('boss-approval-count');
    expect(count.textContent).toContain('3');
    expect(screen.getByTestId('boss-approval-link')).toBeTruthy();
    expectNoAdminCards();
  });

  it('6. role=user 审批卡读到 0 ⇒ empty 可见，unknown/count 不出现', async () => {
    setRole('user');
    mockedAgent.inboxCounts.mockResolvedValue(countsFixture(0, false) as never);
    mockedAgent.listPendingApprovals.mockResolvedValue({
      items: [], total: 0, sessionTotal: 0, truncated: false, degraded: false,
    } as never);
    renderDashboard();
    expect(await screen.findByTestId('boss-approval-empty')).toBeTruthy();
    expect(screen.queryByTestId('boss-approval-unknown')).toBeNull();
    expect(screen.queryByTestId('boss-approval-count')).toBeNull();
    expectNoAdminCards();
  });

  it('7. role=user 审批卡 degraded ⇒ unknown 可见，绝不把读不到写成 0', async () => {
    setRole('user');
    mockedAgent.inboxCounts.mockResolvedValue(countsFixture(null, true) as never);
    mockedAgent.listPendingApprovals.mockResolvedValue({
      items: [], total: null, sessionTotal: null, truncated: false, degraded: true,
    } as never);
    renderDashboard();
    const unknown = await screen.findByTestId('boss-approval-unknown');
    expect(unknown.textContent).toContain('未知');
    expect(screen.queryByTestId('boss-approval-empty')).toBeNull();
    expect(screen.queryByTestId('boss-approval-count')).toBeNull();
    expect(screen.getByTestId('boss-approval-card').textContent ?? '').not.toContain('0');
    expectNoAdminCards();
  });
});
