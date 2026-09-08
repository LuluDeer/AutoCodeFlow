/**
 * FEAT-14：ApplicationDetailPage「版本追溯」Tab——DEP-01 统一发布追溯视图
 * （GET /applications/:id/releases）前端消费。
 *
 * 覆盖：Tab 渲染与 getReleases 调用 / 版本×部署列渲染（合成行/多次部署/
 * 未部署/操作人缺失标注）/ 空态 / 加载失败 StateError 降级 + 重试 / 分页。
 * mock api 层（application-detail.test 先例形态）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import ApplicationDetailPage from '../pages/ApplicationDetailPage';
import { applicationsApi, type Application, type AppReleaseRow } from '../api/applications';
import { tasksApi } from '../api/tasks';
import { useAuthStore } from '../store/auth';

vi.mock('../api/applications', () => ({
  applicationsApi: {
    get: vi.fn(),
    update: vi.fn(),
    syncTasks: vi.fn(),
    getVersionHistory: vi.fn(),
    getReleases: vi.fn(),
    rollback: vi.fn(),
  },
}));
vi.mock('../api/tasks', () => ({ tasksApi: { list: vi.fn() } }));
vi.mock('../api/ai', () => ({ aiApi: { analyzeApp: vi.fn() } }));
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
  createdAt: '2026-09-01T08:00:00Z',
  updatedAt: '2026-09-07T08:00:00Z',
};

const releaseRow = (over: Partial<AppReleaseRow> = {}): AppReleaseRow => ({
  id: 'ver-1',
  version: '1.2.0',
  packageUrl: 'http://api:3000/uploads/packages/demo-1.2.0.zip',
  gitCommit: 'abcdef1234567890',
  deployedAt: '2026-09-07T08:00:00Z',
  latestDeploymentId: 'dep-1',
  deploymentStatus: 'running',
  deploymentCount: 1,
  executorAddress: '10.0.0.9:3002',
  runMode: 'daemon',
  triggerType: 'manual',
  operator: null,
  operatorSource: 'application_versions.createdBy',
  operatorMissingReason: 'not populated by any write path',
  sourceDeploymentId: 'dep-1',
  status: 'released',
  createdAt: '2026-09-06T08:00:00Z',
  synthetic: false,
  ...over,
});

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/applications/app-1?tab=releases']}>
      <Routes>
        <Route path="/applications/:id" element={<ApplicationDetailPage />} />
        <Route path="/applications" element={<div>app-list-mock</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

/** 切到版本追溯 Tab（页头渲染完成后）。注意失败态用例中 StateError 标题
 *  「加载版本追溯失败」也会匹配 /版本追溯/——用整串匹配只命中 Tab 页签。 */
async function openReleasesTab() {
  renderPage();
  await screen.findAllByText('demo-app');
  fireEvent.click(screen.getByText('版本追溯'));
  await waitFor(() => expect(mockedApps.getReleases).toHaveBeenCalled());
}

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
  useAuthStore.setState({ user: { id: 1, username: 'root', role: 'admin' } });
  mockedApps.get.mockResolvedValue(appFixture);
  mockedTasks.list.mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 100 });
  mockedApps.getReleases.mockResolvedValue({
    data: [releaseRow(), releaseRow({ id: 'ver-2', version: '1.1.0', gitCommit: '0000001111222233', deploymentStatus: 'stopped', deploymentCount: 3, triggerType: 'upgrade', latestDeploymentId: 'dep-2' })],
    total: 2,
    page: 1,
    pageSize: 20,
  });
});

afterEach(() => {
  cleanup();
});

describe('ApplicationDetailPage 版本追溯 Tab（FEAT-14 / DEP-01）', () => {
  it('Tab 渲染并以 (appId, page, pageSize) 调用 getReleases，表格出现', async () => {
    await openReleasesTab();
    await waitFor(() => expect(screen.getByTestId('releases-table')).toBeTruthy());
    expect(mockedApps.getReleases).toHaveBeenCalledWith('app-1', 1, 20);
    // 版本列渲染
    expect(screen.getAllByText('1.2.0').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('1.1.0').length).toBeGreaterThanOrEqual(1);
  });

  it('版本×部署列渲染：commit 截断/部署状态/触发方式/执行器/部署时间', async () => {
    await openReleasesTab();
    await screen.findByTestId('releases-table');
    expect(screen.getAllByText('abcdef12').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('运行中').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('已停止').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('手动部署').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('滚动升级').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('10.0.0.9:3002').length).toBeGreaterThanOrEqual(1);
  });

  it('多次部署行显示部署次数徽标；operator 恒 null 显示缺失标注占位', async () => {
    await openReleasesTab();
    await screen.findByTestId('releases-table');
    expect(screen.getAllByText('3次').length).toBeGreaterThanOrEqual(1);
    // operator 缺省如实标注（恒 null 契约）——非「-」而是缺省占位文案
    expect(screen.getAllByText('—').length).toBeGreaterThanOrEqual(1);
  });

  it('无部署版本行显示「未部署」；synthetic 行显示合成标记', async () => {
    mockedApps.getReleases.mockResolvedValue({
      data: [releaseRow({ deploymentStatus: null, deployedAt: null, latestDeploymentId: null, triggerType: null, executorAddress: null }), releaseRow({ id: 'ver-9', version: null, synthetic: true, latestDeploymentId: 'dep-syn', deploymentStatus: 'failed' })],
      total: 2,
      page: 1,
      pageSize: 20,
    });
    await openReleasesTab();
    await screen.findByTestId('releases-table');
    expect(screen.getAllByText('未部署').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('合成').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('失败').length).toBeGreaterThanOrEqual(1);
  });

  it('空态：无发布记录时展示空态文案', async () => {
    mockedApps.getReleases.mockResolvedValue({ data: [], total: 0, page: 1, pageSize: 20 });
    await openReleasesTab();
    await screen.findByTestId('releases-table');
    await waitFor(() =>
      expect(screen.getByText(/暂无发布记录/)).toBeTruthy(),
    );
  });

  it('加载失败降级为 StateError（重试 + 复制），整页不炸且空态不出现', async () => {
    mockedApps.getReleases.mockRejectedValue(new Error('releases down'));
    await openReleasesTab();
    await waitFor(() => expect(screen.getByTestId('state-error')).toBeTruthy());
    expect(screen.getByText(/加载版本追溯失败/)).toBeTruthy();
    expect(screen.getByText('releases down')).toBeTruthy();
    expect(screen.queryByTestId('releases-table')).toBeNull();
  });

  it('StateError 重试按钮重新发起 getReleases', async () => {
    mockedApps.getReleases.mockRejectedValueOnce(new Error('boom'));
    await openReleasesTab();
    await waitFor(() => expect(screen.getByTestId('state-error')).toBeTruthy());
    fireEvent.click(screen.getByText('重试'));
    await waitFor(() => {
      expect(mockedApps.getReleases).toHaveBeenCalledTimes(2);
      expect(screen.getByTestId('releases-table')).toBeTruthy();
    });
  });

  it('分页：翻页时以新页码重新请求', async () => {
    mockedApps.getReleases.mockResolvedValue({
      data: Array.from({ length: 20 }, (_, i) => releaseRow({ id: `ver-${i}`, version: `1.0.${i}`, deploymentCount: 1 })),
      total: 45,
      page: 1,
      pageSize: 20,
    });
    await openReleasesTab();
    await screen.findByTestId('releases-table');
    // antd 分页器第 2 页按钮
    const page2 = screen.getAllByTitle('2').find((el) => el.tagName === 'LI');
    expect(page2).toBeTruthy();
    fireEvent.click(page2 as HTMLElement);
    await waitFor(() => expect(mockedApps.getReleases).toHaveBeenCalledWith('app-1', 2, 20));
  });

  it('刷新按钮以当前页重新请求', async () => {
    await openReleasesTab();
    await screen.findByTestId('releases-table');
    // 页面页头也有「刷新」（整页刷新），取版本追溯卡片内的刷新按钮
    const card = screen.getByTestId('releases-table').closest('.ant-card') as HTMLElement;
    fireEvent.click(Array.from(card.querySelectorAll('button')).find((b) => (b.textContent ?? '').includes('刷新')) as HTMLButtonElement);
    await waitFor(() => expect(mockedApps.getReleases).toHaveBeenCalledTimes(2));
  });
});
