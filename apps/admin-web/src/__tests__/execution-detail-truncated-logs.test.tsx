/**
 * U2 回归：执行详情截断日志兜底。
 * 后端（admin-api task.service.ts）不返回 truncated 标志，截断以标记文本嵌入
 * 日志（Node "[logs truncated, ...]" / Python "[truncated, total N chars]"）。
 * 前端检测到标记 → 显示"日志已截断"提示 + "加载完整日志"按钮：
 * 点击后按 fromLine/limit(2000) 分页调 GET /tasks/:id/executions/:execId/logs
 * 拉全并替换显示；失败 toast 且保留原截断内容。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { tasksApi } from '../api/tasks';
import ExecutionDetailPage from '../pages/ExecutionDetailPage';

// 隔离 api 层：只关心 execution / executionLogs 两个调用契约。
// CORE-02: 详情页新增消费 get / executionsWithStatus——mock 补齐防 TypeError。
vi.mock('../api/tasks', () => ({
  tasksApi: {
    execution: vi.fn(),
    executionLogs: vi.fn(),
    killExecution: vi.fn(),
    trigger: vi.fn(),
    analyzeExecution: vi.fn(),
    get: vi.fn(),
    executionsWithStatus: vi.fn(),
  },
}));

// jsdom 缺失 antd 依赖的浏览器 API（对齐 execution-detail-sse.test 先例）。
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

const TRUNCATED_LOGS = [
  'line-1',
  'line-2',
  '...[truncated, total 50000 chars]...',
  'tail-line',
].join('\n');

function mockExecution(logs: string) {
  vi.mocked(tasksApi.execution).mockReset().mockResolvedValue({
    id: 'e1',
    taskId: 't1',
    taskName: 'nightly',
    status: 'failed',
    triggerType: 'manual',
    logs,
    createdAt: new Date().toISOString(),
  } as never);
  // CORE-02: 详情页新增消费——本套件不关注，空实现即可。
  vi.mocked(tasksApi.get).mockReset().mockResolvedValue({
    id: 't1', maxRetry: 3, retryDelay: 5,
  } as never);
  vi.mocked(tasksApi.executionsWithStatus).mockReset().mockResolvedValue({
    items: [{ id: 'e1', retryCount: 0, status: 'failed' }], total: 1, page: 1, pageSize: 100,
  } as never);
}

beforeEach(() => {
  vi.mocked(tasksApi.executionLogs).mockReset();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('ExecutionDetailPage 截断日志兜底（U2）', () => {
  it('截断标记出现时渲染"日志已截断"提示与"加载完整日志"按钮', async () => {
    mockExecution(TRUNCATED_LOGS);
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <MemoryRouter initialEntries={['/tasks/t1/executions/e1']}>
        <Routes>
          <Route path="/tasks/:taskId/executions/:execId" element={<ExecutionDetailPage />} />
        </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
  );
    expect(await screen.findByText(/日志已截断/)).toBeTruthy();
    expect(screen.getByRole('button', { name: /加载完整日志/ })).toBeTruthy();
  });

  it('无截断标记时不渲染提示与按钮', async () => {
    mockExecution('line-1\nline-2\n正常结束');
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <MemoryRouter initialEntries={['/tasks/t1/executions/e1']}>
        <Routes>
          <Route path="/tasks/:taskId/executions/:execId" element={<ExecutionDetailPage />} />
        </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
  );
    await screen.findByText(/正常结束/);
    expect(screen.queryByText(/日志已截断/)).toBeNull();
    expect(screen.queryByRole('button', { name: /加载完整日志/ })).toBeNull();
  });

  it('点击"加载完整日志"：分页拉全并替换日志显示', async () => {
    mockExecution(TRUNCATED_LOGS);
    vi.mocked(tasksApi.executionLogs)
      .mockResolvedValueOnce({ lines: ['full-a', 'full-b'], totalLines: 3, hasMore: true } as never)
      .mockResolvedValueOnce({ lines: ['full-c'], totalLines: 3, hasMore: false } as never);
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <MemoryRouter initialEntries={['/tasks/t1/executions/e1']}>
        <Routes>
          <Route path="/tasks/:taskId/executions/:execId" element={<ExecutionDetailPage />} />
        </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
  );
    fireEvent.click(await screen.findByRole('button', { name: /加载完整日志/ }));

    await vi.waitFor(() => {
      const pre = document.querySelector('pre');
      expect(pre?.textContent).toBe('full-a\nfull-b\nfull-c');
    });
    // 分页契约：第一页 fromLine=0，第二页按已收行数推进
    expect(tasksApi.executionLogs).toHaveBeenNthCalledWith(1, 't1', 'e1', { fromLine: 0, limit: 2000 });
    expect(tasksApi.executionLogs).toHaveBeenNthCalledWith(2, 't1', 'e1', { fromLine: 2, limit: 2000 });
    // 替换后截断提示与按钮消失
    expect(screen.queryByText(/日志已截断/)).toBeNull();
    expect(screen.queryByRole('button', { name: /加载完整日志/ })).toBeNull();
  });

  it('全量端点失败：toast 报错且保留原截断内容', async () => {
    mockExecution(TRUNCATED_LOGS);
    vi.mocked(tasksApi.executionLogs).mockRejectedValueOnce(new Error('executor unreachable'));
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <MemoryRouter initialEntries={['/tasks/t1/executions/e1']}>
        <Routes>
          <Route path="/tasks/:taskId/executions/:execId" element={<ExecutionDetailPage />} />
        </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
  );
    fireEvent.click(await screen.findByRole('button', { name: /加载完整日志/ }));

    expect(await screen.findByText(/executor unreachable/)).toBeTruthy();
    // 原截断日志保持展示，按钮仍在可重试
    const pre = document.querySelector('pre');
    expect(pre?.textContent).toContain('[truncated, total 50000 chars]');
    expect(screen.getByRole('button', { name: /加载完整日志/ })).toBeTruthy();
  });
});
