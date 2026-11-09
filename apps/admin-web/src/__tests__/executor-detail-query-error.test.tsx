/**
 * R149-F2 回归：执行器详情的两个重查询（metrics / executions）**读取失败**
 * 必须可见且可恢复。
 *
 * 修复前：error 被解构丢弃 ⇒ 24h 趋势说「暂无历史采样」、性能统计说「暂无性能
 * 数据」、活跃卡回落进页快照却仍标「每 30s 轮询」、执行历史说「该执行器暂无历史
 * 执行记录」——把「读接口坏了」谎报成「这台机器没数据」。
 *
 * 断言口径（照 audit F2 的修法）：
 *   ① metrics reject ⇒ 页内出现 StateError（性能统计/资源趋势），**不得**再出现
 *      两条空态文案；活跃卡的轮询标注变「轮询已中断」，不再说「每 30s 轮询」；
 *   ② executions reject ⇒ 出现「执行历史加载失败」，**不得**出现
 *      「该执行器暂无历史执行记录」；
 *   ③ 重试按钮真的重新发请求（refetch 走 TanStack，API 被再次调用）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { cloneElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import '../i18n';
import ExecutorDetailPage from '../pages/ExecutorDetailPage';
import { executorsApi } from '../api/executors';
import { projectsApi } from '../api/projects';
import { useAuthStore } from '../store/auth';

vi.mock('../api/executors', () => ({
  executorsApi: {
    get: vi.fn(),
    getMetrics: vi.fn(),
    getExecutions: vi.fn(),
    getRuntimeConfig: vi.fn(),
  },
}));
vi.mock('../api/projects', () => ({
  projectsApi: { listMyRoles: vi.fn() },
}));
const mockedApi = vi.mocked(executorsApi, true);
const mockedProjects = vi.mocked(projectsApi, true);

// recharts 需要布局测量（jsdom 无）——与 executor-detail-trend.test.tsx 同一份 shim
vi.mock('recharts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('recharts')>();
  return {
    ...actual,
    ResponsiveContainer: ({ children }: { children: React.ReactElement<Record<string, unknown>> }) =>
      cloneElement(children, { width: 800, height: 260 }),
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

const metricsFixture = {
  executor: { id: 'executor-1', address: '10.0.0.9:3002', status: 'online' },
  sevenDayStats: {
    totalExecutions: 10,
    successful: 8,
    failed: 2,
    successRate: 80,
    averageDurationMs: 1200,
  },
  current: { runningTaskCount: 1, reservedSlots: 0, cpuUsage: 20, memUsage: 50 },
  history: [],
};

const executionsFixture = { total: 0, items: [] };

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/executors/executor-1']}>
        <Routes>
          <Route path="/executors/:id" element={<ExecutorDetailPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** antd 给两字中文按钮插空格：「重 试」 */
const retryButtons = () => screen.getAllByRole('button', { name: /重\s*试/ });

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
  useAuthStore.setState({ user: { id: 1, username: 'root', role: 'admin' } });
  mockedProjects.listMyRoles.mockResolvedValue({ userId: 1, isAdmin: true, memberships: [] });
  mockedApi.get.mockResolvedValue(executorFixture);
  mockedApi.getRuntimeConfig.mockResolvedValue({
    heartbeatIntervalMs: 30_000,
    heartbeatTimeoutMultiplier: 3,
    heartbeatTimeoutMs: 90_000,
    listLimit: 500,
    executorTotal: 1,
  });
  mockedApi.getMetrics.mockResolvedValue(metricsFixture);
  mockedApi.getExecutions.mockResolvedValue(executionsFixture);
});

describe('R149-F2 ExecutorDetailPage — 查询失败必须可见且可恢复', () => {
  it('metrics 读取失败：性能统计/资源趋势显示错误态，活跃卡改标「轮询已中断」，不再说「暂无数据」', async () => {
    mockedApi.getMetrics.mockRejectedValue(new Error('metrics 500'));

    renderPage();

    // ① 错误态出现（统计卡 + 趋势卡）
    expect(await screen.findByText('性能统计加载失败')).toBeTruthy();
    expect(await screen.findByText('资源趋势加载失败')).toBeTruthy();
    expect(screen.getAllByTestId('state-error').length).toBeGreaterThanOrEqual(2);

    // ② 空态文案不得再冒充「读取失败」
    expect(screen.queryByText(/暂无性能数据/)).toBeNull();
    expect(screen.queryByText('暂无历史采样')).toBeNull();

    // ③ 活跃卡不再宣称「每 30s 轮询」，改为「轮询已中断」+ 快照说明
    expect(await screen.findByText('轮询已中断')).toBeTruthy();
    expect(screen.queryByText('每 30s 轮询')).toBeNull();
    expect(screen.getByText(/下方为进入页面时的快照值/)).toBeTruthy();

    // ④ 重试真的重新发请求
    expect(mockedApi.getMetrics).toHaveBeenCalledTimes(1);
    fireEvent.click(retryButtons()[0]);
    await waitFor(() => expect(mockedApi.getMetrics).toHaveBeenCalledTimes(2));
  });

  it('executions 读取失败：显示「执行历史加载失败」+ 重试，不再说「暂无历史执行记录」', async () => {
    mockedApi.getExecutions.mockRejectedValue(new Error('executions 502'));

    renderPage();

    expect(await screen.findByText('执行历史加载失败')).toBeTruthy();
    // 列表类空态文案不得出现（读取失败 ≠ 没有历史）
    expect(screen.queryByText('该执行器暂无历史执行记录')).toBeNull();
    // metrics 那一侧正常 ⇒ 性能统计/趋势仍在（局部失败不牵连整页）
    expect(screen.queryByText('性能统计加载失败')).toBeNull();
    expect(screen.queryByText('暂无历史采样')).toBeTruthy();

    expect(mockedApi.getExecutions).toHaveBeenCalledTimes(1);
    fireEvent.click(retryButtons()[0]);
    await waitFor(() => expect(mockedApi.getExecutions).toHaveBeenCalledTimes(2));
  });

  it('读取成功后恢复：错误态消失、空态文案回归（证明是查询状态而非永久错误块）', async () => {
    mockedApi.getMetrics.mockRejectedValueOnce(new Error('metrics 500'));

    renderPage();

    expect(await screen.findByText('性能统计加载失败')).toBeTruthy();

    // 第二轮成功：点重试 → 错误块消失，正常空态回归
    mockedApi.getMetrics.mockResolvedValue(metricsFixture);
    fireEvent.click(retryButtons()[0]);

    await waitFor(() => expect(screen.queryByText('性能统计加载失败')).toBeNull());
    expect(screen.getByText('暂无历史采样')).toBeTruthy();
    expect(screen.getByText('每 30s 轮询')).toBeTruthy();
  });
});
