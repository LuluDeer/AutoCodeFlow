import axios from 'axios';
import { HttpClient } from '../http-client';

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
    interceptors: { request: { use: jest.Mock } };
  };

  beforeEach(() => {
    mockInstance = {
      get: jest.fn(),
      post: jest.fn(),
      put: jest.fn(),
      delete: jest.fn(),
      interceptors: { request: { use: jest.fn() } },
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
});
