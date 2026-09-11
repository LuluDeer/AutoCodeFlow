/**
 * UI-12 无障碍第一阶段：焦点管理与 aria 回归。
 *
 * 覆盖面（严格对应本批两个改动文件）：
 *   MainLayout
 *     · skip-link 与主内容 landmark（键盘用户可跳过整条侧边栏）
 *     · 侧边栏/菜单包进 navigation landmark 并命名
 *     · 头部图标按钮全部具备可访问名（此前纯图标按钮读屏只报「按钮」）
 *     · 用户菜单触发器改为原生 button：可聚焦、Enter 打开、Esc 关闭
 *     · 折叠按钮 / 汉堡按钮的可访问名与 aria-expanded 随态变化
 *     · 移动端遮罩改为原生 button，Esc 关闭后焦点归还汉堡入口
 *   CommandPalette
 *     · 弹层 role=dialog + aria-modal=true + 可访问名（aria-labelledby）
 *     · 打开后焦点进入搜索框
 *     · 组合框语义（role=combobox / aria-controls / aria-expanded）
 *     · ↑↓ 导航时 aria-activedescendant 跟随、aria-selected 同步
 *     · Esc 关闭后焦点归还触发元素
 *
 * 断言纪律：全部为行为断言（getByRole / aria 属性 / focus 归属 / 键盘事件），
 * 不使用快照，不做「元素存在即通过」的弱断言。零新增依赖（无 axe）。
 * 对齐既有页面测试风格：mock api 层隔离 axios、补齐 antd 依赖的浏览器 API。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useState } from 'react';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
import MainLayout from '../layouts/MainLayout';
import CommandPalette from '../components/CommandPalette';
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
vi.mock('../api/executors', () => ({ executorsApi: { list: vi.fn() } }));
vi.mock('../api/applications', () => ({ applicationsApi: { list: vi.fn() } }));
vi.mock('../api/auth', () => ({ authApi: { me: vi.fn() } }));

const mockedTasks = vi.mocked(tasksApi, true);
const mockedExecutors = vi.mocked(executorsApi, true);
const mockedApps = vi.mocked(applicationsApi, true);

// jsdom 缺失 antd 依赖的浏览器 API，先行补齐（对齐 command-palette.test 先例）
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

const SEARCH_PLACEHOLDER = '搜索任务、执行记录、执行器、应用，或输入指令…';

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

/** MainLayout 宿主：带路由探针，可断言导航结果 */
function renderLayout(initialPath = '/dashboard') {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <Routes>
        <Route path="*" element={<MainLayout />} />
      </Routes>
      <LocationProbe />
    </MemoryRouter>,
  );
}

/** 命令面板宿主：真实触发按钮 + 受控 open，用于验证焦点进入/归还 */
function PaletteHarness() {
  const [open, setOpen] = useState(false);
  return (
    <MemoryRouter>
      <button type="button" data-testid="palette-trigger" onClick={() => setOpen(true)}>
        打开搜索面板
      </button>
      <CommandPalette open={open} onOpenChange={setOpen} />
    </MemoryRouter>
  );
}

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
  localStorage.clear();
  useAuthStore.setState({ user: { id: 1, username: 'root', role: 'admin' } as never });
  mockedTasks.list.mockResolvedValue({ items: [taskFixture], total: 1, page: 1, pageSize: 50 });
  mockedTasks.allExecutions.mockResolvedValue({ items: [executionFixture], total: 1, page: 1, pageSize: 5 });
  mockedExecutors.list.mockResolvedValue([executorFixture]);
  mockedApps.list.mockResolvedValue([appFixture]);
});

afterEach(() => {
  cleanup();
});

describe('UI-12 MainLayout — 焦点管理与 aria', () => {
  it('首个 Tab 落在「跳到主要内容」链接，且落点 #main-content 真实存在', async () => {
    const user = userEvent.setup();
    renderLayout();

    await user.tab();
    const skipLink = screen.getByRole('link', { name: '跳到主要内容' });
    expect(document.activeElement).toBe(skipLink);
    expect(skipLink.getAttribute('href')).toBe('#main-content');

    const main = document.getElementById('main-content');
    expect(main).toBeTruthy();
    // tabIndex=-1：可编程聚焦但不进入 Tab 序列（不是键盘陷阱）
    expect(main?.getAttribute('tabindex')).toBe('-1');
  });

  it('侧边栏菜单包进命名 navigation landmark，主导航可被读屏直达', () => {
    renderLayout();
    const nav = screen.getByRole('navigation', { name: '主导航' });
    expect(nav).toBeTruthy();
    expect(nav.querySelector('.ant-menu')).toBeTruthy();
  });

  it('头部图标按钮全部具备可访问名（主题/搜索/帮助/通知/用户菜单）', () => {
    renderLayout();
    expect(screen.getByRole('button', { name: /切换主题/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: '全局搜索' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '帮助文档' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '通知' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '用户菜单' })).toBeTruthy();
  });

  it('页面内不存在无名称按钮（防回归：新增纯图标按钮必须带 aria-label）', () => {
    renderLayout();
    const buttons = Array.from(document.querySelectorAll('button'));
    expect(buttons.length).toBeGreaterThan(0);
    for (const btn of buttons) {
      const name = btn.getAttribute('aria-label') || (btn.textContent ?? '').trim();
      expect(name, `按钮缺少可访问名：${btn.outerHTML.slice(0, 100)}`).toBeTruthy();
    }
  });

  it('用户菜单触发器可聚焦、Enter 键盘打开、Esc 关闭（原为不可聚焦的 div）', async () => {
    const user = userEvent.setup();
    renderLayout();

    const trigger = screen.getByRole('button', { name: '用户菜单' });
    expect(trigger.getAttribute('aria-haspopup')).toBe('menu');
    expect(trigger.getAttribute('aria-expanded')).toBe('false');

    // 可聚焦（原生 button 语义）
    trigger.focus();
    expect(document.activeElement).toBe(trigger);

    // 键盘 Enter 激活 → 菜单展开（侧边栏 antd Menu 同为 role="menu"，
    // 故按内容定位到用户菜单那一个，避免歧义匹配）
    await user.keyboard('{Enter}');
    await waitFor(() => expect(trigger.getAttribute('aria-expanded')).toBe('true'));
    const menus = screen.getAllByRole('menu');
    const userMenu = menus.find((m) => m.textContent?.includes('退出登录'));
    expect(userMenu, '未找到用户下拉菜单（role=menu 且含「退出登录」）').toBeTruthy();
    expect(screen.getByText('退出登录')).toBeTruthy();

    // Esc 关闭
    await user.keyboard('{Escape}');
    await waitFor(() => expect(trigger.getAttribute('aria-expanded')).toBe('false'));
  });

  it('侧边栏折叠按钮：可访问名与 aria-expanded 随折叠态翻转', async () => {
    renderLayout();
    const before = screen.getByRole('button', { name: '收起侧边栏' });
    expect(before.getAttribute('aria-expanded')).toBe('true');

    fireEvent.click(before);
    const after = await screen.findByRole('button', { name: '展开侧边栏' });
    expect(after.getAttribute('aria-expanded')).toBe('false');
  });

  it('Logo 为可聚焦按钮，Enter 键盘触发回控制台导航', async () => {
    const user = userEvent.setup();
    renderLayout('/tasks');
    expect(screen.getByText('route:/tasks')).toBeTruthy();

    const logo = screen.getByRole('button', { name: '返回控制台' });
    logo.focus();
    expect(document.activeElement).toBe(logo);

    await user.keyboard('{Enter}');
    await waitFor(() => expect(screen.getByText('route:/dashboard')).toBeTruthy());
  });

  it('移动端遮罩为按钮；Esc 收起抽屉并把焦点归还汉堡入口', async () => {
    renderLayout();
    const hamburger = screen.getByTestId('mobile-menu-toggle');

    fireEvent.click(hamburger);
    const rootLayout = document.querySelector('.ant-layout') as HTMLElement;
    expect(rootLayout.className).toContain('mobile-sider-open');

    // 遮罩是可聚焦、有名字的按钮（原为裸 div）
    const mask = screen.getByRole('button', { name: '关闭导航菜单' });
    expect(mask).toBe(screen.getByTestId('mobile-sider-mask'));

    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(rootLayout.className).not.toContain('mobile-sider-open'));
    expect(document.activeElement).toBe(hamburger);
  });

  it('汉堡按钮的 aria-label 与 aria-expanded 随抽屉态翻转', () => {
    renderLayout();
    const hamburger = screen.getByTestId('mobile-menu-toggle');
    expect(hamburger.getAttribute('aria-label')).toBe('打开导航菜单');
    expect(hamburger.getAttribute('aria-expanded')).toBe('false');

    fireEvent.click(hamburger);
    expect(hamburger.getAttribute('aria-label')).toBe('收起导航菜单');
    expect(hamburger.getAttribute('aria-expanded')).toBe('true');
  });
});

describe('UI-12 CommandPalette — dialog 语义与焦点', () => {
  it('弹层 role=dialog + aria-modal=true + 可访问名（aria-labelledby）', async () => {
    const user = userEvent.setup();
    render(<PaletteHarness />);
    await user.click(screen.getByTestId('palette-trigger'));

    const dialog = await screen.findByRole('dialog');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    // 有可访问名（此前 closable=false 且无 title，dialog 长期无名）
    const labelledby = dialog.getAttribute('aria-labelledby');
    expect(labelledby).toBeTruthy();
    expect(document.getElementById(labelledby as string)?.textContent).toBe('全局搜索与命令面板');
    expect(screen.getByRole('dialog', { name: '全局搜索与命令面板' })).toBeTruthy();
  });

  it('打开后焦点进入搜索框', async () => {
    const user = userEvent.setup();
    render(<PaletteHarness />);
    await user.click(screen.getByTestId('palette-trigger'));

    const input = await screen.findByPlaceholderText(SEARCH_PLACEHOLDER);
    await waitFor(() => expect(document.activeElement).toBe(input));
  });

  it('搜索框具备组合框语义并与候选列表关联', async () => {
    const user = userEvent.setup();
    render(<PaletteHarness />);
    await user.click(screen.getByTestId('palette-trigger'));

    const input = await screen.findByPlaceholderText(SEARCH_PLACEHOLDER);
    expect(input.getAttribute('role')).toBe('combobox');
    expect(input.getAttribute('aria-autocomplete')).toBe('list');
    expect(input.getAttribute('aria-controls')).toBe('command-palette-listbox');
    expect(input.getAttribute('aria-label')).toBe('搜索任务、执行记录、执行器、应用');

    const listbox = screen.getByRole('listbox', { name: '搜索结果' });
    expect(listbox.getAttribute('id')).toBe('command-palette-listbox');
  });

  it('↑↓ 导航：aria-activedescendant 跟随高亮项，aria-selected 同步', async () => {
    const user = userEvent.setup();
    render(<PaletteHarness />);
    await user.click(screen.getByTestId('palette-trigger'));
    const input = await screen.findByPlaceholderText(SEARCH_PLACEHOLDER);

    // 输入关键词并等待四路结果落地（防抖 300ms + 渲染）
    fireEvent.change(input, { target: { value: 'service' } });
    await waitFor(() => expect(screen.getByText('Deploy Service')).toBeTruthy(), { timeout: 5000 });

    const options = screen.getAllByRole('option');
    expect(options.length).toBeGreaterThan(1);
    for (const opt of options) {
      expect(opt.getAttribute('id')).toBeTruthy();
    }

    // 初始高亮第一项
    expect(input.getAttribute('aria-expanded')).toBe('true');
    expect(input.getAttribute('aria-activedescendant')).toBe(options[0].getAttribute('id'));

    // ↓ 后指向第二项，且 aria-selected 同步
    fireEvent.keyDown(input, { key: 'ArrowDown', keyCode: 40, bubbles: true });
    await waitFor(() =>
      expect(input.getAttribute('aria-activedescendant')).toBe(options[1].getAttribute('id')),
    );
    expect(options[1].getAttribute('aria-selected')).toBe('true');
    expect(options[0].getAttribute('aria-selected')).toBe('false');

    // ↑ 回到第一项
    fireEvent.keyDown(input, { key: 'ArrowUp', keyCode: 38, bubbles: true });
    await waitFor(() =>
      expect(input.getAttribute('aria-activedescendant')).toBe(options[0].getAttribute('id')),
    );
    expect(options[0].getAttribute('aria-selected')).toBe('true');
  });

  it('Esc 关闭后焦点归还触发元素（键盘用户不会掉到 body）', async () => {
    const user = userEvent.setup();
    render(<PaletteHarness />);
    const trigger = screen.getByTestId('palette-trigger');

    await user.click(trigger);
    const input = await screen.findByPlaceholderText(SEARCH_PLACEHOLDER);
    await waitFor(() => expect(document.activeElement).toBe(input));

    // 注：jsdom 下 antd 弹层的退场动画不推进（destroyOnHidden 不生效），
    // 故不断言 DOM 移除，只断言焦点归属——这才是本条要守的行为。
    fireEvent.keyDown(input, { key: 'Escape', keyCode: 27, bubbles: true });
    await waitFor(() => expect(document.activeElement).toBe(trigger));
    expect(document.activeElement).not.toBe(document.body);
  });
});
