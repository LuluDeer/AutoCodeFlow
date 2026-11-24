/**
 * AI 分析按钮的成功落点：分析完成后切到「时间线·报告」Tab，
 * 让刚落库的分析结果直接进入视野；未触发按钮时默认视图保持日志。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { tasksApi } from '../api/tasks';
import { artifactsApi } from '../api/artifacts';
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
  artifactsApi: {
    listArtifacts: vi.fn(),
    downloadArtifact: vi.fn(),
  },
}));

vi.mock('../api/execution-reports', () => ({
  executionReportsApi: {
    report: vi.fn().mockResolvedValue({ execution: {}, timeline: [], report: null }),
  },
}));

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

const AI_TEXT = '根因：脚本第 12 行抛出 ZeroDivisionError。';
const BASE_EXECUTION = {
  id: 'e1',
  taskId: 't1',
  taskName: 'nightly',
  status: 'failed',
  triggerType: 'manual',
  logs: 'line-1\nline-2 with keyword',
  failureReason: 'script_error',
  createdAt: new Date().toISOString(),
};
let analysisReady = false;

function LocationProbe() {
  const loc = useLocation();
  return <span data-testid="loc-probe">{loc.search}</span>;
}

function tabParam(): string | null {
  return new URLSearchParams(screen.getByTestId('loc-probe').textContent ?? '').get('tab');
}

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/tasks/t1/executions/e1']}>
        <LocationProbe />
        <Routes>
          <Route path="/tasks/:taskId/executions/:execId" element={<ExecutionDetailPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  analysisReady = false;
  vi.mocked(tasksApi.execution).mockReset().mockImplementation(async () => ({
    ...BASE_EXECUTION,
    ...(analysisReady ? { aiAnalysis: AI_TEXT } : {}),
  } as never));
  vi.mocked(tasksApi.executionLogs).mockReset();
  vi.mocked(tasksApi.get).mockReset().mockResolvedValue({
    id: 't1', maxRetry: 3, retryDelay: 5, params: {},
  } as never);
  vi.mocked(tasksApi.executions).mockReset().mockResolvedValue({
    items: [{ id: 'e1', retryCount: 0, status: 'failed' }], total: 1, page: 1, pageSize: 100,
  } as never);
  vi.mocked(tasksApi.analyzeExecution).mockReset();
  vi.mocked(artifactsApi.listArtifacts).mockReset().mockResolvedValue([]);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('AI 分析成功后的视野落点', () => {
  it('点按钮：分析完成后切到 report，分析结果可见', async () => {
    vi.mocked(tasksApi.analyzeExecution).mockImplementation(async () => {
      analysisReady = true;
      return { ...BASE_EXECUTION, aiAnalysis: AI_TEXT } as never;
    });

    renderPage();
    await screen.findByText(/line-2 with keyword/);
    fireEvent.click(screen.getByRole('button', { name: /^robot AI 分析$/ }));

    await vi.waitFor(() => expect(tabParam()).toBe('report'));
    await vi.waitFor(() => expect(document.body.textContent).toContain(AI_TEXT));
    expect(tasksApi.analyzeExecution).toHaveBeenCalledWith('t1', 'e1');
    expect(screen.getByTestId('execution-report-panel')).toBeTruthy();
  });

  it('控制组：未点按钮时 Tab 保持 logs，分析结果不提前出现', async () => {
    renderPage();
    await screen.findByText(/line-2 with keyword/);
    expect(tabParam()).toBeNull();
    expect(screen.queryByTestId('execution-report-panel')).toBeNull();
    expect(document.body.textContent).not.toContain(AI_TEXT);
  });
});
