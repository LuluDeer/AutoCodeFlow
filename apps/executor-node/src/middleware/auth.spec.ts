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
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('fetches dynamic tokens without double-prefixing /api admin URLs', async () => {
    mockedAxios.post.mockResolvedValue({ status: 200, data: { token: 'dynamic-token' } });

    const { getCurrentToken } = await import('./auth');
    await expect(getCurrentToken()).resolves.toBe('dynamic-token');

    expect(mockedAxios.post).toHaveBeenCalledWith(
      'http://admin-public:3105/api/executors/token',
      {
        address: 'localhost:3002',
        appName: 'test-executor',
      },
      { timeout: 10000, headers: {} },
    );
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
