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
});
