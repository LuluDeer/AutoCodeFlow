import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { readFileSync } from 'node:fs';
import { tasksApi } from '../api/tasks';
import ExecutionDetailPage from '../pages/ExecutionDetailPage';

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

const LONG_TASK_NAME = 'TaskName_0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz_0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(tasksApi.execution).mockResolvedValue({
    id: 'e1',
    taskId: 't1',
    taskName: LONG_TASK_NAME,
    status: 'success',
    triggerType: 'manual',
    logs: 'ok',
    createdAt: new Date().toISOString(),
  } as never);
  vi.mocked(tasksApi.get).mockResolvedValue({
    id: 't1',
    maxRetry: 0,
    params: {},
  } as never);
  vi.mocked(tasksApi.executionsWithStatus).mockResolvedValue({
    items: [{ id: 'e1', retryCount: 0, status: 'success' }],
    total: 1,
    page: 1,
    pageSize: 100,
  } as never);
  vi.mocked(tasksApi.executionLogs).mockResolvedValue({ lines: [], hasMore: false } as never);
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

describe('UI-09 PageHeader description 长任务名收缩产物', () => {
  it('description 内容带窄屏收缩/换行类并保留 taskName 全文 title', async () => {
    renderPage();
    await screen.findByText('执行信息');

    await waitFor(() => {
      expect(document.querySelector('.ui09-pageheader-description')).toBeTruthy();
    });
    const description = document.querySelector('.ui09-pageheader-description');
    expect(description?.classList.contains('ui09-pageheader-description')).toBe(true);
    expect(description?.textContent).toBe(LONG_TASK_NAME);
    expect(description?.getAttribute('title')).toBe(LONG_TASK_NAME);
  });

  it('index.css 为页头描述提供作用域规则与不可断字符换行', () => {
    const css = readFileSync('src/index.css', 'utf-8');
    expect(css).toContain('.ui09-exec-detail .ui09-pageheader-description');
    expect(css).toMatch(/\.ui09-exec-detail \.ui09-pageheader-description[\s\S]*?overflow-wrap:\s*anywhere/);
    expect(css).toMatch(/\.ui09-exec-detail \.ui09-pageheader-description[\s\S]*?word-break:\s*break-word/);
  });
});
