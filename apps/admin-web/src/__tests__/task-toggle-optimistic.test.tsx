/**
 * OPTIMISTIC-01：任务暂停/恢复的乐观更新（**唯一**两处 onMutate）。
 *
 * 三层断言，缺一层都守不住：
 *  ① **纯函数层**（`patchTaskInPage` / `applyTaskStatusPatch`）：只改 status、
 *     未命中返回原引用（避免无谓重渲染）、不修改入参；
 *  ② **缓存层**（`optimisticallySetTaskStatus`）：覆盖 list 各筛选组合 + detail +
 *     DAG 三种形态，撤销函数精确还原（含"原本没有该缓存 → 撤销后不留空条目"）；
 *  ③ **mutation 层**（`usePauseTask` / `useResumeTask`）：onMutate 写乐观值 +
 *     取消在途 GET、onError 回滚、onSettled 无条件失效。
 *
 * 反证：把 onError 的 rollback 去掉 → ③ 的回滚用例变红；把 onMutate 改成
 * 只写 detail → ②③ 的列表用例变红。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import {
  applyTaskStatusPatch,
  optimisticallySetTaskStatus,
  patchTaskInPage,
  queryKeys,
  usePauseTask,
  useResumeTask,
} from '../api/queries';
import { tasksApi, type PageResult, type Task } from '../api/tasks';

vi.mock('../api/tasks', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/tasks')>();
  return {
    ...actual,
    tasksApi: { ...actual.tasksApi, pause: vi.fn(), resume: vi.fn(), list: vi.fn() },
  };
});

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

const page = (items: Task[]): PageResult<Task> => ({
  items,
  total: items.length,
  page: 1,
  pageSize: 20,
});

function newClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
}

function wrapper(client: QueryClient) {
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('OPTIMISTIC-01 ① 纯函数：只改 status，未命中返回原引用', () => {
  it('applyTaskStatusPatch 只覆盖 status，其它字段原样保留', () => {
    const task = makeTask({ status: 'active' });
    const patched = applyTaskStatusPatch(task, 'paused');
    expect(patched.status).toBe('paused');
    expect(patched.name).toBe(task.name);
    expect(patched.updatedAt).toBe(task.updatedAt);
    // 不修改入参（纯函数）
    expect(task.status).toBe('active');
  });

  it('status 已是目标值 → 返回原引用（不做无谓的缓存写）', () => {
    const task = makeTask({ status: 'paused' });
    expect(applyTaskStatusPatch(task, 'paused')).toBe(task);
  });

  it('patchTaskInPage 命中目标行，其余行引用不变', () => {
    const a = makeTask({ id: 'a', status: 'active' });
    const b = makeTask({ id: 'b', status: 'active' });
    const before = page([a, b]);
    const after = patchTaskInPage(before, 'a', 'paused')!;
    expect(after.items[0].status).toBe('paused');
    expect(after.items[1]).toBe(b); // 未命中的行引用不变
    expect(after.total).toBe(before.total);
    // 原对象未被改动
    expect(before.items[0].status).toBe('active');
  });

  it('patchTaskInPage 未命中 / 空页 → 返回原引用', () => {
    const before = page([makeTask({ id: 'a' })]);
    expect(patchTaskInPage(before, 'not-there', 'paused')).toBe(before);
    expect(patchTaskInPage(undefined, 'a', 'paused')).toBeUndefined();
    // 畸形载荷（items 不是数组）不炸
    expect(
      patchTaskInPage({ items: null, total: 0 } as unknown as PageResult<Task>, 'a', 'paused'),
    ).toBeTruthy();
  });
});

describe('OPTIMISTIC-01 ② 缓存层：覆盖 list/detail/DAG 三种形态，撤销精确还原', () => {
  it('乐观写入覆盖所有已缓存 list 筛选组合 + detail + DAG', () => {
    const client = newClient();
    const keyP1 = queryKeys.tasks.list({ page: 1, pageSize: 20 });
    const keyP2 = queryKeys.tasks.list({ page: 2, pageSize: 20, status: 'active' });
    const keyDetail = queryKeys.tasks.detail('task-1');
    client.setQueryData(keyP1, page([makeTask({ id: 'task-1', status: 'active' })]));
    client.setQueryData(keyP2, page([makeTask({ id: 'task-1', status: 'active' })]));
    client.setQueryData(keyDetail, makeTask({ id: 'task-1', status: 'active' }));
    client.setQueryData(queryKeys.tasks.allForDag, page([makeTask({ id: 'task-1', status: 'active' })]));

    const rollback = optimisticallySetTaskStatus(client, 'task-1', 'paused');

    // 三种形态全部翻到 paused
    expect((client.getQueryData<PageResult<Task>>(keyP1)!).items[0].status).toBe('paused');
    expect((client.getQueryData<PageResult<Task>>(keyP2)!).items[0].status).toBe('paused');
    expect(client.getQueryData<Task>(keyDetail)!.status).toBe('paused');
    expect(
      (client.getQueryData<PageResult<Task>>(queryKeys.tasks.allForDag)!).items[0].status,
    ).toBe('paused');

    // 撤销 → 全部回到 active
    rollback();
    expect((client.getQueryData<PageResult<Task>>(keyP1)!).items[0].status).toBe('active');
    expect((client.getQueryData<PageResult<Task>>(keyP2)!).items[0].status).toBe('active');
    expect(client.getQueryData<Task>(keyDetail)!.status).toBe('active');
    expect(
      (client.getQueryData<PageResult<Task>>(queryKeys.tasks.allForDag)!).items[0].status,
    ).toBe('active');
  });

  it('撤销后不留空条目：原本没有 detail 缓存 → 撤销时被移除而非写回 undefined', () => {
    const client = newClient();
    const keyP1 = queryKeys.tasks.list({ page: 1, pageSize: 20 });
    client.setQueryData(keyP1, page([makeTask({ id: 'task-1' })]));
    // detail 原本没有缓存
    expect(client.getQueryData(queryKeys.tasks.detail('task-1'))).toBeUndefined();

    const rollback = optimisticallySetTaskStatus(client, 'task-1', 'paused');
    // 乐观写入没有凭空创建 detail 缓存（getQueryData 为 undefined 时不写）
    expect(client.getQueryData(queryKeys.tasks.detail('task-1'))).toBeUndefined();

    rollback();
    expect(client.getQueryData(keyP1) && (client.getQueryData<PageResult<Task>>(keyP1)!).items[0].status).toBe(
      'active',
    );
  });

  it('未命中任何缓存 → 撤销是安全的 no-op', () => {
    const client = newClient();
    const rollback = optimisticallySetTaskStatus(client, 'ghost', 'paused');
    expect(() => rollback()).not.toThrow();
  });

  it('只影响目标 id：同页其它任务的状态不变', () => {
    const client = newClient();
    const key = queryKeys.tasks.list({ page: 1, pageSize: 20 });
    client.setQueryData(key, page([makeTask({ id: 'a' }), makeTask({ id: 'b', status: 'paused' })]));
    const rollback = optimisticallySetTaskStatus(client, 'a', 'paused');
    const items = client.getQueryData<PageResult<Task>>(key)!.items;
    expect(items[0].status).toBe('paused');
    expect(items[1].status).toBe('paused'); // b 本来就是 paused，未受影响
    rollback();
    expect(client.getQueryData<PageResult<Task>>(key)!.items[0].status).toBe('active');
  });
});

describe('OPTIMISTIC-01 ③ mutation 层：乐观写入 / 失败回滚 / 收尾失效', () => {
  it('usePauseTask：请求未返回时缓存已翻到 paused（乐观）', async () => {
    const client = newClient();
    const key = queryKeys.tasks.list({ page: 1, pageSize: 20 });
    client.setQueryData(key, page([makeTask({ id: 'task-1', status: 'active' })]));
    // 永不 resolve 的请求：模拟"网络慢"——此刻缓存必须已是目标态
    vi.mocked(tasksApi.pause).mockReturnValue(new Promise(() => {}) as never);

    const { result } = renderHook(() => usePauseTask(), { wrapper: wrapper(client) });
    act(() => {
      result.current.mutate('task-1');
    });

    await waitFor(() =>
      expect(client.getQueryData<PageResult<Task>>(key)!.items[0].status).toBe('paused'),
    );
    // 请求确实发出了
    expect(tasksApi.pause).toHaveBeenCalledWith('task-1');
  });

  it('useResumeTask：乐观翻到 active', async () => {
    const client = newClient();
    const key = queryKeys.tasks.detail('task-1');
    client.setQueryData(key, makeTask({ id: 'task-1', status: 'paused' }));
    vi.mocked(tasksApi.resume).mockReturnValue(new Promise(() => {}) as never);

    const { result } = renderHook(() => useResumeTask(), { wrapper: wrapper(client) });
    act(() => {
      result.current.mutate('task-1');
    });
    await waitFor(() => expect(client.getQueryData<Task>(key)!.status).toBe('active'));
    expect(tasksApi.resume).toHaveBeenCalledWith('task-1');
  });

  it('失败回滚：pause 拒绝 → 缓存恢复为原 status（开关弹回去）', async () => {
    const client = newClient();
    const key = queryKeys.tasks.list({ page: 1, pageSize: 20 });
    const detailKey = queryKeys.tasks.detail('task-1');
    client.setQueryData(key, page([makeTask({ id: 'task-1', status: 'active' })]));
    client.setQueryData(detailKey, makeTask({ id: 'task-1', status: 'active' }));
    vi.mocked(tasksApi.pause).mockRejectedValue(new Error('boom'));

    const { result } = renderHook(() => usePauseTask(), { wrapper: wrapper(client) });
    await act(async () => {
      await result.current.mutateAsync('task-1').catch(() => {});
    });

    await waitFor(() => expect(result.current.isError).toBe(true));
    // 回滚到 active（列表 + 详情都还原）
    expect(client.getQueryData<PageResult<Task>>(key)!.items[0].status).toBe('active');
    expect(client.getQueryData<Task>(detailKey)!.status).toBe('active');
  });

  it('onSettled 无条件失效任务面（成功也用服务端真相校正）', async () => {
    const client = newClient();
    const key = queryKeys.tasks.list({ page: 1, pageSize: 20 });
    client.setQueryData(key, page([makeTask({ id: 'task-1' })]));
    // 预置执行面/metrics 面缓存：未预置的 query 在缓存里根本不存在，
    // getQueryState 返回 undefined（断言 undefined === true 没有意义）
    client.setQueryData(queryKeys.executions.all, []);
    client.setQueryData(queryKeys.metrics.all, []);
    vi.mocked(tasksApi.pause).mockResolvedValue(makeTask({ id: 'task-1', status: 'paused' }) as never);

    const { result } = renderHook(() => usePauseTask(), { wrapper: wrapper(client) });
    await act(async () => {
      await result.current.mutateAsync('task-1');
    });
    await waitFor(() => expect(client.getQueryState(key)?.isInvalidated).toBe(true));
    // 任务面之外的执行面/metrics 同样失效（pause 停调度器，KPI 联动）
    expect(client.getQueryState(queryKeys.executions.all)?.isInvalidated).toBe(true);
    expect(client.getQueryState(queryKeys.metrics.all)?.isInvalidated).toBe(true);
  });

  it('onMutate 取消在途 GET：慢列表请求不会把乐观值盖回旧 status', async () => {
    const client = newClient();
    const key = queryKeys.tasks.list({ page: 1, pageSize: 20 });
    client.setQueryData(key, page([makeTask({ id: 'task-1', status: 'active' })]));
    vi.mocked(tasksApi.pause).mockReturnValue(new Promise(() => {}) as never);

    // 一个真实的 in-flight 查询（挂起中，模拟慢 GET）
    const inflight = client.fetchQuery({
      queryKey: key,
      queryFn: () => new Promise<PageResult<Task>>(() => {}),
    });
    void inflight.catch(() => {});

    const { result } = renderHook(() => usePauseTask(), { wrapper: wrapper(client) });
    act(() => {
      result.current.mutate('task-1');
    });

    await waitFor(() =>
      expect(client.getQueryData<PageResult<Task>>(key)!.items[0].status).toBe('paused'),
    );
    // 在途查询被取消（cancelQueries 生效）——它不会再写缓存
    const cache = client.getQueryCache().find({ queryKey: key });
    expect(cache?.state.fetchStatus).not.toBe('fetching');
  });

  it('SSE 互操作：invalidateExecutionData 不碰 tasks 缓存（乐观值不被 SSE 覆盖）', async () => {
    const client = newClient();
    const key = queryKeys.tasks.list({ page: 1, pageSize: 20 });
    client.setQueryData(key, page([makeTask({ id: 'task-1', status: 'active' })]));
    vi.mocked(tasksApi.pause).mockReturnValue(new Promise(() => {}) as never);

    const { result } = renderHook(() => usePauseTask(), { wrapper: wrapper(client) });
    act(() => {
      result.current.mutate('task-1');
    });
    await waitFor(() =>
      expect(client.getQueryData<PageResult<Task>>(key)!.items[0].status).toBe('paused'),
    );

    // 执行终态 SSE 到达 → invalidateExecutionData（只失效 executions + metrics）
    const { invalidateExecutionData } = await import('../api/queries');
    await invalidateExecutionData(client);

    // tasks 缓存既没被失效、也没被改写——乐观值存活
    expect(client.getQueryState(key)?.isInvalidated).toBeFalsy();
    expect(client.getQueryData<PageResult<Task>>(key)!.items[0].status).toBe('paused');
  });
});
