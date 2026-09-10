/**
 * UI-09 补齐：控制台（DashboardPage）/ 执行详情（ExecutionDetailPage）
 * 移动端（375px）适配回归。
 *
 * 侦察结论（本套件的断言口径来源）：
 *  · ExecutionDetailPage 内**没有 antd Table**——日志是 <pre>、时间线是
 *    Steps、重试链/产物是自绘 flex 与 List。故本页不存在「表格次要列 +
 *    scroll.x」可断言面（既有三页表格的同类断言在 mobile-ui09.test.tsx）。
 *    本页真实溢出点是：日志卡工具条顶出卡头、参数 Tag（antd Tag 默认
 *    nowrap）被长 URL 撑到上千像素、超长任务名面包屑不收缩、以及跨列
 *    Descriptions.Item 在 xs 单列时 span=3 超出列数。
 *  · DashboardPage 真实溢出点是 xs 两列并排（每卡内容宽 ~144px）时
 *    28px 统计值顶破卡片。
 *  jsdom 无布局引擎：断言「渲染产物」（类名/colSpan/属性）与 CSS 源文本，
 *  不假装能断言像素宽度；像素级验证由真实浏览器 375px 实测承担。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, within, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cloneElement } from 'react';
import { readFileSync } from 'node:fs';
import DashboardPage from '../pages/DashboardPage';
import ExecutionDetailPage, { UI09_DESCRIPTIONS_COLUMN } from '../pages/ExecutionDetailPage';
import { metricsApi } from '../api/metrics';
import { tasksApi } from '../api/tasks';

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

// tasksApi 同时服务 DashboardPage（schedulerStats）与 ExecutionDetailPage
// （execution/get/executionsWithStatus），一次 mock 覆盖两页用到的面。
vi.mock('../api/tasks', () => ({
  tasksApi: {
    schedulerStats: vi.fn(),
    execution: vi.fn(),
    executionLogs: vi.fn(),
    get: vi.fn(),
    executionsWithStatus: vi.fn(),
    killExecution: vi.fn(),
    trigger: vi.fn(),
    analyzeExecution: vi.fn(),
  },
}));
const mockedTasks = vi.mocked(tasksApi, true);

vi.mock('../api/artifacts', () => ({
  artifactsApi: { listArtifacts: vi.fn(), downloadArtifact: vi.fn() },
}));
vi.mock('../api/execution-reports', () => ({
  executionReportsApi: { report: vi.fn() },
}));

// recharts ResponsiveContainer 依赖布局测量（对齐 dashboard-ui04 先例：
// 注入显式宽高，其余导出用真实现）
vi.mock('recharts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('recharts')>();
  return {
    ...actual,
    ResponsiveContainer: ({ children }: { children: React.ReactElement }) =>
      cloneElement(children, { width: 200, height: 36 }),
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
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}

// UI-09 行为断言的关键桩：按测试需要伪造断点命中，驱动 antd useBreakpoint
// 走 xs / md 两条 分支（真实浏览器里由媒体查询决定，jsdom 只能打桩）。
let mediaMode: 'xs' | 'md' = 'xs';
window.matchMedia = ((q: string) => {
  const matches = mediaMode === 'xs'
    ? q.includes('max-width: 575px')
    : /min-width: (576|768)px/.test(q);
  return {
    matches,
    media: q,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  } as unknown as MediaQueryList;
}) as unknown as typeof window.matchMedia;

// UI-14: DashboardPage 挂 useMetricsStream（SSE）——jsdom 无 EventSource
class NoopEventSource {
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) {}
  addEventListener() {}
  close() {}
}

const LONG_NAME = 'production-cluster-nightly-full-backup-and-verify-with-a-very-long-descriptive-suffix';
const LONG_PARAM = 'https://git.example.com/a/very/long/repository/path/that/never/ends/and/keeps/going/repo.git#refs/heads/feature-branch';

const summaryFixture = {
  totalTasks: 12345678,
  todayRuns: 9876543,
  totalExecutors: 999,
  onlineExecutors: 998,
  executions: { total: 120, success: 110, failed: 10, running: 1234 },
  successRate: 91.7,
  avgDurationMs: 987654321,
};

const execFixture = {
  id: 'e1',
  taskId: 't1',
  taskName: LONG_NAME,
  status: 'failed',
  triggerType: 'manual',
  logs: 'line-1\nline-2',
  failureReason: 'script_error',
  errorMessage: 'exit code 1: cannot import numpy',
  retryCount: 0,
  exitCode: 1,
  duration: 60000,
  executorAddress: '10.0.0.1:3002',
  taskVersion: 'v1.2.3',
  startTime: '2026-09-11T10:00:00Z',
  endTime: '2026-09-11T10:01:00Z',
  createdAt: '2026-09-11T10:00:00Z',
};

const taskFixture = {
  id: 't1',
  name: LONG_NAME,
  maxRetry: 3,
  retryDelay: 5,
  params: { gitRepo: LONG_PARAM, region: 'cn-north-1' },
};

function makeQueryClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

function renderWithProviders(node: React.ReactElement, path: string) {
  return render(
    <QueryClientProvider client={makeQueryClient()}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/dashboard" element={node} />
          <Route path="/tasks/:taskId/executions/:execId" element={node} />
          <Route path="/executions" element={<div>executions-mock</div>} />
          <Route path="/tasks/:id" element={<div>task-detail-mock</div>} />
          <Route path="/tasks/new" element={<div>task-new-mock</div>} />
          <Route path="/executors/:id" element={<div>executor-detail-mock</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('EventSource', NoopEventSource);
  mediaMode = 'xs';
  mockedMetrics.getSummary.mockResolvedValue(summaryFixture as never);
  mockedMetrics.getDailyTrend.mockResolvedValue([
    { date: '2026-09-10', success: 5, failed: 1 },
  ] as never);
  mockedMetrics.getExecutorStats.mockResolvedValue([] as never);
  mockedMetrics.getRecentFailures.mockResolvedValue([] as never);
  mockedMetrics.getSchedulerMetrics.mockResolvedValue({
    counters: { triggerLatencyCount: 0 },
    derived: {},
    queue: {},
    scheduler: {},
    instance: {},
  } as never);
  mockedTasks.schedulerStats.mockResolvedValue({
    healthy: true,
    activeTimers: 1,
    activeCronTasks: 1,
    runningTaskCount: 0,
    totalScheduledTasks: 1,
    uptime: 60,
  } as never);
  mockedTasks.execution.mockResolvedValue(execFixture as never);
  mockedTasks.get.mockResolvedValue(taskFixture as never);
  mockedTasks.executionsWithStatus.mockResolvedValue({
    items: [{ id: 'e1', retryCount: 0, status: 'failed' }],
    total: 1,
    page: 1,
    pageSize: 100,
  } as never);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('UI-09 DashboardPage 375px 产物', () => {
  it('KPI 统计卡挂 ui09-kpi-stat（窄屏降字号防大数值顶破 168px 卡片）', async () => {
    renderWithProviders(<DashboardPage />, '/dashboard');
    await screen.findAllByText('任务总数');
    const stats = document.querySelectorAll('.ui09-kpi-stat');
    // 四张 KPI 卡（任务总数/今日执行/运行中/在线执行器）逐一挂类
    expect(stats.length).toBe(4);
  });

  it('页头 SSE 连接状态点与关键卡片正常渲染（窄屏页头允许换行）', async () => {
    renderWithProviders(<DashboardPage />, '/dashboard');
    expect(screen.getByTestId('metrics-stream-status')).toBeTruthy();
    // PageHeader 的布局容器显式允许换行，表达窄屏操作区不横向溢出的意图。
    // 不依赖 antd 版本中不存在的 .ant-space-wrap 类名。
    const pageHeader = screen.getByTestId('page-header');
    const headerLayout = pageHeader.children[0] as HTMLElement;
    expect(headerLayout.style.flexWrap).toBe('wrap');
    await screen.findByText('执行趋势');
    // 趋势图数据到达后才从骨架切到 recharts（ResponsiveContainer 已注入尺寸）
    await waitFor(() => {
      expect(document.querySelectorAll('svg.recharts-surface').length).toBeGreaterThan(0);
    });
  });
});

describe('UI-09 ExecutionDetailPage 375px 产物', () => {
  it('页面根挂 ui09-exec-detail 作用域；本页无表格（UI-09 表格规则不适用）', async () => {
    renderWithProviders(<ExecutionDetailPage />, '/tasks/t1/executions/e1');
    await screen.findByText('执行信息');
    expect(document.querySelector('.ui09-exec-detail')).toBeTruthy();
    // 侦察结论守卫：本页无 antd Table（若未来引入表格，需按 mobile-ui09
    // 既有模式补 scroll.x + 次要列 ui09-hide-mobile，本断言会失败提醒）
    expect(document.querySelector('.ant-table')).toBeNull();
  });

  it('超长任务名面包屑：挂 ui09-crumb-ellipsis 省略号类且 title 保全文', async () => {
    renderWithProviders(<ExecutionDetailPage />, '/tasks/t1/executions/e1');
    await screen.findByText('执行信息');
    const crumb = document.querySelector('.ui09-crumb-ellipsis');
    expect(crumb).toBeTruthy();
    expect(crumb!.textContent).toBe(LONG_NAME);
    expect(crumb!.getAttribute('title')).toBe(LONG_NAME);
  });

  it('执行日志卡：工具条挂 ui09-log-toolbar-card / ui09-log-toolbar（窄屏换行独占整行）', async () => {
    renderWithProviders(<ExecutionDetailPage />, '/tasks/t1/executions/e1');
    // “执行日志”同时是 Tab 和 Card 标题：Tab 用精确 role/name，Card
    // 则从日志区域的稳定产物 log-pre 向上限定范围，避免文本查询歧义。
    const logsTab = await screen.findByRole('tab', { name: /^执行日志$/ });
    expect(logsTab.getAttribute('aria-selected')).toBe('true');
    const logPre = await screen.findByTestId('log-pre');
    const logCard = logPre.closest('.ui09-log-toolbar-card');
    expect(logCard).not.toBeNull();
    expect(logCard?.querySelector('.ui09-log-toolbar')).not.toBeNull();
  });

  it('执行信息跨列项随断点收敛：xs 单列 colSpan=1，md 三列 colSpan=3', async () => {
    // xs（375px）：column={xs:1,...} → 旧写法 span={3} 会超出列数并撑破卡片
    mediaMode = 'xs';
    const first = renderWithProviders(<ExecutionDetailPage />, '/tasks/t1/executions/e1');
    await screen.findByText('执行信息');
    const descXs = document.querySelector('.ant-descriptions') as HTMLElement;
    expect(descXs).toBeTruthy();
    const errorTdXs = within(descXs).getByText('错误信息').closest('td');
    expect(errorTdXs?.getAttribute('colspan')).toBe('1');
    first.unmount();

    // md（≥768px）：列数 3 → 跨列项占满整行
    mediaMode = 'md';
    renderWithProviders(<ExecutionDetailPage />, '/tasks/t1/executions/e1');
    await screen.findByText('执行信息');
    const descMd = document.querySelector('.ant-descriptions') as HTMLElement;
    const errorTdMd = within(descMd).getByText('错误信息').closest('td');
    expect(errorTdMd?.getAttribute('colspan')).toBe('3');
  });

  it('参数与产物 Tab：参数 Tag 挂 ui09-param-tag（窄屏允许长 URL 折行）', async () => {
    renderWithProviders(<ExecutionDetailPage />, '/tasks/t1/executions/e1?tab=context');
    await screen.findByText(/region = cn-north-1/);
    const tags = document.querySelectorAll('.ui09-param-tag');
    expect(tags.length).toBe(2);
    // 长 URL 参数在 Tag 文本中（截断展示由 CSS 承担，内容不丢）
    expect(Array.from(tags).some((t) => t.textContent?.includes(LONG_PARAM))).toBe(true);
  });

  it('UI09_DESCRIPTIONS_COLUMN 与页面声明同源（导出供本套件锚定列数配置）', () => {
    expect(UI09_DESCRIPTIONS_COLUMN).toEqual({ xs: 1, sm: 2, md: 3 });
  });
});

describe('UI-09 新增工具类样式源（index.css）', () => {
  it('≤768px 媒体查询含本轮新增的页级工具类，且既有规则未被破坏', () => {
    // jsdom 不解析 CSS 文件：直接读源文件文本断言规则存在（对齐 mobile-ui09 先例）
    const css = readFileSync('src/index.css', 'utf-8');
    expect(css).toContain('@media (max-width: 768px)');
    // 本轮新增
    expect(css).toContain('.ui09-kpi-stat');
    expect(css).toContain('.ui09-exec-detail .ant-breadcrumb li');
    expect(css).toContain('.ui09-crumb-ellipsis');
    expect(css).toContain('.ui09-log-toolbar-card');
    expect(css).toContain('.ui09-param-tag');
    // 既有规则回归守卫（只追加、不改动既有类与断点）
    expect(css).toContain('.ui09-hide-mobile');
    expect(css).toContain('.mobile-sider-open .ant-layout-sider');
  });
});
