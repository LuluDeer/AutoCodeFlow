/**
 * QA-03 第二阶段：ApplicationDetailPage 组件测试（此前零覆盖）。
 *
 * 覆盖核心交互：
 *  1) 详情加载渲染（页头/概览 Tab 应用信息）与加载失败导航回列表；
 *  2) Tab 切换：关联任务 Tab 加载 tasksApi.list({applicationId})；
 *  3) 版本历史 Tab：列表渲染（版本 Tag/commit 截断/当前版本 Tag/双动作门控）；
 *  4) R1（部署模型评审 §4.2）双动作链路：非 released 版本按钮禁用、isAdmin=false
 *     禁用、设为当前版本 → setCurrentVersion(id, versionId) 精确调用 + 刷新；
 *     下发到设备 → 弹窗勾选执行器（RUNNING 默认勾选、非 running 禁用）+
 *     packageUrl 缺失前置警告 → deployVersion(id, versionId, executorIds)；
 *  5) 同步任务门控：isAdmin=false 同步按钮禁用。
 *
 * mock api 层（applicationsApi/tasksApi/aiApi，ExecutionsPage 先例）；
 * AppDeploymentPage 内部请求已在组件 mock 中整体替换，避免部署页噪音。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, act } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import ApplicationDetailPage from '../pages/ApplicationDetailPage';
import { applicationsApi, deploymentsApi, type Application, type VersionHistoryEntry } from '../api/applications';
import { tasksApi, type Task } from '../api/tasks';
import { useAuthStore } from '../store/auth';

vi.mock('../api/applications', () => ({
  applicationsApi: {
    get: vi.fn(),
    update: vi.fn(),
    syncTasks: vi.fn(),
    getVersionHistory: vi.fn(),
    getReleases: vi.fn(),
    setCurrentVersion: vi.fn(),
    deployVersion: vi.fn(),
  },
  deploymentsApi: { list: vi.fn() },
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
const mockedDeployments = vi.mocked(deploymentsApi, true);
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

/** 版本表动作按钮（antd 双汉字插空格，textContent 归一化后定位） */
async function findActionBtn(label: string): Promise<HTMLButtonElement> {
  await waitFor(() => {
    expect(
      Array.from(document.body.querySelectorAll('button')).filter(
        (b) => (b.textContent ?? '').replace(/\s/g, '') === label,
      ).length,
    ).toBeGreaterThanOrEqual(1);
  });
  return Array.from(document.body.querySelectorAll('button')).find(
    (b) => (b.textContent ?? '').replace(/\s/g, '') === label,
  ) as HTMLButtonElement;
}

/** Popconfirm/Modal.confirm 确认键：弹层最后一个按钮（既有先例）。
 *  R1 §4.2 起「设为当前版本」的确认弹层标题与行内按钮同文案——标题文本
 *  单独等待会在弹层尚未挂载时就命中行内按钮，故改为等待 holder 内出现标题。 */
async function confirmDialog(titleText: string) {
  // Modal.confirm 弹层挂在 body 级 ant-modal-confirm holder；跨用例残留时标题
  // 文本可能多次命中——取最后一个 holder 的最后一个按钮（最新弹层的 ok 键）。
  let layer: HTMLElement | undefined;
  await waitFor(() => {
    const holders = Array.from(
      document.body.querySelectorAll('.ant-modal-confirm'),
    ) as HTMLElement[];
    layer = holders.filter((h) => h.textContent?.includes(titleText)).pop();
    expect(layer).toBeTruthy();
  });
  const layerBtns = Array.from(layer!.querySelectorAll('button')) as HTMLButtonElement[];
  const okBtn = layerBtns[layerBtns.length - 1];
  expect(okBtn).toBeTruthy();
  await act(async () => {
    fireEvent.click(okBtn);
  });
}

/** R1 §4.2 下发弹窗（受控 <Modal>，非 Modal.confirm）确认键：footer 最后一个按钮。 */
async function confirmDeployModal() {
  let okBtn: HTMLButtonElement | undefined;
  await waitFor(() => {
    const btns = Array.from(
      document.body.querySelectorAll('.ant-modal-footer button'),
    ) as HTMLButtonElement[];
    okBtn = btns[btns.length - 1];
    expect(okBtn).toBeTruthy();
  });
  await act(async () => {
    fireEvent.click(okBtn!);
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
  // R1 §4.2 双动作链路的读面缺省：部署行清单 + /releases 的 packageUrl 行。
  mockedDeployments.list.mockResolvedValue({
    data: [
      { id: 'dep-1', applicationId: 'app-1', executorId: 'exec-1', executorAddress: '10.0.0.1:8001', status: 'running' },
      { id: 'dep-2', applicationId: 'app-1', executorId: 'exec-2', executorAddress: '10.0.0.2:8001', status: 'stopped' },
    ],
    total: 2,
  } as never);
  mockedApps.getReleases.mockResolvedValue({
    data: [
      { id: 'ver-2', version: '1.1.0', packageUrl: null },
    ],
    total: 1,
    page: 1,
    pageSize: 200,
  } as never);
  mockedApps.setCurrentVersion.mockResolvedValue({
    ok: true, dispatched: false, version: '1.1.0', versionId: 'ver-2',
  });
  mockedApps.deployVersion.mockResolvedValue({
    ok: true, dispatched: true, version: '1.1.0', versionId: 'ver-2',
    upgraded: [{ deploymentId: 'dep-1', executorId: 'exec-1', executorAddress: '10.0.0.1:8001' }],
    skipped: [],
  });
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
    // D-P2-02b：运行时读面走 runtimeLabel（python -> Python），不再裸出后端 token。
    expect(screen.getAllByText('Python').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('正常').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText(/github\.com\/acme\/demo\.git/).length).toBeGreaterThanOrEqual(1);
    expect(mockedApps.get).toHaveBeenCalledWith('app-1');
  });

  // UX-05（本轮体验审查）：本条原先断言「任何错误都跳回列表」——那正是被修的
  // 缺陷：用户正在看的页面突然消失、滚动位置丢失，原因只是一条几秒后消失的
  // toast。现在只有 404（资源确实不存在）才导航；500/网络错误留在原位重试。
  it('404 → 导航回应用列表（资源确实不存在）', async () => {
    mockedApps.get.mockRejectedValue({ response: { status: 404 } });
    renderPage();
    await waitFor(() => expect(screen.getByText('app-list-mock')).toBeTruthy());
  });

  it('UX-05：网络错误（非 404）→ 留在页内渲染可重试错误态，不跳走', async () => {
    mockedApps.get.mockRejectedValue(new Error('network down'));
    renderPage();
    // 页内错误态（UI-08 标准块）
    await waitFor(() => expect(screen.getByTestId('state-error')).toBeTruthy());
    // 关键反证：不得导航离开
    expect(screen.queryByText('app-list-mock')).toBeNull();
    // 且必须给重试入口
    expect(screen.getByText('重试')).toBeTruthy();
  });

  it('Tab 切换到部署实例 → 渲染部署页子组件', async () => {
    renderPage();
    await screen.findAllByText('demo-app');
    fireEvent.click(screen.getByText(/部署实例/));
    await waitFor(() => expect(screen.getByTestId('app-deployment-mock')).toBeTruthy());
  });
});

describe('ApplicationDetailPage 关联任务 Tab（QA-03 第二阶段）', () => {
  it('渲染关联任务列表（任务名/状态/触发）并带 applicationId 查询与 AbortSignal', async () => {
    renderPage();
    await screen.findAllByText('demo-app');
    fireEvent.click(screen.getByText('关联任务'));
    await waitFor(() => {
      expect(mockedTasks.list).toHaveBeenCalledWith(
        expect.objectContaining({ applicationId: 'app-1' }),
        expect.any(AbortSignal),
      );
    });
    expect(screen.getAllByText(/demo\s*任务/).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('运行中').length).toBeGreaterThanOrEqual(1);
  });

  it('关联任务请求在页签卸载后取消且不写入旧结果', async () => {
    let resolveTasks: ((result: unknown) => void) | undefined;
    mockedTasks.list.mockReset().mockImplementation((_params, signal) => new Promise((resolve) => {
      resolveTasks = resolve;
      expect(signal).toBeInstanceOf(AbortSignal);
    }) as never);
    const { unmount } = renderPage();
    await screen.findAllByText('demo-app');
    fireEvent.click(screen.getByText('关联任务'));
    await waitFor(() => expect(mockedTasks.list).toHaveBeenCalledTimes(1));
    const signal = mockedTasks.list.mock.calls[0][1];
    expect(signal).toBeInstanceOf(AbortSignal);

    unmount();
    expect(signal?.aborted).toBe(true);
    resolveTasks?.({ items: [taskFixture], total: 1, page: 1, pageSize: 100 });
    await Promise.resolve();
    expect(screen.queryByText(/demo\s*任务/)).toBeNull();
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

describe('ApplicationDetailPage 版本历史与双动作门控（R1 §4.2）', () => {
  it('渲染版本列表：版本 Tag/commit 前 8 位/当前版本 Tag/非当前行双动作按钮', async () => {
    renderPage();
    await screen.findAllByText('demo-app');
    fireEvent.click(screen.getByText(/版本历史/));
    // 当前版本行（1.2.0 released）
    expect((await screen.findAllByText('1.2.0')).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('abcdef12').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('当前版本').length).toBeGreaterThanOrEqual(1);
    // 1.1.0 stopped 非当前行存在两个动作按钮（stopped → 禁用但可见）
    const setCurrentBtn = await findActionBtn('设为当前版本');
    expect(setCurrentBtn.disabled).toBe(true);
    const deployBtn = await findActionBtn('下发到设备');
    expect(deployBtn.disabled).toBe(true);
  });

  it('非 released 版本双动作按钮禁用（仅已发布版本可操作）', async () => {
    renderPage();
    await screen.findAllByText('demo-app');
    fireEvent.click(screen.getByText(/版本历史/));
    expect((await findActionBtn('设为当前版本')).disabled).toBe(true);
    expect((await findActionBtn('下发到设备')).disabled).toBe(true);
  });

  it('非 admin：双动作按钮禁用（isAdmin 门控）', async () => {
    useAuthStore.setState({ user: { id: 2, username: 'dev', role: 'user' } });
    // 让 1.1.0 行满足 released（排除「未发布」干扰，只验 isAdmin 门控）
    mockedApps.getVersionHistory.mockResolvedValue([
      versionRow(),
      versionRow({ id: 'ver-2', version: '1.1.0', commit: '0000001111222233', status: 'released', deploymentId: 'dep-2' }),
    ]);
    renderPage();
    await screen.findAllByText('demo-app');
    fireEvent.click(screen.getByText(/版本历史/));
    expect((await findActionBtn('设为当前版本')).disabled).toBe(true);
    expect((await findActionBtn('下发到设备')).disabled).toBe(true);
    expect(mockedApps.setCurrentVersion).not.toHaveBeenCalled();
    expect(mockedApps.deployVersion).not.toHaveBeenCalled();
  });

  it('ADMIN 设为当前版本 → setCurrentVersion(appId, versionId) 精确调用并刷新', async () => {
    // 让 1.1.0 行可操作：released 且非当前版本
    mockedApps.getVersionHistory.mockResolvedValue([
      versionRow(),
      versionRow({ id: 'ver-2', version: '1.1.0', commit: '0000001111222233', status: 'released', deploymentId: 'dep-2' }),
    ]);
    renderPage();
    await screen.findAllByText('demo-app');
    fireEvent.click(screen.getByText(/版本历史/));
    fireEvent.click(await findActionBtn('设为当前版本'));
    await confirmDialog('设为当前版本');
    await waitFor(() => {
      expect(mockedApps.setCurrentVersion).toHaveBeenCalledWith('app-1', 'ver-2');
    });
    // 刷新链路：版本历史 + 应用详情重拉
    await waitFor(() => {
      expect(mockedApps.getVersionHistory).toHaveBeenCalledTimes(2);
      expect(mockedApps.get).toHaveBeenCalledTimes(2);
    });
  });

  it('设为当前版本失败 → 错误 toast 呈现响应 message', async () => {
    mockedApps.getVersionHistory.mockResolvedValue([
      versionRow(),
      versionRow({ id: 'ver-2', version: '1.1.0', commit: '0000001111222233', status: 'released', deploymentId: 'dep-2' }),
    ]);
    mockedApps.setCurrentVersion.mockRejectedValue(
      Object.assign(new Error('bad'), { response: { data: { message: '目标版本快照缺失' } } }),
    );
    renderPage();
    await screen.findAllByText('demo-app');
    fireEvent.click(screen.getByText(/版本历史/));
    fireEvent.click(await findActionBtn('设为当前版本'));
    await confirmDialog('设为当前版本');
    await waitFor(() => {
      expect(screen.getByText('目标版本快照缺失')).toBeTruthy();
    });
  });

  it('下发到设备：弹窗勾选 RUNNING 行 + packageUrl 缺失前置警告 → deployVersion(appId, versionId, [exec-1])', async () => {
    mockedApps.getVersionHistory.mockResolvedValue([
      versionRow(),
      versionRow({ id: 'ver-2', version: '1.1.0', commit: '0000001111222233', status: 'released', deploymentId: 'dep-2' }),
    ]);
    renderPage();
    await screen.findAllByText('demo-app');
    fireEvent.click(screen.getByText(/版本历史/));
    fireEvent.click(await findActionBtn('下发到设备'));

    // 弹窗拉部署行清单（勾选面）与 /releases（packageUrl 前置展示）
    await waitFor(() => {
      expect(mockedDeployments.list).toHaveBeenCalledWith('app-1', 1, 100);
      expect(mockedApps.getReleases).toHaveBeenCalledWith('app-1', 1, 200);
    });
    // 两台执行器行均渲染（running 的 exec-1 + stopped 的 exec-2）
    await waitFor(() => expect(screen.getByText('10.0.0.1:8001')).toBeTruthy());
    expect(screen.getByText('10.0.0.2:8001')).toBeTruthy();
    // P1-14 前置：ver-2 快照 packageUrl=null → 确认前即警告「不含包地址」
    expect(screen.getByText(/不含包地址/)).toBeTruthy();
    // stopped 行（exec-2）勾选禁用，running 行（exec-1）缺省勾选 → 下发仅 exec-1
    const stoppedBox = screen
      .getByText('10.0.0.2:8001')
      .closest('label')
      ?.querySelector('input[type="checkbox"]') as HTMLInputElement;
    expect(stoppedBox?.disabled).toBe(true);

    await confirmDeployModal();
    await waitFor(() => {
      expect(mockedApps.deployVersion).toHaveBeenCalledWith('app-1', 'ver-2', ['exec-1']);
    });
    await waitFor(() => {
      expect(mockedApps.getVersionHistory).toHaveBeenCalledTimes(2);
    });
  });

  it('下发失败（部署行清单读取失败）→ 错误 toast 且弹窗关闭', async () => {
    mockedApps.getVersionHistory.mockResolvedValue([
      versionRow(),
      versionRow({ id: 'ver-2', version: '1.1.0', commit: '0000001111222233', status: 'released', deploymentId: 'dep-2' }),
    ]);
    mockedDeployments.list.mockRejectedValue(
      Object.assign(new Error('bad'), { response: { data: { message: '部署行读取失败' } } }),
    );
    renderPage();
    await screen.findAllByText('demo-app');
    fireEvent.click(screen.getByText(/版本历史/));
    fireEvent.click(await findActionBtn('下发到设备'));
    await waitFor(() => {
      expect(screen.getByText('部署行读取失败')).toBeTruthy();
    });
    // 部署行拉不到 = 无从安全勾选：错误如实上屏，且绝不下发
    // （弹窗 DOM 因 antd 关闭动画在 jsdom 不完成而残留，故不断言节点移除）
    expect(mockedApps.deployVersion).not.toHaveBeenCalled();
  });
});
