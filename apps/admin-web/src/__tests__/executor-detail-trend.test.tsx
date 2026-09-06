/**
 * FEAT-04 回归：执行器详情页「资源趋势（24h）」卡片。
 *
 * 数据契约：GET /executors/:id/metrics 响应新增 `history`（最近 24h 的
 * executor_metrics_history 采样，后端按 15 分钟 AVG 桶聚合，≤96 点，升序；
 * cpuUsage/memUsage 整桶无上报时为 null）。前端：
 *   - 空数组 / 字段缺失（旧响应兜底）→ 显式「暂无历史采样」空态，不渲染图表；
 *   - 有数据 → recharts 折线（CPU/内存左轴、并发右轴），三条系列齐全。
 * 对齐既有页面测试风格（application-list-rbac.test.tsx）：mock api 层隔离
 * axios 拦截器 + antd 所需浏览器 API shim + MemoryRouter 包裹。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { cloneElement } from 'react';
import ExecutorDetailPage from '../pages/ExecutorDetailPage';
import { executorsApi } from '../api/executors';
import { useAuthStore } from '../store/auth';

vi.mock('../api/executors', () => ({
  executorsApi: {
    get: vi.fn(),
    getMetrics: vi.fn(),
    getExecutions: vi.fn(),
  },
}));
const mockedApi = vi.mocked(executorsApi, true);

// recharts 的 ResponsiveContainer 依赖 ResizeObserver 布局测量，jsdom 下
// 拿不到尺寸导致 LineChart 不渲染折线 —— mock 注入显式宽高，
// LineChart/XAxis/Legend 等其余导出用真实现（断言的是真实图表产物）。
vi.mock('recharts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('recharts')>();
  return {
    ...actual,
    ResponsiveContainer: ({ children }: { children: React.ReactElement }) =>
      cloneElement(children, { width: 800, height: 260 }),
  };
});

// jsdom 缺失 antd / recharts 依赖的浏览器 API，先行补齐（对齐既有先例）
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
// recharts ResponsiveContainer 依赖尺寸测量；jsdom 下无布局，给兜底尺寸
Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
  configurable: true,
  value: 800,
});
Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
  configurable: true,
  value: 400,
});

const executorFixture = {
  id: 'executor-1',
  appName: 'demo-executor',
  address: '10.0.0.9:3002',
  status: 'online',
  cpuUsage: 12.5,
  memUsage: 40.1,
  runningTaskCount: 1,
  lastHeartbeat: new Date().toISOString(),
};

/** 构造 history 采样点：从 24h 前起按 15 分钟间隔取 n 个桶 */
function makeHistory(n: number) {
  const points = [];
  const start = Date.now() - 24 * 60 * 60 * 1000;
  for (let i = 0; i < n; i++) {
    points.push({
      timestamp: new Date(start + i * 15 * 60 * 1000).toISOString(),
      cpuUsage: 10 + (i % 20),
      memUsage: 40 + (i % 10),
      runningTaskCount: i % 3,
    });
  }
  return points;
}

function renderPage() {
  // 必须挂 Route 才能让 useParams 拿到 :id（否则 ready=false 永不发请求）
  return render(
    <MemoryRouter initialEntries={['/executors/executor-1']}>
      <Routes>
        <Route path="/executors/:id" element={<ExecutorDetailPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('ExecutorDetailPage — 资源趋势（24h）卡片（FEAT-04）', () => {
  beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
    useAuthStore.setState({ user: { id: 1, username: 'root', role: 'admin' } });
    mockedApi.get.mockResolvedValue(executorFixture);
    // 历史执行表：空列表即可，不参与本组断言
    mockedApi.getExecutions.mockResolvedValue({ total: 0, items: [] });
  });

  it('空数据：显示「暂无历史采样」空态，不渲染折线图', async () => {
    mockedApi.getMetrics.mockResolvedValue({
      executor: { id: 'executor-1', address: '10.0.0.9:3002', status: 'online' },
      sevenDayStats: {
        totalExecutions: 0,
        successful: 0,
        failed: 0,
        successRate: 0,
        averageDurationMs: 0,
      },
      current: { runningTaskCount: 0, cpuUsage: null, memUsage: null },
      history: [],
    });

    renderPage();

    // 全量并行跑时 import/渲染慢于默认 1s 轮询窗——显式放宽超时防 flake
    await waitFor(
      () => {
        expect(screen.getByText('暂无历史采样')).toBeTruthy();
      },
      { timeout: 5000 },
    );
    // 空态下不渲染 SVG 折线图
    expect(document.querySelector('.recharts-line')).toBeNull();
    expect(mockedApi.getMetrics).toHaveBeenCalledWith('executor-1');
  });

  it('history 字段缺失（旧响应）：同样走空态兜底，不抛错', async () => {
    // 后端演进前的旧响应形状——前端必须容忍缺失字段
    mockedApi.getMetrics.mockResolvedValue({
      executor: { id: 'executor-1', address: '10.0.0.9:3002', status: 'online' },
      sevenDayStats: {
        totalExecutions: 0,
        successful: 0,
        failed: 0,
        successRate: 0,
        averageDurationMs: 0,
      },
      current: { runningTaskCount: 0, cpuUsage: null, memUsage: null },
    } as never);

    renderPage();

    await waitFor(
      () => {
        expect(screen.getByText('暂无历史采样')).toBeTruthy();
      },
      { timeout: 5000 },
    );
    expect(document.querySelector('.recharts-line')).toBeNull();
  });

  it('有数据：渲染三条折线系列（CPU/内存/并发）', async () => {
    mockedApi.getMetrics.mockResolvedValue({
      executor: { id: 'executor-1', address: '10.0.0.9:3002', status: 'online' },
      sevenDayStats: {
        totalExecutions: 42,
        successful: 40,
        failed: 2,
        successRate: 95.2,
        averageDurationMs: 1500,
      },
      current: { runningTaskCount: 1, cpuUsage: 15, memUsage: 45 },
      history: makeHistory(8),
    });

    renderPage();

    // 卡片标题渲染
    await waitFor(
      () => {
        expect(screen.getByText('资源趋势（24h）')).toBeTruthy();
      },
      { timeout: 5000 },
    );
    // 空态不应出现
    expect(screen.queryByText('暂无历史采样')).toBeNull();
    // recharts 三条折线齐全（每个 <Line> 一个 .recharts-line 图层）
    await waitFor(
      () => {
        expect(document.querySelectorAll('.recharts-line')).toHaveLength(3);
      },
      { timeout: 5000 },
    );
    // 图例文案（Legend）齐全——三条系列的名称锚定
    expect(screen.getByText('CPU %')).toBeTruthy();
    expect(screen.getByText('内存 %')).toBeTruthy();
    expect(screen.getByText('并发任务')).toBeTruthy();
  });
});
