/**
 * NF-02: 依赖 DAG 组件编排动作区测试——「触发整条链」按钮的渲染与交互。
 * 组件取数走 tasksApi.list（mock），布局纯函数已由 dag-layout.test 覆盖；
 * 本文件聚焦链式触发行为断言（调 batchTrigger 且 taskId 集合=图节点全集）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import TaskDependencyGraph from '../components/TaskDependencyGraph';
import { tasksApi, type Task } from '../api/tasks';

vi.mock('../api/tasks', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/tasks')>();
  return { ...actual, tasksApi: { ...actual.tasksApi, list: vi.fn(), batchTrigger: vi.fn() } };
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
    vi.mocked(tasksApi.batchTrigger).mockReset();
  });

  it('有依赖链时渲染按钮，点击触发 batchTrigger 且携带图节点全集', async () => {
    vi.mocked(tasksApi.list).mockResolvedValue({
      items: [
        task('up', '上游'),
        task('cur', '当前', { d1: 'up' }),
        task('down', '下游', { d2: 'cur' }),
      ],
      total: 3,
      page: 1,
      pageSize: 500,
    } as never);
    vi.mocked(tasksApi.batchTrigger).mockResolvedValue([] as never);

    render(
      <MemoryRouter>
        <TaskDependencyGraph taskId="cur" />
      </MemoryRouter>,
    );

    const btn = await screen.findByTestId('dag-trigger-chain');
    await waitFor(() => expect(btn.textContent).toContain('3'));
    fireEvent.click(btn);

    await waitFor(() => expect(tasksApi.batchTrigger).toHaveBeenCalledTimes(1));
    const ids = vi.mocked(tasksApi.batchTrigger).mock.calls[0][0] as string[];
    expect(ids.sort()).toEqual(['cur', 'down', 'up']);
  });

  it('孤立任务（无上下游）按钮仍在且只含自身', async () => {
    vi.mocked(tasksApi.list).mockResolvedValue({
      items: [task('solo', '单任务')],
      total: 1,
      page: 1,
      pageSize: 500,
    } as never);
    render(
      <MemoryRouter>
        <TaskDependencyGraph taskId="solo" />
      </MemoryRouter>,
    );
    const btn = await screen.findByTestId('dag-trigger-chain');
    fireEvent.click(btn);
    await waitFor(() => expect(tasksApi.batchTrigger).toHaveBeenCalledWith(['solo']));
  });

  it('batchTrigger 失败 → 错误消息透出不静默', async () => {
    vi.mocked(tasksApi.list).mockResolvedValue({
      items: [task('solo', '单任务')],
      total: 1,
      page: 1,
      pageSize: 500,
    } as never);
    // axios 形态错误（getErrMsg 优先取 response.data.message）
    vi.mocked(tasksApi.batchTrigger).mockRejectedValue({
      response: { data: { message: 'boom' } },
    } as never);
    render(
      <MemoryRouter>
        <TaskDependencyGraph taskId="solo" />
      </MemoryRouter>,
    );
    const btn = await screen.findByTestId('dag-trigger-chain');
    fireEvent.click(btn);
    await waitFor(() => {
      expect(screen.getAllByText(/boom|链式触发失败/).length).toBeGreaterThan(0);
    });
  });
});
