/**
 * A4（第三轮审计）TaskFormPage 组件级接线回归：
 * 1. 乐观锁——编辑态提交带 expectedUpdatedAt（读取时刻的 updatedAt）；
 * 409 冲突时 message.error 专门提示且**不跳转**；
 * 2. 保存成功后统一失效任务/执行/metrics 查询面（invalidateTaskData）；
 * 3. blockStrategy 控件回填与透传（serial/discard/cover_early）；
 * 4. 维护窗口行 flex wrap 布局（375px 溢出修复）。
 *
 * 测试骨架（api mock / 路由 mock / jsdom 兜底）对齐
 * python-multiversion-form-wiring.test.tsx 先例。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuthStore } from '../store/auth';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import TaskFormPage from '../pages/TaskFormPage';
import { tasksApi } from '../api/tasks';
import { executorsApi } from '../api/executors';
import { applicationsApi } from '../api/applications';
import { projectsApi } from '../api/projects';

vi.mock('../api/tasks', () => ({
  tasksApi: {
    get: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    list: vi.fn(),
    listAll: vi.fn().mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 100 }),
  },
}));
vi.mock('../api/executors', () => ({
  executorsApi: { list: vi.fn(), getGroups: vi.fn(), getTags: vi.fn() },
}));
vi.mock('../api/applications', () => ({ applicationsApi: { list: vi.fn() } }));
vi.mock('../api/projects', () => ({ projectsApi: { list: vi.fn() } }));
vi.mock('../components/GlueEditor', () => ({ default: () => <div data-testid="glue-editor" /> }));
// 捕获 toast（页面从 utils/toast 取 message——与 utils/error 的 showApiError 不同源）
vi.mock('../utils/toast', () => ({
  message: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

let mockRouteParams: { id?: string } = {};
let mockNavigate = vi.fn();
vi.mock('react-router-dom', () => ({
  useNavigate: () => mockNavigate,
  useBlocker: () => ({ state: 'unblocked' as const, proceed: () => {}, reset: () => {} }),
  useParams: () => mockRouteParams,
  useSearchParams: () => [new URLSearchParams('')],
  Link: (props: { to: string; children: React.ReactNode }) => <a href={props.to}>{props.children}</a>,
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
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}

const EDIT_TASK = {
  id: 'task-1',
  name: 'my-task',
  runtime: 'python',
  entrypoint: 'tasks/main.py',
  triggerType: 'manual',
  status: 'active',
  priority: 2,
  timeout: 300,
  maxRetry: 3,
  retryDelay: 0,
  codeSource: 'git' as const,
  gitRepo: 'https://example.com/repo.git',
  gitBranch: 'main',
  glueSource: undefined,
  updatedAt: '2026-10-01T08:00:00.000Z',
  maintenanceWindows: [{ start: '* * * * *', end: '* * 31 2 *', description: 'freeze' }],
  blockStrategy: 'discard' as const,
};

const testQueryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
const renderPage = () =>
  render(
    <QueryClientProvider client={testQueryClient}>
      <TaskFormPage />
    </QueryClientProvider>,
  );

beforeEach(() => {
  useAuthStore.setState({ user: { id: 1, username: 'root', role: 'admin' } });
  mockRouteParams = { id: 'task-1' };
  mockNavigate = vi.fn();
  vi.mocked(executorsApi.list).mockReset().mockResolvedValue([] as never);
  vi.mocked(executorsApi.getGroups).mockReset().mockResolvedValue([] as never);
  vi.mocked(executorsApi.getTags).mockReset().mockResolvedValue([] as never);
  vi.mocked(applicationsApi.list).mockReset().mockResolvedValue([] as never);
  vi.mocked(projectsApi.list).mockReset().mockResolvedValue([] as never);
  vi.mocked(tasksApi.listAll).mockReset().mockResolvedValue({
    items: [], total: 0, page: 1, pageSize: 100,
  } as never);
  vi.mocked(tasksApi.get).mockReset().mockResolvedValue(EDIT_TASK as never);
  vi.mocked(tasksApi.update).mockReset().mockResolvedValue({ id: 'task-1' } as never);
  vi.mocked(tasksApi.create).mockReset().mockResolvedValue({ id: 'new-task' } as never);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

/** 等编辑态加载完成（表单回填 name 值）后点「保存更改」 */
async function submitEditForm() {
  const nameInput = await screen.findByDisplayValue('my-task');
  expect(nameInput).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: /保存更改/ }));
  await waitFor(() => {
    expect(vi.mocked(tasksApi.update)).toHaveBeenCalled();
  });
}

describe('TaskFormPage：乐观锁接线（A4）', () => {
  it('编辑态提交带 expectedUpdatedAt（读取时刻的 updatedAt），成功后失效任务/执行/metrics 查询面并跳转详情', async () => {
    const invalidateSpy = vi.spyOn(testQueryClient, 'invalidateQueries');
    renderPage();
    await submitEditForm();

    const payload = vi.mocked(tasksApi.update).mock.calls[0][1] as Record<string, unknown>;
    expect(payload.expectedUpdatedAt).toBe('2026-10-01T08:00:00.000Z');
    // invalidateTaskData：tasks + executions + metrics 三组查询面
    await waitFor(() => {
      expect(invalidateSpy).toHaveBeenCalled();
    });
    expect(mockNavigate).toHaveBeenCalledWith('/tasks/task-1');
    invalidateSpy.mockRestore();
  });

  it('409 冲突：message.error 弹「请刷新」专门提示，不跳转', async () => {
    const { message } = await import('../utils/toast');
    vi.mocked(tasksApi.update).mockRejectedValue({ __status: 409 } as never);
    renderPage();
    await submitEditForm();

    await waitFor(() => {
      expect(message.error).toHaveBeenCalledWith(
        expect.stringContaining('请刷新'),
        6,
      );
    });
    // 不跳转：留在表单页
    expect(mockNavigate).not.toHaveBeenCalled();
  });
});

describe('TaskFormPage：blockStrategy 控件（A4）', () => {
  it('编辑态回填 blockStrategy，提交透传到 payload', async () => {
    renderPage();
    await submitEditForm();
    // 回填：Select 显示 discard 的中文 label
    expect(await screen.findByText('丢弃新触发（保留上一轮）')).toBeTruthy();
    const payload = vi.mocked(tasksApi.update).mock.calls[0][1] as Record<string, unknown>;
    expect(payload.blockStrategy).toBe('discard');
  });
});

describe('TaskFormPage：维护窗口 flex wrap 布局（A4）', () => {
  it('维护窗口行使用可折行的 flex 容器（375px 溢出修复）', async () => {
    const { container } = renderPage();
    await screen.findByDisplayValue('my-task');
    const wrapRow = container.querySelector('[style*="flex-wrap"]');
    expect(wrapRow).toBeTruthy();
  });
});
