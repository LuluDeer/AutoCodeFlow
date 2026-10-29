/**
 * P2-B1：执行详情页的执行器清单请求必须**只发生 1 次**。
 *
 * 缺陷形态：`useExecutorNames` 的自拉路径是 useEffect + 裸
 * `executorsApi.list()`，完全绕过 TanStack Query 缓存。同一个执行详情页里
 * 有两个调用方——常驻的 `ExecutionInfoCard`（信息卡「执行器」字段）与
 * 「重试链」Tab 里的 `ExecutionRetryChain`（每行解析执行器名）——于是用户
 * 打开重试链 Tab 时，全量清单被**再拉一次**（执行器清单是全列大对象）。
 *
 * 判据：修好后两个调用方共用 `queryKeys.executors.list` 这一份缓存/同一个
 * in-flight 请求，请求次数恒为 1。改动前这条断言会红（2 次）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { tasksApi } from '../api/tasks';
import { executorsApi } from '../api/executors';
import ExecutionDetailPage from '../pages/ExecutionDetailPage';

vi.mock('../api/tasks', () => ({
  tasksApi: {
    execution: vi.fn(),
    executionLogs: vi.fn(),
    killExecution: vi.fn(),
    trigger: vi.fn(),
    analyzeExecution: vi.fn(),
    get: vi.fn(),
    executions: vi.fn(),
  },
}));

vi.mock('../api/artifacts', () => ({
  artifactsApi: { listArtifacts: vi.fn(), downloadArtifact: vi.fn() },
}));

vi.mock('../api/execution-reports', () => ({
  executionReportsApi: { report: vi.fn() },
}));

const g = globalThis as Record<string, unknown>;
if (!g.ResizeObserver) {
  g.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(tasksApi.execution).mockResolvedValue({
    id: 'e1',
    taskId: 't1',
    taskName: '每日对账',
    status: 'success',
    triggerType: 'manual',
    // 信息卡与重试链都要解析同一个执行器 → 两个调用方
    executorId: 'exec-1',
    executorAddress: '192.168.4.54:8003',
    logs: 'ok',
    retryCount: 0,
    createdAt: new Date().toISOString(),
  } as never);
  vi.mocked(tasksApi.get).mockResolvedValue({
    id: 't1',
    maxRetry: 0,
    params: {},
  } as never);
  // 重试链兄弟执行列表：一条（当前执行本身）→ 重试链 Tab 有可渲染的行
  vi.mocked(tasksApi.executions).mockResolvedValue({
    items: [{ id: 'e1', retryCount: 0, status: 'success' }],
    total: 1,
    page: 1,
    pageSize: 100,
  } as never);
  vi.mocked(tasksApi.executionLogs).mockResolvedValue({ lines: [], hasMore: false } as never);
  // 执行器清单：用 spy 计数（真实实现会打网络，且我们只关心"发几次"）
  vi.spyOn(executorsApi, 'list').mockResolvedValue([
    { id: 'exec-1', appName: '财务部-主力机', address: '192.168.4.54:8003' },
  ] as never);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function renderPage() {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={['/tasks/t1/executions/e1']}>
        <Routes>
          <Route path="/tasks/:taskId/executions/:execId" element={<ExecutionDetailPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('执行详情页执行器清单请求收敛（P2-B1）', () => {
  it('信息卡 + 重试链两个调用方合计只拉 1 次执行器清单', async () => {
    const list = vi.mocked(executorsApi.list);
    renderPage();

    // ① 信息卡挂载 → 触发清单请求（第一次，也是唯一一次）
    await screen.findByText('执行信息');
    await waitFor(() => expect(list.mock.calls.length).toBe(1));
    // 名字解析确实用了这份清单（不是"没请求所以 1 次"的假绿）
    await waitFor(() => expect(screen.getAllByText(/财务部-主力机/).length).toBeGreaterThan(0));

    // ② 切到「重试链」Tab → ExecutionRetryChain 挂载 = 第二个 useExecutorNames 调用方
    fireEvent.click(screen.getByTestId('tab-label-retry'));
    await screen.findByTestId('retry-chain-item');

    // ③ 断言：请求次数仍然只有 1。改动前（裸 fetch 绕过 Query 缓存）这里是 2。
    expect(list.mock.calls.length).toBe(1);
  });
});
