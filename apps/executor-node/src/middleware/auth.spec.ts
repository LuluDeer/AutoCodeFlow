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
