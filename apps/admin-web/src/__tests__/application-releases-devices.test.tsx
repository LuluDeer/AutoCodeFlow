/**
 * R3-A（部署模型评审 2026-10-23 §4.3）：ApplicationDetailPage 版本追溯 Tab 的
 * **设备徽标**——devices 列渲染设备心跳上报的版本事实
 * （执行器名 + 运行中/保留 + 离线置灰标注）。
 *
 * mock api 层（application-releases-tab.test 先例形态）；设备名优先取响应内嵌
 * executorName，本文件不依赖 useExecutorNames 的清单请求。
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
vi.mock('../api/executors', () => ({ executorsApi: { list: vi.fn().mockRejectedValue(new Error('no list')) } }));
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
});

afterEach(() => {
  cleanup();
});

describe('ApplicationDetailPage 版本追溯 Tab 设备徽标（R3-A §4.3）', () => {
  it('每设备一枚徽标：执行器名 + 运行中（current 指向本行版本）', async () => {
    mockedApps.getReleases.mockResolvedValue({
      data: [
        releaseRow({
          devices: [
            { executorId: 'exec-a', executorName: 'node-a', currentVersion: '1.2.0', retained: true, online: true, lastHeartbeat: '2026-10-24T08:00:00Z' },
          ],
        }),
      ],
      total: 1,
      page: 1,
      pageSize: 20,
    });
    await openReleasesTab();
    await screen.findByTestId('releases-table');
    // 「设备」字样在页头/其它列也会出现，断言存在至少一处列头即可
    expect(screen.getAllByText('设备').length).toBeGreaterThan(0);
    const badge = screen.getByTestId('release-device-badge');
    expect(badge.textContent).toContain('node-a');
    expect(badge.textContent).toContain('运行中');
  });

  it('保留徽标：current 指向别版但本行版本 ∈ retainedVersions', async () => {
    mockedApps.getReleases.mockResolvedValue({
      data: [
        releaseRow({
          id: 'ver-old',
          version: '1.1.0',
          devices: [
            { executorId: 'exec-b', executorName: 'node-b', currentVersion: '1.2.0', retained: true, online: true, lastHeartbeat: '2026-10-24T08:00:00Z' },
          ],
        }),
      ],
      total: 1,
      page: 1,
      pageSize: 20,
    });
    await openReleasesTab();
    await screen.findByTestId('releases-table');
    const badge = screen.getByTestId('release-device-badge');
    expect(badge.textContent).toContain('node-b');
    expect(badge.textContent).toContain('保留');
    expect(badge.textContent).not.toContain('运行中');
  });

  it('离线设备置灰标注「离线」；多设备各自成徽标', async () => {
    mockedApps.getReleases.mockResolvedValue({
      data: [
        releaseRow({
          devices: [
            { executorId: 'exec-a', executorName: 'node-a', currentVersion: '1.2.0', retained: true, online: true, lastHeartbeat: '2026-10-24T08:00:00Z' },
            { executorId: 'exec-b', executorName: 'node-b', currentVersion: '1.2.0', retained: true, online: false, lastHeartbeat: '2026-10-01T08:00:00Z' },
          ],
        }),
      ],
      total: 1,
      page: 1,
      pageSize: 20,
    });
    await openReleasesTab();
    await screen.findByTestId('releases-table');
    const badges = screen.getAllByTestId('release-device-badge');
    expect(badges).toHaveLength(2);
    const offline = badges.find((b) => b.textContent?.includes('node-b'))!;
    expect(offline.textContent).toContain('离线');
  });

  it('无设备上报（devices 缺省/空数组）→ 占位「-」，不出现徽标', async () => {
    mockedApps.getReleases.mockResolvedValue({
      data: [releaseRow(), releaseRow({ id: 'ver-2', version: '1.1.0', devices: [] })],
      total: 2,
      page: 1,
      pageSize: 20,
    });
    await openReleasesTab();
    await screen.findByTestId('releases-table');
    expect(screen.queryByTestId('release-device-badge')).toBeNull();
    // 设备列存在且如实占位（与「未部署」区分：推断字段列仍正常渲染）
    expect(screen.getAllByText('设备').length).toBeGreaterThan(0);
  });
});
