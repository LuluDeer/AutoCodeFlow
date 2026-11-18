import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ConfigProvider } from 'antd';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import type { agentApi } from '../api/agent';
import TaskDetailPage from '../pages/TaskDetailPage';
import { useAuthStore } from '../store/auth';

// Exercise the real task page, agentApi.create and router; replace only the HTTP boundary.
const http = vi.hoisted(() => ({
  get: vi.fn<(url: string) => Promise<unknown>>(),
  post: vi.fn<(url: string, body: Parameters<typeof agentApi.create>[0]) => ReturnType<typeof agentApi.create>>(),
}));
vi.mock('../api/client', () => ({ client: http }));

const TASK_ID = '94c2eb22-fae1-4010-a0a5-50860de26279';
const TASK_PATH = `/tasks/${TASK_ID}`;
const TASK_NAME = `晚间归档${'任务'.repeat(150)}`;
const CREATED = { id: 'session-718', status: 'pending' };
const ENTRY = /请 Agent 诊断此任务/;
const CONFIRM = /开始只读诊断/;

function setRole(role: string) {
  useAuthStore.setState({ user: { id: 1, username: 'operator', role } });
}

function renderPage(mobile = false) {
  vi.spyOn(window, 'matchMedia').mockImplementation((media) => ({
    media, matches: mobile && media === '(max-width: 768px)', onchange: null,
    addListener: vi.fn(), removeListener: vi.fn(), addEventListener: vi.fn(),
    removeEventListener: vi.fn(), dispatchEvent: () => false,
  }));
  const router = createMemoryRouter([
    { path: '/tasks/:id', element: <TaskDetailPage /> },
    { path: '/agent-sessions', element: <div /> },
  ], { initialEntries: [TASK_PATH] });
  const query = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<ConfigProvider theme={{ token: { motion: false } }}>
    <QueryClientProvider client={query}><RouterProvider router={router} /></QueryClientProvider>
  </ConfigProvider>);
  return router;
}

async function openDialog() {
  const buttons = await screen.findAllByRole('button', { name: ENTRY });
  expect(buttons).toHaveLength(1);
  fireEvent.click(buttons[0]);
  const dialog = within(await screen.findByRole('dialog', { name: ENTRY }));
  expect(dialog.getAllByRole('textbox')).toHaveLength(1);
  return {
    dialog,
    field: dialog.getByRole<HTMLTextAreaElement>('textbox', { name: '诊断问题' }),
    confirm: dialog.getByRole<HTMLButtonElement>('button', { name: CONFIRM }),
  };
}

function holdCreation() {
  let resolve!: (result: typeof CREATED) => void;
  http.post.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
  return () => resolve(CREATED);
}

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  setRole('admin');
  http.get.mockReset().mockImplementation(async (url) => {
    if (url === '/executors') return [];
    if (url.endsWith('/webhook')) return { enabled: false, url: '' };
    if (url.endsWith('/stats')) return { totalRuns: 0 };
    if (url.endsWith('/executions')) return { items: [], total: 0 };
    const id = url.split('/')[2];
    return {
      id, name: id === TASK_ID ? TASK_NAME : '另一项任务', runtime: 'node',
      entrypoint: 'main.js', status: 'active', triggerType: 'manual', maxRetry: 0, timeout: 30,
      params: { privateInput: 'do-not-forward' }, secrets: { credential: 'do-not-forward' },
    };
  });
  http.post.mockReset().mockResolvedValue(CREATED);
});

afterEach(() => {
  cleanup();
  useAuthStore.setState({ user: null });
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('任务详情 → Agent 只读诊断', () => {
  it.each([{ view: '桌面', mobile: false }, { view: '移动端', mobile: true }])(
    '$view：确认前不创建；连击只发一次固定 scope 的请求，按返回 ID 打开专属会话',
    async ({ mobile }) => {
      const finish = holdCreation();
      const router = renderPage(mobile);
      const { dialog, field, confirm } = await openDialog();
      expect(dialog.getByText(/这项任务做只读诊断/)).toBeTruthy();
      expect(dialog.getByText(`任务 ID：${TASK_ID}`)).toBeTruthy();
      expect(field.value).toContain('执行记录');
      const question = mobile ? field.value : '昨晚的执行为什么超时？';
      if (!mobile) fireEvent.change(field, { target: { value: `  ${question}  ` } });
      expect(http.post).not.toHaveBeenCalled();
      await act(async () => { fireEvent.click(confirm); fireEvent.click(confirm); });
      expect(http.post).toHaveBeenCalledTimes(1);
      expect(http.post).toHaveBeenCalledWith('/agent/sessions', {
        kind: 'ops_watch', title: expect.stringContaining('晚间归档'),
        context: { taskId: TASK_ID, question: `任务 ID：${TASK_ID}\n${question}` },
        scope: { tasks: [TASK_ID] },
      });
      expect(http.post.mock.calls[0][1].title!.length).toBeLessThanOrEqual(255);
      expect(confirm.disabled && field.disabled).toBe(true);
      expect(router.state.location.pathname).toBe(TASK_PATH);
      await act(async () => finish());
      expect(router.state.location.pathname + router.state.location.search)
        .toBe(`/agent-sessions?session=${CREATED.id}`);
    },
  );

  it('空白问题不能提交，取消不会创建会话', async () => {
    renderPage();
    const { dialog, field, confirm } = await openDialog();
    fireEvent.change(field, { target: { value: '  \n ' } });
    expect(confirm.disabled).toBe(true);
    fireEvent.click(confirm);
    fireEvent.click(dialog.getByRole('button', { name: /取\s*消/ }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: ENTRY })).toBeNull());
    expect(http.post).not.toHaveBeenCalled();
  });

  it('创建失败时保留当前任务与问题，允许原样重试', async () => {
    http.post.mockRejectedValueOnce(new Error('network unavailable'));
    const router = renderPage();
    const { dialog, field, confirm } = await openDialog();
    fireEvent.change(field, { target: { value: '排查昨天的失败记录' } });
    fireEvent.click(confirm);
    expect((await dialog.findByRole('alert')).textContent).toContain('可以重试');
    expect(field.value).toBe('排查昨天的失败记录');
    expect(confirm.disabled).toBe(false);
    expect(router.state.location.pathname).toBe(TASK_PATH);
    fireEvent.click(confirm);
    await waitFor(() => expect(router.state.location.search).toBe(`?session=${CREATED.id}`));
    expect(http.post.mock.calls).toHaveLength(2);
    expect(http.post.mock.calls[1]).toEqual(http.post.mock.calls[0]);
  });

  it('普通用户看不到入口，确认前降权也不会创建', async () => {
    setRole('user');
    renderPage();
    await screen.findByRole('heading', { name: TASK_NAME });
    expect(screen.queryByRole('button', { name: ENTRY })).toBeNull();
    act(() => setRole('admin'));
    const { confirm } = await openDialog();
    act(() => { setRole('user'); fireEvent.click(confirm); });
    expect(screen.queryByRole('button', { name: ENTRY })).toBeNull();
    expect(screen.queryByRole('dialog', { name: ENTRY })).toBeNull();
    expect(http.post).not.toHaveBeenCalled();
  });

  it('切换任务后，上一任务的迟到响应不会抢走当前页面', async () => {
    const finish = holdCreation();
    const router = renderPage();
    const { confirm } = await openDialog();
    fireEvent.click(confirm);
    expect(http.post).toHaveBeenCalledTimes(1);
    await act(async () => { await router.navigate('/tasks/second'); });
    await screen.findByRole('heading', { name: '另一项任务' });
    await act(async () => finish());
    expect(router.state.location.pathname).toBe('/tasks/second');
    expect(screen.queryByRole('dialog', { name: ENTRY })).toBeNull();
  });
});
