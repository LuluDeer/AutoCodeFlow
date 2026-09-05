import request from 'supertest';
import express from 'express';
import * as fs from 'fs';
import * as path from 'path';
import * as childProcess from 'child_process';
import { EventEmitter } from 'events';

// Mock dependencies before importing the router
jest.mock('fs');
jest.mock('../config', () => ({
  config: {
    workDir: '/tmp/test-workdir',
    maxConcurrentTasks: 10,
    appName: 'test-executor',
    executorAddress: 'localhost:8002',
    taskTimeoutSeconds: 300,
    // N23: per-execution callback token inputs (mirrors real config shape)
    token: 'test-shared-secret',
    executionCallbackSecret: '',
    adminApiUrl: 'http://admin-api:3105',
    adminApiUrlInternal: 'http://admin-api:3105',
  },
}));
jest.mock('../logger', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));
// Provide a real SharedArrayBuffer-backed Int32Array for getRunningCountArray
const _sharedBuf = new SharedArrayBuffer(4);
const _runningCountArr = new Int32Array(_sharedBuf);
jest.mock('../scheduler', () => ({
  incrementRunning: jest.fn(),
  decrementRunning: jest.fn(),
  runningCount: 0,
  getRunningCountArray: jest.fn(() => _runningCountArr),
  getRunningCount: jest.fn(() => 0),
}));
jest.mock('../manifest', () => ({
  loadManifest: jest.fn(() => ({})),
  mergeTaskWithManifest: jest.fn((_task: any, _manifest: any) => _task),
}));
jest.mock('../callback', () => ({ pushCallback: jest.fn() }));
jest.mock('../file-logger', () => ({ appendLog: jest.fn() }));
jest.mock('../task-worker', () => ({
  taskWorkerManager: {
    execute: jest.fn((_taskId: string, _execId: string, _task: any, _params: any, onComplete?: () => void) => {
      if (onComplete) onComplete();
    }),
  },
}));
jest.mock('child_process');

import { executeRouter, runTask, gitCheckoutTo, killRunningTaskProcesses, BoundedLogBuffer } from './execute';
import { pushCallback } from '../callback';
import { executorAuthMiddleware } from './logs';
import { taskWorkerManager } from '../task-worker';

// App without auth — used only for non-auth behaviour tests
const appNoAuth = express();
appNoAuth.use(express.json());
appNoAuth.use('/api', executeRouter);

// App with auth middleware — mirrors production wiring in main.ts
const TEST_TOKEN = 'test-secret-token';
const appWithAuth = express();
appWithAuth.use(express.json());
appWithAuth.use('/api', executorAuthMiddleware, executeRouter);

const mockFs = fs as jest.Mocked<typeof fs>;
const mockCp = childProcess as jest.Mocked<typeof childProcess>;

beforeEach(() => {
  jest.clearAllMocks();
  Atomics.store(_runningCountArr, 0, 0);
  delete process.env.EXECUTOR_SHARED_TOKEN;
  (mockFs.existsSync as jest.Mock).mockReturnValue(false);
  (mockFs.mkdirSync as jest.Mock).mockReturnValue(undefined);
  (mockFs.chmodSync as jest.Mock).mockReturnValue(undefined);
  (mockFs.writeFileSync as jest.Mock).mockReturnValue(undefined);
  // Return a non-symlink stat object so path validation passes
  const nonSymlinkStat = { isSymbolicLink: () => false } as any;
  (mockFs.lstatSync as jest.Mock).mockReturnValue(nonSymlinkStat);
  (mockFs.realpathSync as unknown as jest.Mock).mockImplementation((p: string) => p);
});

afterEach(() => {
  delete process.env.EXECUTOR_SHARED_TOKEN;
});

// ---------------------------------------------------------------------------
// S-01: Authentication tests
// ---------------------------------------------------------------------------
describe('POST /api/execute — authentication (S-01)', () => {
  beforeEach(() => {
    process.env.EXECUTOR_SHARED_TOKEN = TEST_TOKEN;
  });

  it('returns 401 when no Authorization header is provided', async () => {
    const res = await request(appWithAuth)
      .post('/api/execute')
      .send({ executionId: 'exec-auth-001', task: { runtime: 'node' } });
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/Invalid or missing executor token/);
  });

  it('returns 401 when a wrong token is provided', async () => {
    const res = await request(appWithAuth)
      .post('/api/execute')
      .set('Authorization', 'Bearer wrong-token')
      .send({ executionId: 'exec-auth-002', task: { runtime: 'node' } });
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/Invalid or missing executor token/);
  });

  it('returns 401 when Authorization scheme is not Bearer', async () => {
    const res = await request(appWithAuth)
      .post('/api/execute')
      .set('Authorization', `Basic ${TEST_TOKEN}`)
      .send({ executionId: 'exec-auth-003', task: { runtime: 'node' } });
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/Invalid or missing executor token/);
  });

  it('passes through with correct token', async () => {
    // The request itself will fail at runtime validation (unsupported runtime)
    // but it should NOT be blocked by auth — status must not be 401
    const res = await request(appWithAuth)
      .post('/api/execute')
      .set('Authorization', `Bearer ${TEST_TOKEN}`)
      .send({ executionId: 'exec-auth-004', task: { runtime: 'unsupported' } });
    expect(res.status).not.toBe(401);
    expect(res.status).toBe(400); // blocked by runtime validation, not auth
  });
});

// ---------------------------------------------------------------------------
// Functional tests (no secret configured — dev mode, auth passthrough)
// ---------------------------------------------------------------------------
describe('POST /api/execute', () => {
  it('returns 400 when executionId is missing', async () => {
    const res = await request(appNoAuth).post('/api/execute').send({ task: { runtime: 'node' } });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/executionId/);
  });

  it('returns 400 for unsupported runtime', async () => {
    // spawn is not called, process exits with code 0
    const mockSpawn = {
      stdout: { on: jest.fn() },
      stderr: { on: jest.fn() },
      on: jest.fn((event: string, cb: Function) => {
        if (event === 'close') cb(0);
      }),
      kill: jest.fn(),
    };
    (mockCp.spawn as jest.Mock).mockReturnValue(mockSpawn);

    const res = await request(appNoAuth)
      .post('/api/execute')
      .send({ executionId: 'exec-001', task: { runtime: 'java' } });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Unsupported runtime/);
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

  it('releases capacity when git checkout fails', async () => {
    // gitCheckoutTo is async now (spawn, not spawnSync): simulate a clone
    // that writes 'clone failed' to stderr and exits with code 1.
    const failingSpawn = {
      stdout: { on: jest.fn() },
      stderr: { on: jest.fn((event: string, cb: Function) => { if (event === 'data') cb(Buffer.from('clone failed')); }) },
      on: jest.fn((event: string, cb: Function) => { if (event === 'close') cb(1); }),
      kill: jest.fn(),
    };
    (mockCp.spawn as jest.Mock).mockReturnValue(failingSpawn);

    const res = await request(appNoAuth).post('/api/execute').send({
      executionId: 'exec-git-fail',
      task: { runtime: 'node', gitRepo: 'https://example.com/repo.git' },
    });

    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/git clone failed/);
    expect(Atomics.load(_runningCountArr, 0)).toBe(0);
  });

  it('releases capacity when task worker enqueue throws synchronously', async () => {
    (taskWorkerManager.execute as jest.Mock).mockImplementationOnce(() => {
      throw new Error('enqueue failed');
    });

    const res = await request(appNoAuth).post('/api/execute').send({
      executionId: 'exec-worker-fail',
      task: { runtime: 'node', entrypoint: 'index.js' },
    });

    expect(res.status).toBe(500);
    expect(res.body.error).toBe('enqueue failed');
    expect(Atomics.load(_runningCountArr, 0)).toBe(0);
  });

  it('runs node task and returns accepted', async () => {
    const res = await request(appNoAuth).post('/api/execute').send({
      executionId: 'exec-004',
      task: { runtime: 'node', entrypoint: 'index.js' },
    });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('accepted');
    expect(res.body.executionId).toBe('exec-004');
  });
});

describe('runTask callback logs', () => {
  it('truncates large logs before pushing callback payload', async () => {
    const proc = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter;
      stderr: EventEmitter;
      pid: number;
      kill: jest.Mock;
    };
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.pid = 12345;
    proc.kill = jest.fn();
    (mockCp.spawn as jest.Mock).mockReturnValue(proc);

    const task = {
      id: 'task-log-truncate',
      name: 'Task with large logs',
      cmd: 'node',
      args: ['index.js'],
      workDir: '/tmp/test-workdir',
      env: {},
      timeout: 60,
    };

    const promise = runTask(task, {}, 'exec-log-truncate');
    proc.stdout.emit('data', Buffer.from('A'.repeat(7000)));
    proc.stderr.emit('data', Buffer.from('B'.repeat(7000)));
    proc.emit('close', 0);
    await promise;

    expect(pushCallback).toHaveBeenCalledTimes(1);
    const payload = (pushCallback as jest.Mock).mock.calls[0][0];
    expect(payload.status).toBe('success');
    expect(payload.logs).toHaveLength(10_000);
    expect(payload.logs.startsWith('A'.repeat(100))).toBe(true);
    expect(payload.logs.endsWith('B'.repeat(100))).toBe(true);
    expect(payload.logs).toContain('[logs truncated, original length 14000 chars]');
  });

  it('caps in-memory log accumulation for very chatty tasks', async () => {
    const proc = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter;
      stderr: EventEmitter;
      pid: number;
      kill: jest.Mock;
    };
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.pid = 12346;
    proc.kill = jest.fn();
    (mockCp.spawn as jest.Mock).mockReturnValue(proc);

    const task = {
      id: 'task-log-cap',
      name: 'Chatty task',
      cmd: 'node',
      args: ['index.js'],
      workDir: '/tmp/test-workdir',
      env: {},
      timeout: 60,
    };

    const promise = runTask(task, {}, 'exec-log-cap');
    proc.stdout.emit('data', Buffer.from('x'.repeat(3_000_000)));
    proc.stdout.emit('data', Buffer.from('y'.repeat(3_000_000)));
    proc.emit('close', 0);
    await promise;

    const payload = (pushCallback as jest.Mock).mock.calls[0][0];
    // truncateCallbackLogs caps the payload at 10k, but its "original length"
    // reflects the in-memory buffer: without the BoundedLogBuffer it would be
    // 6,000,000 chars.
    const original = Number(/original length (\d+) chars/.exec(payload.logs)![1]);
    expect(original).toBeLessThan(1_200_000);
    expect(payload.logs).toHaveLength(10_000);
  });
});

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

describe('killRunningTaskProcesses', () => {
  it('kills the detached task process group (POSIX) / process tree via taskkill (win32) for running tasks', async () => {
    const proc = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter;
      stderr: EventEmitter;
      pid: number;
      kill: jest.Mock;
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
        // W-03 (windows-findings): win32 has no negative-pid group kill —
        // killProcessTree must taskkill the whole tree and direct-kill as
        // belt-and-braces.
        expect(mockCp.spawn).toHaveBeenCalledWith(
          'taskkill',
          ['/T', '/F', '/PID', '4242'],
          expect.objectContaining({ stdio: 'ignore' }),
        );
        expect(proc.kill).toHaveBeenCalledWith('SIGKILL');
      }
    } finally {
      killSpy.mockRestore();
    }

    proc.emit('close', 0);
    await promise;

    // Registry cleaned up — a second sweep has nothing to kill.
    expect(killRunningTaskProcesses()).toBe(0);
  });
});

describe('task hardening', () => {
  it('injects NODE_PATH pointing at the shared .node_modules dir and leaks no secrets', async () => {
    process.env.EXECUTOR_SHARED_TOKEN = 'top-secret';
    process.env.EXECUTOR_SECRET = 'legacy-secret';
    process.env.SOME_TASK_ENV = 'leak-me';
    const okSpawn = {
      stdout: { on: jest.fn() },
      stderr: { on: jest.fn() },
      on: jest.fn((event: string, cb: Function) => { if (event === 'close') cb(0); }),
      kill: jest.fn(),
    };
    (mockCp.spawn as jest.Mock).mockReturnValue(okSpawn);

    const res = await request(appNoAuth).post('/api/execute').send({
      executionId: 'exec-nodepath',
      task: { id: 'taskA', runtime: 'node', entrypoint: 'index.js', requirements: ['left-pad'] },
    });
    expect(res.status).toBe(200);

    const taskArg = (taskWorkerManager.execute as jest.Mock).mock.calls.at(-1)[2];
    expect(taskArg.env.NODE_PATH).toBe(
      path.join('/tmp/test-workdir', '.node_modules', 'taskA', 'node_modules'),
    );
    expect(taskArg.env.EXECUTOR_SHARED_TOKEN).toBeUndefined();
    expect(taskArg.env.EXECUTOR_SECRET).toBeUndefined();
    expect(taskArg.env.SOME_TASK_ENV).toBeUndefined();
    expect(taskArg.env.PATH).toBeDefined();
    delete process.env.SOME_TASK_ENV;
  });

  it('rejects option-like git refs', async () => {
    const res = await request(appNoAuth).post('/api/execute').send({
      executionId: 'exec-ref',
      task: { runtime: 'node', gitRepo: 'https://example.com/repo.git', gitBranch: '-b' },
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Invalid git ref/);
  });

  it('rejects out-of-bounds task timeouts', async () => {
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

  it('rejects entrypoints that escape the task work directory', async () => {
    const res = await request(appNoAuth).post('/api/execute').send({
      executionId: 'exec-entry-escape',
      task: { runtime: 'shell', entrypoint: '../../etc/evil.sh' },
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/entrypoint escapes/);

    const res2 = await request(appNoAuth).post('/api/execute').send({
      executionId: 'exec-entry-escape-node',
      task: { runtime: 'node', entrypoint: '../sibling.js' },
    });
    expect(res2.status).toBe(400);
    expect(res2.body.error).toMatch(/entrypoint escapes/);
  });
});

describe('git cache serialization', () => {
  it('serializes concurrent checkouts of the same repo (no overlapping clones)', async () => {
    const events: string[] = [];
    const pendingCloses: Array<() => void> = [];
    let active = 0;
    let maxActive = 0;
    (mockCp.spawn as jest.Mock).mockImplementation(() => {
      events.push('spawn');
      active++;
      maxActive = Math.max(maxActive, active);
      return {
        stdout: { on: jest.fn() },
        stderr: { on: jest.fn() },
        on: jest.fn((event: string, cb: Function) => {
          if (event === 'close') {
            pendingCloses.push(() => {
              active--;
              events.push('close');
              cb(0);
            });
          }
        }),
        kill: jest.fn(),
      };
    });

    const p1 = gitCheckoutTo('https://example.com/repo.git', 'main', '/tmp/test-workdir/exec-e1');
    await new Promise(r => setTimeout(r, 0));
    const p2 = gitCheckoutTo('https://example.com/repo.git', 'main', '/tmp/test-workdir/exec-e2');
    await new Promise(r => setTimeout(r, 0));

    // The second checkout is queued behind the first — only one spawn so far.
    expect(events.filter(e => e === 'spawn').length).toBe(1);

    // Drain all commands (each is clone/checkout closing with code 0).
    for (let i = 0; i < 20 && pendingCloses.length; i++) {
      pendingCloses.shift()!();
      await new Promise(r => setTimeout(r, 0));
    }
    await Promise.all([p1, p2]);

    expect(maxActive).toBe(1);
    // Two checkouts × (clone + checkout) = 4 spawns, none overlapping.
    expect(events.filter(e => e === 'spawn').length).toBe(4);
  });

  // W-23 (windows-findings): a taskkill /F during a clone leaves a partial
  // cache dir on disk (the rmtree cleanup never ran). The next checkout must
  // detect it via the bare-repo probe, QUARANTINE it (rename — not delete, so
  // a Windows file lock can't re-break the healing) and re-clone, instead of
  // failing on `git clone` ("destination exists") forever.
  it('quarantines a corrupt cache dir and self-heals by re-cloning (W-23)', async () => {
    const spawned: Array<[string, string[]]> = [];
    // Call order: rev-parse probe (corrupt → fail), clone (ok), checkout (ok).
    const results = [1, 0, 0];
    (mockCp.spawn as jest.Mock).mockImplementation((cmd: string, args: string[]) => {
      spawned.push([cmd, args]);
      const status = results.shift() ?? 0;
      return {
        stdout: { on: jest.fn() },
        stderr: { on: jest.fn() },
        on: jest.fn((event: string, cb: Function) => {
          if (event === 'close') setImmediate(() => cb(status));
        }),
        kill: jest.fn(),
      };
    });
    // Cache dir + HEAD present until the quarantine rename "moves" it aside.
    let cacheAlive = true;
    (mockFs.existsSync as jest.Mock).mockImplementation(
      (p: string) => cacheAlive && String(p).includes('.git_cache'),
    );
    let quarantinedTo = '';
    (mockFs.renameSync as jest.Mock).mockImplementation((from: string, to: string) => {
      quarantinedTo = String(to);
      cacheAlive = false;
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
  // The '../config' mock above is a stable object; mutate per-test and restore.
  const cfg = require('../config').config as {
    token: string;
    executionCallbackSecret: string;
  };

  const okSpawn = {
    stdout: { on: jest.fn() },
    stderr: { on: jest.fn() },
    on: jest.fn((event: string, cb: Function) => {
      if (event === 'close') cb(0);
    }),
    kill: jest.fn(),
  };

  let savedToken: string;
  let savedCallbackSecret: string;

  beforeEach(() => {
    savedToken = cfg.token;
    savedCallbackSecret = cfg.executionCallbackSecret;
    (mockCp.spawn as jest.Mock).mockReturnValue(okSpawn);
  });

  afterEach(() => {
    cfg.token = savedToken;
    cfg.executionCallbackSecret = savedCallbackSecret;
  });

  async function postExecute(executionId: string, params?: Record<string, unknown>) {
    const res = await request(appNoAuth).post('/api/execute').send({
      executionId,
      task: { id: 'cbtask', runtime: 'node', entrypoint: 'index.js' },
      params,
    });
    expect(res.status).toBe(200);
    const taskArg = (taskWorkerManager.execute as jest.Mock).mock.calls.at(-1)[2];
    return taskArg.env as Record<string, string | undefined>;
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
    // default timeout 300s + 900s grace (±60s slack for test execution)
    expect(exp).toBeGreaterThan(now + 1100);
    expect(exp).toBeLessThan(now + 1300);
    expect(parts[3]).toMatch(/^[0-9a-f]{64}$/);
    expect(env.AUTOFLOW_ADMIN_API_URL).toBe('http://admin-api:3105');
  });

  it('never leaks the shared token or the callback HMAC secret into the child env', async () => {
    process.env.EXECUTOR_SHARED_TOKEN = 'top-secret-shared';
    process.env.EXECUTION_CALLBACK_SECRET = 'dedicated-secret';
    cfg.executionCallbackSecret = 'dedicated-secret';
    const env = await postExecute('exec-cbtoken-2');
    expect(env.AUTOFLOW_CALLBACK_TOKEN).toBeDefined();
    expect(env.EXECUTOR_SHARED_TOKEN).toBeUndefined();
    expect(env.EXECUTION_CALLBACK_SECRET).toBeUndefined();
    // The token must not BE the shared token or contain it.
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

  it('omits the token when no executor secret is configured (dev mode, SDK stays disabled)', async () => {
    cfg.token = '';
    cfg.executionCallbackSecret = '';
    const env = await postExecute('exec-cbtoken-4');
    expect(env.AUTOFLOW_CALLBACK_TOKEN).toBeUndefined();
    expect(env.AUTOFLOW_ADMIN_API_URL).toBe('http://admin-api:3105');
  });

  // N27: the per-execution callback path requires executorAddress on every
  // item — executor-node injects its own registered address so task code
  // never has to hardcode it.
  it('injects AUTOFLOW_EXECUTOR_ADDRESS, preferring the public address (same value as registration)', async () => {
    const addrCfg = require('../config').config as {
      executorAddress: string;
      executorAddressPublic?: string;
    };
    const envDefault = await postExecute('exec-addr-1');
    expect(envDefault.AUTOFLOW_EXECUTOR_ADDRESS).toBe('localhost:8002');

    addrCfg.executorAddressPublic = 'public.host:9000';
    try {
      const envPublic = await postExecute('exec-addr-2');
      expect(envPublic.AUTOFLOW_EXECUTOR_ADDRESS).toBe('public.host:9000');
    } finally {
      delete addrCfg.executorAddressPublic;
    }
  });

  it('user params cannot override AUTOFLOW_EXECUTOR_ADDRESS', async () => {
    const env = await postExecute('exec-addr-3', {
      executor_address: 'evil:1234',
    });
    expect(env.AUTOFLOW_EXECUTOR_ADDRESS).toBe('localhost:8002');
  });
});
