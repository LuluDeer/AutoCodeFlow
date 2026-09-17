/**
 * FEAT-06: 任务详情页维护窗口展示回归。
 * 配置了 maintenanceWindows 的任务在"任务配置"描述区渲染窗口 Tag
 * （start → end（说明））；未配置时不渲染"维护窗口"项。
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
  // UI-03：TaskDetailPage 页头 PageHeader 面包屑消费 Link——mock 补齐导出（纯锚点桩）
  Link: (props: { to: string; children: React.ReactNode }) => <a href={props.to}>{props.children}</a>,
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

    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <TaskDetailPage />
      </QueryClientProvider>,
    );
    expect(await screen.findByText('0 22 * * 5 → 0 6 * * 6（发布冻结）')).toBeTruthy();
    expect(screen.getByText('30 2 * * * → 0 4 * * *')).toBeTruthy();
    expect(screen.getByText('维护窗口')).toBeTruthy();
  });

  it('未配置窗口：不渲染"维护窗口"描述项', async () => {
    vi.mocked(tasksApi.get).mockResolvedValue({
      ...BASE_TASK,
      maintenanceWindows: null,
    } as never);

    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <TaskDetailPage />
      </QueryClientProvider>,
    );
    // 等任务名出现（数据已加载完成）再断言负向
    // UI-03：任务名现同时出现于页头面包屑与标题，改用 getAllByText 计数 > 0
    expect((await screen.findAllByText('windowed-job')).length).toBeGreaterThan(0);
    expect(screen.queryByText('维护窗口')).toBeNull();
  });

  it('空数组同 null：不渲染"维护窗口"描述项', async () => {
    vi.mocked(tasksApi.get).mockResolvedValue({
      ...BASE_TASK,
      maintenanceWindows: [],
    } as never);

    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <TaskDetailPage />
      </QueryClientProvider>,
    );
    // UI-03：任务名现同时出现于页头面包屑与标题，改用 findAllByText 计数 > 0
    await waitFor(() => expect(screen.getAllByText('windowed-job').length).toBeGreaterThan(0));
    expect(screen.queryByText('维护窗口')).toBeNull();
  });
});

// P2-3：python_task_multiversion 新增的写面字段（runtimeVersion / codeSource）
// 在任务详情读面也要可见——此前只能打开编辑表单才能确认版本声明。
describe('TaskDetailPage Python 版本 / 代码来源读面（P2-3）', () => {
  it('显式声明 3.7 + application_zip：渲染版本 Tag 与本地化代码来源', async () => {
    vi.mocked(tasksApi.get).mockResolvedValue({
      ...BASE_TASK,
      runtimeVersion: '3.7',
      codeSource: 'application_zip',
      applicationId: 'app-1',
    } as never);

    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <TaskDetailPage />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(screen.getAllByText('windowed-job').length).toBeGreaterThan(0));
    expect(screen.getByText('Python 版本')).toBeTruthy();
    expect(screen.getByText('3.7')).toBeTruthy();
    expect(screen.getByText('代码来源')).toBeTruthy();
    expect(screen.getByText('上传的 zip 应用')).toBeTruthy();
  });

  it('未声明版本：显示宿主默认解释器提示；旧任务按 gitRepo 推导代码来源', async () => {
    vi.mocked(tasksApi.get).mockResolvedValue({
      ...BASE_TASK,
      runtimeVersion: null,
      // 旧任务无 codeSource 字段，但带 gitRepo——按迁移同序推导为 Git 仓库
      gitRepo: 'https://example.com/repo.git',
    } as never);

    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <TaskDetailPage />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(screen.getAllByText('windowed-job').length).toBeGreaterThan(0));
    expect(screen.getByText('未声明版本——使用执行器宿主默认解释器。')).toBeTruthy();
    expect(screen.getByText('Git 仓库')).toBeTruthy();
  });

  it('非 python 任务：不渲染 Python 版本行', async () => {
    vi.mocked(tasksApi.get).mockResolvedValue({
      ...BASE_TASK,
      runtime: 'node',
      runtimeVersion: null,
    } as never);

    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <TaskDetailPage />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(screen.getAllByText('windowed-job').length).toBeGreaterThan(0));
    expect(screen.queryByText('Python 版本')).toBeNull();
  });
});
