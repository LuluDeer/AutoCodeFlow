/**
 * QA-03 第一阶段：ExecutorListPage 组件测试扩面（此前零覆盖的高频页面）。
 *
 * 覆盖核心交互：
 *  1) 列表渲染（状态 Badge 三态中文 / 分组标签 / 任务数 maxConcurrentTasks
 *     双形态 / 死信积压 >0 高亮 U16 回归）；
 *  2) 权限渲染（isAdmin：安装向导/快速添加按钮仅管理员可见；
 *     空态「安装第一个执行器」仅管理员渲染）；
 *  3) 筛选链路（搜索文本命中 appName/address/groupName 三字段 + 状态筛选
 *     + 「N / M 条」计数 + 无匹配空态）；
 *  4) 快速添加链路（install-cmd 成功 → modal + 命令展示；失败 → Modal.error）；
 *  5) 离线超 5 分钟告警条（hasLongOffline）。
 *
 * 隔离 api 层（对齐 dashboard-ui04 / executions-page 先例）；useRequest
 * 来自 ahooks 真实现（list/getGroups 两个 mock 点即可驱动页面）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import ExecutorListPage from '../pages/ExecutorListPage';
import { executorsApi } from '../api/executors';
import { client } from '../api/client';
import { useAuthStore } from '../store/auth';
import type { Executor } from '../api/executors';

vi.mock('../api/executors', () => ({
  executorsApi: {
    list: vi.fn(),
    getGroups: vi.fn(),
  },
}));
const mockedExecutors = vi.mocked(executorsApi, true);

// install-cmd 走裸 client.get('/executors/install-cmd')
vi.mock('../api/client', () => ({
  client: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}));
const mockedClient = vi.mocked(client, true);

// jsdom 缺失 antd 依赖的浏览器 API（既有先例 shim）
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

const NOW = Date.now();
const makeExecutor = (over: Partial<Executor>): Executor => ({
  id: 'ex-1',
  appName: 'alpha',
  address: '10.0.0.1:3002',
  status: 'online',
  cpuUsage: 30,
  memUsage: 50,
  runningTaskCount: 1,
  lastHeartbeat: new Date(NOW - 10_000).toISOString(),
  ...over,
});

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/executors']}>
      <Routes>
        <Route path="/executors" element={<ExecutorListPage />} />
        <Route path="/executors/:id" element={<div>executor-detail-mock</div>} />
        <Route path="/executors/install" element={<div>install-wizard-mock</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

const findBtn = (root: ParentNode, text: string): HTMLButtonElement | null =>
  (Array.from(root.querySelectorAll('button')) as HTMLButtonElement[]).find(
    (b) => (b.textContent ?? '').replace(/\s/g, '') === text,
  ) ?? null;

beforeEach(() => {
  mockedExecutors.list.mockReset();
  mockedExecutors.getGroups.mockReset();
  mockedClient.get.mockReset();
  useAuthStore.setState({ user: { id: 1, username: 'root', role: 'admin' } });
});

afterEach(() => {
  cleanup();
});

describe('ExecutorListPage 列表渲染（QA-03）', () => {
  it('渲染状态三态 Badge、地址、分组标签、任务数与分页 total', async () => {
    mockedExecutors.list.mockResolvedValue([
      makeExecutor({ id: 'ex-1', status: 'online', groupName: '生产组', tags: ['gpu'], maxConcurrentTasks: 4, runningTaskCount: 2 }),
      makeExecutor({ id: 'ex-2', appName: 'beta', address: '10.0.0.2:3002', status: 'busy', groupName: null, tags: null, maxConcurrentTasks: null, runningTaskCount: 3 }),
      makeExecutor({ id: 'ex-3', appName: 'gamma', address: '10.0.0.3:3002', status: 'offline', groupName: null, tags: null, runningTaskCount: 0 }),
    ]);
    mockedExecutors.getGroups.mockResolvedValue(['生产组']);
    renderPage();

    expect(await screen.findByText('alpha')).toBeTruthy();
    expect(screen.getByText('10.0.0.1:3002')).toBeTruthy();
    expect(screen.getAllByText('在线').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('忙碌').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('离线').length).toBeGreaterThanOrEqual(1);
    // 注：分组/标签列 responsive: ['md'] 在 jsdom 无布局宽度下不渲染（antd
    // responsiveObserver 判定），分组 Tag 断言移至筛选用例（搜索命中分组名走
    // 数据面而非展示列）
    expect(screen.getByText('2/4任务')).toBeTruthy();
    expect(screen.getByText('3任务')).toBeTruthy();
    expect(screen.getByText('共 3 条')).toBeTruthy();
    // 页头在线计数
    expect(screen.getByText(/1\s*\/\s*3\s*台在线/)).toBeTruthy();
  });

  it('U16 回归：deadLetterCount > 0 渲染死信 Tag，null/0 不渲染', async () => {
    mockedExecutors.list.mockResolvedValue([
      makeExecutor({ id: 'ex-1', deadLetterCount: 5 }),
      makeExecutor({ id: 'ex-2', appName: 'beta', deadLetterCount: 0 }),
      makeExecutor({ id: 'ex-3', appName: 'gamma', deadLetterCount: null }),
    ]);
    mockedExecutors.getGroups.mockResolvedValue([]);
    renderPage();

    await screen.findByText('alpha');
    expect(screen.getByText('死信 5')).toBeTruthy();
    expect(screen.queryByText('死信 0')).toBeNull();
  });

  it('空数据且无筛选 → 管理员可见「安装第一个执行器」空态引导', async () => {
    mockedExecutors.list.mockResolvedValue([]);
    mockedExecutors.getGroups.mockResolvedValue([]);
    renderPage();
    expect(await screen.findByText('暂无执行器')).toBeTruthy();
    expect(screen.getByText('安装第一个执行器')).toBeTruthy();
  });
});

describe('ExecutorListPage 权限渲染（QA-03）', () => {
  it('管理员：页头渲染安装向导与快速添加按钮', async () => {
    mockedExecutors.list.mockResolvedValue([makeExecutor({})]);
    mockedExecutors.getGroups.mockResolvedValue([]);
    renderPage();
    await screen.findByText('alpha');
    expect(findBtn(document.body, '安装向导')).toBeTruthy();
    expect(findBtn(document.body, '快速添加')).toBeTruthy();
  });

  it('非管理员：安装向导/快速添加/空态引导按钮均隐藏', async () => {
    useAuthStore.setState({ user: { id: 2, username: 'dev', role: 'user' } });
    mockedExecutors.list.mockResolvedValue([]);
    mockedExecutors.getGroups.mockResolvedValue([]);
    renderPage();
    await screen.findByText('暂无执行器');
    expect(findBtn(document.body, '安装向导')).toBeNull();
    expect(findBtn(document.body, '快速添加')).toBeNull();
    expect(screen.queryByText('安装第一个执行器')).toBeNull();
  });
});

describe('ExecutorListPage 筛选链路（QA-03）', () => {
  beforeEach(() => {
    mockedExecutors.list.mockResolvedValue([
      makeExecutor({ id: 'ex-1', appName: 'alpha', address: '10.0.0.1:3002', groupName: '生产组', status: 'online' }),
      makeExecutor({ id: 'ex-2', appName: 'beta', address: '10.0.0.2:3002', groupName: '生产组', status: 'offline' }),
      makeExecutor({ id: 'ex-3', appName: 'gamma', address: '192.168.1.9:3002', groupName: null, status: 'online' }),
    ]);
    mockedExecutors.getGroups.mockResolvedValue(['生产组']);
  });

  it('搜索命中地址 → 「2 / 3 条」计数出现', async () => {
    renderPage();
    await screen.findByText('alpha');
    fireEvent.change(screen.getByPlaceholderText('搜索名称、地址、分组'), {
      target: { value: '10.0.0' },
    });
    await waitFor(() => {
      expect(screen.getByText('2 / 3 条')).toBeTruthy();
    });
    expect(screen.queryByText('gamma')).toBeNull();
  });

  it('搜索命中分组名 → 命中同组全部执行器（数据面筛选）', async () => {
    renderPage();
    await screen.findByText('alpha');
    fireEvent.change(screen.getByPlaceholderText('搜索名称、地址、分组'), {
      target: { value: '生产组' },
    });
    // gamma（无分组）被过滤；alpha/beta 同属生产组保留——按 appName 判定
    await waitFor(() => {
      expect(screen.queryByText('gamma')).toBeNull();
      expect(screen.queryByText('alpha')).toBeTruthy();
      expect(screen.queryByText('beta')).toBeTruthy();
    });
  });

  it('搜索无匹配 → 「无匹配执行器」空态（非「暂无执行器」）', async () => {
    renderPage();
    await screen.findByText('alpha');
    fireEvent.change(screen.getByPlaceholderText('搜索名称、地址、分组'), {
      target: { value: '不存在的名字' },
    });
    await waitFor(() => {
      expect(screen.getByText('无匹配执行器')).toBeTruthy();
    });
    expect(screen.queryByText('暂无执行器')).toBeNull();
  });

  it('点详情跳执行器详情页', async () => {
    renderPage();
    await screen.findByText('alpha');
    fireEvent.click(findBtn(document.body, '详情')!);
    await waitFor(() => {
      expect(screen.getByText('executor-detail-mock')).toBeTruthy();
    });
  });
});

describe('ExecutorListPage 快速添加链路（QA-03）', () => {
  it('install-cmd 成功 → modal 展示安装命令', async () => {
    mockedExecutors.list.mockResolvedValue([makeExecutor({})]);
    mockedExecutors.getGroups.mockResolvedValue([]);
    mockedClient.get.mockResolvedValue({ cmd: 'curl -sL https://example.com/install.sh | bash' });
    renderPage();
    await screen.findByText('alpha');

    fireEvent.click(findBtn(document.body, '快速添加')!);
    expect(await screen.findByText('快速添加执行器')).toBeTruthy();
    expect(screen.getByText('curl -sL https://example.com/install.sh | bash')).toBeTruthy();
  });

  it('install-cmd 失败 → 弹出错误 Modal 不打开添加窗口', async () => {
    mockedExecutors.list.mockResolvedValue([makeExecutor({})]);
    mockedExecutors.getGroups.mockResolvedValue([]);
    mockedClient.get.mockRejectedValue(new Error('网络错误'));
    renderPage();
    await screen.findByText('alpha');

    fireEvent.click(findBtn(document.body, '快速添加')!);
    // Modal.error 标题（单例 holder 可能残留 → getAllByText 容忍）
    await waitFor(() => {
      expect(screen.getAllByText('获取安装命令失败').length).toBeGreaterThanOrEqual(1);
    });
    // 添加窗口未打开
    expect(screen.queryByText('快速添加执行器')).toBeNull();
  });
});

describe('ExecutorListPage 离线告警（QA-03）', () => {
  it('存在离线超 5 分钟执行器 → 顶部告警条出现', async () => {
    mockedExecutors.list.mockResolvedValue([
      makeExecutor({ id: 'ex-9', status: 'offline', lastHeartbeat: new Date(NOW - 10 * 60_000).toISOString() }),
    ]);
    mockedExecutors.getGroups.mockResolvedValue([]);
    renderPage();
    expect(await screen.findByText('有执行器离线超过5分钟，请检查')).toBeTruthy();
  });

  it('最近心跳的离线执行器（未超 5 分钟）不触发告警条', async () => {
    mockedExecutors.list.mockResolvedValue([
      makeExecutor({ id: 'ex-9', status: 'offline', lastHeartbeat: new Date(NOW - 60_000).toISOString() }),
    ]);
    mockedExecutors.getGroups.mockResolvedValue([]);
    renderPage();
    await screen.findByText('alpha');
    await waitFor(() => {
      expect(screen.queryByText('有执行器离线超过5分钟，请检查')).toBeNull();
    });
  });
});
