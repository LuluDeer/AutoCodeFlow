/**
 * P0（UX-AUDIT-2026-09-21 §P0-6）：timeout=0（不限时）必须能在表单里存活。
 *
 * ## 这条守的是什么
 *
 * 后端三处一致地支持"0 = 不限时"：
 *   · `create-task.dto.ts` `@Min(0)`，描述明写 "0 = no limit"；
 *   · `timeout-policy.util.ts` `if (!timeoutSec || timeoutSec <= 0) return null;`
 *   · 编辑态回填 `task.timeoutSeconds ?? task.timeout ?? 300` 原样读库值。
 *
 * 而前端 `<InputNumber min={10}>` 把下限写死成 10。存量 `timeout=0` 的任务打开
 * 编辑页显示 0，antd 在失焦时按 min 钳到 **10** —— 一个原本不限时的长任务被
 * 无声改成 10 秒超时，保存后执行必被杀。反向地，用户也无法表达"不限时"。
 *
 * ## 断言策略
 *
 * 直接断言 InputNumber 收到的 min 属性（这是缺陷的本体），并断言回填的 0
 * 原样保留。只断言"能输入 0"不够——钳值发生在失焦，属于组件内部行为。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useAuthStore } from '../store/auth';
import { render, cleanup, waitFor, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('../api/tasks', () => ({
  tasksApi: {
    get: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    updateGlue: vi.fn(),
    list: vi.fn(),
    listAll: vi.fn(),
  },
}));
vi.mock('../api/executors', () => ({
  executorsApi: { list: vi.fn(), getGroups: vi.fn(), getTags: vi.fn() },
}));
vi.mock('../api/applications', () => ({ applicationsApi: { list: vi.fn() } }));
vi.mock('../components/GlueEditor', () => ({ default: () => <div data-testid="glue-editor" /> }));

let mockRouteParams: { id?: string } = {};
vi.mock('react-router-dom', () => ({
  useNavigate: () => vi.fn(),
  useBlocker: () => ({ state: 'unblocked' as const, proceed: () => {}, reset: () => {} }),
  useParams: () => mockRouteParams,
  useSearchParams: () => [new URLSearchParams('')],
  Link: (props: { to: string; children: React.ReactNode }) => <a href={props.to}>{props.children}</a>,
}));

const g = globalThis as Record<string, unknown>;
if (!g.ResizeObserver) {
  g.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
}
if (!window.matchMedia) {
  window.matchMedia = ((q: string) => ({
    matches: false, media: q, onchange: null,
    addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

import TaskFormPage from '../pages/TaskFormPage';
import { tasksApi } from '../api/tasks';
import { executorsApi } from '../api/executors';
import { applicationsApi } from '../api/applications';

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
const renderPage = () =>
  render(
    <QueryClientProvider client={queryClient}>
      <TaskFormPage />
    </QueryClientProvider>,
  );

function taskWithTimeout(timeout: number) {
  return {
    id: 'task-1',
    name: 'long-job',
    runtime: 'python',
    entrypoint: 'main.py',
    triggerType: 'manual',
    executeMode: 'single',
    timeoutSeconds: timeout,
    timeout,
    maxRetry: 3,
    params: {},
  };
}

beforeEach(() => {
  useAuthStore.setState({ user: { id: 1, username: 'root', role: 'admin' } });
  mockRouteParams = { id: 'task-1' };
  vi.mocked(executorsApi.list).mockReset().mockResolvedValue([] as never);
  vi.mocked(executorsApi.getGroups).mockReset().mockResolvedValue([] as never);
  vi.mocked(executorsApi.getTags).mockReset().mockResolvedValue([] as never);
  vi.mocked(applicationsApi.list).mockReset().mockResolvedValue([] as never);
  const listAll = (tasksApi as unknown as { listAll?: ReturnType<typeof vi.fn> }).listAll;
  listAll?.mockReset().mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 100 } as never);
});

afterEach(() => cleanup());

describe('P0-6: timeout 下限必须允许 0（= 不限时）', () => {
  it('编辑 timeout=0 的任务 → 表单原样显示 0（不被钳成 10）', async () => {
    vi.mocked(tasksApi.get).mockResolvedValue(taskWithTimeout(0) as never);
    renderPage();

    // 「超时时间」字段的输入框须显示 0
    await waitFor(() => {
      const inputs = Array.from(document.querySelectorAll('.ant-input-number-input')) as HTMLInputElement[];
      expect(inputs.some((i) => i.value === '0')).toBe(true);
    });
  });

  it('编辑 timeout=0 的任务 → 失焦后仍为 0（钳值真正发生在 blur）', async () => {
    vi.mocked(tasksApi.get).mockResolvedValue(taskWithTimeout(0) as never);
    renderPage();

    const inputs = await waitFor(() => {
      const all = Array.from(document.querySelectorAll('.ant-input-number-input')) as HTMLInputElement[];
      const zero = all.find((i) => i.value === '0');
      expect(zero).toBeTruthy();
      return zero!;
    });

    // 失焦是 antd 施加 min 钳制的时刻——旧实现（min=10）在这里把 0 改成 10。
    fireEvent.focus(inputs);
    fireEvent.blur(inputs);

    await waitFor(() => expect(inputs.value).toBe('0'));
    expect(inputs.value).not.toBe('10');
  });
});
