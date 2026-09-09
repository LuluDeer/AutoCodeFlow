/**
 * FEAT-09 回归 + UI-11 动作区：全局搜索 / 命令面板（⌘K / Ctrl+K）。
 *
 * 数据契约（对齐组件头注）：tasks 用 name ILIKE 服务端模糊参数（page/pageSize
 * 分页形态），executors/applications 全量数组，executions 取
 * allExecutions({page:1,pageSize:5})（后端 createdAt DESC = 最近 5 条）。
 * 搜索为客户端包含匹配（小写化）；错误静默降级为组内「加载失败」行；
 * 请求序号守卫防旧响应覆盖（快速换词只落地最新一轮）。
 * UI-11 动作区：静态动作（操作分组，置顶、始终可见、不参与过滤）——
 * 新建任务→/tasks/new、创建应用→/applications（admin-only）；任务行内动作
 * 触发/暂停/恢复按 status 动态出键（isAdmin 门控），语义对齐 TaskListPage。
 * 对齐既有页面测试风格（application-list-rbac / executor-detail-trend）：
 * mock api 层隔离 axios 拦截器 + antd 浏览器 API shim + MemoryRouter。
 * 跳转断言用 LocationProbe 渲染真实 location.pathname（useNavigate 契约）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useState } from 'react';
import { render, screen, cleanup, fireEvent, waitFor, act } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
import CommandPalette from '../components/CommandPalette';
import MainLayout from '../layouts/MainLayout';
import { tasksApi } from '../api/tasks';
import type { TaskExecutionStatus } from '../api/tasks';
import { executorsApi } from '../api/executors';
import { applicationsApi } from '../api/applications';
import { useAuthStore } from '../store/auth';

vi.mock('../api/tasks', () => ({
  tasksApi: {
    list: vi.fn(),
    allExecutions: vi.fn(),
    trigger: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
  },
}));
vi.mock('../api/executors', () => ({
  executorsApi: { list: vi.fn() },
}));
vi.mock('../api/applications', () => ({
  applicationsApi: { list: vi.fn() },
}));
vi.mock('../api/auth', () => ({
  authApi: { me: vi.fn() },
}));
const mockedTasks = vi.mocked(tasksApi, true);
const mockedExecutors = vi.mocked(executorsApi, true);
const mockedApps = vi.mocked(applicationsApi, true);

// jsdom 缺失 antd 依赖的浏览器 API，先行补齐（对齐 settings.ai.test 先例）
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

const PLACEHOLDER = '搜索任务、执行记录、执行器、应用，或输入指令…';

// 四组 fixture 名称均含 'service' —— 单一关键词可同时命中全部分组
const taskFixture = {
  id: 'task-1',
  name: 'Deploy Service',
  status: 'active',
  triggerType: 'cron',
  runtime: 'python',
  entrypoint: 'main.py',
  maxRetry: 0,
  timeout: 60,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};
const pausedTaskFixture = {
  ...taskFixture,
  id: 'task-2',
  name: 'Paused Service',
  status: 'paused',
};
const executionFixture = {
  id: 'exec-1',
  taskId: 'task-9',
  taskName: 'Service Runner',
  status: 'success' as TaskExecutionStatus,
  triggerType: 'manual',
  createdAt: '2026-01-01T00:00:00Z',
};
const executorFixture = {
  id: 'executor-1',
  appName: 'service-executor',
  address: '10.0.0.9:3002',
  status: 'online',
  cpuUsage: 10,
  memUsage: 30,
  runningTaskCount: 0,
  lastHeartbeat: '2026-01-01T00:00:00Z',
};
const appFixture = {
  id: 'app-1',
  name: 'order-service',
  version: '1.0.0',
  runtime: 'node',
  status: 'active',
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};

/** 渲染真实 location.pathname，作为 useNavigate 跳转断言锚点 */
function LocationProbe() {
  const location = useLocation();
  return <div>route:{location.pathname}</div>;
}

/** 面板常开渲染（跳转后不卸载，可连续断言多段路由） */
function renderPalette(initialPath = '/dashboard') {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <CommandPalette open onOpenChange={vi.fn()} />
      <Routes>
        <Route path="/tasks/:id" element={<LocationProbe />} />
        <Route path="/tasks/:taskId/executions/:execId" element={<LocationProbe />} />
        <Route path="/executors/:id" element={<LocationProbe />} />
        <Route path="/applications/:id" element={<LocationProbe />} />
        <Route path="*" element={<LocationProbe />} />
      </Routes>
    </MemoryRouter>,
  );
}

/** 受控开关最小宿主：验证全局快捷键真实翻转 DOM（open=false → true） */
function ToggleHarness({ spy }: { spy: (open: boolean) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <MemoryRouter>
      <CommandPalette
        open={open}
        onOpenChange={(v) => {
          spy(v);
          setOpen(v);
        }}
      />
    </MemoryRouter>
  );
}

const pressCtrlK = () =>
  fireEvent.keyDown(window, { key: 'k', code: 'KeyK', keyCode: 75, ctrlKey: true, bubbles: true });

const getPaletteInput = () =>
  screen.getByPlaceholderText(PLACEHOLDER) as HTMLInputElement;

/** 等待四路结果落地（真实计时器下防抖 300ms + 渲染） */
const waitForResults = async (title: string) => {
  await waitFor(
    () => {
      expect(screen.getByText(title)).toBeTruthy();
    },
    { timeout: 5000 },
  );
};

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
  useAuthStore.setState({ user: { id: 1, username: 'root', role: 'admin' } as never });
  mockedTasks.list.mockResolvedValue({ items: [taskFixture], total: 1, page: 1, pageSize: 50 });
  mockedTasks.allExecutions.mockResolvedValue({
    items: [executionFixture],
    total: 1,
    page: 1,
    pageSize: 5,
  });
  mockedExecutors.list.mockResolvedValue([executorFixture]);
  mockedApps.list.mockResolvedValue([appFixture]);
});

afterEach(() => {
  cleanup();
});

describe('CommandPalette — 快捷键与开关（FEAT-09）', () => {
  it('Ctrl+K 唤起（DOM 可见）；再按切换关闭；Esc 关闭', async () => {
    const spy = vi.fn();
    render(<ToggleHarness spy={spy} />);
    expect(screen.queryByPlaceholderText(PLACEHOLDER)).toBeNull();

    pressCtrlK();
    expect(await screen.findByPlaceholderText(PLACEHOLDER)).toBeTruthy();
    expect(spy).toHaveBeenLastCalledWith(true);

    // 再按一次 → 切换关闭（受控方收到 false）
    pressCtrlK();
    expect(spy).toHaveBeenLastCalledWith(false);

    // Esc 关闭（输入框内触发，显式 onOpenChange(false)）
    pressCtrlK();
    const input = await screen.findByPlaceholderText(PLACEHOLDER);
    fireEvent.keyDown(input, { key: 'Escape', keyCode: 27, bubbles: true });
    expect(spy).toHaveBeenLastCalledWith(false);
  });

  it('Meta+K（⌘K）同样唤起', () => {
    const spy = vi.fn();
    render(<ToggleHarness spy={spy} />);
    fireEvent.keyDown(window, { key: 'k', code: 'KeyK', keyCode: 75, metaKey: true, bubbles: true });
    expect(spy).toHaveBeenCalledWith(true);
  });

  it('MainLayout 全局挂载：头部搜索按钮（tooltip Ctrl K）与 Ctrl+K 均可唤起', async () => {
    useAuthStore.setState({ user: { id: 1, username: 'root', role: 'admin' } as never });
    render(
      <MemoryRouter initialEntries={['/dashboard']}>
        <Routes>
          <Route path="/dashboard" element={<MainLayout />} />
        </Routes>
      </MemoryRouter>,
    );
    // 头部搜索按钮存在，tooltip 提示「Ctrl K」
    const btn = screen.getByRole('button', { name: '全局搜索' });
    fireEvent.mouseEnter(btn);
    expect(await screen.findByText('Ctrl K')).toBeTruthy();
    // 点击行为同快捷键：唤起面板
    fireEvent.click(btn);
    expect(await screen.findByPlaceholderText(PLACEHOLDER)).toBeTruthy();
    // Esc 关闭后 Ctrl+K 仍可再次唤起（window keydown 全局生效）
    fireEvent.keyDown(screen.getByPlaceholderText(PLACEHOLDER), {
      key: 'Escape',
      keyCode: 27,
      bubbles: true,
    });
    pressCtrlK();
    expect(await screen.findByPlaceholderText(PLACEHOLDER)).toBeTruthy();
  });
});

describe('CommandPalette — 分组渲染与跳转', () => {
  it('单一关键词命中四组：分组标题与条目齐全，点击执行器行跳 /executors/:id（操作分组置顶共存）', async () => {
    const { container } = renderPalette();
    const input = getPaletteInput();
    fireEvent.change(input, { target: { value: 'service' } });

    await waitForResults('Deploy Service');
    expect(screen.getByText('Service Runner')).toBeTruthy();
    expect(screen.getByText('service-executor')).toBeTruthy();
    expect(screen.getByText('order-service')).toBeTruthy();
    // 五个分组标题齐全（UI-11：操作分组 + 原四搜索分组）
    expect(screen.getByText('操作')).toBeTruthy();
    expect(screen.getByText('任务')).toBeTruthy();
    expect(screen.getByText('执行记录')).toBeTruthy();
    expect(screen.getByText('执行器')).toBeTruthy();
    expect(screen.getByText('应用')).toBeTruthy();

    fireEvent.click(screen.getByText('service-executor'));
    await waitFor(() => {
      expect(container.textContent).toContain('route:/executors/executor-1');
    });
  });

  it('多组命中时高亮默认第一项（UI-11 动作区置顶 → /tasks/new），↓ 两次后 Enter 跳任务详情', async () => {
    const { container } = renderPalette();
    const input = getPaletteInput();
    fireEvent.change(input, { target: { value: 'service' } });
    await waitForResults('Deploy Service');

    fireEvent.keyDown(input, { key: 'ArrowDown', keyCode: 40, bubbles: true });
    fireEvent.keyDown(input, { key: 'ArrowDown', keyCode: 40, bubbles: true });
    fireEvent.keyDown(input, { key: 'Enter', keyCode: 13, bubbles: true });
    await waitFor(() => {
      expect(container.textContent).toContain('route:/tasks/task-1');
    });
  });

  it('↑↓ 循环导航 + Enter 依次跳转：操作组→任务→执行记录→执行器→应用（UI-11 动作区并入扁平索引）', async () => {
    const { container } = renderPalette();
    const input = getPaletteInput();
    fireEvent.change(input, { target: { value: 'service' } });
    await waitForResults('Deploy Service');

    const key = (k: string) => fireEvent.keyDown(input, { key: k, keyCode: k === 'Enter' ? 13 : 40, bubbles: true });
    // 扁平顺序：操作 admin（0）→ 操作 app（1）→ 任务(2) → 执行记录(3) → 执行器(4) → 应用(5)
    key('ArrowDown');
    key('ArrowDown');
    key('Enter');
    expect(container.textContent).toContain('route:/tasks/task-1');
    // ↓↑↓（覆盖上键）停在第 3 项 → 执行记录
    key('ArrowDown');
    key('ArrowUp');
    key('ArrowDown');
    key('Enter');
    expect(container.textContent).toContain('route:/tasks/task-9/executions/exec-1');
    key('ArrowDown');
    key('Enter');
    expect(container.textContent).toContain('route:/executors/executor-1');
    key('ArrowDown');
    key('Enter');
    expect(container.textContent).toContain('route:/applications/app-1');
  });

  it('每组截断前 5 条', async () => {
    const many = Array.from({ length: 8 }, (_, i) => ({
      ...executorFixture,
      id: `executor-${i}`,
      appName: `bulk-executor-${i}`,
    }));
    mockedTasks.list.mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 50 });
    mockedExecutors.list.mockResolvedValue(many);
    mockedApps.list.mockResolvedValue([]);

    renderPalette();
    const input = getPaletteInput();
    fireEvent.change(input, { target: { value: 'bulk' } });

    await waitForResults('bulk-executor-0');
    expect(screen.getByText('bulk-executor-4')).toBeTruthy();
    expect(screen.queryByText('bulk-executor-5')).toBeNull();
    expect(screen.queryByText('bulk-executor-7')).toBeNull();
  });

  it('UI-11 静态动作：零输入即可见（操作分组不参与过滤），键盘 Enter 直达新建任务', async () => {
    const { container } = renderPalette();
    const input = getPaletteInput();
    // 不输入任何关键词：操作分组照常渲染（原搜索四组隐藏）
    expect(screen.getByText('新建任务')).toBeTruthy();
    expect(screen.getByText('创建应用')).toBeTruthy();
    expect(screen.queryByText('任务')).toBeNull();

    // 高亮默认第一项=新建任务，Enter 直接跳 /tasks/new
    fireEvent.keyDown(input, { key: 'Enter', keyCode: 13, bubbles: true });
    await waitFor(() => {
      expect(container.textContent).toContain('route:/tasks/new');
    });
  });

  it('UI-11 静态动作：点击创建应用跳 /applications；普通用户（role=user）该动作隐藏', async () => {
    const { container } = renderPalette('/tasks');
    fireEvent.click(screen.getByText('创建应用'));
    await waitFor(() => {
      expect(container.textContent).toContain('route:/applications');
    });

    cleanup();
    useAuthStore.setState({ user: { id: 2, username: 'dev', role: 'user' } as never });
    renderPalette();
    // role 缺失按非 admin（isAdminUser 守卫）
    expect(screen.getByText('新建任务')).toBeTruthy();
    expect(screen.queryByText('创建应用')).toBeNull();

    // 旧 localStorage 会话（user 无 role）同样按非 admin
    cleanup();
    useAuthStore.setState({ user: { id: 3, username: 'legacy' } as never });
    renderPalette();
    expect(screen.getByText('新建任务')).toBeTruthy();
    expect(screen.queryByText('创建应用')).toBeNull();
  });

  it('UI-11 任务行内动作：active 任务出「触发/暂停」，paused 任务出「触发/恢复」；点击触发调 API 且跳详情', async () => {
    mockedTasks.list.mockResolvedValue({
      items: [taskFixture, pausedTaskFixture],
      total: 2,
      page: 1,
      pageSize: 50,
    });
    const { container } = renderPalette();
    const input = getPaletteInput();
    fireEvent.change(input, { target: { value: 'service' } });

    await waitForResults('Deploy Service');
    expect(screen.getByText('Paused Service')).toBeTruthy();
    // active → 触发+暂停；paused → 触发+恢复
    expect(screen.getByLabelText('触发任务 Deploy Service')).toBeTruthy();
    expect(screen.getByLabelText('暂停任务 Deploy Service')).toBeTruthy();
    expect(screen.queryByLabelText('恢复任务 Deploy Service')).toBeNull();
    expect(screen.getByLabelText('触发任务 Paused Service')).toBeTruthy();
    expect(screen.getByLabelText('恢复任务 Paused Service')).toBeTruthy();
    expect(screen.queryByLabelText('暂停任务 Paused Service')).toBeNull();

    fireEvent.click(screen.getByLabelText('触发任务 Deploy Service'));
    await waitFor(() => {
      expect(mockedTasks.trigger).toHaveBeenCalledWith('task-1');
    });
    await waitFor(() => {
      expect(container.textContent).toContain('route:/tasks/task-1');
    });
  });

  it('UI-11 行内动作：暂停/恢复各调对应端点并提示；失败 toast 兜底不跳转', async () => {
    const { container } = renderPalette();
    const input = getPaletteInput();
    fireEvent.change(input, { target: { value: 'service' } });
    await waitForResults('Deploy Service');

    fireEvent.click(screen.getByLabelText('暂停任务 Deploy Service'));
    await waitFor(() => {
      expect(mockedTasks.pause).toHaveBeenCalledWith('task-1');
    });
    await waitFor(() => {
      expect(container.textContent).toContain('route:/tasks/task-1');
    });

    cleanup();
    // Axios 形态错误（err.response.data.message）→ toast 展示后端文案
    mockedTasks.trigger.mockRejectedValueOnce({
      response: { data: { message: '触发失败' } },
    } as never);
    renderPalette();
    const input2 = getPaletteInput();
    fireEvent.change(input2, { target: { value: 'service' } });
    await waitForResults('Deploy Service');
    fireEvent.click(screen.getByLabelText('触发任务 Deploy Service'));
    await waitFor(() => {
      expect(screen.getByText('触发失败')).toBeTruthy();
    });
    // 失败不跳转（面板 Modal 挂 body，container 仅含初始路由探针仍为空即未跳转）
    expect(container.textContent).not.toContain('route:/tasks/task-1');
  });

  it('UI-11 行内动作普通用户不可见（isAdmin 门控），Enter 落在任务行仍正常跳详情', async () => {
    useAuthStore.setState({ user: { id: 2, username: 'dev', role: 'user' } as never });
    const { container } = renderPalette();
    const input = getPaletteInput();
    fireEvent.change(input, { target: { value: 'service' } });
    await waitForResults('Deploy Service');

    expect(screen.queryByLabelText('触发任务 Deploy Service')).toBeNull();
    expect(screen.queryByLabelText('暂停任务 Deploy Service')).toBeNull();

    // 动作区只余新建任务一项 → 任务行扁平索引 1，↓ 后 Enter 跳 /tasks/:id
    fireEvent.keyDown(input, { key: 'ArrowDown', keyCode: 40, bubbles: true });
    fireEvent.keyDown(input, { key: 'Enter', keyCode: 13, bubbles: true });
    await waitFor(() => {
      expect(container.textContent).toContain('route:/tasks/task-1');
    });
  });

  it('UI-11 输入框聚焦时按其他键不误触全局快捷键（非 ⌘K 键零副作用）', async () => {
    const spy = vi.fn();
    render(
      <MemoryRouter>
        <CommandPalette
          open
          onOpenChange={(v) => {
            spy(v);
          }}
        />
      </MemoryRouter>,
    );
    const input = getPaletteInput();
    input.focus();
    // 输入普通字符（无修饰键）：不触发开关、不关闭面板
    fireEvent.keyDown(input, { key: 'a', keyCode: 65, bubbles: true });
    fireEvent.keyDown(input, { key: 'ArrowDown', keyCode: 40, bubbles: true });
    expect(spy).not.toHaveBeenCalled();
    expect(getPaletteInput()).toBeTruthy();
    // ⌘K（metaKey）在输入框内同样可切换关闭（toggle 语义）
    fireEvent.keyDown(window, { key: 'k', code: 'KeyK', keyCode: 75, metaKey: true, bubbles: true });
    expect(spy).toHaveBeenCalledWith(false);
  });
});

describe('CommandPalette — 数据流（防抖 / 降级 / 守卫）', () => {
  it('防抖 300ms：停顿前不请求，停顿后四路各恰好一次；继续输入重启计时', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    try {
      renderPalette();
      const input = getPaletteInput();
      fireEvent.change(input, { target: { value: 'deploy' } });
      // 防抖窗口内不发请求
      expect(mockedTasks.list).not.toHaveBeenCalled();
      expect(mockedExecutors.list).not.toHaveBeenCalled();
      act(() => {
        vi.advanceTimersByTime(300);
      });
      // 四路并行各恰好 1 次；tasks 携带服务端模糊参数与分页形态
      expect(mockedTasks.list).toHaveBeenCalledTimes(1);
      expect(mockedTasks.list).toHaveBeenCalledWith({ page: 1, pageSize: 50, name: 'deploy' });
      expect(mockedExecutors.list).toHaveBeenCalledTimes(1);
      expect(mockedExecutors.list).toHaveBeenCalledWith();
      expect(mockedApps.list).toHaveBeenCalledTimes(1);
      expect(mockedTasks.allExecutions).toHaveBeenCalledTimes(1);
      expect(mockedTasks.allExecutions).toHaveBeenCalledWith({ page: 1, pageSize: 5 });

      // 未停顿 300ms：不叠加请求
      fireEvent.change(input, { target: { value: 'deploy-x' } });
      act(() => {
        vi.advanceTimersByTime(299);
      });
      expect(mockedTasks.list).toHaveBeenCalledTimes(1);
      act(() => {
        vi.advanceTimersByTime(1);
      });
      expect(mockedTasks.list).toHaveBeenCalledTimes(2);
      expect(mockedTasks.list).toHaveBeenLastCalledWith({ page: 1, pageSize: 50, name: 'deploy-x' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('单组失败静默降级：该组显示「加载失败」，其余组正常渲染', async () => {
    mockedExecutors.list.mockRejectedValue(new Error('boom'));
    renderPalette();
    const input = getPaletteInput();
    fireEvent.change(input, { target: { value: 'service' } });

    await waitFor(
      () => {
        expect(screen.getByText('执行器加载失败')).toBeTruthy();
      },
      { timeout: 5000 },
    );
    // 其余组不受阻塞
    expect(screen.getByText('Deploy Service')).toBeTruthy();
    expect(screen.getByText('order-service')).toBeTruthy();
    expect(screen.getByText('Service Runner')).toBeTruthy();
  });

  it('关键词清空后回到空闲态：旧结果清空、不再发起新请求', async () => {
    renderPalette();
    const input = getPaletteInput();
    fireEvent.change(input, { target: { value: 'service' } });
    await waitForResults('Deploy Service');

    fireEvent.change(input, { target: { value: '' } });
    await waitFor(
      () => {
        expect(screen.queryByText('Deploy Service')).toBeNull();
      },
      { timeout: 5000 },
    );
    expect(mockedTasks.list).toHaveBeenCalledTimes(1);
  });

  it('序号守卫：快速换词后旧响应不覆盖新结果', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    try {
      let resolveOld!: (v: unknown) => void;
      let resolveNew!: (v: unknown) => void;
      mockedTasks.list
        .mockImplementationOnce(
          () =>
            new Promise((res) => {
              resolveOld = res;
            }) as never,
        )
        .mockImplementationOnce(
          () =>
            new Promise((res) => {
              resolveNew = res;
            }) as never,
        );
      mockedTasks.allExecutions.mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 5 });
      mockedExecutors.list.mockResolvedValue([]);
      mockedApps.list.mockResolvedValue([]);

      renderPalette();
      const input = getPaletteInput();

      // 第一轮（tasks 慢响应挂起，其余组空数据落地）
      fireEvent.change(input, { target: { value: 'first' } });
      act(() => {
        vi.advanceTimersByTime(300);
      });
      expect(resolveOld).toBeDefined();
      // 第二轮换词
      fireEvent.change(input, { target: { value: 'second' } });
      act(() => {
        vi.advanceTimersByTime(300);
      });
      expect(resolveNew).toBeDefined();

      // 旧响应此刻才到：必须被序号守卫丢弃（其名称含当前关键词，
      // 若守卫失效会被客户端过滤放行渲染，断言不空转）
      await act(async () => {
        resolveOld({
          items: [{ ...taskFixture, id: 'task-old', name: 'stale-second-task' }],
          total: 1,
          page: 1,
          pageSize: 50,
        });
        await Promise.resolve();
      });
      expect(screen.queryByText('stale-second-task')).toBeNull();

      // 新响应正常落地
      await act(async () => {
        resolveNew({
          items: [{ ...taskFixture, id: 'task-new', name: 'second-new-task' }],
          total: 1,
          page: 1,
          pageSize: 50,
        });
        await Promise.resolve();
      });
      expect(screen.getByText('second-new-task')).toBeTruthy();
      expect(screen.queryByText('stale-second-task')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
