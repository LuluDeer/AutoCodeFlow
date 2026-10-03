/**
 * UI-09 第三轮扩面：执行器操作簇三页 375px 产物锚定——
 * 执行器详情（ExecutorDetailPage）/ 应用部署（AppDeploymentPage，详情页
 * 部署 Tab 的内嵌组件）/ 执行器包管理（ExecutorPackagesPage）。
 *
 * 断言口径（与 ui09-mobile-pages.test.tsx / mobile-ui09.test.tsx 一致）：
 * jsdom 无布局引擎，只断言「渲染产物」（类名 / 内联样式 / aria 属性），
 * 不假装能断言像素宽度；像素级验证由真实浏览器 375px 实测承担。
 *
 * 本轮治理选择（对齐同簇既有范式，不发明新形态）：
 *  · 表格页走第一轮既有选择：scroll.x 横向滚动兜底 + 次要列 onCell/
 *    onHeaderCell 挂 .ui09-hide-mobile（index.css ≤768px 媒体查询隐藏），
 *    不做卡片化（卡片视图是主列表页 TaskList/ApplicationList 的选择，
 *    详情/操作簇页面的既有选择是横滚兜底，见 TaskDetailPage/ExecutionsPage）；
 *  · 页头操作行允许换行（AppDeploymentPage 标题行 flexWrap；ExecutorDetailPage
 *    头部 Space wrap / ExecutorPackagesPage 走 PageHeader 的 wrap 为既有产物）；
 *  · 弹窗宽度自适应由第一轮的全局规则承担（.ant-modal max-width ≤100vw-16px），
 *    本轮三页弹窗均为固定 width（520/540），移动端被全局规则钳制，无需逐页改；
 *  · a11y（A11Y-ICON-01 对齐 TaskListPage 惯例）：ExecutorPackagesPage 行内
 *    4 个纯图标按钮补 aria-label（antd Tooltip 不自动注入 aria-label）；
 *    ExecutorDetailPage 纯装饰状态图标（Warning/InfoCircle，均与文字并排）
 *    补 aria-hidden。AppDeploymentPage 所有按钮均带文字，无图标按钮。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cloneElement } from 'react';
import ExecutorDetailPage from '../pages/ExecutorDetailPage';
import AppDeploymentPage from '../pages/AppDeploymentPage';
import ExecutorPackagesPage from '../pages/ExecutorPackagesPage';
import { executorsApi } from '../api/executors';
import { deploymentsApi } from '../api/applications';
import { projectsApi } from '../api/projects';
import {
  listPackages,
} from '../api/executor-packages';
import { useAuthStore } from '../store/auth';
import type { ExecutorPackage } from '../api/executor-packages';

vi.mock('../api/executors', () => ({
  executorsApi: {
    // ExecutorDetailPage 读侧（queries.ts hooks）+ 写侧（页面直调）
    get: vi.fn(),
    getMetrics: vi.fn(),
    getExecutions: vi.fn(),
    getRuntimeConfig: vi.fn(),
    update: vi.fn(),
    reloadConfig: vi.fn(),
    rotateToken: vi.fn(),
    remove: vi.fn(),
    setOffline: vi.fn(),
    removalImpact: vi.fn(),
    // AppDeploymentPage（部署下拉候选）/ ExecutorPackagesPage（机队版本摘要）
    picker: vi.fn(),
    list: vi.fn(),
  },
}));
const mockedExecutors = vi.mocked(executorsApi, true);

vi.mock('../api/applications', () => ({
  deploymentsApi: {
    list: vi.fn(),
    get: vi.fn(),
    deploy: vi.fn(),
    approve: vi.fn(),
    reject: vi.fn(),
    cancel: vi.fn(),
    stop: vi.fn(),
    remove: vi.fn(),
    upgrade: vi.fn(),
  },
  applicationsApi: { upgradeAll: vi.fn() },
}));
const mockedDeployments = vi.mocked(deploymentsApi, true);

vi.mock('../api/projects', () => ({
  projectsApi: { listMyRoles: vi.fn() },
}));
const mockedProjects = vi.mocked(projectsApi, true);

vi.mock('../api/executor-packages', () => ({
  listPackages: vi.fn(),
  uploadPackage: vi.fn(),
  deletePackage: vi.fn(),
  pushPackage: vi.fn(),
  deprecatePackage: vi.fn(),
  activatePackage: vi.fn(),
  downloadPackage: vi.fn(),
}));
const mockedListPackages = vi.mocked(listPackages);

// recharts ResponsiveContainer 依赖布局测量（对齐 ui09-mobile-pages 先例：
// 注入显式宽高，其余导出用真实现）——ExecutorDetailPage 24h 资源趋势图
vi.mock('recharts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('recharts')>();
  return {
    ...actual,
    ResponsiveContainer: ({ children }: { children: React.ReactElement<Record<string, unknown>> }) =>
      cloneElement(children, { width: 200, height: 36 }),
  };
});

// jsdom 缺失 antd 依赖的浏览器 API（既有先例 shim）
const g = globalThis as Record<string, unknown>;
if (!g.ResizeObserver) {
  g.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}

// UI-09 行为断言的关键桩：按测试需要伪造断点命中，驱动 antd useBreakpoint
// 走 xs / md 两条分支（对齐 ui09-mobile-pages 的 stubMatchMedia 形态）。
let mediaMode: 'xs' | 'md' = 'xs';
function stubMatchMedia(mode: 'xs' | 'md') {
  window.matchMedia = ((q: string) => {
    const matches = mode === 'xs'
      ? q.includes('max-width: 575px')
      : /min-width: (576|768)px/.test(q);
    return {
      matches,
      media: q,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    } as unknown as MediaQueryList;
  }) as unknown as typeof window.matchMedia;
}

/** 表格横向滚动兜底：scroll.x 落到 rc-table 的 table style（width/minWidth） */
function tableScrollWidth(): number {
  const table = document.querySelector('.ant-table table') as HTMLElement | null;
  return table ? Number.parseFloat(table.style.width) : Number.NaN;
}

/** 次要列隐藏类：onCell/onHeaderCell 挂到 td/th 的元素集合 */
function hideMobileCells(selector: string): HTMLElement[] {
  return Array.from(document.querySelectorAll(`${selector}.ui09-hide-mobile`)) as HTMLElement[];
}

// —— ExecutorDetailPage 夹具（对齐 executor-detail-config.test 的数据面）——
const LONG_EXECUTOR_NAME =
  'production-cluster-nightly-full-backup-and-verify-with-a-very-long-hostname-suffix';

const executorFixture = {
  id: 'executor-1',
  appName: 'demo-executor',
  address: '10.0.0.9:3002',
  status: 'online',
  cpuUsage: 12.5,
  memUsage: 40.1,
  runningTaskCount: 0,
  maxConcurrentTasks: 10,
  lastHeartbeat: new Date().toISOString(),
};

const executorMetricsFixture = {
  executor: { id: 'executor-1', address: '10.0.0.9:3002', status: 'online' },
  sevenDayStats: { totalExecutions: 12, successful: 10, failed: 2, successRate: 83.3, averageDurationMs: 60000 },
  current: { runningTaskCount: 0 },
  history: [],
};

const execRowFixture = {
  id: 'exec-1',
  taskId: 'task-1',
  taskName: '备份任务',
  status: 'failed',
  startTime: '2026-09-07T10:00:00Z',
  duration: 60000,
  exitCode: 1,
  errorMessage: 'exit code 1',
  createdAt: '2026-09-07T10:00:00Z',
};

// —— AppDeploymentPage 夹具（对齐 app-deployment-approval.test 的数据面）——
const depFixture = {
  id: 'dep-1',
  applicationId: 'app-1',
  executorId: 'executor-1',
  executorAddress: '10.0.0.9:3002',
  status: 'running',
  runMode: 'daemon',
  deployedVersion: '1.2.0',
  deployedAt: '2026-09-07T10:00:00Z',
  createdAt: '2026-09-07T10:00:00Z',
  updatedAt: '2026-09-07T10:00:00Z',
};

// —— ExecutorPackagesPage 夹具（对齐 executor-packages-push.test 的数据面）——
const pkgFixture = (over: Partial<ExecutorPackage> = {}): ExecutorPackage =>
  ({
    id: 'pkg-1',
    name: 'python-runner',
    version: '1.0.0',
    type: 'python',
    platform: 'linux',
    fileSize: 1024,
    sha256: 'sha256',
    changelog: '',
    status: 'active',
    downloadCount: 0,
    uploadedBy: 'alice',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  }) as ExecutorPackage;

function makeQueryClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

function renderWithProviders(node: React.ReactElement, path?: string) {
  return render(
    <QueryClientProvider client={makeQueryClient()}>
      {path !== undefined ? (
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path="/executors/:id" element={node} />
            <Route path="/executors" element={<div>executor-list-mock</div>} />
          </Routes>
        </MemoryRouter>
      ) : (
        node
      )}
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mediaMode = 'xs';
  stubMatchMedia(mediaMode);
  useAuthStore.setState({ user: { id: 1, username: 'root', role: 'admin' } as never });

  // ExecutorDetailPage 数据面
  mockedExecutors.get.mockResolvedValue(executorFixture as never);
  mockedExecutors.getMetrics.mockResolvedValue(executorMetricsFixture as never);
  mockedExecutors.getExecutions.mockResolvedValue({ total: 1, items: [execRowFixture] } as never);
  mockedExecutors.getRuntimeConfig.mockResolvedValue({
    heartbeatIntervalMs: 30000,
    heartbeatTimeoutMultiplier: 3,
    heartbeatTimeoutMs: 90000,
    listLimit: 500,
    executorTotal: 1,
  } as never);
  mockedProjects.listMyRoles.mockResolvedValue({ memberships: [] } as never);

  // AppDeploymentPage 数据面（picker 轻读面；list() 恒零调用是 R4-H 契约）
  mockedExecutors.picker.mockResolvedValue({ items: [], total: 0, truncated: false, limit: 2000 } as never);
  mockedDeployments.list.mockResolvedValue({ data: [depFixture], total: 1 } as never);

  // ExecutorPackagesPage 数据面（active + deprecated 两行，覆盖弃用/激活双态 aria-label）
  mockedListPackages.mockResolvedValue({
    items: [
      pkgFixture(),
      pkgFixture({ id: 'pkg-2', name: 'node-runner', type: 'node', status: 'deprecated' }),
    ],
    total: 2,
  } as never);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  useAuthStore.getState().logout();
});

describe('UI-09 第三轮 ExecutorDetailPage 375px 产物', () => {
  it('页面根挂 ui09-exec-detail 作用域；面包屑长执行器名收敛省略号且 title 保全文', async () => {
    mockedExecutors.get.mockResolvedValue({ ...executorFixture, appName: LONG_EXECUTOR_NAME } as never);
    renderWithProviders(<ExecutorDetailPage />, '/executors/executor-1');
    await screen.findAllByText(LONG_EXECUTOR_NAME);
    // 作用域类：复用第二轮既有媒体查询规则（面包屑 li 允许收缩），本页零新增 CSS
    expect(document.querySelector('.ui09-exec-detail')).toBeTruthy();
    const crumb = document.querySelector('.ui09-crumb-ellipsis');
    expect(crumb).toBeTruthy();
    expect(crumb!.textContent).toBe(LONG_EXECUTOR_NAME);
    expect(crumb!.getAttribute('title')).toBe(LONG_EXECUTOR_NAME);
  });

  it('历史任务执行表：次要列（时长/退出码）th/td 双端挂 ui09-hide-mobile，scroll.x 兜底保留', async () => {
    renderWithProviders(<ExecutorDetailPage />, '/executors/executor-1');
    // 数据面就绪：执行历史行渲染（错误摘要是该行的可见产物）
    await screen.findByText('exit code 1');
    // scroll.x=780 落到 table style（对齐 mobile-ui09 的断言口径）
    expect(tableScrollWidth()).toBe(780);
    // 次要列双端挂类（首轮 mobile-ui09 同款断言）
    const ths = hideMobileCells('.ant-table-thead th');
    expect(ths.map((th) => th.textContent)).toEqual(['耗时', '退出码']);
    const tds = hideMobileCells('.ant-table-tbody td');
    expect(tds.length).toBe(2);
  });

  it('a11y：纯装饰状态图标（与文字并排的 InfoCircle/Warning）挂 aria-hidden', async () => {
    renderWithProviders(<ExecutorDetailPage />, '/executors/executor-1');
    // appName 同时出现在面包屑与 Descriptions 值里——用 AllBy 容忍多命中
    await screen.findAllByText('demo-executor');
    // 夹具里 运行中执行/死信/解释器 三处未上报 → 3 个 InfoCircle「未上报」提示，
    // 加上「解释器」列头的提示图标共 4 个纯装饰图标
    const hiddenInfo = document.querySelectorAll('.anticon-info-circle[aria-hidden="true"]');
    expect(hiddenInfo.length).toBeGreaterThanOrEqual(4);
  });
});

describe('UI-09 第三轮 AppDeploymentPage 375px 产物', () => {
  it('页头操作行允许换行：标题行容器内联 flexWrap=wrap（窄屏操作折到标题下方）', async () => {
    renderWithProviders(<AppDeploymentPage applicationId="app-1" />);
    const title = await screen.findByText('部署实例');
    // 标题 Text 位于 headerRow > Space > item 内，向上取 headerRow 断言内联样式
    const space = title.closest('.ant-space') as HTMLElement;
    const headerRow = space.parentElement as HTMLElement;
    expect(headerRow.style.flexWrap).toBe('wrap');
    // 换行后行间距由 gap 承担（space-between 换行时两行不贴死）
    expect(headerRow.style.gap).toBe('8px');
  });

  it('部署表：次要列（运行模式/部署时间）th/td 双端挂 ui09-hide-mobile，scroll.x 兜底保留', async () => {
    renderWithProviders(<AppDeploymentPage applicationId="app-1" />);
    await screen.findByText('运行中');
    expect(tableScrollWidth()).toBe(720);
    const ths = hideMobileCells('.ant-table-thead th');
    expect(ths.map((th) => th.textContent)).toEqual(['运行模式', '部署时间']);
    const tds = hideMobileCells('.ant-table-tbody td');
    expect(tds.length).toBe(2);
  });
});

describe('UI-09 第三轮 ExecutorPackagesPage 375px 产物', () => {
  it('包列表：次要列（平台/大小/上传者）th/td 双端挂 ui09-hide-mobile，scroll.x 兜底保留', async () => {
    renderWithProviders(<ExecutorPackagesPage />);
    await screen.findByText('python-runner');
    expect(tableScrollWidth()).toBe(1060);
    const ths = hideMobileCells('.ant-table-thead th');
    expect(ths.map((th) => th.textContent)).toEqual(['平台', '大小', '上传者']);
    const tds = hideMobileCells('.ant-table-tbody td');
    expect(tds.length).toBe(6); // 3 列 × 2 行
  });

  it('a11y：行内 4 个纯图标按钮补 aria-label（antd Tooltip 不自动注入），弃用/激活按状态区分', async () => {
    renderWithProviders(<ExecutorPackagesPage />);
    await screen.findByText('python-runner');

    // 行内纯图标按钮：按图标类定位（对齐 executor-packages-push 的 openPushModal 口径）
    const btnByIcon = (iconCls: string): HTMLButtonElement[] =>
      Array.from(document.querySelectorAll(`.ant-table-tbody button .${iconCls}`))
        .map((icon) => (icon as HTMLElement).closest('button') as HTMLButtonElement);

    // 下载 ×2（每行一个）：aria-label 与 Tooltip 文案同源（i18n 既有键复用）
    const downloadBtns = btnByIcon('anticon-cloud-download');
    expect(downloadBtns.length).toBe(2);
    for (const btn of downloadBtns) {
      expect(btn.getAttribute('aria-label')).toBe('下载');
    }
    // 推送 ×2
    const pushBtns = btnByIcon('anticon-send');
    expect(pushBtns.length).toBe(2);
    for (const btn of pushBtns) {
      expect(btn.getAttribute('aria-label')).toBe('推送到调度机');
    }
    // 弃用/激活按行状态区分：active 行=弃用此包，deprecated 行=激活此包
    // （sort 按 UTF-16 码元序：'弃'U+5F03 < '激'U+6FC0）
    const toggleBtns = [
      ...btnByIcon('anticon-stop'),
      ...btnByIcon('anticon-check-circle'),
    ];
    expect(toggleBtns.map((b) => b.getAttribute('aria-label')).sort()).toEqual(['弃用此包', '激活此包']);
    // 删除 ×2
    const deleteBtns = btnByIcon('anticon-delete');
    expect(deleteBtns.length).toBe(2);
    for (const btn of deleteBtns) {
      expect(btn.getAttribute('aria-label')).toBe('删除');
    }
  });
});
