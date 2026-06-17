import axios from 'axios';
import { AutoFlowHTTP } from '../http';

jest.mock('axios');

const mockedAxios = axios as jest.Mocked<typeof axios>;

describe('AutoFlowHTTP', () => {
  let mockClient: {
    get: jest.Mock;
    post: jest.Mock;
    put: jest.Mock;
    delete: jest.Mock;
  };

  beforeEach(() => {
    mockClient = {
      get: jest.fn(),
      post: jest.fn(),
      put: jest.fn(),
      delete: jest.fn(),
    };
    mockedAxios.create.mockReturnValue(mockClient as any);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('constructor', () => {
    it('creates an axios instance with default 30s timeout', () => {
      new AutoFlowHTTP();
      expect(mockedAxios.create).toHaveBeenCalledWith(
        expect.objectContaining({ timeout: 30_000 }),
      );
    });

    it('merges caller config over defaults', () => {
      new AutoFlowHTTP({ timeout: 5_000, baseURL: 'http://example.com' });
      expect(mockedAxios.create).toHaveBeenCalledWith(
        expect.objectContaining({ timeout: 5_000, baseURL: 'http://example.com' }),
      );
    });
  });

  describe('get()', () => {
    it('calls client.get with the url', async () => {
      mockClient.get.mockResolvedValue({ status: 200, data: { ok: true } });
      const http = new AutoFlowHTTP();
      const res = await http.get('http://api.example.com/data');
      expect(mockClient.get).toHaveBeenCalledWith('http://api.example.com/data', undefined);
      expect(res.data).toEqual({ ok: true });
    });

    it('forwards options to client.get', async () => {
      mockClient.get.mockResolvedValue({ status: 200, data: {} });
      const http = new AutoFlowHTTP();
      const opts = { headers: { Authorization: 'Bearer tok' } };
      await http.get('/path', opts);
      expect(mockClient.get).toHaveBeenCalledWith('/path', opts);
    });
  });

  describe('post()', () => {
    it('calls client.post with url and data', async () => {
      mockClient.post.mockResolvedValue({ status: 201, data: { id: '1' } });
      const http = new AutoFlowHTTP();
      const res = await http.post('/items', { name: 'test' });
      expect(mockClient.post).toHaveBeenCalledWith('/items', { name: 'test' }, undefined);
      expect(res.status).toBe(201);
    });

    it('allows post without data', async () => {
      mockClient.post.mockResolvedValue({ status: 200, data: {} });
      const http = new AutoFlowHTTP();
      await http.post('/ping');
      expect(mockClient.post).toHaveBeenCalledWith('/ping', undefined, undefined);
    });
  });

  describe('put()', () => {
    it('calls client.put with url and data', async () => {
      mockClient.put.mockResolvedValue({ status: 200, data: {} });
      const http = new AutoFlowHTTP();
      await http.put('/items/1', { name: 'updated' });
      expect(mockClient.put).toHaveBeenCalledWith('/items/1', { name: 'updated' }, undefined);
    });
  });

  describe('delete()', () => {
    it('calls client.delete with the url', async () => {
      mockClient.delete.mockResolvedValue({ status: 204, data: null });
      const http = new AutoFlowHTTP();
      await http.delete('/items/1');
      expect(mockClient.delete).toHaveBeenCalledWith('/items/1', undefined);
    });
  });
});
