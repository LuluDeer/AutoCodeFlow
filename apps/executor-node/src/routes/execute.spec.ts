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

// NETOPT-F P2-3: zip 渠道包下载 mock。默认测试不触发 zip 下载；用例内再
// mockImplementation 成挂起 Promise 捕获 signal，模拟真实 download.ts 的
// abort→reject('Download aborted') 语义。
jest.mock('../lib/download', () => ({
  downloadFile: jest.fn(),
}));

jest.mock('../file-logger', () => ({
  appendLog: jest.fn(),
  getDeadLetterCount: jest.fn(() => 0),
  // E-08: cleanupWorkDir 据此跳过活跃 execution 目录；测试默认返回空集（无活跃）。
  registerActiveWorkdirProvider: jest.fn(),
  // P2 磁盘水位：mock 默认"无压力"，各用例行为与引入前一致；水位用例
  // 单独覆盖 diskUsagePercent 返回值。
  diskUsagePercent: jest.fn(() => 0),
  DISK_CRITICAL_PERCENT: 95,
  // NETOPT-9-4: 日志分片钉住（createExecutionEntry/release 调用，mock 无副作用）。
  pinLogFilePath: jest.fn(),
  unpinLogFilePath: jest.fn(),
}));

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

import { executeRouter, runTask, gitCheckoutTo, killRunningTaskProcesses, abortAllLiveExecutions, BoundedLogBuffer, resolveBwrapPath, buildTaskSandboxArgv, __resetBwrapPathCacheForTest } from './execute';
import { buildNpmRcContent, executionExists, quoteShellArgForPlatform } from './execute';
// A3（kill/logs 契约化）：kill 真实出参用生成的 schema 现校验
import { KillResponseSchema } from '../generated/protocol.schemas';
import { pushCallback } from '../callback';
import { taskWorkerManager } from '../task-worker';
import { config as testConfig } from '../config';
import { verifyToken } from '../middleware/auth';
import { downloadFile as mockDownloadFile } from '../lib/download';

const mockFs = fs as jest.Mocked<typeof fs>;
const mockCp = childProcess as jest.Mocked<typeof childProcess>;
let mockTempNpmDirectoryNumber = 0;
const mockNpmFiles = new Set<string>();

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
  mockNpmFiles.clear();
  Atomics.store(_runningCountArr, 0, 0);
  delete process.env.EXECUTOR_SHARED_TOKEN;
  delete process.env.NPM_REGISTRY_TOKEN;
  (mockFs.existsSync as jest.Mock).mockReturnValue(false);
  (mockFs.mkdirSync as jest.Mock).mockReturnValue(undefined);
  (mockFs.chmodSync as jest.Mock).mockReturnValue(undefined);
  (mockFs.writeFileSync as jest.Mock).mockImplementation((fp: fs.PathLike) => {
    const file = String(fp);
    if (file.endsWith('.npmrc') || file.endsWith('.npm-globalrc')) mockNpmFiles.add(file);
  });
  (mockFs.mkdtempSync as jest.Mock).mockImplementation(() => `/tmp/autocodeflow-npm-${++mockTempNpmDirectoryNumber}`);
  (mockFs.unlinkSync as jest.Mock).mockImplementation((file: fs.PathLike) => {
    mockNpmFiles.delete(String(file));
  });
  (mockFs.rmSync as jest.Mock).mockImplementation((dir: fs.PathLike) => {
    for (const file of [...mockNpmFiles]) {
      if (file.startsWith(`${String(dir)}${path.sep}`)) mockNpmFiles.delete(file);
    }
  });
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

  it('returns 503 when disk usage is critically full (P2 watermark)', async () => {
    // 磁盘水位闸门（file-logger.diskUsagePercent，默认 mock 返回 0=无压力）：
    // 临界水位（≥95%）下任何新任务都被拒绝，且不触碰容量计数。
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fileLoggerMock = require('../file-logger') as {
      diskUsagePercent: jest.Mock;
      DISK_CRITICAL_PERCENT: number;
    };
    fileLoggerMock.diskUsagePercent.mockReturnValueOnce(
      fileLoggerMock.DISK_CRITICAL_PERCENT + 1,
    );
    const res = await request(appNoAuth).post('/api/execute')
      .send({ executionId: 'exec-503-disk', task: { runtime: 'node' } });
    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/disk is critically full/);
    expect(Atomics.load(_runningCountArr, 0)).toBe(0);
  });

  it('NETOPT-9-1: returns 503 during the shutdown-drain window and never touches the capacity ledger', async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const shutdownState = require('../shutdown-state') as {
      setExecutorShuttingDown: (v: boolean) => void;
      resetShutdownStateForTest: () => void;
    };
    shutdownState.setExecutorShuttingDown(true);
    try {
      const res = await request(appNoAuth).post('/api/execute')
        .send({ executionId: 'exec-503-shutdown', task: { runtime: 'node' } });
      expect(res.status).toBe(503);
      expect(res.body.error).toMatch(/shutting down/);
      // 账本不减不增（守卫在容量操作之前返回）
      expect(Atomics.load(_runningCountArr, 0)).toBe(0);
    } finally {
      shutdownState.resetShutdownStateForTest();
    }
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

  it('E-19: returns 400 when requirements is not an array', async () => {
    // 上游 DTO 演进误传字符串会让 `for (const pkg of reqs)` 逐字符当包名迭代
    // （python _validate_requirements 同源问题）——同步 400 拒绝。
    const res = await request(appNoAuth).post('/api/execute').send({
      executionId: 'exec-req-array',
      task: { runtime: 'node', entrypoint: 'index.js', requirements: 'lodash' },
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/array/i);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // S16 对等修复：requirements 校验必须按 runtime 分流
  // ─────────────────────────────────────────────────────────────────────────

  it('P0 回归：python 任务的 pip 形态依赖不再被 npm 正则误拒', async () => {
    // 反证：把入口的 `runtime === 'python' ? ... : !npmNameRe.test(pkg)` 改回
    // 无条件 `!npmNameRe.test(pkg)`，本例立刻转红（这些全是 admin DTO 里写明
    // 的 pip 形态）。此前同一个 python 任务在 executor-python 上正常、在
    // executor-node 上必然 400 —— CONTRACT §3.3 要求的「全对等」被破坏。
    const pipSpecs = [
      ['requests>=2.31', 'lower-bound'],
      ['rich==13.7.1', 'pinned'],
      ['requests[socks]==2.31', 'extras'],
      ['flask~=3.0', 'compatible-release'],
      ['zope.interface>=5', 'dotted-name'],
      ['requests ; python_version<"3.8"', 'marker'],
    ];
    for (const [spec, label] of pipSpecs) {
      const res = await request(appNoAuth).post('/api/execute').send({
        // executionId 必须匹配协议的 `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`
        // （它就是 workDir 下的目录名）——故这里只能用 ASCII 标签。
        executionId: `exec-pip-${label}`,
        task: { runtime: 'python', entrypoint: 'main.py', requirements: [spec] },
      });
      // 接受即 200（`acceptExecution` 返回 `{ status: 200, payload: { status: 'accepted' } }`）。
      expect([spec, res.status]).toEqual([spec, 200]);
      expect(res.body.status).toBe('accepted');
    }
  });

  it('P0 回归：python 任务的选项形态依赖被拒（argv 注入闸门）', async () => {
    // npm 正则**接受** `-r` / `--index-url` 这类单 token（每个元素各自都能匹配），
    // 而它们会被原样 push 进 `uv pip install` argv —— `--index-url pypi.evil.com`
    // 即包索引劫持。python 侧 `_validate_requirements` 把 leading-'-' 当作唯一注入
    // 向量，node 必须同判。
    for (const spec of ['-r', '--index-url', '-e', '--extra-index-url']) {
      const res = await request(appNoAuth).post('/api/execute').send({
        executionId: `exec-inject-${spec}`,
        task: { runtime: 'python', entrypoint: 'main.py', requirements: [spec] },
      });
      expect([spec, res.status]).toEqual([spec, 400]);
      expect(res.body.error).toMatch(/options are not allowed/i);
    }
  });

  it('node 任务的 npm 命名规则保持不变（不因分流而放松）', async () => {
    // 反向护栏：分流只应让 python 走 python 的规则，node 侧必须仍然拒绝
    // 非 npm 形态（否则这次修复会变成"把闸门整个拆掉"）。
    const res = await request(appNoAuth).post('/api/execute').send({
      executionId: 'exec-node-still-strict',
      task: {
        runtime: 'node',
        entrypoint: 'index.js',
        requirements: ['requests>=2.31'],
      },
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

describe('abortAllLiveExecutions (NETOPT-C P3)', () => {
  it('marks every live execution aborted + aborts its controller (prepare-stage children tree-killed via runCommand signal)', async () => {
    const proc = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter; stderr: EventEmitter; pid: number; kill: jest.Mock;
    };
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.pid = 4243;
    proc.kill = jest.fn();
    (mockCp.spawn as jest.Mock).mockReturnValue(proc);

    const promise = runTask(
      { id: 'task-abort', name: 'a', cmd: 'node', args: ['x.js'], workDir: '/tmp/test-workdir', env: {}, timeout: 60 },
      {},
      'exec-abort',
    );

    const n = abortAllLiveExecutions();
    expect(n).toBe(1);
    // 幂等：已 abort 的不重复
    expect(abortAllLiveExecutions()).toBe(0);

    // 停机路径随后照常树杀 runProcess 登记的进程组
    const killed = killRunningTaskProcesses();
    expect(killed).toBe(1);

    proc.emit('close', 0);
    await promise;
    expect(killRunningTaskProcesses()).toBe(0);
  });

  it('abort during git-checkout prepare tree-kills the clone child via runCommand signal (NETOPT-D P3-2)', async () => {
    // N2: 既有 abort 用例只覆盖 runProcess 运行阶段；prepare 阶段的 git clone
    // 走 runCommand（spawn options 含 signal）——abort 后其 signal 必须已触发，
    // 否则 detached 克隆进程在停机后继续下载（孤儿家族）。
    testConfig.maxConcurrentTasks = 5;
    let gitSpawnCall = 0;
    const pendingGit: Array<Function> = [];
    const spawnSignals: Array<AbortSignal | undefined> = [];
    (mockCp.spawn as jest.Mock).mockImplementation((_cmd: string, _args: string[], opts?: any) => {
      gitSpawnCall++;
      if (opts?.signal) spawnSignals.push(opts.signal);
      return {
        stdout: { on: jest.fn() },
        stderr: { on: jest.fn() },
        on: jest.fn((event: string, cb: Function) => {
          if (event === 'close') pendingGit.push(cb);
        }),
        kill: jest.fn(),
        pid: 33333,
      };
    });

    let captured: { onComplete?: () => void; runPrepared?: any } = {};
    (taskWorkerManager.execute as jest.Mock).mockImplementationOnce(
      async (_tid: string, _eid: string, _task: any, _params: any, onComplete?: () => void, runPrepared?: any) => {
        captured = { onComplete, runPrepared };
      },
    );

    const execRes = await request(appNoAuth).post('/api/execute').send({
      executionId: 'exec-abort-during-git',
      task: { runtime: 'node', gitRepo: 'https://example.com/repo.git' },
    });
    expect(execRes.status).toBe(200);
    await flushAsync();
    expect(captured.runPrepared).toBeTruthy();

    // 轮到执行：prepare 开始 git clone（pending spawn）
    let prepError: any;
    const prep = (async () => {
      try {
        await captured.runPrepared!(() => undefined);
      } catch (err) {
        prepError = err;
      }
    })();
    await flushAsync();
    expect(gitSpawnCall).toBeGreaterThan(0);

    // 停机 drain：abort 所有 live execution → git clone 的 runCommand signal 触发
    const n = abortAllLiveExecutions();
    expect(n).toBe(1);
    expect(spawnSignals.length).toBeGreaterThan(0);
    for (const sig of spawnSignals) {
      expect(sig!.aborted).toBe(true);
    }

    // 树杀后的 git 子进程退出 → prepare 转 ExecutionCancelledError
    for (const close of pendingGit.splice(0)) close(null);
    await prep;
    expect(prepError?.name).toBe('ExecutionCancelledError');

    // 真实 worker 同款收尾：catch 内 onComplete 幂等释放容量（本测试手动驱动
    // runPrepared 绕过了 stub 的 try/catch，这里补上等价收尾再断言归零）
    captured.onComplete?.();
    expect(Atomics.load(_runningCountArr, 0)).toBe(0);

    // P3-4: abort（停机，非 kill）时 prepare 阶段补推 status=failed 终态回调
    const failed = (pushCallback as jest.Mock).mock.calls
      .map((c) => c[0])
      .filter((p: any) => p.executionId === 'exec-abort-during-git' && p.status === 'failed');
    expect(failed).toHaveLength(1);
    expect(failed[0].failureReason).toBeUndefined();
    // NETOPT-E P3-4: 补推终态同时写 execMeta——桌面历史对停机 abort 的执行
    // 能看到结束原因（此前只 pushCallback，观测层与 dispatch 失败分支不一致）。
    const metaWrites = (mockFs.writeFileSync as jest.Mock).mock.calls.filter((c) =>
      String(c[0]).endsWith('exec-abort-during-git.json'),
    );
    expect(metaWrites.length).toBeGreaterThan(0);
    expect(String(metaWrites[metaWrites.length - 1][1])).toContain('"status": "failed"');
  });

  it('abort during zip-download prepare rejects via the passed signal and pushes a failed terminal (NETOPT-F P2-3)', async () => {
    // P2-3: 既有 prepare-abort 用例只走 git checkout 渠道；zip 渠道（execute.ts:1442
    // downloadFile 透传 entry.abortController.signal）接线正确但零测试——把这行
    // signal 删掉全绿。mock 下载为挂起 Promise（abort 触发 reject，与真实
    // download.ts 语义一致），abort 后断言 signal 已触发 + 补推 failed 终态 +
    // execMeta 落盘 + 容量归零。
    testConfig.maxConcurrentTasks = 5;
    (mockDownloadFile as jest.Mock).mockImplementation(
      (_url: string, _dest: string, opts?: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          const sig = opts?.signal;
          if (!sig) {
            reject(new Error('zip test: abort signal missing'));
            return;
          }
          if (sig.aborted) {
            reject(new Error('Download aborted'));
            return;
          }
          sig.addEventListener('abort', () => reject(new Error('Download aborted')), { once: true });
          // 永不 resolve——abort 由测试驱动
        }),
    );

    let captured: { onComplete?: () => void; runPrepared?: any } = {};
    (taskWorkerManager.execute as jest.Mock).mockImplementationOnce(
      async (_tid: string, _eid: string, _task: any, _params: any, onComplete?: () => void, runPrepared?: any) => {
        captured = { onComplete, runPrepared };
      },
    );

    const execRes = await request(appNoAuth).post('/api/execute').send({
      executionId: 'exec-abort-during-zip',
      task: {
        runtime: 'node',
        codeSource: 'application_zip',
        applicationId: 'app-1',
        packageUrl: 'https://example.com/app.zip',
      },
    });
    expect(execRes.status).toBe(200);
    await flushAsync();
    expect(captured.runPrepared).toBeTruthy();

    let prepError: any;
    const prep = (async () => {
      try {
        await captured.runPrepared!(() => undefined);
      } catch (err) {
        prepError = err;
      }
    })();
    await flushAsync();
    expect(mockDownloadFile).toHaveBeenCalled();
    const dlOpts = (mockDownloadFile as jest.Mock).mock.calls[0][2] as { signal?: AbortSignal };
    expect(dlOpts.signal).toBeTruthy();

    // 停机 drain：abort 所有 live execution → zip 下载持有的 signal 必须已触发
    const n = abortAllLiveExecutions();
    expect(n).toBe(1);
    expect(dlOpts.signal!.aborted).toBe(true);

    await prep;
    expect(prepError?.name).toBe('ExecutionCancelledError');

    // 真实 worker 同款收尾：catch 内 onComplete 幂等释放容量
    captured.onComplete?.();
    expect(Atomics.load(_runningCountArr, 0)).toBe(0);

    // P3-4 同款：abort（停机）时 zip prepare 补推 status=failed 终态回调 + execMeta
    const failed = (pushCallback as jest.Mock).mock.calls
      .map((c) => c[0])
      .filter((p: any) => p.executionId === 'exec-abort-during-zip' && p.status === 'failed');
    expect(failed).toHaveLength(1);
    expect(failed[0].failureReason).toBeUndefined();
    const metaWrites = (mockFs.writeFileSync as jest.Mock).mock.calls.filter((c) =>
      String(c[0]).endsWith('exec-abort-during-zip.json'),
    );
    expect(metaWrites.length).toBeGreaterThan(0);
    expect(String(metaWrites[metaWrites.length - 1][1])).toContain('"status": "failed"');
  });
});

// ---------------------------------------------------------------------------
// runProcess stdio (NETOPT-9-2)
// ---------------------------------------------------------------------------

describe('runProcess stdio (NETOPT-9-2)', () => {
  it('task process spawns with stdio ignoring stdin (never holds an open stdin pipe)', async () => {
    const proc = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter; stderr: EventEmitter; pid: number; kill: jest.Mock;
    };
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.pid = 7777;
    proc.kill = jest.fn();
    (mockCp.spawn as jest.Mock).mockReturnValue(proc);

    const promise = runTask(
      { id: 'task-stdio', name: 's', cmd: 'node', args: ['stdin.js'], workDir: '/tmp/test-workdir', env: {}, timeout: 60 },
      {},
      'exec-stdio',
    );

    // 裸任务（无 git/npm 准备步骤）只 spawn 一次——即任务进程本身。
    const spawnCalls = (mockCp.spawn as jest.Mock).mock.calls;
    expect(spawnCalls.length).toBe(1);
    const options = spawnCalls[0][2] as Record<string, unknown>;
    expect(options.stdio).toEqual(['ignore', 'pipe', 'pipe']);

    proc.emit('close', 0);
    await promise;
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

  // A3 反证有牙：404/200 的 kill 出参都必须被**生成的** KillResponse 接受
  // （逐字段同形 {ok:bool}），strict 还必须拒绝未声明的额外键。
  it('404 kill body conforms to the generated KillResponse schema (strict)', async () => {
    const res = await request(appNoAuth).post('/api/executions/never-started/kill');
    expect(KillResponseSchema.safeParse(res.body).success).toBe(true);
    expect(KillResponseSchema.safeParse({ ok: false, stray: 1 }).success).toBe(false);
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
      // A3：200 kill 出参同样过生成的 KillResponse
      expect(KillResponseSchema.safeParse(killRes.body).success).toBe(true);
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

  it('AUTOFLOW_ADMIN_API_URL prefers the external URL (python parity)', async () => {
    // AUTOFLOW-API-URL-01：executor-python 注入的是
    // `admin_api.get_admin_api_base_url()`，优先级 external > internal > default；
    // 本侧此前只读 `adminApiUrlInternal || adminApiUrl`，于是配了公网地址时
    // 执行器**自己**出站走公网、注入给任务代码的却是容器内网址——同一进程
    // 两个答案，且任务侧回调失败是静默的（只是没有中间回调）。
    //
    // 反证：把 execute.ts 的注入改回 `config.adminApiUrlInternal || config.adminApiUrl`，
    // 本例立即转红（会得到 http://admin-internal:3105）。
    (testConfig as any).adminApiUrlExternal = 'https://admin.example.com/api';
    (testConfig as any).adminApiUrlInternal = 'http://admin-internal:3105';
    try {
      const env = await postExecute('exec-apiurl-1');
      expect(env.AUTOFLOW_ADMIN_API_URL).toBe('https://admin.example.com/api');
    } finally {
      delete (testConfig as any).adminApiUrlExternal;
      (testConfig as any).adminApiUrlInternal = 'http://admin-api:3105';
    }
  });

  it('AUTOFLOW_ADMIN_API_URL falls back to internal then default', async () => {
    (testConfig as any).adminApiUrlInternal = 'http://admin-internal:3105';
    try {
      const env = await postExecute('exec-apiurl-2');
      expect(env.AUTOFLOW_ADMIN_API_URL).toBe('http://admin-internal:3105');
    } finally {
      (testConfig as any).adminApiUrlInternal = 'http://admin-api:3105';
    }
    const envDefault = await postExecute('exec-apiurl-3');
    expect(envDefault.AUTOFLOW_ADMIN_API_URL).toBe('http://admin-api:3105');
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
    (mockFs.writeFileSync as jest.Mock).mockImplementation((fp: string, content: string | Buffer) => {
      if (String(fp).endsWith('.npmrc')) {
        writtenNpmrc.push(String(content));
        mockNpmFiles.add(String(fp));
      }
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

  it('cleans token-bearing npm config after a successful install', async () => {
    testConfig.npmRegistryUrl = 'http://verdaccio:4873/';
    testConfig.npmRegistryToken = 'secret-token-success';
    (mockCp.spawn as jest.Mock).mockReturnValue(okSpawn());

    const res = await request(appNoAuth).post('/api/execute').send({
      executionId: 'exec-npm-success-cleanup',
      task: { id: 'task-success', runtime: 'node', entrypoint: 'index.js', requirements: ['left-pad'] },
    });
    expect(res.status).toBe(200);
    await flushAsync();

    expect(mockNpmFiles.size).toBe(0);
    expect((mockFs.unlinkSync as jest.Mock).mock.calls.length).toBeGreaterThanOrEqual(2);
    expect((mockFs.rmSync as jest.Mock).mock.calls.some(([dir]) => String(dir).includes('autocodeflow-npm-'))).toBe(true);
  });

  it('cleans token-bearing npm config when npm exits unsuccessfully', async () => {
    testConfig.npmRegistryUrl = 'http://verdaccio:4873/';
    testConfig.npmRegistryToken = 'secret-token-failure';
    (mockCp.spawn as jest.Mock).mockReturnValue({
      stdout: { on: jest.fn() },
      stderr: { on: jest.fn((event: string, cb: Function) => { if (event === 'data') cb(Buffer.from('401 Unauthorized')); }) },
      on: jest.fn((event: string, cb: Function) => { if (event === 'close') setImmediate(() => cb(1)); }),
      kill: jest.fn(),
      pid: 4567,
    });

    const res = await request(appNoAuth).post('/api/execute').send({
      executionId: 'exec-npm-failure-cleanup',
      task: { id: 'task-failure', runtime: 'node', entrypoint: 'index.js', requirements: ['left-pad'] },
    });
    expect(res.status).toBe(200);
    await flushAsync();

    expect(mockNpmFiles.size).toBe(0);
    const failCall = (pushCallback as jest.Mock).mock.calls
      .map(c => c[0])
      .find(p => p.executionId === 'exec-npm-failure-cleanup' && p.status === 'failed');
    expect(failCall?.errorMessage).toMatch(/Dependency installation failed/);
  });

  it('cleans token-bearing npm config after an npm timeout', async () => {
    testConfig.npmRegistryUrl = 'http://verdaccio:4873/';
    testConfig.npmRegistryToken = 'secret-token-timeout';
    const pendingClose: Array<(code: number | null) => void> = [];
    (mockCp.spawn as jest.Mock).mockImplementation(() => ({
      stdout: { on: jest.fn() },
      stderr: { on: jest.fn() },
      on: jest.fn((event: string, cb: Function) => { if (event === 'close') pendingClose.push(cb as (code: number | null) => void); }),
      kill: jest.fn(),
      pid: 5678,
    }));

    const res = await request(appNoAuth).post('/api/execute').send({
      executionId: 'exec-npm-timeout-cleanup',
      task: { id: 'task-timeout', runtime: 'node', entrypoint: 'index.js', requirements: ['left-pad'] },
    });
    expect(res.status).toBe(200);
    await flushAsync();
    expect(mockNpmFiles.size).toBe(2);
    expect(pendingClose).toHaveLength(1);

    pendingClose[0](1);
    await flushAsync();
    expect(mockNpmFiles.size).toBe(0);
  });

  it('cleans token-bearing npm config when npm setup throws', async () => {
    testConfig.npmRegistryUrl = 'http://verdaccio:4873/';
    testConfig.npmRegistryToken = 'secret-token-exception';
    (mockCp.spawn as jest.Mock).mockImplementation(() => {
      throw new Error('npm spawn setup failed');
    });

    const res = await request(appNoAuth).post('/api/execute').send({
      executionId: 'exec-npm-exception-cleanup',
      task: { id: 'task-exception', runtime: 'node', entrypoint: 'index.js', requirements: ['left-pad'] },
    });
    expect(res.status).toBe(200);
    await flushAsync();

    expect(mockNpmFiles.size).toBe(0);
    const failCall = (pushCallback as jest.Mock).mock.calls
      .map(c => c[0])
      .find(p => p.executionId === 'exec-npm-exception-cleanup' && p.status === 'failed');
    expect(failCall?.errorMessage).toMatch(/npm spawn setup failed/);
  });

  it('reports npm config cleanup failure instead of silently continuing', async () => {
    testConfig.npmRegistryUrl = 'http://verdaccio:4873/';
    testConfig.npmRegistryToken = 'secret-token-cleanup-error';
    (mockCp.spawn as jest.Mock).mockReturnValue(okSpawn());
    (mockFs.unlinkSync as jest.Mock).mockImplementation((file: fs.PathLike) => {
      if (String(file).endsWith('.npmrc')) {
        throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
      }
      mockNpmFiles.delete(String(file));
    });

    const res = await request(appNoAuth).post('/api/execute').send({
      executionId: 'exec-npm-cleanup-error',
      task: { id: 'task-cleanup-error', runtime: 'node', entrypoint: 'index.js', requirements: ['left-pad'] },
    });
    expect(res.status).toBe(200);
    await flushAsync();

    const { logger } = require('../logger');
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('Unable to remove temporary npm config'));
    const failCall = (pushCallback as jest.Mock).mock.calls
      .map(c => c[0])
      .find(p => p.executionId === 'exec-npm-cleanup-error' && p.status === 'failed');
    expect(failCall?.errorMessage).toMatch(/Unable to remove temporary npm config/);
  });

  it('does not place token config in the task runtime cwd', async () => {
    testConfig.npmRegistryUrl = 'http://verdaccio:4873/';
    testConfig.npmRegistryToken = 'secret-token-cwd';
    (mockCp.spawn as jest.Mock).mockReturnValue(okSpawn());

    const res = await request(appNoAuth).post('/api/execute').send({
      executionId: 'exec-npm-cwd-isolation',
      task: { id: 'task-cwd', runtime: 'node', entrypoint: 'index.js', requirements: ['left-pad'] },
    });
    expect(res.status).toBe(200);
    await flushAsync();

    const npmCall = (mockCp.spawn as jest.Mock).mock.calls.find(
      (call: unknown[]) => call[0] === (process.platform === 'win32' ? 'npm.cmd' : 'npm'),
    );
    expect(npmCall).toBeTruthy();
    const opts = npmCall![2] as { cwd?: string; env?: Record<string, string | undefined> };
    // W-20/Windows CI：cwd 是 workDir 的平台拼接结果，不能写死 POSIX 字面量
    expect(opts.cwd).toBe(path.join(testConfig.workDir, 'exec-npm-cwd-isolation'));
    expect(opts.env?.npm_config_userconfig).not.toContain(opts.cwd!);
    expect(opts.env?.npm_config_userconfig).toMatch(/[\\/]autocodeflow-npm-[^\\/]+[\\/]\.npmrc$/);
  });

  it('uses an isolated npm env and disables token-bearing lifecycle scripts', async () => {
    testConfig.npmRegistryUrl = 'http://verdaccio:4873/';
    testConfig.npmRegistryToken = 'secret-token-xyz';
    process.env.NPM_REGISTRY_TOKEN = 'host-token';
    process.env.EXECUTOR_SHARED_TOKEN = 'shared-secret';
    process.env.EXECUTOR_SECRET = 'legacy-secret';
    (mockCp.spawn as jest.Mock).mockReturnValue(okSpawn());

    try {
      const res = await request(appNoAuth).post('/api/execute').send({
        executionId: 'exec-npm-env',
        task: { id: 'taskN', runtime: 'node', entrypoint: 'index.js', requirements: ['left-pad'] },
      });
      expect(res.status).toBe(200);
      await flushAsync();

      const npmCall = (mockCp.spawn as jest.Mock).mock.calls.find(
        (call: unknown[]) => call[0] === (process.platform === 'win32' ? 'npm.cmd' : 'npm'),
      );
      expect(npmCall).toBeTruthy();
      const args = npmCall![1] as string[];
      const opts = npmCall![2] as { cwd?: string; env?: Record<string, string | undefined> };
      const env = opts.env!;
      expect(args).toContain('--ignore-scripts');
      expect(opts.cwd).toBe(path.join(testConfig.workDir, 'exec-npm-env'));
      expect(env.PATH).toBeDefined();
      expect(env.HOME).toBeDefined();
      expect(env.npm_config_registry).toBe('http://verdaccio:4873/');
      expect(env.npm_config_userconfig).toMatch(/[\\/]autocodeflow-npm-[^\\/]+[\\/]\.npmrc$/);
      expect(env.npm_config_userconfig).not.toContain(opts.cwd!);
      expect(env.npm_config_globalconfig).toMatch(/[\\/]autocodeflow-npm-[^\\/]+[\\/]\.npm-globalrc$/);
      expect(env.npm_config_cache).toMatch(/\.node_modules[\\/]taskN[\\/]\.npm-cache$/);
      expect(env.NPM_REGISTRY_TOKEN).toBeUndefined();
      expect(env.EXECUTOR_SHARED_TOKEN).toBeUndefined();
      expect(env.EXECUTOR_SECRET).toBeUndefined();
      expect(env.npm_config_authToken).toBeUndefined();
    } finally {
      delete process.env.NPM_REGISTRY_TOKEN;
      delete process.env.EXECUTOR_SHARED_TOKEN;
      delete process.env.EXECUTOR_SECRET;
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
    const _prep = (async () => {
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

// ---------------------------------------------------------------------------
// E-26（DEEP_REVIEW 0ef3bbe）：win32 shell:true 下 npm --prefix 的路径引号。
// 旧实现把 nodeModulesDir 原样塞进 argv；WORK_DIR 含空格时 cmd.exe 会把
// `--prefix C:\My Tasks\nm` 拆成两个 token，npm 把后半段当成要安装的包名。
// ---------------------------------------------------------------------------
describe('E-26 npm --prefix quoting under shell:true', () => {
  it('quoteShellArgForPlatform: quotes only on win32 and only when needed', () => {
    // win32：含空白/shell 元字符必须包引号，否则 cmd.exe 重新分词
    expect(quoteShellArgForPlatform('/tmp/My Tasks/nm', 'win32')).toBe('"/tmp/My Tasks/nm"');
    expect(quoteShellArgForPlatform('C:\\a&b', 'win32')).toBe('"C:\\a&b"');
    expect(quoteShellArgForPlatform('C:\\a|b', 'win32')).toBe('"C:\\a|b"');
    // win32：无空白/元字符保持原样（不引入无谓引号）
    expect(quoteShellArgForPlatform('C:\\tasks\\nm', 'win32')).toBe('C:\\tasks\\nm');
    // POSIX：shell:false，参数直传 execve——加引号会变成路径的一部分
    expect(quoteShellArgForPlatform('/tmp/My Tasks/nm', 'linux')).toBe('/tmp/My Tasks/nm');
    expect(quoteShellArgForPlatform('/tmp/My Tasks/nm', 'darwin')).toBe('/tmp/My Tasks/nm');
  });

  it('passes a quoted --prefix when WORK_DIR contains a space', async () => {
    // E-26：本 spec 顶层 jest.mock('../config') 将 config 换成普通对象属性，
    // 其 workDir 不响应 process.env.WORK_DIR。直接覆盖 mock 的 workDir 为
    // 含空格路径，等价于真实 config.workDir getter 读到含空格 WORK_DIR
    // （Windows 上很常见：C:\My Tasks / C:\Program Files\...）。
    const { config } = jest.requireMock('../config');
    const originalWorkDir = config.workDir;
    config.workDir = '/tmp/My Tasks';
    (mockCp.spawn as jest.Mock).mockReturnValue(okSpawn());
    (taskWorkerManager.execute as jest.Mock).mockImplementationOnce(
      async (_tid: string, _eid: string, _task: any, _params: any, onComplete?: () => void, runPrepared?: any) => {
        if (runPrepared) await runPrepared(() => undefined);
        if (onComplete) onComplete();
      },
    );

    try {
      const res = await request(appNoAuth).post('/api/execute').send({
        executionId: 'exec-prefix-space',
        task: { id: 'taskSp', runtime: 'node', entrypoint: 'index.js', requirements: ['left-pad'] },
      });
      expect(res.status).toBe(200);
      await flushAsync();

      const npmCall = (mockCp.spawn as jest.Mock).mock.calls.find((c) =>
        String(c[0]).includes('npm'),
      );
      expect(npmCall).toBeTruthy();
      const args = npmCall![1] as string[];
      const prefixIdx = args.indexOf('--prefix');
      expect(prefixIdx).toBeGreaterThanOrEqual(0);

      const rawPrefix = path.join('/tmp/My Tasks', '.node_modules', 'taskSp');
      expect(args[prefixIdx + 1]).toBe(quoteShellArgForPlatform(rawPrefix));
      // 回归护栏：win32 下不得再把含空格的路径裸传（旧行为）
      if (process.platform === 'win32') {
        expect(args[prefixIdx + 1]).not.toBe(rawPrefix);
        expect(args[prefixIdx + 1]).toBe(`"${rawPrefix}"`);
      }
    } finally {
      config.workDir = originalWorkDir;
    }
  });
});

// ---------------------------------------------------------------------------
// A3-C：协议向量驱动 POST /execute（node 侧）
// ---------------------------------------------------------------------------
/**
 * 与 `src/protocol-schemas.spec.ts` 的区别：后者断言的是「生成的 zod schema 与
 * 协议一致」，这里断言的是「**端点真的按协议拒绝**」。少了这一层，schema 只是
 * 一份被测试引用的产物——删掉运行时的手检、端点照收不误，协议也不会红。
 *
 * 只跑 invalid 方向：valid 方向会真实登记 live execution 并占用容量槽位（本
 * 文件前面的用例已占用多个），而「合法载荷能被接受」由 protocol-schemas.spec
 * 与既有的 200 用例覆盖。invalid 载荷在登记之前就被拒，无副作用。
 */
describe('A3-C 协议闸门：schemaVectors.ExecuteRequest.invalid 必须被 /execute 拒绝', () => {
  // fs 在本文件被 jest.mock('fs') 全量自动 mock——读协议必须绕开它。
  const realFs = jest.requireActual('fs') as typeof import('fs');
  const realPath = jest.requireActual('path') as typeof import('path');
  const PROTOCOL_RELATIVE = realPath.join('packages', 'executor-protocol', 'protocol.json');

  let root = __dirname;
  for (let i = 0; i < 8 && !realFs.existsSync(realPath.join(root, PROTOCOL_RELATIVE)); i++) {
    root = realPath.dirname(root);
  }
  const protocol = JSON.parse(
    realFs.readFileSync(realPath.join(root, PROTOCOL_RELATIVE), 'utf-8'),
  );

  interface Vec {
    name: string;
    payload: Record<string, unknown>;
    expectErrorPath: (string | number)[];
  }
  const invalid: Vec[] = protocol.schemaVectors.ExecuteRequest.invalid;

  it('扫描面非空——向量被清空/键名写错时本组断言会变成永真', () => {
    expect(Array.isArray(invalid)).toBe(true);
    expect(invalid.length).toBeGreaterThanOrEqual(6);
  });

  for (const vec of invalid) {
    it(`invalid「${vec.name}」→ 400（不是 200，也不是 500）`, async () => {
      const res = await request(appNoAuth).post('/api/execute').send(vec.payload);
      expect([vec.name, res.status]).toEqual([vec.name, 400]);
      expect(typeof res.body.error).toBe('string');
      expect(res.body.error.length).toBeGreaterThan(0);
    });
  }
});

// ── NETOPT-F P3: bwrap 探测缓存状态机 ─────────────────────────────────────
// resolveBwrapPath 的缓存规则：仅"确定"结论写缓存（status=0 找到、status=1
// clean not-found）；status=null（timeout/信号）与异常是"本次没探到"，不写
// 缓存留待重试——否则启动期一次撞车会把执行器存活期内所有 bwrap 任务永久
// fail-closed。jest.mock('child_process') 全量 mock 下 spawnSync 是 jest.fn。
describe('NETOPT-F P3: bwrap probe cache state machine', () => {
  const cp = require('child_process');
  const spawnSyncMock = cp.spawnSync as jest.Mock;

  beforeEach(() => {
    __resetBwrapPathCacheForTest();
    jest.clearAllMocks();
  });
  afterAll(() => {
    __resetBwrapPathCacheForTest();
  });

  it('status 0: caches the real path, second call does not re-probe', () => {
    spawnSyncMock.mockReturnValue({
      status: 0,
      stdout: '/usr/bin/bwrap\n',
    });
    expect(resolveBwrapPath()).toBe('/usr/bin/bwrap');
    expect(resolveBwrapPath()).toBe('/usr/bin/bwrap');
    expect(spawnSyncMock).toHaveBeenCalledTimes(1);
  });

  it('status 1 (clean not-found): caches empty, second call does not re-probe', () => {
    spawnSyncMock.mockReturnValue({ status: 1, stdout: '' });
    expect(resolveBwrapPath()).toBe('');
    expect(resolveBwrapPath()).toBe('');
    expect(spawnSyncMock).toHaveBeenCalledTimes(1);
  });

  it('status null (timeout): returns empty but does NOT cache — next call re-probes', () => {
    spawnSyncMock.mockReturnValue({ status: null, stdout: '' });
    expect(resolveBwrapPath()).toBe('');
    // 未缓存：第二次调用必须重新探测
    expect(resolveBwrapPath()).toBe('');
    expect(spawnSyncMock).toHaveBeenCalledTimes(2);
  });

  it('exception during probe: returns empty but does NOT cache — next call re-probes', () => {
    spawnSyncMock.mockImplementation(() => {
      throw new Error('spawn ENOENT');
    });
    expect(resolveBwrapPath()).toBe('');
    expect(resolveBwrapPath()).toBe('');
    expect(spawnSyncMock).toHaveBeenCalledTimes(2);
  });

  it('after a cached not-found, reset hook re-enables probing', () => {
    spawnSyncMock.mockReturnValue({ status: 1, stdout: '' });
    expect(resolveBwrapPath()).toBe('');
    __resetBwrapPathCacheForTest();
    spawnSyncMock.mockReturnValue({ status: 0, stdout: '/usr/bin/bwrap\n' });
    expect(resolveBwrapPath()).toBe('/usr/bin/bwrap');
    expect(spawnSyncMock).toHaveBeenCalledTimes(2);
  });
});

// ── NETOPT-G P2-2: buildTaskSandboxArgv 拒绝/argv 构造分支 ───────────────────
// 此前 5 个状态机用例只测 resolveBwrapPath 缓存，从不经过 buildTaskSandboxArgv
// ——"TASK_SANDBOX=bwrap 而二进制缺失/平台不符时绝不静默降级直跑"的安全承诺
// 零回归保护（若误删 :2338 throw 或改回退直跑，全部用例仍绿）。本 describe
// 钉死三条：win32 守卫、fail-closed 拒绝、成功路径 argv。
describe('NETOPT-G P2-2: bwrap argv construction fail-closed branches', () => {
  const cp = require('child_process');
  const spawnSyncMock = cp.spawnSync as jest.Mock;
  const originalPlatform = process.platform;

  beforeEach(() => {
    __resetBwrapPathCacheForTest();
    jest.clearAllMocks();
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
  });
  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
    __resetBwrapPathCacheForTest();
  });

  it('passthrough when TASK_SANDBOX is not bwrap', () => {
    (testConfig as { taskSandbox: string }).taskSandbox = '';
    const out = buildTaskSandboxArgv('node', ['-e', 'x'], '/work/a');
    expect(out).toEqual({ cmd: 'node', args: ['-e', 'x'] });
  });

  it('win32: throws "not supported on Windows" (never runs unsandboxed)', () => {
    (testConfig as { taskSandbox: string }).taskSandbox = 'bwrap';
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    expect(() => buildTaskSandboxArgv('node', [], '/work/a')).toThrow(/not supported on Windows/);
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });

  it('bwrap not on PATH: throws fail-closed (no silent downgrade to unsandboxed)', () => {
    (testConfig as { taskSandbox: string }).taskSandbox = 'bwrap';
    spawnSyncMock.mockReturnValue({ status: 1, stdout: '' });
    expect(() => buildTaskSandboxArgv('node', ['run.js'], '/work/a')).toThrow(/not on PATH/);
    expect(spawnSyncMock).toHaveBeenCalledTimes(1);
  });

  it('probe timeout (status null): still throws fail-closed for THIS task, no cache poison', () => {
    (testConfig as { taskSandbox: string }).taskSandbox = 'bwrap';
    spawnSyncMock.mockReturnValue({ status: null, stdout: '' });
    expect(() => buildTaskSandboxArgv('node', [], '/work/a')).toThrow(/not on PATH/);
    // 未写缓存：下一任务重新探测
    spawnSyncMock.mockReturnValue({ status: 0, stdout: '/usr/bin/bwrap\n' });
    expect(buildTaskSandboxArgv('node', [], '/work/a').cmd).toBe('/usr/bin/bwrap');
    expect(spawnSyncMock).toHaveBeenCalledTimes(2);
  });

  it('success path: wraps under bwrap with die-with-parent/unshare-all and bind cwd', () => {
    (testConfig as { taskSandbox: string }).taskSandbox = 'bwrap';
    spawnSyncMock.mockReturnValue({ status: 0, stdout: '/usr/bin/bwrap\n' });
    const out = buildTaskSandboxArgv('python', ['main.py', '--flag'], '/work/x');
    expect(out.cmd).toBe('/usr/bin/bwrap');
    const a = out.args;
    expect(a).toContain('--die-with-parent');
    expect(a).toContain('--unshare-all');
    expect(a).toContain('--share-net');
    expect(a).toContain('--chdir');
    const sep = a.indexOf('--');
    expect(sep).toBeGreaterThan(-1);
    expect(a.slice(sep + 1)).toEqual(['python', 'main.py', '--flag']);
  });
});
