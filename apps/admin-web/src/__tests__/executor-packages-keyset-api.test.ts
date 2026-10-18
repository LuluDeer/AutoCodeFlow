/**
 * `executorPackagesApi.list` / `listLatest` 的**api 层**契约
 * （📌 任务书点名要钉的那一条：`listLatest` 逐字节不变）。
 *
 * ## 为什么单独一份文件
 *
 * 页面的 keyset 用例（`executor-packages-keyset-paging.test.tsx`）必须把整个
 * `api/executor-packages` 模块 mock 掉才能隔离网络——那种隔离下 `listLatest`
 * 的**真实实现**根本不会被执行，写在那里的断言检验的是测试自己的 mock。
 * 这里只 mock `api/client`（最外层的 HTTP 出口），真实实现在跑，断言才有意义。
 *
 * ## 为什么 `listLatest` 必须钉住
 *
 * 它走的是**同一个端点** `GET /executor-packages`（安装向导用它取"active 的
 * 最新 100 个包"当候选，按类型+平台自行匹配最新）。它**不传 cursor**：
 *   · 客户端侧：它的参数对象里**没有** cursor 键；
 *   · 服务端侧：于是后端走 OFFSET 分支，响应形态与加游标之前**逐字节一致**。
 *
 * 一旦有人"顺手"给它加 cursor（比如为了消除 lint 警告把包表那套参数整个
 * 透传过来），向导的候选列表就会变成"游标之后的一页"，且随包表上一次翻到
 * 第几页而变——安装向导会给管理员推荐**错的安装包**，而整个过程不报错。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { client } from '../api/client';
import { executorPackagesApi } from '../api/executor-packages';
import type { ExecutorPackage } from '../api/executor-packages';

vi.mock('../api/client', () => ({
  client: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}));
const mockedClient = vi.mocked(client, true);

const packageRow = (over: Partial<ExecutorPackage> = {}): ExecutorPackage => ({
  id: 'pkg-1',
  name: 'python-runner',
  version: '1.0.0',
  type: 'python',
  platform: 'linux',
  fileSize: 1024,
  sha256: 'sha256',
  changelog: '',
  status: 'active',
  downloadCount: 0,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...over,
});

/** 取出第 n 次 get 调用的 params。 */
const paramsOf = (n = 0): Record<string, unknown> =>
  (mockedClient.get.mock.calls[n]![1] as { params: Record<string, unknown> }).params;

beforeEach(() => {
  vi.clearAllMocks();
  mockedClient.get.mockResolvedValue({ items: [packageRow()], total: 1 } as never);
});

describe('listLatest：安装向导的固定切片，逐字节不变', () => {
  it('请求参数逐字等于 {page:1, pageSize:100, status:active}，且**没有** cursor 键', async () => {
    const rows = await executorPackagesApi.listLatest();

    expect(mockedClient.get).toHaveBeenCalledTimes(1);
    const [url] = mockedClient.get.mock.calls[0]!;
    expect(url).toBe('/executor-packages');
    // 逐字节：键集合与值都必须与加游标之前完全相同。
    // 注意 toEqual 对 {cursor: undefined} 是**宽容**的（键存在但值为 undefined
    // 也能过），故下面再用 `in` 判据明确钉住"键不存在"。
    expect(paramsOf()).toEqual({ page: 1, pageSize: 100, status: 'active' });
    expect('cursor' in paramsOf()).toBe(false);
    // 响应是裸 {items,total}（不是 paginate() 信封）→ items 原样返回
    expect(rows).toEqual([packageRow()]);
  });

  it('响应多带 nextCursor 也只取 items（多一个键不改变安装向导的候选集）', async () => {
    // 模拟"后端将来在非 cursor 请求上也回 nextCursor"——listLatest 仍只看 items，
    // 不会因为多了个键就把候选集换成"下一页"。
    mockedClient.get.mockResolvedValue({
      items: [packageRow()],
      total: 1,
      nextCursor: 'SHOULD_BE_IGNORED',
    } as never);

    const rows = await executorPackagesApi.listLatest();

    expect(rows).toEqual([packageRow()]);
    expect('cursor' in paramsOf()).toBe(false);
  });

  it('items 缺失 → 空数组（不抛错；向导按"无可用包"降级）', async () => {
    mockedClient.get.mockResolvedValue({ total: 0 } as never);
    await expect(executorPackagesApi.listLatest()).resolves.toEqual([]);
  });

  it('items 为 null（后端偶发）→ 空数组而不是 null 传染到渲染层', async () => {
    mockedClient.get.mockResolvedValue({ items: null, total: 0 } as never);
    await expect(executorPackagesApi.listLatest()).resolves.toEqual([]);
  });
});

describe('list：三态游标的显式归一', () => {
  it('未传 cursor → 请求里**没有** cursor 键（旧 OFFSET 路径逐字节不变）', async () => {
    await executorPackagesApi.list({ page: 1, pageSize: 20, name: 'py' });

    const params = paramsOf();
    expect('cursor' in params).toBe(false);
    expect(params).toEqual({ page: 1, pageSize: 20, name: 'py' });
  });

  it('cursor: undefined 的键被显式删掉（不押在 axios 的序列化细节上）', async () => {
    await executorPackagesApi.list({ page: 1, pageSize: 20, cursor: undefined });

    const params = paramsOf();
    expect('cursor' in params).toBe(false);
  });

  it('cursor: \'\'（空串）**必须保留**（= keyset 起点，被归一掉就永远进不去）', async () => {
    await executorPackagesApi.list({ page: 1, pageSize: 20, cursor: '' });

    const params = paramsOf();
    // 用 in 判据：空串是"键存在且为空"
    expect('cursor' in params).toBe(true);
    expect(params.cursor).toBe('');
  });

  it('cursor: 非空串 → 原样回传，不解析不加工', async () => {
    await executorPackagesApi.list({ cursor: 'OPAQUE_TOKEN_abc-_123' });

    expect(paramsOf().cursor).toBe('OPAQUE_TOKEN_abc-_123');
  });

  it('响应 nextCursor 三态如实透传（字符串 / null / 键缺失）', async () => {
    mockedClient.get.mockResolvedValue({
      items: [packageRow()],
      total: 1,
      nextCursor: 'NEXT_1',
    } as never);
    await expect(executorPackagesApi.list({ cursor: '' })).resolves.toMatchObject({
      nextCursor: 'NEXT_1',
    });

    mockedClient.get.mockResolvedValue({
      items: [],
      total: 1,
      nextCursor: null,
    } as never);
    await expect(executorPackagesApi.list({ cursor: 'NEXT_1' })).resolves.toMatchObject({
      nextCursor: null,
    });

    // OFFSET 路径：键根本不存在 → 读出来是 undefined（**不是** null）
    mockedClient.get.mockResolvedValue({ items: [packageRow()], total: 1 } as never);
    const offsetRes = await executorPackagesApi.list({});
    expect('nextCursor' in offsetRes).toBe(false);
  });
});
