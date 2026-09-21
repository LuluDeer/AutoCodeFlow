/**
 * D-设计审计 2026-09-22 分片A — 依赖 DAG 键盘可达回归。
 *
 * D-P2-05：可点击节点（div onClick）此前无 tabIndex/onKeyDown，键盘用户无法
 * 跳转到上下游任务。补 tabIndex=0 + Enter/Space 触发。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import TaskDependencyGraph from '../components/TaskDependencyGraph';
import { tasksApi, type Task } from '../api/tasks';

const navigateMock = vi.fn();

vi.mock('../api/tasks', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/tasks')>();
  return { ...actual, tasksApi: { ...actual.tasksApi, list: vi.fn(), listAll: vi.fn(), batchTrigger: vi.fn() } };
});
vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>();
  return { ...actual, useNavigate: () => navigateMock };
});

const task = (id: string, name: string, status: string, deps?: Record<string, string>): Partial<Task> =>
  ({ id, name, status, ...(deps ? { dependencies: deps } : {}) });

function renderGraph(taskId: string) {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter>
        <TaskDependencyGraph taskId={taskId} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('D-P2-05: DAG 可点击节点键盘可达', () => {
  beforeEach(() => {
    navigateMock.mockClear();
    vi.mocked(tasksApi.listAll).mockReset().mockResolvedValue({
      items: [
        task('up', '上游任务', 'active'),
        task('cur', '当前任务', 'paused', { d1: 'up' }),
      ],
      total: 2, page: 1, pageSize: 100,
    } as never);
  });

  it('非当前节点是可聚焦的 button（tabIndex=0 + role=button）', async () => {
    renderGraph('cur');
    const upstream = await screen.findByText('上游任务');
    const nodeEl = upstream.closest('div[role="button"]') as HTMLElement;
    expect(nodeEl).toBeTruthy();
    expect(nodeEl.getAttribute('tabIndex')).toBe('0');
  });

  it('在节点上按 Enter → 跳转到该任务', async () => {
    renderGraph('cur');
    const upstream = await screen.findByText('上游任务');
    const nodeEl = upstream.closest('div[role="button"]') as HTMLElement;
    fireEvent.keyDown(nodeEl, { key: 'Enter' });
    expect(navigateMock).toHaveBeenCalledWith('/tasks/up');
  });

  it('在节点上按 Space → 跳转到该任务', async () => {
    renderGraph('cur');
    const upstream = await screen.findByText('上游任务');
    const nodeEl = upstream.closest('div[role="button"]') as HTMLElement;
    fireEvent.keyDown(nodeEl, { key: ' ' });
    expect(navigateMock).toHaveBeenCalledWith('/tasks/up');
  });

  it('当前节点不可聚焦（tabIndex=-1，不响应键盘）', async () => {
    renderGraph('cur');
    const current = await screen.findByText('当前任务');
    const nodeEl = current.closest('div[role="button"], div[tabindex]') as HTMLElement;
    expect(nodeEl).toBeTruthy();
    // 当前节点：role 为 undefined，tabIndex=-1
    expect(nodeEl.getAttribute('role')).toBeNull();
    expect(nodeEl.getAttribute('tabIndex')).toBe('-1');
  });
});
