/**
 * D-设计审计 2026-09-22 分片A — TaskDetailPage 行为回归。
 *
 * D-P2-03：timeout=0（不限时）此前显示 '-'。改为渲染「不限时」。
 * D-P2-02a：状态行 Badge 在 failed/inactive 时落裸英文 token——复用
 *  taskList.status.* 映射显示中文状态。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import TaskDetailPage from '../pages/TaskDetailPage';
import { tasksApi } from '../api/tasks';

vi.mock('../api/tasks', () => ({
  tasksApi: {
    get: vi.fn(),
    executions: vi.fn(),
    stats: vi.fn(),
    schedulerStats: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    delete: vi.fn(),
    trigger: vi.fn(),
    killExecution: vi.fn(),
  },
}));
vi.mock('../api/ai', () => ({ aiApi: { suggestSchedule: vi.fn() } }));
vi.mock('react-router-dom', () => ({
  useNavigate: () => vi.fn(),
  useParams: () => ({ id: 'task-1' }),
  Link: (props: { to: string; children: React.ReactNode }) => <a href={props.to}>{props.children}</a>,
}));
vi.mock('../components/GlueEditor', () => ({ default: () => <div data-testid="glue-editor" /> }));
vi.mock('../components/TaskDependencyGraph', () => ({
  default: () => <div data-testid="dep-graph" />,
}));
vi.mock('../components/ParamsEditor', () => ({ default: () => <div data-testid="params-editor" /> }));

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

const BASE_TASK = {
  id: 'task-1',
  name: 'timeout-job',
  runtime: 'python',
  entrypoint: 'main.py',
  triggerType: 'cron',
  cronExpression: '*/5 * * * *',
  status: 'active',
  maxRetry: 3,
  timeout: 300,
  params: {},
};

function renderDetail() {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <TaskDetailPage />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.mocked(tasksApi.get).mockReset();
  vi.mocked(tasksApi.executions).mockReset().mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 20 } as never);
  vi.mocked(tasksApi.stats).mockReset().mockResolvedValue({ recentExecutions: [], successRate: 0, avgDuration: 0, totalRuns: 0 } as never);
  vi.mocked(tasksApi.schedulerStats).mockReset().mockResolvedValue({ healthy: true, activeTimers: 0, activeCronTasks: 0, runningTaskCount: 0, totalScheduledTasks: 0, uptime: 0 } as never);
});
afterEach(() => cleanup());

describe('D-P2-03: timeout=0 渲染「不限时」而非 "-"', () => {
  it('timeout=0：超时项显示「不限时」', async () => {
    vi.mocked(tasksApi.get).mockResolvedValue({ ...BASE_TASK, timeout: 0 } as never);
    renderDetail();
    await waitFor(() => expect(screen.getAllByText('timeout-job').length).toBeGreaterThan(0));
    expect(screen.getByText('不限时')).toBeTruthy();
  });

  it('timeout=300：仍显示秒数（行为不变）', async () => {
    vi.mocked(tasksApi.get).mockResolvedValue({ ...BASE_TASK, timeout: 300 } as never);
    renderDetail();
    await waitFor(() => expect(screen.getAllByText('timeout-job').length).toBeGreaterThan(0));
    expect(screen.getByText('300 秒')).toBeTruthy();
  });
});

describe('D-P2-02a: 状态行 Badge 在 failed/inactive 时显示中文状态', () => {
  it('failed 状态显示「失败」，不裸出 failed', async () => {
    vi.mocked(tasksApi.get).mockResolvedValue({ ...BASE_TASK, status: 'failed' } as never);
    renderDetail();
    await waitFor(() => expect(screen.getAllByText('timeout-job').length).toBeGreaterThan(0));
    expect(screen.getByText('失败')).toBeTruthy();
  });

  it('inactive 状态显示「未激活」，不裸出 inactive', async () => {
    vi.mocked(tasksApi.get).mockResolvedValue({ ...BASE_TASK, status: 'inactive' } as never);
    renderDetail();
    await waitFor(() => expect(screen.getAllByText('timeout-job').length).toBeGreaterThan(0));
    expect(screen.getByText('未激活')).toBeTruthy();
  });
});
