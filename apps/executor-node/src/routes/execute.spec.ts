import request from 'supertest';
import express from 'express';
import * as fs from 'fs';
import * as path from 'path';
import * as childProcess from 'child_process';
import { EventEmitter } from 'events';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

jest.mock('fs');
jest.mock('child_process');
// verifyToken (mounted on appWithAuth) calls refreshTokenIfNeeded -> axios.post
// on every request; automock keeps that a fast no-op (fetch fails -> falls back
// to the static token captured from the config mock below).
jest.mock('axios');

jest.mock('../config', () => ({
  config: {
    workDir: '/tmp/test-workdir',
    maxConcurrentTasks: 10,
    appName: 'test-executor',
    executorAddress: 'localhost:8002',
    taskTimeoutSeconds: 300,
    token: 'test-shared-secret',
    executionCallbackSecret: '',
    adminApiUrl: 'http://admin-api:3105',
    adminApiUrlInternal: 'http://admin-api:3105',
    npmRegistryUrl: '',
    npmRegistryToken: '',
  },
}));

jest.mock('../logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

// Provide a real SharedArrayBuffer-backed Int32Array for getRunningCountArray
const _sharedBuf = new SharedArrayBuffer(4);
const _runningCountArr = new Int32Array(_sharedBuf);
jest.mock('../scheduler', () => ({
  incrementRunning: jest.fn(),
  decrementRunning: jest.fn(),
  runningCount: 0,
  getRunningCountArray: jest.fn(() => _runningCountArr),
  getRunningCount: jest.fn(() => 0),
  // STALE-01 心跳 provider 注册（execute.ts 模块加载时调用）
  registerRunningExecutionIdsProvider: jest.fn(),
  registerDeadLetterCountProvider: jest.fn(),
}));

jest.mock('../manifest', () => ({
  loadManifest: jest.fn(() => ({})),
  mergeTaskWithManifest: jest.fn((_task: any, _manifest: any) => _task),
}));

jest.mock('../callback', () => ({
  pushCallback: jest.fn(),
  truncateCallbackErrorMessage: jest.fn((m?: string) => m),
}));

jest.mock('../file-logger', () => ({ appendLog: jest.fn() }));

// Worker stub that mirrors the real TaskWorker contract:
// - runPrepared (prepare + spawn) is invoked when the execution's turn comes;
// - ExecutionCancelledError (kill) → silent return, onComplete NOT called
//   (the kill endpoint owns the callback + capacity release);
// - any other outcome → onComplete afterwards.
// cancelExecution default is false ("execution already running"); kill tests
// override per-case.
jest.mock('../task-worker', () => {
  class ExecutionCancelledErrorStub extends Error {
    constructor(executionId: string) {
      super(`Execution ${executionId} was cancelled`);
      this.name = 'ExecutionCancelledError';
    }
  }
  return {
    ExecutionCancelledError: ExecutionCancelledErrorStub,
    taskWorkerManager: {
      execute: jest.fn(
        async (
          _taskId: string,
          _execId: string,
          _task: any,
          _params: any,
          onComplete?: () => void,
          runPrepared?: (assertNotCancelled: () => void) => Promise<{ task: any; params: Record<string, any> }>,
        ) => {
        try {
          if (runPrepared) await runPrepared(() => undefined);
        } catch {
          // 真实 worker 同款：取消/失败均不阻断 finally 语义——onComplete
          // 照常调用（entry.release 幂等，kill 端点已收尾时二次释放无害）
          if (onComplete) onComplete();
          return;
        }
        if (onComplete) onComplete();
        },
      ),
      cancelExecution: jest.fn(() => false),
    },
  };
});

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

import { executeRouter, runTask, gitCheckoutTo, killRunningTaskProcesses, BoundedLogBuffer } from './execute';
import { buildNpmRcContent, executionExists } from './execute';
import { pushCallback } from '../callback';
import { taskWorkerManager } from '../task-worker';
import { config as testConfig } from '../config';
import { verifyToken } from '../middleware/auth';

const mockFs = fs as jest.Mocked<typeof fs>;
const mockCp = childProcess as jest.Mocked<typeof childProcess>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildApp(...middleware: Array<(req: any, res: any, next: any) => void>) {
  const app = express();
  app.use(express.json());
  for (const mw of middleware) app.use('/api', mw);
  app.use('/api', executeRouter);
  return app;
}

const appNoAuth = buildApp();
// verifyToken compares against STATIC_TOKEN = config.token captured at module
// load (the config mock above pins it to 'test-shared-secret'), so the bearer
// used by the auth tests must match that value — not an env var (verifyToken
// never reads EXECUTOR_SHARED_TOKEN directly; config.ts resolves it once).
const AUTH_TOKEN = 'test-shared-secret';
const appWithAuth = buildApp(verifyToken);

function flushAsync() {
  return new Promise(r => setImmediate(r));
}

function okSpawn(code: number | null = 0) {
  return {
    stdout: { on: jest.fn() },
    stderr: { on: jest.fn() },
    on: jest.fn((event: string, cb: Function) => {
      if (event === 'close') setImmediate(() => cb(code));
    }),
    kill: jest.fn(),
    pid: 12345,
  };
}

// ---------------------------------------------------------------------------
// beforeEach
// ---------------------------------------------------------------------------

beforeEach(() => {
  jest.clearAllMocks();
  Atomics.store(_runningCountArr, 0, 0);
  delete process.env.EXECUTOR_SHARED_TOKEN;
  delete process.env.NPM_REGISTRY_TOKEN;
  (mockFs.existsSync as jest.Mock).mockReturnValue(false);
  (mockFs.mkdirSync as jest.Mock).mockReturnValue(undefined);
  (mockFs.chmodSync as jest.Mock).mockReturnValue(undefined);
  (mockFs.writeFileSync as jest.Mock).mockReturnValue(undefined);
  (mockFs.lstatSync as jest.Mock).mockReturnValue({ isSymbolicLink: () => false });
  (mockFs.realpathSync as unknown as jest.Mock).mockImplementation((p: string) => p);
  // Reset config
  testConfig.npmRegistryUrl = '';
  testConfig.npmRegistryToken = '';
  testConfig.token = 'test-shared-secret';
  testConfig.executionCallbackSecret = '';
  testConfig.maxConcurrentTasks = 10;
  testConfig.taskTimeoutSeconds = 300;
});

afterEach(() => {
  delete process.env.EXECUTOR_SHARED_TOKEN;
});

// ---------------------------------------------------------------------------
// Auth (S-01) — /api/execute + kill guarded by the现役 verifyToken middleware
// (same gate main.ts mounts). STATIC_TOKEN is captured from the config mock
// ('test-shared-secret'); verifyToken ignores EXECUTOR_SHARED_TOKEN at request
// time, so the bearer below must match config.token.
// ---------------------------------------------------------------------------

describe('POST /api/execute — authentication (verifyToken)', () => {
  it('returns 401 when no Authorization header is provided', async () => {
    const res = await request(appWithAuth).post('/api/execute')
      .send({ executionId: 'exec-auth-001', task: { runtime: 'node' } });
    expect(res.status).toBe(401);
  });

  it('returns 401 when a wrong token is provided', async () => {
    (mockCp.spawn as jest.Mock).mockReturnValue(okSpawn());
    const res = await request(appWithAuth)
      .post('/api/execute')
      .set('Authorization', 'Bearer wrong-token')
      .send({ executionId: 'exec-auth-002', task: { runtime: 'node' } });
    expect(res.status).toBe(401);
  });

  it('returns 401 when Authorization scheme is not Bearer', async () => {
    const res = await request(appWithAuth)
      .post('/api/execute')
      .set('Authorization', `Basic ${AUTH_TOKEN}`)
      .send({ executionId: 'exec-auth-003', task: { runtime: 'node' } });
    expect(res.status).toBe(401);
  });

  it('passes through with correct token', async () => {
    (mockCp.spawn as jest.Mock).mockReturnValue(okSpawn());
    const res = await request(appWithAuth)
      .post('/api/execute')
      .set('Authorization', `Bearer ${AUTH_TOKEN}`)
      .send({ executionId: 'exec-auth-004', task: { runtime: 'node' } });
    expect(res.status).toBe(200);
  });

  it('protects the kill endpoint with the same bearer check', async () => {
    const anon = await request(appWithAuth).post('/api/executions/exec-auth-kill/kill');
    expect(anon.status).toBe(401);
    const wrong = await request(appWithAuth)
      .post('/api/executions/exec-auth-kill/kill')
      .set('Authorization', 'Bearer nope');
    expect(wrong.status).toBe(401);
    // 正确 token 下才能进到运行表查找（404 = 通过鉴权但不在表中）
    const ok = await request(appWithAuth)
      .post('/api/executions/exec-auth-kill/kill')
      .set('Authorization', `Bearer ${AUTH_TOKEN}`);
    expect(ok.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Basic /execute validation (dev mode, no auth)
// ---------------------------------------------------------------------------

describe('POST /api/execute', () => {
  it('returns 400 when executionId is missing', async () => {
    const res = await request(appNoAuth).post('/api/execute').send({ task: { runtime: 'node' } });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/executionId/);
  });

  it('returns 429 when at capacity', async () => {
    testConfig.maxConcurrentTasks = 1;
    Atomics.store(_runningCountArr, 0, 1);
    const res = await request(appNoAuth).post('/api/execute')
      .send({ executionId: 'exec-429', task: { runtime: 'node' } });
    expect(res.status).toBe(429);
    expect(Atomics.load(_runningCountArr, 0)).toBe(1);
  });

  it('returns 400 for invalid gitRepo scheme', async () => {
    const res = await request(appNoAuth).post('/api/execute').send({
      executionId: 'exec-002',
      task: { runtime: 'node', gitRepo: 'file:///etc/passwd' },
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/gitRepo URL scheme not allowed/);
  });

  it('returns 400 for invalid npm package name', async () => {
    const res = await request(appNoAuth).post('/api/execute').send({
      executionId: 'exec-003',
      task: { runtime: 'node', requirements: ['valid-pkg', '; rm -rf /'] },
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Invalid npm package name/);
  });

  it('returns 400 for duplicate execution (already active)', async () => {
    testConfig.maxConcurrentTasks = 2;
    (mockCp.spawn as jest.Mock).mockReturnValue(okSpawn());
    // 第一个执行由 worker 桩持有且永不 onComplete —— 保持在运行表中活跃
    (taskWorkerManager.execute as jest.Mock).mockImplementationOnce(
      async (_tid: string, _eid: string, _task: any, _params: any, onComplete?: () => void, runPrepared?: any) => {
        if (runPrepared) {
          try {
            await runPrepared(() => undefined);
          } catch {
            /* 测试内保持占用，回调无需断言 */
          }
        }
        // 故意不调用 onComplete
      },
    );
    const res1 = await request(appNoAuth).post('/api/execute').send({
      executionId: 'exec-dup', task: { runtime: 'node', entrypoint: 'index.js' },
    });
    expect(res1.status).toBe(200);
    await flushAsync();
    const res2 = await request(appNoAuth).post('/api/execute').send({
      executionId: 'exec-dup', task: { runtime: 'node', entrypoint: 'index.js' },
    });
    expect(res2.status).toBe(400);
    expect(res2.body.error).toMatch(/already active/);
    // 二次领取不得叠加占用并发槽（防双释放/计数失真）
    expect(Atomics.load(_runningCountArr, 0)).toBe(1);
  });

  // B-01: prepare (git checkout) moved to background — /execute returns 200
  // immediately; the git failure is reported via pushCallback, not via HTTP.
  it('returns 200 immediately and pushes a failed callback on git checkout failure (B-01)', async () => {
    const failingSpawn = {
      stdout: { on: jest.fn() },
      stderr: { on: jest.fn((event: string, cb: Function) => { if (event === 'data') cb(Buffer.from('clone failed')); }) },
      on: jest.fn((event: string, cb: Function) => { if (event === 'close') setImmediate(() => cb(1)); }),
      kill: jest.fn(),
      pid: 12345,
    };
    (mockCp.spawn as jest.Mock).mockReturnValue(failingSpawn);

    const res = await request(appNoAuth).post('/api/execute').send({
      executionId: 'exec-git-fail',
      task: { runtime: 'node', gitRepo: 'https://example.com/repo.git' },
    });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('accepted');
    await flushAsync();
    // Background failure callback
    const failCall = (pushCallback as jest.Mock).mock.calls
      .map(c => c[0])
      .find(p => p.status === 'failed' && /git clone failed/.test(p.errorMessage || ''));
    expect(failCall).toBeTruthy();
    // BUG-10 细化：git clone 失败从 package_fetch_failed 拆分为 git_fetch_failed
    expect(failCall.failureReason).toBe('git_fetch_failed');
    expect(Atomics.load(_runningCountArr, 0)).toBe(0);
  });

  // B-02: worker enqueue failure (no runPrepared — e.g. placeholder rejected)
  it('pushes failed callback when worker.execute throws synchronously (B-02)', async () => {
    (taskWorkerManager.execute as jest.Mock).mockImplementationOnce(() => {
      throw new Error('enqueue failed');
    });
    const res = await request(appNoAuth).post('/api/execute').send({
      executionId: 'exec-worker-fail',
      task: { runtime: 'node', entrypoint: 'index.js' },
    });
    expect(res.status).toBe(200); // /execute returns accepted synchronously
    const failCall = (pushCallback as jest.Mock).mock.calls
      .map(c => c[0])
      .find(p => p.status === 'failed' && /enqueue failed/.test(p.errorMessage || ''));
    expect(failCall).toBeTruthy();
    expect(Atomics.load(_runningCountArr, 0)).toBe(0);
  });

  it('runs node task and returns accepted (response body shape unchanged)', async () => {
    (mockCp.spawn as jest.Mock).mockReturnValue(okSpawn());
    const res = await request(appNoAuth).post('/api/execute').send({
      executionId: 'exec-004',
      task: { runtime: 'node', entrypoint: 'index.js' },
    });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('accepted');
    expect(res.body.executionId).toBe('exec-004');
    // No extra fields compared to old synchronous path
    expect(Object.keys(res.body).sort()).toEqual(['executionId', 'status']);
  });
});

// ---------------------------------------------------------------------------
// BoundedLogBuffer (unchanged)
// ---------------------------------------------------------------------------

describe('BoundedLogBuffer', () => {
  it('keeps head and tail while dropping the middle once over the cap', () => {
    const buf = new BoundedLogBuffer();
    buf.append('a'.repeat(600_000));
    buf.append('b'.repeat(600_000));
    buf.append('c'.repeat(600_000));
    const s = buf.toString();
    expect(s.length).toBeLessThan(1_100_000);
    expect(s.startsWith('aaaa')).toBe(true);
    expect(s.endsWith('cccc')).toBe(true);
    expect(s).toContain('truncated in memory');
  });

  it('returns the exact content when under the cap', () => {
    const buf = new BoundedLogBuffer();
    buf.append('hello ');
    buf.append('world');
    expect(buf.toString()).toBe('hello world');
  });
});

// ---------------------------------------------------------------------------
// killRunningTaskProcesses (shutdown path — unchanged)
// ---------------------------------------------------------------------------

describe('killRunningTaskProcesses', () => {
  it('kills the detached task process group (POSIX) / process tree via taskkill (win32) for running tasks', async () => {
    const proc = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter; stderr: EventEmitter; pid: number; kill: jest.Mock;
    };
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.pid = 4242;
    proc.kill = jest.fn();
    (mockCp.spawn as jest.Mock).mockReturnValue(proc);

    const promise = runTask(
      { id: 'task-kill', name: 'k', cmd: 'node', args: ['x.js'], workDir: '/tmp/test-workdir', env: {}, timeout: 60 },
      {},
      'exec-kill',
    );

    const killSpy = jest.spyOn(process, 'kill').mockImplementation(() => true);
    try {
      const killed = killRunningTaskProcesses();
      expect(killed).toBe(1);
      if (process.platform !== 'win32') {
        expect(killSpy).toHaveBeenCalledWith(-4242, 'SIGKILL');
      } else {
        expect(mockCp.spawn).toHaveBeenCalledWith('taskkill', ['/T', '/F', '/PID', '4242'], expect.anything());
        expect(proc.kill).toHaveBeenCalledWith('SIGKILL');
      }
    } finally {
      killSpy.mockRestore();
    }
    proc.emit('close', 0);
    await promise;
    expect(killRunningTaskProcesses()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// POST /api/executions/:executionId/kill (改动1)
// ---------------------------------------------------------------------------

describe('POST /api/executions/:executionId/kill', () => {
  function runningProc(pid: number) {
    const proc = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; pid: number; kill: jest.Mock };
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.pid = pid;
    proc.kill = jest.fn();
    return proc;
  }

  it('returns 404 when execution is not active', async () => {
    const res = await request(appNoAuth).post('/api/executions/never-started/kill');
    expect(res.status).toBe(404);
    expect(res.body.ok).toBe(false);
  });

  it('kills a running execution, sends failure callback (failureReason=killed), releases capacity once (改动1 在跑)', async () => {
    testConfig.maxConcurrentTasks = 5;
    const proc = runningProc(7001);
    (mockCp.spawn as jest.Mock).mockReturnValue(proc);

    // 模拟真实 worker 的两段语义：execute() 在“入队”时立即 resolve，
    // runPrepared/任务运行发生在“轮到该执行”之后。
    let captured: { onComplete?: () => void; runPrepared?: any } = {};
    (taskWorkerManager.execute as jest.Mock).mockImplementationOnce(
      async (_tid: string, _eid: string, _task: any, _params: any, onComplete?: () => void, runPrepared?: any) => {
        captured = { onComplete, runPrepared };
      },
    );

    const execRes = await request(appNoAuth).post('/api/execute').send({
      executionId: 'exec-kill-run',
      task: { runtime: 'node', entrypoint: 'index.js' },
    });
    expect(execRes.status).toBe(200);
    await flushAsync();
    expect(Atomics.load(_runningCountArr, 0)).toBe(1); // slot occupied
    expect(executionExists('exec-kill-run')).toBe(true);

    // 轮到该执行：prepare 成功 → 任务进程 spawn 后由 worker 持有 onComplete
    const prepared = await captured.runPrepared!(() => undefined);
    void runTask(prepared.task, prepared.params, 'exec-kill-run');
    await flushAsync(); // runProcess 注册 runningTaskProcesses[exec-kill-run]

    const killSpy = jest.spyOn(process, 'kill').mockImplementation(() => true);
    try {
      const killRes: any = await request(appNoAuth).post('/api/executions/exec-kill-run/kill');
      expect(killRes.status).toBe(200);
      expect(killRes.body.ok).toBe(true);
      if (process.platform !== 'win32') {
        // killProcessTree 走进程组。断言必须在 mockRestore 之前——
        // mockRestore 会清空 mock.calls，restore 后断言恒为 0 次调用
        //（此前的写法在 POSIX 上必挂、win32 因断言被跳过而漏检）。
        expect(killSpy).toHaveBeenCalledWith(-7001, 'SIGKILL');
      }
    } finally {
      killSpy.mockRestore();
    }

    // 进程树被杀 → close(null) → runTask 失败路径（标记 killed）；容量释放走
    // worker onComplete（与正常完成路径同款，kill 端点不抢——防双释放竞态）
    proc.emit('close', null);
    await flushAsync();

    const failCall = (pushCallback as jest.Mock).mock.calls
      .map(c => c[0])
      .find(p => p.status === 'failed' && p.executionId === 'exec-kill-run');
    expect(failCall).toBeTruthy();
    expect(failCall.failureReason).toBe('killed');
    expect(Atomics.load(_runningCountArr, 0)).toBe(1); // 尚未走 onComplete

    captured.onComplete!();
    expect(Atomics.load(_runningCountArr, 0)).toBe(0);
    expect(executionExists('exec-kill-run')).toBe(false);
    // 幂等：再触发一次 onComplete 也不得多减（防双释放）
    captured.onComplete!();
    expect(Atomics.load(_runningCountArr, 0)).toBe(0);
  });

  it('returns 404 when capacity slot already released (no double-kill) (改动1 幂等)', async () => {
    testConfig.maxConcurrentTasks = 5;
    (mockCp.spawn as jest.Mock).mockReturnValue(okSpawn());
    const execRes = await request(appNoAuth).post('/api/execute').send({
      executionId: 'exec-kill-idem',
      task: { runtime: 'node', entrypoint: 'index.js' },
    });
    expect(execRes.status).toBe(200);
    await flushAsync();
    // Natural completion → slot released
    expect(Atomics.load(_runningCountArr, 0)).toBe(0);
    // Kill after completion → 404 (already not in liveExecutions)
    const res = await request(appNoAuth).post('/api/executions/exec-kill-idem/kill');
    expect(res.status).toBe(404);
    expect(res.body.ok).toBe(false);
    // Slot still 0 (no double-release)
    expect(Atomics.load(_runningCountArr, 0)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// task hardening (existing + updated for async prepare)
// ---------------------------------------------------------------------------

describe('task hardening', () => {
  it('injects NODE_PATH pointing at the shared .node_modules dir and leaks no secrets', async () => {
    process.env.EXECUTOR_SHARED_TOKEN = 'top-secret';
    process.env.EXECUTOR_SECRET = 'legacy-secret';
    process.env.SOME_TASK_ENV = 'leak-me';
    (mockCp.spawn as jest.Mock).mockReturnValue(okSpawn());

    let envFromExecute: Record<string, string | undefined> | undefined;
    (taskWorkerManager.execute as jest.Mock).mockImplementationOnce(
      async (_tid: string, _eid: string, task: any, _params: any, onComplete?: () => void, runPrepared?: any) => {
        if (runPrepared) {
          const prepared = await runPrepared(() => undefined);
          envFromExecute = prepared.task.env;
        }
        if (onComplete) onComplete();
      },
    );

    const res = await request(appNoAuth).post('/api/execute').send({
      executionId: 'exec-nodepath',
      task: { id: 'taskA', runtime: 'node', entrypoint: 'index.js', requirements: ['left-pad'] },
    });
    expect(res.status).toBe(200);
    await flushAsync();

    // env is now passed inside the prepared task (via runPrepared); check via taskWorkerManager.execute call
    // In the worker-stub above we captured envFromExecute
    // But the mockImplementationOnce approach: envFromExecute captured by mock impl
    expect(envFromExecute).toBeTruthy();
    expect(envFromExecute!.NODE_PATH).toBe(
      path.join('/tmp/test-workdir', '.node_modules', 'taskA', 'node_modules'),
    );
    expect(envFromExecute!.EXECUTOR_SHARED_TOKEN).toBeUndefined();
    expect(envFromExecute!.EXECUTOR_SECRET).toBeUndefined();
    expect(envFromExecute!.SOME_TASK_ENV).toBeUndefined();
    expect(envFromExecute!.PATH).toBeDefined();
    delete process.env.SOME_TASK_ENV;
  });

  it('rejects option-like git refs (synchronous 400)', async () => {
    const res = await request(appNoAuth).post('/api/execute').send({
      executionId: 'exec-ref',
      task: { runtime: 'node', gitRepo: 'https://example.com/repo.git', gitBranch: '-b' },
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Invalid git ref/);
  });

  it('rejects out-of-bounds task timeouts (synchronous 400)', async () => {
    const res = await request(appNoAuth).post('/api/execute').send({
      executionId: 'exec-timeout-neg',
      task: { runtime: 'node', entrypoint: 'index.js', timeout: 0.5 },
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Invalid task timeout/);

    const res2 = await request(appNoAuth).post('/api/execute').send({
      executionId: 'exec-timeout-huge',
      task: { runtime: 'node', entrypoint: 'index.js', timeout: 90_000 },
    });
    expect(res2.status).toBe(400);
  });

  it('contains spawn failures: stdio socket errors do not crash the executor (W-24)', async () => {
    const proc: any = {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      pid: 4242,
      kill: jest.fn(),
      on: jest.fn(),
    };
    (mockCp.spawn as jest.Mock).mockReturnValue(proc);
    (mockFs.existsSync as jest.Mock).mockReturnValue(true);

    const longWorkDir = 'C:\\af-long\\' + 'segment-padding-xxxx'.repeat(13);
    const promise = runTask(
      { id: 'w24', name: 'w24', cmd: 'node', args: ['x.js'], workDir: longWorkDir, env: {}, timeout: 30 },
      {},
      'exec-w24',
    );
    proc.stdout.emit('error', Object.assign(new Error('read ENOTCONN'), { code: 'ENOTCONN' }));
    const errHandlers = (proc.on as jest.Mock).mock.calls.filter((c: any) => c[0] === 'error');
    for (const [, cb] of errHandlers) {
      cb(Object.assign(new Error('spawn node ENOENT'), { code: 'ENOENT' }));
    }
    await promise;

    const failedCall = (pushCallback as jest.Mock).mock.calls
      .map(c => c[0])
      .find((p: any) => p.status === 'failed' && /ENOENT/.test(p.errorMessage || ''));
    expect(failedCall).toBeTruthy();
    expect(failedCall.errorMessage).toMatch(/MAX_PATH/);
    // 恢复默认：本测试把 existsSync 置 true，不还原会污染后续路径校验
    (mockFs.existsSync as jest.Mock).mockReturnValue(false);
  });

  it('background prepare rejects entrypoint escape (failure callback)', async () => {
    (mockCp.spawn as jest.Mock).mockReturnValue(okSpawn());
    const res = await request(appNoAuth).post('/api/execute').send({
      executionId: 'exec-entry-escape',
      task: { runtime: 'shell', entrypoint: '../../etc/evil.sh' },
    });
    expect(res.status).toBe(200); // accepted immediately
    await flushAsync();
    const failCall = (pushCallback as jest.Mock).mock.calls
      .map(c => c[0])
      .find(p => p.status === 'failed' && /entrypoint escapes/.test(p.errorMessage || ''));
    expect(failCall).toBeTruthy();
    expect(Atomics.load(_runningCountArr, 0)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// git cache serialization (unchanged)
// ---------------------------------------------------------------------------

describe('git cache serialization', () => {
  it('serializes concurrent checkouts of the same repo (no overlapping clones)', async () => {
    const events: string[] = [];
    const pendingCloses: Array<() => void> = [];
    let active = 0;
    let maxActive = 0;
    (mockCp.spawn as jest.Mock).mockImplementation(() => {
      events.push('spawn'); active++; maxActive = Math.max(maxActive, active);
      return {
        stdout: { on: jest.fn() }, stderr: { on: jest.fn() },
        on: jest.fn((event: string, cb: Function) => {
          if (event === 'close') pendingCloses.push(() => { active--; events.push('close'); cb(0); });
        }),
        kill: jest.fn(), pid: 1,
      };
    });
    const p1 = gitCheckoutTo('https://example.com/repo.git', 'main', '/tmp/test-workdir/exec-e1');
    await flushAsync();
    const p2 = gitCheckoutTo('https://example.com/repo.git', 'main', '/tmp/test-workdir/exec-e2');
    await flushAsync();
    expect(events.filter(e => e === 'spawn').length).toBe(1);
    for (let i = 0; i < 20 && pendingCloses.length; i++) { pendingCloses.shift()!(); await flushAsync(); }
    await Promise.all([p1, p2]);
    expect(maxActive).toBe(1);
    expect(events.filter(e => e === 'spawn').length).toBe(4);
  });

  it('quarantines a corrupt cache dir and self-heals by re-cloning (W-23)', async () => {
    const spawned: Array<[string, string[]]> = [];
    const results = [1, 0, 0];
    (mockCp.spawn as jest.Mock).mockImplementation((cmd: string, args: string[]) => {
      spawned.push([cmd, args]);
      const status = results.shift() ?? 0;
      return {
        stdout: { on: jest.fn() }, stderr: { on: jest.fn() },
        on: jest.fn((event: string, cb: Function) => { if (event === 'close') setImmediate(() => cb(status)); }),
        kill: jest.fn(), pid: 1,
      };
    });
    let cacheAlive = true;
    (mockFs.existsSync as jest.Mock).mockImplementation(
      (p: string) => cacheAlive && String(p).includes('.git_cache'),
    );
    let quarantinedTo = '';
    (mockFs.renameSync as jest.Mock).mockImplementation((from: string, to: string) => {
      quarantinedTo = String(to); cacheAlive = false;
    });
    await gitCheckoutTo('https://example.com/repo.git', 'main', '/tmp/test-workdir/exec-w23');
    expect(spawned[0][1].join(' ')).toContain('--is-bare-repository');
    expect(quarantinedTo).toMatch(/-broken-\d+$/);
    expect(spawned[1][1][0]).toBe('clone');
    expect(spawned[2][1]).toContain('checkout');
  });
});

// ---------------------------------------------------------------------------
// N23: per-execution callback token injection
// ---------------------------------------------------------------------------

describe('POST /api/execute — per-execution callback token (N23)', () => {
  beforeEach(() => {
    (mockCp.spawn as jest.Mock).mockReturnValue(okSpawn());
  });

  async function postExecute(executionId: string, params?: Record<string, unknown>) {
    let envFromPrepare: Record<string, string | undefined> | undefined;
    (taskWorkerManager.execute as jest.Mock).mockImplementationOnce(
      async (_tid: string, _eid: string, _task: any, _params: any, onComplete?: () => void, runPrepared?: any) => {
        if (runPrepared) {
          const prepared = await runPrepared(() => undefined);
          envFromPrepare = prepared.task.env;
        }
        if (onComplete) onComplete();
      },
    );
    const res = await request(appNoAuth).post('/api/execute').send({
      executionId,
      task: { id: 'cbtask', runtime: 'node', entrypoint: 'index.js' },
      params,
    });
    expect(res.status).toBe(200);
    await flushAsync();
    return envFromPrepare!;
  }

  it('injects a v1 callback token bound to the execution plus the admin API URL', async () => {
    const env = await postExecute('exec-cbtoken-1');
    const token = env.AUTOFLOW_CALLBACK_TOKEN;
    expect(token).toBeDefined();
    const parts = token!.split('.');
    expect(parts[0]).toBe('v1');
    expect(parts[1]).toBe('exec-cbtoken-1');
    const exp = Number(parts[2]);
    const now = Math.floor(Date.now() / 1000);
    expect(exp).toBeGreaterThan(now + 1100);
    expect(exp).toBeLessThan(now + 1300);
    expect(parts[3]).toMatch(/^[0-9a-f]{64}$/);
    expect(env.AUTOFLOW_ADMIN_API_URL).toBe('http://admin-api:3105');
  });

  it('never leaks the shared token or the callback HMAC secret into the child env', async () => {
    process.env.EXECUTOR_SHARED_TOKEN = 'top-secret-shared';
    process.env.EXECUTION_CALLBACK_SECRET = 'dedicated-secret';
    testConfig.executionCallbackSecret = 'dedicated-secret';
    const env = await postExecute('exec-cbtoken-2');
    expect(env.AUTOFLOW_CALLBACK_TOKEN).toBeDefined();
    expect(env.EXECUTOR_SHARED_TOKEN).toBeUndefined();
    expect(env.EXECUTION_CALLBACK_SECRET).toBeUndefined();
    expect(env.AUTOFLOW_CALLBACK_TOKEN).not.toContain('top-secret-shared');
    expect(env.AUTOFLOW_CALLBACK_TOKEN).not.toContain('dedicated-secret');
    delete process.env.EXECUTOR_SHARED_TOKEN;
    delete process.env.EXECUTION_CALLBACK_SECRET;
  });

  it('user params cannot override the callback token or admin URL', async () => {
    const env = await postExecute('exec-cbtoken-3', {
      callback_token: 'evil-token',
      admin_api_url: 'http://evil:1234',
    });
    expect(env.AUTOFLOW_CALLBACK_TOKEN).toMatch(/^v1\.exec-cbtoken-3\./);
    expect(env.AUTOFLOW_ADMIN_API_URL).toBe('http://admin-api:3105');
  });

  it('omits the token when no executor secret is configured (dev mode)', async () => {
    testConfig.token = '';
    testConfig.executionCallbackSecret = '';
    const env = await postExecute('exec-cbtoken-4');
    expect(env.AUTOFLOW_CALLBACK_TOKEN).toBeUndefined();
    expect(env.AUTOFLOW_ADMIN_API_URL).toBe('http://admin-api:3105');
  });

  it('injects AUTOFLOW_EXECUTOR_ADDRESS, preferring the public address', async () => {
    const envDefault = await postExecute('exec-addr-1');
    expect(envDefault.AUTOFLOW_EXECUTOR_ADDRESS).toBe('localhost:8002');
    (testConfig as any).executorAddressPublic = 'public.host:9000';
    try {
      const envPublic = await postExecute('exec-addr-2');
      expect(envPublic.AUTOFLOW_EXECUTOR_ADDRESS).toBe('public.host:9000');
    } finally {
      delete (testConfig as any).executorAddressPublic;
    }
  });

  it('user params cannot override AUTOFLOW_EXECUTOR_ADDRESS', async () => {
    const env = await postExecute('exec-addr-3', { executor_address: 'evil:1234' });
    expect(env.AUTOFLOW_EXECUTOR_ADDRESS).toBe('localhost:8002');
  });
});

// ---------------------------------------------------------------------------
// 改动3: .npmrc content builder
// ---------------------------------------------------------------------------

describe('buildNpmRcContent (改动3)', () => {
  it('has token + @autoflow package: scoped lines + auth token', () => {
    const rc = buildNpmRcContent(
      'http://verdaccio:4873/',
      'secret-token-abc',
      ['@autoflow/core', 'lodash'],
    );
    expect(rc).toContain('@autoflow:registry=http://verdaccio:4873/');
    expect(rc).toContain('@autocodeflow:registry=http://verdaccio:4873/');
    expect(rc).toContain('registry=http://verdaccio:4873/');
    expect(rc).toContain('//verdaccio:4873/:_authToken=secret-token-abc');
    // 每一行要么 registry 配置、要么是纯 auth 行——token 不与其他键混行
    for (const line of rc.split('\n').filter(Boolean)) {
      if (line.startsWith('//')) {
        expect(line).toMatch(/^\/\/[^/]+\/:_authToken=secret-token-abc$/);
      } else {
        expect(line).not.toContain('secret-token-abc');
      }
    }
  });

  it('no token: no _authToken line', () => {
    const rc = buildNpmRcContent('http://verdaccio:4873/', '', ['@autoflow/core']);
    expect(rc).not.toContain('_authToken');
  });

  it('no token (undefined): no _authToken line', () => {
    const rc = buildNpmRcContent('http://verdaccio:4873/', undefined, ['@autoflow/core']);
    expect(rc).not.toContain('_authToken');
  });

  it('all scoped-only packages: no global registry line', () => {
    const rc = buildNpmRcContent('http://verdaccio:4873/', undefined, ['@autoflow/core', '@autocodeflow/sdk']);
    expect(rc).not.toMatch(/^registry=/m);
    expect(rc).toContain('@autoflow:registry=');
    expect(rc).toContain('@autocodeflow:registry=');
  });

  it('has non-scoped packages: global registry line present', () => {
    const rc = buildNpmRcContent('http://verdaccio:4873/', undefined, ['left-pad']);
    expect(rc).toMatch(/^registry=/m);
  });

  it('https registry URL: auth token line uses //host:port format', () => {
    const rc = buildNpmRcContent('https://npm.example.com:4873/', 'tok123', ['lodash']);
    expect(rc).toContain('//npm.example.com:4873/:_authToken=tok123');
  });

  it('writes npmrc with token for node task with requirements', async () => {
    testConfig.npmRegistryUrl = 'http://verdaccio:4873/';
    testConfig.npmRegistryToken = 'secret-token-xyz';
    (mockCp.spawn as jest.Mock).mockReturnValue(okSpawn());
    const writtenNpmrc: string[] = [];
    (mockFs.writeFileSync as jest.Mock).mockImplementation((fp: string, content: string) => {
      if (String(fp).endsWith('.npmrc')) writtenNpmrc.push(content);
    });
    const res = await request(appNoAuth).post('/api/execute').send({
      executionId: 'exec-npmrc',
      task: { id: 'taskN', runtime: 'node', entrypoint: 'index.js', requirements: ['@autoflow/core', 'lodash'] },
    });
    expect(res.status).toBe(200);
    await flushAsync();
    expect(writtenNpmrc).toHaveLength(1);
    expect(writtenNpmrc[0]).toContain('_authToken=secret-token-xyz');
    // Token must not appear in any log call
    const { logger } = require('../logger');
    for (const call of logger.info.mock.calls) {
      expect(String(call[0])).not.toContain('secret-token-xyz');
    }
  });
});

// ---------------------------------------------------------------------------
// 改动4: timeout=0 → Infinity (unbounded), null/undefined → config default
// ---------------------------------------------------------------------------

describe('timeout semantics (改动4)', () => {
  it('timeout=0 → runTask receives Infinity (no kill timer)', async () => {
    (mockCp.spawn as jest.Mock).mockReturnValue(okSpawn());
    const promise = runTask(
      { id: 't', name: 't', cmd: 'node', args: ['x.js'], workDir: '/tmp/test-workdir', env: {}, timeout: Infinity },
      {},
      'exec-timeout0',
    );
    // No timer to fire — just close immediately
    await promise;
    const call = (pushCallback as jest.Mock).mock.calls[0][0];
    expect(call.status).toBe('success');
  });

  it('timeout=0 in /execute body: synchronous validation accepts it', async () => {
    (mockCp.spawn as jest.Mock).mockReturnValue(okSpawn());
    const res = await request(appNoAuth).post('/api/execute').send({
      executionId: 'exec-t0',
      task: { runtime: 'node', entrypoint: 'index.js', timeout: 0 },
    });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('accepted');
  });

  it('timeout=undefined → config.taskTimeoutSeconds (300)', async () => {
    (mockCp.spawn as jest.Mock).mockReturnValue(okSpawn());
    let timeoutInPrepared: number | undefined;
    (taskWorkerManager.execute as jest.Mock).mockImplementationOnce(
      async (_tid: string, _eid: string, _task: any, _params: any, onComplete?: () => void, runPrepared?: any) => {
        if (runPrepared) {
          const prepared = await runPrepared(() => undefined);
          timeoutInPrepared = prepared.task.timeout;
        }
        if (onComplete) onComplete();
      },
    );
    await request(appNoAuth).post('/api/execute').send({
      executionId: 'exec-tundef',
      task: { runtime: 'node', entrypoint: 'index.js' },
    });
    await flushAsync();
    expect(timeoutInPrepared).toBe(300);
  });

  it('timeout=120 → prepared task receives 120', async () => {
    (mockCp.spawn as jest.Mock).mockReturnValue(okSpawn());
    let timeoutInPrepared: number | undefined;
    (taskWorkerManager.execute as jest.Mock).mockImplementationOnce(
      async (_tid: string, _eid: string, _task: any, _params: any, onComplete?: () => void, runPrepared?: any) => {
        if (runPrepared) {
          const prepared = await runPrepared(() => undefined);
          timeoutInPrepared = prepared.task.timeout;
        }
        if (onComplete) onComplete();
      },
    );
    await request(appNoAuth).post('/api/execute').send({
      executionId: 'exec-t120',
      task: { runtime: 'node', entrypoint: 'index.js', timeout: 120 },
    });
    await flushAsync();
    expect(timeoutInPrepared).toBe(120);
  });

  it('timeout=0 → prepared task receives Infinity; callback token TTL 用封顶值而非 Infinity', async () => {
    (mockCp.spawn as jest.Mock).mockReturnValue(okSpawn());
    let preparedTask: any;
    (taskWorkerManager.execute as jest.Mock).mockImplementationOnce(
      async (_tid: string, _eid: string, _task: any, _params: any, onComplete?: () => void, runPrepared?: any) => {
        if (runPrepared) {
          preparedTask = (await runPrepared(() => undefined)).task;
        }
        if (onComplete) onComplete();
      },
    );
    await request(appNoAuth).post('/api/execute').send({
      executionId: 'exec-t0-prep',
      task: { runtime: 'node', entrypoint: 'index.js', timeout: 0 },
    });
    await flushAsync();
    expect(preparedTask.timeout).toBe(Infinity);
    // runProcess 的 kill 定时器条件 `timeoutSec && Number.isFinite(...)`：
    // Infinity/0 均不挂定时器 → 不限时
    const parts = String(preparedTask.env.AUTOFLOW_CALLBACK_TOKEN).split('.');
    const exp = Number(parts[2]);
    const now = Math.floor(Date.now() / 1000);
    expect(Number.isFinite(exp)).toBe(true);
    expect(exp).toBeGreaterThan(now + 315_360_000 - 7200);
    expect(exp).toBeLessThan(now + 315_360_000 + 7200);
  });
});

// ---------------------------------------------------------------------------
// 改动2: prepare failure during kill — abort mid-prepare
// ---------------------------------------------------------------------------

describe('POST /api/execute — kill during prepare (改动2)', () => {
  it('kill during git checkout aborts prepare, pushes exactly one killed callback, releases once', async () => {
    testConfig.maxConcurrentTasks = 5;
    let gitSpawnCall = 0;
    const pendingGit: Array<Function> = [];
    (mockCp.spawn as jest.Mock).mockImplementation(() => {
      gitSpawnCall++;
      return {
        stdout: { on: jest.fn() },
        stderr: { on: jest.fn() },
        on: jest.fn((event: string, cb: Function) => {
          if (event === 'close') pendingGit.push(cb);
        }),
        kill: jest.fn(),
        pid: 11111,
      };
    });

    // 两段式模拟 worker：execute() 入队即 resolve，"轮到执行"由测试手动触发
    let captured: { onComplete?: () => void; runPrepared?: any } = {};
    (taskWorkerManager.execute as jest.Mock).mockImplementationOnce(
      async (_tid: string, _eid: string, _task: any, _params: any, onComplete?: () => void, runPrepared?: any) => {
        captured = { onComplete, runPrepared };
      },
    );

    const execRes = await request(appNoAuth).post('/api/execute').send({
      executionId: 'exec-kill-during-git',
      task: { runtime: 'node', gitRepo: 'https://example.com/repo.git' },
    });
    expect(execRes.status).toBe(200);
    await flushAsync();
    expect(captured.runPrepared).toBeTruthy();
    expect(gitSpawnCall).toBe(0); // 尚未轮到该执行 → git 未开始

    // 轮到执行：prepare 开始 git clone（永不结束的 pending spawn）
    let prepError: any;
    const prep = (async () => {
      try {
        await captured.runPrepared!(() => undefined);
      } catch (err) {
        prepError = err;
      }
    })();
    await flushAsync();
    expect(gitSpawnCall).toBeGreaterThan(0); // clone 已在后台启动
    expect(Atomics.load(_runningCountArr, 0)).toBe(1);

    // kill 在 prepare 期间到达：worker 队列项被摘除 → 立即收尾（幂等回调）
    (taskWorkerManager.cancelExecution as jest.Mock).mockReturnValueOnce(true);
    const killRes = await request(appNoAuth).post('/api/executions/exec-kill-during-git/kill');
    expect(killRes.status).toBe(200);
    expect(killRes.body.ok).toBe(true);

    // prepare 因 abort 信号在下一检查点退出：模拟被 kill 的 git 子进程退出
    // （真实 OS 中 killProcessTree 之后必然触发 close；abort 检查在 status
    // 判定之前，无论退出码都转 ExecutionCancelledError）。
    for (const close of pendingGit.splice(0)) close(null);
    await prep;
    expect(prepError?.name).toBe('ExecutionCancelledError');

    const killedCalls = (pushCallback as jest.Mock).mock.calls
      .map(c => c[0])
      .filter(p => p.executionId === 'exec-kill-during-git' && p.status === 'failed');
    expect(killedCalls).toHaveLength(1); // 恰好一次（killed 回调由 finalize 推送）
    expect(killedCalls[0].failureReason).toBe('killed');
    expect(Atomics.load(_runningCountArr, 0)).toBe(0); // 只释放一次
  });

  it('prepare 期间被 kill（执行已被 worker 取出，不在队列）：补推 killed 回调，容量经 onComplete 释放', async () => {
    testConfig.maxConcurrentTasks = 5;
    // npm install 的 runCommand 子进程挂起不退出 → prepare 停在安装阶段
    const pendingInstall: Array<Function> = [];
    (mockCp.spawn as jest.Mock).mockImplementation(() => ({
      stdout: { on: jest.fn() },
      stderr: { on: jest.fn() },
      on: jest.fn((event: string, cb: Function) => {
        if (event === 'close') pendingInstall.push(cb);
      }),
      kill: jest.fn(),
      pid: 22222,
    }));
    const captured: { onComplete?: () => void; runPrepared?: any } = {};
    (taskWorkerManager.execute as jest.Mock).mockImplementationOnce(
      async (_tid: string, _eid: string, _task: any, _params: any, onComplete?: () => void, runPrepared?: any) => {
        // 真实 worker 语义：入队即 resolve；"轮到执行"由下面的测试手动驱动
        Object.assign(captured, { onComplete, runPrepared });
      },
    );
    const execRes = await request(appNoAuth).post('/api/execute').send({
      executionId: 'exec-kill-post-dequeue',
      task: { id: 'taskkd', runtime: 'node', entrypoint: 'index.js', requirements: ['left-pad'] },
    });
    expect(execRes.status).toBe(200);
    await flushAsync();
    expect(captured.runPrepared).toBeTruthy(); // dispatch 完成 → entry.enqueued=true

    // 轮到执行：prepare 开始装依赖（spawn 挂起不退出）；取消错误静默吞掉，
    // finally 照常 onComplete（真实 TaskWorker 同款语义）
    let prepError: any;
    const prep = (async () => {
      try {
        await captured.runPrepared!(() => undefined);
      } catch (err: any) {
        prepError = err;
      } finally {
        captured.onComplete?.();
      }
    })();
    await flushAsync();
    expect(pendingInstall.length).toBeGreaterThan(0); // prepare 正在装依赖

    // kill 到达：执行已被取出（cancelExecution 默认 false → 不 finalize）
    // 且尚未 spawn 任务进程（runningTaskProcesses 无项）
    const killRes = await request(appNoAuth).post('/api/executions/exec-kill-post-dequeue/kill');
    expect(killRes.status).toBe(200);
    expect(killRes.body.ok).toBe(true);

    // abort 信号杀了 npm 进程树 → 子进程退出 → 安装结果作废，prepare 在
    // aborted 检查点抛 ExecutionCancelledError
    for (const close of pendingInstall.splice(0)) close(1);
    await flushAsync();
    expect(prepError?.name).toBe('ExecutionCancelledError');

    // 失败回调由 runPrepared 取消分支补推（kill 端点未 finalize），容量由
    // worker 的 onComplete 释放
    const killedCalls = (pushCallback as jest.Mock).mock.calls
      .map(c => c[0])
      .filter(p => p.executionId === 'exec-kill-post-dequeue' && p.status === 'failed');
    expect(killedCalls).toHaveLength(1);
    expect(killedCalls[0].failureReason).toBe('killed');
    expect(Atomics.load(_runningCountArr, 0)).toBe(0);
    expect(executionExists('exec-kill-post-dequeue')).toBe(false);
    // 二次 kill → 404（已出表）
    const again = await request(appNoAuth).post('/api/executions/exec-kill-post-dequeue/kill');
    expect(again.status).toBe(404);
  });
});