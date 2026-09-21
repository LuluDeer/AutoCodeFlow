/**
 * P1-6 / P2-4（UX-AUDIT-2026-09-21）：删除任务必须说明"在跑执行会被强杀"，
 * 且批量删除确认文案不得挂错 i18n 键。
 *
 * ## P1-6 旧实现的错
 * TaskListPage 行内删除 Popconfirm（`title='确认删除此任务？'`）与 TaskDetailPage
 * 删除 Popconfirm 都**只有** title、没有 description。后端 task.controller 明写
 * "Running executions will be forcefully terminated"，task.service 确会
 * schedulerService.stop——用户以为只是移除配置，实际中断生产执行。
 * 修法：两处 Popconfirm 补 description「正在执行中的运行将被强制终止。」。
 *
 * ## P2-4 旧实现的错
 * TaskListPage 批量删除 Popconfirm 误用 `t('taskList.batchTrigger.confirm')`——
 * 键名是"批量触发"、值却是"确认删除 N 个任务？"。埋点风险：后续按键名"修正"文案
 * 会改错一个**不可逆删除操作**的确认语。修法：新增语义正确的
 * `taskList.batchDelete.confirm`（并顺带带上强杀说明），组件改用该键。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, act, within } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import TaskListPage from '../pages/TaskListPage';
import { tasksApi, type Task } from '../api/tasks';

vi.mock('../api/tasks', async () => {
  const actual = await vi.importActual<typeof import('../api/tasks')>('../api/tasks');
  return {
    summarizeBatch: actual.summarizeBatch,
    tasksApi: {
      list: vi.fn(), get: vi.fn(), create: vi.fn(), delete: vi.fn(),
      trigger: vi.fn(), pause: vi.fn(), resume: vi.fn(),
      batchTrigger: vi.fn(), batchPause: vi.fn(), batchResume: vi.fn(),
      batchDelete: vi.fn(),
    },
  };
});
const mockedTasks = vi.mocked(tasksApi, true);

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

const makeTask = (over: Partial<Task> = {}): Task => ({
  id: 'task-1', name: '备份任务', runtime: 'python', entrypoint: 'src/main.py',
  status: 'active', triggerType: 'cron', cronExpression: '0 2 * * *',
  maxRetry: 3, timeout: 300, priority: 2,
  createdAt: '2026-09-01T08:00:00Z', updatedAt: '2026-09-07T08:00:00Z', ...over,
});

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/tasks']}>
        <Routes>
          <Route path="/tasks" element={<TaskListPage />} />
          <Route path="/tasks/new" element={<div />} />
          <Route path="/task-templates" element={<div />} />
          <Route path="/tasks/:id" element={<div />} />
          <Route path="/tasks/:id/edit" element={<div />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
  mockedTasks.list.mockResolvedValue({
    items: [makeTask(), makeTask({ id: 'task-2', name: '巡检任务', status: 'paused' })],
    total: 2, page: 1, pageSize: 20,
  });
});
afterEach(() => cleanup());

describe('P1-6: 删除任务 Popconfirm 必须说明"在跑执行会被强杀"', () => {
  it('行内删除：弹层在 title 之外额外展示强制终止说明', async () => {
    renderPage();
    await screen.findAllByText(/备份\s*任务/);
    // 删除按钮（行内、danger 图标按钮）——触发 Popconfirm 弹层。
    const delBtns = Array.from(document.querySelectorAll('.ant-table-row button')) as HTMLButtonElement[];
    fireEvent.click(delBtns[delBtns.length - 1]);

    // 旧实现只有 title「确认删除此任务？」，没有 description。
    const pop = await screen.findByText('确认删除此任务？');
    const layer = pop.closest('.ant-popover') as HTMLElement;
    expect(layer).toBeTruthy();
    // 新增的强杀说明必须出现在同一个弹层里。
    expect(within(layer as HTMLElement).queryByText(/正在执行中的运行将被强制终止/)).toBeTruthy();
  });
});

describe('P2-4: 批量删除确认文案用语义正确的键（含强杀说明）', () => {
  it('勾选后点批量删除：弹层标题含"确认删除 N 个任务"且带强杀说明（不再是 batchTrigger.confirm）', async () => {
    renderPage();
    await screen.findAllByText(/备份\s*任务/);

    // 勾选两行 → 批量操作条出现
    const boxes = document.querySelectorAll('.ant-table-row .ant-checkbox-input');
    await act(async () => { fireEvent.click(boxes[0]); });
    await act(async () => { fireEvent.click(boxes[1]); });

    // 点「批量删除」按钮 → 弹出批量删除 Popconfirm
    const batchDel = Array.from(document.querySelectorAll('button'))
      .find((b) => (b.textContent ?? '').includes('批量删除')) as HTMLButtonElement;
    expect(batchDel).toBeTruthy();
    fireEvent.click(batchDel);

    // 新键 taskList.batchDelete.confirm 的文案（旧 batchTrigger.confirm 只有"确认删除 N 个任务？"，
    // 不含强杀说明——这正是要钉住的回归点）。
    expect(await screen.findByText(/确认删除 2 个任务.*正在执行中的运行将被强制终止/)).toBeTruthy();
  });
});
