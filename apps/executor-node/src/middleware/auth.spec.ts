import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';

jest.mock('axios');
/**
 * NETOPT-G P1-1：auth.ts 的 token 获取已从**模块级默认 axios**（`axios.post`）
 * 改为经 `admin-http-agent` 的**共享实例**（带 keepAlive 的 https agent +
 * 最小重试）——因为默认实例对 https 目标等于每次冷 TLS 握手且零重试，而这是
 * 执行器取 per-executor 令牌的唯一路径。
 *
 * 本 mock 把共享实例的 `post` 接到 axios automock 的同名方法上，使既有断言
 * （URL / body / 请求配置）继续有效，同时新增 `create` 的 agent 断言面见
 * admin-http-agent 自身的用例。
 */
jest.mock('../admin-http-agent', () => {

  const realAxios = require('axios');
  const automocked = realAxios.default ?? realAxios;
  return {
    sharedAxios: { post: automocked.post, get: automocked.get, request: automocked.request },
    MIN_ATTEMPTS: 3,
    RETRY_BACKOFF_MS: 500,
    DEFAULT_TIMEOUT_MS: 20_000,
    httpStatusOf: (error: unknown) =>
      (error as { response?: { status?: number } } | undefined)?.response?.status,
    isTransientServerError: (error: unknown) => {
      const s = (error as { response?: { status?: number } } | undefined)?.response
        ?.status;
      return typeof s === 'number' && s >= 500 && s <= 599;
    },
  };
});
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

/**
 * ADR-017 阶段 3（复查补口）：把指纹**钉死**（与 executor-python
 * test_registration.py 的 monkeypatch 同款做法）。
 *
 * 为什么必须 mock 而不是用真实采集：真实 `getDeviceFingerprint()` 依赖
 * workDir 下的盐文件与机器身份探测，单测环境两者都取不到 → 恒返回 null →
 * 「指纹随载荷上报」这条断言会因**环境**而非**代码**变红/空转。钉死采集结果
 * 后，断言只度量本文件真正负责的事：**载荷字段是否转发**。
 * 另有独立用例（device-identity.spec.ts）度量采集算法本身。
 */
jest.mock('../device-identity', () => ({
  getDeviceFingerprint: () => 'a'.repeat(64),
  DEVICE_IDENTITY_DIR_NAME: '.device-identity',
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
      // NETOPT-G P1-1：token 获取走共享实例，其 post 被 mock 接到 axios
      // automock 的 post 上（见顶部 jest.mock('../admin-http-agent')）。
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
      { timeout: 20_000, headers: {} },
    );
  });

  // R9 (round-8 P1 root fix): admin-api's global ResponseInterceptor wraps
  // every success in {code,message,data} and the token endpoint answers 201.
  // The old code read response.data.token on a 200-only check — both wrong —
  // so every fetch "failed", retried every 30s, and each retry rotated the
  // stored tokenHash (docs/archive/verifies/verify-round8-e2e.md §1.5).
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

  // ADR-017 阶段 3（复查补口）：指纹必须随 /executors/token 上报——它是中台的
  // **行定位键**。缺了它，issueToken → register 会回落 `findOne({address})`，
  // 而 pull 同址多行（ADR-017 §5）时那会任取一行 → 轮换**别人的** token
  // （那台随即 401，其执行卡在 RUNNING 直到 stale sweep）。
  // 反证：删掉 fetchToken 载荷里的 deviceFingerprint → 本用例转红。
  it('ADR-017: reports deviceFingerprint on the token fetch so admin can pin the row', async () => {
    const { post, getCurrentToken } = await freshAuth();
    post.mockResolvedValue({
      status: 201,
      data: { code: 201, message: 'success', data: { token: 't' } },
    });

    await getCurrentToken();

    expect(post).toHaveBeenCalledWith(
      'http://admin-public:3105/api/executors/token',
      expect.objectContaining({
        // 指纹由上面的 jest.mock('../device-identity') 钉死为 64×'a'；
        // 真实环境由 getDeviceFingerprint() 产出同形态值。
        deviceFingerprint: 'a'.repeat(64),
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
    delete process.env.EXECUTOR_SHARED_TOKEN;
    delete process.env.EXECUTOR_SECRET;
    const axiosDefault = ((await import('axios')) as any).default;
    axiosDefault.post.mockResolvedValue({
      status: 201,
      data: { code: 201, message: 'success', data: null },
    });
    const { config } = await import('../config');
    // static token is read at call time (5-2) — set config before importing.
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
    // NETOPT-G P1-1：fetchToken 现带最小重试（3 次），因此一次失败的调用会
    // 产生多次 POST。用 mockRejectedValue（而非 ...Once）让**所有**尝试都失败，
    // 才能真实模拟"admin 不可达"——否则第 2 次尝试会拿到 resolved mock 而
    // 假性成功，测不到 backoff 路径。
    post.mockRejectedValue(new Error('admin unreachable'));
    // No dynamic token and STATIC_TOKEN is '' → getCurrentToken falls
    // through to the empty static token (dev-mode passthrough).
    await expect(getCurrentToken()).resolves.toBeFalsy();
    const callsAfterFailedFetch = post.mock.calls.length;
    expect(callsAfterFailedFetch).toBeGreaterThan(1);

    // Even though the next fetch WOULD succeed, the 30s backoff after a
    // failed fetch must short-circuit — concurrent 401s cannot spin.
    post.mockResolvedValueOnce({
      status: 201,
      data: { code: 201, message: 'success', data: { token: 'late-token' } },
    });
    await expect(forceTokenRefresh()).resolves.toBeNull();
    // backoff 生效：没有再发出任何新的 POST（调用次数停留在失败那次的总数）
    expect(post).toHaveBeenCalledTimes(callsAfterFailedFetch);
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

  // NETOPT-G P1-1：token 获取此前是**模块级默认 axios + 零重试**——而它是
  // 执行器取 per-executor 令牌的唯一路径，失败一次会让所有依赖 token 的请求
  // （心跳/pull/回调）连带全灭。以下是新增的重试语义回归锁。
  describe('NETOPT-G P1-1 token 获取重试', () => {
    it('瞬时连接故障后重试并成功取得 token（旧实现会直接失败）', async () => {
      const { post, getCurrentToken } = await freshAuth();
      post
        .mockRejectedValueOnce(new Error('socket hang up'))
        .mockResolvedValueOnce({
          status: 201,
          data: { code: 201, message: 'success', data: { token: 'retry-token' } },
        });

      await expect(getCurrentToken()).resolves.toBe('retry-token');
      expect(post).toHaveBeenCalledTimes(2);
    });

    it('5xx 属于瞬时故障，同样重试', async () => {
      const { post, getCurrentToken } = await freshAuth();
      post
        .mockRejectedValueOnce({ message: 'Request failed with status code 502', response: { status: 502 } })
        .mockResolvedValueOnce({
          status: 201,
          data: { code: 201, message: 'success', data: { token: 'after-502' } },
        });

      await expect(getCurrentToken()).resolves.toBe('after-502');
      expect(post).toHaveBeenCalledTimes(2);
    });

    it('4xx 是确定性拒绝：立即放弃，不做无谓重试', async () => {
      const { post, getCurrentToken } = await freshAuth();
      post.mockRejectedValue({
        message: 'Request failed with status code 403',
        response: { status: 403 },
      });

      await expect(getCurrentToken()).resolves.toBeFalsy();
      // 只尝试一次——重试 403 不会让令牌变有效，徒增 admin 压力
      expect(post).toHaveBeenCalledTimes(1);
    });

    it('重试耗尽后仍失败：回退到 static token（不抛出，保持既有降级语义）', async () => {
      const { post, getCurrentToken } = await freshAuth();
      post.mockRejectedValue(new Error('socket hang up'));

      await expect(getCurrentToken()).resolves.toBeFalsy();
      expect(post).toHaveBeenCalledTimes(3); // MIN_ATTEMPTS 上限，不是无限重试
    });
  });
});

describe('verifyToken — REQUIRE_TOKEN fail-closed mode', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.resetModules();
    delete process.env.REQUIRE_TOKEN;
    delete process.env.EXECUTOR_ALLOW_NO_TOKEN;
    delete process.env.EXECUTOR_SHARED_TOKEN;
    delete process.env.EXECUTOR_SECRET;
    mockedAxios.post.mockRejectedValue(new Error('admin unreachable'));
  });

  afterEach(() => {
    delete process.env.REQUIRE_TOKEN;
    delete process.env.EXECUTOR_ALLOW_NO_TOKEN;
    delete process.env.EXECUTOR_SHARED_TOKEN;
    delete process.env.EXECUTOR_SECRET;
  });

  it('refuses by default (fail-closed, S-3) when no token is configured', async () => {
    const { verifyToken } = await import('./auth');
    const res = makeRes();
    const next = jest.fn();
    await verifyToken({ headers: {} } as any, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.stringMatching(/No executor token is configured/) }),
    );
  });

  it('keeps dev-mode passthrough only with the explicit EXECUTOR_ALLOW_NO_TOKEN=true opt-in', async () => {
    process.env.EXECUTOR_ALLOW_NO_TOKEN = 'true';
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
      expect.objectContaining({ error: expect.stringMatching(/No executor token is configured/) }),
    );
  });
});

// ---------------------------------------------------------------------------
// verifyToken — Bearer authentication semantics.
// Migrated from the removed routes/logs.ts legacy Bearer middleware (dead code
// with two defects: a non-constant-time `token !== secret` and a fail-open
// `next()` when no secret was configured). These cover the现役 /api gate's
// contract — dynamic + static token acceptance, 401 on invalid / missing /
// wrong-scheme / malformed bearer, and the timing-safe comparison. The
// REQUIRE_TOKEN fail-closed 503 and the dev-mode passthrough already live in
// the describe above.
// ---------------------------------------------------------------------------
describe('verifyToken — Bearer authentication (migrated)', () => {
  // STATIC_TOKEN is captured when auth.ts loads, so config.token must be set
  // BEFORE the dynamic import; axios is re-acquired after resetModules because
  // the reset regenerates its automock (same pattern as `freshAuth` above).
  async function loadVerify(opts: {
    staticToken?: string;
    adminResponse?: unknown;
  } = {}) {
    jest.resetModules();
    // 5-2（audit-r4）：static token 每次调用读 env 优先——测试必须清掉宿主
    // 环境泄漏的 EXECUTOR_SHARED_TOKEN，否则 config.token 桩值不生效。
    delete process.env.EXECUTOR_SHARED_TOKEN;
    delete process.env.EXECUTOR_SECRET;
    delete process.env.EXECUTOR_ALLOW_NO_TOKEN;
    delete process.env.REQUIRE_TOKEN;
    const { config } = await import('../config');
    (config as Record<string, any>).token = opts.staticToken ?? '';
    const axiosDefault = ((await import('axios')) as any).default;
    if (opts.adminResponse === undefined) {
      axiosDefault.post.mockRejectedValue(new Error('admin unreachable'));
    } else {
      axiosDefault.post.mockResolvedValue(opts.adminResponse);
    }
    const { verifyToken } = await import('./auth');
    return { verifyToken, post: axiosDefault.post as jest.Mock };
  }

  const dynEnvelope = (token: string) => ({
    status: 201,
    data: { code: 201, message: 'success', data: { token } },
  });

  it('accepts a valid dynamic token fetched from admin-api', async () => {
    const { verifyToken } = await loadVerify({ adminResponse: dynEnvelope('dyn-abc') });
    const next = jest.fn();
    const res = makeRes();
    await verifyToken({ headers: { authorization: 'Bearer dyn-abc' } } as any, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });

  it('accepts a valid static shared token', async () => {
    const { verifyToken } = await loadVerify({ staticToken: 'static-xyz' });
    const next = jest.fn();
    const res = makeRes();
    await verifyToken({ headers: { authorization: 'Bearer static-xyz' } } as any, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });

  it('accepts the dynamic token even when a static token is also configured', async () => {
    const { verifyToken } = await loadVerify({
      staticToken: 'stat-1',
      adminResponse: dynEnvelope('dyn-1'),
    });
    const next = jest.fn();
    await verifyToken({ headers: { authorization: 'Bearer dyn-1' } } as any, makeRes(), next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('rejects an invalid token with 401 (same length, exercises timingSafeEqual)', async () => {
    const { verifyToken } = await loadVerify({ staticToken: 'static-xyz' });
    const next = jest.fn();
    const res = makeRes();
    await verifyToken({ headers: { authorization: 'Bearer static-yzz' } } as any, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.stringMatching(/执行器令牌无效或缺失/) }),
    );
  });

  it('rejects a different-length token with 401 (length guard, no throw)', async () => {
    const { verifyToken } = await loadVerify({ staticToken: 'a-long-static-token' });
    const next = jest.fn();
    const res = makeRes();
    await verifyToken({ headers: { authorization: 'Bearer short' } } as any, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it('rejects a missing Authorization header with 401', async () => {
    const { verifyToken } = await loadVerify({ staticToken: 'static-xyz' });
    const next = jest.fn();
    const res = makeRes();
    await verifyToken({ headers: {} } as any, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it('rejects a non-Bearer scheme with 401', async () => {
    const { verifyToken } = await loadVerify({ staticToken: 'static-xyz' });
    const next = jest.fn();
    const res = makeRes();
    await verifyToken({ headers: { authorization: 'Basic static-xyz' } } as any, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it('rejects a malformed single-part Authorization header with 401', async () => {
    const { verifyToken } = await loadVerify({ staticToken: 'static-xyz' });
    const next = jest.fn();
    const res = makeRes();
    await verifyToken({ headers: { authorization: 'static-xyz' } } as any, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it('compares tokens with timingSafeEqual, never a plain !== (SEC regression)', () => {
    const src = fs.readFileSync(path.join(__dirname, 'auth.ts'), 'utf-8');
    expect(src).toMatch(/timingSafeEqual/);
    // The removed legacy middleware used `token !== secret`; guard against
    // reintroducing a non-constant-time equality on the bearer token.
    expect(src).not.toMatch(/token\s*!==?\s*(secret|STATIC_TOKEN)/);
  });

  // R74-A1（安全面四轴审计·轴 3 鉴权）：信息泄露面。
  // 逐个错误分支都已覆盖，但"这些分支彼此**不可区分**"这个性质本身此前没有
  // 断言——而它才是防止枚举/指纹（哪个执行器配了什么凭据、token 是否存在）
  // 的那条线。断言方式：把 status/json 的全部调用参数快照下来逐字段相等。
  it('缺失 token 与无效 token 的响应完全一致（不区分「不存在」与「无效」）', async () => {
    const { verifyToken } = await loadVerify({
      staticToken: 'shared-1',
      adminResponse: dynEnvelope('per-exec-1'),
    });
    const missingRes = makeRes();
    await verifyToken({ headers: {} } as any, missingRes, jest.fn());
    const invalidRes = makeRes();
    await verifyToken(
      { headers: { authorization: 'Bearer wrong-token' } } as any,
      invalidRes,
      jest.fn(),
    );
    const snapshot = (res: any) => ({ status: res.status.mock.calls, json: res.json.mock.calls });
    expect(snapshot(missingRes)).toEqual(snapshot(invalidRes));
    // 且两条分支都必须是 401（不是 403/400 这类能区分"存在但无权"的码）
    expect(missingRes.status).toHaveBeenCalledWith(401);
    expect(invalidRes.status).toHaveBeenCalledWith(401);
    expect(missingRes.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: '执行器令牌无效或缺失' }),
    );
  });

  // R74-A1 轴 3：shared token 与 per-executor token 的**优先级**必须是明确的
  // OR（任一匹配即放行），不是覆盖/遮蔽——既有用例只钉了"dynamic 在 static
  // 存在时仍被接受"，反向（static 不被 dynamic 遮蔽）与"两者都不匹配则拒绝"
  // 没有一起钉住，优先级就没被完整表达。
  it('shared 与 per-executor token 并存时互不遮蔽（优先级 = OR，非覆盖）', async () => {
    const { verifyToken } = await loadVerify({
      staticToken: 'shared-1',
      adminResponse: dynEnvelope('per-exec-1'),
    });
    for (const accepted of ['shared-1', 'per-exec-1']) {
      const next = jest.fn();
      const res = makeRes();
      await verifyToken({ headers: { authorization: `Bearer ${accepted}` } } as any, res, next);
      expect(next).toHaveBeenCalledTimes(1);
      expect(res.status).not.toHaveBeenCalled();
    }
    const next = jest.fn();
    const res = makeRes();
    await verifyToken({ headers: { authorization: 'Bearer neither-one' } } as any, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
  });
});

// N41: fetchToken 成功后触发 onTokenAcquired 钩子——main.ts 用它在启动期
// register 失败、token 链恢复后补一次带富元数据的重注册（/token side effect
// 重建的行没有 type/capabilities/maxConcurrent/version）。钩子必须
// fire-and-forget：监听器抛错不得影响 token 获取主流程。
describe('setOnTokenAcquired — N41 register self-heal hook', () => {
  async function freshAuth() {
    jest.resetModules();
    const axiosDefault = ((await import('axios')) as any).default;
    const { getCurrentToken, setOnTokenAcquired } = await import('./auth');
    return {
      post: axiosDefault.post as jest.Mock,
      getCurrentToken,
      setOnTokenAcquired,
    };
  }

  const flushAsync = () => new Promise((resolve) => setTimeout(resolve, 0));

  it('fires the listener after a successful token fetch', async () => {
    const { post, getCurrentToken, setOnTokenAcquired } = await freshAuth();
    post.mockResolvedValue({
      status: 201,
      data: { code: 201, message: 'success', data: { token: 'healed-token' } },
    });
    const listener = jest.fn();
    setOnTokenAcquired(listener);

    await expect(getCurrentToken()).resolves.toBe('healed-token');
    // 钩子是非阻塞的 fire-and-forget：让出微任务队列后再断言。
    await flushAsync();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('does not fire the listener when the fetch fails', async () => {
    const { post, getCurrentToken, setOnTokenAcquired } = await freshAuth();
    post.mockRejectedValue(new Error('admin unreachable'));
    const listener = jest.fn();
    setOnTokenAcquired(listener);

    await expect(getCurrentToken()).resolves.toBeFalsy();
    await flushAsync();
    expect(listener).not.toHaveBeenCalled();
  });

  it('listener errors are swallowed and never break the token flow', async () => {
    const { post, getCurrentToken, setOnTokenAcquired } = await freshAuth();
    post.mockResolvedValue({
      status: 201,
      data: { code: 201, message: 'success', data: { token: 'token-x' } },
    });
    setOnTokenAcquired(() => {
      throw new Error('re-register boom');
    });

    // 主流程不受监听器异常影响（re-register 失败由监听器自担，下轮再试）。
    await expect(getCurrentToken()).resolves.toBe('token-x');
    await flushAsync();
  });
});

// E-27（DEEP_REVIEW 0ef3bbe）：token 刷新 in-flight 去重。旧实现里 token 过期
// 瞬间的一批并发调用（心跳 + 每个入站 /api 请求都走 verifyToken）各自发一次
// POST /token——既是并发放大，也让整批调用各自多等一个 RTT。
describe('E-27 concurrent refresh single-flight', () => {
  async function freshAuth() {
    jest.resetModules();
    const axiosDefault = ((await import('axios')) as any).default;
    const { getCurrentToken, forceTokenRefresh } = await import('./auth');
    return { post: axiosDefault.post as jest.Mock, getCurrentToken, forceTokenRefresh };
  }

  it('fires exactly one POST /token for N concurrent callers with an expired token', async () => {
    const { post, getCurrentToken } = await freshAuth();

    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    post.mockImplementation(async () => {
      await held; // 把 /token 挂在飞行中，让所有调用者堆在同一扇门前
      return { status: 201, data: { code: 201, message: 'ok', data: { token: 'single-flight' } } };
    });

    const pending = Promise.all([
      getCurrentToken(),
      getCurrentToken(),
      getCurrentToken(),
      getCurrentToken(),
      getCurrentToken(),
    ]);
    // 让第一批调用推进到 await（此时 in-flight 门已建立）
    await new Promise((r) => setImmediate(r));
    release();

    await expect(pending).resolves.toEqual(Array(5).fill('single-flight'));
    expect(post).toHaveBeenCalledTimes(1);
  });

  it('clears the in-flight gate after settling so a later refresh still fetches', async () => {
    const { post, getCurrentToken, forceTokenRefresh } = await freshAuth();
    post.mockResolvedValue({
      status: 201,
      data: { code: 201, message: 'ok', data: { token: 'first' } },
    });
    await expect(getCurrentToken()).resolves.toBe('first');
    expect(post).toHaveBeenCalledTimes(1);

    // 强制刷新（R10 自愈路径）必须还能真的再发一次——去重门不得永久卡住
    post.mockResolvedValue({
      status: 201,
      data: { code: 201, message: 'ok', data: { token: 'second' } },
    });
    await expect(forceTokenRefresh()).resolves.toBe('second');
    expect(post).toHaveBeenCalledTimes(2);
  });

  it('concurrent forceTokenRefresh callers do not stack extra /token requests', async () => {
    // 单轮跑会漏检：判据曾用「刷新成功的时间戳 >= 等待者入场时间」，而刷新启动与
    // 等待者入场通常落在同一毫秒，只有恰好跨毫秒边界才暴露（旧实现 POST 2→4 次）。
    // 实测单轮失败率约 1/8，于是 CI 上表现为「偶发 flaky」而长期无人追。这里把同一
    // 场景重复 25 轮（每轮独立模块状态），把毫秒边界的偶发放大变成确定性回归。
    for (let round = 0; round < 25; round += 1) {
      const { post, getCurrentToken, forceTokenRefresh } = await freshAuth();
      post.mockResolvedValue({
        status: 201,
        data: { code: 201, message: 'ok', data: { token: 'cached' } },
      });
      await getCurrentToken();
      expect(post).toHaveBeenCalledTimes(1);

      let release!: () => void;
      const held = new Promise<void>((resolve) => { release = resolve; });
      post.mockImplementation(async () => {
        await held;
        return { status: 201, data: { code: 201, message: 'ok', data: { token: 'healed' } } };
      });

      const pending = Promise.all([forceTokenRefresh(), forceTokenRefresh(), forceTokenRefresh()]);
      await new Promise((r) => setImmediate(r));
      release();
      await pending;

      // 并发自愈不放大：一次成功刷新 + 至多一次追赶刷新，绝不 3 次
      const calls = (post as jest.Mock).mock.calls.length;
      if (calls > 2) {
        throw new Error(
          `第 ${round + 1}/25 轮出现并发刷新放大：POST /token 共 ${calls} 次（应 ≤2）`,
        );
      }
    }
  });
});

// ---------------------------------------------------------------------------
// P1-1（本轮审计，2026-10-26）：/token 409 慢性冲突——指数退避 + 冲突态暴露。
//
// 生产实证：同 push 地址存在旧指纹行时 admin 对 register/token 恒 409，旧实现
// 以心跳节拍（30s）无限重试（真机 7h 883 次），健康面零痕迹。修复后：
//   ① 409 单独走指数退避（30s 起步 ×2 封顶 10min），任何非 409 结果复位；
//   ② conflict 置位经 heartbeat-state 暴露到 /health 与 /health/admin-status。
// 用例直接驱动 performTokenRefresh 的公开入口（getCurrentToken /
// forceTokenRefresh），退避窗口用 Date.now 推进模拟时间流逝。
// ---------------------------------------------------------------------------
describe('P1-1 /token 409 conflict backoff + health exposure', () => {
  async function freshAuth() {
    jest.resetModules();
    const axiosDefault = ((await import('axios')) as any).default;
    const { getCurrentToken, forceTokenRefresh, __resetTokenConflictStateForTest } =
      await import('./auth');
    const heartbeatState = await import('../heartbeat-state');
    return {
      post: axiosDefault.post as jest.Mock,
      getCurrentToken,
      forceTokenRefresh,
      __resetTokenConflictStateForTest,
      heartbeatState,
    };
  }

  function conflict409(): { status: number; response: { status: number } } {
    // axios 形态的 409：fetchTokenWithRetry 对确定性 4xx 直接上抛，错误携带 response。
    const err: any = new Error('Request failed with status code 409');
    err.response = { status: 409 };
    err.status = 409;
    return err;
  }

  function conflict4xx(status: number) {
    const err: any = new Error(`Request failed with status code ${status}`);
    err.response = { status };
    err.status = status;
    return err;
  }

  it('escalates the retry interval across consecutive 409s (30s → 60s → 120s, capped at 10min)', async () => {
    const { post, forceTokenRefresh, __resetTokenConflictStateForTest, heartbeatState } =
      await freshAuth();
    __resetTokenConflictStateForTest();

    // 全程 409：每次 forceTokenRefresh 至多发 1 次 POST（409 是确定性拒绝，
    // fetchTokenWithRetry 不重试）。
    post.mockRejectedValue(conflict409());

    const now = Date.now();
    const spy = jest.spyOn(Date, 'now');
    try {
      // 第 1 次 409：立即发出（此前无失败锚点）。
      spy.mockReturnValue(now);
      await expect(forceTokenRefresh()).resolves.toBeNull();
      expect(heartbeatState.isRegistrationConflictActive()).toBe(true);
      const callsAfterFirst = post.mock.calls.length;
      expect(callsAfterFirst).toBe(1);

      // +31s：第一个冲突退避窗（30s）已过 → 第二次 409 发出。
      spy.mockReturnValue(now + 31_000);
      await forceTokenRefresh();
      expect(post.mock.calls.length).toBe(2);

      // +10s（距第 2 次失败 10s < 第二档 60s）→ 退避生效，不发。
      spy.mockReturnValue(now + 41_000);
      await forceTokenRefresh();
      expect(post.mock.calls.length).toBe(2);

      // 再过 55s（累计距第 2 次失败 65s > 60s）→ 第 3 次 409 发出（第三档 120s）。
      spy.mockReturnValue(now + 96_000);
      await forceTokenRefresh();
      expect(post.mock.calls.length).toBe(3);

      // 冲突间隔按 ×2 递增：距第 3 次失败 100s < 120s → 不发。
      spy.mockReturnValue(now + 196_000);
      await forceTokenRefresh();
      expect(post.mock.calls.length).toBe(3);

      // 再过 130s（> 120s）→ 第 4 次发出（第四档 240s）。
      spy.mockReturnValue(now + 326_000);
      await forceTokenRefresh();
      expect(post.mock.calls.length).toBe(4);

      // 封顶验证：把时间推到极远（> 全部档位之和），此后每次以 > 封顶窗
      //（601s > 600s）的间隔推进恰发一次、以 10s 的间隔不发——间隔已钉在
      // 10min 封顶，不再增长。
      spy.mockReturnValue(now + 326_000 + 601_000);
      await forceTokenRefresh();
      expect(post.mock.calls.length).toBe(5);
      spy.mockReturnValue(now + 326_000 + 2 * 601_000);
      await forceTokenRefresh();
      expect(post.mock.calls.length).toBe(6);
      // 距上次仅 10s（远小于封顶窗 600s）→ 退避生效，不发。
      spy.mockReturnValue(now + 326_000 + 2 * 601_000 + 10_000);
      await forceTokenRefresh();
      expect(post.mock.calls.length).toBe(6);
    } finally {
      spy.mockRestore();
      __resetTokenConflictStateForTest();
    }
  });

  it('resets the backoff after success (next failure starts from the base interval again)', async () => {
    const { post, forceTokenRefresh, __resetTokenConflictStateForTest, heartbeatState } =
      await freshAuth();
    __resetTokenConflictStateForTest();

    const now = Date.now();
    const spy = jest.spyOn(Date, 'now');
    try {
      spy.mockReturnValue(now);
      post.mockRejectedValue(conflict409());
      await forceTokenRefresh(); // 409 #1，退避 30s
      expect(post.mock.calls.length).toBe(1);

      // 冲突解除（admin 接管自愈成功）→ 成功响应。
      spy.mockReturnValue(now + 31_000);
      post.mockResolvedValueOnce({
        status: 201,
        data: { code: 201, message: 'ok', data: { token: 'healed', tokenHash: 'hash-1' } },
      });
      await expect(forceTokenRefresh()).resolves.toBe('healed');
      // 成功复位冲突态。
      expect(heartbeatState.isRegistrationConflictActive()).toBe(false);

      // 复位后再次失败：退避必须从 30s 基础档重新开始（不继承上一轮的 60s+），
      // 验证方式：成功后立即 409，再过 31s 即可重试（若继承 60s 档则发不出）。
      spy.mockReturnValue(now + 40_000);
      post.mockRejectedValue(conflict409());
      await forceTokenRefresh(); // 409 #2（新冲突第一拍）
      const callsAfterSecondConflict = post.mock.calls.length;
      spy.mockReturnValue(now + 40_000 + 31_000); // +31s：基础档 30s 已过
      post.mockRejectedValue(conflict409());
      await forceTokenRefresh();
      expect(post.mock.calls.length).toBe(callsAfterSecondConflict + 1);
    } finally {
      spy.mockRestore();
      __resetTokenConflictStateForTest();
    }
  });

  it('clears the conflict flag on a non-409 failure (ordinary errors do not inherit conflict pacing)', async () => {
    const { post, forceTokenRefresh, __resetTokenConflictStateForTest, heartbeatState } =
      await freshAuth();
    __resetTokenConflictStateForTest();

    const now = Date.now();
    const spy = jest.spyOn(Date, 'now');
    try {
      spy.mockReturnValue(now);
      post.mockRejectedValue(conflict409());
      await forceTokenRefresh();
      expect(heartbeatState.isRegistrationConflictActive()).toBe(true);

      // 一次普通网络错（非 409）→ 冲突态立即清除。
      spy.mockReturnValue(now + 61_000);
      post.mockRejectedValue(new Error('socket hang up'));
      await forceTokenRefresh();
      expect(heartbeatState.isRegistrationConflictActive()).toBe(false);
    } finally {
      spy.mockRestore();
      __resetTokenConflictStateForTest();
    }
  });

  it('does not treat other 4xx (e.g. 403) as a conflict and clears any prior conflict state', async () => {
    const { post, forceTokenRefresh, __resetTokenConflictStateForTest, heartbeatState } =
      await freshAuth();
    __resetTokenConflictStateForTest();

    const now = Date.now();
    const spy = jest.spyOn(Date, 'now');
    try {
      spy.mockReturnValue(now);
      post.mockRejectedValue(conflict409());
      await forceTokenRefresh();
      expect(heartbeatState.isRegistrationConflictActive()).toBe(true);

      // 403（版本门禁）不是地址冲突：不复位为「冲突」，清除既有冲突态。
      spy.mockReturnValue(now + 61_000);
      post.mockRejectedValue(conflict4xx(403));
      await forceTokenRefresh();
      expect(heartbeatState.isRegistrationConflictActive()).toBe(false);
    } finally {
      spy.mockRestore();
      __resetTokenConflictStateForTest();
    }
  });
});
