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
      expect(mockedAxios.create).toHaveBeenCalledWith({ baseURL: BASE_URL });
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
});
