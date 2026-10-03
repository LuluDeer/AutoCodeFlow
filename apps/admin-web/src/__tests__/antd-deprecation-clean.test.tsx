// @vitest-environment jsdom
/**
 * antd v6 弃用 prop / rc Descriptions span 越限收敛（真实 Chromium 走查
 * test-results/ux-walkthrough/report.md 的 console.error 清单）：
 *
 *  - task-detail@375/1280：`[antd: Drawer] width is deprecated. Please use size instead`
 *    → TaskDetailPage 版本历史抽屉 width={720} 迁 size（R5-A 先例）。
 *  - app-detail@375/1280：`[rc-collapse] children will be removed…use items instead`
 *    → ApplicationDetailPage 两处 Collapse.Panel 子元素式迁 items API。
 *  - app-detail@375：`[antd: Descriptions] Sum of column span in a line not match column`
 *    → 概览 Descriptions 写死 span={3}/{2}，在 xs(1 列)/sm(2 列) 断点超出列数。
 *      判据见 antd/es/descriptions/hooks/useRow.js：行内累计 count > mergedColumn
 *      即 exceed 告警，且 antd 会把该 item **钳制挤压进当前行剩余列**（sm 下
 *      描述被挤进「状态」同行半格）——是真实布局风险，不只是噪声。
 *  - execution-detail@375：同款 span 告警 → 真实来源是 ExecutionInfoCard 解释器块
 *    （ExecutionDetailPage 自身无 Descriptions）：池清单/详情两项写死
 *    span={UI09_DESCRIPTIONS_COLUMN.md}=3。
 *  - executor-detail@375：同款 span 告警 → 描述项写死 span={2}。
 *
 * 修法统一走 antd 6.6.5+ 的 span="filled"（填满当前行）/断点对象（gitRepo：
 * sm 及以上占 2 列，xs 收敛 1），各断点渲染产物与修复前一致（exceed 分支的
 * 钳制值恰等于 filled/断点对象解析值），告警消除。
 *
 * 断言口径：
 *  1) 动态——渲染四页 + spy console.error：不得出现 deprecated / Sum of column /
 *     rc-collapse children 告警。jsdom 下 antd 照常发射（NODE_ENV=test 时
 *     resetWarned 每次清位，告警必发射不吞）；matchMedia 桩驱动 xs/sm/md 三档，
 *     xs(1 列) 是 exceed 判据的最紧边界——「span 加总=column」在动态侧由此覆盖。
 *  2) 静态——读组件源码锚定 span 配置形态（raw-enum-labels.ux06 风格）：
 *     本仓 Descriptions 列配置最小列恒为 xs:1，任何写死数字 span(>1) 都必然在
 *     xs 越限，故源码层禁止 Descriptions.Item 出现数字 span，只允许
 *     'filled'/断点对象/缺省(=1)。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, createMemoryRouter, RouterProvider } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cloneElement } from 'react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import TaskDetailPage from '../pages/TaskDetailPage';
import ApplicationDetailPage from '../pages/ApplicationDetailPage';
import ExecutorDetailPage from '../pages/ExecutorDetailPage';
import ExecutionDetailPage from '../pages/ExecutionDetailPage';
import { tasksApi } from '../api/tasks';
import { executorsApi } from '../api/executors';
import { applicationsApi } from '../api/applications';
import { useAuthStore } from '../store/auth';

vi.mock('../api/tasks', () => ({
  tasksApi: {
    schedulerStats: vi.fn(),
    get: vi.fn(),
    stats: vi.fn(),
    executions: vi.fn(),
    execution: vi.fn(),
    versions: vi.fn(),
    webhookStatus: vi.fn(),
    list: vi.fn(),
    listAll: vi.fn(),
    rollback: vi.fn(),
    getReleases: vi.fn(),
    syncTasks: vi.fn(),
    upgradeAll: vi.fn(),
    killExecution: vi.fn(),
    trigger: vi.fn(),
    updateGlue: vi.fn(),
    allExecutions: vi.fn(),
  },
}));
vi.mock('../api/artifacts', () => ({
  artifactsApi: { listArtifacts: vi.fn(), downloadArtifact: vi.fn() },
}));
vi.mock('../api/execution-reports', () => ({
  executionReportsApi: { report: vi.fn() },
}));
vi.mock('../api/executors', () => ({
  executorsApi: {
    list: vi.fn(),
    get: vi.fn(),
    getGroups: vi.fn(),
    getTags: vi.fn(),
    getMetrics: vi.fn(),
    getExecutions: vi.fn(),
    getRuntimeConfig: vi.fn(),
  },
}));
vi.mock('../api/applications', () => ({
  applicationsApi: {
    list: vi.fn(),
    get: vi.fn(),
    update: vi.fn(),
    getVersionHistory: vi.fn(),
    rollback: vi.fn(),
    getReleases: vi.fn(),
    syncTasks: vi.fn(),
    upgradeAll: vi.fn(),
  },
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
}));
vi.mock('../api/projects', () => ({ projectsApi: { list: vi.fn() } }));
vi.mock('../api/task-templates', () => ({
  taskTemplatesApi: { list: vi.fn(), get: vi.fn(), create: vi.fn(), remove: vi.fn(), instantiate: vi.fn() },
}));
vi.mock('../api/ai', () => ({
  aiApi: { suggestSchedule: vi.fn(), analyzeApp: vi.fn(), analyzeExecution: vi.fn() },
}));
// 重依赖裁剪（对齐 ui09-mobile-pages 同名桩）
vi.mock('../components/GlueEditor', () => ({ default: () => <div data-testid="glue-editor" /> }));
vi.mock('../components/TaskDependencyGraph', () => ({ default: () => <div data-testid="dep-graph" /> }));
vi.mock('../components/ParamsEditor', () => ({ default: () => <div data-testid="params-editor" /> }));
vi.mock('recharts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('recharts')>();
  return {
    ...actual,
    ResponsiveContainer: ({ children }: { children: React.ReactElement<Record<string, unknown>> }) =>
      cloneElement(children, { width: 200, height: 36 }),
  };
});

// jsdom 缺失的浏览器 API（既有先例 shim）
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

// 断点桩：antd responsiveObserver 用有界区间媒体查询（sm=576-767、md=768-991）。
// md 档放行 576/768 两条 min-width（累计语义，matchScreen 大→小扫描取 md）。
type MediaMode = 'xs' | 'sm' | 'md';
function stubMatchMedia(mode: MediaMode) {
  window.matchMedia = ((q: string) => {
    let matches: boolean;
    if (mode === 'xs') matches = q.includes('max-width: 575px');
    else if (mode === 'sm') matches = q.includes('min-width: 576px') && !q.includes('min-width: 768px');
    else matches = /min-width: (576|768|992|1200|1600)px/.test(q);
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

// UI-14 / SSE 相关：jsdom 无 EventSource
class NoopEventSource {
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) {}
  addEventListener() {}
  close() {}
}

// —— 走查同款夹具：字段必须足以渲染全部告警路径 ——

const appFixture = {
  id: 'app-2001',
  name: '数据采集平台-生产环境-长名称验证用例',
  description: '分布式采集与清洗管线，含 12 个子任务',
  status: 'active',
  version: '2.3.1',
  runtime: 'python',
  // gitRepo(span={{sm:2}})/gitBranch(补行)/gitCommit/entrypoint：驱动概览
  // Descriptions 的跨列与非跨列混排
  gitRepo: 'https://git.example.com/demo/repo.git',
  gitBranch: 'main',
  gitCommit: 'f00dcafe1234567890',
  entrypoint: 'main.py',
  // env/manifest：驱动两处 Collapse（items API 迁移面）
  env: { DB_URL: 'postgres://db.internal/etl', LOG_LEVEL: 'info' },
  manifest: { kind: 'python', entry: 'main.py', requirements: ['requests'] },
  createdAt: '2026-07-15T10:12:41Z',
  updatedAt: '2026-09-30T08:00:00Z',
};

const executorFixture = {
  id: 'ex-3001',
  appName: '上海电信机房-生产执行器-01-长名称验证用例',
  address: 'http://192.168.4.54:9001',
  status: 'online',
  type: 'python',
  executorVersion: '1.4.2',
  dispatchMode: 'pull',
  groupName: 'prod-bj',
  tags: ['ssd', 'prod'],
  maxConcurrentTasks: 4,
  runningTaskCount: 1,
  // 描述：span="filled" 迁移面（原 span={2} 在 xs 越限）
  description: '生产库每日全量备份专用执行器，长描述验证跨列渲染',
  deadLetterCount: 0,
  lastHeartbeat: new Date().toISOString(),
  interpreters: [
    { version: '3.12.11', path: '/pool/3.12.11/bin/python', available: true, discoveredAt: '2026-09-30T08:00:00Z' },
  ],
};

// result.interpreter：驱动 ExecutionInfoCard 解释器块（池清单/详情两个
// span="filled" 迁移项——execution-detail 路由 span 告警的真实来源）
const execFixture = {
  id: 'e-9001',
  taskId: 't-1001',
  taskName: '生产库每日全量备份-含超长名称验证用例-very-long-suffix',
  status: 'failed',
  triggerType: 'cron',
  logs: 'line-1\nline-2',
  failureReason: 'interpreter_unavailable',
  errorMessage: 'interpreter 3.7 unavailable: not_downloadable',
  retryCount: 1,
  exitCode: 1,
  duration: 60000,
  executorAddress: '192.168.4.54:9001',
  taskVersion: 'v3',
  startTime: '2026-10-02T10:00:00Z',
  endTime: '2026-10-02T10:01:00Z',
  createdAt: '2026-10-02T10:00:00Z',
  result: {
    interpreter: {
      requested: '3.7',
      resolved: null,
      reason: 'not_downloadable',
      detail: '3.7 needs offline prefill, see executor docs',
      pool: { install_dir: '/pool', versions: ['3.12.11', '3.9.20'] },
    },
  },
};

const taskFixture = {
  id: 't-1001',
  name: '生产库每日全量备份-含超长名称验证用例-very-long-suffix',
  maxRetry: 3,
  retryDelay: 5,
  params: { region: 'cn-north-1' },
};

const taskVersionFixture = {
  id: 'v-1',
  taskId: 't-1001',
  version: 3,
  config: { params: { region: 'cn-north-1' } },
  createdAt: '2026-09-20T08:00:00Z',
  createdBy: 'alice',
};

function makeQueryClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

function renderWithProviders(path: string, routes: Array<{ path: string; element: React.ReactElement }>) {
  return render(
    <QueryClientProvider client={makeQueryClient()}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          {routes.map((r) => (
            <Route key={r.path} path={r.path} element={r.element} />
          ))}
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function renderOnDataRouter(node: React.ReactElement, path: string) {
  const router = createMemoryRouter(
    [
      { path: '/tasks/:id', element: node },
      { path: '/applications/:id', element: node },
    ],
    { initialEntries: [path] },
  );
  return render(
    <QueryClientProvider client={makeQueryClient()}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

/** console.error 捕获：断言走查四告警类不再出现。 */
function captureConsoleError() {
  const captured: string[] = [];
  const spy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    captured.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a) ?? String(a))).join(' '));
  });
  return {
    spy,
    /** 走查三类告警：deprecated prop / rc Descriptions span 越限 / rc-collapse children */
    assertClean() {
      const hits = captured.filter((line) =>
        /is deprecated|Sum of column|will be removed/.test(line),
      );
      expect(hits).toEqual([]);
    },
    restore() {
      spy.mockRestore();
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('EventSource', NoopEventSource);
  stubMatchMedia('xs');
  useAuthStore.setState({ user: { id: 1, username: 'alice', role: 'admin' } as never });
  // —— 公共数据面默认值（各用例可覆盖）——
  vi.mocked(tasksApi.get).mockResolvedValue(taskFixture as never);
  vi.mocked(tasksApi.stats).mockResolvedValue({
    recentExecutions: [],
    successRate: 0,
    avgDuration: 0,
    totalRuns: 0,
  } as never);
  vi.mocked(tasksApi.webhookStatus).mockResolvedValue({ enabled: false, url: '' } as never);
  vi.mocked(tasksApi.executions).mockResolvedValue({
    items: [{ id: 'e-9001', retryCount: 1, status: 'failed' }],
    total: 1,
    page: 1,
    pageSize: 20,
  } as never);
  vi.mocked(tasksApi.execution).mockResolvedValue(execFixture as never);
  vi.mocked(tasksApi.versions).mockResolvedValue([taskVersionFixture] as never);
  vi.mocked(tasksApi.schedulerStats).mockResolvedValue({
    healthy: true,
    activeTimers: 1,
    activeCronTasks: 1,
    runningTaskCount: 0,
    totalScheduledTasks: 1,
    uptime: 60,
  } as never);
  vi.mocked(tasksApi.list).mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 20 } as never);
  vi.mocked(executorsApi.list).mockResolvedValue([] as never);
  vi.mocked(executorsApi.getGroups).mockResolvedValue([] as never);
  vi.mocked(executorsApi.getTags).mockResolvedValue([] as never);
  vi.mocked(applicationsApi.list).mockResolvedValue([] as never);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  useAuthStore.getState().logout();
});

describe('走查告警收敛：task-detail 抽屉 size 迁移', () => {
  it('渲染 + 打开版本历史抽屉（含抽屉打开态）console.error 无 Drawer deprecated', async () => {
    vi.mocked(tasksApi.get).mockResolvedValue(taskFixture as never);
    const cap = captureConsoleError();
    renderOnDataRouter(<TaskDetailPage />, '/tasks/t-1001');
    await screen.findByTestId('page-header');
    // 打开抽屉：迁移点在 Drawer 的 size prop，关闭态也应触发（走查即页面
    // 加载时告警），打开态再加一层保险。
    fireEvent.click(screen.getByTestId('version-history'));
    await waitFor(() => expect(document.querySelector('.ant-drawer-open')).toBeTruthy());
    cap.assertClean();
    cap.restore();
  });
});

describe('走查告警收敛：app-detail Collapse items + Descriptions span', () => {
  it('概览渲染（env/manifest 折叠块 + git 跨列项）console.error 无 rc-collapse/Sum of column', async () => {
    vi.mocked(applicationsApi.get).mockResolvedValue(appFixture as never);
    const cap = captureConsoleError();
    renderOnDataRouter(<ApplicationDetailPage />, '/applications/app-2001');
    await screen.findByText('应用信息');
    // 概览 Descriptions + env 折叠块（items API）都在文档里
    expect(screen.getByText(/环境变量 \(/)).toBeTruthy();
    cap.assertClean();
    cap.restore();
  });

  it('sm 断点（2 列）下同样无 Sum of column 告警——跨列项不再挤压「状态」同行', async () => {
    vi.mocked(applicationsApi.get).mockResolvedValue(appFixture as never);
    stubMatchMedia('sm');
    const cap = captureConsoleError();
    renderOnDataRouter(<ApplicationDetailPage />, '/applications/app-2001');
    await screen.findByText('应用信息');
    cap.assertClean();
    cap.restore();
  });
});

describe('走查告警收敛：executor-detail Descriptions span', () => {
  it('详情渲染 console.error 无 Sum of column', async () => {
    vi.mocked(executorsApi.get).mockResolvedValue(executorFixture as never);
    vi.mocked(executorsApi.getMetrics).mockResolvedValue({
      executor: { id: 'ex-3001', address: '192.168.4.54:9001', status: 'online' },
      sevenDayStats: { totalExecutions: 0, successful: 0, failed: 0, successRate: 0, averageDurationMs: 0 },
      current: { runningTaskCount: 1 },
      history: [],
    } as never);
    vi.mocked(executorsApi.getExecutions).mockResolvedValue({ total: 0, items: [] } as never);
    vi.mocked(executorsApi.getRuntimeConfig).mockResolvedValue({ heartbeatTimeoutMs: 90_000 } as never);
    const cap = captureConsoleError();
    renderWithProviders(
       '/executors/ex-3001',
      [{ path: '/executors/:id', element: <ExecutorDetailPage /> }],
    );
    await screen.findAllByText(executorFixture.appName);
    cap.assertClean();
    cap.restore();
  });
});

describe('走查告警收敛：execution-detail Descriptions span（ExecutionInfoCard 解释器块）', () => {
  it('执行详情渲染（含解释器留痕块）console.error 无 Sum of column', async () => {
    const cap = captureConsoleError();
    renderWithProviders(
      '/tasks/t-1001/executions/e-9001',
      [{ path: '/tasks/:taskId/executions/:execId', element: <ExecutionDetailPage /> }],
    );
    // 解释器块渲染（data-testid 见 ExecutionInfoCard）：池清单/详情两项
    // 正是原 span={3} 越限面
    await screen.findByTestId('execution-interpreter');
    cap.assertClean();
    cap.restore();
  });

  it('md 断点（3 列）下解释器块同样无 Sum of column 告警', async () => {
    stubMatchMedia('md');
    const cap = captureConsoleError();
    renderWithProviders(
      '/tasks/t-1001/executions/e-9001',
      [{ path: '/tasks/:taskId/executions/:execId', element: <ExecutionDetailPage /> }],
    );
    await screen.findByTestId('execution-interpreter');
    cap.assertClean();
    cap.restore();
  });
});

// ---------------------------------------------------------------------------
// 静态源码锚定（raw-enum-labels.ux06 风格）：span 配置形态守卫。
// 本仓 Descriptions 列配置最小列恒为 xs:1——任何写死数字 span(>1) 必然在 xs
// 越限（useRow exceed 判据）。故 Descriptions.Item 的 span 只允许
// 'filled' / 断点对象 / 缺省(=1)；Drawer 不得再出现 width prop。
// ---------------------------------------------------------------------------
const SRC = join(__dirname, '..');
const read = (rel: string) => readFileSync(join(SRC, rel.replace(/^src\//, '')), 'utf-8');
/** 注释不参与断言（历史注记会提到旧写法，raw-enum-labels.ux06 同款处理） */
const stripComments = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
/** 数字 span（如 span={3}/span={2}）出现在 Descriptions.Item 开标签内 */
const NUMERIC_SPAN_ON_ITEM = /<Descriptions\.Item\b[^>]*?\sspan=\{\s*\d/;
const DEPRECATION_CLEAN_DESC = 'Descriptions.Item 不得写死数字 span（xs 单列必越限），用 span="filled"/断点对象';

describe('静态守卫：Descriptions span 与 Drawer size 配置形态', () => {
  it('ApplicationDetailPage：无数字 span、无 Collapse.Panel 子元素式', () => {
    const src = stripComments(read('src/pages/ApplicationDetailPage.tsx'));
    expect(src).not.toMatch(NUMERIC_SPAN_ON_ITEM);
    expect(src).toContain('span="filled"'); // 描述：整行
    expect(src).toContain('span={{ sm: 2 }}'); // git 仓库：sm+ 占 2 列、xs 收敛 1
    expect(src).not.toContain('Collapse.Panel'); // items API 迁移闭合
    expect(DEPRECATION_CLEAN_DESC).toBeTruthy();
  });

  it('ExecutorDetailPage：描述项用 span="filled"', () => {
    const src = stripComments(read('src/pages/ExecutorDetailPage.tsx'));
    expect(src).not.toMatch(NUMERIC_SPAN_ON_ITEM);
    expect(src).toContain('span="filled"');
  });

  it('ExecutionInfoCard（execution-detail 告警真实来源）：解释器块两项用 span="filled"', () => {
    const src = stripComments(read('src/components/ExecutionInfoCard.tsx'));
    expect(src).not.toMatch(NUMERIC_SPAN_ON_ITEM);
    expect(src).not.toContain('span={UI09_DESCRIPTIONS_COLUMN.md}');
    // 池清单 + 详情两项
    expect(src.match(/span="filled"/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it('TaskDetailPage：Drawer 用 size 不再用 width', () => {
    const src = stripComments(read('src/pages/TaskDetailPage.tsx'));
    const drawerBlock = src.slice(src.indexOf('<Drawer'), src.indexOf('</Drawer>'));
    expect(drawerBlock).not.toMatch(/\bwidth=/);
    expect(drawerBlock).toContain("size={isMobile ? '100%' : 720}");
    // 桌面宽度语义不变（720px）已由上一断言锚定
  });
});
