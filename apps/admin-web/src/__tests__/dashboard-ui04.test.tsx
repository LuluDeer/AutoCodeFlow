/**
 * UI-04 回归：Dashboard 重构五项（指标卡 sparkline / 失败 Top 榜 / 执行器
 * 资源热力条 / 调度延迟卡 / 空态引导）。
 *
 * 对齐既有页面测试风格（executor-detail-trend.test.tsx）：mock api 层隔离
 * axios 拦截器 + recharts ResponsiveContainer 注入显式宽高 + antd 浏览器
 * API shim。DashboardPage 内含既有四卡与趋势图，断言聚焦本轮新增产物。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
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

// recharts ResponsiveContainer 依赖布局测量（既有先例 mock：注入显式宽高，
// 其余导出用真实现——sparkline 的 .recharts-line 断言的是真实图表产物）
vi.mock('recharts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('recharts')>();
  return {
    ...actual,
    ResponsiveContainer: ({ children }: { children: React.ReactElement }) =>
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
Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
  configurable: true,
  value: 800,
});
Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
  configurable: true,
  value: 400,
});

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
  { date: '2026-09-01', success: 5, failed: 1 },
  { date: '2026-09-02', success: 8, failed: 0 },
  { date: '2026-09-03', success: 3, failed: 2 },
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
  {
    id: 'exec-2',
    appName: 'beta',
    address: '10.0.0.2:3002',
    status: 'busy',
    cpuUsage: 90,
    memUsage: 70,
    runningTaskCount: 4,
    lastHeartbeat: new Date().toISOString(),
  },
];

const failuresFixture = [
  { id: 'f1', taskId: 'task-a', taskName: '任务A', errorMessage: 'boom', failureReason: 'script_error', exitCode: 1, createdAt: '2026-09-07T10:00:00Z', duration: 1000 },
  { id: 'f2', taskId: 'task-a', taskName: '任务A', errorMessage: 'boom2', failureReason: null, exitCode: null, createdAt: '2026-09-07T11:00:00Z', duration: 1200 },
  { id: 'f3', taskId: 'task-b', taskName: '任务B', errorMessage: 'nope', failureReason: 'timeout', exitCode: null, createdAt: '2026-09-07T09:00:00Z', duration: 800 },
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

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/dashboard']}>
      <Routes>
        <Route path="/dashboard" element={<DashboardPage />} />
        <Route path="/tasks/:id" element={<div>task-detail-mock</div>} />
        <Route path="/executors/:id" element={<div>executor-detail-mock</div>} />
        <Route path="/tasks/new" element={<div>task-new-mock</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

function mockAll({
  summary = summaryFixture,
  trend = trendFixture,
  executors = executorsFixture,
  failures = failuresFixture,
  schedulerMetrics = schedulerMetricsFixture,
} = {}) {
  mockedMetrics.getSummary.mockResolvedValue(summary);
  mockedMetrics.getDailyTrend.mockResolvedValue(trend);
  mockedMetrics.getExecutorStats.mockResolvedValue(executors);
  mockedMetrics.getRecentFailures.mockResolvedValue(failures);
  mockedMetrics.getSchedulerMetrics.mockResolvedValue(schedulerMetrics);
  mockedTasks.schedulerStats.mockResolvedValue(schedulerStatsFixture);
}

describe('DashboardPage — UI-04 五项', () => {
  beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
    useAuthStore.setState({ user: { id: 1, username: 'root', role: 'admin' } });
  });

  describe('① 指标卡 sparkline', () => {
    it('有数据：KPI 卡内渲染迷你折线（.recharts-line 真实产物）', async () => {
      mockAll();
      renderPage();
      await waitFor(
        () => {
          expect(screen.getAllByTestId('kpi-sparkline').length).toBeGreaterThanOrEqual(2);
        },
        { timeout: 5000 },
      );
      // 每条 sparkline 都产生真实折线图层（ResponsiveContainer 已注入尺寸）
      expect(document.querySelectorAll('.recharts-line').length).toBeGreaterThanOrEqual(2);
    });

    it('无数据：sparkline 渲染「暂无数据」占位而非空白', async () => {
      mockAll({ trend: [] });
      renderPage();
      await waitFor(
        () => {
          expect(screen.getAllByTestId('kpi-sparkline-empty').length).toBeGreaterThanOrEqual(2);
        },
        { timeout: 5000 },
      );
      expect(screen.getAllByText('暂无数据').length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('② 失败 Top 任务榜', () => {
    it('按任务聚合并按失败次数降序展示 Top 行', async () => {
      mockAll();
      renderPage();
      await waitFor(
        () => {
          expect(screen.getByTestId('failure-top-list')).toBeTruthy();
        },
        { timeout: 5000 },
      );
      const counts = screen.getAllByTestId('failure-top-count').map(el => el.textContent);
      // 任务A 两次失败排第一，任务B 一次排第二
      expect(counts[0]).toBe('2 次');
      expect(counts[1]).toBe('1 次');
      // 榜单内锚定任务名（页面下方「最近失败」明细卡也含同名文本，
      // 用 testid 作用域限定到榜单行）
      const rows = screen.getAllByTestId('failure-top-row');
      expect(rows[0].textContent).toContain('任务A');
      expect(rows[1].textContent).toContain('任务B');
    });

    it('点击榜单行跳转任务详情页', async () => {
      mockAll();
      renderPage();
      await waitFor(
        () => {
          expect(screen.getByTestId('failure-top-list')).toBeTruthy();
        },
        { timeout: 5000 },
      );
      fireEvent.click(screen.getAllByTestId('failure-top-row')[0]);
      await waitFor(() => {
        expect(screen.getByText('task-detail-mock')).toBeTruthy();
      });
    });

    it('无失败数据：渲染空态占位', async () => {
      mockAll({ failures: [] });
      renderPage();
      await waitFor(
        () => {
          expect(screen.getByTestId('failure-top-empty')).toBeTruthy();
        },
        { timeout: 5000 },
      );
      expect(screen.getByText('近期无失败任务')).toBeTruthy();
    });
  });

  describe('③ 执行器资源热力条', () => {
    it('每执行器一行双条形，按阈值上色（90=红 / 30=绿 / 50=绿）', async () => {
      mockAll();
      renderPage();
      await waitFor(
        () => {
          expect(screen.getAllByTestId('executor-heat-row')).toHaveLength(2);
        },
        { timeout: 5000 },
      );
      const fills = document.querySelectorAll<HTMLElement>('[data-testid^="heat-fill-"]');
      // 4 条填充（2 执行器 × CPU/内存）
      expect(fills).toHaveLength(4);
      // jsdom 不解析 CSS 变量：断言内联 style 原始值（heatColor 返回的 token 名）
      const colorOf = (label: string, row: number) =>
        (document.querySelectorAll(`[data-testid="heat-fill-${label}"]`)[row] as HTMLElement).style.background;
      // beta CPU 90 ≥ 85 → destructive 红；alpha CPU 30 / 内存 50 → accent 绿
      expect(colorOf('CPU', 1)).toBe('var(--color-destructive)');
      expect(colorOf('CPU', 0)).toBe('var(--color-accent)');
      expect(colorOf('内存', 0)).toBe('var(--color-accent)');
    });

    it('点击执行器行跳转执行器详情页', async () => {
      mockAll();
      renderPage();
      await waitFor(
        () => {
          expect(screen.getAllByTestId('executor-heat-row')).toHaveLength(2);
        },
        { timeout: 5000 },
      );
      fireEvent.click(screen.getAllByTestId('executor-heat-row')[0]);
      await waitFor(() => {
        expect(screen.getByText('executor-detail-mock')).toBeTruthy();
      });
    });
  });

  describe('④ 调度延迟卡', () => {
    it('渲染 P99/平均/最近一次三个数字（formatDuration 毫秒形态）', async () => {
      mockAll();
      renderPage();
      await waitFor(
        () => {
          expect(screen.getByTestId('scheduler-latency-card')).toBeTruthy();
        },
        { timeout: 5000 },
      );
      // p99=80ms / avg=100ms / last=42ms
      expect(screen.getByText('80ms')).toBeTruthy();
      expect(screen.getByText('100ms')).toBeTruthy();
      expect(screen.getByText('42ms')).toBeTruthy();
      // 样本数注记
      expect(screen.getByText(/样本 15 次/)).toBeTruthy();
    });

    it('无样本：P99/均值显式 0 值提示「暂无定时触发样本」而非误导', async () => {
      mockAll({
        schedulerMetrics: {
          ...schedulerMetricsFixture,
          counters: {
            ...schedulerMetricsFixture.counters,
            triggerLatencyCount: 0,
            triggerLatencySumMs: 0,
            lastTriggerLatencyMs: 0,
          },
        },
      });
      renderPage();
      await waitFor(
        () => {
          expect(screen.getByTestId('scheduler-latency-card')).toBeTruthy();
        },
        { timeout: 5000 },
      );
      expect(screen.getByText(/暂无定时触发样本/)).toBeTruthy();
    });
  });

  describe('⑤ 空态引导', () => {
    it('totalTasks===0：显示 Empty 引导与「创建第一个任务」按钮并跳 /tasks/new', async () => {
      mockAll({ summary: { ...summaryFixture, totalTasks: 0 } });
      renderPage();
      await waitFor(
        () => {
          expect(screen.getByTestId('dashboard-empty-guide')).toBeTruthy();
        },
        { timeout: 5000 },
      );
      fireEvent.click(screen.getByTestId('dashboard-empty-guide-create'));
      await waitFor(() => {
        expect(screen.getByText('task-new-mock')).toBeTruthy();
      });
    });

    it('totalTasks>0：不渲染空态引导', async () => {
      mockAll();
      renderPage();
      await waitFor(
        () => {
          expect(screen.getByText('失败 Top 任务')).toBeTruthy();
        },
        { timeout: 5000 },
      );
      expect(screen.queryByTestId('dashboard-empty-guide')).toBeNull();
    });
  });
});
