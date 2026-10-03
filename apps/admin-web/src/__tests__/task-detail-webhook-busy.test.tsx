/**
 * 本轮 UX 打磨回归：TaskDetailPage 任务 webhook 写操作防重复提交。
 * 此前「启用/轮换/停用」无 in-flight 标记，双击会连发两次请求——rotate 尤其
 * 有害：每次调用都吊销旧密钥并签发新密钥，第一发明文弹窗被第二发覆盖后，
 * 用户保存的密钥其实已失效。现以 webhookBusy 互斥串行（任一在途即禁用全部）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import TaskDetailPage from '../pages/TaskDetailPage';
import { useAuthStore } from '../store/auth';
import { tasksApi } from '../api/tasks';

vi.mock('../api/tasks', () => ({
  tasksApi: {
    webhookStatus: vi.fn().mockResolvedValue({ enabled: false, url: '' }),
    get: vi.fn(),
    executions: vi.fn(),
    stats: vi.fn(),
    schedulerStats: vi.fn(),
    webhookEnable: vi.fn(),
    webhookRotate: vi.fn(),
    webhookDisable: vi.fn(),
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
  name: 'hooked-job',
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
  // webhook 写面为管理员操作（P1-5），以管理员身份驱动
  useAuthStore.setState({ user: { id: 1, username: 'root', role: 'admin' } });
  vi.mocked(tasksApi.get).mockReset().mockResolvedValue(BASE_TASK as never);
  vi.mocked(tasksApi.executions).mockReset().mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 20 } as never);
  vi.mocked(tasksApi.stats).mockReset().mockResolvedValue({ recentExecutions: [], successRate: 0, avgDuration: 0, totalRuns: 0 } as never);
  vi.mocked(tasksApi.schedulerStats).mockReset().mockResolvedValue({ healthy: true, activeTimers: 0, activeCronTasks: 0, runningTaskCount: 0, totalScheduledTasks: 0, uptime: 0 } as never);
  vi.mocked(tasksApi.webhookStatus).mockReset().mockResolvedValue({ enabled: false, url: '' } as never);
  vi.mocked(tasksApi.webhookEnable).mockReset();
});

afterEach(() => {
  cleanup();
});

const renderPage = () =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <TaskDetailPage />
    </QueryClientProvider>,
  );

describe('TaskDetailPage webhook 防重复提交（webhookBusy 互斥）', () => {
  it('启用在途期间再点不连发：两次点击只发一次 webhookEnable', async () => {
    // 第一发挂起不 resolve，模拟慢请求
    vi.mocked(tasksApi.webhookEnable).mockImplementation(
      () => new Promise(() => undefined) as never,
    );

    renderPage();
    // antd 双字按钮自动插空格：「启 用」
    const enableBtn = await screen.findByText('启 用');
    fireEvent.click(enableBtn);
    await waitFor(() => expect(tasksApi.webhookEnable).toHaveBeenCalledTimes(1));

    // 在途期间按钮已禁用（互斥），再点不再发出第二次请求
    expect((enableBtn.closest('button') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(enableBtn);
    expect(tasksApi.webhookEnable).toHaveBeenCalledTimes(1);
  });

  it('请求完成后按钮解除互斥，可再次操作', async () => {
    vi.mocked(tasksApi.webhookEnable).mockResolvedValue({ url: 'http://x/hook', secret: 's' } as never);

    renderPage();
    const enableBtn = await screen.findByText('启 用');
    fireEvent.click(enableBtn);
    // 成功后弹出一次性密钥弹窗，按钮解除禁用
    await waitFor(() =>
      expect((enableBtn.closest('button') as HTMLButtonElement).disabled).toBe(false),
    );
    expect(tasksApi.webhookEnable).toHaveBeenCalledTimes(1);
  });
});

describe('TaskDetailPage 任务不存在出口（排查清单 #4）', () => {
  it('任务数据为空时给「返回任务列表」出口，不留死胡同', async () => {
    // React Query 拒绝 undefined（视作查询错误），数据确空用 null 走 Empty 分支
    vi.mocked(tasksApi.get).mockReset().mockResolvedValue(null as never);
    renderPage();
    expect(await screen.findByText('任务不存在')).toBeTruthy();
    expect(screen.getByText('返回任务列表')).toBeTruthy();
  });
});
