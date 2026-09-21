/**
 * P0（UX-AUDIT-2026-09-21 §P0-5）页面级：切换代码来源必须弹确认，且取消=不切换。
 *
 * 纯函数侧的"损失预告"由 code-source-switch-losses.test.ts 覆盖；本文件钉住
 * **页面确实调用了它**——纯函数再正确，没接上就等于没有防线（这正是本轮审计
 * 反复出现的形态：能力写好了，接线漏了）。
 *
 * 断言三件事：
 *  ① 有值的来源切换 → 弹确认（Modal.confirm 被调用）；
 *  ② 确认后才真正切换（onOk 之前 codeSource 不变）→ 用"切到 glue 后 git 输入框
 *     仍可见"来反证；
 *  ③ 无值切换（全空）→ 不弹窗、直接切（不打扰）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useAuthStore } from '../store/auth';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const { mockConfirm } = vi.hoisted(() => ({ mockConfirm: vi.fn() }));

vi.mock('antd', async (importOriginal) => {
  const actual = await importOriginal<typeof import('antd')>();
  return {
    ...actual,
    Modal: Object.assign(actual.Modal, { confirm: mockConfirm }),
    message: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
  };
});

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

function gitTask() {
  return {
    id: 'task-1',
    name: 'git-job',
    runtime: 'python',
    entrypoint: 'main.py',
    triggerType: 'manual',
    executeMode: 'single',
    timeoutSeconds: 300,
    maxRetry: 3,
    params: {},
    codeSource: 'git',
    gitRepo: 'git@github.com:acme/refund.git',
    gitBranch: 'release/2.x',
  };
}

beforeEach(() => {
  useAuthStore.setState({ user: { id: 1, username: 'root', role: 'admin' } });
  mockRouteParams = { id: 'task-1' };
  mockConfirm.mockClear();
  vi.mocked(executorsApi.list).mockReset().mockResolvedValue([] as never);
  vi.mocked(executorsApi.getGroups).mockReset().mockResolvedValue([] as never);
  vi.mocked(executorsApi.getTags).mockReset().mockResolvedValue([] as never);
  vi.mocked(applicationsApi.list).mockReset().mockResolvedValue([] as never);
  const listAll = (tasksApi as unknown as { listAll?: ReturnType<typeof vi.fn> }).listAll;
  listAll?.mockReset().mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 100 } as never);
  vi.mocked(tasksApi.get).mockReset().mockResolvedValue(gitTask() as never);
});

afterEach(() => cleanup());

describe('P0-5 页面级：切换代码来源需确认', () => {
  it('git → glue 且 gitRepo 有值 → 弹确认（不静默清空）', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByTestId('code-source-glue')).toBeTruthy());

    fireEvent.click(screen.getByTestId('code-source-glue'));

    await waitFor(() => expect(mockConfirm).toHaveBeenCalledTimes(1));
    // 确认框必须点名将被清空的字段（用户才能判断这是不是他要的配置）
    const arg = mockConfirm.mock.calls[0][0] as { title: string; okText: string };
    expect(arg.title).toMatch(/清空/);
    expect(arg.okText).toMatch(/切换/);
  });

  it('确认前不切换：git 输入框仍在（避免"框先消失、值随后丢"）', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByTestId('code-source-glue')).toBeTruthy());

    fireEvent.click(screen.getByTestId('code-source-glue'));
    await waitFor(() => expect(mockConfirm).toHaveBeenCalled());

    // 尚未点"确认切换"——git 仓库地址字段应仍挂载
    expect(screen.getByDisplayValue('git@github.com:acme/refund.git')).toBeTruthy();
  });

  it('onOk 被调用后才真正切换（git 字段卸载）', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByTestId('code-source-glue')).toBeTruthy());

    fireEvent.click(screen.getByTestId('code-source-glue'));
    await waitFor(() => expect(mockConfirm).toHaveBeenCalled());

    const arg = mockConfirm.mock.calls[0][0] as { onOk: () => void };
    arg.onOk();

    await waitFor(() =>
      expect(screen.queryByDisplayValue('git@github.com:acme/refund.git')).toBeNull(),
    );
  });
});
