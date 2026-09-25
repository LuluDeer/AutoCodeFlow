/**
 * P2-3（UX-AUDIT-2026-09-21）：依赖 DAG 节点状态不得渲染裸枚举。
 *
 * 旧实现：TaskDependencyGraph.tsx 节点 Tag 直接 `{n.status}`——中文用户在排查
 * 依赖链时看到的是英文裸 token（active/paused），而全站别处（TaskListPage 等）
 * 同一状态都已中文化。修法：复用共享词表 taskList.status.* 映射（deleted 另补
 * depGraph.status.deleted），未命中再回退裸值兜底。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
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

describe('P2-3: DAG 节点状态复用共享中文映射（不渲染裸枚举）', () => {
  beforeEach(() => {
    vi.mocked(tasksApi.listAll).mockReset().mockResolvedValue({
      items: [
        task('up', '上游', 'active'),
        task('cur', '当前', 'paused', { d1: 'up' }),
      ],
      total: 2, page: 1, pageSize: 100,
    } as never);
  });

  it('节点 Tag 显示中文状态（已启用/已暂停），不出现裸 active/paused', async () => {
    renderGraph('cur');
    // 旧实现直接渲染 {n.status} → 页面会出现字面 "active"/"paused"
    // SEMANTIC-01：active 中文标签为「已启用」（调度启用态，非「运行中」）
    expect(await screen.findByText('上游')).toBeTruthy();
    expect(screen.getByText('已启用')).toBeTruthy();
    expect(screen.getByText('已暂停')).toBeTruthy();
    // 裸枚举不应出现在节点上
    expect(screen.queryByText('active')).toBeNull();
    expect(screen.queryByText('paused')).toBeNull();
  });
});
