/**
 * P3-③（审计）回归：ApplicationDetailPage 的 ?tab= 深链健壮化。
 *
 * 此前 `searchParams.get('tab') || 'overview'` 对**无效值**不设防——
 * `/applications/:id?tab=history`（实际 key 是 versions）会让 antd Tabs 的
 * activeKey 落在空档：内容区一片空白，连第一个 Tab 都不高亮。
 * 修复对齐 ExecutionDetailPage.normalizeTabKey 先例：白名单命中才采用，
 * 否则回退 'overview'。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import '../i18n';
import ApplicationDetailPage from '../pages/ApplicationDetailPage';
import { applicationsApi, deploymentsApi, type Application } from '../api/applications';
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
// AppDeploymentPage 是部署实例 Tab 的整页子组件——整体替换掉避免噪音（先例）
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

const renderAt = (search: string) =>
  render(
    <MemoryRouter initialEntries={[`/applications/app-1${search}`]}>
      <Routes>
        <Route path="/applications/:id" element={<ApplicationDetailPage />} />
        <Route path="/applications" element={<div>app-list-mock</div>} />
      </Routes>
    </MemoryRouter>,
  );

/** 当前激活 Tab 的文本（antd .ant-tabs-tab-active） */
const activeTabText = () =>
  (document.querySelector('.ant-tabs-tab-active') as HTMLElement | null)?.textContent ?? '';

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
  useAuthStore.setState({ user: { id: 1, username: 'root', role: 'admin' } });
  mockedApps.get.mockResolvedValue(appFixture);
  mockedTasks.list.mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 100 });
  mockedApps.getVersionHistory.mockResolvedValue([]);
  mockedApps.getReleases.mockResolvedValue({ data: [], total: 0, page: 1, pageSize: 200 } as never);
  vi.mocked(deploymentsApi.list).mockResolvedValue({ data: [], total: 0 } as never);
});

afterEach(cleanup);

describe('P3-③ ?tab= 深链归一化', () => {
  it('无效 tab（?tab=history）→ 回退概览 Tab，不再渲染空白内容区', async () => {
    renderAt('?tab=history');
    await screen.findAllByText('demo-app');
    await waitFor(() => expect(activeTabText()).toContain('概览'));
  });

  it('合法 tab（?tab=versions）→ 直接落到版本历史', async () => {
    renderAt('?tab=versions');
    await screen.findAllByText('demo-app');
    await waitFor(() => expect(activeTabText()).toContain('版本历史'));
  });

  it('无 tab 参数 → 默认概览（既有行为不回归）', async () => {
    renderAt('');
    await screen.findAllByText('demo-app');
    await waitFor(() => expect(activeTabText()).toContain('概览'));
  });
});
