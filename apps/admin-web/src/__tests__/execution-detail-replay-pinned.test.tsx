/**
 * 技术债 A 组（2026-10-01）·按原版本重放：执行详情页「重新触发」确认 Modal
 * 内的「按原版本重放」复选框。
 *
 * ## 背景
 *  - 重新触发（重跑）此前永远以任务**当前配置**派发——原执行所用的代码版本
 *    已被升级/回滚时，重跑跑的不是当时那份代码（RETRIGGER-TERMINAL 提示只
 *    说出问题，没给解法）；
 *  - 后端新增 TriggerTaskDto.version（钉定版本快照派发，任务当前配置零影响）。
 *
 * ## 本测试钉住的契约
 *  1. 原执行 taskVersion 可解析（如 "v3"）时，Modal 内渲染复选框；勾选后
 *     确认 → `tasksApi.trigger(taskId, params, 3)` 三参调用（version=3）；
 *  2. 不勾选 → 保持旧两参调用形态 `trigger(taskId, params)`（无尾部
 *     undefined 第三参——「不传 version 行为完全不变」落到调用契约本身）；
 *  3. 老数据无 taskVersion（解析不出版本号）→ 复选框不渲染，行为与旧版一致。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
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

function renderPage(execVersion: string | undefined) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  vi.mocked(tasksApi.execution).mockResolvedValue({
    id: 'e1', taskId: 't1', taskName: 'nightly', status: 'failed', triggerType: 'manual',
    failureReason: 'script_error', params: { region: 'cn-north' },
    // 派发时刻任务 currentVersion 快照（钉定重放的取值来源）。
    taskVersion: execVersion,
    createdAt: new Date().toISOString(),
  } as never);
  vi.mocked(tasksApi.get).mockResolvedValue({
    id: 't1', maxRetry: 3, retryDelay: 5, params: {}, currentVersion: 'v5',
  } as never);
  vi.mocked(tasksApi.executions).mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 100 } as never);
  vi.mocked(tasksApi.executionLogs).mockResolvedValue({ lines: [], hasMore: false } as never);
  vi.mocked(tasksApi.trigger).mockResolvedValue({} as never);
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/tasks/t1/executions/e1']}>
        <Routes>
          <Route path="/tasks/:taskId/executions/:execId" element={<ExecutionDetailPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

async function openConfirmModal() {
  const [btn] = await screen.findAllByRole('button', { name: /重新触发/ });
  fireEvent.click(btn!);
  await screen.findByText('重新触发确认');
}

beforeEach(() => { cleanup(); vi.clearAllMocks(); });
afterEach(cleanup);

describe('技术债 A 组: 重新触发「按原版本重放」复选框（REPLAY-PINNED）', () => {
  it('勾选后确认 → trigger 携带钉定版本号（taskVersion "v3" → version=3），且 Modal 文案切换为钉定态', async () => {
    renderPage('v3');
    await openConfirmModal();

    // 复选框可解析 taskVersion 时渲染，默认不勾选
    const checkbox = screen.getByTestId('retrigger-replay-pinned') as HTMLInputElement;
    expect(checkbox.checked).toBe(false);

    fireEvent.click(checkbox);
    // 勾选后 Modal 提示切换为「将按 v3 快照派发」（versionDiffers 提示随之隐藏）
    expect(await screen.findByText(/将执行原版本 v3 的快照/)).toBeTruthy();

    const okBtn = await screen.findByRole('button', { name: /用本次参数重跑/ });
    fireEvent.click(okBtn);

    await waitFor(() => expect(vi.mocked(tasksApi.trigger)).toHaveBeenCalled());
    // 三参调用：version=3（"v3" 去前缀解析），params 沿用本次执行的参数
    expect(vi.mocked(tasksApi.trigger)).toHaveBeenCalledWith('t1', { region: 'cn-north' }, 3);
  });

  it('不勾选 → 保持旧两参调用（无第三参）；老数据无 taskVersion 时复选框不渲染', async () => {
    renderPage('v3');
    await openConfirmModal();

    const okBtn = await screen.findByRole('button', { name: /用本次参数重跑/ });
    fireEvent.click(okBtn);

    await waitFor(() => expect(vi.mocked(tasksApi.trigger)).toHaveBeenCalled());
    // 严格两参断言：默认（不钉定）调用形态与旧版逐参一致
    expect(vi.mocked(tasksApi.trigger)).toHaveBeenCalledWith('t1', { region: 'cn-north' });
    expect(vi.mocked(tasksApi.trigger).mock.calls[0]).toHaveLength(2);

    // 老数据（无 taskVersion）：复选框不渲染，确认框仍可用
    cleanup();
    vi.clearAllMocks();
    vi.mocked(tasksApi.trigger).mockResolvedValue({} as never);
    renderPage(undefined);
    await openConfirmModal();
    expect(screen.queryByTestId('retrigger-replay-pinned')).toBeNull();
    const okBtn2 = await screen.findByRole('button', { name: /用本次参数重跑/ });
    fireEvent.click(okBtn2);
    await waitFor(() => expect(vi.mocked(tasksApi.trigger)).toHaveBeenCalled());
    expect(vi.mocked(tasksApi.trigger)).toHaveBeenCalledWith('t1', { region: 'cn-north' });
  });
});
