/**
 * P1-4（UX-AUDIT-2026-09-21）：长表单无未保存守卫。
 *
 * 旧实现的错（证据）：TaskFormPage 是一个几十字段的长表单，页头返回按钮、面包屑、
 * 浏览器关闭/刷新都**没有任何 dirty 守卫**——点一下返回/刷新，用户填了半天的内容
 * 直接丢失，且不可恢复（已发生过"返回丢草稿"的反馈）。
 *
 * 修法：
 *  - antd onValuesChange 置 dirty；加载回填、模板预填、提交成功后清 dirty；
 *  - react-router v7 `useBlocker(dirty)` 拦截站内跳转，弹未保存确认（离开/留下）；
 *  - dirty 时 window beforeunload 拦截浏览器关闭/刷新。
 *
 * 本测试钉住最稳定、与 router 内部实现解耦的可观测行为：
 *   「未改动时 beforeunload 不拦截；用户改动后 beforeunload 被 preventDefault」。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import TaskFormPage from '../pages/TaskFormPage';
import { executorsApi } from '../api/executors';
import { applicationsApi } from '../api/applications';
import { projectsApi } from '../api/projects';

vi.mock('../api/tasks', () => ({ tasksApi: { get: vi.fn(), create: vi.fn(), update: vi.fn(), list: vi.fn(), listAll: vi.fn().mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 100 }) } }));
vi.mock('../api/executors', () => ({ executorsApi: { list: vi.fn(), getGroups: vi.fn(), getTags: vi.fn() } }));
vi.mock('../api/applications', () => ({ applicationsApi: { list: vi.fn() } }));
vi.mock('../api/projects', () => ({ projectsApi: { list: vi.fn() } }));
vi.mock('../components/GlueEditor', () => ({ default: () => <div data-testid="glue-editor" /> }));

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

function renderForm() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createMemoryRouter(
    [
      { path: '/tasks/new', element: <TaskFormPage /> },
      { path: '/tasks', element: <div>tasks-list-mock</div> },
    ],
    { initialEntries: ['/tasks/new'] },
  );
  return render(
    <QueryClientProvider client={qc}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

const fireBeforeUnload = (): boolean => {
  const ev = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(ev);
  return ev.defaultPrevented;
};

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.mocked(executorsApi.list).mockResolvedValue([] as never);
  vi.mocked(executorsApi.getGroups).mockResolvedValue([] as never);
  vi.mocked(executorsApi.getTags).mockResolvedValue([] as never);
  vi.mocked(applicationsApi.list).mockResolvedValue([] as never);
  vi.mocked(projectsApi.list).mockResolvedValue([] as never);
});
afterEach(() => cleanup());

describe('P1-4: TaskFormPage 未保存守卫（beforeunload）', () => {
  it('未改动时不拦截 beforeunload；用户改动后拦截（preventDefault）', async () => {
    renderForm();
    // 初始未脏：关闭/刷新不应被拦。
    expect(fireBeforeUnload()).toBe(false);

    // 在名称字段输入 → antd onValuesChange → setDirty(true)。
    const nameInput = await screen.findByPlaceholderText('daily-report');
    fireEvent.change(nameInput, { target: { value: 'my-job' } });

    // dirty 生效后，beforeunload 必须被拦截（旧实现永远 false）。
    await waitFor(() => expect(fireBeforeUnload()).toBe(true));
  });

  it('未保存确认弹窗默认关闭（dirty=false 时不渲染）', async () => {
    renderForm();
    await screen.findByPlaceholderText('daily-report');
    // 旧实现根本没有这个对话框；新实现 dirty=false 时不打开。
    expect(screen.queryByText(/有未保存的更改|Unsaved changes/)).toBeNull();
  });
});
