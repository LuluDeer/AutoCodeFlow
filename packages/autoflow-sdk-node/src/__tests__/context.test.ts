import { AutoFlowContext } from '../context';
import { getLogger } from '../logger';
import { AutoFlowHTTP } from '../http';

describe('AutoFlowContext', () => {
  describe('constructor', () => {
    it('sets executionId, taskId, taskName, and params', () => {
      const ctx = new AutoFlowContext({
        executionId: 'exec-001',
        taskId: 'task-001',
        taskName: 'My Task',
        params: { key: 'value' },
      });
      expect(ctx.executionId).toBe('exec-001');
      expect(ctx.taskId).toBe('task-001');
      expect(ctx.taskName).toBe('My Task');
      expect(ctx.params).toEqual({ key: 'value' });
    });

    it('defaults taskName to taskId when not provided', () => {
      const ctx = new AutoFlowContext({ executionId: 'e1', taskId: 'task-x' });
      expect(ctx.taskName).toBe('task-x');
    });

    it('defaults params to empty object when not provided', () => {
      const ctx = new AutoFlowContext({ executionId: 'e1', taskId: 't1' });
      expect(ctx.params).toEqual({});
    });

    it('exposes a logger instance', () => {
      const ctx = new AutoFlowContext({ executionId: 'e1', taskId: 't1' });
      expect(ctx.logger).toBeDefined();
      expect(typeof ctx.logger.info).toBe('function');
    });

    it('exposes an http instance', () => {
      const ctx = new AutoFlowContext({ executionId: 'e1', taskId: 't1' });
      expect(ctx.http).toBeDefined();
      expect(typeof ctx.http.get).toBe('function');
    });
  });

  describe('fromEnv()', () => {
    const ORIGINAL_ENV = process.env;

    beforeEach(() => {
      process.env = { ...ORIGINAL_ENV };
    });

    afterEach(() => {
      process.env = ORIGINAL_ENV;
    });

    it('reads EXECUTION_ID, TASK_ID, TASK_NAME from environment', () => {
      process.env.EXECUTION_ID = 'env-exec';
      process.env.TASK_ID = 'env-task';
      process.env.TASK_NAME = 'Env Task';
      const ctx = AutoFlowContext.fromEnv();
      expect(ctx.executionId).toBe('env-exec');
      expect(ctx.taskId).toBe('env-task');
      expect(ctx.taskName).toBe('Env Task');
    });

    it('maps AUTOFLOW_* env vars to params', () => {
      process.env.AUTOFLOW_DATE = '2024-01-01';
      process.env.AUTOFLOW_OUTPUT_PATH = '/data';
      const ctx = AutoFlowContext.fromEnv();
      expect(ctx.params['date']).toBe('2024-01-01');
      expect(ctx.params['output_path']).toBe('/data');
    });

    it('falls back to "unknown" when env vars are not set', () => {
      delete process.env.EXECUTION_ID;
      delete process.env.TASK_ID;
      delete process.env.TASK_NAME;
      const ctx = AutoFlowContext.fromEnv();
      expect(ctx.executionId).toBe('unknown');
      expect(ctx.taskId).toBe('unknown');
    });
  });

  describe('getParam()', () => {
    it('returns the param value when it exists', () => {
      const ctx = new AutoFlowContext({
        executionId: 'e1',
        taskId: 't1',
        params: { date: '2024-01-01' },
      });
      expect(ctx.getParam('date')).toBe('2024-01-01');
    });

    it('returns defaultValue when param does not exist', () => {
      const ctx = new AutoFlowContext({ executionId: 'e1', taskId: 't1' });
      expect(ctx.getParam('missing', 'fallback')).toBe('fallback');
    });

    it('returns undefined when param missing and no default given', () => {
      const ctx = new AutoFlowContext({ executionId: 'e1', taskId: 't1' });
      expect(ctx.getParam('missing')).toBeUndefined();
    });
  });

  describe('getConfig() / setConfig()', () => {
    it('returns defaultValue when config key not set', () => {
      const ctx = new AutoFlowContext({ executionId: 'e1', taskId: 't1' });
      expect(ctx.getConfig('key', 'default')).toBe('default');
    });

    it('stores and retrieves config values', () => {
      const ctx = new AutoFlowContext({ executionId: 'e1', taskId: 't1' });
      ctx.setConfig('db_url', 'postgresql://localhost/test');
      expect(ctx.getConfig('db_url')).toBe('postgresql://localhost/test');
    });
  });

  describe('success() / failure()', () => {
    it('success() returns TaskResult with success=true', () => {
      const ctx = new AutoFlowContext({ executionId: 'e1', taskId: 't1' });
      expect(ctx.success({ count: 5 })).toEqual({ success: true, data: { count: 5 } });
    });

    it('success() allows no data argument', () => {
      const ctx = new AutoFlowContext({ executionId: 'e1', taskId: 't1' });
      expect(ctx.success()).toEqual({ success: true, data: undefined });
    });

    it('failure() returns TaskResult with success=false', () => {
      const ctx = new AutoFlowContext({ executionId: 'e1', taskId: 't1' });
      expect(ctx.failure('something went wrong')).toEqual({
        success: false,
        error: 'something went wrong',
      });
    });
  });
});
