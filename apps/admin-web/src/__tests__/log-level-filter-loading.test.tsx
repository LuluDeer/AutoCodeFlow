/**
 * P2（audit-web-code）回归：日志级别过滤 loading 状态不复位竞态。
 *
 * 竞态链（旧实现）：
 *   选 ERROR → seq=N、setLoadingFilteredLogs(true)、分页请求挂起；
 *   立刻切 ALL  → seq=N+1，ALL 分支清数据后直接 return，不碰 loading；
 *   旧请求 finally 因 levelFetchSeq.current(N+1) !== seq(N) 跳过复位；
 *   ⇒ ExecutionLogToolbar 的 Select 永久 loading + disabled，用户必须再选一次
 *   具体级别才解除（交互态缺口，数据落地守卫本身是正确的）。
 *
 * 手法：deferred Promise 卡住 ERROR 请求 → 捕获 Toolbar 的 onChange 程序化切 ALL
 * （Select 一旦 disabled 就无法再用鼠标点击，故直接驱动 onChange 这一个入口）
 * → 放行旧请求 → 断言 Select 恢复可交互（能重新展开 5 个选项）且无 disabled 标记。
 * 在旧实现上本用例转红；修复后转绿。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { ExecutionLogToolbarProps } from '../components/ExecutionLogToolbar';
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

vi.mock('../api/execution-reports', () => ({
  executionReportsApi: { report: vi.fn().mockResolvedValue(null) },
}));

/** 捕获真实 Toolbar 收到的 onChange；渲染仍交给原组件，DOM 断言针对真实 Select。 */
let changeLevelFilter: ExecutionLogToolbarProps['onLevelFilterChange'] | null = null;
vi.mock('../components/ExecutionLogToolbar', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../components/ExecutionLogToolbar')>();
  return {
    ...actual,
    default: (props: ExecutionLogToolbarProps) => {
      changeLevelFilter = props.onLevelFilterChange;
      return <actual.default {...props} />;
    },
  };
});

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

const LOGS = [
  '2026-09-06 10:00:00 [INFO] start',
  '2026-09-06 10:00:01 [ERROR] boom',
  'plain line',
].join('\n');

function mockExecution() {
  vi.mocked(tasksApi.execution).mockResolvedValue({
    id: 'e1',
    taskId: 't1',
    taskName: 'nightly',
    status: 'failed',
    triggerType: 'manual',
    logs: LOGS,
    createdAt: new Date().toISOString(),
  } as never);
  vi.mocked(tasksApi.get).mockResolvedValue({ id: 't1', maxRetry: 3, retryDelay: 5 } as never);
  vi.mocked(tasksApi.executions).mockResolvedValue({
    items: [{ id: 'e1', retryCount: 0, status: 'failed' }], total: 1, page: 1, pageSize: 100,
  } as never);
}

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

function getLevelSelect(): HTMLElement {
  const select = document.querySelector<HTMLElement>('.ant-select');
  if (!select) throw new Error('级别过滤 Select 未渲染');
  return select;
}

function getPre(): HTMLElement {
  const pre = document.querySelector<HTMLElement>('pre');
  if (!pre) throw new Error('日志 pre 未渲染');
  return pre;
}

beforeEach(() => {
  changeLevelFilter = null;
  vi.mocked(tasksApi.executionLogs).mockReset();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('ExecutionLogSection 级别过滤 loading 归属（P2）', () => {
  it('ERROR 请求在途时切回 ALL：旧请求晚到后 Select 不得永久 loading/disabled', async () => {
    mockExecution();
    // 受控 deferred：卡住 ERROR 的分页请求，让 ALL 能在请求在途时插入
    let releaseError!: (value: unknown) => void;
    const errorRequest = new Promise((resolve) => { releaseError = resolve; });
    vi.mocked(tasksApi.executionLogs).mockImplementation(() => errorRequest as never);

    renderPage();
    await screen.findByText(/plain line/);
    expect(changeLevelFilter).not.toBeNull();

    // ① 选 ERROR：loading=true，请求挂起
    await act(async () => { changeLevelFilter!('ERROR'); });
    expect(tasksApi.executionLogs).toHaveBeenCalledWith('t1', 'e1', { fromLine: 0, limit: 2000, level: 'ERROR' });

    // ② 立刻切 ALL：最后一次发起者变成 ALL，旧 ERROR 请求仍在途
    await act(async () => { changeLevelFilter!('ALL'); });

    // ③ 旧请求晚到：数据落地守卫必须丢弃它，loading 也不得由它负责
    await act(async () => {
      releaseError({ lines: ['LATE-ERROR-LINE'], totalLines: 1, hasMore: false });
    });
    expect(getPre().textContent).toBe(LOGS);
    expect(getPre().textContent).not.toContain('LATE-ERROR-LINE');

    // ④ 用户可见的交互态：Select 不再 disabled，且能重新展开选项
    const select = getLevelSelect();
    expect(select.className).not.toMatch(/ant-select-disabled|ant-select-loading/);
    fireEvent.mouseDown(select);
    await vi.waitFor(() => {
      expect(document.querySelectorAll('.ant-select-item-option').length).toBe(5);
    });
  });
});
