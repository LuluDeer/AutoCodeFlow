/**
 * REFACTOR-TASKFORM 回归（commit 7d66a9b0 记录的既有 bug 之 1/2）：
 *
 * P1 语言切换重灌编辑态——useTranslation 的 t 在 changeLanguage 后引用变化，
 * 曾令把 t 列入依赖的数据 effect 整组重跑：
 *   - 编辑回填 / 模板预填 effect：整表重回填 + setDirty(false)，冲掉用户未保存
 *     的修改（任务/模板还被重复拉取）；
 *   - 参照数据 effect：重拉本身可接受（选项文案重译），但其中的
 *     `?applicationId=` 回填会把用户已改的应用绑定静默冲回 URL 参数值。
 *
 * 本文件钉死三条防线（修前跑红、修后转绿）：
 *   1) 编辑态切语言：脏值保留 / 任务不重拉 / dirty 守卫（beforeunload 监听）不解除；
 *   2) 创建态 ?applicationId=：挂载预填生效；用户改绑后切语言不被 URL 参数冲回；
 *   3) 创建态 ?templateId=：预填后用户改动保留 / 模板不重拉 / dirty 不解除；
 *   4) 执行器分区 allTags.map(t=>) 改名 tag（t 遮蔽）后，分组模式标签下拉
 *      选项渲染零行为变化。
 *
 * mock 脚手架与 task-form-page.test.tsx 同款（api 层隔离 + GlueEditor 裁剪 +
 * react-router-dom 覆写；useSearchParams 用缓存对象避免引用不稳定误触 effect）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from '@testing-library/react';
import { useAuthStore } from '../store/auth';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import TaskFormPage from '../pages/TaskFormPage';
import { tasksApi } from '../api/tasks';
import { executorsApi } from '../api/executors';
import { applicationsApi } from '../api/applications';
import { projectsApi } from '../api/projects';
import { taskTemplatesApi } from '../api/task-templates';
import type { TaskTemplate } from '../api/task-templates';
import i18n from '../i18n';

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
vi.mock('../api/task-templates', () => ({ taskTemplatesApi: { get: vi.fn(), list: vi.fn() } }));
// F-01 配套：GlueEditor 重依赖（monaco）裁剪（策略同 task-form-page.test 先例）。
vi.mock('../components/GlueEditor', () => ({ default: () => <div data-testid="glue-editor" /> }));

// 路由参数可切换：编辑态默认 id='task-1'；创建态用例置 {}。
// useSearchParams 返回值按 mockSearch 内容缓存（真路由在 setSearchParams 后
// 返回稳定引用；不变则稳定），避免每次渲染新对象误触 effect 依赖。
let mockRouteParams: { id?: string } = { id: 'task-1' };
let mockSearch = '';
let mockSearchParamsCache: URLSearchParams | null = null;
let mockSearchParamsCacheKey = '';
vi.mock('react-router-dom', () => ({
  useNavigate: () => vi.fn(),
  useBlocker: () => ({ state: 'unblocked' as const, proceed: () => {}, reset: () => {} }),
  useParams: () => mockRouteParams,
  useSearchParams: () => {
    if (mockSearch !== mockSearchParamsCacheKey || !mockSearchParamsCache) {
      mockSearchParamsCacheKey = mockSearch;
      mockSearchParamsCache = new URLSearchParams(mockSearch);
    }
    return [mockSearchParamsCache, vi.fn()];
  },
  // UI-03：TaskFormPage 页头 PageHeader 面包屑消费 Link——mock 补齐导出（纯锚点桩）
  Link: (props: { to: string; children: React.ReactNode }) => <a href={props.to}>{props.children}</a>,
}));

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

const TPL_UUID = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';

function makeTemplate(): TaskTemplate {
  return {
    id: TPL_UUID,
    key: 'scheduled_backup',
    name: '定时备份',
    description: '周期性备份任务：Cron 定时触发。',
    category: '备份',
    config: {
      triggerType: 'cron',
      cronExpression: '0 2 * * *',
      timezone: 'Asia/Shanghai',
      runtime: 'shell',
      entrypoint: 'backup.sh',
      timeoutSeconds: 3600,
      maxRetry: 3,
      retryDelay: 60,
      blockStrategy: 'discard',
    },
    isOfficial: true,
    createdAt: '2026-09-07T00:00:00.000Z',
    updatedAt: '2026-09-07T00:00:00.000Z',
  };
}

function makeApp(id: string, name: string) {
  return { id, name, runtime: 'python', version: '1.0.0', description: '', status: 'active', updatedAt: '' };
}

const testQueryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
const renderPage = () =>
  render(
    <QueryClientProvider client={testQueryClient}>
      <TaskFormPage />
    </QueryClientProvider>,
  );

/** 语言切换（真实 i18n 通道，t 引用随之变化——正是被修 bug 的触发机制） */
const switchLanguage = (lng: 'zh' | 'en') =>
  act(async () => {
    await i18n.changeLanguage(lng);
  });

function fieldSelect(label: string): HTMLElement {
  const labelNode = screen.getByText(label, { selector: '.ant-form-item-label label' });
  const item = labelNode.closest('.ant-form-item');
  const selector = item?.querySelector('.ant-select') as HTMLElement | null;
  expect(selector).toBeTruthy();
  return selector!;
}

beforeEach(() => {
  useAuthStore.setState({ user: { id: 1, username: 'root', role: 'admin' } });
  mockRouteParams = { id: 'task-1' };
  mockSearch = '';
  mockSearchParamsCache = null;
  mockSearchParamsCacheKey = '';
  vi.mocked(executorsApi.list).mockReset().mockResolvedValue([] as never);
  vi.mocked(executorsApi.getGroups).mockReset().mockResolvedValue([] as never);
  vi.mocked(executorsApi.getTags).mockReset().mockResolvedValue([] as never);
  vi.mocked(applicationsApi.list).mockReset().mockResolvedValue([] as never);
  vi.mocked(projectsApi.list).mockReset().mockResolvedValue([] as never);
  vi.mocked(tasksApi.listAll).mockReset().mockResolvedValue({
    items: [], total: 0, page: 1, pageSize: 100,
  } as never);
  vi.mocked(taskTemplatesApi.get).mockReset().mockResolvedValue(makeTemplate() as never);
});

afterEach(async () => {
  cleanup();
  vi.restoreAllMocks();
  await i18n.changeLanguage('zh');
});

describe('P1 编辑态：切语言不得重灌编辑态（脏值保留 / 不重拉 / dirty 不解除）', () => {
  it('用户改动在 changeLanguage 后保留，任务只拉一次，beforeunload 守卫不卸载', async () => {
    vi.mocked(tasksApi.get).mockReset().mockResolvedValue({
      id: 'task-1',
      name: 'pinned-job',
      runtime: 'python',
      entrypoint: 'main.py',
      triggerType: 'manual',
      executeMode: 'single',
      timeoutSeconds: 300,
      maxRetry: 3,
      params: {},
    } as never);

    renderPage();
    // 回填完成基线：服务端值可见
    expect(await screen.findByDisplayValue('pinned-job')).toBeTruthy();

    const addSpy = vi.spyOn(window, 'addEventListener');
    const removeSpy = vi.spyOn(window, 'removeEventListener');
    // 用户手改名称（P1-4 语义：onValuesChange → setDirty(true) → 挂 beforeunload）
    fireEvent.change(screen.getByPlaceholderText('daily-report'), { target: { value: 'user-edited' } });
    expect(screen.getByDisplayValue('user-edited')).toBeTruthy();
    expect(addSpy).toHaveBeenCalledWith('beforeunload', expect.any(Function));

    await switchLanguage('en');

    // 断言面 1：脏值保留——服务端值不得回灌覆盖用户修改
    expect(screen.getByDisplayValue('user-edited')).toBeTruthy();
    // 断言面 2：编辑回填 effect 不重跑——任务数据只拉取一次
    expect(tasksApi.get).toHaveBeenCalledTimes(1);
    // 断言面 3：dirty 未被重置——setDirty(false) 会卸载 beforeunload 监听，
    // 监听仍在 = 未保存守卫仍生效
    expect(removeSpy).not.toHaveBeenCalledWith('beforeunload', expect.any(Function));
  }, 30_000);
});

describe('P1 创建态 ?applicationId=：预填只在挂载时生效，已改绑定不被冲回', () => {
  it('挂载预填 zip 应用；用户改绑其他应用后切语言，选择器保持用户选择', async () => {
    mockRouteParams = {};
    mockSearch = 'applicationId=app-9';
    vi.mocked(applicationsApi.list).mockReset().mockResolvedValue([
      makeApp('app-9', 'Zip App'),
      makeApp('app-2', 'Zip Two'),
    ] as never);

    renderPage();

    // 挂载即预填：创建态同时把来源切到 application_zip，选择器回显 URL 指定应用
    // （antd 选中回显带 title=应用名；aria-live 播报区无 title，不干扰定位）
    const zipSelect = await screen
      .findByTitle('Zip App')
      .then((el) => el.closest('.ant-select') as HTMLElement);

    // 用户改绑为另一个应用（选择动作经 onValuesChange 置脏）
    fireEvent.mouseDown(zipSelect);
    fireEvent.click((await screen.findByTitle('Zip Two')).closest('.ant-select-item') as HTMLElement);

    await switchLanguage('en');

    // 用户绑定保留（title 限定在选择器容器内，排除隐藏下拉浮层里的选项行）——
    // 修前：参照 effect 随语言切换重跑 setFieldValue('applicationId','app-9')，
    // 选择器会被冲回 Zip App。
    await waitFor(() => expect(zipSelect.querySelector('[title="Zip Two"]')).toBeTruthy());
    expect(zipSelect.querySelector('[title="Zip App"]')).toBeNull();
  }, 30_000);
});

describe('P1 创建态 ?templateId=：模板预填同样不得随语言切换重灌', () => {
  it('用户改动保留、模板只拉一次、dirty 不解除', async () => {
    mockRouteParams = {};
    mockSearch = `templateId=${TPL_UUID}`;
    renderPage();

    // 模板预填完成基线
    const entrypoint = await screen.findByDisplayValue('backup.sh');

    const addSpy = vi.spyOn(window, 'addEventListener');
    const removeSpy = vi.spyOn(window, 'removeEventListener');
    fireEvent.change(entrypoint, { target: { value: 'custom.sh' } });
    expect(screen.getByDisplayValue('custom.sh')).toBeTruthy();
    expect(addSpy).toHaveBeenCalledWith('beforeunload', expect.any(Function));

    await switchLanguage('en');

    // 用户对预填字段的修改保留（模板值不得回灌）
    expect(screen.getByDisplayValue('custom.sh')).toBeTruthy();
    // 模板不重拉
    expect(taskTemplatesApi.get).toHaveBeenCalledTimes(1);
    // dirty 未被重置
    expect(removeSpy).not.toHaveBeenCalledWith('beforeunload', expect.any(Function));
  }, 30_000);
});

describe('P2 执行器分区 allTags.map(t=>) 改名 tag：选项渲染零行为变化', () => {
  it('分组模式下「执行器标签」下拉渲染全部候选标签', async () => {
    mockRouteParams = {};
    vi.mocked(executorsApi.getTags).mockReset().mockResolvedValue(['gpu', 'edge', 'windows', 'arm'] as never);
    vi.mocked(executorsApi.getGroups).mockReset().mockResolvedValue(['g1'] as never);

    renderPage();

    // 切到「按分组/标签」模式，组内标签筛选下拉出现
    fireEvent.click(screen.getByText('按分组/标签'));
    const tagsSelect = fieldSelect('执行器标签');
    fireEvent.mouseDown(tagsSelect);

    await waitFor(() => expect(screen.getAllByText('gpu').length).toBeGreaterThan(0));
    for (const tag of ['gpu', 'edge', 'windows', 'arm']) {
      expect(screen.getAllByText(tag).length).toBeGreaterThan(0);
    }
  }, 30_000);
});
