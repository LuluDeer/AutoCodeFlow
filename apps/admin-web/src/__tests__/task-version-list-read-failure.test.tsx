/**
 * R171（P2-2）：**版本列表读失败 ≠ 没有版本**。
 *
 * ## 缺陷现场（`useTaskVersionRollback.loadVersions`）
 *
 * catch 里只有 `setVersions([])` + 一条 toast ⇒ 版本抽屉立刻落到 Table 的空态
 * 「暂无版本记录」，与「这个任务**真的**没有版本记录」完全同形。
 *
 * 代价不在措辞上：用户打开版本抽屉的场景就是「我想回滚到某个旧版本」。看到
 * 「暂无版本记录」，结论必然是「回滚不了，算了」——而事实是请求失败，
 * 重试一次就有。读失败被渲染成没有数据，直接把一个可用功能读成了不存在。
 *
 * ## 本 spec 钉住四条
 *
 * ① hook 层：`versions` 失败 ⇒ `versionsError` 非空（且列表清空，不串上一个任务的数据）；
 * ② hook 层：成功 ⇒ `versionsError` 为 null（控制组，证明①不是因为「永远失败」）；
 * ③ hook 层：失败后重试成功 ⇒ error 被清掉、列表回来（重试路径真的可用）；
 * ④ 页面层：抽屉里渲染的是 `StateError`（标题「版本列表加载失败」+ 重试），
 *    **不出现**空态「暂无版本记录」；点重试会再次调 `tasksApi.versions`。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { renderHook, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import TaskDetailPage from '../pages/TaskDetailPage';
import { tasksApi } from '../api/tasks';
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
  Link: (props: { to: string; children: React.ReactNode }) => <a href={props.to}>{props.children}</a>,
}));
// 重子组件裁剪：本 spec 只关心版本抽屉的读取失败态。
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

import { useTaskVersionRollback } from '../pages/task-detail/useTaskVersionRollback';

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

const versionOf = (id: string, version: string) => ({
  id,
  taskId: 'task-1',
  version,
  gitCommit: 'abcdef1234567890',
  snapshot: {},
  createdBy: 'alice',
  createdAt: '2026-09-01T08:00:00Z',
});

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <TaskDetailPage />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  cleanup();
  useAuthStore.setState({ user: { id: 1, username: 'root', role: 'admin' } });
  vi.mocked(tasksApi.get).mockReset().mockResolvedValue(BASE_TASK as never);
  vi.mocked(tasksApi.executions).mockReset().mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 20 } as never);
  vi.mocked(tasksApi.stats).mockReset().mockResolvedValue({ recentExecutions: [], successRate: 0, avgDuration: 0, totalRuns: 0 } as never);
  vi.mocked(tasksApi.schedulerStats).mockReset().mockResolvedValue({ healthy: true, activeTimers: 0, activeCronTasks: 0, runningTaskCount: 0, totalScheduledTasks: 0, uptime: 0 } as never);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('R171 P2-2：版本列表读取失败（hook 层）', () => {
  it('① 失败 ⇒ versionsError 非空，列表清空（不串上一个任务的数据）', async () => {
    vi.mocked(tasksApi.versions).mockReset().mockRejectedValue(new Error('502'));

    const { result } = renderHook(() => useTaskVersionRollback('task-1', () => {}));
    act(() => result.current.setVersionDrawerOpen(true));

    await waitFor(() => expect(result.current.versionsError).not.toBeNull());
    expect(result.current.versions).toEqual([]);
  });

  it('② 控制组：成功 ⇒ versionsError 为 null 且列表落地', async () => {
    vi.mocked(tasksApi.versions).mockReset().mockResolvedValue([versionOf('ver-1', 'v1')] as never);

    const { result } = renderHook(() => useTaskVersionRollback('task-1', () => {}));
    act(() => result.current.setVersionDrawerOpen(true));

    await waitFor(() => expect(result.current.versions).toHaveLength(1));
    expect(result.current.versionsError).toBeNull();
  });

  it('③ 失败后重试成功 ⇒ error 清掉、列表回来', async () => {
    vi.mocked(tasksApi.versions)
      .mockReset()
      .mockRejectedValueOnce(new Error('502'))
      .mockResolvedValue([versionOf('ver-2', 'v2')] as never);

    const { result } = renderHook(() => useTaskVersionRollback('task-1', () => {}));
    act(() => result.current.setVersionDrawerOpen(true));
    await waitFor(() => expect(result.current.versionsError).not.toBeNull());

    act(() => result.current.loadVersions());
    // ⚠️ R192：这里**不能**只等 `versionsError` 变 null。
    // `loadVersions` 里 `setVersionsError(null)`（第 159 行）与 `.then(setVersions)`
    // （第 161 行）是**两次独立的 setState** ⇒ React 批处理下 `versionsError` 先变
    // null、`versions` 后落地 ⇒ 「等 error 为 null」会在**列表还没落地**时就满足。
    // CI runner 负载高时这个窗口更宽 ⇒ 该断言偶发红（实测 run 42505853721 的
    // admin-web-build：`expected [] to have a length of 1 but got +0`；本地连跑
    // 3 次全绿 ⇒ 典型 flaky）。
    // ⇒ 等**真正要断言的那个状态**（列表落地），而不是等一个更早的状态。
    await waitFor(() => expect(result.current.versions).toHaveLength(1));
    expect(result.current.versionsError).toBeNull();
  });
});

describe('R171 P2-2：版本抽屉渲染（页面层）', () => {
  it('④ 失败 ⇒ 抽屉显示 StateError「版本列表加载失败」+ 重试，绝不显示「暂无版本记录」', async () => {
    vi.mocked(tasksApi.versions).mockReset().mockRejectedValue(new Error('502'));

    renderPage();
    fireEvent.click(await screen.findByTestId('version-history'));

    // StateError（页内错误块）出现，标题是版本列表的加载失败
    const err = await screen.findByTestId('state-error');
    expect(err.textContent).toContain('版本列表加载失败');
    // 关键：失败不得被渲染成「没有版本」
    expect(screen.queryByText('暂无版本记录')).toBeNull();

    // 重试按钮真的再拉一次（loadVersions 被复用）
    const before = vi.mocked(tasksApi.versions).mock.calls.length;
    fireEvent.click(screen.getByRole('button', { name: /重\s*试/ }));
    await waitFor(() =>
      expect(vi.mocked(tasksApi.versions).mock.calls.length).toBe(before + 1),
    );
  });
});
