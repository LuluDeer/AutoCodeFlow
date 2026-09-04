import axios from 'axios';
import {
  failover,
  getAllAdminUrls,
  getCurrentAdminUrl,
  initAdminClients,
  checkAdminApiConnectivity,
  post,
  postWithStaticToken,
  request,
} from './admin-client';
import { getCurrentToken, getStaticToken, forceTokenRefresh } from './middleware/auth';

jest.mock('axios');
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

const mockedAxios = axios as jest.Mocked<typeof axios>;
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
    const requestMock = jest.fn().mockResolvedValue({ data: { ok: true } });
    mockedAxios.create.mockReturnValue({ request: requestMock } as any);
    mockedGetCurrentToken.mockResolvedValue('secret-token');
    initAdminClients(['http://admin-a:3105/api']);

    await post('/api/test', { hello: 'world' });

    expect(mockedAxios.create).toHaveBeenCalledWith({
      baseURL: 'http://admin-a:3105',
      timeout: 10_000,
      headers: {
        'Content-Type': 'application/json',
        'X-Executor-Token': 'secret-token',
        Authorization: 'Bearer secret-token',
      },
    });
    expect(requestMock).toHaveBeenCalledWith({
      method: 'post',
      url: '/api/test',
      data: { hello: 'world' },
    });
  });

  it('fails over and retries the next admin URL', async () => {
    const requestMockA = jest.fn().mockRejectedValue(new Error('down'));
    const requestMockB = jest.fn().mockResolvedValue({ data: { ok: true } });
    mockedAxios.create
      .mockReturnValueOnce({ request: requestMockA } as any)
      .mockReturnValueOnce({ request: requestMockB } as any);
    initAdminClients(['http://admin-a:3105', 'http://admin-b:3105']);

    const result = await request('get', '/api/health');

    expect(result.data).toEqual({ ok: true });
    expect(mockedAxios.create).toHaveBeenNthCalledWith(1, expect.objectContaining({
      baseURL: 'http://admin-a:3105',
    }));
    expect(mockedAxios.create).toHaveBeenNthCalledWith(2, expect.objectContaining({
      baseURL: 'http://admin-b:3105',
    }));
    expect(getCurrentAdminUrl()).toBe('http://admin-b:3105');
  });

  it('throws after all configured admins fail', async () => {
    mockedAxios.create.mockReturnValue({
      request: jest.fn().mockRejectedValue(new Error('down')),
    } as any);
    initAdminClients(['http://admin-a:3105', 'http://admin-b:3105']);

    await expect(request('get', '/api/health')).rejects.toThrow(
      'All 2 admin servers are unavailable',
    );
  });

  it('returns true and selects the reachable admin during startup self-check', async () => {
    mockedAxios.get
      .mockRejectedValueOnce(new Error('down'))
      .mockResolvedValueOnce({ data: { status: 'ok' } });
    initAdminClients(['http://admin-a:3105', 'http://admin-b:3105']);

    const ok = await checkAdminApiConnectivity({ attempts: 1 });

    expect(ok).toBe(true);
    expect(mockedAxios.get).toHaveBeenNthCalledWith(1, 'http://admin-a:3105/api/health', { timeout: 5_000 });
    expect(mockedAxios.get).toHaveBeenNthCalledWith(2, 'http://admin-b:3105/api/health', { timeout: 5_000 });
    expect(getCurrentAdminUrl()).toBe('http://admin-b:3105');
  });

  it('returns false after startup self-check retries are exhausted', async () => {
    mockedAxios.get.mockRejectedValue(new Error('down'));
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
      const requestMock = jest
        .fn()
        .mockRejectedValueOnce(unauthorized401())
        .mockResolvedValueOnce({ data: { ok: true } });
      mockedAxios.create.mockImplementation((() => ({ request: requestMock })) as any);
      mockedGetCurrentToken.mockResolvedValueOnce('old-token');
      // fetchToken adopts BOTH the new bearer and the new tokenHash; here we
      // only assert the bearer reaches the retry (hash adoption is covered
      // in middleware/auth.spec.ts).
      mockedForceTokenRefresh.mockResolvedValue('new-token');

      const result = await post('/api/executors/heartbeat', { address: 'a:1' });

      expect(result.data).toEqual({ ok: true });
      expect(mockedForceTokenRefresh).toHaveBeenCalledTimes(1);
      expect(mockedAxios.create).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          headers: expect.objectContaining({ Authorization: 'Bearer old-token' }),
        }),
      );
      expect(mockedAxios.create).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          headers: expect.objectContaining({
            'X-Executor-Token': 'new-token',
            Authorization: 'Bearer new-token',
          }),
        }),
      );
    });

    it('does not fail over to another admin on 401 and gives up when the refresh yields no new token', async () => {
      const requestMock = jest.fn().mockRejectedValue(unauthorized401());
      mockedAxios.create.mockImplementation((() => ({ request: requestMock })) as any);
      mockedGetCurrentToken.mockResolvedValue('stale-token');
      // Shared token also rejected (or backoff active) → refresh returns the
      // same token → retrying would just 401 again, so the original error
      // must propagate after exactly one attempt on the FIRST admin URL.
      mockedForceTokenRefresh.mockResolvedValue('stale-token');
      initAdminClients(['http://admin-a:3105', 'http://admin-b:3105']);

      await expect(post('/api/executors/heartbeat', {})).rejects.toMatchObject({
        response: { status: 401 },
      });
      expect(mockedAxios.create).toHaveBeenCalledTimes(1);
      expect(getCurrentAdminUrl()).toBe('http://admin-a:3105');
    });

    it('retries at most once on auth failure — a second 401 propagates (no retry storm)', async () => {
      const requestMock = jest.fn().mockRejectedValue(unauthorized401());
      mockedAxios.create.mockImplementation((() => ({ request: requestMock })) as any);
      mockedGetCurrentToken.mockResolvedValue('old-token');
      mockedForceTokenRefresh.mockResolvedValue('new-token');

      await expect(post('/api/executions/callback', [])).rejects.toMatchObject({
        response: { status: 401 },
      });
      expect(mockedAxios.create).toHaveBeenCalledTimes(2);
      expect(mockedForceTokenRefresh).toHaveBeenCalledTimes(1);
    });

    it('never triggers the dynamic re-auth path for static-token requests (register)', async () => {
      const requestMock = jest.fn().mockRejectedValue(unauthorized401());
      mockedAxios.create.mockImplementation((() => ({ request: requestMock })) as any);
      mockedGetStaticToken.mockReturnValue('shared-token');

      await expect(
        postWithStaticToken('/api/executors/register', { address: 'a:1' }),
      ).rejects.toMatchObject({ response: { status: 401 } });
      expect(mockedForceTokenRefresh).not.toHaveBeenCalled();
      expect(mockedGetCurrentToken).not.toHaveBeenCalled();
      expect(requestMock).toHaveBeenCalledTimes(1);
    });

    it('keeps the failover loop for non-401 transport errors', async () => {
      const requestMockA = jest.fn().mockRejectedValue(new Error('down'));
      const requestMockB = jest.fn().mockResolvedValue({ data: { ok: true } });
      mockedAxios.create
        .mockReturnValueOnce({ request: requestMockA } as any)
        .mockReturnValueOnce({ request: requestMockB } as any);
      initAdminClients(['http://admin-a:3105', 'http://admin-b:3105']);

      const result = await request('get', '/api/health');

      expect(result.data).toEqual({ ok: true });
      expect(mockedForceTokenRefresh).not.toHaveBeenCalled();
    });
  });
});
