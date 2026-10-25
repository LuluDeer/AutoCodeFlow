import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import axios, { AxiosError, AxiosHeaders, CanceledError, type AxiosAdapter } from 'axios';
import { message } from 'antd';
import { client, getApiBaseUrl, __resetToastDedupe } from '../api/client';
import { logoutRemote } from '../api/logout';
import { useAuthStore } from '../store/auth';
import { setLanguage } from '../i18n';

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
  // TOAST-DEDUPE 的窗口是模块级状态，且本文件用 fake timers（Date.now 冻结）
  // ——不清空的话，上一用例弹过的同文案会抑制下一用例（跨用例假阴性）。
  __resetToastDedupe();
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
    // F-41：500 从重试面移除（应用层确定性故障不重试）——只保留网络失败与
    // 网关类暂态 5xx（502/503/504）。
    [undefined, 502, 503, 504].map(status => ({ method, status })),
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

  // F-41：500 是应用层确定性故障（如深链坏 id 的 DB cast），重试零收益纯翻倍
  // 请求与 toast——移出重试面；429 是限流信号，尊重之。两者都不重试。
  it.each([400, 403, 404, 409, 429, 500])('GET does not retry HTTP %i', async (status) => {
    adapter.mockImplementation(failure(status));
    // DUP-TOAST：拦截器对这些状态码弹过 toast，reject 值带 __toastedByClient
    // 标——页面 catch 的 showApiError 兜底据此去重，不再二次弹错。
    // P1-3：reject 值同时带数字型 __status（HTTP 状态码），utils/error 的
    // isNotFoundError 据此判定 404（拦截器已剥掉 err.response，原路径恒 false）。
    await expect(client.get('/tasks', { adapter })).rejects.toEqual({ message: `HTTP ${status}`, __toastedByClient: true, __status: status });
    expect(adapter).toHaveBeenCalledTimes(1);
    expect(message.error).toHaveBeenCalledExactlyOnceWith(`HTTP ${status}`, 4);
  });

  it('P1-3: 404 的 reject 值带 __status=404，isNotFoundError 据此恢复生效', async () => {
    adapter.mockImplementation(failure(404));
    const rejected: unknown = await client.get('/tasks', { adapter }).then(
      () => { throw new Error('should reject'); },
      (err: unknown) => err,
    );
    expect((rejected as { __status?: unknown }).__status).toBe(404);
  });

  it('P1-3: 响应体为字符串原语时 __status 挂不上，reject 原样返回字符串', async () => {
    adapter.mockImplementation(async (config) => {
      throw new AxiosError('Request failed', undefined, config, undefined, {
        config, status: 404, statusText: 'Not Found', headers: new AxiosHeaders(),
        data: 'not found',
      });
    });
    await expect(client.get('/tasks', { adapter })).rejects.toBe('not found');
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

describe('TOAST-I18N: 框架样板文案不得盖掉 i18n 文案（2026-10-13 生产报障）', () => {
  /** 构造带指定响应体的失败（模拟 NestJS 的 message 形态）。 */
  const failWithBody = (status: number, data: unknown): AxiosAdapter => async (config) => {
    throw new AxiosError('Request failed', undefined, config, undefined, {
      config, status, statusText: 'Error', headers: new AxiosHeaders(), data,
    });
  };

  it('ThrottlerException: Too Many Requests → 走 i18n，而不是裸英文原文', async () => {
    // 用户报障现场的原句（NestJS ThrottlerException 的 message）。
    adapter.mockImplementation(failWithBody(429, { message: 'ThrottlerException: Too Many Requests' }));
    await expect(client.get('/tasks', { adapter })).rejects.toBeDefined();
    // 反证：若不过滤框架文案，这里会是 'ThrottlerException: Too Many Requests'
    // （i18n 的 http.error.429 恒被跳过，是死配置）。
    expect(message.error).toHaveBeenCalledExactlyOnceWith('操作过于频繁，请稍后再试', 4);
  });

  it('纯状态名（Too Many Requests / Forbidden）同样回落 i18n', async () => {
    adapter.mockImplementation(failWithBody(429, { message: 'Too Many Requests' }));
    await expect(client.get('/tasks', { adapter })).rejects.toBeDefined();
    expect(message.error).toHaveBeenCalledExactlyOnceWith('操作过于频繁，请稍后再试', 4);

    __resetToastDedupe();
    vi.mocked(message.error).mockClear();
    adapter.mockImplementation(failWithBody(403, { message: 'Forbidden resource' }));
    await expect(client.get('/tasks', { adapter })).rejects.toBeDefined();
    expect(message.error).toHaveBeenCalledExactlyOnceWith('没有操作权限', 4);
  });

  it('业务文案仍然优先（不得因为过滤框架文案而吃掉中文描述）', async () => {
    adapter.mockImplementation(failWithBody(409, { message: '该应用正在部署中，请先停止' }));
    await expect(client.get('/tasks', { adapter })).rejects.toBeDefined();
    expect(message.error).toHaveBeenCalledExactlyOnceWith('该应用正在部署中，请先停止', 4);
  });

  it('message 为字符串数组（ValidationPipe 原始形态）时拼接展示，不整段丢弃', async () => {
    adapter.mockImplementation(failWithBody(400, { message: ['name 不能为空', 'runtime 非法'] }));
    await expect(client.get('/tasks', { adapter })).rejects.toBeDefined();
    expect(message.error).toHaveBeenCalledExactlyOnceWith('name 不能为空; runtime 非法', 4);
  });

  it('框架样板 message 但 error 字段是业务文案时，用 error 字段', async () => {
    // 用 409 而非 500：5xx 对安全方法是**可重试**的（拦截器 sleep 1s 后再发），
    // 在 fake timers 下不推进定时器会挂到用例超时——与本用例要验的语义无关。
    adapter.mockImplementation(failWithBody(409, { message: 'Conflict', error: '执行器连接失败' }));
    await expect(client.get('/tasks', { adapter })).rejects.toBeDefined();
    expect(message.error).toHaveBeenCalledExactlyOnceWith('执行器连接失败', 4);
  });
});

describe('TOAST-DEDUPE: 并发扇出的同文案只弹一条（2026-10-13 生产报障）', () => {
  it('26 个并发 429（同一文案）→ 只弹 1 条，且每条都打了 __toastedByClient 标', async () => {
    // 复现现场：应用列表页 26 个并发请求同时被限流。
    adapter.mockImplementation(failure(429));
    const reqs = Array.from({ length: 26 }, (_, i) =>
      client.get(`/app-deployments?applicationId=app-${i}`, { adapter }).catch((e) => e),
    );
    const rejected = await Promise.all(reqs);

    // 反证：修复前是 26 条一模一样的 toast（用户看到的"非常多"）。
    expect(message.error).toHaveBeenCalledTimes(1);
    // 全部 26 个 reject 值仍须打标——否则页面 catch 的 showApiError 兜底会把
    // 被抑制的 25 条补弹回来，去重形同虚设。
    expect(rejected).toHaveLength(26);
    for (const r of rejected) {
      expect((r as Record<string, unknown>)['__toastedByClient']).toBe(true);
    }
  });

  it('不同文案不受去重影响（各自照常弹）', async () => {
    adapter.mockImplementation(failure(403));
    await expect(client.get('/a', { adapter })).rejects.toBeDefined();
    adapter.mockImplementation(failure(404));
    await expect(client.get('/b', { adapter })).rejects.toBeDefined();
    expect(message.error).toHaveBeenCalledTimes(2);
  });

  it('超出窗口后同文案可再次弹出（不永久静音）', async () => {
    adapter.mockImplementation(failure(429));
    await expect(client.get('/a', { adapter })).rejects.toBeDefined();
    expect(message.error).toHaveBeenCalledTimes(1);

    // 推进超过去重窗口（1500ms）
    await vi.advanceTimersByTimeAsync(1600);

    adapter.mockImplementation(failure(429));
    await expect(client.get('/b', { adapter })).rejects.toBeDefined();
    expect(message.error).toHaveBeenCalledTimes(2);
  });
});

describe('NETOPT-7① canceled requests bypass retry and toast', () => {
  // 主动取消的两种真实形态：
  // - CancelToken/CanceledError（axios 自有取消、dispatchRequest 预检 abort）
  // - AbortController 在传输层 abort 时 xhr adapter 抛的 AxiosError{code:'ERR_CANCELED'}
  it.each([
    ['CanceledError', (config: Parameters<AxiosAdapter>[0]) => new CanceledError('canceled', config)],
    ['AxiosError{ERR_CANCELED}', (config: Parameters<AxiosAdapter>[0]) => new AxiosError('canceled', AxiosError.ERR_CANCELED, config)],
  ])('%s (with config) is rejected as-is: no retry, no toast, no leftover timer', async (_name, makeErr) => {
    adapter.mockImplementation(async (config) => { throw makeErr(config); });
    const result = expect(client.get('/tasks', { adapter })).rejects.toThrow();
    await vi.runAllTimersAsync();
    await result;
    expect(adapter).toHaveBeenCalledTimes(1);
    expect(message.error).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('CanceledError without config (pre-dispatch abort) rejects the cancel, not a TypeError', async () => {
    const canceledErr = new CanceledError('canceled');
    adapter.mockImplementation(async () => { throw canceledErr; });
    const result = expect(client.get('/tasks', { adapter })).rejects.toBe(canceledErr);
    await vi.runAllTimersAsync();
    await result;
    expect(adapter).toHaveBeenCalledTimes(1);
    expect(message.error).not.toHaveBeenCalled();
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
    const result = expect(client.get('/tasks', { adapter })).rejects.toEqual({ message: 'HTTP 401', __status: 401 });
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

// LANG-ERR-01（2026-10-20）：拦截器 toast 必须**先按 errorCode 翻译**再回落服务端
// message。这是前端使用率最高的一条失败出口（403/404/409/429/5xx 全在这里弹，
// 且弹完就打 __toastedByClient 标抑制页面兜底），此前它把单语言的服务端中文 message
// 排在 i18n 之前 —— 英文界面的用户在所有 4xx/5xx 上都拿到中文，而页面 catch 里
// 那条**会**按码翻译的 showApiError 又被去重标记跳过，等于整条码化在这条路径上被绕过。
describe('LANG-ERR-01: 拦截器 toast 按 errorCode 本地化', () => {
  const failWithBody = (status: number, data: unknown): AxiosAdapter => async (config) => {
    throw new AxiosError('Request failed', undefined, config, undefined, {
      config, status, statusText: 'Error', headers: new AxiosHeaders(), data,
    });
  };

  afterEach(async () => {
    // 用**产品真实切换路径** setLanguage：en 语言包是按需 import 的（i18n 启动时
    // 只在检测到 en 才加载），直接调 i18n.changeLanguage('en') 会因缺 en 资源
    // 而回落到 fallbackLng=zh —— 那样测出来的就不是用户实际看到的语言。
    await setLanguage('zh');
  });

  it('英文界面 + 有 errorCode → 英文文案（不是服务端中文 message）', async () => {
    await setLanguage('en');
    adapter.mockImplementation(
      failWithBody(404, {
        errorCode: 'TASK_NOT_FOUND',
        params: { taskId: 't-42' },
        message: '任务 t-42 不存在',
      }),
    );
    await expect(client.get('/tasks/t-42', { adapter })).rejects.toBeDefined();
    // 反证：把 translateByErrorCode 从拦截器里去掉 → 这里会变成「任务 t-42 不存在」
    expect(message.error).toHaveBeenCalledExactlyOnceWith('Task t-42 not found', 4);
  });

  it('中文界面 + 有 errorCode → 中文词条（插值生效），与服务端 message 无关', async () => {
    await setLanguage('zh');
    adapter.mockImplementation(
      failWithBody(404, {
        errorCode: 'TASK_NOT_FOUND',
        params: { taskId: 't-7' },
        message: 'SERVER-SIDE-RAW-MESSAGE',
      }),
    );
    await expect(client.get('/tasks/t-7', { adapter })).rejects.toBeDefined();
    const shown = vi.mocked(message.error).mock.calls[0][0] as string;
    expect(shown).toContain('t-7');
    expect(shown).not.toContain('SERVER-SIDE-RAW-MESSAGE');
  });

  it('有码但字典没有该码 → 回落服务端 message，绝不渲染裸码', async () => {
    adapter.mockImplementation(
      failWithBody(409, { errorCode: 'FUTURE_CODE_NOT_SHIPPED_YET', message: '未来的新码' }),
    );
    await expect(client.get('/tasks', { adapter })).rejects.toBeDefined();
    const shown = vi.mocked(message.error).mock.calls[0][0] as string;
    expect(shown).toBe('未来的新码');
    expect(shown).not.toContain('err.');
  });

  it('无码（老后端）→ 业务 message 仍然优先（既有行为不被本修复改变）', async () => {
    adapter.mockImplementation(failWithBody(409, { message: '该应用正在部署中，请先停止' }));
    await expect(client.get('/tasks', { adapter })).rejects.toBeDefined();
    expect(message.error).toHaveBeenCalledExactlyOnceWith('该应用正在部署中，请先停止', 4);
  });
});
