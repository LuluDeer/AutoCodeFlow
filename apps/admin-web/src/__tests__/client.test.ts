import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import axios, { AxiosError, AxiosHeaders, type AxiosAdapter } from 'axios';
import { message } from 'antd';
import { client, getApiBaseUrl } from '../api/client';
import { logoutRemote } from '../api/logout';
import { useAuthStore } from '../store/auth';

vi.mock('antd', () => ({ message: { error: vi.fn() } }));

const adapter = vi.fn<AxiosAdapter>();
const success: AxiosAdapter = async (config) => ({
  config, status: 200, statusText: 'OK', headers: new AxiosHeaders(),
  data: { code: 0, data: { ok: true } },
});
const failure = (status?: number): AxiosAdapter => async (config) => {
  throw new AxiosError('Request failed', undefined, config, undefined, status ? {
    config, status, statusText: 'Error', headers: new AxiosHeaders(),
    data: { message: `HTTP ${status}` },
  } : undefined);
};

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  useAuthStore.getState().setAuth('old-access', 'old-refresh', { id: 1, username: 'alice' });
  adapter.mockReset().mockImplementation(success);
  vi.mocked(message.error).mockClear();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  useAuthStore.getState().logout();
});

describe('DR-06 safe-method retries', () => {
  it.each(['post', 'put', 'patch', 'delete'].flatMap(method =>
    [undefined, 502, 504].map(status => ({ method, status })),
  ))('$method does not retry on $status / network failure', async ({ method, status }) => {
    adapter.mockImplementation(failure(status));
    const result = expect((client as unknown as (config: { url: string; method: string; adapter: typeof adapter }) => Promise<unknown>)({ url: '/tasks', method, adapter })).rejects.toBeDefined();
    await vi.runAllTimersAsync();
    await result;
    expect(adapter).toHaveBeenCalledTimes(1);
    expect(message.error).toHaveBeenCalledExactlyOnceWith(
      status ? `HTTP ${status}` : '网络连接失败，请检查网络或稍后重试', 4,
    );
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['get', 'head', 'options'].flatMap(method =>
    [undefined, 500, 502, 504].map(status => ({ method, status })),
  ))('$method retries $status / network failure once after 1s', async ({ method, status }) => {
    adapter.mockImplementationOnce(failure(status));
    const request = (client as unknown as (config: { url: string; method: string; adapter: typeof adapter }) => Promise<unknown>)({ url: '/tasks', method, adapter });
    await vi.advanceTimersByTimeAsync(0);
    expect(adapter).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(999);
    expect(adapter).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(request).resolves.toEqual({ ok: true });
    expect(adapter).toHaveBeenCalledTimes(2);
    expect(message.error).not.toHaveBeenCalled();
  });

  it.each([400, 403, 404, 409, 429])('GET does not retry HTTP %i', async (status) => {
    adapter.mockImplementation(failure(status));
    await expect(client.get('/tasks', { adapter })).rejects.toEqual({ message: `HTTP ${status}` });
    expect(adapter).toHaveBeenCalledTimes(1);
    expect(message.error).toHaveBeenCalledExactlyOnceWith(`HTTP ${status}`, 4);
  });

  it.each([undefined, 503])('GET stops after a second transient failure ($0)', async (status) => {
    adapter.mockImplementation(failure(status));
    const result = expect(client.get('/tasks', { adapter })).rejects.toBeDefined();
    await vi.runAllTimersAsync();
    await result;
    expect(adapter).toHaveBeenCalledTimes(2);
    expect(message.error).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('401 refresh and DR-04 logout race', () => {
  it.each(['get', 'post'])('$0 still replays after a successful 401 refresh', async (method) => {
    adapter.mockImplementationOnce(failure(401));
    const post = vi.spyOn(axios, 'post').mockResolvedValue({
      data: { code: 0, data: { accessToken: 'new-access', refreshToken: 'new-refresh' } },
    });
    await expect((client as unknown as (config: { url: string; method: string; adapter: typeof adapter }) => Promise<unknown>)({ url: '/tasks', method, adapter })).resolves.toEqual({ ok: true });
    expect(post).toHaveBeenCalledExactlyOnceWith(
      `${getApiBaseUrl()}/auth/refresh`, { refreshToken: 'old-refresh' }, { timeout: 10_000 },
    );
    expect(adapter).toHaveBeenCalledTimes(2);
    expect(adapter.mock.calls[1][0].headers.Authorization).toBe('Bearer new-access');
    expect(useAuthStore.getState()).toMatchObject({ token: 'new-access', refreshToken: 'new-refresh' });
    expect(message.error).not.toHaveBeenCalled();
  });

  it('deduplicates concurrent refreshes', async () => {
    adapter.mockImplementationOnce(failure(401)).mockImplementationOnce(failure(401));
    let resolveRefresh!: (value: { data: { accessToken: string } }) => void;
    const post = vi.spyOn(axios, 'post').mockImplementation(() => new Promise(resolve => {
      resolveRefresh = resolve;
    }));
    const first = client.get('/tasks/1', { adapter });
    const second = client.get('/tasks/2', { adapter });
    await vi.advanceTimersByTimeAsync(0);
    expect(post).toHaveBeenCalledTimes(1);
    resolveRefresh({ data: { accessToken: 'new-access' } });
    await expect(Promise.all([first, second])).resolves.toEqual([{ ok: true }, { ok: true }]);
    expect(adapter).toHaveBeenCalledTimes(4);
  });

  it('does not restore tokens when an in-flight refresh resolves after remote logout', async () => {
    adapter.mockImplementationOnce(failure(401));
    let resolveRefresh!: (value: { data: { accessToken: string; refreshToken: string } }) => void;
    const post = vi.spyOn(axios, 'post')
      .mockImplementationOnce(() => new Promise(resolve => { resolveRefresh = resolve; }))
      .mockResolvedValueOnce({ data: { success: true } });
    const result = expect(client.get('/tasks', { adapter })).rejects.toEqual({ message: 'HTTP 401' });
    await vi.advanceTimersByTimeAsync(0);
    expect(post).toHaveBeenCalledTimes(1);
    await logoutRemote();
    const setToken = vi.spyOn(useAuthStore.getState(), 'setToken');
    const setRefreshToken = vi.spyOn(useAuthStore.getState(), 'setRefreshToken');
    resolveRefresh({ data: { accessToken: 'revoked-access', refreshToken: 'revoked-refresh' } });
    await result;
    expect(setToken).not.toHaveBeenCalled();
    expect(setRefreshToken).not.toHaveBeenCalled();
    expect(useAuthStore.getState()).toMatchObject({ token: null, refreshToken: null, user: null });
    expect(JSON.parse(localStorage.getItem('autoflow-auth')!).state).toEqual({
      token: null, refreshToken: null, user: null,
    });
    expect(adapter).toHaveBeenCalledTimes(1);
    expect(post.mock.calls.map(([url]) => url)).toEqual([
      `${getApiBaseUrl()}/auth/refresh`, `${getApiBaseUrl()}/auth/logout`,
    ]);
  });
});
