/**
 * F-1 / F-4（本轮审计）：保存成功后的**导航链路**集成回归。
 *
 * 与 task-form-page.test.tsx 的差别：那里整模块 mock 了 react-router-dom
 * （useBlocker 恒 unblocked），钉不住「保存成功 → 跳转」的真实行为。本文件用
 * **真实 data router**（createMemoryRouter）渲染，useBlocker 走真实现：
 *
 *  - F-1：编辑保存成功后跳转详情——修复前 useBlocker(dirty||glueDirty) 在
 *    nav 判定时仍读到 dirty=true（闭包 state 未重渲），把自己的导航拦下来，
 *    「任务更新成功」与「有未保存的更改」Modal 同屏；修复后判定走 ref，
 *    clearFormDirty 同步翻转后再 nav，跳转直达且 Modal 不出现。
 *  - F-4：创建成功后跳 /tasks/:id/edit（replace）——修复前停留 /tasks/new，
 *    刷新丢上下文、重复提交撞任务名 409。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import TaskFormPage from '../pages/TaskFormPage';
import { tasksApi } from '../api/tasks';
import { executorsApi } from '../api/executors';
import { applicationsApi } from '../api/applications';
import { projectsApi } from '../api/projects';
import { useAuthStore } from '../store/auth';

vi.mock('../api/tasks', () => ({
  tasksApi: {
    get: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    updateGlue: vi.fn(),
    list: vi.fn(),
    listAll: vi.fn(),
  },
}));
vi.mock('../api/executors', () => ({
  executorsApi: { list: vi.fn(), getGroups: vi.fn(), getTags: vi.fn() },
}));
vi.mock('../api/applications', () => ({ applicationsApi: { list: vi.fn() } }));
vi.mock('../api/projects', () => ({ projectsApi: { list: vi.fn() } }));
// GlueEditor 拖带 monaco（jsdom 缺浏览器 API），与兄弟文件同策裁剪。
vi.mock('../components/GlueEditor', () => ({ default: () => <div data-testid="glue-editor" /> }));

const EDIT_TASK = {
  id: 'task-1',
  name: 'my-task',
  runtime: 'python',
  entrypoint: 'tasks/main.py',
  triggerType: 'manual',
  status: 'active',
  maxRetry: 3,
  retryDelay: 0,
  timeout: 300,
  priority: 2,
  updatedAt: '2026-01-01T00:00:00Z',
};

function renderAt(path: string) {
  const router = createMemoryRouter(
    [
      { path: '/tasks/new', element: <TaskFormPage /> },
      { path: '/tasks/:id/edit', element: <TaskFormPage /> },
      // 详情路由桩：断言「保存成功 → URL 跳详情」的落点
      { path: '/tasks/:id', element: <div data-testid="task-detail-stub">detail</div> },
    ],
    { initialEntries: [path] },
  );
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return router;
}

const PIN_UUID = '550e8400-e29b-41d4-a716-446655440000';

// jsdom 缺失 antd 依赖的浏览器 API，先行补齐（对齐 task-form-page.test 先例）。
const g = globalThis as Record<string, unknown>;
if (!g.ResizeObserver) {
  g.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}
if (!window.matchMedia) {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

beforeEach(() => {
  // DRAFT-01：草稿落 localStorage——用例间必须隔离，否则上一个用例的输入会
  // 被下一个用例"恢复"进表单。
  localStorage.clear();
  useAuthStore.setState({ user: { id: 1, username: 'root', role: 'admin' } });
  vi.mocked(executorsApi.list).mockReset().mockResolvedValue([
    { id: PIN_UUID, appName: 'node-a', address: '10.0.0.1:3001', status: 'online' },
  ] as never);
  vi.mocked(executorsApi.getGroups).mockReset().mockResolvedValue([] as never);
  vi.mocked(executorsApi.getTags).mockReset().mockResolvedValue([] as never);
  vi.mocked(applicationsApi.list).mockReset().mockResolvedValue([] as never);
  vi.mocked(projectsApi.list).mockReset().mockResolvedValue([] as never);
  vi.mocked(tasksApi.listAll).mockReset().mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 100 } as never);
  vi.mocked(tasksApi.get).mockReset().mockResolvedValue(EDIT_TASK as never);
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.clearAllMocks();
});

// ── F-1 ─────────────────────────────────────────────────
describe('F-1：编辑保存成功后跳详情，不再被自家未保存守卫拦截', () => {
  it('改动表单后保存：URL 跳 /tasks/:id，未保存 Modal 不出现', async () => {
    vi.mocked(tasksApi.update).mockReset().mockResolvedValue({ ...EDIT_TASK } as never);
    const router = renderAt('/tasks/task-1/edit');

    // 等编辑态回填完成（name 输入框出现且带任务名）
    const nameInput = (await screen.findByPlaceholderText('daily-report')) as HTMLInputElement;
    await waitFor(() => expect(nameInput.value).toBe('my-task'));

    // 用户改动 → dirty=true（守卫应进入武装态）
    fireEvent.change(nameInput, { target: { value: 'my-task-renamed' } });

    // 保存 → update 成功 → 应清脏并跳详情
    fireEvent.click(screen.getByRole('button', { name: /保存更改/ }));

    await waitFor(() => expect(tasksApi.update).toHaveBeenCalledTimes(1));
    // 关键断言 1：导航未被自家 blocker 拦截——URL 真的到了详情页
    await waitFor(() => expect(router.state.location.pathname).toBe('/tasks/task-1'));
    // router state 先于 React commit 更新，等渲染提交后再断言落点
    await waitFor(() => expect(screen.getByTestId('task-detail-stub')).toBeTruthy());
    // 关键断言 2：「有未保存的更改」Modal 不出现（修复前与成功 toast 同屏）
    expect(screen.queryByText('有未保存的更改')).toBeNull();
    // 请求载荷带上用户改动
    const payload = vi.mocked(tasksApi.update).mock.calls[0][1] as unknown as Record<string, unknown>;
    expect(payload.name).toBe('my-task-renamed');
  }, 20_000);
});

// ── F-4 ─────────────────────────────────────────────────
describe('F-4：创建成功后跳新任务编辑页（不再停留 /tasks/new）', () => {
  it('创建成功：URL replace 到 /tasks/:id/edit，且不再出现未保存 Modal', async () => {
    vi.mocked(tasksApi.create).mockReset().mockResolvedValue({ id: 'brand-new-task' } as never);
    const router = renderAt('/tasks/new');

    const nameInput = await screen.findByPlaceholderText('daily-report');
    fireEvent.change(nameInput, { target: { value: 'fresh-task' } });
    fireEvent.change(screen.getByPlaceholderText('tasks/main.py'), {
      target: { value: 'tasks/main.py' },
    });
    fireEvent.click(screen.getByRole('button', { name: /创建任务/ }));

    await waitFor(() => expect(tasksApi.create).toHaveBeenCalledTimes(1));
    // 关键断言：跳到新任务编辑页（replace 导航；修复前停留 /tasks/new）
    await waitFor(() => expect(router.state.location.pathname).toBe('/tasks/brand-new-task/edit'));
    // 导航未被守卫拦截：未保存 Modal 不出现
    expect(screen.queryByText('有未保存的更改')).toBeNull();
    // 编辑页重新拉取刚创建的任务（上下文不再丢失）
    await waitFor(() => expect(tasksApi.get).toHaveBeenCalledWith('brand-new-task', expect.anything()));
  }, 20_000);
});
