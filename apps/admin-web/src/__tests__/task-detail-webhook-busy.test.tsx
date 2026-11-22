/**
 * 本轮 UX 打磨回归：TaskDetailPage 任务 webhook 写操作防重复提交。
 * 此前「启用/轮换/停用」无 in-flight 标记，双击会连发两次请求——rotate 尤其
 * 有害：每次调用都吊销旧密钥并签发新密钥，第一发明文弹窗被第二发覆盖后，
 * 用户保存的密钥其实已失效。现以 webhookBusy 互斥串行（任一在途即禁用全部）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, act } from '@testing-library/react';
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
  useBlocker: () => ({ state: 'unblocked' as const, proceed: () => {}, reset: () => {} }),
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

/** 受控 Promise：把 status GET 的落点握在测试手里，验证 busy 与 stale 守卫。 */
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};

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
  vi.mocked(tasksApi.webhookRotate).mockReset();
  vi.mocked(tasksApi.webhookDisable).mockReset();
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

  it('写成功后 GET 未落定前保持互斥，晚到的旧 GET 不能覆盖 enabled=true', async () => {
    const initialGet = deferred<{ enabled: boolean; url: string }>();
    const refreshGet = deferred<{ enabled: boolean; url: string }>();
    vi.mocked(tasksApi.webhookStatus)
      .mockReset()
      .mockImplementationOnce(() => initialGet.promise as never)
      .mockImplementationOnce(() => refreshGet.promise as never)
      .mockResolvedValue({ enabled: true, url: 'http://x/hook' } as never);
    vi.mocked(tasksApi.webhookEnable).mockResolvedValue({ url: 'http://x/hook', secret: 's' } as never);

    renderPage();
    const enableBtn = await screen.findByText('启 用');
    fireEvent.click(enableBtn);

    // 写响应落定：权威状态立刻切成 enabled，但刷新 GET 仍 pending ⇒ 互斥不解除
    const rotateButton = () => screen.getByText('轮换密钥').closest('button') as HTMLButtonElement;
    const rotateBtn = await screen.findByText('轮换密钥');
    expect((rotateBtn.closest('button') as HTMLButtonElement).disabled).toBe(true);
    expect(tasksApi.webhookEnable).toHaveBeenCalledTimes(1);
    // 已切到禁用态的按钮再点不得补发 POST/轮换
    fireEvent.click(rotateBtn);
    expect(tasksApi.webhookRotate).not.toHaveBeenCalled();
    expect(tasksApi.webhookEnable).toHaveBeenCalledTimes(1);
    expect(tasksApi.webhookStatus).toHaveBeenCalledTimes(2);

    // 页面初次加载那次 GET 晚到且回报 disabled：stale 守卫必须丢弃它
    await act(async () => {
      initialGet.resolve({ enabled: false, url: '' });
      await initialGet.promise;
    });
    expect(screen.getByText('已启用')).toBeTruthy();
    expect(rotateButton().disabled).toBe(true);

    // 写后发起的刷新 GET 落定：状态仍为 enabled，互斥解除
    await act(async () => {
      refreshGet.resolve({ enabled: true, url: 'http://x/hook' });
      await refreshGet.promise;
    });
    await waitFor(() => expect(rotateButton().disabled).toBe(false));
    expect(screen.getByText('已启用')).toBeTruthy();
    expect(screen.queryByText('Webhook 状态读取失败')).toBeNull();
    expect(tasksApi.webhookStatus).toHaveBeenCalledTimes(2);
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

/**
 * E4（审计轮 #15）：webhook 状态读取失败必须与「确实未启用」区分。
 *
 * 旧实现 `.catch(() => setWebhookStatus(null))`：已启用的任务在 GET 失败时显示
 * 「未启用 + 启用按钮」，而后端对已启用任务再次 enable 会**轮换密钥**
 * （task.controller.ts:980），误点一次就让外部集成的签名全部 401。
 */
describe('TaskDetailPage webhook 状态未知（读取失败）', () => {
  it('读取失败 → 状态未知 + 不提供启用按钮（防误轮换密钥）', async () => {
    vi.mocked(tasksApi.webhookStatus).mockReset().mockRejectedValue(new Error('boom'));

    renderPage();
    expect(await screen.findByText('Webhook 状态读取失败')).toBeTruthy();
    expect(screen.getByText('状态未知')).toBeTruthy();
    // 「启 用」绝不能出现——那正是会轮换密钥的那个按钮
    expect(screen.queryByText('启 用')).toBeNull();
    // 注意：页面别处也可能出现「未启用」字样，这里只钉 webhook 卡片自身的三态
    // （tag 文案已由上一行断言为「状态未知」）。
  });

  it('点重试后恢复正常三态（已启用 → 显示轮换/停用）', async () => {
    vi.mocked(tasksApi.webhookStatus)
      .mockReset()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({ enabled: true, url: 'http://x/hook' } as never);

    renderPage();
    fireEvent.click(await screen.findByText('重 试'));
    await waitFor(() => expect(screen.getByText('已启用')).toBeTruthy());
    expect(screen.getByText('轮换密钥')).toBeTruthy();
    expect(screen.queryByText('Webhook 状态读取失败')).toBeNull();
  });
});
