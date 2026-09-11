/**
 * tasks API 层契约测试（N13）：
 * 后端契约——pause/resume 返回保存后的 Task 实体（admin-api task.service.ts），
 * killExecution 返回 {success,message} 包装。类型断言必须与实际响应形态一致，
 * 否则下游按类型读字段会拿到 undefined（TS 不报错的契约谎言）。
 *
 * 编译期契约（由 `tsc -b` / `npm run build` 把关，运行时测试无法替代）：
 * - 若 pause/resume 断言回退为 {success,message}，读取 res.status 的行将编译失败；
 * - 若 TaskExecution.status 回退为 string，@ts-expect-error 行将因“预期错误未出现”而编译失败。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  TASK_LIST_MAX_PAGES,
  TASK_LIST_PAGE_CONCURRENCY,
  TASK_LIST_PAGE_SIZE,
  tasksApi,
  type Task,
  type TaskExecution,
} from '../api/tasks';
import { client } from '../api/client';

vi.mock('../api/client', () => ({
  client: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}));

const mockGet = vi.mocked(client.get);
const mockPost = vi.mocked(client.post);

const fakeTask = {
  id: 't1',
  name: 'demo',
  runtime: 'node',
  entrypoint: 'index.js',
  status: 'paused',
  triggerType: 'manual',
  maxRetry: 0,
  timeout: 60,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
} satisfies Task;

const firstPageItems = (count: number) =>
  Array.from({ length: count }, (_, i) => ({ ...fakeTask, id: `t-${i}` }));

beforeEach(() => {
  mockGet.mockReset();
  mockPost.mockReset();
});

describe('tasksApi.listAll — GET /tasks pageSize 上限与全量聚合', () => {
  it('uses pageSize=100 and aggregates every page when total exceeds 100', async () => {
    const firstItems = Array.from({ length: 100 }, (_, i) => ({ ...fakeTask, id: `t-${i}` }));
    const secondItems = Array.from({ length: 2 }, (_, i) => ({ ...fakeTask, id: `t-${100 + i}` }));
    mockGet
      .mockResolvedValueOnce({ items: firstItems, total: 102, page: 1, pageSize: 100, totalPages: 2 })
      .mockResolvedValueOnce({ items: secondItems, total: 102, page: 2, pageSize: 100, totalPages: 2 });

    const result = await tasksApi.listAll();

    expect(mockGet).toHaveBeenNthCalledWith(1, '/tasks', { params: { page: 1, pageSize: 100 } });
    expect(mockGet).toHaveBeenNthCalledWith(2, '/tasks', { params: { page: 2, pageSize: 100 } });
    expect(result.items).toHaveLength(102);
    expect(result.items.map((item) => item.id)).toEqual([
      ...firstItems.map((item) => item.id),
      ...secondItems.map((item) => item.id),
    ]);
  });

  it('uses the response total when totalPages is omitted', async () => {
    const firstItems = Array.from({ length: 100 }, (_, i) => ({ ...fakeTask, id: `t-${i}` }));
    mockGet
      .mockResolvedValueOnce({ items: firstItems, total: 101, page: 1, pageSize: 100 })
      .mockResolvedValueOnce({ items: [{ ...fakeTask, id: 't-100' }], total: 101, page: 2, pageSize: 100 });

    const result = await tasksApi.listAll();

    expect(mockGet).toHaveBeenCalledTimes(2);
    expect(result.items).toHaveLength(101);
    expect(result.totalPages).toBe(2);
  });

  it('passes AbortSignal to every page request', async () => {
    const signal = new AbortController().signal;
    mockGet
      .mockResolvedValueOnce({ items: firstPageItems(100), total: 101, page: 1, pageSize: 100, totalPages: 2 })
      .mockResolvedValueOnce({ items: [{ ...fakeTask, id: 't-100' }], total: 101, page: 2, pageSize: 100, totalPages: 2 });

    await tasksApi.listAll({ status: 'active' }, signal);

    expect(mockGet).toHaveBeenNthCalledWith(1, '/tasks', {
      params: { status: 'active', page: 1, pageSize: 100 },
      signal,
    });
    expect(mockGet).toHaveBeenNthCalledWith(2, '/tasks', {
      params: { status: 'active', page: 2, pageSize: 100 },
      signal,
    });
  });

  it.each([
    ['totalPages 不一致', { total: 101, page: 1, pageSize: 100, totalPages: 3 }],
    ['中间页为空', { total: 201, page: 2, pageSize: 100, totalPages: 3 }],
  ])('rejects %s instead of returning partial results', async (_reason, badPage) => {
    mockGet.mockResolvedValueOnce({
      items: firstPageItems(100),
      total: badPage.total,
      page: 1,
      pageSize: 100,
      totalPages: badPage.totalPages,
    });
    if (badPage.page === 2) {
      mockGet.mockResolvedValueOnce({
        items: [],
        total: badPage.total,
        page: badPage.page,
        pageSize: 100,
        totalPages: badPage.totalPages,
      });
    }

    await expect(tasksApi.listAll()).rejects.toThrow('任务列表分页响应无效');
  });

  it('rejects duplicate task ids across pages', async () => {
    mockGet
      .mockResolvedValueOnce({ items: firstPageItems(100), total: 101, page: 1, pageSize: 100, totalPages: 2 })
      .mockResolvedValueOnce({ items: [{ ...fakeTask, id: 't-0' }], total: 101, page: 2, pageSize: 100, totalPages: 2 });

    await expect(tasksApi.listAll()).rejects.toThrow('重复出现');
  });

  it('rejects a non-final empty page and missing records', async () => {
    mockGet
      .mockResolvedValueOnce({ items: firstPageItems(100), total: 201, page: 1, pageSize: 100, totalPages: 3 })
      .mockResolvedValueOnce({ items: [], total: 201, page: 2, pageSize: 100, totalPages: 3 })
      .mockResolvedValueOnce({ items: firstPageItems(1).map((item) => ({ ...item, id: 't-200' })), total: 201, page: 3, pageSize: 100, totalPages: 3 });

    await expect(tasksApi.listAll()).rejects.toThrow('应有 100 条');
  });

  it('keeps a large total within the fixed concurrency window', async () => {
    const total = TASK_LIST_PAGE_SIZE * (TASK_LIST_PAGE_CONCURRENCY * 2 + 1) + 1;
    const totalPages = Math.ceil(total / TASK_LIST_PAGE_SIZE);
    let active = 0;
    let maxActive = 0;

    mockGet.mockImplementation(async (_url, config) => {
      const page = (config as { params?: { page?: number } }).params?.page ?? 1;
      const count = page < totalPages
        ? TASK_LIST_PAGE_SIZE
        : total - TASK_LIST_PAGE_SIZE * (totalPages - 1);
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      active -= 1;
      return {
        items: Array.from({ length: count }, (_, index) => ({
          ...fakeTask,
          id: `t-${(page - 1) * TASK_LIST_PAGE_SIZE + index}`,
        })),
        total,
        page,
        pageSize: TASK_LIST_PAGE_SIZE,
        totalPages,
      };
    });

    const result = await tasksApi.listAll();

    expect(maxActive).toBeLessThanOrEqual(TASK_LIST_PAGE_CONCURRENCY);
    expect(mockGet).toHaveBeenCalledTimes(totalPages);
    expect(result.items).toHaveLength(total);
  });

  it('does not start the next window after cancellation', async () => {
    const controller = new AbortController();
    const total = TASK_LIST_PAGE_SIZE * (TASK_LIST_PAGE_CONCURRENCY + 1);
    const totalPages = total / TASK_LIST_PAGE_SIZE;

    mockGet.mockImplementation(async (_url, config) => {
      const page = (config as { params?: { page?: number } }).params?.page ?? 1;
      if (page === 2) controller.abort();
      return {
        items: firstPageItems(page < totalPages ? TASK_LIST_PAGE_SIZE : 0).map((item, index) => ({
          ...item,
          id: `t-${(page - 1) * TASK_LIST_PAGE_SIZE + index}`,
        })),
        total,
        page,
        pageSize: TASK_LIST_PAGE_SIZE,
        totalPages,
      };
    });

    await expect(tasksApi.listAll({}, controller.signal)).rejects.toThrow();
    expect(mockGet).toHaveBeenCalledTimes(2);
    expect(mockGet.mock.calls.slice(1).every(([, config]) =>
      (config as { signal?: AbortSignal }).signal === controller.signal,
    )).toBe(true);
  });

  it('rejects an impossible page count before starting page two', async () => {
    mockGet.mockResolvedValueOnce({
      items: firstPageItems(100),
      total: TASK_LIST_MAX_PAGES * TASK_LIST_PAGE_SIZE + 1,
      page: 1,
      pageSize: TASK_LIST_PAGE_SIZE,
    });

    await expect(tasksApi.listAll()).rejects.toThrow('超过安全上限');
    expect(mockGet).toHaveBeenCalledTimes(1);
  });

  it('accepts an empty list with total=0', async () => {
    mockGet.mockResolvedValueOnce({
      items: [],
      total: 0,
      page: 1,
      pageSize: TASK_LIST_PAGE_SIZE,
      totalPages: 0,
    });

    const result = await tasksApi.listAll();

    expect(result.items).toEqual([]);
    expect(result.totalPages).toBe(0);
    expect(mockGet).toHaveBeenCalledTimes(1);
  });
});

describe('tasksApi.pause / resume — 后端返回 Task 实体', () => {
  it('pause 透传后端 Task，并命中 /tasks/:id/pause', async () => {
    mockPost.mockResolvedValue(fakeTask);
    const res = await tasksApi.pause('t1');
    expect(mockPost).toHaveBeenCalledWith('/tasks/t1/pause');
    // 编译期契约：res 必须具有 Task 形态
    const status: Task['status'] = res.status;
    expect(status).toBe('paused');
    // 运行时契约：响应不是 {success,message} 包装
    expect((res as unknown as Record<string, unknown>).success).toBeUndefined();
  });

  it('resume 透传后端 Task，并命中 /tasks/:id/resume', async () => {
    const resumed = { ...fakeTask, status: 'active' };
    mockPost.mockResolvedValue(resumed);
    const res = await tasksApi.resume('t1');
    expect(mockPost).toHaveBeenCalledWith('/tasks/t1/resume');
    const status: Task['status'] = res.status;
    expect(status).toBe('active');
  });
});

describe('tasksApi.killExecution — 后端返回 {success,message}', () => {
  it('透传 kill 结果形态，并命中 /tasks/:id/executions/:execId/kill', async () => {
    mockPost.mockResolvedValue({ success: true, message: '执行已终止' });
    const res = await tasksApi.killExecution('t1', 'e1');
    expect(mockPost).toHaveBeenCalledWith('/tasks/t1/executions/e1/kill');
    expect(res.success).toBe(true);
    expect(res.message).toBe('执行已终止');
  });
});

describe('TaskExecution.status — 与后端 ExecutionStatus 枚举对齐的联合类型', () => {
  it('包含 killed 终态且拒绝未知字符串', () => {
    const killed: TaskExecution['status'] = 'killed';
    // @ts-expect-error — status 是联合类型而非 string，未知值应编译报错
    const invalid: TaskExecution['status'] = 'not_a_real_status';
    expect(killed).toBe('killed');
    expect(invalid).toBe('not_a_real_status');
  });
});
