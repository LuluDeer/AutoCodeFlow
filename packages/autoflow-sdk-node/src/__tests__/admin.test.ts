import axios from 'axios';
import {
  AutoFlowAdminClient,
  RegisterExecutorOptions,
  HeartbeatOptions,
  TriggerTaskOptions,
} from '../admin';

jest.mock('axios');

const mockedAxios = axios as jest.Mocked<typeof axios>;

describe('AutoFlowAdminClient', () => {
  let mockHttp: {
    get: jest.Mock;
    post: jest.Mock;
  };

  beforeEach(() => {
    mockHttp = {
      get: jest.fn(),
      post: jest.fn(),
    };
    mockedAxios.create.mockReturnValue(mockHttp as any);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('constructor', () => {
    it('creates axios instance with baseURL and default timeout', () => {
      new AutoFlowAdminClient({ baseURL: 'http://admin:8000' });
      expect(mockedAxios.create).toHaveBeenCalledWith(
        expect.objectContaining({
          baseURL: 'http://admin:8000',
          timeout: 10_000,
        }),
      );
    });

    it('sets Authorization header when apiKey is provided', () => {
      new AutoFlowAdminClient({ baseURL: 'http://admin:8000', apiKey: 'secret' });
      expect(mockedAxios.create).toHaveBeenCalledWith(
        expect.objectContaining({
          headers: { Authorization: 'Bearer secret' },
        }),
      );
    });

    it('uses empty headers object when no apiKey', () => {
      new AutoFlowAdminClient({ baseURL: 'http://admin:8000' });
      expect(mockedAxios.create).toHaveBeenCalledWith(
        expect.objectContaining({ headers: {} }),
      );
    });

    it('respects custom timeoutMs', () => {
      new AutoFlowAdminClient({ baseURL: 'http://admin:8000', timeoutMs: 5_000 });
      expect(mockedAxios.create).toHaveBeenCalledWith(
        expect.objectContaining({ timeout: 5_000 }),
      );
    });
  });

  describe('registerExecutor()', () => {
    it('posts to /api/executors/register and returns data', async () => {
      mockHttp.post.mockResolvedValue({
        data: { executorId: 'exec-1', token: 'tok-abc' },
      });
      const client = new AutoFlowAdminClient({ baseURL: 'http://admin:8000' });
      const opts: RegisterExecutorOptions = {
        name: 'my-exec',
        address: 'http://exec:8080',
        runtimes: ['python', 'node'],
      };
      const res = await client.registerExecutor(opts);
      expect(mockHttp.post).toHaveBeenCalledWith('/api/executors/register', opts);
      expect(res.executorId).toBe('exec-1');
      expect(res.token).toBe('tok-abc');
    });
  });

  describe('heartbeat()', () => {
    it('posts to /api/executors/:id/heartbeat with defaults', async () => {
      mockHttp.post.mockResolvedValue({ data: {} });
      const client = new AutoFlowAdminClient({ baseURL: 'http://admin:8000' });
      const opts: HeartbeatOptions = { executorId: 'exec-1' };
      await client.heartbeat(opts);
      expect(mockHttp.post).toHaveBeenCalledWith(
        '/api/executors/exec-1/heartbeat',
        { status: 'idle', activeJobs: 0 },
      );
    });

    it('forwards custom status and activeJobs', async () => {
      mockHttp.post.mockResolvedValue({ data: {} });
      const client = new AutoFlowAdminClient({ baseURL: 'http://admin:8000' });
      await client.heartbeat({ executorId: 'exec-2', status: 'busy', activeJobs: 3 });
      expect(mockHttp.post).toHaveBeenCalledWith(
        '/api/executors/exec-2/heartbeat',
        { status: 'busy', activeJobs: 3 },
      );
    });
  });

  describe('triggerTask()', () => {
    it('posts to /api/tasks/trigger and returns executionId', async () => {
      mockHttp.post.mockResolvedValue({
        data: { executionId: 'run-99', status: 'pending' },
      });
      const client = new AutoFlowAdminClient({ baseURL: 'http://admin:8000' });
      const opts: TriggerTaskOptions = {
        taskId: 'daily-report',
        params: { date: '2024-01-01' },
      };
      const res = await client.triggerTask(opts);
      expect(mockHttp.post).toHaveBeenCalledWith('/api/tasks/trigger', opts);
      expect(res.executionId).toBe('run-99');
      expect(res.status).toBe('pending');
    });
  });

  describe('getExecutionStatus()', () => {
    it('gets /api/executions/:id and returns status data', async () => {
      mockHttp.get.mockResolvedValue({
        data: { executionId: 'run-99', status: 'success', result: { rows: 10 } },
      });
      const client = new AutoFlowAdminClient({ baseURL: 'http://admin:8000' });
      const res = await client.getExecutionStatus('run-99');
      expect(mockHttp.get).toHaveBeenCalledWith('/api/executions/run-99');
      expect(res.status).toBe('success');
      expect(res.result).toEqual({ rows: 10 });
    });

    it('returns status without result when not provided', async () => {
      mockHttp.get.mockResolvedValue({
        data: { executionId: 'run-50', status: 'running' },
      });
      const client = new AutoFlowAdminClient({ baseURL: 'http://admin:8000' });
      const res = await client.getExecutionStatus('run-50');
      expect(res.status).toBe('running');
      expect(res.result).toBeUndefined();
    });
  });
});
