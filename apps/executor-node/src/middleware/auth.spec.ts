import axios from 'axios';

jest.mock('axios');
jest.mock('../config', () => ({
  config: {
    token: '',
    adminApiUrl: 'http://admin-public:3105/api',
    adminApiUrlInternal: '',
    adminApiUrlExternal: '',
    executorAddress: 'localhost:3002',
    executorAddressPublic: '',
    appName: 'test-executor',
    // R9: mutable runtime state adopted from admin responses (N26/W3)
    executorTokenHash: '',
  },
}));

const mockedAxios = axios as jest.Mocked<typeof axios>;

function makeRes() {
  return {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  } as any;
}

describe('auth token fetch', () => {
  // auth.ts keeps module-level token state (dynamicToken/expiry/backoff), so
  // every test needs a fresh module registry. resetModules also regenerates
  // the axios automock, so the post mock must be re-acquired afterwards —
  // the file-level `axios` binding would point at the previous instance.
  async function freshAuth() {
    jest.resetModules();
    const axiosDefault = ((await import('axios')) as any).default;
    const { getCurrentToken } = await import('./auth');
    const { config } = await import('../config');
    return {
      post: axiosDefault.post as jest.Mock,
      getCurrentToken,
      config: config as Record<string, any>,
    };
  }

  it('fetches dynamic tokens without double-prefixing /api admin URLs', async () => {
    const { post, getCurrentToken } = await freshAuth();
    post.mockResolvedValue({ status: 200, data: { token: 'dynamic-token' } });

    await expect(getCurrentToken()).resolves.toBe('dynamic-token');

    expect(post).toHaveBeenCalledWith(
      'http://admin-public:3105/api/executors/token',
      expect.objectContaining({
        address: 'localhost:3002',
        appName: 'test-executor',
      }),
      { timeout: 10000, headers: {} },
    );
  });

  // R9 (round-8 P1 root fix): admin-api's global ResponseInterceptor wraps
  // every success in {code,message,data} and the token endpoint answers 201.
  // The old code read response.data.token on a 200-only check — both wrong —
  // so every fetch "failed", retried every 30s, and each retry rotated the
  // stored tokenHash (docs/VERIFY-round8-e2e.md §1.5).
  it('unwraps the {code,message,data} envelope and accepts the 201 status', async () => {
    const { post, getCurrentToken, config } = await freshAuth();
    post.mockResolvedValue({
      status: 201,
      data: {
        code: 201,
        message: 'success',
        data: { token: 'enveloped-token', tokenHash: '$2b$12$adminhash' },
      },
    });

    await expect(getCurrentToken()).resolves.toBe('enveloped-token');
    // W3: the matching tokenHash is adopted so the N26 callback HMAC secret
    // stays in sync with whatever admin-api just authorized.
    expect(config.executorTokenHash).toBe('$2b$12$adminhash');
  });

  it('still accepts bare (non-enveloped) token responses for compatibility', async () => {
    const { post, getCurrentToken, config } = await freshAuth();
    post.mockResolvedValue({
      status: 200,
      data: { token: 'bare-token', tokenHash: '$2b$12$barehash' },
    });

    await expect(getCurrentToken()).resolves.toBe('bare-token');
    expect(config.executorTokenHash).toBe('$2b$12$barehash');
  });

  it('sends the process startupId so admin-api can answer idempotently', async () => {
    const { post, getCurrentToken } = await freshAuth();
    post.mockResolvedValue({
      status: 201,
      data: { code: 201, message: 'success', data: { token: 't' } },
    });

    await getCurrentToken();

    expect(post).toHaveBeenCalledWith(
      'http://admin-public:3105/api/executors/token',
      expect.objectContaining({
        address: 'localhost:3002',
        appName: 'test-executor',
        startupId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      }),
      expect.anything(),
    );
  });

  it('caches the dynamic token — repeated getCurrentToken does not re-request', async () => {
    const { post, getCurrentToken } = await freshAuth();
    post.mockResolvedValue({
      status: 201,
      data: { code: 201, message: 'success', data: { token: 'cached-token' } },
    });

    await expect(getCurrentToken()).resolves.toBe('cached-token');
    await expect(getCurrentToken()).resolves.toBe('cached-token');

    expect(post).toHaveBeenCalledTimes(1);
  });

  it('treats an envelope without a token as a failed fetch and falls back to the static token', async () => {
    jest.resetModules();
    const axiosDefault = ((await import('axios')) as any).default;
    axiosDefault.post.mockResolvedValue({
      status: 201,
      data: { code: 201, message: 'success', data: null },
    });
    const { config } = await import('../config');
    // STATIC_TOKEN is captured at auth module load — set it before importing.
    config.token = 'static-token';
    const { getCurrentToken } = await import('./auth');

    await expect(getCurrentToken()).resolves.toBe('static-token');
    // A second call must hit the 30s fetch backoff, not spam /token again.
    await expect(getCurrentToken()).resolves.toBe('static-token');
    expect(axiosDefault.post).toHaveBeenCalledTimes(1);
  });
});

// R10 (round-10 gap #3): forceTokenRefresh is the hook admin-client uses when
// an outbound request 401s — i.e. admin rotated our per-executor token out
// from under us (admin-UI rotate-token). It must bypass the 30-minute
// schedule but keep the fetch-failure backoff (storm guard).
describe('forceTokenRefresh — R10 stale-credential self-heal', () => {
  async function freshAuth() {
    jest.resetModules();
    const axiosDefault = ((await import('axios')) as any).default;
    const { getCurrentToken, forceTokenRefresh } = await import('./auth');
    const { config } = await import('../config');
    return {
      post: axiosDefault.post as jest.Mock,
      getCurrentToken,
      forceTokenRefresh,
      config: config as Record<string, any>,
    };
  }

  it('re-fetches immediately even while the cached token is still fresh, adopting token+hash', async () => {
    const { post, getCurrentToken, forceTokenRefresh, config } = await freshAuth();
    post
      .mockResolvedValueOnce({
        status: 201,
        data: { code: 201, message: 'success', data: { token: 'token-A', tokenHash: 'hash-A' } },
      })
      .mockResolvedValueOnce({
        status: 201,
        data: { code: 201, message: 'success', data: { token: 'token-B', tokenHash: 'hash-B' } },
      });

    await expect(getCurrentToken()).resolves.toBe('token-A');
    // A plain getCurrentToken would sit on the 30-minute schedule; the 401
    // self-heal must not wait for it.
    await expect(forceTokenRefresh()).resolves.toBe('token-B');
    expect(post).toHaveBeenCalledTimes(2);
    // The N26 callback HMAC secret follows the new token in the same call.
    expect(config.executorTokenHash).toBe('hash-B');
  });

  it('degrades to a no-op while the fetch-failure backoff is active', async () => {
    const { post, getCurrentToken, forceTokenRefresh } = await freshAuth();
    post.mockRejectedValueOnce(new Error('admin unreachable'));
    // No dynamic token and STATIC_TOKEN is '' → getCurrentToken falls
    // through to the empty static token (dev-mode passthrough).
    await expect(getCurrentToken()).resolves.toBeFalsy();

    // Even though the next fetch WOULD succeed, the 30s backoff after a
    // failed fetch must short-circuit — concurrent 401s cannot spin.
    post.mockResolvedValueOnce({
      status: 201,
      data: { code: 201, message: 'success', data: { token: 'late-token' } },
    });
    await expect(forceTokenRefresh()).resolves.toBeNull();
    expect(post).toHaveBeenCalledTimes(1);
  });

  it('returns the unchanged token when admin answers idempotently (caller must skip the retry)', async () => {
    const { post, getCurrentToken, forceTokenRefresh } = await freshAuth();
    post.mockResolvedValue({
      status: 201,
      data: { code: 201, message: 'success', data: { token: 'same-token' } },
    });

    await expect(getCurrentToken()).resolves.toBe('same-token');
    // R9 idempotent issueToken: a re-fetch can legitimately return the SAME
    // token (e.g. the 401 came from a different cause). forceTokenRefresh
    // hands it back unchanged — admin-client compares against the failed
    // token and skips a pointless retry in that case.
    await expect(forceTokenRefresh()).resolves.toBe('same-token');
    expect(post).toHaveBeenCalledTimes(2);
  });
});

describe('verifyToken — REQUIRE_TOKEN fail-closed mode', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.resetModules();
    delete process.env.REQUIRE_TOKEN;
    mockedAxios.post.mockRejectedValue(new Error('admin unreachable'));
  });

  afterEach(() => {
    delete process.env.REQUIRE_TOKEN;
  });

  it('keeps dev-mode passthrough when no token is configured and REQUIRE_TOKEN is unset', async () => {
    const { verifyToken } = await import('./auth');
    const next = jest.fn();
    await verifyToken({ headers: {} } as any, makeRes(), next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('refuses the request with 503 when REQUIRE_TOKEN=true and no token is configured', async () => {
    process.env.REQUIRE_TOKEN = 'true';
    const { verifyToken } = await import('./auth');
    const res = makeRes();
    const next = jest.fn();
    await verifyToken({ headers: {} } as any, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.stringMatching(/REQUIRE_TOKEN/) }),
    );
  });
});
