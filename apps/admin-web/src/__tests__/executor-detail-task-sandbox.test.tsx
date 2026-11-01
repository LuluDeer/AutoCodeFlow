/**
 * S4-C4（沙箱姿态在控制面可见，协议 v9）：详情页的**三态**渲染。
 *
 * ## 为什么这个测试是本项的核心
 *
 * 缺陷原本是：「某台执行器到底在不在 fail-closed 沙箱里」只能 SSH 上机看环境
 * 变量——于是「默认关」是运维的**显式取舍**还是**疏忽**在控制面上不可区分。
 * 修法把姿态送上心跳（协议 v9 的 `taskSandbox: '' | 'bwrap'`）并落库
 * （迁移 1790000000088）。
 *
 * 但上报本身不解决问题：读面若把三态**塌成两态**（例如把 null 当成直跑，或
 * 把 '' 当成未上报），运维看到的仍是一条无法区分「不知道」与「确认没开」的
 * 展示——等于退回原状。本文件逐态钉住 UI 文案：
 *
 * | 载荷 | 期望文案 | 语义 |
 * |---|---|---|
 * | `null`（旧执行器） | 未上报（**不显示**「直跑」） | 不知道 |
 * | `''`            | 直跑（未沙箱） + 生产提示 | 已确认未开 |
 * | `'bwrap'`       | 沙箱（bwrap） | 已确认开着 |
 *
 * 反证方向同样重要：`null` 用例显式断言**不出现**「直跑（未沙箱）」——那是
 * 本项唯一的失败模式（把「不知道」伪装成「确认没开」，会让人得出假的安全结论）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, within } from '@testing-library/react';
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

const executorBase = {
  id: 'executor-sbx',
  appName: 'SBX-01',
  address: '10.0.0.9:3002',
  status: 'online',
  cpuUsage: 3.2,
  memUsage: 21.5,
  runningTaskCount: 0,
  maxConcurrentTasks: 4,
  lastHeartbeat: new Date().toISOString(),
};

const metricsFixture = {
  executor: { id: 'executor-sbx', address: '10.0.0.9:3002', status: 'online' },
  sevenDayStats: { totalExecutions: 0, successful: 0, failed: 0, successRate: 0, averageDurationMs: 0 },
  current: { runningTaskCount: 0 },
  history: [],
};

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/executors/executor-sbx']}>
        <Routes>
          <Route path="/executors/:id" element={<ExecutorDetailPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/**
 * 「任务沙箱」那一行的内容单元格。
 *
 * 页面上的「未上报」同时出现在运行中执行列表 / 死信 / 解释器池三行，全局
 * `getByText('未上报')` 会撞上它们——必须按**标签**定位到本行，否则断言会
 * 见证别的字段（首版既踩此坑）。
 */
const sandboxCell = (): HTMLElement => {
  const label = Array.from(
    document.querySelectorAll('.ant-descriptions-item-label'),
  ).find((el) => (el.textContent ?? '').includes('任务沙箱')) as HTMLElement | undefined;
  expect(label, '详情页应渲染「任务沙箱」一行').toBeDefined();
  const row = label!.closest('tr') as HTMLElement | null;
  const cell = (row?.querySelector('.ant-descriptions-item-content') ??
    label!.parentElement?.querySelector('.ant-descriptions-item-content')) as HTMLElement | null;
  expect(cell, '任务沙箱行应有内容单元格').toBeTruthy();
  return cell!;
};

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
  useAuthStore.setState({ user: { id: 1, username: 'root', role: 'admin' } });
  mockedApi.getMetrics.mockResolvedValue({ ...metricsFixture } as never);
  mockedApi.getExecutions.mockResolvedValue({ total: 0, items: [] } as never);
});

afterEach(() => {
  cleanup();
});

describe('S4-C4：执行器详情页的沙箱姿态三态', () => {
  it("taskSandbox='bwrap' ⇒ 显示「沙箱（bwrap）」，不显示直跑/未上报", async () => {
    mockedApi.get.mockResolvedValue({ ...executorBase, taskSandbox: 'bwrap' } as never);

    renderPage();
    await screen.findAllByText('SBX-01');

    const cell = sandboxCell();
    expect(within(cell).getByText('沙箱（bwrap）')).toBeTruthy();
    expect(within(cell).queryByText('直跑（未沙箱）')).toBeNull();
    expect(within(cell).queryByText('未上报')).toBeNull();
  });

  it("taskSandbox='' ⇒ 显示「直跑（未沙箱）」并给出显式提示（不是告警）", async () => {
    mockedApi.get.mockResolvedValue({ ...executorBase, taskSandbox: '' } as never);

    renderPage();
    await screen.findAllByText('SBX-01');

    const cell = sandboxCell();
    expect(within(cell).getByText('直跑（未沙箱）')).toBeTruthy();
    // 「生产且未开沙箱」的显式提示：文案存在，但不是告警（无 Alert 角色、
    // 无 warning 图标——这里是文案层断言，样式层由「非 error/warning 类」
    // 的既有惯例保证：本行只用了 Tag 默认色 + Text secondary）。
    expect(within(cell).getByText(/生产环境请确认这是显式取舍/)).toBeTruthy();
    expect(within(cell).queryByText('沙箱（bwrap）')).toBeNull();
    expect(within(cell).queryByText('未上报')).toBeNull();
  });

  it('taskSandbox=null（旧执行器未上报）⇒ 显示「未上报」，**绝不**显示成「直跑」', async () => {
    mockedApi.get.mockResolvedValue({ ...executorBase, taskSandbox: null } as never);

    renderPage();
    await screen.findAllByText('SBX-01');

    const cell = sandboxCell();
    expect(within(cell).getByText('未上报')).toBeTruthy();
    // 本项唯一的失败模式：把「不知道」伪装成「确认没开」。这条反证必须红
    // 在它发生的那一刻。
    expect(within(cell).queryByText('直跑（未沙箱）')).toBeNull();
    expect(within(cell).queryByText('沙箱（bwrap）')).toBeNull();
  });

  it('字段整个缺失（更旧的响应，无该键）⇒ 同样显示「未上报」，不退化成直跑', async () => {
    // null 与「键缺失」在协议层是同一形态（都没上报）；前端把两者一并按
    // 未上报渲染，且**不**用 `executor.taskSandbox || '...'` 这类写法把空串
    // 与缺失混为一谈（那是本项最容易犯的实现错误）。
    mockedApi.get.mockResolvedValue({ ...executorBase } as never);

    renderPage();
    await screen.findAllByText('SBX-01');

    const cell = sandboxCell();
    expect(within(cell).getByText('未上报')).toBeTruthy();
    expect(within(cell).queryByText('直跑（未沙箱）')).toBeNull();
  });
});
