import request from 'supertest';
import express from 'express';
import * as fs from 'fs';
import * as path from 'path';
import * as childProcess from 'child_process';

// Mock dependencies before importing the router
jest.mock('fs');
jest.mock('../config', () => ({
  config: {
    workDir: '/tmp/test-workdir',
    maxConcurrentTasks: 10,
    appName: 'test-executor',
    executorAddress: 'localhost:8002',
  },
}));
jest.mock('../logger', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));
jest.mock('../scheduler', () => ({
  incrementRunning: jest.fn(),
  decrementRunning: jest.fn(),
  runningCount: 0,
}));
jest.mock('../manifest', () => ({
  loadManifest: jest.fn(() => ({})),
  mergeTaskWithManifest: jest.fn((_task: any, _manifest: any) => _task),
}));
jest.mock('child_process');

import { executeRouter } from './execute';
import { executorAuthMiddleware } from './logs';

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
  delete process.env.EXECUTOR_SHARED_TOKEN;
  (mockFs.existsSync as jest.Mock).mockReturnValue(false);
  (mockFs.mkdirSync as jest.Mock).mockReturnValue(undefined);
  (mockFs.chmodSync as jest.Mock).mockReturnValue(undefined);
  (mockFs.writeFileSync as jest.Mock).mockReturnValue(undefined);
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

  it('runs node task and returns success', async () => {
    const mockSpawn = {
      stdout: { on: jest.fn((_e: string, cb: Function) => cb(Buffer.from('hello\n'))) },
      stderr: { on: jest.fn() },
      on: jest.fn((event: string, cb: Function) => {
        if (event === 'close') cb(0);
      }),
      kill: jest.fn(),
    };
    (mockCp.spawn as jest.Mock).mockReturnValue(mockSpawn);

    const res = await request(appNoAuth).post('/api/execute').send({
      executionId: 'exec-004',
      task: { runtime: 'node', entrypoint: 'index.js' },
    });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.logs).toContain('hello');
  });
});
