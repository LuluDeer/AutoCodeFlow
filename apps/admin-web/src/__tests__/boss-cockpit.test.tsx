/**
 * 老板驾驶舱一屏（boss-cockpit）验收 —— 第 2 级：组件级（RTL + API 层 mock）。
 *
 * 覆盖契约（实现 agent `impl-boss-cockpit` 承诺的 data-testid）：
 *   · boss-cockpit                 首屏区块（DashboardPage.tsx）
 *   · boss-approval-card           审批卡
 *     - boss-approval-count        读到 N
 *     - boss-approval-unknown      null/degraded ⇒「未知（读取失败）」，绝不显示 0
 *     - boss-approval-empty        读到 0
 *     - boss-approval-link         跳 /inbox
 *   · boss-cost-card               成本卡
 *     - boss-cost-amount           仅 priceReason=OK 且 currencyValue 非 null
 *     - boss-cost-unavailable      否则标缺，绝不 0 / ¥0.00
 *   · 北极星卡从页面底部移入 boss-cockpit，且全页仅一处实例。
 *
 * 边界声明：本套件 mock 的是 API 层（agentApi / metricsApi / getActivationStats），
 * 只证明「组件在该数据形状下的分支行为」，不证明后端真跑、不证明传输层已接通。
 * 真浏览器级证据见 e2e/boss-cockpit.spec.ts（同样是传输层 mock）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  render, screen, waitFor, cleanup, fireEvent,
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

// ── API 层 mock（对齐 dashboard-ui04 / north-star-card 先例）─────────────────
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

// recharts 依赖布局测量（既有先例：注入显式宽高，其余导出用真实现）
vi.mock('recharts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('recharts')>();
  return {
    ...actual,
    ResponsiveContainer: ({ children }: { children: React.ReactElement<Record<string, unknown>> }) =>
      cloneElement(children, { width: 200, height: 36 }),
  };
});

// jsdom 缺失的 antd / recharts 浏览器 API shim
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

// SSE：jsdom 无 EventSource（对齐 dashboard-ui04 noop 桩）
class NoopEventSource {
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) {}
  addEventListener() {}
  close() {}
}
g.EventSource = NoopEventSource;

// ── fixtures ─────────────────────────────────────────────────────────────────
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
  { id: 'f1', taskId: 'task-a', taskName: '任务A', errorMessage: 'boom', failureReason: 'script_error', exitCode: 1, createdAt: '2026-09-07T10:00:00Z', duration: 1000 },
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

const northStarReport: NorthStarReport = {
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
    eligible: true,
    reasons: ['运营前置（脚本不验证）：telemetry/status 的 coverage 须为 full 且 count>0'],
    reasonDetails: [{ code: 'OPS_PREREQ_COVERAGE', text: '运营前置（脚本不验证）：telemetry/status 的 coverage 须为 full 且 count>0' }],
    weeks: 1, activeInstallWeeks: 7,
    thresholds: { minWeeks: 4, minActiveInstallWeeks: 20 },
  },
  ttfv: {
    dataStatus: 'gate_off',
    medianMinutes: null,
    activation24h: null,
    sampleSize: 0,
    asOf: '2026-11-20T10:30:00.000Z',
    note: '遥测未启用，暂无 TTFV 样本',
  },
  warnings: ['⚠️ 有产物/有证据 ≠ 被业务确认，代理值勿当严格值'],
};

/** inboxCounts 默认 fixture：读到 3 单、未降级。 */
const countsFixture = (pendingApprovals: number | null, degraded = false) => ({
  pendingApprovals,
  waitingSessions: 2,
  stalled: 0,
  backlogged: 0,
  backlogTruncated: false,
  deployments: 0,
  queueStall: 0,
  failedSessions: 1,
  failedWindowHours: 24,
  degraded,
});

/** getActivationStats 默认 fixture：dualBasis 由用例覆写 priceReason/currencyValue。 */
const statsFixture = (dualBasis: Partial<activationApi.ActivationStatsDualBasis>) => ({
  total: 12,
  byCapability: [{ capabilityKey: 'browser', count: 12, success: 11, failure: 1, blocked: 0 }],
  byProject: [{ projectId: 'proj-a', count: 12 }],
  dualBasis: {
    basis: 'per-activation',
    invocations: 12,
    successfulDeliveries: 11,
    skipped: 0,
    note: '无 token 样本，金额不可折算。', // 中性 fixture：避免把说明文案里的「不是 0 元」误判成金额位显示 0
    tokenSample: null,
    currencyValue: null,
    priceReason: 'NO_TOKEN_SAMPLE' as const,
    allocationNote: '无 token 样本，不折算金额。',
    byCapability: [],
    byProject: [],
    ...dualBasis,
  },
});

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

/** 把三路 boss 数据源一次性设置为「健康默认」，各用例只覆写自己关心的那一路。 */
function mockAll() {
  mockedMetrics.getSummary.mockResolvedValue(summaryFixture);
  mockedMetrics.getDailyTrend.mockResolvedValue(trendFixture);
  mockedMetrics.getExecutorStats.mockResolvedValue(executorsFixture);
  mockedMetrics.getRecentFailures.mockResolvedValue(failuresFixture);
  mockedMetrics.getSchedulerMetrics.mockResolvedValue(schedulerMetricsFixture);
  mockedMetrics.getNorthStar.mockResolvedValue(northStarReport);
  mockedTasks.schedulerStats.mockResolvedValue(schedulerStatsFixture);
  mockedAgent.inboxCounts.mockResolvedValue(countsFixture(3) as never);
  mockedAgent.listPendingApprovals.mockResolvedValue({
    items: [], total: 3, sessionTotal: 2, truncated: false, degraded: false,
  } as never);
  mockedGetActivationStats.mockResolvedValue(statsFixture({}) as never);
}

/** 取卡片内纯文本（用于「绝不出现 0 / ¥0.00」的诚实边界断言）。 */
const textOf = (testId: string) => screen.getByTestId(testId).textContent ?? '';

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
  localStorage.setItem(STORAGE_KEY, 'zh');
  void setLanguage('zh');
  // 角色化首屏后三卡仅 admin 可见：原 6+ 例围绕驾驶舱四卡语义，显式注入
  // admin user 保持原覆盖原意（不是放宽断言）。
  useAuthStore.setState({ user: { id: 1, username: 'boss', role: 'admin' } as never });
  mockAll();
});

afterEach(() => {
  cleanup();
  useAuthStore.setState({ user: null });
});

describe('boss-cockpit — 老板驾驶舱一屏（第 2 级组件级）', () => {
  it('1. 首屏区块 boss-cockpit 存在，审批卡与成本卡挂载', async () => {
    renderDashboard();
    expect(await screen.findByTestId('boss-cockpit')).toBeTruthy();
    expect(screen.getByTestId('boss-approval-card')).toBeTruthy();
    expect(screen.getByTestId('boss-cost-card')).toBeTruthy();
  });

  it('2. inboxCounts=null+degraded ⇒ unknown 可见、count 不存在、审批卡内不出现 0', async () => {
    mockedAgent.inboxCounts.mockResolvedValue(countsFixture(null, true) as never);
    mockedAgent.listPendingApprovals.mockResolvedValue({
      items: [], total: null, sessionTotal: null, truncated: false, degraded: true,
    } as never);
    renderDashboard();
    const card = await screen.findByTestId('boss-approval-card');
    expect(await waitFor(() => {
      const unknown = screen.getByTestId('boss-approval-unknown');
      expect(unknown.textContent).toContain('未知');
      return true;
    })).toBe(true);
    expect(screen.queryByTestId('boss-approval-count')).toBeNull();
    // 防「读不到=0」假事实：审批卡内既不出现独立 0，也不出现「未知 0」混排。
    expect(textOf('boss-approval-card')).not.toContain('0');
    expect(card).toBeTruthy();
  });

  it('3. pendingApprovals=0 ⇒ empty 可见、不显示未知、不显示 count', async () => {
    mockedAgent.inboxCounts.mockResolvedValue(countsFixture(0, false) as never);
    mockedAgent.listPendingApprovals.mockResolvedValue({
      items: [], total: 0, sessionTotal: 0, truncated: false, degraded: false,
    } as never);
    renderDashboard();
    expect(await screen.findByTestId('boss-approval-empty')).toBeTruthy();
    expect(screen.queryByTestId('boss-approval-unknown')).toBeNull();
    expect(screen.queryByTestId('boss-approval-count')).toBeNull();
  });

  it('4. pendingApprovals=3 ⇒ count 含 3、link 点击跳 /inbox', async () => {
    renderDashboard(); // 默认 countsFixture(3)
    const count = await screen.findByTestId('boss-approval-count');
    expect(count.textContent).toContain('3');
    const link = screen.getByTestId('boss-approval-link');
    // 实现走 useNavigate 编程式跳转（Button onClick），非 <a href>；断言真实落点。
    fireEvent.click(link);
    expect(await screen.findByTestId('inbox-probe')).toBeTruthy();
    expect(screen.queryByTestId('boss-approval-unknown')).toBeNull();
    expect(screen.queryByTestId('boss-approval-empty')).toBeNull();
  });

  it('5. 成本 NO_TOKEN_SAMPLE+null ⇒ unavailable 可见、成本卡不出现 ¥0.00 / 0 元', async () => {
    mockedGetActivationStats.mockResolvedValue(statsFixture({
      priceReason: 'NO_TOKEN_SAMPLE', currencyValue: null,
    }) as never);
    renderDashboard();
    expect(await screen.findByTestId('boss-cost-unavailable')).toBeTruthy();
    expect(screen.queryByTestId('boss-cost-amount')).toBeNull();
    const text = textOf('boss-cost-card');
    expect(text).not.toContain('¥0.00');
    expect(text).not.toContain('0 元');
    expect(text).not.toContain('0元');
  });

  it('6. 成本 OK + currencyValue=123.45 ⇒ amount 显示金额', async () => {
    mockedGetActivationStats.mockResolvedValue(statsFixture({
      priceReason: 'OK', currencyValue: 123.45,
    }) as never);
    renderDashboard();
    const amount = await screen.findByTestId('boss-cost-amount');
    expect(amount.textContent).toContain('123.45');
    expect(screen.queryByTestId('boss-cost-unavailable')).toBeNull();
  });

  it('7. 成本 API 读失败 ⇒ 仍走标缺，成本卡不显示 0', async () => {
    mockedGetActivationStats.mockRejectedValueOnce(new Error('boom: stats unavailable'));
    renderDashboard();
    expect(await screen.findByTestId('boss-cost-unavailable')).toBeTruthy();
    expect(screen.queryByTestId('boss-cost-amount')).toBeNull();
    const text = textOf('boss-cost-card');
    expect(text).not.toContain('¥0.00');
    expect(text).not.toContain('0 元');
    expect(text).not.toContain('0元');
  });

  it('8. 北极星卡位于 boss-cockpit 内，且全页仅一处实例（防双实例）', async () => {
    renderDashboard();
    const cockpit = await screen.findByTestId('boss-cockpit');
    // north-star-strict 是北极星卡的既有唯一锚点；全页恰好 1 个且在 cockpit 内。
    await waitFor(() => {
      expect(document.querySelectorAll('[data-testid="north-star-strict"]')).toHaveLength(1);
    });
    expect(cockpit.querySelector('[data-testid="north-star-strict"]')).not.toBeNull();
  });

  it('9. 既有 KPI 卡仍渲染（驾驶舱改造不破坏老区块）', async () => {
    renderDashboard();
    expect(await screen.findByTestId('kpi-today-runs')).toBeTruthy();
    expect(screen.getByTestId('kpi-running')).toBeTruthy();
    expect(screen.getByTestId('kpi-success-rate')).toBeTruthy();
    expect(screen.getByTestId('scope-group-project')).toBeTruthy();
    expect(screen.getByTestId('scope-group-global')).toBeTruthy();
  });
});
