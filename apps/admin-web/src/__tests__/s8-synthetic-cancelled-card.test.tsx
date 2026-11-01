/**
 * S8（迁移 1790000000091）：**排障卡把合成行误解释成「被 COVER_EARLY 覆盖」**——
 * 这条用例钉住**接线**（不只是纯函数）。
 *
 * 纯函数层（`failureRunbookAction` 的第 4 参）见
 * `s8-synthetic-cancelled-runbook.test.ts`；但纯函数对了**不等于**UI 对了——
 * 上一次这类缺陷的形态恰恰是「分支写了，没人传参，永远走不到」。
 * 本文件从**页面**往下打：mock 一条 `status='cancelled' & synthetic=true` 的执行，
 * 断言失败定位卡片里出现的是「去查上游任务」那条文案，且**不出现**
 * COVER_EARLY 那条（「阻断策略」/「COVER_EARLY」）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
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

// jsdom 缺失 antd 依赖的浏览器 API（对齐既有 execution-detail-ui05 测试先例）。
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

const LOGS = 'line-1\nline-2 with keyword\nplain';

function mockExecution(overrides: Record<string, unknown> = {}) {
  vi.mocked(tasksApi.execution).mockReset().mockResolvedValue({
    id: 'e1',
    taskId: 't1',
    taskName: 'downstream',
    status: 'cancelled',
    triggerType: 'dependency',
    logs: LOGS,
    failureReason: null,
    createdAt: new Date().toISOString(),
    ...overrides,
  } as never);
  vi.mocked(tasksApi.get).mockReset().mockResolvedValue({
    id: 't1',
    maxRetry: 3,
    retryDelay: 5,
    params: {},
  } as never);
  vi.mocked(tasksApi.executions).mockReset().mockResolvedValue({
    items: [],
    total: 0,
    page: 1,
    pageSize: 100,
  } as never);
  vi.mocked(tasksApi.executionLogs).mockReset();
}

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[`/tasks/t1/executions/e1`]}>
        <Routes>
          <Route
            path="/tasks/:taskId/executions/:execId"
            element={<ExecutionDetailPage />}
          />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('S8 · 排障卡：合成 cancelled 行 ⇒ 指向「上游失败」，不是 COVER_EARLY', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => {
    cleanup();
  });

  it('synthetic=true 的 cancelled 行：卡片给出「去查上游任务」文案', async () => {
    mockExecution({ status: 'cancelled', synthetic: true });
    renderPage();

    const card = await screen.findByTestId('failure-triage-card');
    const text = card.textContent ?? '';
    // 合成文案要点：从未真正运行 + 指向上游 + 显式否掉 COVER_EARLY
    expect(text).toContain('从未真正运行');
    expect(text).toContain('上游');
    expect(text).toContain('不是 COVER_EARLY 覆盖');
    // 不得出现 COVER_EARLY 那条文案的特征句（运维会被引去改 blockStrategy）
    expect(text).not.toContain('阻断策略改为「排队等待」');
  });

  it('回归锁：synthetic=false 的 cancelled 行：仍是 COVER_EARLY 那条文案', async () => {
    mockExecution({ status: 'cancelled', synthetic: false });
    renderPage();

    const card = await screen.findByTestId('failure-triage-card');
    const text = card.textContent ?? '';
    expect(text).toContain('COVER_EARLY');
    expect(text).not.toContain('从未真正运行');
  });
});
