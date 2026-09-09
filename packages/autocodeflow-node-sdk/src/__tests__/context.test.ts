import { TaskContext } from '../context';
import { ERROR_MESSAGE_MAX_LENGTH, LOGS_MAX_LENGTH } from '../context';
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

  // ECO-01: node-side callback shorthands mirroring the python SDK's
  // ctx.report_success / ctx.report_failure — item shape, defaults,
  // truncation caps and the omitted-vs-empty executorAddress behavior
  // must stay byte-comparable across the two SDKs.
  describe('callback shorthands (ECO-01, python parity)', () => {
    const CRED_ENV: TaskEnv = {
      ...baseEnv,
      executorAddress: 'executor-node:8002',
    };
    let post: jest.Mock;

    beforeEach(() => {
      jest.mock('axios');
      post = jest.fn().mockResolvedValue({ results: [] });
      // bypass the real HttpClient: stub ctx.http.post directly
    });

    function ctxWithPost(): TaskContext {
      const ctx = TaskContext.create(CRED_ENV);
      // Replace the axios-backed client's post with a spy — item shape is
      // what this suite asserts, not transport behavior (covered elsewhere).
      (ctx as { http: unknown }).http = { post } as unknown;
      return ctx;
    }

    it('reportSuccess posts status=success with executionId pinned', async () => {
      const ctx = ctxWithPost();
      await ctx.reportSuccess({ summary: '3 rows written', durationMs: 1234 });
      expect(post).toHaveBeenCalledTimes(1);
      const [url, items] = post.mock.calls[0] as [string, Array<Record<string, unknown>>];
      expect(url).toBe('/api/executions/callback');
      expect(items).toEqual([
        {
          executionId: 'exec-001',
          status: 'success',
          executorAddress: 'executor-node:8002',
          logs: '3 rows written',
          durationMs: 1234,
        },
      ]);
    });

    it('reportSuccess omits logs/durationMs when not provided', async () => {
      const ctx = ctxWithPost();
      await ctx.reportSuccess();
      const [, items] = post.mock.calls[0] as [string, Array<Record<string, unknown>>];
      expect(items).toEqual([
        { executionId: 'exec-001', status: 'success', executorAddress: 'executor-node:8002' },
      ]);
      expect(items[0]).not.toHaveProperty('logs');
      expect(items[0]).not.toHaveProperty('durationMs');
    });

    it('reportSuccess omits executorAddress entirely when unknown (never empty string)', async () => {
      const ctx = TaskContext.create(baseEnv); // no executorAddress
      (ctx as { http: unknown }).http = { post } as unknown;
      await ctx.reportSuccess();
      const [, items] = post.mock.calls[0] as [string, Array<Record<string, unknown>>];
      expect(items[0]).not.toHaveProperty('executorAddress');
    });

    it('reportFailure defaults to failureReason=script_error and maps error message', async () => {
      const ctx = ctxWithPost();
      await ctx.reportFailure(new Error('upstream 503'));
      const [, items] = post.mock.calls[0] as [string, Array<Record<string, unknown>>];
      expect(items[0]).toMatchObject({
        executionId: 'exec-001',
        status: 'failed',
        errorMessage: 'upstream 503',
        failureReason: 'script_error',
        executorAddress: 'executor-node:8002',
      });
    });

    it('reportFailure stringifies non-Error values and accepts a custom reason', async () => {
      const ctx = ctxWithPost();
      await ctx.reportFailure({ code: 7 }, { failureReason: 'timeout', durationMs: 42 });
      const [, items] = post.mock.calls[0] as [string, Array<Record<string, unknown>>];
      expect(items[0]).toMatchObject({
        errorMessage: '{"code":7}',
        failureReason: 'timeout',
        durationMs: 42,
      });
    });

    it('reportFailure truncates errorMessage to the 4 KB DTO cap', async () => {
      const ctx = ctxWithPost();
      await ctx.reportFailure('x'.repeat(ERROR_MESSAGE_MAX_LENGTH + 100));
      const [, items] = post.mock.calls[0] as [string, Array<Record<string, unknown>>];
      expect((items[0].errorMessage as string).length).toBe(ERROR_MESSAGE_MAX_LENGTH);
    });

    it('reportSuccess truncates summary to the 512 KB logs cap', async () => {
      const ctx = ctxWithPost();
      await ctx.reportSuccess({ summary: 'y'.repeat(LOGS_MAX_LENGTH + 1) });
      const [, items] = post.mock.calls[0] as [string, Array<Record<string, unknown>>];
      expect((items[0].logs as string).length).toBe(LOGS_MAX_LENGTH);
    });

    it('shorthands surface the disabled-client rejection instead of swallowing it', async () => {
      // Disabled client: credentials absent → the real HttpClient must reject.
      const disabled = TaskContext.create({
        executionId: 'e',
        taskId: 't',
        taskName: 'n',
      });
      await expect(disabled.reportSuccess()).rejects.toThrow(/HttpClient is disabled/);
      await expect(disabled.reportFailure(new Error('x'))).rejects.toThrow(
        /HttpClient is disabled/,
      );
    });
  });
});
