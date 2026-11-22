/**
 * UI-09：移动端适配（值班场景三页）回归。
 *
 * jsdom 无布局引擎，响应式断言对齐既有 task-form-anchor 测试形态——
 * 断言「渲染产物」而非视觉：
 *  · MainLayout：汉堡入口/遮罩节点挂载、抽屉开合类名切换、路由跳转自动收起；
 *  · 三页表格：scroll.x 横向滚动兜底 + 次要列 onCell/onHeaderCell 挂
 *    .ui09-hide-mobile 类（index.css @media ≤768px 据此隐藏）；
 *  · index.css：媒体查询规则存在（读源文件文本断言，jsdom 不解析 CSS 文件）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { readFileSync } from 'node:fs';
import MainLayout from '../layouts/MainLayout';
import TaskListPage from '../pages/TaskListPage';
import TaskDetailPage from '../pages/TaskDetailPage';
import ExecutionsPage from '../pages/ExecutionsPage';
import { authApi } from '../api/auth';
import { tasksApi } from '../api/tasks';
import { useAuthStore } from '../store/auth';
import type { Task, TaskExecution } from '../api/tasks';

vi.mock('../api/auth', () => ({ authApi: { me: vi.fn() } }));
vi.mock('../api/tasks', () => ({
  tasksApi: {
    webhookStatus: vi.fn().mockResolvedValue({ enabled: false, url: '' }),
    list: vi.fn(),
    get: vi.fn(),
    executions: vi.fn(),
    stats: vi.fn(),
    schedulerStats: vi.fn(),
    allExecutions: vi.fn(),
    killExecution: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    trigger: vi.fn(),
    delete: vi.fn(),
  },
}));
vi.mock('../api/task-templates', () => ({
  taskTemplatesApi: { list: vi.fn(), get: vi.fn(), create: vi.fn(), remove: vi.fn(), instantiate: vi.fn() },
}));
vi.mock('../api/ai', () => ({ aiApi: { suggestSchedule: vi.fn() } }));
// 重子组件裁剪（对齐 task-detail-maintenance.test 先例）
vi.mock('../components/GlueEditor', () => ({ default: () => <div data-testid="glue-editor" /> }));
vi.mock('../components/TaskDependencyGraph', () => ({ default: () => <div data-testid="dep-graph" /> }));
vi.mock('../components/ParamsEditor', () => ({ default: () => <div data-testid="params-editor" /> }));
vi.mock('../components/ExecutionCompare', () => ({
  COMPARE_MAX: 3,
  ExecutionCompareModal: () => null,
}));

// jsdom 缺失 antd 依赖的浏览器 API（既有先例 shim）
const g = globalThis as Record<string, unknown>;
if (!g.ResizeObserver) {
  g.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}
/** 测试视口切换：useIsMobile 只在挂载时读 matchMedia，故需在 render 前设置 */
function mockMatchMedia(matches: boolean) {
  window.matchMedia = ((q: string) => ({
    matches,
    media: q,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}
if (!window.matchMedia) {
  mockMatchMedia(false);
}
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}

// UI-14: ExecutionsPage 挂 useMetricsStream（SSE）——jsdom 无 EventSource，
// 用 noop 桩（对齐 dashboard-ui04 / execution-detail-sse 先例）
class NoopEventSource {
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) {}
  addEventListener() {}
  close() {}
}

const layoutUser = { id: 1, username: 'alice', role: 'admin' };

const makeTask = (over: Partial<Task> = {}): Task =>
  ({
    id: 'task-1',
    name: '备份任务',
    runtime: 'python',
    entrypoint: 'src/main.py',
    status: 'active',
    triggerType: 'cron',
    cronExpression: '0 2 * * *',
    maxRetry: 3,
    timeout: 300,
    priority: 2,
    createdAt: '2026-09-01T08:00:00Z',
    updatedAt: '2026-09-07T08:00:00Z',
    ...over,
  }) as Task;

const makeExec = (over: Partial<TaskExecution> = {}): TaskExecution =>
  ({
    id: 'exec-1',
    taskId: 'task-1',
    taskName: '备份任务',
    status: 'failed',
    triggerType: 'cron',
    executorAddress: '10.0.0.1:3002',
    startTime: '2026-09-07T10:00:00Z',
    endTime: '2026-09-07T10:01:00Z',
    duration: 60_000,
    errorMessage: 'exit code 1',
    params: null,
    createdAt: '2026-09-07T10:00:00Z',
    ...over,
  }) as TaskExecution;

beforeEach(() => {
  localStorage.clear();
  mockMatchMedia(false);
  vi.stubGlobal('EventSource', NoopEventSource);
  vi.mocked(authApi.me).mockReset().mockRejectedValue(new Error('skip profile'));
  vi.mocked(tasksApi.list).mockReset().mockResolvedValue({ items: [makeTask()], total: 1, page: 1, pageSize: 20 } as never);
  vi.mocked(tasksApi.get).mockReset().mockResolvedValue(makeTask() as never);
  vi.mocked(tasksApi.executions).mockReset().mockResolvedValue({ items: [makeExec()], total: 1, page: 1, pageSize: 20 } as never);
  vi.mocked(tasksApi.stats).mockReset().mockResolvedValue({ recentExecutions: [], successRate: 0, avgDuration: 0, totalRuns: 0 } as never);
  vi.mocked(tasksApi.schedulerStats).mockReset().mockResolvedValue({ healthy: true, activeTimers: 0, activeCronTasks: 0, runningTaskCount: 0, totalScheduledTasks: 0, uptime: 0 } as never);
  vi.mocked(tasksApi.allExecutions).mockReset().mockResolvedValue({ items: [makeExec()], total: 1, page: 1, pageSize: 20 } as never);
  useAuthStore.getState().setAuth('ui09-access', 'ui09-refresh', layoutUser);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  useAuthStore.getState().logout();
});

function renderLayout(path = '/dashboard') {
  // BELL-01：MainLayout 内 NotificationBell 消费 react-query → 需要 provider
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          {/* 具体路由在前，* 兜底 MainLayout（react-router 按序匹配） */}
          <Route path="/tasks" element={<div>tasks-mock</div>} />
          <Route path="*" element={<MainLayout />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function renderPage(node: React.ReactElement, path: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/tasks" element={node} />
          <Route path="/tasks/:id" element={node} />
          <Route path="/executions" element={node} />
          <Route path="/tasks/:taskId/executions/:execId" element={<div>execution-detail-mock</div>} />
          <Route path="/tasks/new" element={<div>task-new-mock</div>} />
          <Route path="/task-templates" element={<div>templates-mock</div>} />
          <Route path="/tasks/:id/edit" element={<div>task-edit-mock</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** 表格横向滚动兜底：scroll.x 落到 rc-table 的 table style（width/minWidth） */
function tableScrollStyle(): CSSStyleDeclaration | null {
  const table = document.querySelector('.ant-table table') as HTMLElement | null;
  return table ? table.style : null;
}

/** 次要列隐藏类：onCell/onHeaderCell 挂到 td/th 的类集合 */
function cellClassSet(): Set<string> {
  const cells = document.querySelectorAll('.ant-table-tbody td, .ant-table-thead th');
  const set = new Set<string>();
  cells.forEach((c) => (c.className || '').split(/\s+/).forEach((cls) => cls && set.add(cls)));
  return set;
}

describe('UI-09 MainLayout 移动端抽屉', () => {
  it('汉堡入口与遮罩节点挂载（桌面端由 CSS display:none 隐藏，节点恒在）', () => {
    renderLayout();
    expect(screen.getByTestId('mobile-menu-toggle')).toBeTruthy();
    expect(screen.getByTestId('mobile-sider-mask')).toBeTruthy();
  });

  it('点击汉堡 → 根 Layout 挂 mobile-sider-open 类；再点收起', () => {
    renderLayout();
    const toggle = screen.getByTestId('mobile-menu-toggle');
    fireEvent.click(toggle);
    const rootLayout = document.querySelector('.ant-layout') as HTMLElement;
    expect(rootLayout.className).toContain('mobile-sider-open');
    fireEvent.click(toggle);
    expect(rootLayout.className).not.toContain('mobile-sider-open');
  });

  it('抽屉展开时点击遮罩收起', () => {
    renderLayout();
    fireEvent.click(screen.getByTestId('mobile-menu-toggle'));
    const rootLayout = document.querySelector('.ant-layout') as HTMLElement;
    expect(rootLayout.className).toContain('mobile-sider-open');
    fireEvent.click(screen.getByTestId('mobile-sider-mask'));
    expect(rootLayout.className).not.toContain('mobile-sider-open');
  });

  it('抽屉展开时选中菜单项导航 → 路由跳转且 MainLayout 卸载（真实路由树中布局常驻，收起由 pathname effect 承担）', async () => {
    // 从控制台起步（MainLayout 兜底渲染），点菜单项导航到 /tasks 桩
    renderLayout('/dashboard');
    fireEvent.click(screen.getByTestId('mobile-menu-toggle'));
    const rootLayout = document.querySelector('.ant-layout') as HTMLElement;
    expect(rootLayout.className).toContain('mobile-sider-open');
    // 展开自动化分组并点击「任务」（antd 菜单可点击节点为 li.ant-menu-item）
    const menu = document.querySelector('.ant-menu') as HTMLElement;
    const groupTitle = Array.from(menu.querySelectorAll<HTMLElement>('.ant-menu-submenu-title'))
      .find((el) => el.textContent === '自动化');
    expect(groupTitle).toBeTruthy();
    fireEvent.click(groupTitle!);
    const item = Array.from(menu.querySelectorAll<HTMLElement>('.ant-menu-title-content'))
      .find((el) => el.textContent === '任务');
    expect(item).toBeTruthy();
    fireEvent.click(item!.closest('li')!);
    // 路由跳转成功（jsdom 测试路由树中 MainLayout 被 /tasks 桩替换——
    // 真实 router.tsx 中 MainLayout 为父路由常驻，pathname effect 收起抽屉）
    await waitFor(() => {
      expect(screen.getByText('tasks-mock')).toBeTruthy();
    });
    expect(document.querySelector('.ant-menu')).toBeNull();
  });
});

describe('UI-09 三页表格移动端产物', () => {
  it('TaskListPage：不再挂固定 scroll.x；缺省辅助列收起不进 DOM（P1-1）', async () => {
    renderPage(<TaskListPage />, '/tasks');
    await screen.findAllByText(/备份\s*任务/);
    const style = tableScrollStyle();
    // P1-1：移除固定 scroll.x=1428 硬塞，表格不挂像素宽，名称列弹性吸收剩余宽度；
    // 辅助列（触发方式/优先级/调度/运行时）缺省收进列设置，不在首屏 DOM。
    expect(style ? style.width : '').toBe('');
    const headers = [...document.querySelectorAll('thead th')].map((th) => th.textContent ?? '');
    expect(headers).toContain('任务名称');
    expect(headers).toContain('上次执行');
    for (const aux of ['触发方式', '优先级', '调度', '运行时']) {
      expect(headers).not.toContain(aux);
    }
  });

  it('TaskDetailPage 执行记录表：scroll.x 兜底 + 次要列挂 ui09-hide-mobile 类', async () => {
    renderPage(<TaskDetailPage />, '/tasks/task-1');
    // 详情页默认落在「任务配置」Tab，切到「执行记录」Tab 后表格才挂载
    fireEvent.click(await screen.findByText(/执行记录/));
    await screen.findByText('exit code 1');
    const style = tableScrollStyle();
    expect(style).toBeTruthy();
    // UI 打磨：scroll.x 与列宽合计校准（原 620 < 固定列合计 630，形同虚设）
    expect(Number.parseFloat(style!.width)).toBe(960);
    const classes = cellClassSet();
    expect(classes.has('ui09-hide-mobile')).toBe(true);
  });

  it('ExecutionsPage：scroll.x 兜底 + 次要列挂 ui09-hide-mobile 类', async () => {
    renderPage(<ExecutionsPage />, '/executions');
    await screen.findAllByText(/备份\s*任务/);
    const style = tableScrollStyle();
    expect(style).toBeTruthy();
    // UI 打磨：scroll.x 与列宽合计校准（固定列 + 两个弹性列最小宽）。
    // 2026-10-23：操作列 135→210（「终止」曾被裁掉一半）后，合计从 1040 上调到 1080。
    expect(Number.parseFloat(style!.width)).toBe(1080);
    const classes = cellClassSet();
    expect(classes.has('ui09-hide-mobile')).toBe(true);
  });
});

describe('UI-09 375px 执行记录卡片', () => {
  it('慢请求在途显示骨架，不闪现空态', async () => {
    mockMatchMedia(true);
    let resolveList: (value: { items: TaskExecution[]; total: number; page: number; pageSize: number }) => void = () => {};
    vi.mocked(tasksApi.allExecutions).mockReset().mockImplementationOnce(
      () => new Promise<{ items: TaskExecution[]; total: number; page: number; pageSize: number }>((resolve) => {
        resolveList = resolve;
      }) as never,
    );

    renderPage(<ExecutionsPage />, '/executions');

    expect(await screen.findByTestId('page-skeleton')).toBeTruthy();
    expect(screen.queryByText('暂无执行记录')).toBeNull();
    expect(screen.queryByText('没有匹配的执行记录')).toBeNull();
    resolveList({ items: [], total: 0, page: 1, pageSize: 20 });
  });

  it('OFFSET 卡片分页点击下一页请求 page=2', async () => {
    mockMatchMedia(true);
    vi.mocked(tasksApi.allExecutions).mockReset().mockImplementation(async (params) => ({
      items: [makeExec({
        id: params?.page === 2 ? 'exec-page2' : 'exec-page1',
        taskName: params?.page === 2 ? '第二页任务' : '备份任务',
      })],
      total: 40,
      page: params?.page ?? 1,
      pageSize: params?.pageSize ?? 20,
    }));

    renderPage(<ExecutionsPage />, '/executions');

    await screen.findByText('备份任务');
    expect(screen.getByText('共 40 条')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /下一页/ }));
    await waitFor(() => {
      expect(vi.mocked(tasksApi.allExecutions).mock.calls.some(([params]) => params?.page === 2)).toBe(true);
    });
    await screen.findByText('第二页任务');
  });

  it('卡片勾选两条后对比按钮出现', async () => {
    mockMatchMedia(true);
    vi.mocked(tasksApi.allExecutions).mockReset().mockResolvedValue({
      items: [makeExec({ id: 'exec-a' }), makeExec({ id: 'exec-b', taskName: '巡检任务' })],
      total: 2,
      page: 1,
      pageSize: 20,
    });

    renderPage(<ExecutionsPage />, '/executions');

    await screen.findByText('巡检任务');
    const boxes = await screen.findAllByRole('checkbox');
    expect(boxes).toHaveLength(2);
    fireEvent.click(boxes[0]);
    fireEvent.click(boxes[1]);

    await waitFor(() => {
      const compare = screen.getByRole('button', { name: /对比/ }) as HTMLButtonElement;
      expect(compare.textContent).toContain('2');
      expect(compare.disabled).toBe(false);
    });
  });
});

describe('UI-09 媒体查询样式源', () => {
  it('index.css 含 ≤768px 媒体查询与关键规则（sider 抽屉/次要列/触控目标/弹窗）', () => {
    // jsdom 不解析 CSS 文件：直接读源文件文本断言规则存在
    const css = readFileSync('src/index.css', 'utf-8');
    expect(css).toContain('@media (max-width: 768px)');
    // 侧边栏抽屉化 + 遮罩
    expect(css).toContain('.mobile-sider-open .ant-layout-sider');
    expect(css).toContain('.mobile-sider-open .mobile-sider-mask');
    // 次要列隐藏
    expect(css).toContain('.ui09-hide-mobile');
    // 触控目标 ≥40px
    expect(css).toContain('min-width: 40px');
    // 弹窗不超屏
    expect(css).toContain('.ant-modal');
    // 头部次要信息隐藏
    expect(css).toContain('.header-time');
    expect(css).toContain('.header-breadcrumb');
  });
});
