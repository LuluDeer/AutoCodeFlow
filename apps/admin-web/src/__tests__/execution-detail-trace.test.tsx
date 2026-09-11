/**
 * OBS-01: 执行详情页 traceId 展示。
 * admin-api OTEL_ENABLED=true 时 task_executions.traceId 落库，详情页信息卡
 * 在 traceId 有值时展示追踪标识 + 「复制 traceId」按钮；null（默认关闭/旧
 * 数据）时不渲染该行（零噪音）。Jaeger/Tempo 跳转链接留配置项——collector
 * 未部署，不硬编码 URL（计划纪律）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

// 隔离 api 层（对齐 execution-detail-sse.test 先例）。
vi.mock('../api/tasks', () => ({
  tasksApi: {
    execution: vi.fn(),
    killExecution: vi.fn(),
    trigger: vi.fn(),
    analyzeExecution: vi.fn(),
    get: vi.fn(),
    executionsWithStatus: vi.fn(),
  },
}));
vi.mock('../api/execution-reports', () => ({
  executionReportsApi: {
    report: vi.fn().mockResolvedValue({ execution: {}, timeline: [], report: null }),
  },
}));
vi.mock('../api/metrics', () => ({ metricsApi: {} }));

// jsdom 缺失 antd 依赖的浏览器 API（对齐既有先例）。
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

const TRACE_ID = '4bf92f3577b34da6a3ce929d0e0e4736';

const { tasksApi } = await import('../api/tasks');

function makeExecution(overrides: Record<string, unknown> = {}) {
  return {
    id: 'e1',
    taskId: 't1',
    taskName: 'nightly',
    status: 'success',
    triggerType: 'manual',
    retryCount: 0,
    createdAt: new Date().toISOString(),
    ...overrides,
  } as never;
}

async function renderPage(execution: Record<string, unknown>) {
  vi.mocked(tasksApi.execution).mockResolvedValue(execution as never);
  vi.mocked(tasksApi.get).mockResolvedValue({ id: 't1', maxRetry: 3, retryDelay: 5 } as never);
  vi.mocked(tasksApi.executionsWithStatus).mockResolvedValue({
    items: [{ id: 'e1', retryCount: 0, status: 'success' }], total: 1, page: 1, pageSize: 100,
  } as never);
  const { useAuthStore } = await import('../store/auth');
  useAuthStore.getState().setAuth('tok-123', 'refresh-1', { id: 1, username: 'admin' });
  const { default: ExecutionDetailPage } = await import('../pages/ExecutionDetailPage');
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={['/tasks/t1/executions/e1']}>
      <Routes>
        <Route path="/tasks/:taskId/executions/:execId" element={<ExecutionDetailPage />} />
      </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  await vi.waitFor(() => expect(screen.getAllByText('nightly').length).toBeGreaterThan(0));
}

describe('OBS-01: 执行详情页 traceId 展示', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => {
    cleanup();
    localStorage.clear();
  });

  it('traceId 有值时展示追踪标识行', { timeout: 20000 }, async () => {
    await renderPage(makeExecution({ traceId: TRACE_ID }));
    expect(screen.getByTestId('execution-trace-id').textContent).toBe(TRACE_ID);
  });

  it('traceId 为 null（默认关闭/旧数据）时不渲染追踪行', { timeout: 20000 }, async () => {
    await renderPage(makeExecution({ traceId: null }));
    expect(screen.queryByTestId('execution-trace-id')).toBeNull();
  });

  it('复制按钮写入剪贴板并提示成功', { timeout: 20000 }, async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    await renderPage(makeExecution({ traceId: TRACE_ID }));
    fireEvent.click(screen.getByTestId('copy-trace-id'));
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith(TRACE_ID));
  });

  it('复制失败（剪贴板 reject）不抛未处理异常', { timeout: 20000 }, async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('denied'));
    Object.assign(navigator, { clipboard: { writeText } });
    await renderPage(makeExecution({ traceId: TRACE_ID }));
    fireEvent.click(screen.getByTestId('copy-trace-id'));
    await vi.waitFor(() => expect(writeText).toHaveBeenCalled());
  });
});
