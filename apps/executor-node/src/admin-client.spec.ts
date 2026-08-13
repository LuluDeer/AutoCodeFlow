import axios from 'axios';
import {
  failover,
  getAllAdminUrls,
  getCurrentAdminUrl,
  initAdminClients,
  checkAdminApiConnectivity,
  post,
  request,
} from './admin-client';
import { getCurrentToken } from './middleware/auth';

jest.mock('axios');
jest.mock('./middleware/auth', () => ({
  getCurrentToken: jest.fn(),
}));
jest.mock('./logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
  },
}));

const mockedAxios = axios as jest.Mocked<typeof axios>;
const mockedGetCurrentToken = getCurrentToken as jest.MockedFunction<typeof getCurrentToken>;

describe('admin-client', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedGetCurrentToken.mockResolvedValue(null);
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
});
