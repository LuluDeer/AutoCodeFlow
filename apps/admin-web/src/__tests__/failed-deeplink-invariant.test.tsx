/**
 * R281-INVARIANT：「卡片里看到的失败行数 == 点进去看到的行数」——全仓缺失的那条不变式。
 *
 * ## 为什么需要这个文件（既有测试为什么挡不住这条缺陷）
 *
 * 「失败」口径是 `FAILED ∪ TIMEOUT`（`FAILED_EXECUTION_STATUSES`，唯一事实源见
 * `apps/admin-api/src/modules/task/entities/task-execution.entity.ts`），而
 * `/executions?status=` 在**后端单值语义被刻意保留**的前提下，是「逗号多值 → IN」。
 * 于是超时风暴（N 条 timeout、0 条 failed）时，Dashboard 的失败 Top 卡与通知铃铛
 * 里的行**有内容**，点进去 `/executions?status=failed` 却是 **0 行**——用户刚看到
 * N 条失败，紧接着被告知「没有匹配的执行记录」。
 *
 * 现有的两类深链测试都挡不住它：
 *   · `dashboard-failed-deeplink-multistatus.test.tsx` / `notification-bell-…` 只断言
 *     **href 字面**与**路由落点**（「URL 对不对」）；
 *   · `executions-deeplink.test.tsx` 的列表 fixture **恒为空**（`pageFixture([])`），
 *     它证明「请求发出去了」，**不证明「用户看到了东西」**。
 * 两者之间那条缝，正是缺陷能长期潜伏的地方：修完之后没有任何东西阻止它回来。
 *
 * ## 本文件断言的是「关系」，不是「调用了什么」
 *
 * ① 卡片侧行数（`failure-top-row` 的个数）与小节标题所述的**同一批**记录，
 *    在点击深链后必须变成**同样多**的可见表格行（`.ant-table-row`），且**不得**
 *    出现空态文案「没有匹配的执行记录」。
 * ② 反证：**旧**深链 `?status=failed` 在 3 条 timeout / 0 条 failed 的现场确实拿不到
 *    任何行（后端单值等值语义刻意保留，不是缺陷），故前端**必须**显式带 timeout。
 * ③ `%2C` 形态：`URLSearchParams` 把逗号编码成 `%2C`，后端收到的是解码后的
 *    `failed,timeout`——断言链路里没有任何一处手工 split / 双重编码把它弄坏。
 * ④ 「最近失败 → 全部记录」**刻意**不带 status（带 status 会把「全部」偷换成
 *    「全部失败」，是另一个更坏的谎报）。
 *
 * ## 后端语义在这里是怎么建模的
 *
 * 本文件是**前端组件测试**：`allExecutions` 被 mock，故不可能真连后端。
 * `backendStatusSemantics()` 把侦察确认的后端口径（**单值 = 等值；逗号多值 = IN**）
 * 写成夹具过滤器，让「卡片数 == 列表条数」这条不变式在两个方向上都可判定：
 * 深链带多值 → IN 命中 3 行；深链退回单值 → 等值命中 0 行（今日缺陷的原始症状）。
 * 它是**夹具**，不是对后端的验证——后端行为由 admin-api 侧 spec 与真机实测钉住。
 *
 * 断言纪律（对齐本仓既有约定）：不用 `toHaveBeenCalled()` 当覆盖（本仓未装
 * jest-dom，故用字面 `getAttribute('href')` 与 DOM 计数）；每一条都要求
 * 「改了就会红」。反证记录见 R281 回执：把 `MULTI_STATUS` 改回 `'failed'`
 * ⇒ ①②③ 红；改回 ⇒ 全绿。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cloneElement } from 'react';
import DashboardPage from '../pages/DashboardPage';
import ExecutionsPage from '../pages/ExecutionsPage';
import { metricsApi } from '../api/metrics';
import { tasksApi } from '../api/tasks';
import type { TaskExecution } from '../api/tasks';
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

// 两个页面共用同一份 tasks 门面：Dashboard 只看 schedulerStats，
// ExecutionsPage 看 allExecutions / killExecution（exportExecutions 只在点击导出时
// 触达，本文件不点，故不桩）。
vi.mock('../api/tasks', () => ({
  tasksApi: {
    allExecutions: vi.fn(),
    killExecution: vi.fn(),
    schedulerStats: vi.fn(),
  },
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
Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, value: 800 });
Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, value: 400 });

// Dashboard 现挂 useMetricsStream（SSE）——jsdom 无 EventSource，
// createSseClient 内部检测后降级为 no-op；这里给一个 noop 桩以免将来
// jsdom/依赖补上 EventSource 后本文件去真连 127.0.0.1（对齐 dashboard-ui04 先例）。
class NoopEventSource {
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) {}
  addEventListener() {}
  close() {}
}

// ── 常量：深链口径 ────────────────────────────────────────────────────
/** 失败口径的字面形态（`FAILED ∪ TIMEOUT`）；改回 `'failed'` 即回归今日缺陷。 */
const MULTI_STATUS = 'failed,timeout';
/** `URLSearchParams` 对逗号的实际编码形态（真机实测 Express 会解码）。 */
const MULTI_STATUS_ENCODED = 'failed%2Ctimeout';
/** 旧（缺陷）形态：后端等值语义下拿不到 timeout 行。 */
const OLD_SINGLE_STATUS = 'failed';

// ── 夹具：超时风暴现场（3 条 timeout、0 条 failed）──────────────────────
const timeoutRow = (i: number): TaskExecution => ({
  id: `exec-timeout-${i}`,
  taskId: `task-timeout-${i}`,
  taskName: `timeout-nightly-${i}`,
  status: 'timeout',
  triggerType: 'cron',
  executorAddress: '10.0.0.9:3002',
  startTime: '2026-09-07T10:00:00Z',
  endTime: '2026-09-07T10:05:00Z',
  duration: 300_000,
  createdAt: '2026-09-07T10:00:00Z',
  errorMessage: `exec exceeded budget (${i})`,
  failureReason: 'timeout',
});

/**
 * 种在「数据库」里的行：**全是 timeout**。「失败」口径已含 timeout，
 * 所以 Dashboard 卡片能看见它们；单值 `?status=failed` 看不见——这就是缺陷现场。
 * 三个不同 taskId ⇒ 卡片出现 3 行、每行「1 次」，与列表 3 行同数（可逐行对账）。
 */
const SEED_ROWS: TaskExecution[] = [1, 2, 3].map(timeoutRow);

/**
 * 后端 status 语义的**夹具模型**（不是对后端的验证，见文件头注）：
 *   · 未传 ⇒ 不过滤；
 *   · 单值 `'failed'` ⇒ 等值 ⇒ 3 条 timeout 一条都不匹配 ⇒ 0 行；
 *   · 逗号多值 `'failed,timeout'` ⇒ IN ⇒ 3 行。
 */
const backendStatusSemantics = (
  rows: TaskExecution[],
  status: string | undefined,
): TaskExecution[] => {
  if (!status) return rows;
  const wanted = status
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return rows.filter((r) => wanted.includes(r.status));
};

const summaryFixture = {
  totalTasks: 3,
  todayRuns: 12,
  totalExecutors: 2,
  onlineExecutors: 2,
  executions: { total: 120, success: 110, failed: 3, running: 1 },
  successRate: 91.7,
  avgDurationMs: 3200,
};

const daysAgo = (n: number) => {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

const trendFixture = [
  { date: daysAgo(1), success: 8, failed: 0, timeout: 2 },
  { date: daysAgo(0), success: 3, failed: 0, timeout: 1 },
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

// /metrics/failures：口径已是 FAILED ∪ TIMEOUT，故这次拉回来的全是 timeout。
const failuresFixture = SEED_ROWS.map((r) => ({
  id: r.id,
  taskId: r.taskId,
  taskName: r.taskName,
  errorMessage: r.errorMessage ?? '',
  failureReason: 'timeout',
  exitCode: null,
  createdAt: '2026-09-07T10:05:00Z',
  duration: 300_000,
}));

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

/**
 * Dashboard + ExecutionsPage 同挂一棵真路由：点击深链是**真导航**
 * （而不是只读 href），落点即「用户点进去」的现场。
 */
function renderApp(initialEntry = '/dashboard') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <Routes>
          <Route path="/dashboard" element={<DashboardPage />} />
          <Route path="/executions" element={<ExecutionsPage />} />
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

/** 列表侧：真实渲染出来的表格行数（用户眼睛看到的行）。 */
const listRowCount = (): number => document.querySelectorAll('.ant-table-row').length;

/** 列表请求实际收到的 status 集合（按调用顺序；未传记为 undefined）。 */
const statusesSeen = (): (string | undefined)[] =>
  mockedTasks.allExecutions.mock.calls.map((c) => c[0]?.status);

/** 解析深链 href 的 query（href 是 `/executions?...` 相对形态）。 */
const hrefQuery = (href: string): URLSearchParams =>
  new URLSearchParams(href.split('?')[1] ?? '');

/** 按可见文案取深链 anchor（antd Typography 可能包一层 span）。 */
function linkByText(text: string): HTMLAnchorElement {
  const anchors = screen
    .getAllByText(text)
    .map((n) => n.closest('a'))
    .filter((a): a is HTMLAnchorElement => !!a);
  expect(anchors.length, `未找到文案为「${text}」的深链`).toBeGreaterThan(0);
  return anchors[0];
}

describe('R281-INVARIANT · 「卡片数 == 点进去条数」（失败 = FAILED ∪ TIMEOUT）', () => {
  beforeEach(async () => {
    cleanup();
    vi.clearAllMocks();
    vi.stubGlobal('EventSource', NoopEventSource);
    useAuthStore.setState({ user: { id: 1, username: 'root', role: 'admin' } });
    await setLanguage('zh');
    // 后端语义夹具：按 status 过滤种下的 timeout 行（单值等值 / 多值 IN）。
    mockedTasks.allExecutions.mockImplementation(async (params) => {
      const rows = backendStatusSemantics(SEED_ROWS, params?.status);
      return { items: rows, total: rows.length, page: 1, pageSize: 20 };
    });
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  /**
   * ① 核心不变式（正向）。断言的是**数量关系**：卡片里的 3 行失败，点进去必须
   * 变成 3 个可见表格行，而不是 0 行。
   * 修复前：href 是 `?status=failed` ⇒ 后端等值 ⇒ 0 行 ⇒ 本用例红（这就是它的价值）。
   */
  it('① 卡片 3 条 timeout →「全部失败」→ 列表真渲染出 3 行（不是 0 行）', async () => {
    mockDashboard();
    renderApp('/dashboard');

    await waitFor(() => expect(screen.getByTestId('failure-top-list')).toBeTruthy(), { timeout: 5000 });

    // 卡片侧：用户此刻在「失败 Top」里看到的失败记录行（3 个不同任务，各 1 次）
    const cardRows = screen.getAllByTestId('failure-top-row').length;
    expect(cardRows).toBe(3);
    expect(screen.getAllByTestId('failure-top-count').map((n) => n.textContent)).toEqual([
      '1 次',
      '1 次',
      '1 次',
    ]);

    const link = linkByText('全部失败');
    const href = link.getAttribute('href') ?? '';
    // 深链必须**显式**带 timeout：后端单值等值语义刻意保留，缺了它等于切换到
    // 另一个结果集（后端不会替前端补 timeout）。
    expect(hrefQuery(href).get('status')).toBe(MULTI_STATUS);
    // URLSearchParams 的实际编码形态（前端侧就是 %2C，后端解码后是逗号）。
    expect(href).toContain(`status=${MULTI_STATUS_ENCODED}`);

    // 真导航：点进去即 ExecutionsPage 挂载
    fireEvent.click(link);

    // 请求侧：每一次列表请求都必须带多值，任何一次退回单值都会让上面那条不变式失效
    await waitFor(() => expect(statusesSeen().length).toBeGreaterThan(0));
    expect(statusesSeen().every((s) => s === MULTI_STATUS)).toBe(true);

    // 渲染侧（本用例的新东西）：用户看到的行数 == 卡片里的行数，且非空
    await waitFor(() => expect(listRowCount()).toBe(cardRows));
    expect(listRowCount()).toBe(3);
    for (const name of ['timeout-nightly-1', 'timeout-nightly-2', 'timeout-nightly-3']) {
      expect(await screen.findByText(name)).toBeTruthy();
    }
    // 反向：绝不能把「3 条超时」谎报成「没有匹配的执行记录」
    expect(screen.queryByText('没有匹配的执行记录')).toBeNull();
  });

  /**
   * ② 今日缺陷的反证（双向钉死）。
   *
   * (a) 旧深链 `?status=failed` 在 3 条 timeout / 0 条 failed 的现场**确实**拿不到
   *     timeout：这不是缺陷修复对象，而是后端**刻意保留**的单值等值语义。断言
   *     「不包含 timeout」+「0 行 + 空态文案」，把这个语义事实写死。
   * (b) 正因为 (a) 成立，前端**必须**显式带 timeout——所以 Dashboard 现今不得再
   *     产出旧形态。若将来有人把前端改回单值 `failed`，本条 (b) 会红。
   *
   * 一句话：**深链必须显式带 timeout，因为后端单值语义刻意保留。**
   */
  it('② 反证：旧深链 ?status=failed 拿不到 timeout，且 Dashboard 不得再产出该形态', async () => {
    mockDashboard();

    // (a) 旧深链的语义事实：等值过滤 ⇒ 0 行 + 空态文案（今日缺陷的原始症状）
    renderApp(`/executions?status=${OLD_SINGLE_STATUS}`);
    await waitFor(() => expect(statusesSeen().length).toBeGreaterThan(0));
    expect(statusesSeen().every((s) => s === OLD_SINGLE_STATUS)).toBe(true);
    // 核心反证断言：旧深链的 status **不含** timeout
    expect(statusesSeen().some((s) => (s ?? '').includes('timeout'))).toBe(false);
    expect(listRowCount()).toBe(0);
    expect(await screen.findByText('没有匹配的执行记录')).toBeTruthy();

    // (b) 同一现场下 Dashboard 产出的深链不得是旧形态
    cleanup();
    vi.clearAllMocks();
    mockDashboard();
    renderApp('/dashboard');
    await waitFor(() => expect(screen.getByTestId('failure-top-list')).toBeTruthy(), { timeout: 5000 });

    const status = hrefQuery(linkByText('全部失败').getAttribute('href') ?? '').get('status');
    expect(status).toBe(MULTI_STATUS);
    expect(status).not.toBe(OLD_SINGLE_STATUS);
    expect(status).toContain('timeout');
  });

  /**
   * ③ `%2C` 编码形态：`URLSearchParams` 编码的 `failed%2Ctimeout` 进 URL，
   * ExecutionsPage 必须原样解出 `failed,timeout` 交给后端（Express 会解码，
   * 真机验证过）。这条钉住「前端编码不影响后端」：
   *   · 若有人加一层手工 split 后只取首值 ⇒ 变成 `failed` ⇒ 红；
   *   · 若有人双重编码 ⇒ 变成 `failed%2Ctimeout`（字面百分号）⇒ 红。
   */
  it('③ %2C 形态解码为 failed,timeout（不拆单值、不双重编码）', async () => {
    renderApp(`/executions?status=${MULTI_STATUS_ENCODED}`);

    await waitFor(() => expect(statusesSeen().length).toBeGreaterThan(0));
    expect(statusesSeen()[0]).toBe(MULTI_STATUS);
    expect(statusesSeen()[0]).not.toBe(OLD_SINGLE_STATUS);
    // 双重编码/未解码的形态必须不出现（含字面 % 即说明某处多编了一层）
    expect(statusesSeen()[0]).not.toContain('%');
    expect(statusesSeen()[0]).not.toContain(MULTI_STATUS_ENCODED);

    // 端到端：解码正确 ⇒ 后端 IN 命中 ⇒ 用户看到 3 行
    await waitFor(() => expect(listRowCount()).toBe(3));
  });

  /**
   * ④「最近失败 → 全部记录」**刻意**不带 status。
   *
   * 「全部记录」承诺的是**全部**执行记录（它本来就能看到那些 timeout）；
   * 为了「与左卡保持一致」给它加 `status=failed,timeout`，等于把「全部」偷换成
   * 「全部失败」——那是另一个、更坏的谎报（R281 已论证）。故断言 href 恰为
   * `/executions` 且**不含** status：任何人把它改成带 status 都会红。
   */
  it('④ 「全部记录」href 恰为 /executions，不含 status（「全部」不得被偷换成「全部失败」）', async () => {
    mockDashboard();
    renderApp('/dashboard');

    await waitFor(() => expect(screen.getByText('全部记录')).toBeTruthy(), { timeout: 5000 });

    const href = linkByText('全部记录').getAttribute('href') ?? '';
    expect(href).toBe('/executions');
    expect(href).not.toContain('status');
    expect(hrefQuery(href).has('status')).toBe(false);
  });
});