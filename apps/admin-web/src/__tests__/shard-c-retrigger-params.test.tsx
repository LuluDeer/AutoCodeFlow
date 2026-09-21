/**
 * P1-26（UX-AUDIT-2026-09-21，Shard C）：「重新触发」静默丢参数并立刻导航。
 *
 * ## 旧实现怎么错（红）
 *  - handleRetry 调 `tasksApi.trigger(taskId!)` —— 不传第二参 params
 *    （api/tasks.ts 的 trigger(id, params?) 明明支持），于是以任务**当前默认参数**
 *    重跑，而不是复现**这一次**失败执行的参数；
 *  - 成功后立刻 `nav('/tasks/:taskId')` 离开现场，用户正要读的错误/日志随页消失。
 *
 * ## 修法（绿）
 *  - 携带本次执行的 params：`trigger(taskId, data?.params)`；
 *  - 点「重新触发」先弹确认 Modal，展示本次执行参数（与任务默认参数的差异）；
 *  - 不再自动导航，用户留在现场继续看日志。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import ExecutionDetailPage from '../pages/ExecutionDetailPage';
import { tasksApi } from '../api/tasks';

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
  artifactsApi: { listArtifacts: vi.fn().mockResolvedValue([]), downloadArtifact: vi.fn() },
}));
vi.mock('../api/execution-reports', () => ({
  executionReportsApi: { report: vi.fn().mockResolvedValue({ execution: {}, timeline: [], report: null }) },
}));

const g = globalThis as Record<string, unknown>;
if (!g.ResizeObserver) {
  g.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
}
if (!window.matchMedia) {
  window.matchMedia = ((q: string) => ({
    matches: false, media: q, onchange: null,
    addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

function LocationProbe() {
  const loc = useLocation();
  return <span data-testid="loc-probe">{loc.pathname}</span>;
}

function renderPage(params: Record<string, unknown> | null = { region: 'cn-north', shards: 4 }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  // 本次失败执行带 params——旧实现重跑时会把它丢掉。
  vi.mocked(tasksApi.execution).mockResolvedValue({
    id: 'e1', taskId: 't1', taskName: 'nightly', status: 'failed', triggerType: 'manual',
    failureReason: 'script_error', params, createdAt: new Date().toISOString(),
  } as never);
  vi.mocked(tasksApi.get).mockResolvedValue({
    id: 't1', maxRetry: 3, retryDelay: 5, params: { region: 'eu-west', shards: 8 },
  } as never);
  vi.mocked(tasksApi.executions).mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 100 } as never);
  vi.mocked(tasksApi.executionLogs).mockResolvedValue({ lines: [], hasMore: false } as never);
  vi.mocked(tasksApi.trigger).mockResolvedValue({} as never);
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/tasks/t1/executions/e1']}>
        <LocationProbe />
        <Routes>
          <Route path="/tasks/:taskId/executions/:execId" element={<ExecutionDetailPage />} />
          <Route path="/tasks/:taskId" element={<div>task-detail-mock</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => { cleanup(); vi.clearAllMocks(); });
afterEach(() => cleanup());

describe('P1-26: 重新触发携带本次参数 + 确认 Modal + 不自动导航', () => {
  it('点「重新触发」先弹确认 Modal，而非立刻触发/导航', async () => {
    renderPage();
    // 头部与失败卡各有一个「重新触发」按钮，取第一个点击。
    const [btn] = await screen.findAllByRole('button', { name: /重新触发/ });
    fireEvent.click(btn!);
    // 旧实现：点了就直接 trigger + nav；新实现先弹确认框。
    expect(await screen.findByText('重新触发确认')).toBeTruthy();
    expect(vi.mocked(tasksApi.trigger)).not.toHaveBeenCalled();
  });

  it('确认后以「本次执行的 params」调用 trigger（而非任务默认参数），且不离开本页', async () => {
    renderPage();
    const [btn] = await screen.findAllByRole('button', { name: /重新触发/ });
    fireEvent.click(btn!);
    await screen.findByText('重新触发确认');
    // Modal 内展示本次执行参数（region=cn-north），并提示与任务默认参数不同
    expect(screen.getByText(/region = cn-north/)).toBeTruthy();
    expect(screen.getByText(/与任务当前默认参数不同/)).toBeTruthy();

    const okBtn = await screen.findByRole('button', { name: /用本次参数重跑/ });
    fireEvent.click(okBtn);

    await waitFor(() => expect(vi.mocked(tasksApi.trigger)).toHaveBeenCalled());
    // 旧实现：trigger 只传 taskId；新实现携带本次执行参数 {region:'cn-north',shards:4}
    expect(vi.mocked(tasksApi.trigger)).toHaveBeenCalledWith('t1', { region: 'cn-north', shards: 4 });
    // 旧实现成功后 nav('/tasks/t1') 离开；新实现留在执行详情现场。
    await waitFor(() =>
      expect(screen.getByTestId('loc-probe').textContent).toBe('/tasks/t1/executions/e1'),
    );
  });

  it('无额外参数时确认框提示将使用任务默认参数', async () => {
    renderPage(null);
    const [btn] = await screen.findAllByRole('button', { name: /重新触发/ });
    fireEvent.click(btn!);
    await screen.findByText('重新触发确认');
    expect(screen.getByText(/没有额外参数/)).toBeTruthy();
  });
});
