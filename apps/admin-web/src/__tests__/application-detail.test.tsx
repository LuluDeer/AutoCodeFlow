/**
 * QA-03 第二阶段：ApplicationDetailPage 组件测试（此前零覆盖）。
 *
 * 覆盖核心交互：
 *  1) 详情加载渲染（页头/概览 Tab 应用信息）与加载失败导航回列表；
 *  2) Tab 切换：关联任务 Tab 加载 tasksApi.list({applicationId})；
 *  3) 版本历史 Tab：列表渲染（版本 Tag/commit 截断/当前版本 Tag/回滚按钮门控）；
 *  4) 回滚链路：非 released 版本按钮禁用、isAdmin=false 禁用、确认回滚
 *     → rollback(id) 精确调用 + 刷新；回滚失败 toast；
 *  5) 同步任务门控：isAdmin=false 同步按钮禁用。
 *
 * mock api 层（applicationsApi/tasksApi/aiApi，ExecutionsPage 先例）；
 * AppDeploymentPage 内部请求已在组件 mock 中整体替换，避免部署页噪音。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, act } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import ApplicationDetailPage from '../pages/ApplicationDetailPage';
import { applicationsApi, type Application, type VersionHistoryEntry } from '../api/applications';
import { tasksApi, type Task } from '../api/tasks';
import { useAuthStore } from '../store/auth';

vi.mock('../api/applications', () => ({
  applicationsApi: {
    get: vi.fn(),
    update: vi.fn(),
    syncTasks: vi.fn(),
    getVersionHistory: vi.fn(),
    rollback: vi.fn(),
  },
}));
vi.mock('../api/tasks', () => ({
  tasksApi: { list: vi.fn() },
}));
vi.mock('../api/ai', () => ({
  aiApi: { analyzeApp: vi.fn() },
}));
// AppDeploymentPage 是部署实例 Tab 的整页子组件（自带 useRequest/deploymentsApi
// 请求与 Modal 链路，已有 app-deployment-race 专项覆盖）——整体替换掉避免噪音。
vi.mock('../pages/AppDeploymentPage', () => ({
  default: () => <div data-testid="app-deployment-mock">deployments-mock</div>,
}));

const mockedApps = vi.mocked(applicationsApi, true);
const mockedTasks = vi.mocked(tasksApi, true);

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
    matches: false, media: q, onchange: null,
    addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

const appFixture: Application = {
  id: 'app-1',
  name: 'demo-app',
  version: '1.2.0',
  runtime: 'python',
  status: 'active',
  description: '演示应用',
  gitRepo: 'https://github.com/acme/demo.git',
  gitBranch: 'main',
  gitCommit: 'abcdef1234567890',
  entrypoint: 'src/main.py',
  createdAt: '2026-09-01T08:00:00Z',
  updatedAt: '2026-09-07T08:00:00Z',
};

const taskFixture: Task = {
  id: 'task-1',
  name: 'demo 任务',
  runtime: 'python',
  entrypoint: 'src/main.py',
  status: 'active',
  triggerType: 'cron',
  cronExpression: '0 2 * * *',
  maxRetry: 3,
  timeout: 300,
  createdAt: '2026-09-01T08:00:00Z',
  updatedAt: '2026-09-07T08:00:00Z',
};

const versionRow = (over: Partial<VersionHistoryEntry> = {}): VersionHistoryEntry => ({
  id: 'ver-1',
  version: '1.2.0',
  commit: 'abcdef1234567890',
  status: 'released',
  executorAddress: '10.0.0.9:3002',
  deployedAt: '2026-09-07T08:00:00Z',
  deploymentId: 'dep-1',
  ...over,
});

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/applications/app-1']}>
      <Routes>
        <Route path="/applications/:id" element={<ApplicationDetailPage />} />
        <Route path="/applications" element={<div>app-list-mock</div>} />
        <Route path="/tasks/new" element={<div>task-form-mock</div>} />
        <Route path="/tasks/:id" element={<div>task-detail-mock</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

/** 版本表回滚按钮（antd 双汉字插空格，textContent 归一化后定位） */
async function findRollbackBtn(): Promise<HTMLButtonElement> {
  await waitFor(() => {
    expect(
      Array.from(document.body.querySelectorAll('button')).filter(
        (b) => (b.textContent ?? '').replace(/\s/g, '') === '回滚',
      ).length,
    ).toBeGreaterThanOrEqual(1);
  });
  return Array.from(document.body.querySelectorAll('button')).find(
    (b) => (b.textContent ?? '').replace(/\s/g, '') === '回滚',
  ) as HTMLButtonElement;
}

/** Popconfirm/Modal.confirm 确认键：弹层最后一个按钮（既有先例） */
async function confirmDialog(titleText: string) {
  // Modal.confirm 弹层挂在 body 级 ant-modal-confirm holder；跨用例残留时标题
  // 文本可能多次命中——取最后一个 holder 的最后一个按钮（最新弹层的 ok 键）。
  await waitFor(() => {
    expect(screen.queryAllByText(titleText).length).toBeGreaterThanOrEqual(1);
  });
  const holders = Array.from(document.body.querySelectorAll('.ant-modal-confirm')) as HTMLElement[];
  const layer = holders.length > 0 ? holders[holders.length - 1] : document.body;
  const layerBtns = Array.from(layer.querySelectorAll('button')) as HTMLButtonElement[];
  const okBtn = layerBtns[layerBtns.length - 1];
  expect(okBtn).toBeTruthy();
  await act(async () => {
    fireEvent.click(okBtn);
  });
}

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
  useAuthStore.setState({ user: { id: 1, username: 'root', role: 'admin' } });
  mockedApps.get.mockResolvedValue(appFixture);
  mockedTasks.list.mockResolvedValue({ items: [taskFixture], total: 1, page: 1, pageSize: 100 });
  mockedApps.getVersionHistory.mockResolvedValue([
    versionRow(),
    versionRow({ id: 'ver-2', version: '1.1.0', commit: '0000001111222233', status: 'stopped', deploymentId: 'dep-2' }),
  ]);
});

afterEach(() => {
  cleanup();
});

describe('ApplicationDetailPage 详情加载（QA-03 第二阶段）', () => {
  it('渲染页头应用名与概览信息（版本/运行时/状态中文/Git 仓库）', async () => {
    renderPage();
    // 页头 title + 面包屑（多命中容忍）
    expect((await screen.findAllByText('demo-app')).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('1.2.0').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('python').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('正常').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText(/github\.com\/acme\/demo\.git/).length).toBeGreaterThanOrEqual(1);
    expect(mockedApps.get).toHaveBeenCalledWith('app-1');
  });

  it('加载失败 → toast 并导航回应用列表', async () => {
    mockedApps.get.mockRejectedValue(new Error('network down'));
    renderPage();
    await waitFor(() => expect(screen.getByText('app-list-mock')).toBeTruthy());
  });

  it('Tab 切换到部署实例 → 渲染部署页子组件', async () => {
    renderPage();
    await screen.findAllByText('demo-app');
    fireEvent.click(screen.getByText(/部署实例/));
    await waitFor(() => expect(screen.getByTestId('app-deployment-mock')).toBeTruthy());
  });
});

describe('ApplicationDetailPage 关联任务 Tab（QA-03 第二阶段）', () => {
  it('渲染关联任务列表（任务名/状态/触发）并带 applicationId 查询', async () => {
    renderPage();
    await screen.findAllByText('demo-app');
    fireEvent.click(screen.getByText('关联任务'));
    await waitFor(() => {
      expect(mockedTasks.list).toHaveBeenCalledWith(
        expect.objectContaining({ applicationId: 'app-1' }),
      );
    });
    expect(screen.getAllByText(/demo\s*任务/).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('运行中').length).toBeGreaterThanOrEqual(1);
  });

  it('ADMIN 可见「同步任务」按钮；成功后提示同步数量', async () => {
    mockedApps.syncTasks.mockResolvedValue({ ok: true, registeredCount: 4 });
    renderPage();
    await screen.findAllByText('demo-app');
    fireEvent.click(screen.getByText('关联任务'));
    const syncBtn = await screen.findByText('同步任务');
    fireEvent.mouseDown(syncBtn.parentElement!);
    fireEvent.click(syncBtn);
    await waitFor(() => expect(mockedApps.syncTasks).toHaveBeenCalledWith('app-1'));
  });

  it('非 admin：同步任务按钮禁用（W3 RBAC 门控）', async () => {
    useAuthStore.setState({ user: { id: 2, username: 'dev', role: 'user' } });
    renderPage();
    await screen.findAllByText('demo-app');
    fireEvent.click(screen.getByText('关联任务'));
    const syncBtn = await screen.findByText('同步任务').then((el) => el.closest('button') as HTMLButtonElement);
    expect(syncBtn?.disabled).toBe(true);
  });
});

describe('ApplicationDetailPage 版本历史与回滚门控（QA-03 第二阶段）', () => {
  it('渲染版本列表：版本 Tag/commit 前 8 位/当前版本 Tag/回滚按钮', async () => {
    renderPage();
    await screen.findAllByText('demo-app');
    fireEvent.click(screen.getByText(/版本历史/));
    // 当前版本行（1.2.0 released）
    expect((await screen.findAllByText('1.2.0')).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('abcdef12').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('当前版本').length).toBeGreaterThanOrEqual(1);
    // 1.1.0 stopped 行存在回滚按钮（antd 双汉字插空格 → findBtn 归一化匹配）
    await waitFor(() => {
      const rollbackBtns = Array.from(document.body.querySelectorAll('button')).filter(
        (b) => (b.textContent ?? '').replace(/\s/g, '') === '回滚',
      );
      expect(rollbackBtns.length).toBe(1);
    });
  });

  it('非 released 版本回滚按钮禁用（仅已发布版本可回滚）', async () => {
    renderPage();
    await screen.findAllByText('demo-app');
    fireEvent.click(screen.getByText(/版本历史/));
    const rollbackBtn = await findRollbackBtn();
    expect(rollbackBtn.disabled).toBe(true);
  });

  it('非 admin：回滚按钮禁用（isAdmin 门控）', async () => {
    useAuthStore.setState({ user: { id: 2, username: 'dev', role: 'user' } });
    renderPage();
    await screen.findAllByText('demo-app');
    fireEvent.click(screen.getByText(/版本历史/));
    const rollbackBtn = await findRollbackBtn();
    expect(rollbackBtn.disabled).toBe(true);
    expect(mockedApps.rollback).not.toHaveBeenCalled();
  });

  it('ADMIN 确认回滚 → rollback(appId, targetId) 精确调用并刷新版本/应用', async () => {
    // 让 1.1.0 行可回滚：released 且非当前版本
    mockedApps.getVersionHistory.mockResolvedValue([
      versionRow(),
      versionRow({ id: 'ver-2', version: '1.1.0', commit: '0000001111222233', status: 'released', deploymentId: 'dep-2' }),
    ]);
    mockedApps.rollback.mockResolvedValue({ ok: true, rolledBackTo: '1.1.0', total: 2, succeeded: 2, failed: 0 });
    renderPage();
    await screen.findAllByText('demo-app');
    fireEvent.click(screen.getByText(/版本历史/));
    fireEvent.click(await findRollbackBtn());
    await confirmDialog('确认回滚');
    await waitFor(() => {
      expect(mockedApps.rollback).toHaveBeenCalledWith('app-1', 'ver-2');
    });
  });

  it('回滚失败 → 错误 toast 呈现响应 message', async () => {
    mockedApps.getVersionHistory.mockResolvedValue([
      versionRow({ status: 'stopped' }),
      versionRow({ id: 'ver-2', version: '1.1.0', commit: '0000001111222233', status: 'released', deploymentId: 'dep-2' }),
    ]);
    mockedApps.rollback.mockRejectedValue(
      Object.assign(new Error('bad'), { response: { data: { message: '目标版本快照缺失' } } }),
    );
    renderPage();
    await screen.findAllByText('demo-app');
    fireEvent.click(screen.getByText(/版本历史/));
    fireEvent.click(await findRollbackBtn());
    await confirmDialog('确认回滚');
    await waitFor(() => {
      expect(screen.getByText('目标版本快照缺失')).toBeTruthy();
    });
  });
});
