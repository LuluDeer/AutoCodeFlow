/**
 * NETOPT-7② 反证回归：完整日志跨执行串页。
 *
 * 场景（复验记录）：重试链 Tab 的兄弟执行 Link（同路由 :execId，组件不重挂）
 * 切执行时 U2 effect 先重置 fullLogs=null；旧执行"加载完整日志"的分页拉取
 * （最多 LOG_MAX_PAGES 页 × 顺序请求）晚到 resolve → setFullLogs(旧日志) →
 * 新执行详情显示旧日志，复制/下载（所见即所得）连带串页。
 *
 * 修法：fullLogsFetchSeq 守卫（切执行的 U2 重置 effect 自增序号使在途请求
 * 失效；成功/catch/finally 落地前先比对再 setState）。
 *
 * 手法：手动可控的 executionLogs mock（deferred promise）+ useNavigate 探针
 * 程序化导航（等价于点击兄弟执行 Link：同一路由组件实例，不重挂）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router-dom';
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

// 隔离 report 端点（useExecutionReport），避免测试环境真实外发请求。
vi.mock('../api/execution-reports', () => ({
  executionReportsApi: { report: vi.fn().mockResolvedValue(null) },
}));

// jsdom 缺失 antd 依赖的浏览器 API（对齐 execution-detail-log-level.test 先例）。
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

const E1_LOGS = 'exec1 tail line\n... [logs truncated, original length 99999 chars] ...';
const E2_LOGS = 'exec2 own log line A\nexec2 own log line B';
// 旧执行"加载完整日志"分页拉到的行（晚到后不得出现在 e2 视图）
const E1_FULL_LINE = 'EXEC1-LATE-FULL-LOG-LINE';

function makeExec(execId: string) {
  return {
    id: execId,
    taskId: 't1',
    taskName: 'nightly',
    status: 'failed',
    triggerType: 'manual',
    logs: execId === 'e1' ? E1_LOGS : E2_LOGS,
    createdAt: new Date().toISOString(),
  } as never;
}

/** useNavigate 探针：程序化导航等价点击兄弟执行 Link（同路由组件不重挂） */
let navigateTo: (to: string) => void = () => {};
function NavigateProbe() {
  const nav = useNavigate();
  navigateTo = nav;
  return null;
}

function renderPage() {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={['/tasks/t1/executions/e1']}>
        <NavigateProbe />
        <Routes>
          <Route path="/tasks/:taskId/executions/:execId" element={<ExecutionDetailPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function getLogPre(): HTMLElement {
  const pre = document.querySelector('[data-testid="log-pre"]');
  if (!pre) throw new Error('日志 pre 未渲染');
  return pre;
}

beforeEach(() => {
  vi.mocked(tasksApi.get).mockResolvedValue({ id: 't1', maxRetry: 3, retryDelay: 5 } as never);
  vi.mocked(tasksApi.executions).mockResolvedValue({
    items: [], total: 0, page: 1, pageSize: 100,
  } as never);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('ExecutionDetailPage 完整日志跨执行竞态（NETOPT-7②）', () => {
  it('旧执行的完整日志响应晚到，不得覆盖新执行的日志视图', async () => {
    vi.mocked(tasksApi.execution).mockImplementation(async (_taskId, execId) => makeExec(execId));
    // e1 的完整日志分页响应：手动控制落地时机（deferred）
    let resolveE1Logs!: (value: { lines: string[]; totalLines: number; hasMore: boolean }) => void;
    const e1Deferred = new Promise<{ lines: string[]; totalLines: number; hasMore: boolean }>((resolve) => {
      resolveE1Logs = resolve;
    });
    vi.mocked(tasksApi.executionLogs).mockImplementation(async (_taskId, execId) => {
      if (execId === 'e1') return e1Deferred as never;
      throw new Error(`unexpected executionLogs call for ${execId}`);
    });

    renderPage();
    // e1 详情到达，截断标记触发"加载完整日志"按钮
    await screen.findByText(/truncated/i);
    expect(getLogPre().textContent).toBe(E1_LOGS);

    // 点击"加载完整日志"→ e1 的分页拉取挂起（未 resolve）
    fireEvent.click(screen.getByRole('button', { name: /加载完整日志/ }));

    // 切到 e2（同路由组件不重挂，U2 effect 重置 fullLogs）
    await act(async () => {
      navigateTo('/tasks/t1/executions/e2');
    });
    await screen.findByText(/exec2 own log line A/);

    // 旧执行的完整日志响应晚到 resolve
    await act(async () => {
      resolveE1Logs({ lines: [E1_FULL_LINE], totalLines: 1, hasMore: false });
    });

    // 反证断言：日志区必须是 e2 的内容，e1 的晚到行不得串页
    expect(getLogPre().textContent).toBe(E2_LOGS);
    expect(getLogPre().textContent).not.toContain(E1_FULL_LINE);
    // executionLogs 只在 e1 上被调用过一次（分页拉取未在 e2 上误发）
    expect(tasksApi.executionLogs).toHaveBeenCalledTimes(1);
    expect(tasksApi.executionLogs).toHaveBeenCalledWith('t1', 'e1', { fromLine: 0, limit: 2000 });
  });
});
