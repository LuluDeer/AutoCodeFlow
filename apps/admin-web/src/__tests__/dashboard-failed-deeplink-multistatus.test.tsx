/**
 * R281-DEEPLINK-01（S2 前端深链）：Dashboard 两个「全部…」深链的**方向相反**，两条都要钉住。
 *
 * ## ① 失败 Top ·「全部失败」→ **必须**多值 `status=failed,timeout`
 *
 * 「失败」口径已在 R280 统一成后端的
 * `FAILED_EXECUTION_STATUSES = FAILED ∪ TIMEOUT`
 * （`apps/admin-api/src/modules/task/entities/task-execution.entity.ts:61`），
 * 而 `/executions` 的 status 过滤是**等值**（多值由 S1 切片改成 `IN (...)`，单值不变）。
 * 超时风暴（10 条 timeout、0 条 failed）下：卡片**有内容**（口径已含 timeout），
 * 点进去 `/executions?status=failed` 却是 **0 条**——用户刚看到 10 条失败却被告知
 * 没有匹配，最挫败的形态。
 *
 * ## ② 最近失败 ·「全部记录」→ **必须保持**不带 status（本 spec 反向钉住）
 *
 * 「全部记录」承诺的是**全部**执行记录，它本来就能看到那 10 条 timeout，
 * 不存在「漏筛选」缺陷。若为了「与左卡保持一致」改成 `failed,timeout`，
 * 按钮就变成「只能看失败」，「全部」二字成了**新的、更坏的谎报**
 * （把一个问题换成另一个问题）。故 ② 的断言是 **href 恰好等于 `/executions`**
 * ——任何人把它改成带 status 都会红。
 *
 * ## 本 spec 的断言纪律
 *
 * 全部用**真断言**（`getAttribute('href')` 的**字面**全等 / 真实导航后的落点
 * pathname+search），不用 `toHaveBeenCalled()` 这种「只要点了就算覆盖」的弱形态
 * （本仓未装 jest-dom，故不用 `toHaveAttribute`，字面 getAttribute 断言强度相同）：
 * 把 `'failed,timeout'` 改回 `'failed'`（或删掉 status）必须红。
 *
 * ## 为什么不断言「下拉显示」
 *
 * 执行页的状态下拉只认 `failed` / `timeout` 两个**单值**（主动筛选意图，见
 * `ExecutionsPage.tsx:903-904`），多值 URL 匹配不到任何选项，下拉显示空/未选中。
 * 实测（R281，jsdom 真实渲染）结论：antd Select 把未匹配的 `value` 原样显示在
 * `.ant-select-content` 的 `title` 上（`title="failed,timeout"`），**不报错、不崩、
 * 不影响列表请求**（请求原样带 `status: 'failed,timeout'` 交给后端）。
 * 这是**可接受**的：深链是「从汇总进来」的快捷路径，用户可在下拉里重新选单值——
 * 该结论已写入两处调用点注释，不在此处锁 DOM 细节（antd 内部结构易变）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cloneElement } from 'react';
import DashboardPage from '../pages/DashboardPage';
import { metricsApi } from '../api/metrics';
import { tasksApi } from '../api/tasks';
import { useAuthStore } from '../store/auth';
import '../i18n';
import { setLanguage } from '../i18n';

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

// recharts ResponsiveContainer 依赖布局测量（既有先例 mock，对齐 dashboard-ui04）
vi.mock('recharts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('recharts')>();
  return {
    ...actual,
    ResponsiveContainer: ({ children }: { children: React.ReactElement<Record<string, unknown>> }) =>
      cloneElement(children, { width: 200, height: 36 }),
  };
});

// jsdom 缺失 antd / recharts 依赖的浏览器 API（既有先例 shim）
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

// DashboardPage 现挂 useMetricsStream（SSE）——jsdom 无 EventSource，用 noop 桩
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

// 超时风暴现场：卡片里的行**全是 timeout**（FAILED ∪ TIMEOUT 的另一半）。
// 若深链回退成单值 'failed'，用户在这张卡里看到的这些行点进去一条都找不到。
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

/** 目标页桩：把落点 pathname+search 渲染出来，用于断言深链真实落点。 */
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
  mockedMetrics.getSummary.mockResolvedValue(summaryFixture);
  mockedMetrics.getDailyTrend.mockResolvedValue(trendFixture);
  mockedMetrics.getExecutorStats.mockResolvedValue(executorsFixture);
  mockedMetrics.getRecentFailures.mockResolvedValue(failuresFixture);
  mockedMetrics.getSchedulerMetrics.mockResolvedValue(schedulerMetricsFixture);
  mockedTasks.schedulerStats.mockResolvedValue(schedulerStatsFixture);
}

/** 按可见文案取深链 anchor（`closest('a')`：antd Typography 可能包一层 span）。 */
function linkByText(text: string): HTMLAnchorElement {
  const anchors = screen
    .getAllByText(text)
    .map((n) => n.closest('a'))
    .filter((a): a is HTMLAnchorElement => !!a);
  expect(anchors.length, `未找到文案为「${text}」的深链`).toBeGreaterThan(0);
  return anchors[0];
}

/** URLSearchParams 对逗号编码成 %2C——两卡都用 executionsHref 生成，形态一致。 */
const MULTI = 'status=failed%2Ctimeout';

describe('R281-DEEPLINK-01 · Dashboard 失败深链带多值 status', () => {
  beforeEach(async () => {
    cleanup();
    vi.clearAllMocks();
    vi.stubGlobal('EventSource', NoopEventSource);
    useAuthStore.setState({ user: { id: 1, username: 'root', role: 'admin' } });
    await setLanguage('zh');
  });
  afterEach(() => cleanup());

  it('① 失败 Top 的「全部失败」href 含 status=failed,timeout（不是单值 failed）', async () => {
    mockDashboard();
    renderDashboard();

    await waitFor(() => expect(screen.getByTestId('failure-top-list')).toBeTruthy(), { timeout: 5000 });

    const link = linkByText('全部失败');
    // 核心断言：**字面** href 全等。改回单值 'failed' 或删掉 status 都必然红。
    expect(link.getAttribute('href')).toBe(`/executions?${MULTI}`);
    // 反向护栏：不得回退成「只取 failed」，也不得落全量
    expect(link.getAttribute('href')).not.toMatch(/[?&]status=failed(&|$)/);
    expect(link.getAttribute('href')).not.toBe('/executions');
  });

  it('② 「最近失败 → 全部记录」**刻意**不带 status（href 恰为 /executions，钉住反向契约）', async () => {
    mockDashboard();
    renderDashboard();

    await waitFor(() => expect(screen.getByText('全部记录')).toBeTruthy(), { timeout: 5000 });

    const link = linkByText('全部记录');
    // 「全部记录」承诺的是**全部**——带 status 会把「全部」偷换成「全部失败」。
    // 这条断言的方向与用例 ① 相反：改为 'failed,timeout' 必须红。
    expect(link.getAttribute('href')).toBe('/executions');
    expect(link.getAttribute('href')).not.toContain('status=');
  });

  it('③ 点击「全部失败」真导航到执行页，落点 query 含 status=failed,timeout', async () => {
    mockDashboard();
    renderDashboard();

    await waitFor(() => expect(screen.getByTestId('failure-top-list')).toBeTruthy(), { timeout: 5000 });
    fireEvent.click(linkByText('全部失败'));

    // 真路由导航断言（而非只看 href）：落点 URL 必须是多值
    const probe = await screen.findByTestId('executions-probe');
    expect(probe.textContent).toBe(`/executions?${MULTI}`);
  });

  it('④ 点击「全部记录」真导航到裸 /executions（无 query，全量口径）', async () => {
    mockDashboard();
    renderDashboard();

    await waitFor(() => expect(screen.getByText('全部记录')).toBeTruthy(), { timeout: 5000 });
    fireEvent.click(linkByText('全部记录'));

    // 真路由落点：不带任何 status（「全部记录」= 全部，不是「全部失败」）
    const probe = await screen.findByTestId('executions-probe');
    expect(probe.textContent).toBe('/executions');
  });

  it('⑤ project 上下文仍并存：失败 Top 带 status+project，全部记录只带 project', async () => {
    // project 上下文走 URL ?project=<UUID>（useProjectFilter 只认 UUID / 'default'，
    // 非 UUID 脏值回落 'all' 即不传——故夹具必须是 UUID 形状，见 useProjectFilter.normalize）
    const UUID = '11111111-2222-3333-4444-555555555555';
    mockDashboard();
    renderDashboard(`/dashboard?project=${UUID}`);

    await waitFor(() => expect(screen.getByTestId('failure-top-list')).toBeTruthy(), { timeout: 5000 });
    await waitFor(() => expect(screen.getByText('全部记录')).toBeTruthy(), { timeout: 5000 });

    // 失败 Top：多值 status 与 project 并存，顺序由 executionsHref 决定（status 先）
    expect(linkByText('全部失败').getAttribute('href')).toBe(`/executions?${MULTI}&project=${UUID}`);
    // 全部记录：仍然**只有** project，没有 status（不因左卡改动而「被统一」）
    expect(linkByText('全部记录').getAttribute('href')).toBe(`/executions?project=${UUID}`);
  });
});