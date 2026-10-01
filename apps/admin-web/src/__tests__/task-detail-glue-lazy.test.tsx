/**
 * PERF（第四轮审计）— TaskDetailPage 的 GlueEditor 按需加载（React.lazy）。
 *
 * 此前 TaskDetailPage 静态 import GlueEditor（拖带 monaco 的 2.5MB lazy
 * chunk），打开任意任务详情页（哪怕只看「任务配置」Tab）路由加载时都会
 * 预取编辑器 chunk。修复后：
 *  - 首屏（默认 info Tab）不渲染编辑器，也不渲染其 Suspense 占位
 *    （antd Tabs 非激活面板不渲染，动态 import 根本不发起）；
 *  - 切到「Glue 脚本」Tab 才触发动态 import——解析期间展示 Spin 占位，
 *    解析完成后编辑器挂载。
 *
 * GlueEditor 用受控 Promise mock：工厂返回手工 resolve 的 Promise，从而
 * 确定性断言「占位先出现 → chunk 解析完 → 编辑器挂载」的时序。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, act } from '@testing-library/react';
import { fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement } from 'react';
import TaskDetailPage from '../pages/TaskDetailPage';
import { tasksApi } from '../api/tasks';

// 受控的动态 import：factory 返回未 resolve 的 Promise，测试体里按需放行。
// （vi.mock 工厂在首次 import——即点击 Glue Tab 触发 lazy 加载——时才执行。）
let releaseEditor: (mod: { default: React.FC }) => void = () => {};
vi.mock('../components/GlueEditor', () =>
  new Promise((resolve) => {
    releaseEditor = (mod) => resolve(mod);
  }),
);

vi.mock('../api/tasks', () => ({
  tasksApi: {
    webhookStatus: vi.fn().mockResolvedValue({ enabled: false, url: '' }),
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
vi.mock('../components/TaskDependencyGraph', () => ({
  default: () => <div data-testid="dep-graph" />,
}));
vi.mock('../components/ParamsEditor', () => ({ default: () => <div data-testid="params-editor" /> }));

// jsdom 缺浏览器 API——与 design-audit-shard-a-detail.test.tsx 同款 shim
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
  name: 'lazy-glue-job',
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
  vi.mocked(tasksApi.get).mockReset().mockResolvedValue(BASE_TASK as never);
  vi.mocked(tasksApi.executions).mockReset().mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 20 } as never);
  vi.mocked(tasksApi.stats).mockReset().mockResolvedValue({ recentExecutions: [], successRate: 0, avgDuration: 0, totalRuns: 0 } as never);
  vi.mocked(tasksApi.schedulerStats).mockReset().mockResolvedValue({ healthy: true, activeTimers: 0, activeCronTasks: 0, runningTaskCount: 0, totalScheduledTasks: 0, uptime: 0 } as never);
});
afterEach(() => cleanup());

describe('PERF：TaskDetailPage 的 GlueEditor 按需挂载（React.lazy + Suspense）', () => {
  it('首屏（info Tab）不渲染编辑器，也不渲染 Suspense 占位', async () => {
    renderDetail();
    await waitFor(() => expect(screen.getAllByText('lazy-glue-job').length).toBeGreaterThan(0));
    expect(screen.queryByTestId('glue-editor')).toBeNull();
    expect(screen.queryByTestId('glue-editor-fallback')).toBeNull();
  });

  it('切到 Glue Tab：先出现占位，chunk 解析完成后编辑器才挂载', async () => {
    renderDetail();
    await waitFor(() => expect(screen.getAllByText('lazy-glue-job').length).toBeGreaterThan(0));

    // 点击「Glue 脚本」Tab → antd 首次激活该面板 → lazy import 发起 → Suspense 占位
    fireEvent.click(screen.getByRole('tab', { name: /Glue 脚本/ }));
    await waitFor(() => expect(screen.getByTestId('glue-editor-fallback')).toBeTruthy());
    expect(screen.queryByTestId('glue-editor')).toBeNull();

    // 动态 import 完成（受控 Promise 放行）→ 编辑器挂载、占位退场
    await act(async () => {
      releaseEditor({ default: () => createElement('div', { 'data-testid': 'glue-editor' }) });
    });
    await waitFor(() => expect(screen.getByTestId('glue-editor')).toBeTruthy());
    expect(screen.queryByTestId('glue-editor-fallback')).toBeNull();
  });
});
