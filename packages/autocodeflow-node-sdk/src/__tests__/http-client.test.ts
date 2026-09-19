import axios from 'axios';
import {
  CircuitBreaker,
  CircuitBreakerOpenError,
  HttpClient,
  isRetryableError,
  parseRetryAfterHeader,
  stripTrailingApiSuffix,
} from '../http-client';

jest.mock('axios');

const mockedAxios = axios as jest.Mocked<typeof axios>;

describe('HttpClient', () => {
  const BASE_URL = 'http://api.example.com';
  const TOKEN = 'test-token';
  const TRACE_ID = 'trace-123';

  let mockInstance: {
    get: jest.Mock;
    post: jest.Mock;
    put: jest.Mock;
    delete: jest.Mock;
    interceptors: {
      request: { use: jest.Mock };
      response: { use: jest.Mock };
    };
  };

  beforeEach(() => {
    mockInstance = {
      get: jest.fn(),
      post: jest.fn(),
      put: jest.fn(),
      delete: jest.fn(),
      interceptors: { request: { use: jest.fn() }, response: { use: jest.fn() } },
    };
    mockedAxios.create.mockReturnValue(mockInstance as any);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('constructor', () => {
    it('creates an axios instance with the given baseURL', () => {
      new HttpClient(BASE_URL, TOKEN);
      // 10s 默认超时对齐 python SDK（callback.py），防 admin-api 挂起拖死任务进程
      expect(mockedAxios.create).toHaveBeenCalledWith({ baseURL: BASE_URL, timeout: 10_000 });
    });

    it('registers a request interceptor', () => {
      new HttpClient(BASE_URL, TOKEN);
      expect(mockInstance.interceptors.request.use).toHaveBeenCalledTimes(1);
    });

    it('accepts an optional traceId', () => {
      expect(() => new HttpClient(BASE_URL, TOKEN, TRACE_ID)).not.toThrow();
    });
  });

  /**
   * SDK-BASE-01（本轮审计）：请求路径是绝对的 `/api/executions/callback`，
   * axios 对 baseURL 与绝对路径做简单串接——base 若已带 `/api` 就会变成
   * `/api/api/...` → 404，回调通道整体失联且无任何诊断。python SDK 早已容忍
   * 这种 base（callback.py 的 endswith("/api") 分支），本包此前漏了。
   */
  describe('base URL /api dedupe (SDK-BASE-01)', () => {
    it('strips a trailing /api so the callback path is not doubled', () => {
      expect(stripTrailingApiSuffix('http://host:3105/api')).toBe('http://host:3105');
      expect(stripTrailingApiSuffix('http://host:3105/api/')).toBe('http://host:3105');
    });

    it('collapses repeated /api segments', () => {
      expect(stripTrailingApiSuffix('http://host:3105/api/api/')).toBe('http://host:3105');
    });

    it('leaves a clean base untouched', () => {
      expect(stripTrailingApiSuffix('http://host:3105')).toBe('http://host:3105');
      expect(stripTrailingApiSuffix('http://host:3105/')).toBe('http://host:3105');
      expect(stripTrailingApiSuffix('http://host:3105/base')).toBe('http://host:3105/base');
    });

    it('does not mangle a path that merely starts with "api"', () => {
      // /apiary 不是 /api 段，必须原样保留
      expect(stripTrailingApiSuffix('http://host:3105/apiary')).toBe('http://host:3105/apiary');
      expect(stripTrailingApiSuffix('http://host:3105/apix')).toBe('http://host:3105/apix');
    });

    it('passes undefined/empty through unchanged', () => {
      expect(stripTrailingApiSuffix(undefined)).toBeUndefined();
      expect(stripTrailingApiSuffix('')).toBe('');
    });

    it('the constructed client uses the deduped base URL', () => {
      new HttpClient('http://host:3105/api', TOKEN);
      expect(mockedAxios.create).toHaveBeenCalledWith({
        baseURL: 'http://host:3105',
        timeout: 10_000,
      });
    });

    it('a buggy (undeduped) base really would double the prefix — regression proof', () => {
      // 本文件的 axios 是 mock，故用真实实现复现拼接语义：
      // axios 对 baseURL + 绝对 url 做简单串接（不辨别 url 已带 /api）。
      const realAxios = jest.requireActual<typeof import('axios')>('axios').default;
      const buggy = realAxios.create({ baseURL: 'http://host:3105/api' });
      expect(buggy.getUri({ url: '/api/executions/callback' })).toBe(
        'http://host:3105/api/api/executions/callback',
      );
      // 经收敛后的 base 拼出来是正确的
      const fixed = realAxios.create({
        baseURL: stripTrailingApiSuffix('http://host:3105/api'),
      });
      expect(fixed.getUri({ url: '/api/executions/callback' })).toBe(
        'http://host:3105/api/executions/callback',
      );
    });
  });

  describe('interceptor behaviour', () => {
    it('attaches Authorization header to requests', () => {
      new HttpClient(BASE_URL, TOKEN);
      const interceptorFn = mockInstance.interceptors.request.use.mock.calls[0][0];
      const config = { headers: {} } as any;
      const result = interceptorFn(config);
      expect(result.headers['Authorization']).toBe(`Bearer ${TOKEN}`);
    });

    it('attaches X-Trace-Id when traceId is provided', () => {
      new HttpClient(BASE_URL, TOKEN, TRACE_ID);
      const interceptorFn = mockInstance.interceptors.request.use.mock.calls[0][0];
      const config = { headers: {} } as any;
      const result = interceptorFn(config);
      expect(result.headers['X-Trace-Id']).toBe(TRACE_ID);
    });

    it('does not set X-Trace-Id when traceId is omitted', () => {
      new HttpClient(BASE_URL, TOKEN);
      const interceptorFn = mockInstance.interceptors.request.use.mock.calls[0][0];
      const config = { headers: {} } as any;
      const result = interceptorFn(config);
      expect(result.headers['X-Trace-Id']).toBeUndefined();
    });
  });

  describe('get()', () => {
    it('calls instance.get with the url and returns data', async () => {
      mockInstance.get.mockResolvedValue({ data: { items: [1, 2] } });
      const client = new HttpClient(BASE_URL, TOKEN);
      const result = await client.get('/items');
      expect(mockInstance.get).toHaveBeenCalledWith('/items', undefined);
      expect(result).toEqual({ items: [1, 2] });
    });

    it('forwards config to instance.get', async () => {
      mockInstance.get.mockResolvedValue({ data: {} });
      const client = new HttpClient(BASE_URL, TOKEN);
      await client.get('/search', { params: { q: 'test' } });
      expect(mockInstance.get).toHaveBeenCalledWith('/search', { params: { q: 'test' } });
    });
  });

  describe('post()', () => {
    it('calls instance.post and returns data', async () => {
      mockInstance.post.mockResolvedValue({ data: { id: 'new-1' } });
      const client = new HttpClient(BASE_URL, TOKEN);
      const result = await client.post('/items', { name: 'test' });
      expect(mockInstance.post).toHaveBeenCalledWith('/items', { name: 'test' }, undefined);
      expect(result).toEqual({ id: 'new-1' });
    });

    // N27: callback items must carry executorAddress — the client stamps
    // the injected executor address onto items that omit it.
    describe('executorAddress auto-fill (N27)', () => {
      const ADDR = 'executor-node:8002';

      it('fills executorAddress on callback items that omit it', async () => {
        mockInstance.post.mockResolvedValue({ data: { results: [] } });
        const client = new HttpClient(BASE_URL, TOKEN, undefined, ADDR);
        await client.post('/api/executions/callback', [
          { executionId: 'e1', status: 'success' },
          { executionId: 'e2', status: 'failed', executorAddress: 'other:9' },
        ]);
        expect(mockInstance.post).toHaveBeenCalledWith(
          '/api/executions/callback',
          [
            { executionId: 'e1', status: 'success', executorAddress: ADDR },
            { executionId: 'e2', status: 'failed', executorAddress: 'other:9' },
          ],
          undefined,
        );
      });

      it('leaves non-callback posts untouched', async () => {
        mockInstance.post.mockResolvedValue({ data: {} });
        const client = new HttpClient(BASE_URL, TOKEN, undefined, ADDR);
        await client.post('/items', { name: 'x' });
        expect(mockInstance.post).toHaveBeenCalledWith(
          '/items',
          { name: 'x' },
          undefined,
        );
      });

      it('passes the payload through unchanged when no address is known', async () => {
        mockInstance.post.mockResolvedValue({ data: {} });
        const client = new HttpClient(BASE_URL, TOKEN);
        await client.post('/api/executions/callback', [{ executionId: 'e1' }]);
        expect(mockInstance.post).toHaveBeenCalledWith(
          '/api/executions/callback',
          [{ executionId: 'e1' }],
          undefined,
        );
      });

      it('forAdminApi wires env.executorAddress into the client', async () => {
        mockInstance.post.mockResolvedValue({ data: {} });
        const client = HttpClient.forAdminApi({
          executionId: 'e',
          taskId: 't',
          taskName: 'n',
          adminApiUrl: BASE_URL,
          executorToken: TOKEN,
          executorAddress: ADDR,
        });
        await client.post('/api/executions/callback', [{ executionId: 'e' }]);
        expect(mockInstance.post).toHaveBeenCalledWith(
          '/api/executions/callback',
          [{ executionId: 'e', executorAddress: ADDR }],
          undefined,
        );
      });
    });
  });

  describe('put()', () => {
    it('calls instance.put and returns data', async () => {
      mockInstance.put.mockResolvedValue({ data: { updated: true } });
      const client = new HttpClient(BASE_URL, TOKEN);
      const result = await client.put('/items/1', { name: 'updated' });
      expect(mockInstance.put).toHaveBeenCalledWith('/items/1', { name: 'updated' }, undefined);
      expect(result).toEqual({ updated: true });
    });
  });

  describe('delete()', () => {
    it('calls instance.delete and returns data', async () => {
      mockInstance.delete.mockResolvedValue({ data: { deleted: true } });
      const client = new HttpClient(BASE_URL, TOKEN);
      const result = await client.delete('/items/1');
      expect(mockInstance.delete).toHaveBeenCalledWith('/items/1', undefined);
      expect(result).toEqual({ deleted: true });
    });
  });

  // U14: admin-api's global ResponseInterceptor wraps every body in
  // { code, message, data }. The helpers must unwrap it (callback callers
  // read `results` off the resolved value) and keep failure messages
  // readable by surfacing the envelope's `message`.
  describe('admin-api envelope unwrapping (U14)', () => {
    it('get() unwraps the { code, message, data } envelope', async () => {
      mockInstance.get.mockResolvedValue({
        data: { code: 200, message: 'success', data: { items: [1, 2] } },
      });
      const client = new HttpClient(BASE_URL, TOKEN);
      expect(await client.get('/items')).toEqual({ items: [1, 2] });
    });

    it('post() to the callback endpoint resolves with { results }', async () => {
      mockInstance.post.mockResolvedValue({
        data: {
          code: 200,
          message: 'success',
          data: { results: [{ executionId: 'e1', success: true }] },
        },
      });
      const client = new HttpClient(BASE_URL, TOKEN);
      const result = (await client.post('/api/executions/callback', [
        { executionId: 'e1', status: 'success' },
      ])) as { results: Array<{ executionId: string; success: boolean }> };
      expect(result.results).toEqual([{ executionId: 'e1', success: true }]);
    });

    it('put()/delete() unwrap the envelope too', async () => {
      mockInstance.put.mockResolvedValue({
        data: { code: 200, message: 'success', data: { updated: true } },
      });
      mockInstance.delete.mockResolvedValue({
        data: { code: 200, message: 'success', data: { deleted: true } },
      });
      const client = new HttpClient(BASE_URL, TOKEN);
      expect(await client.put('/items/1', {})).toEqual({ updated: true });
      expect(await client.delete('/items/1')).toEqual({ deleted: true });
    });

    it('non-enveloped bodies pass through unchanged', async () => {
      mockInstance.get.mockResolvedValue({ data: { results: [] } });
      const client = new HttpClient(BASE_URL, TOKEN);
      expect(await client.get('/x')).toEqual({ results: [] });
    });

    it('registers a response error interceptor that surfaces the server message', async () => {
      new HttpClient(BASE_URL, TOKEN);
      expect(mockInstance.interceptors.response.use).toHaveBeenCalledTimes(1);
      const onRejected = mockInstance.interceptors.response.use.mock.calls[0][1];
      const error = Object.assign(
        new Error('Request failed with status code 401'),
        {
          response: {
            status: 401,
            data: { code: 401, message: 'Invalid or expired execution callback token' },
          },
        },
      );
      await expect(onRejected(error)).rejects.toBe(error);
      expect(error.message).toBe(
        'Request failed with status code 401: Invalid or expired execution callback token',
      );
    });

    it('keeps 403 permission errors readable without retrying or rewriting status', async () => {
      new HttpClient(BASE_URL, TOKEN);
      const onRejected = mockInstance.interceptors.response.use.mock.calls[0][1];
      const error = Object.assign(new Error('Request failed with status code 403'), {
        response: {
          status: 403,
          data: { code: 403, message: 'executor token cannot access this execution' },
        },
      });

      await expect(onRejected(error)).rejects.toBe(error);
      expect(error.message).toBe(
        'Request failed with status code 403: executor token cannot access this execution',
      );
    });

    // B-4（中台↔执行器深度审查）：SDK 已补齐与 python SDK 对齐的
    // 「重试 + 熔断 + Retry-After」契约——旧的"薄包装不重试"断言失效，
    // 替换为：幂等 GET 在可重试错误上有界重试（maxRetries+1 次尝试）。
    it('retries a safe GET on a network-level error, up to maxRetries+1 attempts', async () => {
      const timeout = Object.assign(
        new Error('timeout of 10000ms exceeded'),
        // 真实 axios 超时错误带 code: 'ECONNABORTED'（isRetryableError 据此判定）
        { code: 'ECONNABORTED' },
      );
      mockInstance.get.mockRejectedValue(timeout);
      const client = new HttpClient(BASE_URL, TOKEN, undefined, undefined, {
        retry: { maxRetries: 1, minWaitMs: 1 }, // 2 次尝试，退避缩短便于快速收敛
      });

      await expect(client.get('/items')).rejects.toBe(timeout);
      expect(mockInstance.get).toHaveBeenCalledTimes(2);
    });

    it('retries a safe GET on a retryable status (503) then succeeds', async () => {
      const serverError = Object.assign(
        new Error('Request failed with status code 503'),
        { response: { status: 503, headers: {}, data: {} } },
      );
      mockInstance.get
        .mockRejectedValueOnce(serverError)
        .mockResolvedValueOnce({ data: { items: [1] } });
      const client = new HttpClient(BASE_URL, TOKEN, undefined, undefined, {
        retry: { maxRetries: 1, minWaitMs: 1 },
      });

      await expect(client.get('/items')).resolves.toEqual({ items: [1] });
      expect(mockInstance.get).toHaveBeenCalledTimes(2);
    });

    it('does not retry non-safe methods (POST) — failure propagates from the first attempt', async () => {
      const serverError = Object.assign(
        new Error('Request failed with status code 503'),
        { response: { status: 503, headers: {}, data: {} } },
      );
      mockInstance.post.mockRejectedValue(serverError);
      const client = new HttpClient(BASE_URL, TOKEN, undefined, undefined, {
        retry: { maxRetries: 3 },
      });

      await expect(client.post('/items', {})).rejects.toBe(serverError);
      expect(mockInstance.post).toHaveBeenCalledTimes(1);
    });

    it('respects the Retry-After header (delta-seconds) over the exponential backoff', async () => {
      const serverError = Object.assign(
        new Error('Request failed with status code 429'),
        {
          response: { status: 429, headers: { 'retry-after': '5' }, data: {} },
        },
      );
      mockInstance.get
        .mockRejectedValueOnce(serverError)
        .mockResolvedValueOnce({ data: { ok: true } });
      const client = new HttpClient(BASE_URL, TOKEN, undefined, undefined, {
        retry: { maxRetries: 1 },
      });

      jest.useFakeTimers();
      try {
        const pending = client.get('/items');
        // attempt 0 的指数退避 = minWait=1000ms；Retry-After=5000ms → 等 5000
        await jest.advanceTimersByTimeAsync(5000);
        await expect(pending).resolves.toEqual({ ok: true });
        expect(mockInstance.get).toHaveBeenCalledTimes(2);
      } finally {
        jest.useRealTimers();
      }
    });

    it('429 with no Retry-After still retries with the plain backoff', async () => {
      const serverError = Object.assign(
        new Error('Request failed with status code 429'),
        { response: { status: 429, headers: {}, data: {} } },
      );
      mockInstance.get
        .mockRejectedValueOnce(serverError)
        .mockResolvedValueOnce({ data: { ok: true } });
      const client = new HttpClient(BASE_URL, TOKEN, undefined, undefined, {
        retry: { maxRetries: 1, minWaitMs: 1 },
      });
      await expect(client.get('/items')).resolves.toEqual({ ok: true });
      expect(mockInstance.get).toHaveBeenCalledTimes(2);
    });

    it('error interceptor leaves non-envelope errors untouched', async () => {
      new HttpClient(BASE_URL, TOKEN);
      const onRejected = mockInstance.interceptors.response.use.mock.calls[0][1];
      const error = Object.assign(new Error('Network Error'), { response: undefined });
      await expect(onRejected(error)).rejects.toBe(error);
      expect(error.message).toBe('Network Error');
    });
  });

  // N23: clients built without Admin API credentials are explicitly disabled.
  describe('disabled client (N23)', () => {
    it('forAdminApi without credentials is disabled and creates no axios instance', () => {
      const client = HttpClient.forAdminApi({
        executionId: 'e',
        taskId: 't',
        taskName: 'n',
      });
      expect(client.enabled).toBe(false);
      expect(client.disabledReason).toMatch(/ADMIN_API_URL/);
      expect(mockedAxios.create).not.toHaveBeenCalled();
    });

    it('every request method rejects with a clear error when disabled', async () => {
      const client = HttpClient.forAdminApi({
        executionId: 'e',
        taskId: 't',
        taskName: 'n',
        adminApiUrl: BASE_URL, // token missing
      });
      expect(client.enabled).toBe(false);
      await expect(client.get('/x')).rejects.toThrow(/HttpClient is disabled/);
      await expect(client.post('/x', {})).rejects.toThrow(/HttpClient is disabled/);
      await expect(client.put('/x', {})).rejects.toThrow(/HttpClient is disabled/);
      await expect(client.delete('/x')).rejects.toThrow(/HttpClient is disabled/);
    });

    it('forAdminApi with full credentials is enabled', () => {
      const client = HttpClient.forAdminApi({
        executionId: 'e',
        taskId: 't',
        taskName: 'n',
        adminApiUrl: BASE_URL,
        executorToken: TOKEN,
      });
      expect(client.enabled).toBe(true);
      expect(mockedAxios.create).toHaveBeenCalledWith({ baseURL: BASE_URL, timeout: 10_000 });
    });
  });

  // B-4（中台↔执行器深度审查）：熔断器 + 重试判据 + Retry-After 解析，
  // 语义与 python SDK（autocodeflow-http client.py 的 _CircuitBreaker）同构。
  describe('circuit breaker (B-4)', () => {
    const err503 = () =>
      Object.assign(new Error('Request failed with status code 503'), {
        response: { status: 503, headers: {}, data: {} },
      });

    it('fails fast with CircuitBreakerOpenError once the threshold is hit, without touching the instance', async () => {
      mockInstance.get.mockRejectedValue(err503());
      // maxRetries: 0 → 每次请求只尝试一次；连续 5 次可熔断失败 → open
      const client = new HttpClient(BASE_URL, TOKEN, undefined, undefined, {
        retry: { maxRetries: 0 },
      });

      for (let i = 0; i < 5; i++) {
        await expect(client.get('/items')).rejects.toBeInstanceOf(Error);
      }
      const callsBeforeOpen = mockInstance.get.mock.calls.length;
      expect(callsBeforeOpen).toBe(5);

      // open → 快速失败（不再触碰 axios 实例）
      await expect(client.get('/items')).rejects.toThrow(CircuitBreakerOpenError);
      expect(mockInstance.get.mock.calls.length).toBe(5);
    });

    it('a non-breakable 4xx error neither retries nor counts toward the breaker', async () => {
      const badRequest = Object.assign(
        new Error('Request failed with status code 400'),
        { response: { status: 400, headers: {}, data: {} } },
      );
      mockInstance.get.mockRejectedValue(badRequest);
      const client = new HttpClient(BASE_URL, TOKEN, undefined, undefined, {
        retry: { maxRetries: 3 },
      });

      for (let i = 0; i < 7; i++) {
        await expect(client.get('/items')).rejects.toBe(badRequest);
      }
      // 7 次 400 都不算可熔断失败 → 熔断器始终 closed → 每次都触达实例
      expect(mockInstance.get).toHaveBeenCalledTimes(7);
      await expect(client.get('/items')).rejects.toBe(badRequest);
      expect(mockInstance.get).toHaveBeenCalledTimes(8);
    });

    // NETOPT-6①：half-open 探测收到不可重试的 4xx 时，探测槽必须被释放
    // （PK-09 parity：镜像 python autocodeflow-http 的 try/finally
    // release_probe）。修复前探测请求收到 400 既不走 onSuccess 也不走
    // onFailure → probeInFlight 永久为 true → 该 HttpClient 进程内永久砖死
    // （后续全部抛 CircuitBreakerOpenError）。
    it('NETOPT-6①: a 400 hitting the half-open probe releases the slot so later requests can probe again', async () => {
      // 必须先开 fake timers：Date.now() 随假时钟从 0 起跑，advanceTimersByTime
      // 才能把 open 态推进过 60s 复位时间（见下方 unit semantics 的同款说明）。
      jest.useFakeTimers();
      try {
        const err503 = () =>
          Object.assign(new Error('Request failed with status code 503'), {
            response: { status: 503, headers: {}, data: {} },
          });
        const bad400 = Object.assign(
          new Error('Request failed with status code 400'),
          { response: { status: 400, headers: {}, data: {} } },
        );
        const client = new HttpClient(BASE_URL, TOKEN, undefined, undefined, {
          retry: { maxRetries: 0 }, // 每次请求只尝试一次，失败计数可控
        });

        // 5 次可熔断失败（503）→ open；open 态快速失败不再触达实例
        mockInstance.get.mockRejectedValue(err503());
        for (let i = 0; i < 5; i++) {
          await expect(client.get('/items')).rejects.toBeTruthy();
        }
        expect(mockInstance.get).toHaveBeenCalledTimes(5);
        await expect(client.get('/items')).rejects.toThrow(CircuitBreakerOpenError);
        expect(mockInstance.get).toHaveBeenCalledTimes(5);

        // 复位时间过后 → 惰性转 half-open，放行的探测请求收到 400（不可重试）
        jest.advanceTimersByTime(61_000);
        mockInstance.get.mockRejectedValueOnce(bad400);
        await expect(client.get('/items')).rejects.toBe(bad400);
        expect(mockInstance.get).toHaveBeenCalledTimes(6);

        // 修复断言（还原此处应红：后续请求全抛 CircuitBreakerOpenError）：
        // 探测槽已被释放，下一个请求可再次作为探测放行，成功 → closed。
        mockInstance.get.mockResolvedValueOnce({
          data: { code: 200, data: { recovered: true } },
        });
        await expect(client.get('/items')).resolves.toEqual({ recovered: true });
        expect(mockInstance.get).toHaveBeenCalledTimes(7);
      } finally {
        jest.useRealTimers();
      }
    });
  });

  describe('circuit breaker unit semantics (B-4)', () => {
    it('closed → open after threshold, blocks while open, half-open probe recovers on success', () => {
      // 必须先开 fake timers 再建实例：Date.now() 随假时钟从 0 起跑，
      // 否则 openedAt 落在真实时间，advanceTimersByTime 后差值仍为负 → 永不转态。
      jest.useFakeTimers();
      try {
        const cb = new CircuitBreaker(2, 50);
        expect(cb.tryAcquire()).toBe(true);
        cb.onFailure();
        expect(cb.tryAcquire()).toBe(true);
        cb.onFailure();
        expect(cb.getState()).toBe('open');
        expect(cb.tryAcquire()).toBe(false); // open 且未到复位时间 → 阻塞

        // 复位时间过后，第一次 tryAcquire 惰性转入 half-open：恰放行一个探测，
        // 其余阻塞（状态转换发生在 tryAcquire 内，不是计时器驱动——见实现）
        jest.advanceTimersByTime(51);
        expect(cb.tryAcquire()).toBe(true); // 探测请求（此刻转 half_open）
        expect(cb.getState()).toBe('half_open');
        expect(cb.tryAcquire()).toBe(false); // 探测在飞 → 其余阻塞
        cb.onSuccess(); // 探测成功 → closed
        expect(cb.getState()).toBe('closed');
        expect(cb.tryAcquire()).toBe(true);
      } finally {
        jest.useRealTimers();
      }
    });

    it('half-open probe failure re-opens the circuit and restarts the timer', () => {
      jest.useFakeTimers();
      try {
        const cb = new CircuitBreaker(1, 50);
        cb.onFailure(); // → open
        expect(cb.getState()).toBe('open');

        jest.advanceTimersByTime(51); // 复位时间过后，首次 tryAcquire 惰性转 half-open
        expect(cb.tryAcquire()).toBe(true);
        expect(cb.getState()).toBe('half_open');
        cb.onFailure(); // 探测失败 → 重新 open
        expect(cb.getState()).toBe('open');
        expect(cb.tryAcquire()).toBe(false);
      } finally {
        jest.useRealTimers();
      }
    });

    // NETOPT-6①：onProbeSettled 释放 half-open 探测槽——对应探测以不可熔断
    // 错误（如 4xx）结束的路径；closed/open 态下调用是无害 no-op。
    it('NETOPT-6①: onProbeSettled releases the slot so half-open can probe again', () => {
      jest.useFakeTimers();
      try {
        const cb = new CircuitBreaker(1, 50);
        cb.onFailure(); // → open
        jest.advanceTimersByTime(51); // → 下次 tryAcquire 惰性转 half-open
        expect(cb.tryAcquire()).toBe(true); // 占用探测槽
        expect(cb.tryAcquire()).toBe(false); // 探测在飞 → 其余阻塞
        cb.onProbeSettled(); // 探测以不可熔断错误结束 → 释放槽
        expect(cb.tryAcquire()).toBe(true); // 可再次探测
        expect(cb.getState()).toBe('half_open');
        cb.onSuccess(); // 探测成功 → closed
        expect(cb.getState()).toBe('closed');
        // closed/open 态下调用为 no-op，不影响状态
        cb.onProbeSettled();
        expect(cb.getState()).toBe('closed');
        expect(cb.tryAcquire()).toBe(true);
      } finally {
        jest.useRealTimers();
      }
    });
  });

  describe('retry decision helpers (B-4)', () => {
    it('classifies retryable statuses and network-level errors', () => {
      expect(isRetryableError(Object.assign(new Error('e'), { response: { status: 429 } }))).toBe(true);
      expect(isRetryableError(Object.assign(new Error('e'), { response: { status: 500 } }))).toBe(true);
      expect(isRetryableError(Object.assign(new Error('e'), { response: { status: 503 } }))).toBe(true);
      expect(isRetryableError(Object.assign(new Error('e'), { response: { status: 504 } }))).toBe(true);
      expect(isRetryableError(Object.assign(new Error('e'), { response: { status: 400 } }))).toBe(false);
      expect(isRetryableError(Object.assign(new Error('e'), { response: { status: 401 } }))).toBe(false);
      expect(isRetryableError(Object.assign(new Error('e'), { code: 'ECONNABORTED' }))).toBe(true);
      expect(isRetryableError(Object.assign(new Error('e'), { code: 'ECONNREFUSED' }))).toBe(true);
      expect(isRetryableError(new Error('plain error'))).toBe(false);
    });

    it('parses Retry-After as delta-seconds or HTTP-date, tolerates garbage', () => {
      expect(
        parseRetryAfterHeader(Object.assign(new Error('e'), { response: { headers: { 'retry-after': '5' } } })),
      ).toBe(5000);
      expect(
        parseRetryAfterHeader(Object.assign(new Error('e'), { response: { headers: { 'retry-after': 'Wed, 21 Oct 2015 07:28:00 GMT' } } })),
      ).toBeGreaterThanOrEqual(0);
      expect(
        parseRetryAfterHeader(Object.assign(new Error('e'), { response: { headers: {} } })),
      ).toBeNull();
      expect(parseRetryAfterHeader(new Error('no response'))).toBeNull();
      expect(
        parseRetryAfterHeader(Object.assign(new Error('e'), { response: { headers: { 'retry-after': 'garbage' } } })),
      ).toBeNull();
    });
  });
});
