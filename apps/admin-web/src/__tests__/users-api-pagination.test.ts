/**
 * usersApi 分页契约回归（ADMIN 成员面板 400 事件）。
 *
 * 事故：ProjectsPage 的「成员」抽屉以管理员身份打开时整块报错
 *   `Validation failed: pageSize must not be greater than 100`
 * 根因：调用方写死 `usersApi.list(1, 200)`，而后端 PageQueryDto 对 pageSize
 * 有 `@Max(100)`（见 apps/admin-api/src/common/dto/pagination.dto.ts:42）。
 * 该请求的 enabled 条件是 `open && isAdmin`，因此**只有管理员会踩中**——
 * 普通用户永远看不到，是一个长期潜伏的 ADMIN-only 缺陷。
 *
 * 本文件锁定三件事：
 *  1. list 对任意入参都夹紧到 ≤100（契约违规在 API 层被挡住）；
 *  2. listAll 跨页取全，用户数 >100 时不静默截断；
 *  3. listAll 对异常 total / 空页 / 中止信号的处理。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { usersApi } from '../api/users';
import { client as apiClient } from '../api/client';

vi.mock('../api/client', () => ({
  client: { get: vi.fn() },
}));

const mockGet = vi.mocked(apiClient.get);

const makeUser = (id: number) => ({
  id,
  username: `u${id}`,
  email: `u${id}@x`,
  role: 'user',
  createdAt: '',
  updatedAt: '',
});

// 从 GET 的 url 里解析 page / pageSize，模拟后端的分页语义
const parsePage = (url: string) => {
  const m = /page=(\d+)&pageSize=(\d+)/.exec(url);
  return { page: Number(m?.[1]), pageSize: Number(m?.[2]) };
};

describe('usersApi 分页契约（pageSize ≤ 100）', () => {
  beforeEach(() => {
    mockGet.mockReset();
  });

  it('list 把超限的 pageSize 夹紧到 100（原 200 → 必 400 的根因）', async () => {
    mockGet.mockResolvedValue({ list: [], total: 0, page: 1, pageSize: 100 });
    await usersApi.list(1, 200);
    expect(mockGet).toHaveBeenCalledWith('/users?page=1&pageSize=100');
  });

  it.each([
    [5000, 100],
    [101, 100],
    [100, 100],
    [20, 20],
  ])('list pageSize=%i → 实际下发 %i', async (input, expected) => {
    mockGet.mockResolvedValue({ list: [], total: 0, page: 1, pageSize: expected });
    await usersApi.list(1, input);
    const url = mockGet.mock.calls[0][0] as string;
    expect(parsePage(url).pageSize).toBe(expected);
  });

  it('list 对非法 pageSize（0 / NaN / undefined）回落默认 20，负数夹到 1', async () => {
    mockGet.mockResolvedValue({ list: [], total: 0, page: 1, pageSize: 20 });
    // 0 / NaN / undefined 都是"没给有效值"→ 默认 20；
    // 负数是有意给的坏值 → 夹到合法下界 1。
    // 三者的关键共同点：**绝不把非法值原样下发**（pageSize=0 后端同样 400）。
    const cases: Array<[number | undefined, number]> = [
      [0, 20],
      [Number.NaN, 20],
      [undefined, 20],
      [-5, 1],
    ];
    for (const [bad, expected] of cases) {
      mockGet.mockClear();
      await usersApi.list(1, bad as number);
      const url = mockGet.mock.calls[0][0] as string;
      const actual = parsePage(url).pageSize;
      expect(actual).toBe(expected);
      expect(actual).toBeGreaterThanOrEqual(1); // 契约下界
      expect(actual).toBeLessThanOrEqual(100); // 契约上界
    }
  });

  it('listAll 单页足够时只请求一次', async () => {
    mockGet.mockResolvedValue({ list: [makeUser(1), makeUser(2)], total: 2, page: 1, pageSize: 100 });
    const all = await usersApi.listAll();
    expect(all).toHaveLength(2);
    expect(mockGet).toHaveBeenCalledTimes(1);
  });

  it('listAll 在 total>100 时翻页取全（不静默截断）', async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => makeUser(i + 1));
    const page2 = Array.from({ length: 50 }, (_, i) => makeUser(i + 101));
    mockGet
      .mockResolvedValueOnce({ list: page1, total: 150, page: 1, pageSize: 100 })
      .mockResolvedValueOnce({ list: page2, total: 150, page: 2, pageSize: 100 });

    const all = await usersApi.listAll();
    expect(all).toHaveLength(150);
    expect(mockGet).toHaveBeenCalledTimes(2);
    // 两页都必须是合法 pageSize
    for (const call of mockGet.mock.calls) {
      expect(parsePage(call[0] as string).pageSize).toBeLessThanOrEqual(100);
    }
    // 无重复
    expect(new Set(all.map((u) => u.id)).size).toBe(150);
  });

  it('listAll 遇到空页提前收敛（total 虚高时不空转）', async () => {
    mockGet
      .mockResolvedValueOnce({ list: [makeUser(1)], total: 999, page: 1, pageSize: 100 })
      .mockResolvedValueOnce({ list: [], total: 999, page: 2, pageSize: 100 });
    const all = await usersApi.listAll();
    expect(all).toHaveLength(1);
    expect(mockGet).toHaveBeenCalledTimes(2); // 第 2 页空 → 停止，不再打第 3 页
  });

  it('listAll 遵守 maxPages 上限', async () => {
    mockGet.mockImplementation(async (url: string) => {
      const { page } = parsePage(url);
      return { list: [makeUser(page)], total: 10_000, page, pageSize: 100 };
    });
    await usersApi.listAll(undefined, 3);
    expect(mockGet).toHaveBeenCalledTimes(3);
  });

  it('listAll 在 total 非法时返回已拿到的一页（不猜测翻页）', async () => {
    mockGet.mockResolvedValue({ list: [makeUser(1)], total: -1, page: 1, pageSize: 100 });
    const all = await usersApi.listAll();
    expect(all).toHaveLength(1);
    expect(mockGet).toHaveBeenCalledTimes(1);
  });

  it('listAll 响应的 pageSize 恒 ≤100（契约红线）', async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => makeUser(i + 1));
    mockGet
      .mockResolvedValueOnce({ list: page1, total: 101, page: 1, pageSize: 100 })
      .mockResolvedValueOnce({ list: [makeUser(101)], total: 101, page: 2, pageSize: 100 });
    await usersApi.listAll();
    const sizes = mockGet.mock.calls.map((c) => parsePage(c[0] as string).pageSize);
    expect(Math.max(...sizes)).toBeLessThanOrEqual(100);
  });
});
