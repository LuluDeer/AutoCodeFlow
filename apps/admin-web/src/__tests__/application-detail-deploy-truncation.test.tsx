/**
 * R150（F1）：应用详情「下发到设备」弹窗的**部署行截断提示**与**真空态区分**。
 *
 * ## 缺陷现场（读只审计 R149 F1）
 *
 * 取数 `deploymentsApi.list(app.id, 1, 100)` 只拿前 100 行且**丢弃 `total`**；
 * 后端按 `createdAt DESC` 排序 ⇒ 被截掉的恰是**最老**、最可能仍在 `running`
 * 的部署行。那些设备既不在勾选列表里、也不在默认勾选集里，用户只会得到
 * 「这台机器没部署过」这一种解释（真相是分页窗口）。
 *
 * ## 本文件钉住的行为
 *
 *   ① `total > 已取行数` ⇒ 出现**截断告警**（写明已列/共有/更早未显示条数），
 *      且**不得**出现「没有部署」文案；
 *   ② `total === 0`（真空态）⇒ 出现「暂无部署行」文案，且**不得**出现截断告警；
 *   ③ `rows.length === 0 && total > 0` ⇒ **不得**说「没有部署」（那是另一个
 *      假事实）——改为如实说明「本次未取到、共 N 条」；
 *   ④ 快照包地址三态：确认有 / 确认没有 / **未确认**（读取失败）⇒ 「未确认」
 *      必须可见（此前两种情形都表现为「什么都不显示」）。
 *
 * 用例 ①② 是「还原后转红」的反证锚点：还原截断提示 ⇒ ①红；还原真空态判断 ⇒ ②红。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, act } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import ApplicationDetailPage from '../pages/ApplicationDetailPage';
import { applicationsApi, deploymentsApi, type Application, type VersionHistoryEntry } from '../api/applications';
import { tasksApi } from '../api/tasks';
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
// AppDeploymentPage 是部署实例 Tab 的整页子组件——整体替换掉避免噪音。
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

/** 部署行（最小可用形状）。 */
const depRow = (id: string, executorId: string, address: string, status = 'running') => ({
  id,
  applicationId: 'app-1',
  executorId,
  executorAddress: address,
  status,
  runMode: 'daemon',
  deployedCommit: null,
  deployedVersion: null,
  startCommand: null,
  env: null,
  pid: null,
  lastHeartbeat: null,
  statusMessage: null,
  deployedAt: null,
  createdAt: '2026-09-01T08:00:00Z',
  updatedAt: '2026-09-01T08:00:00Z',
});

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/applications/app-1']}>
      <Routes>
        <Route path="/applications/:id" element={<ApplicationDetailPage />} />
        <Route path="/applications" element={<div>app-list-mock</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

/** 版本表动作按钮（antd 双汉字插空格，textContent 归一化后定位）。 */
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

/** 打开「版本历史」Tab 并点「下发到设备」。 */
async function openDeployModal() {
  renderPage();
  await screen.findAllByText('demo-app');
  fireEvent.click(screen.getByText(/版本历史/));
  fireEvent.click(await findActionBtn('下发到设备'));
}

/** 真空态文案（「该应用暂无部署行…」）。 */
const EMPTY_TEXT = '该应用暂无部署行';
/** 截断态文案（「本次未取到可下发的部署行…」）。 */
const EMPTY_UNKNOWN_TEXT = '本次未取到可下发的部署行';

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
  useAuthStore.setState({ user: { id: 1, username: 'root', role: 'admin' } });
  mockedApps.get.mockResolvedValue(appFixture);
  mockedTasks.list.mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 100 });
  mockedApps.getVersionHistory.mockResolvedValue([
    versionRow(),
    versionRow({ id: 'ver-2', version: '1.1.0', commit: '0000001111222233', status: 'released', deploymentId: 'dep-2' }),
  ]);
  mockedApps.getReleases.mockResolvedValue({
    data: [{ id: 'ver-2', version: '1.1.0', packageUrl: null }],
    total: 1,
    page: 1,
    pageSize: 200,
  } as never);
  mockedApps.setCurrentVersion.mockResolvedValue({ ok: true, dispatched: false, version: '1.1.0', versionId: 'ver-2' });
  mockedApps.deployVersion.mockResolvedValue({
    ok: true, dispatched: true, version: '1.1.0', versionId: 'ver-2',
    upgraded: [], skipped: [],
  });
});

afterEach(() => {
  cleanup();
});

describe('R150(F1) 下发弹窗：部署行被截断 ⇒ 显式可见提示（不是「没有部署」）', () => {
  // ── 反证锚点 ①：还原截断提示 ⇒ 本例红 ──────────────────────────────
  it('total(137) > 已取行数 ⇒ 出现截断告警，写明已列/共有/更早未显示条数', async () => {
    mockedDeployments.list.mockResolvedValue({
      data: [depRow('dep-1', 'exec-1', '10.0.0.1:8001')],
      total: 137,
    } as never);

    await openDeployModal();

    // 截断告警可见
    const alert = await screen.findByTestId('deploy-rows-truncated');
    expect(alert).toBeTruthy();
    // 文案如实给出三个数字：已列 1 / 共有 137 / 更早未显示 136
    const text = alert.textContent ?? '';
    expect(text).toContain('137');
    expect(text).toContain('1');
    expect(text).toContain('136');
    // 并给出**可去的地方**（跳到本应用的「部署实例」页）
    expect(screen.getByTestId('deploy-truncated-goto-deployments')).toBeTruthy();
  });

  it('截断告警条的出口：点「查看部署实例」→ 切到部署实例页签', async () => {
    mockedDeployments.list.mockResolvedValue({
      data: [depRow('dep-1', 'exec-1', '10.0.0.1:8001')],
      total: 137,
    } as never);

    await openDeployModal();

    const btn = await screen.findByTestId('deploy-truncated-goto-deployments');
    await act(async () => {
      fireEvent.click(btn);
    });
    // 出口真的可达：部署实例页签被激活（该 Tab 的子组件渲染出来了）
    await waitFor(() => expect(screen.getByTestId('app-deployment-mock')).toBeTruthy());
  });

  it('total(137) > 已取行数 ⇒ **不得**出现「没有部署」文案', async () => {
    mockedDeployments.list.mockResolvedValue({
      data: [depRow('dep-1', 'exec-1', '10.0.0.1:8001')],
      total: 137,
    } as never);

    await openDeployModal();

    await screen.findByTestId('deploy-rows-truncated');
    expect(screen.queryByText(new RegExp(EMPTY_TEXT))).toBeNull();
    expect(screen.queryByText(new RegExp(EMPTY_UNKNOWN_TEXT))).toBeNull();
    // 真实部署行照常渲染（截断提示是**追加**信息，不替换列表）
    expect(screen.getByText('10.0.0.1:8001')).toBeTruthy();
  });

  // ── 反证锚点 ②：还原真空态判断 ⇒ 本例红 ──────────────────────────────
  it('total === 0 ⇒ 出现真空态（「暂无部署行」）且**不得**出现截断告警', async () => {
    mockedDeployments.list.mockResolvedValue({ data: [], total: 0 } as never);

    await openDeployModal();

    await waitFor(() => {
      expect(screen.getByText(new RegExp(EMPTY_TEXT))).toBeTruthy();
    });
    expect(screen.queryByTestId('deploy-rows-truncated')).toBeNull();
  });

  it('total === 已取行数（未截断）⇒ 不得出现截断告警（提示不得常显降级为噪音）', async () => {
    mockedDeployments.list.mockResolvedValue({
      data: [depRow('dep-1', 'exec-1', '10.0.0.1:8001')],
      total: 1,
    } as never);

    await openDeployModal();

    await waitFor(() => expect(screen.getByText('10.0.0.1:8001')).toBeTruthy());
    expect(screen.queryByTestId('deploy-rows-truncated')).toBeNull();
  });

  it('取到 0 行但 total > 0 ⇒ 不得说「没有部署」，改为如实说明共 N 条', async () => {
    mockedDeployments.list.mockResolvedValue({ data: [], total: 42 } as never);

    await openDeployModal();

    await waitFor(() => {
      expect(screen.getByText(new RegExp(EMPTY_UNKNOWN_TEXT))).toBeTruthy();
    });
    expect(screen.queryByText(new RegExp(EMPTY_TEXT))).toBeNull();
    // 总数如实上屏（在同一句里）
    const emptyText = screen.getByText(new RegExp(EMPTY_UNKNOWN_TEXT)).textContent ?? '';
    expect(emptyText).toContain('42');
  });
});

describe('R150(F1) 下发弹窗：快照包地址三态（读失败 ≠ 确定没有）', () => {
  it('/releases 读取失败 ⇒ 显示「无法确认」提示（不得静默什么都不显示）', async () => {
    mockedDeployments.list.mockResolvedValue({
      data: [depRow('dep-1', 'exec-1', '10.0.0.1:8001')],
      total: 1,
    } as never);
    mockedApps.getReleases.mockRejectedValue(new Error('releases boom'));

    await openDeployModal();

    await waitFor(() => {
      expect(screen.getByTestId('deploy-pkg-alert')).toBeTruthy();
    });
    const text = screen.getByTestId('deploy-pkg-alert').textContent ?? '';
    expect(text).toContain('无法确认');
    // 不得谎称「不含包地址」
    expect(text).not.toContain('不含包地址');
  });

  it('/releases 读取成功且快照确无包地址 ⇒ 显示「不含包地址」（确认过的事实）', async () => {
    mockedDeployments.list.mockResolvedValue({
      data: [depRow('dep-1', 'exec-1', '10.0.0.1:8001')],
      total: 1,
    } as never);

    await openDeployModal();

    await waitFor(() => {
      expect(screen.getByTestId('deploy-pkg-alert')).toBeTruthy();
    });
    const text = screen.getByTestId('deploy-pkg-alert').textContent ?? '';
    expect(text).toContain('不含包地址');
    expect(text).not.toContain('无法确认');
  });
});

describe('R150(F1) 下发弹窗：行为零变更（勾选与下发链路）', () => {
  it('截断态下 RUNNING 行仍默认勾选、stopped 行仍禁用 ⇒ 下发只点名 running 的执行器', async () => {
    mockedDeployments.list.mockResolvedValue({
      data: [
        depRow('dep-1', 'exec-1', '10.0.0.1:8001', 'running'),
        depRow('dep-2', 'exec-2', '10.0.0.2:8001', 'stopped'),
      ],
      total: 137,
    } as never);

    await openDeployModal();

    await screen.findByTestId('deploy-rows-truncated');
    expect(screen.getByText('10.0.0.1:8001')).toBeTruthy();
    const stoppedBox = screen
      .getByText('10.0.0.2:8001')
      .closest('label')
      ?.querySelector('input[type="checkbox"]') as HTMLInputElement;
    expect(stoppedBox?.disabled).toBe(true);

    let okBtn: HTMLButtonElement | undefined;
    await waitFor(() => {
      const btns = Array.from(document.body.querySelectorAll('.ant-modal-footer button')) as HTMLButtonElement[];
      okBtn = btns[btns.length - 1];
      expect(okBtn).toBeTruthy();
    });
    await act(async () => {
      fireEvent.click(okBtn!);
    });
    await waitFor(() => {
      expect(mockedApps.deployVersion).toHaveBeenCalledWith('app-1', 'ver-2', ['exec-1']);
    });
  });
});
