/**
 * APP-SELECT-01：任务表单「可检索应用选择器」组件级回归。
 *
 * 背景：zip 应用多起来后，两处应用 Select（zip 必填载体 / 部署绑定）原来只有
 * name 平铺 + 按名称过滤——搜不到描述/版本、看不出 runtime 是否匹配任务、
 * 不知道应用整包是否就绪、无应用时没有引导。本文件钉死升级后的四层行为：
 *   1) 富信息选项：name + version + runtime Tag + updatedAt 相对时间（+描述）；
 *   2) 过滤走自定义 search 字符串（名称+描述+版本），ReactNode label 不破坏过滤；
 *   3) zip 分支健康语义：deploying/failed 禁用并显示原因（绑定分支不禁用）；
 *      runtime 与任务不一致的应用保持可选，但 Tag 提前变警示色（与提交侧
 *      Alert 同口径、不动其语义）；
 *   4) 空态：无应用 → 引导文案 + 前往应用管理链接；加载中 → Spin；
 *      搜索无命中 → 改关键词提示；zip 分支 extra 显示「共 N 个应用」。
 *
 * mock 脚手架与 python-multiversion-form-wiring.test.tsx 同款（api 层隔离 +
 * GlueEditor 裁剪 + react-router-dom 覆写）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuthStore } from '../store/auth';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import TaskFormPage from '../pages/TaskFormPage';
import { tasksApi } from '../api/tasks';
import { executorsApi } from '../api/executors';
import { applicationsApi } from '../api/applications';
import { projectsApi } from '../api/projects';

vi.mock('../api/tasks', () => ({
  tasksApi: {
    get: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    list: vi.fn(),
    listAll: vi.fn().mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 100 }),
  },
}));
vi.mock('../api/executors', () => ({
  executorsApi: { list: vi.fn(), getGroups: vi.fn(), getTags: vi.fn() },
}));
vi.mock('../api/applications', () => ({ applicationsApi: { list: vi.fn() } }));
vi.mock('../api/projects', () => ({ projectsApi: { list: vi.fn() } }));
// GlueEditor 是 monaco 重依赖（jsdom 缺浏览器 API），组件级用例一律桩掉。
vi.mock('../components/GlueEditor', () => ({ default: () => <div data-testid="glue-editor" /> }));

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return {
    ...actual,
    useNavigate: () => vi.fn(),
    useBlocker: () => ({ state: 'unblocked' as const, proceed: () => {}, reset: () => {} }),
    useParams: () => ({}),
    useSearchParams: () => [new URLSearchParams('')],
    // 无 Router 包裹渲染页面：Link 降级为裸 a（对齐 task-form-ui06 先例）。
    Link: (props: { to: string; children: React.ReactNode }) => <a href={props.to}>{props.children}</a>,
  };
});

// jsdom 缺失 antd 依赖的浏览器 API，先行补齐（对齐既有先例）。
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
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}

/** zip 下拉的占位文案（定位该分支选择器的锚点） */
const ZIP_PLACEHOLDER = '选择要部署的 zip 应用';
/** 部署绑定下拉的占位文案（git 来源分支） */
const BIND_PLACEHOLDER = '选择应用（可不关联）';

/** 全字段应用桩：覆盖富选项要展示的每个读面字段 */
function makeApp(overrides: Record<string, unknown>) {
  return {
    id: 'app-1',
    name: 'etl-job',
    version: '1.2.0',
    runtime: 'python',
    description: 'ETL 清洗任务包',
    status: 'active',
    updatedAt: new Date(Date.now() - 2 * 3600_000).toISOString(),
    ...overrides,
  };
}

/** 切到 zip 来源并打开应用下拉，等待首选项渲染后返回下拉容器 */
async function openZipAppDropdown(firstName = 'etl-job') {
  fireEvent.click(screen.getByTestId('code-source-application_zip'));
  const select = screen.getByText(ZIP_PLACEHOLDER).closest('.ant-select') as HTMLElement;
  fireEvent.mouseDown(select);
  await screen.findByTitle(firstName);
  return select;
}

/** 打开部署绑定（git 来源）下拉 */
async function openBindAppDropdown(firstName = 'etl-job') {
  const select = await screen.findByText(BIND_PLACEHOLDER).then((el) => el.closest('.ant-select') as HTMLElement);
  fireEvent.mouseDown(select);
  await screen.findByTitle(firstName);
  return select;
}

/** 读取某个应用选项所在的行元素（title 挂在行 div 上） */
function optionRowOf(name: string) {
  return screen.getByTitle(name).closest('.ant-select-item') as HTMLElement;
}

const testQueryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
const renderPage = () =>
  render(
    <QueryClientProvider client={testQueryClient}>
      <TaskFormPage />
    </QueryClientProvider>,
  );

beforeEach(() => {
  useAuthStore.setState({ user: { id: 1, username: 'root', role: 'admin' } });
  vi.mocked(executorsApi.list).mockReset().mockResolvedValue([] as never);
  vi.mocked(executorsApi.getGroups).mockReset().mockResolvedValue([] as never);
  vi.mocked(executorsApi.getTags).mockReset().mockResolvedValue([] as never);
  vi.mocked(applicationsApi.list).mockReset().mockResolvedValue([] as never);
  vi.mocked(projectsApi.list).mockReset().mockResolvedValue([] as never);
  vi.mocked(tasksApi.listAll).mockReset().mockResolvedValue({
    items: [], total: 0, page: 1, pageSize: 100,
  } as never);
});

afterEach(() => {
  cleanup();
});

describe('APP-SELECT-01 富信息选项（zip 必填载体分支）', () => {
  it('下拉项展示 name + version + runtime Tag + updatedAt 相对时间 + 描述', async () => {
    vi.mocked(applicationsApi.list).mockResolvedValue([
      makeApp({}),
    ] as never);
    renderPage();

    await openZipAppDropdown();

    const row = optionRowOf('etl-job');
    // version（不带 "undefined" 兜底——字段缺失时不渲染，而非渲染脏文本）
    expect(row.textContent).toContain('v1.2.0');
    // runtime Tag
    expect(row.textContent).toContain('python');
    expect(row.querySelector('.ant-tag')).toBeTruthy();
    // updatedAt 相对时间（2 小时前）
    expect(row.textContent).toContain('小时前');
    // 描述截断展示
    expect(row.textContent).toContain('ETL 清洗任务包');
  }, 20_000);

  it('runtime 与任务运行时不一致：保持可选，但 runtime Tag 提前变警示色（不动提交侧 Alert 语义）', async () => {
    vi.mocked(applicationsApi.list).mockResolvedValue([
      makeApp({ id: 'app-node', name: 'node-app', runtime: 'node' }),
    ] as never);
    renderPage();

    await openZipAppDropdown('node-app');
    // 任务 runtime 默认 python，应用是 node → Tag 用警示色（orange）标出
    const row = optionRowOf('node-app');
    const runtimeTag = Array.from(row.querySelectorAll('.ant-tag')).find((el) => el.textContent === 'node');
    expect(runtimeTag).toBeTruthy();
    expect(runtimeTag?.className).toContain('ant-tag-orange');
    // 不一致 ≠ 不可选：行不是 disabled
    expect(row.className).not.toContain('ant-select-item-option-disabled');
  }, 20_000);
});

describe('APP-SELECT-01 检索（自定义 search 字符串）', () => {
  it('按描述关键词命中：ReactNode label 下过滤仍可用', async () => {
    vi.mocked(applicationsApi.list).mockResolvedValue([
      makeApp({ id: 'app-1', name: 'etl-job', description: 'ETL 清洗任务包' }),
      makeApp({ id: 'app-2', name: 'report-gen', description: '日报生成' }),
    ] as never);
    renderPage();

    const select = await openZipAppDropdown();
    const input = select.querySelector('input') as HTMLInputElement;

    // 描述关键词：只有 etl-job 命中（旧实现仅按名称过滤，这里必然搜不到）
    fireEvent.change(input, { target: { value: '清洗' } });
    await waitFor(() => {
      expect(screen.getByTitle('etl-job')).toBeTruthy();
      expect(screen.queryByTitle('report-gen')).toBeNull();
    });
  }, 20_000);

  it('按版本号命中', async () => {
    vi.mocked(applicationsApi.list).mockResolvedValue([
      makeApp({ id: 'app-1', name: 'etl-job', version: '1.2.0' }),
      makeApp({ id: 'app-2', name: 'report-gen', version: '3.0.0' }),
    ] as never);
    renderPage();

    const select = await openZipAppDropdown();
    const input = select.querySelector('input') as HTMLInputElement;

    fireEvent.change(input, { target: { value: '3.0.0' } });
    await waitFor(() => {
      expect(screen.queryByTitle('etl-job')).toBeNull();
      expect(screen.getByTitle('report-gen')).toBeTruthy();
    });
  }, 20_000);

  it('无命中时给「改关键词」提示（与「无应用」空态区分）', async () => {
    vi.mocked(applicationsApi.list).mockResolvedValue([
      makeApp({}),
    ] as never);
    renderPage();

    const select = await openZipAppDropdown();
    const input = select.querySelector('input') as HTMLInputElement;

    fireEvent.change(input, { target: { value: 'zzz-no-such-app' } });
    await waitFor(() => {
      expect(screen.getByText('没有匹配的应用：支持按名称、描述、版本搜索')).toBeTruthy();
    });
    // 不是「无应用」引导
    expect(screen.queryByTestId('app-select-empty-guide')).toBeNull();
  }, 20_000);
});

describe('APP-SELECT-01 zip 分支健康语义（active/deploying/failed）', () => {
  beforeEach(() => {
    vi.mocked(applicationsApi.list).mockResolvedValue([
      makeApp({ id: 'app-ok', name: 'healthy-app', status: 'active' }),
      makeApp({ id: 'app-dep', name: 'deploying-app', status: 'deploying' }),
      makeApp({ id: 'app-fail', name: 'failed-app', status: 'failed' }),
    ] as never);
  });

  it('deploying/failed 禁用并显示原因；active 可选', async () => {
    renderPage();
    await openZipAppDropdown('healthy-app');

    // active：可选
    expect(optionRowOf('healthy-app').className).not.toContain('ant-select-item-option-disabled');
    // deploying：禁用 + 原因
    const depRow = optionRowOf('deploying-app');
    expect(depRow.className).toContain('ant-select-item-option-disabled');
    expect(depRow.textContent).toContain('部署中');
    expect(depRow.textContent).toContain('整包尚未就绪，暂不可选');
    // failed：禁用 + 原因
    const failRow = optionRowOf('failed-app');
    expect(failRow.className).toContain('ant-select-item-option-disabled');
    expect(failRow.textContent).toContain('部署失败');
    expect(failRow.textContent).toContain('没有可用的整包');
  }, 20_000);

  it('部署绑定分支不禁用 deploying/failed（绑定关系与代码来源正交）', async () => {
    renderPage();
    await openBindAppDropdown('healthy-app');

    expect(optionRowOf('deploying-app').className).not.toContain('ant-select-item-option-disabled');
    expect(optionRowOf('failed-app').className).not.toContain('ant-select-item-option-disabled');
  }, 20_000);

  it('zip 分支 extra 显示「共 N 个应用」计数', async () => {
    renderPage();
    fireEvent.click(screen.getByTestId('code-source-application_zip'));
    expect(await screen.findByText('共 3 个应用')).toBeTruthy();
  }, 20_000);
});

describe('APP-SELECT-01 空态', () => {
  it('无应用：引导文案 + 前往应用管理（/applications）链接', async () => {
    vi.mocked(applicationsApi.list).mockResolvedValue([] as never);
    renderPage();

    fireEvent.click(screen.getByTestId('code-source-application_zip'));
    const select = await screen.findByText(ZIP_PLACEHOLDER).then((el) => el.closest('.ant-select') as HTMLElement);
    fireEvent.mouseDown(select);

    const guide = await screen.findByTestId('app-select-empty-guide');
    expect(guide.textContent).toContain('暂无应用。先到「应用管理」创建或上传应用');
    const link = guide.querySelector('a');
    expect(link?.getAttribute('href')).toBe('/applications');
    expect(link?.textContent).toBe('前往应用管理');
  }, 20_000);

  it('列表加载中：下拉空态给 Spin（不显示无应用引导误导读）', async () => {
    let resolveList: ((apps: unknown) => void) | undefined;
    vi.mocked(applicationsApi.list).mockImplementation(
      () => new Promise((resolve) => { resolveList = resolve; }) as never,
    );
    renderPage();

    fireEvent.click(screen.getByTestId('code-source-application_zip'));
    const select = await screen.findByText(ZIP_PLACEHOLDER).then((el) => el.closest('.ant-select') as HTMLElement);
    fireEvent.mouseDown(select);

    await waitFor(() => {
      expect(document.querySelector('.ant-select-dropdown .ant-spin')).toBeTruthy();
    });
    expect(screen.queryByTestId('app-select-empty-guide')).toBeNull();

    resolveList?.([]);
    await waitFor(() => {
      expect(screen.getByTestId('app-select-empty-guide')).toBeTruthy();
    });
  }, 20_000);
});
