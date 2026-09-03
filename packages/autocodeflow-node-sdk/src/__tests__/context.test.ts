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

    it('exposes executorAddress from an explicit TaskEnv (N27)', () => {
      const ctx = TaskContext.create({
        ...baseEnv,
        executorAddress: 'executor-node:8002',
      });
      expect(ctx.executorAddress).toBe('executor-node:8002');
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
          'AUTOFLOW_ADMIN_API_URL',
          'AUTOFLOW_CALLBACK_TOKEN',
          'AUTOFLOW_EXECUTOR_ADDRESS',
        ]) {
          saved[key] = process.env[key];
        }
        for (const key of Object.keys(trio)) delete process.env[key];
        delete process.env['ADMIN_API_URL'];
        delete process.env['EXECUTOR_TOKEN'];
        delete process.env['TRACE_ID'];
        delete process.env['AUTOFLOW_ADMIN_API_URL'];
        delete process.env['AUTOFLOW_CALLBACK_TOKEN'];
        delete process.env['AUTOFLOW_EXECUTOR_ADDRESS'];
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

      // N23 (round 8): executor-node now injects a per-execution callback
      // token + admin API URL, so fromEnv enables the client out of the box.
      describe('N23 per-execution callback env', () => {
        const EXEC_TOKEN =
          'v1.exec-n23.2000000000.' +
          '29f7b55965d77d10204409c0146d78628d5d06b86f4c32d8a2778cc2fb84e56b';

        it('enables the http client from AUTOFLOW_ADMIN_API_URL + AUTOFLOW_CALLBACK_TOKEN', () => {
          Object.assign(process.env, trio, {
            AUTOFLOW_ADMIN_API_URL: 'http://admin-api:3105',
            AUTOFLOW_CALLBACK_TOKEN: EXEC_TOKEN,
          });
          const ctx = TaskContext.fromEnv();
          expect(ctx.http.enabled).toBe(true);
          expect(ctx.env.adminApiUrl).toBe('http://admin-api:3105');
          expect(ctx.env.executorToken).toBe(EXEC_TOKEN);
        });

        it('stays disabled when only AUTOFLOW_ADMIN_API_URL is present (no token)', () => {
          Object.assign(process.env, trio, {
            AUTOFLOW_ADMIN_API_URL: 'http://admin-api:3105',
          });
          const ctx = TaskContext.fromEnv();
          expect(ctx.http.enabled).toBe(false);
        });

        it('stays disabled when only AUTOFLOW_CALLBACK_TOKEN is present (no URL)', () => {
          Object.assign(process.env, trio, {
            AUTOFLOW_CALLBACK_TOKEN: EXEC_TOKEN,
          });
          const ctx = TaskContext.fromEnv();
          expect(ctx.http.enabled).toBe(false);
        });

        it('legacy ADMIN_API_URL / EXECUTOR_TOKEN take precedence over AUTOFLOW_*', () => {
          Object.assign(process.env, trio, {
            ADMIN_API_URL: 'http://legacy:3105',
            EXECUTOR_TOKEN: 'legacy-token',
            AUTOFLOW_ADMIN_API_URL: 'http://admin-api:3105',
            AUTOFLOW_CALLBACK_TOKEN: EXEC_TOKEN,
          });
          const ctx = TaskContext.fromEnv();
          expect(ctx.env.adminApiUrl).toBe('http://legacy:3105');
          expect(ctx.env.executorToken).toBe('legacy-token');
          expect(ctx.http.enabled).toBe(true);
        });

        // N27 (round 8): executor-node now also injects its registered
        // address so callback items can carry it without hardcoding.
        it('exposes AUTOFLOW_EXECUTOR_ADDRESS via ctx.executorAddress', () => {
          Object.assign(process.env, trio, {
            AUTOFLOW_ADMIN_API_URL: 'http://admin-api:3105',
            AUTOFLOW_CALLBACK_TOKEN: EXEC_TOKEN,
            AUTOFLOW_EXECUTOR_ADDRESS: 'executor-node:8002',
          });
          const ctx = TaskContext.fromEnv();
          expect(ctx.executorAddress).toBe('executor-node:8002');
          expect(ctx.env.executorAddress).toBe('executor-node:8002');
        });

        it('ctx.executorAddress is undefined when the executor does not inject it (older executor)', () => {
          Object.assign(process.env, trio, {
            AUTOFLOW_ADMIN_API_URL: 'http://admin-api:3105',
            AUTOFLOW_CALLBACK_TOKEN: EXEC_TOKEN,
          });
          const ctx = TaskContext.fromEnv();
          expect(ctx.executorAddress).toBeUndefined();
        });
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
