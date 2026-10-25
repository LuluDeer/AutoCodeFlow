import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import axios, { AxiosError, AxiosHeaders, type AxiosAdapter } from 'axios';
import { client, getApiBaseUrl } from '../api/client';
import { useAuthStore } from '../store/auth';

/**
 * A-4（R3-A 审计）: 多标签页互踢修复——
 *  ① 401 refresh 前从 localStorage（zustand persist 落盘）重读最新 refresh
 *     token：另一 tab 已轮换写回新值时，本 tab 用新值 refresh 而非内存旧值
 *     （旧值已被后端轮换吊销，用旧值必 401 → 互踢跳 /login）；
 *  ② storage 事件把另一 tab 的落盘状态同步进本 tab 内存（登录/轮换/登出）。
 */

const adapter = vi.fn<AxiosAdapter>();
const success: AxiosAdapter = async (config) => ({
  config, status: 200, statusText: 'OK', headers: new AxiosHeaders(),
  data: { code: 0, data: { ok: true } },
});
const failure401: AxiosAdapter = async (config) => {
  throw new AxiosError('Request failed', undefined, config, undefined, {
    config, status: 401, statusText: 'Unauthorized', headers: new AxiosHeaders(),
    data: { message: 'HTTP 401' },
  });
};

/** 直接写 persist 落盘（模拟另一 tab 的 zustand persist 写入）。 */
const writePersisted = (state: {
  token: string | null;
  refreshToken: string | null;
  user: unknown;
}) => {
  localStorage.setItem(
    'autoflow-auth',
    JSON.stringify({ state, version: 0 }),
  );
};

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  useAuthStore.getState().logout();
  useAuthStore.getState().setAuth('tab-b-access', 'tab-b-refresh', { id: 1, username: 'alice' });
  adapter.mockReset().mockImplementation(success);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  useAuthStore.getState().logout();
});

describe('A-4 refresh 前重读 localStorage 最新 token', () => {
  it('另一 tab 已轮换写回新值 → 用落盘新值 refresh，并同步内存', async () => {
    // tab A 轮换后 persist 写回：token/refreshToken 均为 tab A 的新值
    writePersisted({
      token: 'tab-a-access',
      refreshToken: 'tab-a-refresh',
      user: { id: 1, username: 'alice' },
    });
    adapter.mockImplementationOnce(failure401);
    const post = vi.spyOn(axios, 'post').mockResolvedValue({
      data: { code: 0, data: { accessToken: 'new-access', refreshToken: 'new-refresh' } },
    });

    await expect(
      client.get('/tasks', { adapter: adapter as unknown as AxiosAdapter }),
    ).resolves.toEqual({ ok: true });

    // 关键断言：refresh 载荷用的是落盘新值，不是内存旧值 'tab-b-refresh'
    expect(post).toHaveBeenCalledWith(
      `${getApiBaseUrl()}/auth/refresh`,
      { refreshToken: 'tab-a-refresh' },
      { timeout: 10_000 },
    );
    // 轮换结果落回内存（后续请求用新 access）
    expect(useAuthStore.getState()).toMatchObject({
      token: 'new-access',
      refreshToken: 'new-refresh',
    });
  });

  it('落盘与内存一致（无另一 tab 更新）→ 仍用内存值 refresh（回归）', async () => {
    writePersisted({
      token: 'tab-b-access',
      refreshToken: 'tab-b-refresh',
      user: { id: 1, username: 'alice' },
    });
    adapter.mockImplementationOnce(failure401);
    const post = vi.spyOn(axios, 'post').mockResolvedValue({
      data: { code: 0, data: { accessToken: 'new-access' } },
    });

    await expect(
      client.get('/tasks', { adapter: adapter as unknown as AxiosAdapter }),
    ).resolves.toEqual({ ok: true });
    expect(post).toHaveBeenCalledWith(
      `${getApiBaseUrl()}/auth/refresh`,
      { refreshToken: 'tab-b-refresh' },
      { timeout: 10_000 },
    );
  });

  it('单飞不破坏：并发 401 只发一次 refresh（回归）', async () => {
    writePersisted({
      token: 'tab-a-access',
      refreshToken: 'tab-a-refresh',
      user: { id: 1, username: 'alice' },
    });
    // 两个并发首请求各吃一次 401，重放成功（与 client.test 去重用例同形态）
    adapter.mockImplementationOnce(failure401).mockImplementationOnce(failure401);
    const post = vi
      .spyOn(axios, 'post')
      .mockResolvedValue({ data: { code: 0, data: { accessToken: 'new-access' } } });

    const first = client.get('/tasks/1', { adapter: adapter as unknown as AxiosAdapter });
    const second = client.get('/tasks/2', { adapter: adapter as unknown as AxiosAdapter });
    await vi.advanceTimersByTimeAsync(0);
    expect(post).toHaveBeenCalledTimes(1);
    await expect(Promise.all([first, second])).resolves.toEqual([{ ok: true }, { ok: true }]);
    expect(adapter).toHaveBeenCalledTimes(4);
  });
});

// F-6（UIUX 审计 P2-5）：多标签页 refresh「互踢」残余竞态收尾——
//  ① TOCTOU：B 在 A 落盘前读走旧 RT，携已被轮换吊销的 RT 去刷新必 401；
//     此时存储 RT 已不是自己这枚 → 别人的刷新已成功，复用新 access，不登出。
//  ② 「成功刷新被守卫误杀」：refresh 在途期间 storage 事件把另一 tab 的新 RT
//     同步进内存，旧守卫会把成功结果扔掉并登出；新语义改为复用新票。
// 判据统一为「当前存储 RT 是否已不是自己那枚」，而非「自己发起时的 RT」。
describe('F-6 多标签 refresh 互踢竞态收尾', () => {
  /** 把 store/persist 置为「A/B 同持的旧会话」（两 tab 轮换前的共同起点）。 */
  const seedSharedSession = () => {
    writePersisted({ token: 'old-access', refreshToken: 'rt-old', user: { id: 1, username: 'alice' } });
    useAuthStore.getState().setAuth('old-access', 'rt-old', { id: 1, username: 'alice' });
  };
  /** 模拟 tab A 完成轮换：新会话落盘（zustand persist 的原子写入）。 */
  const aRotatesToDisk = () => {
    writePersisted({ token: 'a-access', refreshToken: 'rt-new', user: { id: 1, username: 'alice' } });
  };
  /** 模拟 storage 事件把 A 的落盘同步进本 tab（B）内存。 */
  const deliverStorageEvent = () => {
    window.dispatchEvent(
      new StorageEvent('storage', {
        key: 'autoflow-auth',
        newValue: localStorage.getItem('autoflow-auth'),
      }),
    );
  };
  const reject401 = (reject: (e: unknown) => void) => {
    reject(new AxiosError('Request failed', undefined, undefined, undefined, {
      status: 401, statusText: 'Unauthorized', headers: new AxiosHeaders(), data: { message: 'HTTP 401' },
    }));
  };

  it('TOCTOU：B 携已被轮换的旧 RT 刷新 401（storage 已同步 A 新票）→ 复用 A 的新 access，不登出', async () => {
    seedSharedSession();
    adapter.mockImplementationOnce(failure401);
    let rejectRefresh!: (e: unknown) => void;
    const post = vi.spyOn(axios, 'post').mockImplementation(
      () => new Promise((_resolve, reject) => { rejectRefresh = reject; }),
    );

    const request = client.get('/tasks', { adapter: adapter as unknown as AxiosAdapter });
    await vi.advanceTimersByTimeAsync(0);
    // B 用的是自己发起时的 rt-old（A 尚未落盘）——TOCTOU 窗口
    expect(post).toHaveBeenCalledWith(
      `${getApiBaseUrl()}/auth/refresh`, { refreshToken: 'rt-old' }, { timeout: 10_000 },
    );
    // A 完成轮换：落盘 + storage 事件同步进 B 内存；B 的 refresh 随后 401
    aRotatesToDisk();
    deliverStorageEvent();
    reject401(rejectRefresh);

    await expect(request).resolves.toEqual({ ok: true }); // 原请求携 A 的新 access 重放成功
    expect(useAuthStore.getState()).toMatchObject({ token: 'a-access', refreshToken: 'rt-new' }); // 未登出
    expect(post).toHaveBeenCalledTimes(1);
  });

  it('双标签同时过期：B 的 refresh 携旧票 401、仅落盘已换新（storage 事件未达的纯 TOCTOU 窗口）→ 仍复用新票，并发请求都重放成功且不登出', async () => {
    seedSharedSession();
    // 两个并发首请求各吃一次 401（单飞 refresh 只发一发）
    adapter.mockImplementationOnce(failure401).mockImplementationOnce(failure401);
    let rejectRefresh!: (e: unknown) => void;
    const post = vi.spyOn(axios, 'post').mockImplementation(
      () => new Promise((_resolve, reject) => { rejectRefresh = reject; }),
    );

    const first = client.get('/tasks/1', { adapter: adapter as unknown as AxiosAdapter });
    const second = client.get('/tasks/2', { adapter: adapter as unknown as AxiosAdapter });
    await vi.advanceTimersByTimeAsync(0);
    expect(post).toHaveBeenCalledTimes(1);
    // A 完成轮换：只落盘，storage 事件尚未到达 B（内存仍是 rt-old）
    aRotatesToDisk();
    reject401(rejectRefresh);

    await expect(Promise.all([first, second])).resolves.toEqual([{ ok: true }, { ok: true }]);
    expect(useAuthStore.getState()).toMatchObject({ token: 'a-access', refreshToken: 'rt-new' }); // 未登出
    expect(post).toHaveBeenCalledTimes(1); // 不补发第二发注定失败的 refresh
  });

  it('成功刷新不再被「session changed」守卫误杀：在途期间 storage 已同步 A 的新 RT → 复用 A 的新 access，A 的 RT 不被覆盖', async () => {
    seedSharedSession();
    adapter.mockImplementationOnce(failure401);
    let resolveRefresh!: (v: { data: unknown }) => void;
    const post = vi.spyOn(axios, 'post').mockImplementation(
      () => new Promise((resolve) => { resolveRefresh = resolve; }),
    );

    const request = client.get('/tasks', { adapter: adapter as unknown as AxiosAdapter });
    await vi.advanceTimersByTimeAsync(0);
    // B 的 refresh 在途期间，A 的轮换经 storage 事件同步进 B 内存（RT 已换人）
    aRotatesToDisk();
    deliverStorageEvent();
    // B 携旧票的 refresh 仍成功返回（后端宽限窗口：旧票尚未判死）
    resolveRefresh({ data: { code: 0, data: { accessToken: 'b-access', refreshToken: 'b-rt' } } });

    // 旧行为：守卫判「session changed」→ 扔掉成功结果 + 登出跳转（双 tab 全灭）
    // 新行为：复用 A 的新 access 重放；b-rt 绝不盖掉 A 较新的 rt-new
    await expect(request).resolves.toEqual({ ok: true });
    expect(useAuthStore.getState()).toMatchObject({ token: 'a-access', refreshToken: 'rt-new' });
    expect(post).toHaveBeenCalledTimes(1);
  });

  it('回归：本 tab 已登出（RT 为 null）时仍丢弃在途刷新结果，绝不把 token 写回（DR-04 语义不变）', async () => {
    seedSharedSession();
    adapter.mockImplementationOnce(failure401);
    let resolveRefresh!: (v: { data: unknown }) => void;
    const post = vi.spyOn(axios, 'post').mockImplementation(
      () => new Promise((resolve) => { resolveRefresh = resolve; }),
    );

    const request = client.get('/tasks', { adapter: adapter as unknown as AxiosAdapter });
    await vi.advanceTimersByTimeAsync(0);
    useAuthStore.getState().logout(); // 本 tab 登出（RT → null）
    resolveRefresh({ data: { code: 0, data: { accessToken: 'revoked-access', refreshToken: 'revoked-rt' } } });

    await expect(request).rejects.toBeDefined();
    expect(useAuthStore.getState()).toMatchObject({ token: null, refreshToken: null });
    expect(post).toHaveBeenCalledTimes(1);
  });
});

describe('A-4 storage 事件同步（跨标签页）', () => {
  it('另一 tab 轮换写入 → 本 tab 内存同步为新 token', () => {
    writePersisted({
      token: 'tab-a-access',
      refreshToken: 'tab-a-refresh',
      user: { id: 1, username: 'alice' },
    });
    window.dispatchEvent(
      new StorageEvent('storage', {
        key: 'autoflow-auth',
        newValue: localStorage.getItem('autoflow-auth'),
      }),
    );
    expect(useAuthStore.getState()).toMatchObject({
      token: 'tab-a-access',
      refreshToken: 'tab-a-refresh',
    });
  });

  it('另一 tab 登出（落盘全空）→ 本 tab 跟随清空内存', () => {
    writePersisted({ token: null, refreshToken: null, user: null });
    window.dispatchEvent(
      new StorageEvent('storage', {
        key: 'autoflow-auth',
        newValue: localStorage.getItem('autoflow-auth'),
      }),
    );
    expect(useAuthStore.getState()).toMatchObject({
      token: null,
      refreshToken: null,
      user: null,
    });
  });

  it('无关 key 的 storage 事件不触碰认证状态', () => {
    window.dispatchEvent(
      new StorageEvent('storage', { key: 'some-other-key', newValue: '{}' }),
    );
    expect(useAuthStore.getState()).toMatchObject({
      token: 'tab-b-access',
      refreshToken: 'tab-b-refresh',
    });
  });

  // ── F-12（UIAUDIT P3-5）：storage 同步的「user 没变不写」判据 ─────────────
  // 旧判据 `user !== persisted.user` 恒真（persisted.user 每次重新 JSON.parse，
  // 引用永不相等）→ 每次跨 tab 写入都多打一发 setUser。序列化串比较后：
  // 同一账号（同 id 同字段）不再 setUser，字段真变才写。
  it('F-12：另一 tab 写入的 user 与内存相同（串相等）→ 不再触发 setUser', () => {
    const setUserSpy = vi.spyOn(useAuthStore.getState(), 'setUser');
    writePersisted({
      token: 'tab-b-access',
      refreshToken: 'tab-b-refresh',
      user: { id: 1, username: 'alice' },
    });
    window.dispatchEvent(
      new StorageEvent('storage', {
        key: 'autoflow-auth',
        newValue: localStorage.getItem('autoflow-auth'),
      }),
    );
    expect(setUserSpy).not.toHaveBeenCalled();
    setUserSpy.mockRestore();
  });

  it('F-12：user 字段真变（同 id 换 username）→ 仍同步 setUser（幂等语义保留）', () => {
    const setUserSpy = vi.spyOn(useAuthStore.getState(), 'setUser');
    writePersisted({
      token: 'tab-b-access',
      refreshToken: 'tab-b-refresh',
      user: { id: 1, username: 'alice-renamed' },
    });
    window.dispatchEvent(
      new StorageEvent('storage', {
        key: 'autoflow-auth',
        newValue: localStorage.getItem('autoflow-auth'),
      }),
    );
    expect(setUserSpy).toHaveBeenCalledTimes(1);
    setUserSpy.mockRestore();
  });
});
