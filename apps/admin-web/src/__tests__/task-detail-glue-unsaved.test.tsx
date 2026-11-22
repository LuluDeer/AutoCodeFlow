/**
 * GLUE-DIRTY-NAV：Glue 脚本脏状态必须拦住站内导航（返回/面包屑/编辑/程序化导航同理）。
 *
 * 这里刻意用真实 data router（createMemoryRouter + RouterProvider），不使用
 * vi.mock('react-router-dom')：只有真 useBlocker 才能证明 Modal 的「留下/离开」
 * 分别走 reset/proceed，URL 在确认前保持不变。页面自身返回按钮文案不在断言面，
 * 导航由路由内 NavProbe 触发。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ConfigProvider } from 'antd';
import { createMemoryRouter, RouterProvider, useNavigate } from 'react-router-dom';
import TaskDetailPage from '../pages/TaskDetailPage';
import { useAuthStore } from '../store/auth';

const http = vi.hoisted(() => ({
  get: vi.fn<(url: string) => Promise<unknown>>(),
  post: vi.fn<(url: string, body: unknown) => Promise<unknown>>(),
}));
vi.mock('../api/client', () => ({ client: http }));

// lazy 的 GlueEditor 只暴露一个脏标记入口；不引入 monaco。
vi.mock('../components/GlueEditor', () => ({
  default: ({ onDirtyChange }: { onDirtyChange?: (dirty: boolean) => void }) => (
    <>
      <button type="button" data-testid="mark-glue-dirty" onClick={() => onDirtyChange?.(true)}>
        mark dirty
      </button>
      <button type="button" data-testid="clear-glue-dirty" onClick={() => onDirtyChange?.(false)}>
        clear dirty
      </button>
    </>
  ),
}));
vi.mock('../components/TaskDependencyGraph', () => ({ default: () => <div data-testid="dep-graph" /> }));
vi.mock('../components/ParamsEditor', () => ({ default: () => <div data-testid="params-editor" /> }));

const TASK_ID = 'glue-unsaved-1';
const TASK_PATH = `/tasks/${TASK_ID}`;
const TASK_NAME = 'glue-unsaved-job';
const DEST = '/tasks';
const UNSAVED_DIALOG = /Glue 脚本有未保存的修改/;

function NavProbe() {
  const nav = useNavigate();
  return <button type="button" data-testid="nav-probe" onClick={() => nav(DEST)}>navigate away</button>;
}

function renderPage() {
  const router = createMemoryRouter([
    { path: '/tasks/:id', element: <><TaskDetailPage /><NavProbe /></> },
    { path: DEST, element: <div data-testid="destination">destination</div> },
  ], { initialEntries: [TASK_PATH] });
  const query = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <ConfigProvider theme={{ token: { motion: false } }}>
      <QueryClientProvider client={query}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </ConfigProvider>,
  );
  return router;
}

function beforeUnloadEvent() {
  return new Event('beforeunload', { cancelable: true });
}

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  vi.spyOn(window, 'matchMedia').mockImplementation((media) => ({
    media, matches: false, onchange: null,
    addListener: vi.fn(), removeListener: vi.fn(), addEventListener: vi.fn(),
    removeEventListener: vi.fn(), dispatchEvent: () => false,
  }));
  useAuthStore.setState({ user: { id: 1, username: 'operator', role: 'admin' } });
  http.get.mockReset().mockImplementation(async (url) => {
    if (url === '/executors') return [];
    if (url.endsWith('/webhook')) return { enabled: false, url: '' };
    if (url.endsWith('/versions')) return [];
    if (url.endsWith('/stats')) return { totalRuns: 0 };
    if (url.endsWith('/executions')) return { items: [], total: 0 };
    return {
      id: TASK_ID, name: TASK_NAME, runtime: 'python', codeSource: 'glue',
      entrypoint: 'main.py', status: 'active', triggerType: 'manual', maxRetry: 0, timeout: 30,
      params: {},
    };
  });
  http.post.mockReset().mockResolvedValue({});
});

afterEach(() => {
  cleanup();
  useAuthStore.setState({ user: null });
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('GLUE-DIRTY-NAV：TaskDetailPage 的 Glue 未保存守卫', () => {
  it('站内导航被拦：留下保持原页，再导航离开才跳目标路由', async () => {
    const router = renderPage();
    await screen.findByRole('heading', { name: TASK_NAME });

    // 干净态：beforeunload 不拦，导航也不弹窗。
    const cleanEvent = beforeUnloadEvent();
    window.dispatchEvent(cleanEvent);
    expect(cleanEvent.defaultPrevented).toBe(false);
    await act(async () => { fireEvent.click(screen.getByTestId('nav-probe')); });
    expect(router.state.location.pathname).toBe(DEST);
    expect(screen.queryByRole('dialog', { name: UNSAVED_DIALOG })).toBeNull();

    // 回到详情页，切 Glue Tab 并置 dirty。
    await act(async () => { await router.navigate(TASK_PATH); });
    await screen.findByRole('heading', { name: TASK_NAME });
    await act(async () => { fireEvent.click(screen.getByRole('tab', { name: /Glue 脚本/ })); });
    await act(async () => { fireEvent.click(await screen.findByTestId('mark-glue-dirty')); });

    const dirtyEvent = beforeUnloadEvent();
    window.dispatchEvent(dirtyEvent);
    expect(dirtyEvent.defaultPrevented).toBe(true);

    // 站内导航：URL 不动，确认 Modal 出现。
    await act(async () => { fireEvent.click(screen.getByTestId('nav-probe')); });
    expect(router.state.location.pathname).toBe(TASK_PATH);
    const dialog = await screen.findByRole('dialog', { name: UNSAVED_DIALOG });
    expect(within(dialog).getByText(/离开此页面将丢失这些更改/)).toBeTruthy();

    // 留下：Modal 关闭，仍在详情页。
    await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: /留\s*下/ })); });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: UNSAVED_DIALOG })).toBeNull());
    expect(router.state.location.pathname).toBe(TASK_PATH);

    // 再导航并确认离开：proceed 后才到 B。
    await act(async () => { fireEvent.click(screen.getByTestId('nav-probe')); });
    const again = await screen.findByRole('dialog', { name: UNSAVED_DIALOG });
    await act(async () => { fireEvent.click(within(again).getByRole('button', { name: /离\s*开/ })); });
    await waitFor(() => expect(router.state.location.pathname).toBe(DEST));
    expect(await screen.findByTestId('destination')).toBeTruthy();
    expect(screen.queryByRole('dialog', { name: UNSAVED_DIALOG })).toBeNull();
  });

  it('脚本保存后 dirty 归零：beforeunload 与站内拦截同时解除', async () => {
    const router = renderPage();
    await screen.findByRole('heading', { name: TASK_NAME });
    await act(async () => { fireEvent.click(screen.getByRole('tab', { name: /Glue 脚本/ })); });
    await act(async () => { fireEvent.click(await screen.findByTestId('mark-glue-dirty')); });

    const dirtyEvent = beforeUnloadEvent();
    window.dispatchEvent(dirtyEvent);
    expect(dirtyEvent.defaultPrevented).toBe(true);

    await act(async () => { fireEvent.click(screen.getByTestId('clear-glue-dirty')); });
    const cleanEvent = beforeUnloadEvent();
    window.dispatchEvent(cleanEvent);
    expect(cleanEvent.defaultPrevented).toBe(false);

    await act(async () => { fireEvent.click(screen.getByTestId('nav-probe')); });
    expect(router.state.location.pathname).toBe(DEST);
    expect(screen.queryByRole('dialog', { name: UNSAVED_DIALOG })).toBeNull();
  });
});
