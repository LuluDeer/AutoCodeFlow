/**
 * OPTIMISTIC-01（页面层）：TaskListPage 行内 Switch 的乐观暂停/恢复。
 *
 * 与 task-toggle-optimistic.test.tsx（纯函数/缓存/mutation 三层）互补——
 * 本文件从**用户视角**钉住：
 *  ① 点 Switch → **请求还在飞**的时候开关就已经翻到目标态（乐观生效）；
 *  ② 请求失败 → 开关自己弹回原态（回滚真的接到了 UI），并给出错误提示；
 *  ③ 失败后列表数据仍是"未变更"的一致状态（不残留乐观值）。
 *
 * 反证：把 handlePause 改回 `await tasksApi.pause(id)` + `refresh()`（无
 * onMutate）→ ① 变红（请求挂起时开关不动）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import TaskListPage from '../pages/TaskListPage';
import { tasksApi, type Task } from '../api/tasks';
import { useAuthStore } from '../store/auth';

vi.mock('../api/tasks', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/tasks')>();
  return {
    ...actual,
    tasksApi: {
      ...actual.tasksApi,
      list: vi.fn(),
      get: vi.fn(),
      create: vi.fn(),
      delete: vi.fn(),
      trigger: vi.fn(),
      pause: vi.fn(),
      resume: vi.fn(),
      batchTrigger: vi.fn(),
      batchPause: vi.fn(),
      batchResume: vi.fn(),
      batchDelete: vi.fn(),
    },
  };
});

const g = globalThis as Record<string, unknown>;
if (!g.ResizeObserver) {
  g.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
}
if (!window.matchMedia) {
  window.matchMedia = ((q: string) => ({
    matches: false, media: q, onchange: null, addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

const makeTask = (over: Partial<Task> = {}): Task =>
  ({
    id: 'task-1',
    name: '备份任务',
    runtime: 'python',
    entrypoint: 'src/main.py',
    status: 'active',
    triggerType: 'cron',
    cronExpression: '0 2 * * *',
    maxRetry: 3,
    timeout: 300,
    priority: 2,
    createdAt: '2026-09-01T08:00:00Z',
    updatedAt: '2026-09-07T08:00:00Z',
    ...over,
  }) as Task;

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return {
    qc,
    ...render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={['/tasks']}>
          <Routes>
            <Route path="/tasks" element={<TaskListPage />} />
            <Route path="/tasks/new" element={<div />} />
            <Route path="/tasks/:id" element={<div />} />
            <Route path="/tasks/:id/edit" element={<div />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    ),
  };
}

/** 第一行 Switch（启用列） */
const rowSwitch = (index = 0): HTMLButtonElement =>
  document.body.querySelectorAll('.ant-table-row .ant-switch')[index] as HTMLButtonElement;

/** 开关当前是否处于"开启"态 */
const isSwitchOn = (el: HTMLButtonElement) => el.getAttribute('aria-checked') === 'true';

beforeEach(() => {
  localStorage.clear();
  cleanup();
  vi.clearAllMocks();
  useAuthStore.setState({ user: { id: 1, username: 'root', role: 'admin' } });
  vi.mocked(tasksApi.list).mockResolvedValue({
    items: [makeTask({ status: 'active' })], total: 1, page: 1, pageSize: 20,
  } as never);
});
afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe('OPTIMISTIC-01 TaskListPage：暂停的乐观反馈', () => {
  it('请求还在飞时开关已经关掉（乐观生效，不等服务端）', async () => {
    // 永不 resolve：模拟慢网络。若实现没有 onMutate，开关会一直停在开启态。
    vi.mocked(tasksApi.pause).mockReturnValue(new Promise(() => {}) as never);
    renderPage();
    await screen.findByText('备份任务');

    const sw = rowSwitch();
    expect(isSwitchOn(sw)).toBe(true);
    fireEvent.click(sw);

    await waitFor(() => expect(tasksApi.pause).toHaveBeenCalledWith('task-1'));
    // 关键断言：请求未返回，但开关已翻到关闭
    await waitFor(() => expect(isSwitchOn(rowSwitch())).toBe(false));
  });

  it('恢复的乐观反馈：paused 行点开关 → 请求未返回时已开启', async () => {
    vi.mocked(tasksApi.list).mockResolvedValue({
      items: [makeTask({ status: 'paused' })], total: 1, page: 1, pageSize: 20,
    } as never);
    vi.mocked(tasksApi.resume).mockReturnValue(new Promise(() => {}) as never);
    renderPage();
    await screen.findByText('备份任务');

    expect(isSwitchOn(rowSwitch())).toBe(false);
    fireEvent.click(rowSwitch());
    await waitFor(() => expect(tasksApi.resume).toHaveBeenCalledWith('task-1'));
    await waitFor(() => expect(isSwitchOn(rowSwitch())).toBe(true));
  });

  it('失败回滚：pause 拒绝 → 开关弹回开启态，且给出错误提示', async () => {
    vi.mocked(tasksApi.pause).mockRejectedValue(
      Object.assign(new Error('bad'), { response: { data: { message: '任务已被删除' } } }),
    );
    renderPage();
    await screen.findByText('备份任务');

    fireEvent.click(rowSwitch());
    // 错误提示（既有语义不变）
    await waitFor(() => expect(screen.getByText('任务已被删除')).toBeTruthy());
    // 回滚：开关回到开启态（不是停在乐观的关闭态）
    await waitFor(() => expect(isSwitchOn(rowSwitch())).toBe(true));
  });

  it('失败回滚后列表数据一致：重新拉取拿到的仍是 active（无残留乐观值）', async () => {
    vi.mocked(tasksApi.pause).mockRejectedValue(new Error('network down'));
    const { qc } = renderPage();
    await screen.findByText('备份任务');

    fireEvent.click(rowSwitch());
    await waitFor(() => expect(tasksApi.pause).toHaveBeenCalled());

    // 等回滚落定后，缓存的 status 必须是 active（不是 paused）
    await waitFor(() => {
      const entries = qc.getQueryCache().findAll({ queryKey: ['tasks', 'list'] });
      expect(entries.length).toBeGreaterThan(0);
      const data = entries[0].state.data as { items: Task[] } | undefined;
      expect(data?.items[0]?.status).toBe('active');
    });
  });

  /**
   * **只有回滚能救**的用例（补强）：
   *
   * 上面那条「失败回滚后列表数据一致」与更上面那条「开关弹回」都**不足以**
   * 证明回滚接上了——它们断言的状态，靠 `onSettled` 的 invalidate 重取
   * （list mock 恒返 active）同样能得到。实测反证：把 `onError` 里的
   * `rollback?.()` 注释掉，那两条**照样全绿**，只有 mutation 层那条纯缓存
   * 用例变红。也就是说页面层的"回滚"其实验的是重取路径。
   *
   * 真实故障形态恰恰是重取也救不了：pause 因网络失败 → 紧接着 onSettled 的
   * 重取**同样失败**（同一张网）。此时 React Query 在重取失败时保留旧 data，
   * 若回滚没接上，开关会**永久**停在乐观的关闭态，而服务端其实还是 active
   * ——用户以为任务停了，实际还在跑（比不做乐观更新更危险）。
   *
   * 故本用例让首屏 list 成功、其后所有 list 重取一律失败：UI 能回到开启态
   * 的唯一途径就是 `onError` 的快照回滚。
   */
  it('网络故障（pause 失败 + 后续重取也失败）→ 开关仍必须弹回：只有回滚能救', async () => {
    let listCalls = 0;
    vi.mocked(tasksApi.list).mockImplementation((async () => {
      listCalls += 1;
      // 首屏成功，之后（失败后的重取）一律失败——模拟"网络已经断了"
      if (listCalls === 1) {
        return { items: [makeTask({ status: 'active' })], total: 1, page: 1, pageSize: 20 };
      }
      throw new Error('network down');
    }) as never);
    vi.mocked(tasksApi.pause).mockRejectedValue(new Error('network down'));

    renderPage();
    await screen.findByText('备份任务');
    expect(isSwitchOn(rowSwitch())).toBe(true);

    fireEvent.click(rowSwitch());
    await waitFor(() => expect(tasksApi.pause).toHaveBeenCalled());

    // 重取已失败（listCalls ≥ 2）之后，开关仍必须是开启态
    await waitFor(() => expect(listCalls).toBeGreaterThan(1));
    await waitFor(() => expect(isSwitchOn(rowSwitch())).toBe(true));
  });

  it('成功后由服务端真相校正：onSettled 触发一次重取（乐观值只是过渡态）', async () => {
    vi.mocked(tasksApi.pause).mockResolvedValue(makeTask({ status: 'paused' }) as never);
    renderPage();
    await screen.findByText('备份任务');
    const listCallsBefore = vi.mocked(tasksApi.list).mock.calls.length;

    fireEvent.click(rowSwitch());
    await waitFor(() => expect(tasksApi.pause).toHaveBeenCalledWith('task-1'));

    // onSettled → invalidateTaskData(tasks.all)。列表有活跃 observer，
    // invalidate 会立即触发重取；`isInvalidated` 标记在重取完成后即被清除，
    // 因此这里断言「确实又拉了一次」而不是「标记还在」。
    await waitFor(() =>
      expect(vi.mocked(tasksApi.list).mock.calls.length).toBeGreaterThan(listCallsBefore),
    );
  });
});
