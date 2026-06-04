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

const app = express();
app.use(express.json());
app.use('/api', executeRouter);

const mockFs = fs as jest.Mocked<typeof fs>;
const mockCp = childProcess as jest.Mocked<typeof childProcess>;

beforeEach(() => {
  jest.clearAllMocks();
  (mockFs.existsSync as jest.Mock).mockReturnValue(false);
  (mockFs.mkdirSync as jest.Mock).mockReturnValue(undefined);
  (mockFs.chmodSync as jest.Mock).mockReturnValue(undefined);
  (mockFs.writeFileSync as jest.Mock).mockReturnValue(undefined);
});

describe('POST /api/execute', () => {
  it('returns 400 when executionId is missing', async () => {
    const res = await request(app).post('/api/execute').send({ task: { runtime: 'node' } });
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

    const res = await request(app)
      .post('/api/execute')
      .send({ executionId: 'exec-001', task: { runtime: 'java' } });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Unsupported runtime/);
  });

  it('returns 400 for invalid gitRepo scheme', async () => {
    const res = await request(app).post('/api/execute').send({
      executionId: 'exec-002',
      task: { runtime: 'node', gitRepo: 'file:///etc/passwd' },
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/gitRepo URL scheme not allowed/);
  });

  it('returns 400 for invalid npm package name', async () => {
    const res = await request(app).post('/api/execute').send({
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

    const res = await request(app).post('/api/execute').send({
      executionId: 'exec-004',
      task: { runtime: 'node', entrypoint: 'index.js' },
    });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.logs).toContain('hello');
  });
});
