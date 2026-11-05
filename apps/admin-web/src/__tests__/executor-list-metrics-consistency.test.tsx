/**
 * R62（§7.17 P3 收尾）`list-page-metrics-consistency`：执行器**列表页**是 R59 遗留的
 * 同类盲区——它同样展示运行计数，却直接取 `runningTaskCount` 的**原始值**：
 *
 * · 详情页（R18/R59）显示 `实际在跑 = runningTaskCount − reservedSlots`（下限钳 0），
 *   列表页显示**已占槽位**（含 E-01 取件预留）⇒ **同一个执行器，列表「1/10」、
 *   详情「0/10」**，运维只能二选一相信；
 * · 计数自相矛盾（`reserved > occupied`，R16/R17 实证可达）时，列表页既不钳制也
 *   无提示——与 R59 修好的详情页形成两套口径。
 *
 * 本文件把列表页两个视图（表格 / 卡片）都锁死到**同一套判据**：
 * · 显示数走 `utils/executor-metrics.ts::resolveRunningCount`（与详情页同源）；
 * · 矛盾时出现提示（`hasInconsistentMetrics`，与详情页同源，**不复制逻辑**）。
 *
 * 反向断言同等重要：`reserved <= occupied`（含旧版 `reservedSlots` 缺失）时
 * **不得**出现提示，否则提示退化成常亮噪音。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import ExecutorListPage from '../pages/ExecutorListPage';
import { executorsApi } from '../api/executors';
import { client } from '../api/client';
import { useAuthStore } from '../store/auth';
import type { Executor } from '../api/executors';

vi.mock('../api/executors', () => ({
  executorsApi: { list: vi.fn(), getGroups: vi.fn() },
}));
const mockedExecutors = vi.mocked(executorsApi, true);

vi.mock('../api/client', () => ({
  client: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}));
const mockedClient = vi.mocked(client, true);

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

const NOW = Date.now();
const makeExecutor = (over: Partial<Executor>): Executor => ({
  id: 'ex-1',
  appName: 'alpha',
  address: '10.0.0.1:3002',
  status: 'online',
  cpuUsage: 30,
  memUsage: 50,
  runningTaskCount: 1,
  lastHeartbeat: new Date(NOW - 10_000).toISOString(),
  ...over,
});

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/executors']}>
        <Routes>
          <Route path="/executors" element={<ExecutorListPage />} />
          <Route path="/executors/:id" element={<div>executor-detail-mock</div>} />
          <Route path="/executors/install" element={<div>install-wizard-mock</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** 提示文案的唯一标识（与详情页同一个 i18n 键，保证「一致的提示」）。 */
const HINT_TEXT = /后端上报的任务计数不一致/;

beforeEach(() => {
  mockedExecutors.list.mockReset();
  mockedExecutors.getGroups.mockReset();
  mockedClient.get.mockReset();
  useAuthStore.setState({ user: { id: 1, username: 'root', role: 'admin' } });
  mockedExecutors.getGroups.mockResolvedValue([]);
  mockedClient.get.mockResolvedValue({ command: 'curl …' } as never);
  localStorage.removeItem('autoflow-ui07-executor-view'); // 默认表格视图
});

afterEach(() => {
  cleanup();
  localStorage.removeItem('autoflow-ui07-executor-view');
});

describe('R62 — 列表页表格视图：运行计数与详情页同口径 + 矛盾提示', () => {
  it('【正向】reserved > occupied ⇒ 显示钳制后的 0，且出现「计数不一致」提示', async () => {
    // R16 抬高了 runningTaskCount 的在途下限，reservedSlots 仍是旧自述值 ⇒ 矛盾态可达。
    mockedExecutors.list.mockResolvedValue([
      makeExecutor({ runningTaskCount: 1, reservedSlots: 5, maxConcurrentTasks: 10 }),
    ]);
    renderPage();
    await screen.findByText('alpha');

    // ① 展示口径与详情页一致：1 − 5 ⇒ 钳到 0（绝不显示负数，也不谎报 1）。
    expect(screen.getByText('0/10任务')).toBeTruthy();
    // ② 核心：矛盾状态对用户可见（此前列表页既不钳制也无提示）。
    expect(screen.getByLabelText(HINT_TEXT)).toBeTruthy();
  });

  it('【反向】合理预留（reserved < occupied）⇒ 显示扣除后的实际在跑数，且不提示', async () => {
    mockedExecutors.list.mockResolvedValue([
      makeExecutor({ runningTaskCount: 10, reservedSlots: 3, maxConcurrentTasks: 10 }),
    ]);
    renderPage();
    await screen.findByText('alpha');

    // 与详情页同一换算：10 − 3 = 7（不是已占槽位 10）。
    expect(screen.getByText('7/10任务')).toBeTruthy();
    expect(screen.queryByLabelText(HINT_TEXT)).toBeNull();
  });

  it('【反向】旧版执行器未上报 reservedSlots ⇒ 回落旧口径，且不提示', async () => {
    mockedExecutors.list.mockResolvedValue([
      makeExecutor({ runningTaskCount: 2, maxConcurrentTasks: 4 }), // 无 reservedSlots 字段
    ]);
    renderPage();
    await screen.findByText('alpha');

    expect(screen.getByText('2/4任务')).toBeTruthy();
    expect(screen.queryByLabelText(HINT_TEXT)).toBeNull();
  });

  it('【反向】边界相等（reserved === occupied）是合法状态 ⇒ 显示 0 但不提示', async () => {
    mockedExecutors.list.mockResolvedValue([
      makeExecutor({ runningTaskCount: 2, reservedSlots: 2, maxConcurrentTasks: 4 }),
    ]);
    renderPage();
    await screen.findByText('alpha');

    expect(screen.getByText('0/4任务')).toBeTruthy();
    expect(screen.queryByLabelText(HINT_TEXT)).toBeNull();
  });
});

describe('R62 — 列表页卡片视图：同一判据、同一提示', () => {
  it('【正向】卡片视图在矛盾计数时同样钳到 0 并给出提示', async () => {
    localStorage.setItem('autoflow-ui07-executor-view', 'card');
    mockedExecutors.list.mockResolvedValue([
      makeExecutor({ runningTaskCount: 1, reservedSlots: 5, maxConcurrentTasks: 10 }),
    ]);
    renderPage();
    await screen.findByText('alpha');

    // 卡片视图渲染的是「{{label}} 任务」形态（execCard.tasks）。
    expect(screen.getByText(/0\/10 任务/)).toBeTruthy();
    expect(screen.getByText(HINT_TEXT)).toBeTruthy();
  });

  it('【反向】卡片视图在合理预留时不提示', async () => {
    localStorage.setItem('autoflow-ui07-executor-view', 'card');
    mockedExecutors.list.mockResolvedValue([
      makeExecutor({ runningTaskCount: 10, reservedSlots: 3, maxConcurrentTasks: 10 }),
    ]);
    renderPage();
    await screen.findByText('alpha');

    expect(screen.getByText(/7\/10 任务/)).toBeTruthy();
    expect(screen.queryByText(HINT_TEXT)).toBeNull();
  });
});
