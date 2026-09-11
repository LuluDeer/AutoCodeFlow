/**
 * NF-02: 依赖 DAG 组件编排动作区测试——「触发整条链」按钮的渲染与交互。
 * 组件取数走 tasksApi.list（mock），布局纯函数已由 dag-layout.test 覆盖；
 * 本文件聚焦链式触发行为断言（调 batchTrigger 且 taskId 集合=图节点全集）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import TaskDependencyGraph from '../components/TaskDependencyGraph';
import { tasksApi, type Task } from '../api/tasks';

vi.mock('../api/tasks', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/tasks')>();
  return { ...actual, tasksApi: { ...actual.tasksApi, list: vi.fn(), listAll: vi.fn(), batchTrigger: vi.fn() } };
});

vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>();
  return { ...actual, useNavigate: () => vi.fn() };
});

function task(id: string, name = id, deps?: Record<string, string>): Partial<Task> {
  return { id, name, status: 'active', ...(deps ? { dependencies: deps } : {}) };
}

describe('TaskDependencyGraph 编排动作区（NF-02 触发整条链）', () => {
  beforeEach(() => {
    vi.mocked(tasksApi.list).mockReset();
    vi.mocked(tasksApi.listAll).mockReset().mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 100 } as never);
    vi.mocked(tasksApi.batchTrigger).mockReset();
  });

  it('有依赖链时渲染按钮，点击触发 batchTrigger 且携带图节点全集', async () => {
    vi.mocked(tasksApi.listAll).mockResolvedValue({
      items: [
        task('up', '上游'),
        task('cur', '当前', { d1: 'up' }),
        task('down', '下游', { d2: 'cur' }),
      ],
      total: 3,
      page: 1,
      pageSize: 100,
    } as never);
    vi.mocked(tasksApi.batchTrigger).mockResolvedValue([] as never);

    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <MemoryRouter>
        <TaskDependencyGraph taskId="cur" />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    const btn = await screen.findByTestId('dag-trigger-chain');
    await waitFor(() => expect(btn.textContent).toContain('3'));
    fireEvent.click(btn);

    await waitFor(() => expect(tasksApi.batchTrigger).toHaveBeenCalledTimes(1));
    const ids = vi.mocked(tasksApi.batchTrigger).mock.calls[0][0] as string[];
    expect(ids.sort()).toEqual(['cur', 'down', 'up']);
  });

  it('孤立任务（无上下游）按钮仍在且只含自身', async () => {
    vi.mocked(tasksApi.listAll).mockResolvedValue({
      items: [task('solo', '单任务')],
      total: 1,
      page: 1,
      pageSize: 100,
    } as never);
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <MemoryRouter>
        <TaskDependencyGraph taskId="solo" />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    const btn = await screen.findByTestId('dag-trigger-chain');
    fireEvent.click(btn);
    await waitFor(() => expect(tasksApi.batchTrigger).toHaveBeenCalledWith(['solo']));
  });

  it('batchTrigger 失败 → 错误消息透出不静默', async () => {
    vi.mocked(tasksApi.listAll).mockResolvedValue({
      items: [task('solo', '单任务')],
      total: 1,
      page: 1,
      pageSize: 100,
    } as never);
    // axios 形态错误（getErrMsg 优先取 response.data.message）
    vi.mocked(tasksApi.batchTrigger).mockRejectedValue({
      response: { data: { message: 'boom' } },
    } as never);
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <MemoryRouter>
        <TaskDependencyGraph taskId="solo" />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    const btn = await screen.findByTestId('dag-trigger-chain');
    fireEvent.click(btn);
    await waitFor(() => {
      expect(screen.getAllByText(/boom|链式触发失败/).length).toBeGreaterThan(0);
    });
  });

  it('任务列表加载失败显示错误态与重试，而不是误报任务不存在', async () => {
    vi.mocked(tasksApi.listAll).mockRejectedValue(new Error('network down'));
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <MemoryRouter>
        <TaskDependencyGraph taskId="missing" />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    expect(await screen.findByTestId('state-error')).toBeTruthy();
    expect(screen.getByText('依赖图加载失败')).toBeTruthy();
    expect(screen.queryByText('任务不存在或已删除，无法构建依赖图')).toBeNull();
  });

  it('列表成功但当前任务不存在时显示不存在，而不是加载失败', async () => {
    vi.mocked(tasksApi.listAll).mockResolvedValue({
      items: [task('other', '其他任务')],
      total: 1,
      page: 1,
      pageSize: 100,
    } as never);
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <MemoryRouter>
        <TaskDependencyGraph taskId="missing" />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    expect(await screen.findByText('任务不存在或已删除，无法构建依赖图')).toBeTruthy();
    expect(screen.queryByTestId('state-error')).toBeNull();
  });
});
