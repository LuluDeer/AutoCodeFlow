import { TaskContext } from '../context';
import { TaskEnv } from '../types';

const baseEnv: TaskEnv = {
  executionId: 'exec-001',
  taskId: 'task-001',
  taskName: 'Test Task',
  adminApiUrl: 'http://localhost:3000',
  executorToken: 'test-token',
  traceId: 'trace-abc',
};

describe('TaskContext', () => {
  describe('create()', () => {
    it('should expose env properties via shorthand getters', () => {
      const ctx = TaskContext.create(baseEnv);
      expect(ctx.executionId).toBe('exec-001');
      expect(ctx.taskId).toBe('task-001');
      expect(ctx.taskName).toBe('Test Task');
    });

    it('should attach collected logs to the result', () => {
      const ctx = TaskContext.create(baseEnv);
      ctx.logger.info('step 1');
      ctx.logger.warn('step 2');

      const result = ctx.success('done');
      expect(result.success).toBe(true);
      expect(result.logs).toHaveLength(2);
      expect(result.logs![0].level).toBe('info');
      expect(result.logs![1].level).toBe('warn');
    });
  });

  describe('success()', () => {
    it('should return a successful TaskResult with message and output', () => {
      const ctx = TaskContext.create(baseEnv);
      const result = ctx.success('all good', { count: 5 });
      expect(result.success).toBe(true);
      expect(result.message).toBe('all good');
      expect(result.output).toEqual({ count: 5 });
    });
  });

  describe('failure()', () => {
    it('should return a failed TaskResult with message', () => {
      const ctx = TaskContext.create(baseEnv);
      const result = ctx.failure('something went wrong');
      expect(result.success).toBe(false);
      expect(result.message).toBe('something went wrong');
    });
  });

  describe('fromEnv()', () => {
    it('should throw when a required env var is missing', () => {
      const original = process.env['EXECUTION_ID'];
      delete process.env['EXECUTION_ID'];
      expect(() => TaskContext.fromEnv()).toThrow(
        /missing required environment variable "EXECUTION_ID"/,
      );
      // restore
      if (original !== undefined) process.env['EXECUTION_ID'] = original;
    });

    // N23: the executor only injects the task-scoped trio; fromEnv must not
    // require Admin API credentials.
    describe('N23 — executor env contract', () => {
      const trio = {
        EXECUTION_ID: 'exec-n23',
        TASK_ID: 'task-n23',
        TASK_NAME: 'N23 Task',
      };
      let saved: Record<string, string | undefined>;

      beforeEach(() => {
        saved = {};
        for (const key of [
          ...Object.keys(trio),
          'ADMIN_API_URL',
          'EXECUTOR_TOKEN',
          'TRACE_ID',
        ]) {
          saved[key] = process.env[key];
        }
        for (const key of Object.keys(trio)) delete process.env[key];
        delete process.env['ADMIN_API_URL'];
        delete process.env['EXECUTOR_TOKEN'];
        delete process.env['TRACE_ID'];
      });

      afterEach(() => {
        for (const [key, value] of Object.entries(saved)) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
      });

      it('succeeds with only EXECUTION_ID/TASK_ID/TASK_NAME (real executor env)', () => {
        Object.assign(process.env, trio);
        const ctx = TaskContext.fromEnv();
        expect(ctx.executionId).toBe('exec-n23');
        expect(ctx.taskId).toBe('task-n23');
        expect(ctx.taskName).toBe('N23 Task');
      });

      it('leaves the http client explicitly disabled without credentials', async () => {
        Object.assign(process.env, trio);
        const ctx = TaskContext.fromEnv();
        expect(ctx.http.enabled).toBe(false);
        expect(ctx.http.disabledReason).toMatch(/ADMIN_API_URL/);
        await expect(ctx.http.post('/api/tasks/trigger', {})).rejects.toThrow(
          /HttpClient is disabled/,
        );
      });

      it('enables the http client when credentials are present', () => {
        Object.assign(process.env, trio, {
          ADMIN_API_URL: 'http://admin:3105',
          EXECUTOR_TOKEN: 'tok',
        });
        const ctx = TaskContext.fromEnv();
        expect(ctx.http.enabled).toBe(true);
      });

      it('still throws when TASK_ID or TASK_NAME is missing', () => {
        const { TASK_ID: _omit, ...rest } = trio;
        Object.assign(process.env, rest);
        expect(() => TaskContext.fromEnv()).toThrow(
          /missing required environment variable "TASK_ID"/,
        );
      });
    });
  });
});
