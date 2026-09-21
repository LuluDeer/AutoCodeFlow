/**
 * D-设计审计 2026-09-22 分片A — TaskListPage 行为回归。
 *
 * D-P1-1：fixedRate≥60s 二次包裹出「每 2 分钟 秒」。≥60s 分支直接渲染
 *  本地化 label，120s 应渲染为「2 分钟」且不再带「每…秒」尾巴。
 * D-P2-02a：运行时列直出 python/node/shell 裸值——改走 runtimeLabel 映射。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import TaskListPage from '../pages/TaskListPage';
import { tasksApi, type Task } from '../api/tasks';

vi.mock('../api/tasks', async () => {
  const actual = await vi.importActual<typeof import('../api/tasks')>('../api/tasks');
  return {
    summarizeBatch: actual.summarizeBatch,
    tasksApi: {
      list: vi.fn(),
      get: vi.fn(),
      create: vi.fn(),
      delete: vi.fn(),
      trigger: vi.fn(),
      pause: vi.fn(),
      resume: vi.fn(),
      batchTrigger: vi.fn(),
      batchPause: vi.fn(),
      batchResume: vi.fn(),
      batchDelete: vi.fn(),
    },
  };
});
const mockedTasks = vi.mocked(tasksApi, true);

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
    matches: false, media: q, onchange: null,
    addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

const makeTask = (over: Partial<Task> = {}): Task => ({
  id: 'task-1',
  name: '调度任务',
  runtime: 'python',
  entrypoint: 'src/main.py',
  status: 'active',
  triggerType: 'fixed_rate',
  fixedRate: 120,
  maxRetry: 3,
  timeout: 300,
  priority: 2,
  createdAt: '2026-09-01T08:00:00Z',
  updatedAt: '2026-09-07T08:00:00Z',
  ...over,
});

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/tasks']}>
        <Routes>
          <Route path="/tasks" element={<TaskListPage />} />
          <Route path="/tasks/:id" element={<div>task-detail-mock</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => cleanup());

describe('D-P1-1: fixedRate ≥60s 调度列不再二次包裹「每 {{sec}} 秒」', () => {
  it('120s 渲染为「2 分钟」，不带「每…秒」尾巴', async () => {
    mockedTasks.list.mockResolvedValue({
      items: [makeTask({ id: 'fr-120', name: '每两分钟任务', fixedRate: 120 })],
      total: 1, page: 1, pageSize: 20,
    });
    renderPage();
    const name = await screen.findByText('每两分钟任务');
    // 定位所在行，断言调度列文本
    const row = name.closest('.ant-table-row') as HTMLElement;
    expect(row).toBeTruthy();
    // 120s → 「2 分钟」（taskList.schedule.min）
    expect(row.textContent).toContain('2 分钟');
    // 反证：旧 bug 渲染成「每 2 分钟 秒」——不得出现这个尾巴
    expect(row.textContent).not.toContain('每 2 分钟 秒');
    // 调度列不应再出现「每 N 分钟 秒」这类自相矛盾文案
    expect(row.textContent).not.toMatch(/每\s*\d+\s*分钟\s*秒/);
  });

  it('125s 渲染为「2 分 5 秒」，不带尾巴', async () => {
    mockedTasks.list.mockResolvedValue({
      items: [makeTask({ id: 'fr-125', name: '两分五秒任务', fixedRate: 125 })],
      total: 1, page: 1, pageSize: 20,
    });
    renderPage();
    const name = await screen.findByText('两分五秒任务');
    const row = name.closest('.ant-table-row') as HTMLElement;
    expect(row.textContent).toContain('2 分 5 秒');
    expect(row.textContent).not.toContain('每 2 分 5 秒 秒');
  });

  it('<60s 分支仍走「每 N 秒」模板（行为不变）', async () => {
    mockedTasks.list.mockResolvedValue({
      items: [makeTask({ id: 'fr-30', name: '三十秒任务', fixedRate: 30 })],
      total: 1, page: 1, pageSize: 20,
    });
    renderPage();
    const name = await screen.findByText('三十秒任务');
    const row = name.closest('.ant-table-row') as HTMLElement;
    expect(row.textContent).toContain('每 30 秒');
  });
});

describe('D-P2-02a: 运行时列走 runtimeLabel 映射（不裸出枚举）', () => {
  it('python/node/shell 显示本地化标签；未知值回退原始 token', async () => {
    mockedTasks.list.mockResolvedValue({
      items: [
        makeTask({ id: 'r1', name: 'py任务', runtime: 'python' }),
        makeTask({ id: 'r2', name: 'node任务', runtime: 'node' }),
        makeTask({ id: 'r3', name: 'shell任务', runtime: 'shell' }),
        makeTask({ id: 'r4', name: 'java任务', runtime: 'java' }),
      ],
      total: 4, page: 1, pageSize: 20,
    });
    renderPage();
    await screen.findByText('py任务');
    // 本地化标签出现
    expect(screen.getByText('Python')).toBeTruthy();
    expect(screen.getByText('Node.js')).toBeTruthy();
    expect(screen.getByText('Shell')).toBeTruthy();
    // 未知值 java 回退原始 token（不抹掉可诊断信息）
    expect(screen.getByText('java')).toBeTruthy();
  });
});
