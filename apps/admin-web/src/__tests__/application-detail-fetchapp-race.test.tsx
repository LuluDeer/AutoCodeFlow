/**
 * NETOPT-7④ 反证回归：ApplicationDetailPage 的 fetchApp 无守卫，两个应用详情间
 * 导航（同路由 :id 组件不重挂）新旧请求并发：
 *   1) 旧 id 的响应晚到 → setApp(旧应用)，新应用页面显示旧应用内容；
 *   2) 旧 id 404 分支 → setNotFound(true) + nav('/applications')，
 *      把用户从正在看的新页面踢走。
 *
 * 修法：fetchAppSeq 序号守卫——await 落地后（成功/404/其他错误/finally 四条路径）
 * 先比对再 setState。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, act } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useNavigate, useLocation } from 'react-router-dom';
import ApplicationDetailPage from '../pages/ApplicationDetailPage';
import { applicationsApi, type Application } from '../api/applications';

vi.mock('../api/applications', () => ({
  applicationsApi: {
    get: vi.fn(),
    update: vi.fn(),
    syncTasks: vi.fn(),
    getVersionHistory: vi.fn(),
    rollback: vi.fn(),
  },
}));
vi.mock('../api/tasks', () => ({ tasksApi: { list: vi.fn() } }));
vi.mock('../api/ai', () => ({ aiApi: { analyzeApp: vi.fn() } }));
vi.mock('../pages/AppDeploymentPage', () => ({
  default: () => <div data-testid="app-deployment-mock" />,
}));

// jsdom 缺失 antd 依赖的浏览器 API（对齐 application-detail.test 先例）
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

const appFixture = (id: string, name: string): Application => ({
  id,
  name,
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
});

/** useNavigate/useLocation 探针：程序化导航等价应用详情间导航（同路由组件不重挂） */
let navigateTo: (to: string) => void = () => {};
function NavProbe() {
  const nav = useNavigate();
  const loc = useLocation();
  navigateTo = nav;
  return <span data-testid="loc-probe">{loc.pathname}</span>;
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/applications/app-1']}>
      <NavProbe />
      <Routes>
        <Route path="/applications/:id" element={<ApplicationDetailPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.mocked(applicationsApi.get).mockReset();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('ApplicationDetailPage fetchApp 跨应用导航竞态（NETOPT-7④）', () => {
  it('旧应用响应晚到，不得覆盖新应用详情', async () => {
    const appA = appFixture('app-1', 'demo-app-a');
    const appB = appFixture('app-2', 'other-app-b');
    let resolveA!: (v: Application) => void;
    vi.mocked(applicationsApi.get).mockImplementation(async (id: string) => {
      if (id === 'app-1') return new Promise<Application>((res) => { resolveA = res; });
      return appB;
    });

    renderPage();
    // app-1 请求悬而未决（骨架屏），直接切到 app-2
    await act(async () => {
      navigateTo('/applications/app-2');
    });
    await screen.findAllByText('other-app-b');
    expect(screen.getByTestId('loc-probe').textContent).toBe('/applications/app-2');

    // 旧应用的响应晚到
    await act(async () => {
      resolveA(appA);
    });

    // 反证断言：页面仍是 app-2
    expect(screen.queryAllByText('demo-app-a')).toHaveLength(0);
    expect(screen.getAllByText('other-app-b').length).toBeGreaterThan(0);
    expect(screen.getByTestId('loc-probe').textContent).toBe('/applications/app-2');
  }, 15_000);

  it('旧应用的 404 晚到，不得把用户从新页面踢走', async () => {
    const appB = appFixture('app-2', 'other-app-b');
    const notFoundErr = { response: { status: 404 } };
    let rejectA!: (e: unknown) => void;
    vi.mocked(applicationsApi.get).mockImplementation(async (id: string) => {
      if (id === 'app-1') {
        return new Promise<Application>((_res, rej) => { rejectA = () => rej(notFoundErr); });
      }
      return appB;
    });

    renderPage();
    await act(async () => {
      navigateTo('/applications/app-2');
    });
    await screen.findAllByText('other-app-b');

    // 旧应用的 404 晚到
    await act(async () => {
      rejectA(notFoundErr);
    });

    // 反证断言：未导航回列表、未出现 notFound 空态，页面仍是 app-2
    expect(screen.getByTestId('loc-probe').textContent).toBe('/applications/app-2');
    expect(screen.queryByText('应用不存在')).toBeNull();
    expect(screen.getAllByText('other-app-b').length).toBeGreaterThan(0);
  }, 15_000);
});
