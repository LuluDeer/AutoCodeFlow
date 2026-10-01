/**
 * A5（第二轮审计）：任务详情页「版本历史」Drawer 功能空洞补齐回归。
 *
 * 后端 versions / rollbackToVersion / compareVersions 三端点此前前端零调用。
 * 本 spec 钉住三条链路：
 *   ① 列表渲染：版本号 / 时间 / 创建者可见，每行有「回滚到此版本」按钮；
 *   ② 两版对比：勾选两个版本 → compareVersions → diff 键值表（旧值/新值）；
 *   ③ 回滚确认：点「回滚到此版本」先出确认 Modal（说明覆盖影响），确认后才
 *      调 rollbackToVersion，成功后刷新版本列表（versions 被再次拉取）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import TaskDetailPage from '../pages/TaskDetailPage';
import { tasksApi, type TaskVersion } from '../api/tasks';
import { useAuthStore } from '../store/auth';

vi.mock('../api/tasks', () => ({
  tasksApi: {
    webhookStatus: vi.fn().mockResolvedValue({ enabled: false, url: '' }),
    get: vi.fn(),
    executions: vi.fn(),
    stats: vi.fn(),
    schedulerStats: vi.fn(),
    versions: vi.fn(),
    compareVersions: vi.fn(),
    rollbackToVersion: vi.fn(),
    killExecution: vi.fn(),
  },
}));
vi.mock('../api/ai', () => ({ aiApi: { suggestSchedule: vi.fn() } }));
vi.mock('react-router-dom', () => ({
  useNavigate: () => vi.fn(),
  useParams: () => ({ id: 'task-1' }),
  // UI-03：页头 PageHeader 面包屑消费 Link——mock 补齐导出（纯锚点桩）
  Link: (props: { to: string; children: React.ReactNode }) => <a href={props.to}>{props.children}</a>,
}));
// 重子组件裁剪：本 spec 只关心版本 Drawer，Glue/DAG/参数编辑器换成桩。
vi.mock('../components/GlueEditor', () => ({ default: () => <div data-testid="glue-editor" /> }));
vi.mock('../components/TaskDependencyGraph', () => ({
  default: () => <div data-testid="dep-graph" />,
}));
vi.mock('../components/ParamsEditor', () => ({ default: () => <div data-testid="params-editor" /> }));

// jsdom 缺失 antd 依赖的浏览器 API（对齐 task-detail-maintenance.test 先例）。
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
  cronExpression: '0 2 * * *',
  status: 'paused',
  maxRetry: 3,
  timeout: 300,
  params: {},
};

const makeVersion = (over: Partial<TaskVersion> = {}): TaskVersion => ({
  id: 'ver-1',
  taskId: 'task-1',
  version: 'v1',
  gitCommit: 'abcdef1234567890',
  snapshot: {},
  createdBy: 'alice',
  createdAt: '2026-09-01T08:00:00Z',
  ...over,
});

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <TaskDetailPage />
    </QueryClientProvider>,
  );
}

const openDrawer = async () => {
  fireEvent.click(await screen.findByTestId('version-history'));
  await waitFor(() =>
    expect(vi.mocked(tasksApi.versions)).toHaveBeenCalledWith('task-1'),
  );
};

beforeEach(() => {
  cleanup();
  // 回滚是写面——页头写按钮统一 admin 门禁，这里以管理员身份渲染。
  useAuthStore.setState({ user: { id: 1, username: 'root', role: 'admin' } });
  vi.mocked(tasksApi.get).mockReset().mockResolvedValue(BASE_TASK as never);
  vi.mocked(tasksApi.executions).mockReset().mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 20 } as never);
  vi.mocked(tasksApi.stats).mockReset().mockResolvedValue({ recentExecutions: [], successRate: 0, avgDuration: 0, totalRuns: 0 } as never);
  vi.mocked(tasksApi.schedulerStats).mockReset().mockResolvedValue({ healthy: true, activeTimers: 0, activeCronTasks: 0, runningTaskCount: 0, totalScheduledTasks: 0, uptime: 0 } as never);
  vi.mocked(tasksApi.rollbackToVersion).mockReset().mockResolvedValue(BASE_TASK as never);
});

afterEach(() => {
  cleanup();
});

describe('TaskDetailPage 版本历史 Drawer（A5）', () => {
  it('列表渲染：版本号 / 时间 / 创建者 / 每行回滚按钮', async () => {
    vi.mocked(tasksApi.versions).mockReset().mockResolvedValue([
      makeVersion({ id: 'ver-2', version: 'v2', createdBy: 'bob', createdAt: '2026-09-02T08:00:00Z' }),
      makeVersion({ id: 'ver-1', version: 'v1', createdBy: 'alice' }),
    ] as never);

    renderPage();
    await openDrawer();

    expect(await screen.findByText('v2')).toBeTruthy();
    expect(screen.getByText('v1')).toBeTruthy();
    expect(screen.getByText('bob')).toBeTruthy();
    expect(screen.getByText('alice')).toBeTruthy();
    // 每行都有回滚入口（带 testid）
    expect(screen.getByTestId('version-rollback-v1')).toBeTruthy();
    expect(screen.getByTestId('version-rollback-v2')).toBeTruthy();
  });

  it('两版对比：勾选两个版本 → diff 键值表展示旧值/新值', async () => {
    vi.mocked(tasksApi.versions).mockReset().mockResolvedValue([
      makeVersion({ id: 'ver-2', version: 'v2' }),
      makeVersion({ id: 'ver-1', version: 'v1' }),
    ] as never);
    vi.mocked(tasksApi.compareVersions).mockReset().mockResolvedValue({
      cronExpression: { old: '0 1 * * *', new: '0 2 * * *' },
    } as never);

    renderPage();
    await openDrawer();

    // 等行真正渲染出来再找勾选框（Drawer 内容挂载 + Table 渲染是异步的）。
    // 注意 antd Drawer 传送门挂在 document.body 而非 render() 的 container，
    // 必须查 document（screen 的 findByText 能找到 v2 也正因如此）。
    expect(await screen.findByText('v2')).toBeTruthy();
    await waitFor(() => {
      expect(
        document.querySelectorAll('input.ant-checkbox-input').length,
      ).toBeGreaterThanOrEqual(3);
    });
    // 勾选两行（checkbox[0] 是表头全选，跳过）
    const boxes = document.querySelectorAll('input.ant-checkbox-input');
    fireEvent.click(boxes[1]);
    fireEvent.click(boxes[2]);

    fireEvent.click(screen.getByTestId('version-compare'));
    expect(vi.mocked(tasksApi.compareVersions)).toHaveBeenCalledWith('task-1', 'ver-2', 'ver-1');

    expect(await screen.findByText('版本差异')).toBeTruthy();
    expect(screen.getByText('cronExpression')).toBeTruthy();
    expect(screen.getByText('0 1 * * *')).toBeTruthy();
    // 「0 2 * * *」同时是任务自身的 cron（信息页签）与 diff 新值——按计数断言
    expect(screen.getAllByText('0 2 * * *').length).toBeGreaterThanOrEqual(1);
  });

  it('回滚：先出确认弹窗（说明影响），确认后调 rollbackToVersion 并刷新列表', async () => {
    vi.mocked(tasksApi.versions).mockReset().mockResolvedValue([
      makeVersion({ id: 'ver-2', version: 'v2' }),
    ] as never);

    renderPage();
    await openDrawer();

    // 未确认前不调回滚
    fireEvent.click(await screen.findByTestId('version-rollback-v2'));
    expect(vi.mocked(tasksApi.rollbackToVersion)).not.toHaveBeenCalled();

    // 确认弹窗出现且带影响说明
    expect(await screen.findByText('确认回滚到 v2 ？')).toBeTruthy();
    expect(screen.getByText(/整体覆盖/)).toBeTruthy();

    fireEvent.click(screen.getByTestId('version-rollback-confirm'));
    await waitFor(() =>
      expect(vi.mocked(tasksApi.rollbackToVersion)).toHaveBeenCalledWith('task-1', 'ver-2'),
    );
    // 成功后刷新版本列表（第二次拉取）
    await waitFor(() => expect(vi.mocked(tasksApi.versions)).toHaveBeenCalledTimes(2));
  });
});
