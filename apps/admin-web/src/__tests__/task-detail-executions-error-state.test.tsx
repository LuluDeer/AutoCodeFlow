/**
 * R151（F3）：任务详情「执行记录」Tab 的**读取失败必须可见且可恢复**。
 *
 * ## 缺陷（F3）
 *
 * `useTaskExecutions` 的 `error` 此前被**丢弃**（页面只解构 `data` / `isLoading`）：
 * `GET /tasks/:id/executions` 失败（500 / 超时 / 网关）时 `execData` 为 undefined
 * ⇒ 执行行数组为空 ⇒ 表格渲染「暂无执行记录」。
 *
 * 「这个任务从没执行过」与「执行记录读不出来」是**两个方向相反的结论**：
 * 前者会让人立刻手动触发一次（页面右上就有「手动触发」）⇒ 多一次真实执行；
 * 后者应当重试或报障。同页 `task` 有整页错误块、`taskStats` 失败时整块不渲染
 * （宁可缺席也不撒谎）——唯独这个查询既无错误分支、又有明确的空态文案。
 *
 * ## 判据
 *
 * ① 读取失败 ⇒ **错误块在场**（复用全站既有 `components/StateError`，判据用它的
 *    `data-testid="state-error"`）+ **不渲染**「暂无执行记录」+ **重试按钮存在**；
 * ② 重试后恢复 ⇒ 数据出现、「暂无执行记录」消失；
 * ③ 真空态（读成功但列表为空）⇒ **仍然**渲染「暂无执行记录」（不得误伤）。
 *
 * ## 为什么 mock `tasksApi.executions` 而不是 mock 整个 hook
 *
 * mock 整个 `useTaskExecutions` 会把「TanStack Query 在 error 后仍保留旧 data、
 * `refetch` 能把它拉回来」这条**真实机制**也一并 stub 掉 ⇒ 用例就退化成
 * 「断言一个我自己的 mock」。这里 mock 的是**数据源**（`tasksApi.executions`），
 * 让真实的 query 生命周期（error → refetch → success）跑起来。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import TaskDetailPage from '../pages/TaskDetailPage';
import { tasksApi } from '../api/tasks';

vi.mock('../api/tasks', () => ({
  tasksApi: {
    webhookStatus: vi.fn().mockResolvedValue({ enabled: false, url: '' }),
    get: vi.fn(),
    executions: vi.fn(),
    stats: vi.fn().mockResolvedValue({ recentExecutions: [], successRate: 0, avgDuration: 0, totalRuns: 0 }),
    schedulerStats: vi.fn().mockResolvedValue({ healthy: true, activeTimers: 0, activeCronTasks: 0, runningTaskCount: 0, totalExecutions: 0, uptime: 0 }),
    pause: vi.fn(),
    resume: vi.fn(),
    delete: vi.fn(),
    trigger: vi.fn(),
    killExecution: vi.fn(),
  },
}));
vi.mock('../api/ai', () => ({ aiApi: { suggestSchedule: vi.fn() } }));
vi.mock('react-router-dom', () => ({
  useNavigate: () => vi.fn(),
  useParams: () => ({ id: 'task-1' }),
  Link: (props: { to: string; children: React.ReactNode }) => <a href={props.to}>{props.children}</a>,
}));
vi.mock('../components/GlueEditor', () => ({ default: () => <div data-testid="glue-editor" /> }));
vi.mock('../components/TaskDependencyGraph', () => ({ default: () => <div data-testid="dep-graph" /> }));
vi.mock('../components/ParamsEditor', () => ({ default: () => <div data-testid="params-editor" /> }));

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

const BASE_TASK = {
  id: 'task-1',
  name: 'timeout-job',
  runtime: 'python',
  entrypoint: 'main.py',
  triggerType: 'cron',
  cronExpression: '*/5 * * * *',
  status: 'active',
  maxRetry: 3,
  timeout: 300,
  params: {},
};

const EXEC_ROW = {
  id: 'exec-1',
  taskId: 'task-1',
  taskName: 'timeout-job',
  status: 'failed',
  triggerType: 'cron',
  executorAddress: '10.0.0.1:3002',
  startTime: '2026-09-07T10:00:00Z',
  duration: 60_000,
  errorMessage: 'exit code 1',
  params: null,
  createdAt: '2026-09-07T10:00:00Z',
};

const renderPage = () =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <TaskDetailPage />
    </QueryClientProvider>,
  );

/** 切到「执行记录」Tab（详情页默认落在「任务配置」）。 */
async function openExecutionsTab() {
  fireEvent.click(await screen.findByRole('tab', { name: /执行记录/ }));
}

beforeEach(() => {
  vi.mocked(tasksApi.get).mockReset().mockResolvedValue({ ...BASE_TASK } as never);
  vi.mocked(tasksApi.executions).mockReset().mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 20 } as never);
  vi.mocked(tasksApi.stats).mockReset().mockResolvedValue({ recentExecutions: [], successRate: 0, avgDuration: 0, totalRuns: 0 } as never);
});

afterEach(() => {
  cleanup();
});

describe('R151/F3：执行记录读取失败 ⇒ 错误块可见 + 可重试（绝不说「暂无执行记录」）', () => {
  it('① 读取失败：错误块在场、无「暂无执行记录」、重试按钮存在', async () => {
    vi.mocked(tasksApi.executions).mockRejectedValue({
      code: 500,
      errorCode: null,
      message: '服务器内部错误',
      params: null,
      __status: 500,
    } as never);

    renderPage();
    await openExecutionsTab();

    // 错误块在场（StateError 是全站既有组件，判据用它的稳定 testid）
    await waitFor(() => expect(screen.getByTestId('state-error')).toBeTruthy());
    expect(screen.getByText('执行记录加载失败')).toBeTruthy();

    // ⚠️ 关键断言：不得出现「暂无执行记录」——读取失败 ≠ 这个任务从没执行过
    expect(screen.queryByText('暂无执行记录')).toBeNull();

    // 重试入口存在（StateError 的 onRetry ⇒ 按钮）
    expect(screen.getByRole('button', { name: /重试/ })).toBeTruthy();
  });

  it('② 重试后恢复：数据出现、「暂无执行记录」消失', async () => {
    // 第一次失败 ⇒ 错误块；第二次成功 ⇒ 数据回来。
    vi.mocked(tasksApi.executions)
      .mockRejectedValueOnce({ code: 500, errorCode: null, message: '服务器内部错误', params: null, __status: 500 } as never)
      .mockResolvedValue({ items: [EXEC_ROW], total: 1, page: 1, pageSize: 20 } as never);

    renderPage();
    await openExecutionsTab();

    await waitFor(() => expect(screen.getByTestId('state-error')).toBeTruthy());

    // 点重试（StateError 的重试按钮）
    fireEvent.click(screen.getByRole('button', { name: /重试/ }));

    // 恢复：执行行出现（错误摘要「exit code 1」是该行的错误列内容）
    await waitFor(() => expect(screen.getByText('exit code 1')).toBeTruthy());
    expect(screen.queryByTestId('state-error')).toBeNull();
    expect(screen.queryByText('暂无执行记录')).toBeNull();
  });

  it('③ 真空态（读成功但列表为空）仍渲染「暂无执行记录」（不得误伤）', async () => {
    vi.mocked(tasksApi.executions).mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 20 } as never);

    renderPage();
    await openExecutionsTab();

    await waitFor(() => expect(screen.getByText('暂无执行记录')).toBeTruthy());
    // 真空态**不是**错误态 ⇒ 不该有错误块
    expect(screen.queryByTestId('state-error')).toBeNull();
  });
});
