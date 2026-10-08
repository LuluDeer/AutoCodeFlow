/**
 * 生产反馈回归：任务名可改 + 支持中文；搜索框按描述可搜。
 *
 * ## 背景（两条真实的生产疑问）
 *
 * 1. 「创建任务时任务名称只能英文，而且一旦创建就无法被修改调整」——
 *    根因是**纯前端**的两处限制：`TaskFormBasicSection` 里一条
 *    `/^[a-zA-Z0-9_-]+$/` 白名单，以及 `disabled={isEdit}`。后端
 *    （CreateTaskDto / UpdateTaskDto / TaskService）**从未**要求 ASCII，
 *    也一直支持改名（update 走 Object.assign 落库）。
 *
 * 2. 「搜索栏明明写着『搜索任务名、描述』，输入描述里的关键字却搜不出来」——
 *    根因是搜索框把关键字发给了 `name` 参数，而后端只过滤 name 列；
 *    描述压根不参与匹配，且因为不报错用户完全无从察觉。
 *
 * 本文件钉住修复后的前端契约（后端侧契约见 admin-api 的
 * task-name.constraint.spec.ts 与 task.service.spec.ts 的 FEAT-TASK-SEARCH /
 * FEAT-RENAME 用例）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useAuthStore } from '../store/auth';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import TaskFormPage from '../pages/TaskFormPage';
import TaskListPage from '../pages/TaskListPage';
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
vi.mock('../components/GlueEditor', () => ({ default: () => <div data-testid="glue-editor" /> }));
// 任务列表页还消费这些面，裁剪掉避免真实请求。
// useTasksList 必须返回**完整的 react-query 结果形状**——组件直接解构
// `{ data, isLoading, error, refetch }`，返回 undefined 会在渲染期抛错。
vi.mock('../api/queries', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/queries')>();
  return {
    ...actual,
    useTasksList: vi.fn(() => ({
      data: { items: [], total: 0, page: 1, pageSize: 20 },
      isLoading: false,
      error: null,
      refetch: vi.fn(),
    })),
  };
});

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
  Link: (props: { to: string; children: React.ReactNode }) => <a href={props.to}>{props.children}</a>,
}));

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
    matches: /prefers-reduced-motion: reduce/.test(q),
    media: q,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

const testQueryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

const baseTask = {
  id: 'task-1',
  name: '每日备份',
  description: '把生产库导出到对象存储',
  runtime: 'python',
  entrypoint: 'main.py',
  triggerType: 'manual',
  status: 'active',
};

beforeEach(() => {
  useAuthStore.setState({ user: { id: 1, username: 'root', role: 'admin' } });
  mockRouteParams = { id: 'task-1' };
  mockSearch = '';
  mockSearchParamsCache = null;
  mockSearchParamsCacheKey = '';
  vi.mocked(tasksApi.get).mockReset().mockResolvedValue({ ...baseTask } as never);
  vi.mocked(tasksApi.update).mockReset().mockResolvedValue({ ...baseTask } as never);
  vi.mocked(tasksApi.list).mockReset().mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 20 } as never);
  vi.mocked(executorsApi.list).mockReset().mockResolvedValue([] as never);
  vi.mocked(executorsApi.getGroups).mockReset().mockResolvedValue([] as never);
  vi.mocked(executorsApi.getTags).mockReset().mockResolvedValue([] as never);
  vi.mocked(applicationsApi.list).mockReset().mockResolvedValue([] as never);
  vi.mocked(projectsApi.list).mockReset().mockResolvedValue([] as never);
});

afterEach(() => {
  cleanup();
});

const renderForm = () =>
  render(
    <QueryClientProvider client={testQueryClient}>
      <TaskFormPage />
    </QueryClientProvider>,
  );

describe('FEAT-RENAME 前端：任务名可编辑 + 支持中文', () => {
  it('编辑态名称输入框**不再禁用**（此前 disabled={isEdit} 把改名彻底锁死）', async () => {
    renderForm();
    const input = await screen.findByDisplayValue('每日备份');
    expect((input as HTMLInputElement).disabled).toBe(false);
  });

  it('编辑态改名后提交，PATCH payload 携带新名（后端本就支持）', async () => {
    renderForm();
    const input = await screen.findByDisplayValue('每日备份');
    fireEvent.change(input, { target: { value: '每日备份（生产）' } });
    fireEvent.click(screen.getByRole('button', { name: /保存修改|保存/ }));

    await waitFor(() => expect(tasksApi.update).toHaveBeenCalledTimes(1));
    const payload = vi.mocked(tasksApi.update).mock.calls[0][1] as unknown as Record<string, unknown>;
    expect(payload.name).toBe('每日备份（生产）');
  });

  it('中文名通过校验（不再被 ASCII 白名单拦死）', async () => {
    renderForm();
    const input = await screen.findByDisplayValue('每日备份');
    fireEvent.change(input, { target: { value: '中文任务名' } });
    // 校验通过 = 提交真的发生（若被 pattern 拦截，update 永不调用）
    fireEvent.click(screen.getByRole('button', { name: /保存修改|保存/ }));
    await waitFor(() => expect(tasksApi.update).toHaveBeenCalledTimes(1));
    const payload = vi.mocked(tasksApi.update).mock.calls[0][1] as unknown as Record<string, unknown>;
    expect(payload.name).toBe('中文任务名');
  });

  it('首尾空格被拦下（与后端同一判据：不静默 trim，避免"输入名≠存储名"）', async () => {
    renderForm();
    const input = await screen.findByDisplayValue('每日备份');
    fireEvent.change(input, { target: { value: ' 备份' } });
    fireEvent.click(screen.getByRole('button', { name: /保存修改|保存/ }));

    await screen.findByText(/不能以空格开头或结尾/);
    expect(tasksApi.update).not.toHaveBeenCalled();
  });

  it('控制字符（零宽字符 U+200B）被拦下——不可见，会造出"看起来同名"的两个任务', async () => {
    // 刻意不用 `\n`：单行 <input> 按 HTML 规范会**剥掉**换行，浏览器里根本
    // 输不进去（该形态由后端约束器兜底，见 admin-api 的 task-name.constraint
    // spec）。前端这条守卫真正要拦的是 U+200B 这类**能输进去且看不见**的
    // Cf 字符——两个任务名在界面上逐像素相同，重名排查时无从下手。
    renderForm();
    const input = await screen.findByDisplayValue('每日备份');
    fireEvent.change(input, { target: { value: '备份\u200b' } });
    fireEvent.click(screen.getByRole('button', { name: /保存修改|保存/ }));

    await screen.findByText(/控制字符/);
    expect(tasksApi.update).not.toHaveBeenCalled();
  });

  it('编辑态 tooltip 说明"可修改"（不再声称创建后不可更改）', async () => {
    renderForm();
    const input = await screen.findByDisplayValue('每日备份');
    // tooltip 由 Form.Item 的 icon 承载；断言文案已换掉旧承诺
    const formItem = input.closest('.ant-form-item');
    expect(formItem).toBeTruthy();
    expect(formItem!.textContent ?? '').not.toContain('创建后不可更改');
  });
});

describe('FEAT-TASK-SEARCH 前端：搜索框发 q（name OR description）', () => {
  const renderList = () =>
    render(
      <QueryClientProvider client={testQueryClient}>
        <TaskListPage />
      </QueryClientProvider>,
    );

  it('搜索框输入关键字后，请求带 q 而不是 name', async () => {
    const { useTasksList } = await import('../api/queries');
    renderList();

    const box = await screen.findByPlaceholderText('搜索任务名、描述');
    fireEvent.change(box, { target: { value: '对象存储' } });

    // 防抖 300ms
    await waitFor(
      () => {
        const calls = vi.mocked(useTasksList).mock.calls;
        const last = calls[calls.length - 1]?.[0] as Record<string, unknown> | undefined;
        expect(last?.q).toBe('对象存储');
        // 关键：不得再错发 name（那只搜任务名，描述恒不命中）
        expect(last?.name).toBeUndefined();
      },
      { timeout: 3000 },
    );
  });

  it('占位符文案与实现一致（承诺搜索描述，实现确实发 q）', async () => {
    const { useTasksList } = await import('../api/queries');
    renderList();
    const box = await screen.findByPlaceholderText('搜索任务名、描述');
    expect(box).toBeTruthy();

    fireEvent.change(box, { target: { value: '生产库' } });
    await waitFor(
      () => {
        const calls = vi.mocked(useTasksList).mock.calls;
        const last = calls[calls.length - 1]?.[0] as Record<string, unknown> | undefined;
        expect(last?.q).toBe('生产库');
      },
      { timeout: 3000 },
    );
  });
});
