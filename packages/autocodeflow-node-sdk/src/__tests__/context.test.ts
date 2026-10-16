import {
  TaskContext,
  loadTypedParams,
  coerceParamValue,
  PARAMS_JSON_ENV_KEY,
} from '../context';
import { ERROR_MESSAGE_MAX_LENGTH, LOGS_MAX_LENGTH } from '../context';
import { TaskLogger } from '../logger';
import { TaskEnv } from '../types';

const baseEnv: TaskEnv = {
  executionId: 'exec-001',
  taskId: 'task-001',
  taskName: 'Test Task',
  adminApiUrl: 'http://localhost:3000',
  executorToken: 'test-token',
  traceId: 'trace-abc',
};

/**
 * ADR-017 阶段 3 (protocol v6) device fingerprint — the same 64-lowercase-hex
 * shape executor-node reports on register/heartbeat
 * (`sha256(deviceId + ':' + installSalt)`).
 */
const DEVICE_FP =
  '3f2a1c9d8b7e6f504132a5b6c7d8e9f00a1b2c3d4e5f60718293a4b5c6d7e8f9';

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

    it('exposes deviceFingerprint from an explicit TaskEnv (ADR-017 phase 3)', () => {
      const ctx = TaskContext.create({
        ...baseEnv,
        deviceFingerprint: DEVICE_FP,
      });
      expect(ctx.deviceFingerprint).toBe(DEVICE_FP);
      expect(ctx.env.deviceFingerprint).toBe(DEVICE_FP);
    });

    it('ctx.deviceFingerprint is undefined when the env lacks it', () => {
      expect(TaskContext.create(baseEnv).deviceFingerprint).toBeUndefined();
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

  describe('PK-24 — logs ring-buffer semantics in results', () => {
    it('result carries no logsDropped hint while the ring is below the cap', () => {
      const ctx = TaskContext.create(baseEnv);
      ctx.logger.info('hello');
      const result = ctx.success('done');
      expect(result.logs).toHaveLength(1);
      expect(result).not.toHaveProperty('logsDropped');
    });

    it('result surfaces a logsDropped hint once the ring overflows', () => {
      const ctx = TaskContext.create(baseEnv);
      const total = TaskLogger.MAX_ENTRIES + 10;
      for (let i = 0; i < total; i++) {
        ctx.logger.info(`line-${i}`);
      }
      const result = ctx.success('done');
      expect(result.logs).toHaveLength(TaskLogger.MAX_ENTRIES);
      expect(result.logsDropped).toBe(10);
      // 保留的是最新尾部
      expect(result.logs![0].message).toBe(`line-${10}`);
    });

    it('failure() reports the same logsDropped semantics', () => {
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      const ctx = TaskContext.create(baseEnv);
      for (let i = 0; i < TaskLogger.MAX_ENTRIES + 1; i++) {
        ctx.logger.warn(`w-${i}`);
      }
      const result = ctx.failure('boom');
      expect(result.logsDropped).toBe(1);
      expect(result.logs).toHaveLength(TaskLogger.MAX_ENTRIES);
      warnSpy.mockRestore();
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
          'AUTOFLOW_DEVICE_FINGERPRINT',
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
        delete process.env['AUTOFLOW_DEVICE_FINGERPRINT'];
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

        // ADR-017 阶段 3 (protocol v6): executor-node also injects the
        // stable install identity so callbacks can be attributed to a row
        // even on the shared/legacy token path.
        it('exposes AUTOFLOW_DEVICE_FINGERPRINT via ctx.deviceFingerprint', () => {
          Object.assign(process.env, trio, {
            AUTOFLOW_ADMIN_API_URL: 'http://admin-api:3105',
            AUTOFLOW_CALLBACK_TOKEN: EXEC_TOKEN,
            AUTOFLOW_EXECUTOR_ADDRESS: 'executor-node:8002',
            AUTOFLOW_DEVICE_FINGERPRINT: DEVICE_FP,
          });
          const ctx = TaskContext.fromEnv();
          expect(ctx.deviceFingerprint).toBe(DEVICE_FP);
          expect(ctx.env.deviceFingerprint).toBe(DEVICE_FP);
        });

        it('ctx.deviceFingerprint is undefined when the executor does not inject it (older executor)', () => {
          Object.assign(process.env, trio, {
            AUTOFLOW_ADMIN_API_URL: 'http://admin-api:3105',
            AUTOFLOW_CALLBACK_TOKEN: EXEC_TOKEN,
          });
          const ctx = TaskContext.fromEnv();
          expect(ctx.deviceFingerprint).toBeUndefined();
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
      deviceFingerprint: DEVICE_FP,
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
          deviceFingerprint: DEVICE_FP,
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
        {
          executionId: 'exec-001',
          status: 'success',
          executorAddress: 'executor-node:8002',
          deviceFingerprint: DEVICE_FP,
        },
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

    // ADR-017 阶段 3: deviceFingerprint is the callback face's row identity,
    // so it must reach reportSuccess/reportFailure items the same way
    // executorAddress does — and be omitted, not emptied, when unknown.
    it('reportSuccess stamps deviceFingerprint when known', async () => {
      const ctx = TaskContext.create({ ...baseEnv, deviceFingerprint: DEVICE_FP });
      (ctx as { http: unknown }).http = { post } as unknown;
      await ctx.reportSuccess();
      const [, items] = post.mock.calls[0] as [string, Array<Record<string, unknown>>];
      expect(items[0]).toMatchObject({ deviceFingerprint: DEVICE_FP });
    });

    it('reportSuccess omits deviceFingerprint entirely when unknown (never empty string)', async () => {
      const ctx = TaskContext.create(baseEnv); // no deviceFingerprint
      (ctx as { http: unknown }).http = { post } as unknown;
      await ctx.reportSuccess();
      const [, items] = post.mock.calls[0] as [string, Array<Record<string, unknown>>];
      expect(items[0]).not.toHaveProperty('deviceFingerprint');
    });

    it('reportFailure stamps deviceFingerprint when known', async () => {
      const ctx = TaskContext.create({ ...baseEnv, deviceFingerprint: DEVICE_FP });
      (ctx as { http: unknown }).http = { post } as unknown;
      await ctx.reportFailure(new Error('boom'));
      const [, items] = post.mock.calls[0] as [string, Array<Record<string, unknown>>];
      expect(items[0]).toMatchObject({ deviceFingerprint: DEVICE_FP });
    });

    it('reportFailure omits deviceFingerprint entirely when unknown (never empty string)', async () => {
      const ctx = TaskContext.create(baseEnv); // no deviceFingerprint
      (ctx as { http: unknown }).http = { post } as unknown;
      await ctx.reportFailure(new Error('boom'));
      const [, items] = post.mock.calls[0] as [string, Array<Record<string, unknown>>];
      expect(items[0]).not.toHaveProperty('deviceFingerprint');
    });

    it('omits deviceFingerprint when it is an empty string (never sent empty)', async () => {
      const ctx = TaskContext.create({ ...baseEnv, deviceFingerprint: '' });
      (ctx as { http: unknown }).http = { post } as unknown;
      await ctx.reportSuccess();
      const [, items] = post.mock.calls[0] as [string, Array<Record<string, unknown>>];
      expect(items[0]).not.toHaveProperty('deviceFingerprint');
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
        deviceFingerprint: DEVICE_FP,
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

    it('reportFailure rejects invalid failureReason locally without sending HTTP (NETOPT-F P3-2)', async () => {
      // 白名单早拒对齐 python SDK（callback.py VALID_FAILURE_REASONS）——非法值
      // 不发请求，否则 admin @IsIn 400 + 4xx 单发语义下任务代码只拿到远端错误。
      const ctx = ctxWithPost();
      // 本地早拒是同步 throw（不发 HTTP），用 toThrow 而非 rejects。
      expect(() =>
        ctx.reportFailure(new Error('x'), { failureReason: 'stale_recovered' }),
      ).toThrow(/invalid failureReason/);
      // stale_recovered 是 admin stale sweep 的溯源标记，上报方无从得知自己的
      // 执行是被谁终态化的——白名单收窄为 executorReportable 子集。
      expect(post).not.toHaveBeenCalled();
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

// ---------------------------------------------------------------------------
// A-11R: typed params channel (protocol v5) + per-key fallback type recovery.
//
// The per-key AUTOFLOW_<KEY> values are ALWAYS strings, so they cannot express
// the difference between the string "true" and the boolean true. Both executors
// therefore also inject the whole params object as one JSON document, and
// getParam() must prefer it.
// ---------------------------------------------------------------------------

describe('A-11R typed params channel', () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of [
      PARAMS_JSON_ENV_KEY,
      'EXECUTION_ID',
      'TASK_ID',
      'TASK_NAME',
      'AUTOFLOW_REGION',
      'AUTOFLOW_LIMIT',
      'AUTOFLOW_DRY_RUN',
      'AUTOFLOW_MODE',
      'AUTOFLOW_TAGS',
      'AUTOFLOW_RATIO',
    ]) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
    process.env['EXECUTION_ID'] = 'exec-a11r';
    process.env['TASK_ID'] = 'task-a11r';
    process.env['TASK_NAME'] = 'A-11R';
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('loadTypedParams returns undefined for absent / malformed / non-object', () => {
    expect(loadTypedParams(undefined)).toBeUndefined();
    expect(loadTypedParams('')).toBeUndefined();
    expect(loadTypedParams('{not json')).toBeUndefined();
    expect(loadTypedParams('[1,2]')).toBeUndefined();
    expect(loadTypedParams('"str"')).toBeUndefined();
    expect(loadTypedParams('null')).toBeUndefined();
    expect(loadTypedParams('{"a":1}')).toEqual({ a: 1 });
  });

  it('fromEnv prefers the typed channel and preserves real types', () => {
    process.env[PARAMS_JSON_ENV_KEY] = JSON.stringify({
      flag: true,
      count: 3,
      ratio: 1.5,
      nothing: null,
      tags: ['a', 2],
      nested: { b: true, a: 1 },
      text: '中文',
      empty: '',
    });
    // Real executors also inject the per-key copies; they must not downgrade.
    process.env['AUTOFLOW_LIMIT'] = '3';
    process.env['AUTOFLOW_TAGS'] = '["a",2]';

    const ctx = TaskContext.fromEnv();
    expect(ctx.getParam('flag')).toBe(true);
    expect(ctx.getParam('count')).toBe(3);
    expect(ctx.getParam('ratio')).toBe(1.5);
    expect(ctx.getParam('nothing')).toBeNull();
    expect(ctx.getParam('tags')).toEqual(['a', 2]);
    expect(ctx.getParam('nested')).toEqual({ b: true, a: 1 });
    expect(ctx.getParam('text')).toBe('中文');
    // An empty string is a real value, not an absent parameter.
    expect(ctx.getParam('empty')).toBe('');
  });

  it('distinguishes the string "true" from the boolean true', () => {
    process.env[PARAMS_JSON_ENV_KEY] = JSON.stringify({ flag: 'true' });
    process.env['AUTOFLOW_FLAG'] = 'true';
    const ctx = TaskContext.fromEnv();
    expect(ctx.getParam('flag')).toBe('true');
    expect(ctx.getParam('flag')).not.toBe(true);
  });

  it('matches keys case-insensitively (per-key names are upper-cased)', () => {
    process.env[PARAMS_JSON_ENV_KEY] = JSON.stringify({ LIMIT: 5, host: 'h' });
    const ctx = TaskContext.fromEnv();
    expect(ctx.getParam('limit')).toBe(5);
    expect(ctx.getParam('LIMIT')).toBe(5);
    expect(ctx.getParam('HOST')).toBe('h');
  });

  it('returns the fallback for a key absent from the typed channel', () => {
    process.env[PARAMS_JSON_ENV_KEY] = JSON.stringify({ a: 1 });
    const ctx = TaskContext.fromEnv();
    expect(ctx.getParam('missing')).toBeUndefined();
    expect(ctx.getParam('missing', 'dflt')).toBe('dflt');
  });

  it('falls back to per-key vars on pre-v5 executors without raising', () => {
    process.env['AUTOFLOW_REGION'] = '欧盟';
    process.env['AUTOFLOW_LIMIT'] = '3';
    process.env['AUTOFLOW_DRY_RUN'] = 'true';
    process.env['AUTOFLOW_TAGS'] = '["a",2]';
    process.env['AUTOFLOW_RATIO'] = '1.5';
    const ctx = TaskContext.fromEnv();
    expect(ctx.params).toBeUndefined();
    // Bare user strings stay strings — coercing "3" or a date would change
    // task behaviour and is not what the user typed.
    expect(ctx.getParam('region')).toBe('欧盟');
    expect(ctx.getParam('limit')).toBe('3');
    // JSON-rendered non-strings are recovered.
    expect(ctx.getParam('dry_run')).toBe(true);
    expect(ctx.getParam('tags')).toEqual(['a', 2]);
    expect(ctx.getParam('ratio')).toBe(1.5);
  });

  it('recovers A-11 quoted strings from old executors', () => {
    // A-11 (< v5) injected strings JSON-quoted — the regression that silently
    // stopped tasks for 12 days. `'""'` was additionally TRUTHY while
    // meaning the empty string.
    process.env['AUTOFLOW_REGION'] = '"欧盟"';
    process.env['AUTOFLOW_LIMIT'] = '"3"';
    process.env['AUTOFLOW_MODE'] = '""';
    const ctx = TaskContext.fromEnv();
    expect(ctx.getParam('region')).toBe('欧盟');
    expect(ctx.getParam('limit')).toBe('3');
    expect(ctx.getParam('mode')).toBe('');
  });

  it('coerceParamValue only decodes shapes JSON produces for non-strings', () => {
    expect(coerceParamValue('欧盟')).toBe('欧盟');
    expect(coerceParamValue('3')).toBe('3');
    expect(coerceParamValue('2024-06-01')).toBe('2024-06-01');
    expect(coerceParamValue('')).toBe('');
    expect(coerceParamValue('true')).toBe(true);
    expect(coerceParamValue('null')).toBeNull();
    expect(coerceParamValue('1.5')).toBe(1.5);
    expect(coerceParamValue('[1,"a"]')).toEqual([1, 'a']);
    expect(coerceParamValue('{not json')).toBe('{not json');
  });

  it('the typed channel key is exactly AUTOFLOW_PARAMS_JSON', () => {
    // Same literal as the executors (param-env.ts / routers/execute.py), the
    // console tooltip and the docs table — renaming it breaks the contract.
    expect(PARAMS_JSON_ENV_KEY).toBe('AUTOFLOW_PARAMS_JSON');
  });
});
