/**
 * 部署定位深链：ApplicationDetailPage → ReleasesTab 的行级高亮 + 滚动定位。
 * mock 范式沿用 application-releases-tab.test.tsx（api 层 vi.mock + MemoryRouter）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import ApplicationDetailPage from '../pages/ApplicationDetailPage';
import { applicationsApi, type Application, type AppReleaseRow } from '../api/applications';
import { tasksApi } from '../api/tasks';
import { useAuthStore } from '../store/auth';
import { scrollToSectionWhenReady } from '../utils/scroll-when-ready';
import {
  DEPLOY_HIT_CLASS,
  deploymentRowDomId,
  getVersionKey,
  resolveDeployLocator,
} from '../pages/application-detail/deploy-deeplink';

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
vi.mock('../utils/scroll-when-ready', () => ({ scrollToSectionWhenReady: vi.fn() }));

const mockedApps = vi.mocked(applicationsApi, true);
const mockedTasks = vi.mocked(tasksApi, true);
const mockedScroll = vi.mocked(scrollToSectionWhenReady);

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

const UUID_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const UUID_B = 'bbbbbbbb-bbbb-4bbb-8bbbb-bbbbbbbbbbbb';

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
  latestDeploymentId: UUID_A,
  deploymentStatus: 'running',
  deploymentCount: 1,
  executorAddress: '10.0.0.9:3002',
  runMode: 'daemon',
  triggerType: 'manual',
  operator: null,
  operatorSource: 'application_versions.createdBy',
  operatorMissingReason: 'not populated by any write path',
  sourceDeploymentId: UUID_A,
  status: 'released',
  createdAt: '2026-09-06T08:00:00Z',
  synthetic: false,
  ...over,
});

const rows = [
  releaseRow(),
  releaseRow({ id: 'ver-2', version: '1.1.0', latestDeploymentId: UUID_B, sourceDeploymentId: UUID_B, gitCommit: '0000001111222233', deploymentStatus: 'stopped', deploymentCount: 3, triggerType: 'upgrade' }),
];

function renderPage(query = '?tab=releases') {
  return render(
    <MemoryRouter initialEntries={[`/applications/app-1${query}`]}>
      <Routes>
        <Route path="/applications/:id" element={<ApplicationDetailPage />} />
        <Route path="/applications" element={<div>app-list-mock</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

async function openReleases(query?: string) {
  renderPage(query);
  await screen.findAllByText('demo-app');
  await waitFor(() => expect(mockedApps.getReleases).toHaveBeenCalled());
  await screen.findByTestId('releases-table');
  await waitFor(() => expect(screen.getAllByText('1.1.0').length).toBeGreaterThanOrEqual(1));
}

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
  useAuthStore.setState({ user: { id: 1, username: 'root', role: 'admin' } });
  mockedApps.get.mockResolvedValue(appFixture);
  mockedTasks.list.mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 100 });
  mockedApps.getReleases.mockResolvedValue({ data: rows, total: rows.length, page: 1, pageSize: 20 });
});

afterEach(() => { cleanup(); });

describe('resolveDeployLocator（纯解析）', () => {
  it('UUID deploymentId + 编码 version 均合法', () => {
    const q = new URLSearchParams(`deploymentId=${encodeURIComponent(UUID_A)}&version=${encodeURIComponent('1.2.0 rc')}`);
    expect(resolveDeployLocator(q)).toEqual({ deploymentId: UUID_A, version: '1.2.0 rc', matched: true });
  });

  it('非法 deploymentId 被忽略但合法 version 仍命中；两者皆非法则中性降级', () => {
    expect(resolveDeployLocator(new URLSearchParams('deploymentId=bad&version=1.2.0')).deploymentId).toBeNull();
    expect(resolveDeployLocator(new URLSearchParams('deploymentId=bad&version=1.2.0')).matched).toBe(true);
    const none = resolveDeployLocator(new URLSearchParams('deploymentId=bad&version='));
    expect(none).toEqual({ deploymentId: null, version: null, matched: false });
  });
});

describe('ApplicationDetailPage 部署定位深链', () => {
  it('(a) 带 deploymentId：命中对应行，该行有锚点 id + 高亮 class，并滚动定位', async () => {
    await openReleases(`?tab=releases&deploymentId=${encodeURIComponent(UUID_B)}&version=${encodeURIComponent('1.1.0')}`);
    const key = getVersionKey(rows[1]);
    const hit = document.getElementById(deploymentRowDomId(key)) as HTMLElement;
    expect(hit).toBeTruthy();
    expect(hit.className).toContain(DEPLOY_HIT_CLASS);
    expect(document.querySelectorAll(`.${DEPLOY_HIT_CLASS}`)).toHaveLength(1);
    expect(document.getElementById(deploymentRowDomId(getVersionKey(rows[0])))).toBeNull();
    await waitFor(() => expect(mockedScroll).toHaveBeenCalledWith(deploymentRowDomId(key)));
  });

  it('(b) 只带 version：按版本号命中', async () => {
    await openReleases(`?tab=releases&version=${encodeURIComponent('1.2.0')}`);
    const key = getVersionKey(rows[0]);
    const hit = document.getElementById(deploymentRowDomId(key)) as HTMLElement;
    expect(hit).toBeTruthy();
    expect(hit.className).toContain(DEPLOY_HIT_CLASS);
    await waitFor(() => expect(mockedScroll).toHaveBeenCalledWith(deploymentRowDomId(key)));
  });

  it('(c) 非法/缺失参数中性降级：不高亮、不滚动，?tab=releases 仍照旧', async () => {
    await openReleases('?tab=releases&deploymentId=not-a-uuid&version=');
    expect(screen.getByTestId('releases-table')).toBeTruthy();
    expect(document.querySelectorAll(`.${DEPLOY_HIT_CLASS}`)).toHaveLength(0);
    expect(document.querySelector('[id^="app-release-deploy-"]')).toBeNull();
    expect(mockedScroll).not.toHaveBeenCalled();
  });

  it('(d) 正例控制组：无深链时逐字保持原行为', async () => {
    await openReleases('?tab=releases');
    expect(mockedApps.getReleases).toHaveBeenCalledWith('app-1', 1, 20);
    expect(screen.getAllByText('1.2.0').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('1.1.0').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByTestId('releases-table')).toBeTruthy();
    expect(document.querySelectorAll(`.${DEPLOY_HIT_CLASS}`)).toHaveLength(0);
    expect(mockedScroll).not.toHaveBeenCalled();
  });
});
