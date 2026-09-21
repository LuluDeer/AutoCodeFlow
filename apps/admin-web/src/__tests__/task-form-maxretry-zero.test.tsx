/**
 * ENG 审计 E-P1-F1：maxRetry=0（不自动重试）必须能在表单里存活。
 *
 * ## 这条守的是什么
 *
 * 后端 `create-task.dto.ts` 对 maxRetry 是 `@Min(0) @Max(10)`，0 被明确定义为
 * 「不自动重试」（`task.service.ts` 用 `Math.max(1, task.maxRetry ?? 1)` 兜底 attempts，
 * 但 maxRetry=0 的语义由前端/用户显式表达）。而前端
 * `TaskFormPage.tsx` 的 `<InputNumber min={1} max={10}>` 把下限写死成 1。
 *
 * 旧实现会怎样错：存量 maxRetry=0 的任务打开编辑页，表单回填
 * `task.maxRetry ?? 3`（0 ?? 3 === 0，0 被保留），输入框显示 0；antd InputNumber
 * 在**失焦**时按 min 钳值——旧 min=1 把 0 静默改成 1，用户「不动直接保存」就把
 * 「不自动重试」改成了「重试一次」。与上轮 timeout P0-6 是同一类静默钳位。
 *
 * ## 断言策略
 *
 * 与 task-form-timeout-zero.test.tsx 同范式：定位「最大尝试次数」表单项内的
 * InputNumber，断言它初始显示 0、且 focus→blur 后仍为 0（旧 min=1 会在此处
 * 把它改成 1）。只断言「能输入 0」不够——钳值发生在失焦。
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

function taskWithMaxRetry(maxRetry: number) {
  return {
    id: 'task-1',
    name: 'retry-job',
    runtime: 'python',
    entrypoint: 'main.py',
    triggerType: 'manual',
    executeMode: 'single',
    timeoutSeconds: 300,
    timeout: 300,
    maxRetry,
    retryDelay: 0,
    params: {},
  };
}

/** 按「最大尝试次数」标签定位 maxRetry 表单项内的 InputNumber。 */
function findMaxRetryInput(): HTMLInputElement | null {
  const item = Array.from(document.querySelectorAll('.ant-form-item')).find((el) =>
    el.querySelector('.ant-form-item-label')?.textContent?.includes('最大尝试次数'),
  );
  return (item?.querySelector('.ant-input-number-input') as HTMLInputElement | null) ?? null;
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

describe('ENG 审计 E-P1-F1：maxRetry=0 必须能在编辑态存活', () => {
  it('编辑 maxRetry=0 的任务 → 表单原样显示 0', async () => {
    vi.mocked(tasksApi.get).mockResolvedValue(taskWithMaxRetry(0) as never);
    renderPage();

    await waitFor(() => {
      const input = findMaxRetryInput();
      expect(input).toBeTruthy();
      expect(input!.value).toBe('0');
    });
  });

  it('编辑 maxRetry=0 的任务 → 失焦后仍为 0（旧 min=1 会在此处钳成 1）', async () => {
    vi.mocked(tasksApi.get).mockResolvedValue(taskWithMaxRetry(0) as never);
    renderPage();

    const input = await waitFor(() => {
      const el = findMaxRetryInput();
      expect(el).toBeTruthy();
      return el!;
    });

    // 失焦是 antd 施加 min 钳制的时刻——旧实现（min=1）在这里把 0 改成 1。
    fireEvent.focus(input);
    fireEvent.blur(input);

    await waitFor(() => expect(input.value).toBe('0'));
    expect(input.value).not.toBe('1');
  });
});
