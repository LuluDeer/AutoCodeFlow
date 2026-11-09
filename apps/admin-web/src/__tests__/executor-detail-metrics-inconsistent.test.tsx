/**
 * R59（§7.17 P3）`inconsistent-metrics-hint`：后端上报的计数**自相矛盾**时，
 * 详情页必须**明说**「数据不一致，已按下限显示」。
 *
 * ## 为什么需要这条提示
 *
 * 展示口径是 `实际在跑 = runningTaskCount − reservedSlots`，但两者的**写入时机
 * 不同**：R16 把 `runningTaskCount` 抬到「客户端上报 vs 服务端在途占坑」的较大值，
 * 而 `reservedSlots` 仍是客户端自述值（采纳时只校验「≤ 当时行上的
 * runningTaskCount」，R16 的下限在写入前才生效）。R17 的事实核查已确认
 * **落库状态里 `reservedSlots > runningTaskCount` 是可达的**（不是防御性幻想）。
 *
 * R18 已把换算收进 `resolveRunningCount`（下限钳 0），界面不会显示负数——但
 * **用户仍然看不到「这个数是被钳出来的」**：卡片只会安静地显示 `0`，运维无从
 * 判断「真的没在跑」还是「后端上报打架了」。本组用例锁死这条可观测性。
 *
 * ## 判据（成对，双向咬）
 *
 * 1. `reserved > occupied` ⇒ 必须出现提示（旧实现无提示 ⇒ 本文件首轮 exit 1）；
 * 2. `reserved <= occupied`（含旧版执行器 `reservedSlots = null`）⇒ **不得**出现
 *    提示 —— 反向断言，防止「常显」把提示降级成噪音。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import ExecutorDetailPage from '../pages/ExecutorDetailPage';
import { executorsApi } from '../api/executors';
import { useAuthStore } from '../store/auth';

vi.mock('../api/executors', () => ({
  executorsApi: {
    get: vi.fn(),
    getMetrics: vi.fn(),
    getExecutions: vi.fn(),
    rotateToken: vi.fn(),
    remove: vi.fn(),
  },
}));
const mockedApi = vi.mocked(executorsApi, true);

// jsdom 缺失 antd 依赖的浏览器 API（既有先例 shim）
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

const baseExecutor = {
  id: 'executor-r59',
  appName: 'RPA9',
  address: '10.0.0.9:3002',
  status: 'online',
  cpuUsage: 3.2,
  memUsage: 21.5,
  runningTaskCount: 1,
  reservedSlots: 5,
  runningExecutionIds: [],
  maxConcurrentTasks: 10,
  lastHeartbeat: new Date().toISOString(),
};

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/executors/executor-r59']}>
        <Routes>
          <Route path="/executors/:id" element={<ExecutorDetailPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** 提示文案的唯一标识（与 i18n 的 `executorMetrics.inconsistent` 同源；R62 起与列表页共用）。 */
const INCONSISTENT_HINT = /后端上报的任务计数不一致/;

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
  useAuthStore.setState({ user: { id: 1, username: 'root', role: 'admin' } });
  mockedApi.get.mockResolvedValue({ ...baseExecutor } as never);
  mockedApi.getMetrics.mockResolvedValue({
    executor: { id: 'executor-r59', address: '10.0.0.9:3002', status: 'online' },
    sevenDayStats: { totalExecutions: 0, successful: 0, failed: 0, successRate: 0, averageDurationMs: 0 },
    current: { runningTaskCount: 1, reservedSlots: 5 },
    history: [],
  } as never);
  mockedApi.getExecutions.mockResolvedValue({ total: 0, items: [] } as never);
});

afterEach(() => {
  cleanup();
});

describe('R59 — reservedSlots > runningTaskCount：必须给出「计数不一致」提示', () => {
  it('【正向】矛盾计数 ⇒ 出现提示，且卡片仍按钳制后的 0 显示', async () => {
    renderPage();
    await screen.findAllByText('RPA9');

    // 核心断言：数据自相矛盾时用户**看得见**。
    expect(await screen.findByText(INCONSISTENT_HINT)).toBeTruthy();
    // 说明文案要讲清清零的原因（"已按 0 显示"），而不是让用户自己猜。
    expect(screen.getByText(/已按 0 显示/)).toBeTruthy();
    // 钳制口径不变：occupied(1) − reserved(5) 被钳到 0，绝不出现负数。
    const card = (Array.from(document.querySelectorAll('.ant-statistic')) as HTMLElement[]).find(
      (el) => (el.textContent ?? '').includes('当前运行任务'),
    );
    expect(card?.querySelector('.ant-statistic-content-value')?.textContent ?? '').toBe('0');
  });

  it('【反向】reserved < occupied（合理预留）⇒ 不得出现不一致提示，只显示预留说明', async () => {
    mockedApi.get.mockResolvedValue({
      ...baseExecutor,
      runningTaskCount: 10,
      reservedSlots: 3,
    } as never);
    mockedApi.getMetrics.mockResolvedValue({
      executor: { id: 'executor-r59', address: '10.0.0.9:3002', status: 'online' },
      sevenDayStats: { totalExecutions: 0, successful: 0, failed: 0, successRate: 0, averageDurationMs: 0 },
      current: { runningTaskCount: 10, reservedSlots: 3 },
      history: [],
    } as never);

    renderPage();
    await screen.findAllByText('RPA9');

    // 预留说明照旧（合理预留不是异常）。
    expect(await screen.findByText(/已占 10 个槽位（含 3 个取件预留）/)).toBeTruthy();
    expect(screen.queryByText(INCONSISTENT_HINT)).toBeNull();
  });

  it('【反向】reserved === occupied ⇒ 边界相等不算矛盾，不得出现提示', async () => {
    mockedApi.get.mockResolvedValue({
      ...baseExecutor,
      runningTaskCount: 2,
      reservedSlots: 2,
    } as never);
    mockedApi.getMetrics.mockResolvedValue({
      executor: { id: 'executor-r59', address: '10.0.0.9:3002', status: 'online' },
      sevenDayStats: { totalExecutions: 0, successful: 0, failed: 0, successRate: 0, averageDurationMs: 0 },
      current: { runningTaskCount: 2, reservedSlots: 2 },
      history: [],
    } as never);

    renderPage();
    await screen.findAllByText('RPA9');

    expect(await screen.findByText(/已占 2 个槽位（含 2 个取件预留）/)).toBeTruthy();
    expect(screen.queryByText(INCONSISTENT_HINT)).toBeNull();
  });

  it('【反向】旧版执行器未上报 reservedSlots（null）⇒ 无从判断矛盾，不得出现提示', async () => {
    mockedApi.get.mockResolvedValue({
      ...baseExecutor,
      reservedSlots: null,
    } as never);
    mockedApi.getMetrics.mockResolvedValue({
      executor: { id: 'executor-r59', address: '10.0.0.9:3002', status: 'online' },
      sevenDayStats: { totalExecutions: 0, successful: 0, failed: 0, successRate: 0, averageDurationMs: 0 },
      current: { runningTaskCount: 1 },
      history: [],
    } as never);

    renderPage();
    await screen.findAllByText('RPA9');

    expect(screen.queryByText(INCONSISTENT_HINT)).toBeNull();
  });
});
