/**
 * F-41（UIUX 审计 P1-2）：任务详情页错误态分流回归。
 *
 * 后端修复前，坏 id 深链（/tasks/999999）返回 500 + errorCode:null，页面只有
 * 「任务详情加载失败 + 重试」一种形态且整组请求重试。后端映射为 400/404 后，
 * 页面按确定性分流：
 *   - 404（任务不存在/已删除）→ 「任务不存在」空态 + 返回列表（重试不可能成功）；
 *   - 5xx/网络错误 → 「任务详情加载失败 + 重试」（可恢复，保留重试入口）。
 * 配套的请求次数上限（4xx 零重试、500 不再重试）钉在 client.test.ts 的
 * DR-06 重试矩阵。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import TaskDetailPage from '../pages/TaskDetailPage';
import { tasksApi } from '../api/tasks';

vi.mock('../api/tasks', () => ({
  tasksApi: {
    webhookStatus: vi.fn().mockResolvedValue({ enabled: false, url: '' }),
    get: vi.fn(),
    executions: vi.fn().mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 20 }),
    stats: vi.fn().mockResolvedValue({ recentExecutions: [], successRate: 0, avgDuration: 0, totalRuns: 0 }),
    schedulerStats: vi.fn().mockResolvedValue({ healthy: true, activeTimers: 0, activeCronTasks: 0, runningTaskCount: 0, totalScheduledTasks: 0, uptime: 0 }),
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
vi.mock('../components/TaskDependencyGraph', () => ({ default: () => <div data-testid="dep-graph" /> }));
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

const renderPage = () =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <TaskDetailPage />
    </QueryClientProvider>,
  );

beforeEach(() => {
  vi.mocked(tasksApi.webhookStatus).mockReset().mockResolvedValue({ enabled: false, url: '' } as never);
});

afterEach(() => {
  cleanup();
});

describe('F-41 详情页错误态分流（404 空态 / 5xx 可重试）', () => {
  it('404（__status=404，TASK_NOT_FOUND）→「任务不存在」空态，不渲染「加载失败/重试」', async () => {
    // client.ts 拦截器 reject 的是响应体对象并打 __status 标（isNotFoundError 的判据）
    vi.mocked(tasksApi.get).mockRejectedValue({
      code: 404,
      errorCode: 'TASK_NOT_FOUND',
      message: '任务 task-1 不存在',
      params: null,
      __status: 404,
    } as never);
    renderPage();

    const notFound = await screen.findByText('任务不存在');
    expect(notFound).toBeTruthy();
    expect(screen.getByRole('button', { name: '返回任务列表' })).toBeTruthy();
    expect(screen.queryByText('任务详情加载失败')).toBeNull();
    expect(screen.queryByRole('button', { name: '重试' })).toBeNull();
  });

  it('500 →「任务详情加载失败」+ 重试入口（可恢复故障保留重试）', async () => {
    vi.mocked(tasksApi.get).mockRejectedValue({
      code: 500,
      errorCode: null,
      message: '服务器内部错误',
      params: null,
      __status: 500,
    } as never);
    renderPage();

    const failed = await screen.findByText('任务详情加载失败');
    expect(failed).toBeTruthy();
    // antd Button 的 icon（ReloadOutlined 的 role="img" aria-label="reload"）
    // 会进 accessible name，故用正则匹配「重试」文本。
    expect(screen.getByRole('button', { name: /重试/ })).toBeTruthy();
    expect(screen.queryByText('任务不存在')).toBeNull();
  });
});
