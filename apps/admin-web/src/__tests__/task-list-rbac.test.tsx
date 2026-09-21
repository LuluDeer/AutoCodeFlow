/**
 * P1-5（UX-AUDIT-2026-09-21）：任务三页此前无权限门控——普通用户能看到并点击
 * 新建/编辑/删除/触发等写按钮，点了才由后端 403。修法照 ApplicationListPage 先例：
 * `useAuthStore().user` 经 isAdminUser 判定，写按钮 `disabled={!isAdmin}` + Tooltip 提示，
 * 读面保持可见可用，不整页 403，也不发起会 403 的请求。
 *
 * 本文件钉住 TaskListPage（列表/新建/行内写操作）的门控；Detail/Form 两页同法。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import TaskListPage from '../pages/TaskListPage';
import { tasksApi, type Task } from '../api/tasks';
import { useAuthStore } from '../store/auth';

vi.mock('../api/tasks', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/tasks')>();
  return {
    ...actual,
    tasksApi: {
      list: vi.fn(), get: vi.fn(), create: vi.fn(), delete: vi.fn(),
      trigger: vi.fn(), pause: vi.fn(), resume: vi.fn(),
      batchTrigger: vi.fn(), batchPause: vi.fn(), batchResume: vi.fn(), batchDelete: vi.fn(),
    },
  };
});

const g = globalThis as Record<string, unknown>;
if (!g.ResizeObserver) g.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
if (!window.matchMedia) {
  window.matchMedia = ((q: string) => ({
    matches: false, media: q, onchange: null, addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
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
          <Route path="/tasks/:id" element={<div />} />
          <Route path="/tasks/:id/edit" element={<div />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** 操作列按钮（详情/编辑/克隆/触发/删除）按出现顺序取。 */
const rowActionButtons = () =>
  Array.from(document.querySelectorAll('.ant-table-row .ant-table-cell:last-child button')) as HTMLButtonElement[];

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.mocked(tasksApi.list).mockResolvedValue({
    items: [makeTask()], total: 1, page: 1, pageSize: 20,
  } as never);
  useAuthStore.setState({ user: { id: 1, username: 'root', role: 'admin' } });
});
afterEach(() => {
  cleanup();
  useAuthStore.setState({ user: { id: 1, username: 'root', role: 'admin' } });
});

describe('P1-5: TaskListPage 写操作 isAdmin 门控', () => {
  it('管理员：新建按钮与行内写按钮可用', async () => {
    renderPage();
    await screen.findByText('备份任务');
    expect((screen.getByRole('button', { name: /创建任务/ }) as HTMLButtonElement).disabled).toBe(false);
    const btns = rowActionButtons();
    // [详情, 编辑, 克隆, 触发, 删除]
    expect(btns.length).toBe(5);
    expect(btns[1].disabled).toBe(false); // 编辑
    expect(btns[4].disabled).toBe(false); // 删除
  });

  it('普通用户：新建按钮与行内写按钮禁用，读面（详情）可用', async () => {
    useAuthStore.setState({ user: { id: 2, username: 'dev', role: 'user' } });
    renderPage();
    await screen.findByText('备份任务'); // 读面保持可见

    expect((screen.getByRole('button', { name: /创建任务/ }) as HTMLButtonElement).disabled).toBe(true);
    const btns = rowActionButtons();
    expect(btns[0].disabled).toBe(false); // 详情（读）
    expect(btns[1].disabled).toBe(true); // 编辑
    expect(btns[4].disabled).toBe(true); // 删除
  });

  it('普通用户点禁用的行内删除不触发 DELETE（不发起会 403 的请求）', async () => {
    useAuthStore.setState({ user: { id: 2, username: 'dev', role: 'user' } });
    renderPage();
    await screen.findByText('备份任务');
    fireEvent.click(rowActionButtons()[4]);
    await waitFor(() => expect(tasksApi.delete).not.toHaveBeenCalled());
  });
});
