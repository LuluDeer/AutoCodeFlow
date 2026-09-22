import axios from 'axios';
import {
  failover,
  getAllAdminUrls,
  getCurrentAdminUrl,
  initAdminClients,
  checkAdminApiConnectivity,
  post,
  postLong,
  postWithStaticToken,
  request,
} from './admin-client';
import { getCurrentToken, getStaticToken, forceTokenRefresh } from './middleware/auth';

// O-23（共享 axios 实例）：admin-client 在模块加载时创建一次共享 client
// （keepAlive agent），请求参数（url/timeout/headers）在每次 request 调用时
// 传入。因此 mock 面从「每次 axios.create 返回新 client」改为「create 恒定
// 返回同一个 mock client」，测试直接驱动 mockClient.request / mockClient.get，
// 并断言 request 的入参形状（url 已拼 baseURL、timeout、headers）。
//
// 时序约束：jest.mock 工厂被提升到文件顶部、先于本文件任何 const 执行，而
// admin-client 在 import 时就调用 axios.create()——所以 mock client 必须在
// 工厂内部创建，再通过 __client 通道暴露给测试（工厂闭包引用外层 const 会
// 撞 TDZ / 未初始化）。
jest.mock('axios', () => {
  const client = { request: jest.fn(), get: jest.fn() };
  return {
    __client: client,
    create: jest.fn(() => client),
    get: jest.fn(),
  };
});
// 工厂内实例 = 模块加载时 admin-client 拿到的那个（跨测试稳定）。
type MockAxiosClient = { request: jest.Mock; get: jest.Mock };
const mockedAxios = axios as unknown as { __client: MockAxiosClient };
const clientUnderTest = mockedAxios.__client;
jest.mock('./middleware/auth', () => ({
  getCurrentToken: jest.fn(),
  getStaticToken: jest.fn(),
  // R10: admin-client's 401 self-heal calls this; the real implementation
  // would hit POST /token over the (also mocked) axios default — keep it a
  // pure mock so each test decides what the refresh yields.
  forceTokenRefresh: jest.fn(),
}));
jest.mock('./logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
  },
}));

const mockedGetCurrentToken = getCurrentToken as jest.MockedFunction<typeof getCurrentToken>;
const mockedGetStaticToken = getStaticToken as jest.MockedFunction<typeof getStaticToken>;
const mockedForceTokenRefresh = forceTokenRefresh as jest.MockedFunction<typeof forceTokenRefresh>;

/** Shape of the error axios throws for an HTTP 401 ANSWER (as opposed to a
 *  connect/timeout failure, which carries no `response`). */
const unauthorized401 = () => ({
  message: 'Request failed with status code 401',
  response: { status: 401 },
});

describe('admin-client', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // 共享 client 的实现队列跨测试必须清空（clearAllMocks 只清调用记录）。
    clientUnderTest.request.mockReset();
    clientUnderTest.get.mockReset();
    mockedGetCurrentToken.mockResolvedValue(null);
    mockedGetStaticToken.mockReturnValue(null);
    mockedForceTokenRefresh.mockResolvedValue(null);
    initAdminClients(['http://admin-a:3105']);
  });

  it('trims configured admin URLs and exposes a defensive copy', () => {
    initAdminClients([' http://admin-a:3105 ', '', ' http://admin-b:3105 ']);

    const urls = getAllAdminUrls();
    urls.push('http://mutated:3105');

    expect(getAllAdminUrls()).toEqual([
      'http://admin-a:3105',
      'http://admin-b:3105',
    ]);
    expect(getCurrentAdminUrl()).toBe('http://admin-a:3105');
  });

  it('throws when no usable admin URLs are configured', () => {
    expect(() => initAdminClients(['', '   '])).toThrow('No admin URLs configured');
  });

  it('normalizes configured /api admin URLs to service roots', () => {
    initAdminClients([' http://admin-a:3105/api/ ', 'http://admin-b:3105/api']);

    expect(getAllAdminUrls()).toEqual([
      'http://admin-a:3105',
      'http://admin-b:3105',
    ]);
    expect(getCurrentAdminUrl()).toBe('http://admin-a:3105');
  });

  it('resets current admin URL when reinitialized after failover', () => {
    initAdminClients(['http://admin-a:3105', 'http://admin-b:3105']);
    failover();
    expect(getCurrentAdminUrl()).toBe('http://admin-b:3105');

    initAdminClients(['http://admin-c:3105']);

    expect(getCurrentAdminUrl()).toBe('http://admin-c:3105');
  });

  it('sends auth headers when a token is available', async () => {
    clientUnderTest.request.mockResolvedValue({ data: { ok: true } });
    mockedGetCurrentToken.mockResolvedValue('secret-token');
    initAdminClients(['http://admin-a:3105/api']);

    await post('/api/test', { hello: 'world' });

    // O-23：共享实例——baseURL 拼进 url，timeout/headers 作为请求参数传入
    // NETOPT-G P1-4：默认超时 10s → 20s（跨境链路长尾，见 admin-client.ts
    // DEFAULT_TIMEOUT_MS 注释）。
    expect(clientUnderTest.request).toHaveBeenCalledWith({
      method: 'post',
      url: 'http://admin-a:3105/api/test',
      data: { hello: 'world' },
      timeout: 20_000,
      headers: {
        'Content-Type': 'application/json',
        'X-Executor-Token': 'secret-token',
        Authorization: 'Bearer secret-token',
      },
    });
  });

  it('fails over and retries the next admin URL', async () => {
    clientUnderTest.request
      .mockRejectedValueOnce(new Error('down'))
      .mockResolvedValueOnce({ data: { ok: true } });
    initAdminClients(['http://admin-a:3105', 'http://admin-b:3105']);

    const result = await request('get', '/api/health');

    expect(result.data).toEqual({ ok: true });
    expect(clientUnderTest.request.mock.calls[0][0]).toEqual(
      expect.objectContaining({ url: 'http://admin-a:3105/api/health' }),
    );
    expect(clientUnderTest.request.mock.calls[1][0]).toEqual(
      expect.objectContaining({ url: 'http://admin-b:3105/api/health' }),
    );
    expect(getCurrentAdminUrl()).toBe('http://admin-b:3105');
  });

  it('throws after all configured admins fail', async () => {
    clientUnderTest.request.mockRejectedValue(new Error('down'));
    initAdminClients(['http://admin-a:3105', 'http://admin-b:3105']);

    await expect(request('get', '/api/health')).rejects.toThrow(
      'All 2 admin servers are unavailable',
    );
  });

  it('returns true and selects the reachable admin during startup self-check', async () => {
    clientUnderTest.get
      .mockRejectedValueOnce(new Error('down'))
      .mockResolvedValueOnce({ data: { status: 'ok' } });
    initAdminClients(['http://admin-a:3105', 'http://admin-b:3105']);

    const ok = await checkAdminApiConnectivity({ attempts: 1 });

    expect(ok).toBe(true);
    expect(clientUnderTest.get).toHaveBeenNthCalledWith(1, 'http://admin-a:3105/api/health', { timeout: 5_000 });
    expect(clientUnderTest.get).toHaveBeenNthCalledWith(2, 'http://admin-b:3105/api/health', { timeout: 5_000 });
    expect(getCurrentAdminUrl()).toBe('http://admin-b:3105');
  });

  it('returns false after startup self-check retries are exhausted', async () => {
    clientUnderTest.get.mockRejectedValue(new Error('down'));
    initAdminClients(['http://admin-a:3105']);

    const ok = await checkAdminApiConnectivity({ attempts: 1 });

    expect(ok).toBe(false);
  });

  // R10 (round-10 gap #3): stale-credential self-heal. After an admin-UI
  // rotate-token the executor's bearer (and its adopted tokenHash, via the
  // refresh response) are stale; the next 401 must trigger an immediate
  // forceTokenRefresh + single retry instead of 30 minutes of failing
  // heartbeats/callbacks.
  describe('401 stale-credential self-heal (R10)', () => {
    it('re-authenticates and retries once when admin rejects the dynamic token with 401', async () => {
      clientUnderTest.request
        .mockRejectedValueOnce(unauthorized401())
        .mockResolvedValueOnce({ data: { ok: true } });
      mockedGetCurrentToken.mockResolvedValueOnce('old-token');
      // fetchToken adopts BOTH the new bearer and the new tokenHash; here we
      // only assert the bearer reaches the retry (hash adoption is covered
      // in middleware/auth.spec.ts).
      mockedForceTokenRefresh.mockResolvedValue('new-token');

      const result = await post('/api/executors/heartbeat', { address: 'a:1' });

      expect(result.data).toEqual({ ok: true });
      expect(mockedForceTokenRefresh).toHaveBeenCalledTimes(1);
      expect(clientUnderTest.request.mock.calls[0][0]).toEqual(
        expect.objectContaining({
          headers: expect.objectContaining({ Authorization: 'Bearer old-token' }),
        }),
      );
      expect(clientUnderTest.request.mock.calls[1][0]).toEqual(
        expect.objectContaining({
          headers: expect.objectContaining({
            'X-Executor-Token': 'new-token',
            Authorization: 'Bearer new-token',
          }),
        }),
      );
    });

    it('does not fail over to another admin on 401 and gives up when the refresh yields no new token', async () => {
      clientUnderTest.request.mockRejectedValue(unauthorized401());
      mockedGetCurrentToken.mockResolvedValue('stale-token');
      // Shared token also rejected (or backoff active) → refresh returns the
      // same token → retrying would just 401 again, so the original error
      // must propagate after exactly one attempt on the FIRST admin URL.
      mockedForceTokenRefresh.mockResolvedValue('stale-token');
      initAdminClients(['http://admin-a:3105', 'http://admin-b:3105']);

      await expect(post('/api/executors/heartbeat', {})).rejects.toMatchObject({
        response: { status: 401 },
      });
      expect(clientUnderTest.request).toHaveBeenCalledTimes(1);
      expect(getCurrentAdminUrl()).toBe('http://admin-a:3105');
    });

    it('retries at most once on auth failure — a second 401 propagates (no retry storm)', async () => {
      clientUnderTest.request.mockRejectedValue(unauthorized401());
      mockedGetCurrentToken.mockResolvedValue('old-token');
      mockedForceTokenRefresh.mockResolvedValue('new-token');

      await expect(post('/api/executions/callback', [])).rejects.toMatchObject({
        response: { status: 401 },
      });
      expect(clientUnderTest.request).toHaveBeenCalledTimes(2);
      expect(mockedForceTokenRefresh).toHaveBeenCalledTimes(1);
    });

    it('never triggers the dynamic re-auth path for static-token requests (register)', async () => {
      clientUnderTest.request.mockRejectedValue(unauthorized401());
      mockedGetStaticToken.mockReturnValue('shared-token');

      await expect(
        postWithStaticToken('/api/executors/register', { address: 'a:1' }),
      ).rejects.toMatchObject({ response: { status: 401 } });
      expect(mockedForceTokenRefresh).not.toHaveBeenCalled();
      expect(mockedGetCurrentToken).not.toHaveBeenCalled();
      expect(clientUnderTest.request).toHaveBeenCalledTimes(1);
    });

    it('keeps the failover loop for non-401 transport errors', async () => {
      clientUnderTest.request
        .mockRejectedValueOnce(new Error('down'))
        .mockResolvedValueOnce({ data: { ok: true } });
      initAdminClients(['http://admin-a:3105', 'http://admin-b:3105']);

      const result = await request('get', '/api/health');

      expect(result.data).toEqual({ ok: true });
      expect(mockedForceTokenRefresh).not.toHaveBeenCalled();
    });
  });

  // E-07 残差收口：停机时 abort 在飞长轮询——取消是「调用方主动中止」，不是
  // 连通性故障：不得 failover 到下一个 admin（同一个已 aborted 的 signal 会立刻
  // 再拒一次，白烧 500ms 退避 ×N），error 原样上抛由调用方按预期中止处理。
  describe('request cancellation (E-07)', () => {
    it('passes the caller signal through to axios and short-circuits on abort', async () => {
      const controller = new AbortController();
      clientUnderTest.request.mockImplementation((cfg: { signal?: AbortSignal }) => {
        expect(cfg.signal).toBe(controller.signal);
        controller.abort();
        return Promise.reject(Object.assign(new Error('canceled'), { code: 'ERR_CANCELED' }));
      });
      initAdminClients(['http://admin-a:3105', 'http://admin-b:3105']);

      await expect(
        request('post', '/api/executors/pull', { waitMs: 25_000 }, 2, 'current', undefined, 40_000, controller.signal),
      ).rejects.toThrow('canceled');

      // 只在第一个 admin 上试过一次：未 failover、未重试
      expect(clientUnderTest.request).toHaveBeenCalledTimes(1);
      expect(getCurrentAdminUrl()).toBe('http://admin-a:3105');
      expect(mockedForceTokenRefresh).not.toHaveBeenCalled();
    });

    it('postLong forwards the signal with the 40s long-poll timeout', async () => {
      const controller = new AbortController();
      clientUnderTest.request.mockResolvedValue({ data: { ok: true } });
      initAdminClients(['http://admin-a:3105']);

      await postLong('/api/executors/pull', { waitMs: 25_000 }, 40_000, controller.signal);

      expect(clientUnderTest.request).toHaveBeenCalledWith(
        expect.objectContaining({ timeout: 40_000 }),
      );
      expect(clientUnderTest.request).toHaveBeenCalledWith(
        expect.objectContaining({ signal: controller.signal }),
      );
    });

    it('omits the signal from the request config when the caller passes none', async () => {
      clientUnderTest.request.mockResolvedValue({ data: { ok: true } });
      initAdminClients(['http://admin-a:3105']);

      await post('/api/test');

      // 其余调用的请求形状逐字节不变（无 signal 键）
      expect(clientUnderTest.request).toHaveBeenCalledWith({
        method: 'post',
        url: 'http://admin-a:3105/api/test',
        data: undefined,
        timeout: 20_000,
        headers: expect.any(Object),
      });
    });
  });

  // NETOPT-G P1（跨境链路韧性）：单 admin 部署下 retryCount = adminUrls.length
  // = 1，旧实现"一次抖动即失败"。生产实测 4.5%（80/1759）心跳因此失败，而中台
  // 90s 判死 → 执行器被置 OFFLINE → dispatch() 只选 ONLINE → 手动触发无响应。
  describe('single-admin retry floor (NETOPT-G P1)', () => {
    it('retries a transient transport failure on the ONLY admin instead of failing immediately', async () => {
      clientUnderTest.request
        .mockRejectedValueOnce(new Error('socket hang up'))
        .mockResolvedValueOnce({ data: { ok: true } });
      initAdminClients(['http://admin-a:3105']);

      const result = await post('/api/executors/heartbeat', { address: 'a:1' });

      expect(result.data).toEqual({ ok: true });
      // 同一台被重试（而非 failover —— 只有一台）
      expect(clientUnderTest.request).toHaveBeenCalledTimes(2);
      expect(getCurrentAdminUrl()).toBe('http://admin-a:3105');
      expect(clientUnderTest.request.mock.calls[1][0]).toEqual(
        expect.objectContaining({ url: 'http://admin-a:3105/api/executors/heartbeat' }),
      );
    });

    it('gives up after exactly MIN_ATTEMPTS when the only admin stays down', async () => {
      clientUnderTest.request.mockRejectedValue(new Error('socket hang up'));
      initAdminClients(['http://admin-a:3105']);

      await expect(post('/api/executors/heartbeat', {})).rejects.toThrow(
        'All 1 admin servers are unavailable',
      );
      // 下限 3：既不无限重试，也不"一次即弃"
      expect(clientUnderTest.request).toHaveBeenCalledTimes(3);
    });

    it('retries transient 5xx (admin-api app-layer faults) but not 4xx', async () => {
      clientUnderTest.request
        .mockRejectedValueOnce({ message: 'Request failed with status code 502', response: { status: 502 } })
        .mockResolvedValueOnce({ data: { ok: true } });
      initAdminClients(['http://admin-a:3105']);

      const ok = await post('/api/executors/pull', {});
      expect(ok.data).toEqual({ ok: true });
      expect(clientUnderTest.request).toHaveBeenCalledTimes(2);
    });

    it('surfaces a 4xx verdict instead of masking it as "servers unavailable"', async () => {
      // 4xx 是确定性拒绝：不重试，且必须把真实状态码上抛——旧实现吞成
      // "All 1 admin servers are unavailable"，排障时被误导去查网络。
      clientUnderTest.request.mockRejectedValue({
        message: 'Request failed with status code 400',
        response: { status: 400 },
      });
      initAdminClients(['http://admin-a:3105']);

      await expect(post('/api/executors/pull', {})).rejects.toMatchObject({
        response: { status: 400 },
      });
      expect(clientUnderTest.request).toHaveBeenCalledTimes(1);
    });

    it('surfaces the final 5xx status once retries are exhausted', async () => {
      clientUnderTest.request.mockRejectedValue({
        message: 'Request failed with status code 500',
        response: { status: 500 },
      });
      initAdminClients(['http://admin-a:3105']);

      await expect(post('/api/executors/pull', {})).rejects.toMatchObject({
        response: { status: 500 },
      });
      expect(clientUnderTest.request).toHaveBeenCalledTimes(3);
    });

    it('keeps "one attempt per replica" semantics for multi-admin fleets', async () => {
      clientUnderTest.request.mockRejectedValue(new Error('down'));
      initAdminClients(['http://admin-a:3105', 'http://admin-b:3105']);

      await expect(request('get', '/api/health')).rejects.toThrow(
        'All 2 admin servers are unavailable',
      );
      // HA 语义不变：每台恰好试一次（2 台就是 2 次，不得因重试下限变成 3 次）
      expect(clientUnderTest.request).toHaveBeenCalledTimes(2);
    });
  });
});
