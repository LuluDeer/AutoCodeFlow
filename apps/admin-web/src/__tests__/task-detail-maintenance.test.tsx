/**
 * FEAT-06: 任务详情页维护窗口展示回归。
 * 配置了 maintenanceWindows 的任务在"任务配置"描述区渲染窗口 Tag
 * （start → end（说明））；未配置时不渲染"维护窗口"项。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
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
}));
// 重子组件裁剪：详情展示只关心 Descriptions 区，Glue/DAG/参数编辑器换成桩。
vi.mock('../components/GlueEditor', () => ({ default: () => <div data-testid="glue-editor" /> }));
vi.mock('../components/TaskDependencyGraph', () => ({
  default: () => <div data-testid="dep-graph" />,
}));
vi.mock('../components/ParamsEditor', () => ({ default: () => <div data-testid="params-editor" /> }));

// jsdom 缺失 antd 依赖的浏览器 API（对齐 task-form-page.test 先例）。
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

const BASE_TASK = {
  id: 'task-1',
  name: 'windowed-job',
  runtime: 'python',
  entrypoint: 'main.py',
  triggerType: 'cron',
  cronExpression: '*/5 * * * *',
  status: 'active',
  maxRetry: 3,
  timeout: 300,
  params: {},
};

beforeEach(() => {
  vi.mocked(tasksApi.get).mockReset();
  vi.mocked(tasksApi.executions).mockReset().mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 20 } as never);
  vi.mocked(tasksApi.stats).mockReset().mockResolvedValue({ recentExecutions: [], successRate: 0, avgDuration: 0, totalRuns: 0 } as never);
  vi.mocked(tasksApi.schedulerStats).mockReset().mockResolvedValue({ healthy: true, activeTimers: 0, activeCronTasks: 0, runningTaskCount: 0, totalScheduledTasks: 0, uptime: 0 } as never);
});

afterEach(() => {
  cleanup();
});

describe('TaskDetailPage 维护窗口展示（FEAT-06）', () => {
  it('配置了窗口：任务配置描述区渲染 start → end（说明）Tag', async () => {
    vi.mocked(tasksApi.get).mockResolvedValue({
      ...BASE_TASK,
      maintenanceWindows: [
        { start: '0 22 * * 5', end: '0 6 * * 6', description: '发布冻结' },
        { start: '30 2 * * *', end: '0 4 * * *' },
      ],
    } as never);

    render(<TaskDetailPage />);
    expect(await screen.findByText('0 22 * * 5 → 0 6 * * 6（发布冻结）')).toBeTruthy();
    expect(screen.getByText('30 2 * * * → 0 4 * * *')).toBeTruthy();
    expect(screen.getByText('维护窗口')).toBeTruthy();
  });

  it('未配置窗口：不渲染"维护窗口"描述项', async () => {
    vi.mocked(tasksApi.get).mockResolvedValue({
      ...BASE_TASK,
      maintenanceWindows: null,
    } as never);

    render(<TaskDetailPage />);
    // 等任务名出现（数据已加载完成）再断言负向
    expect(await screen.findByText('windowed-job')).toBeTruthy();
    expect(screen.queryByText('维护窗口')).toBeNull();
  });

  it('空数组同 null：不渲染"维护窗口"描述项', async () => {
    vi.mocked(tasksApi.get).mockResolvedValue({
      ...BASE_TASK,
      maintenanceWindows: [],
    } as never);

    render(<TaskDetailPage />);
    await waitFor(() => expect(screen.getByText('windowed-job')).toBeTruthy());
    expect(screen.queryByText('维护窗口')).toBeNull();
  });
});
