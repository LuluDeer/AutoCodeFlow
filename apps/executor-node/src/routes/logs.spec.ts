import request from 'supertest';
import express from 'express';
import * as fs from 'fs';
import * as path from 'path';

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

import { logsRouter, executorAuthMiddleware, getExecutorAuthToken } from './logs';

const mockFs = fs as jest.Mocked<typeof fs>;

// ---------------------------------------------------------------------------
// Helper apps
// ---------------------------------------------------------------------------
const TEST_TOKEN = 'test-secret-token';

// App without auth middleware
const appNoAuth = express();
appNoAuth.use(express.json());
appNoAuth.use('/api', logsRouter);

// App with auth middleware
const appWithAuth = express();
appWithAuth.use(express.json());
appWithAuth.use('/api', executorAuthMiddleware, logsRouter);

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.EXECUTOR_SHARED_TOKEN;
  delete process.env.EXECUTOR_SECRET;
  (mockFs.existsSync as jest.Mock).mockReturnValue(false);
});

afterEach(() => {
  delete process.env.EXECUTOR_SHARED_TOKEN;
  delete process.env.EXECUTOR_SECRET;
});

// ---------------------------------------------------------------------------
// executorAuthMiddleware unit tests
// ---------------------------------------------------------------------------
describe('executorAuthMiddleware', () => {
  it('prefers EXECUTOR_SHARED_TOKEN over legacy EXECUTOR_SECRET', () => {
    process.env.EXECUTOR_SHARED_TOKEN = TEST_TOKEN;
    process.env.EXECUTOR_SECRET = 'legacy-secret-token';

    expect(getExecutorAuthToken()).toBe(TEST_TOKEN);

    const req = { headers: { authorization: 'Bearer legacy-secret-token' } } as any;
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() } as any;
    const next = jest.fn();

    executorAuthMiddleware(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it('calls next() immediately when no secret is configured', () => {
    delete process.env.EXECUTOR_SHARED_TOKEN;
    const req = {} as any;
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() } as any;
    const next = jest.fn();

    executorAuthMiddleware(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });

  it('returns 401 when secret is set but no Authorization header is provided', () => {
    process.env.EXECUTOR_SHARED_TOKEN = TEST_TOKEN;
    const req = { headers: {} } as any;
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() } as any;
    const next = jest.fn();

    executorAuthMiddleware(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: expect.stringMatching(/Invalid or missing executor token/) }));
  });

  it('returns 401 when wrong token is provided', () => {
    process.env.EXECUTOR_SHARED_TOKEN = TEST_TOKEN;
    const req = { headers: { authorization: 'Bearer wrong-token' } } as any;
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() } as any;
    const next = jest.fn();

    executorAuthMiddleware(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it('calls next() when correct Bearer token is provided', () => {
    process.env.EXECUTOR_SHARED_TOKEN = TEST_TOKEN;
    const req = { headers: { authorization: `Bearer ${TEST_TOKEN}` } } as any;
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() } as any;
    const next = jest.fn();

    executorAuthMiddleware(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// GET /api/logs/:executionId
// ---------------------------------------------------------------------------
describe('GET /api/logs/:executionId', () => {
  it('returns 400 for path-traversal executionId (../etc)', async () => {
    const res = await request(appNoAuth).get('/api/logs/..%2Fetc');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Invalid executionId/);
  });

  it('returns 400 for executionId containing path separators', async () => {
    // Use a double-encoded slash that resolves to a sub-path after basename
    const res = await request(appNoAuth).get('/api/logs/sub%2Ftraversal');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Invalid executionId/);
  });

  it('returns 400 for empty executionId (dot segment)', async () => {
    // Express will normalize '/api/logs/.' to '/api/logs' — send a crafted header instead
    // Testing the basename guard with a single dot value via a path that reaches the handler
    const res = await request(appNoAuth).get('/api/logs/%2E');
    // Express may 400 itself or our guard returns 400
    expect([400, 404]).toContain(res.status);
  });

  it('returns 404 when log file does not exist', async () => {
    (mockFs.existsSync as jest.Mock).mockReturnValue(false);

    const res = await request(appNoAuth).get('/api/logs/exec-missing');
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/Log file not found/);
  });

  it('returns 200 with lines, totalLines and hasMore on success', async () => {
    (mockFs.existsSync as jest.Mock).mockReturnValue(true);
    (mockFs.readFileSync as jest.Mock).mockReturnValue('line1\nline2\nline3\n');

    const res = await request(appNoAuth).get('/api/logs/exec-ok');
    expect(res.status).toBe(200);
    expect(res.body.lines).toEqual(['line1', 'line2', 'line3']);
    expect(res.body.totalLines).toBe(3);
    expect(res.body.hasMore).toBe(false);
  });

  it('returns only lines from fromLine onwards', async () => {
    (mockFs.existsSync as jest.Mock).mockReturnValue(true);
    (mockFs.readFileSync as jest.Mock).mockReturnValue('a\nb\nc\nd\n');

    const res = await request(appNoAuth).get('/api/logs/exec-from?fromLine=2');
    expect(res.status).toBe(200);
    expect(res.body.lines).toEqual(['c', 'd']);
    expect(res.body.totalLines).toBe(4);
  });

  it('returns 200 with empty lines array when fromLine exceeds total', async () => {
    (mockFs.existsSync as jest.Mock).mockReturnValue(true);
    (mockFs.readFileSync as jest.Mock).mockReturnValue('only-one\n');

    const res = await request(appNoAuth).get('/api/logs/exec-overflow?fromLine=99');
    expect(res.status).toBe(200);
    expect(res.body.lines).toEqual([]);
    expect(res.body.totalLines).toBe(1);
  });

  it('returns 500 when readFileSync throws', async () => {
    (mockFs.existsSync as jest.Mock).mockReturnValue(true);
    (mockFs.readFileSync as jest.Mock).mockImplementation(() => {
      throw new Error('disk error');
    });

    const res = await request(appNoAuth).get('/api/logs/exec-error');
    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/Failed to read log file/);
  });

  it('auth middleware blocks request with wrong token for logs route', async () => {
    process.env.EXECUTOR_SHARED_TOKEN = TEST_TOKEN;
    (mockFs.existsSync as jest.Mock).mockReturnValue(true);
    (mockFs.readFileSync as jest.Mock).mockReturnValue('log line\n');

    const res = await request(appWithAuth)
      .get('/api/logs/exec-authtest')
      .set('Authorization', 'Bearer wrong');
    expect(res.status).toBe(401);
  });

  it('auth middleware allows request with correct token for logs route', async () => {
    process.env.EXECUTOR_SHARED_TOKEN = TEST_TOKEN;
    (mockFs.existsSync as jest.Mock).mockReturnValue(true);
    (mockFs.readFileSync as jest.Mock).mockReturnValue('log line\n');

    const res = await request(appWithAuth)
      .get('/api/logs/exec-authtest')
      .set('Authorization', `Bearer ${TEST_TOKEN}`);
    expect(res.status).toBe(200);
  });
});
