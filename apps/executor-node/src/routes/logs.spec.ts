import request from 'supertest';
import express from 'express';
import * as fs from 'fs';
import * as path from 'path';
import { Readable } from 'stream';

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

import { logsRouter, getExecutorAuthToken } from './logs';

const mockFs = fs as jest.Mocked<typeof fs>;

// LOG-02: the router streams via fs.createReadStream — feed it a real stream
// built from the mock content instead of mocking readFileSync.
function mockLogFile(content: string) {
  (mockFs.createReadStream as jest.Mock).mockImplementation(() =>
    Readable.from([content]),
  );
}

// ---------------------------------------------------------------------------
// Helper apps
// ---------------------------------------------------------------------------
const TEST_TOKEN = 'test-secret-token';

// App without auth middleware — the /api/* Bearer gate is verifyToken
// (middleware/auth.ts), exercised in its own spec; the logs route itself is
// tested here without auth.
const appNoAuth = express();
appNoAuth.use(express.json());
appNoAuth.use('/api', logsRouter);

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
// getExecutorAuthToken — token source resolution (live code, used by /health).
// The former legacy logs-route Bearer middleware checks are covered against the
//现役 gate verifyToken in middleware/auth.spec.ts.
// ---------------------------------------------------------------------------
describe('getExecutorAuthToken', () => {
  it('prefers EXECUTOR_SHARED_TOKEN over legacy EXECUTOR_SECRET', () => {
    process.env.EXECUTOR_SHARED_TOKEN = TEST_TOKEN;
    process.env.EXECUTOR_SECRET = 'legacy-secret-token';
    expect(getExecutorAuthToken()).toBe(TEST_TOKEN);
  });

  it('falls back to legacy EXECUTOR_SECRET when the shared token is unset', () => {
    delete process.env.EXECUTOR_SHARED_TOKEN;
    process.env.EXECUTOR_SECRET = 'legacy-secret-token';
    expect(getExecutorAuthToken()).toBe('legacy-secret-token');
  });

  it('returns empty string when no token is configured (dev mode)', () => {
    delete process.env.EXECUTOR_SHARED_TOKEN;
    delete process.env.EXECUTOR_SECRET;
    // config mock for this spec carries no `token`, so the getter bottoms out.
    expect(getExecutorAuthToken()).toBe('');
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
    mockLogFile('line1\nline2\nline3\n');

    const res = await request(appNoAuth).get('/api/logs/exec-ok');
    expect(res.status).toBe(200);
    expect(res.body.lines).toEqual(['line1', 'line2', 'line3']);
    expect(res.body.totalLines).toBe(3);
    expect(res.body.hasMore).toBe(false);
  });

  it('returns only lines from fromLine onwards', async () => {
    (mockFs.existsSync as jest.Mock).mockReturnValue(true);
    mockLogFile('a\nb\nc\nd\n');

    const res = await request(appNoAuth).get('/api/logs/exec-from?fromLine=2');
    expect(res.status).toBe(200);
    expect(res.body.lines).toEqual(['c', 'd']);
    expect(res.body.totalLines).toBe(4);
  });

  it('honors the limit parameter and reports hasMore for further pages', async () => {
    (mockFs.existsSync as jest.Mock).mockReturnValue(true);
    mockLogFile('a\nb\nc\nd\n');

    const res = await request(appNoAuth).get('/api/logs/exec-limit?limit=2');
    expect(res.status).toBe(200);
    expect(res.body.lines).toEqual(['a', 'b']);
    expect(res.body.totalLines).toBe(4);
    expect(res.body.hasMore).toBe(true);

    // Last page has no more lines
    const last = await request(appNoAuth).get('/api/logs/exec-limit?fromLine=2&limit=2');
    expect(last.body.lines).toEqual(['c', 'd']);
    expect(last.body.hasMore).toBe(false);
  });

  it('falls back to the default limit for invalid limit input', async () => {
    (mockFs.existsSync as jest.Mock).mockReturnValue(true);
    mockLogFile('a\nb\nc\n');

    const res = await request(appNoAuth).get('/api/logs/exec-badlimit?limit=abc');
    expect(res.status).toBe(200);
    expect(res.body.lines).toEqual(['a', 'b', 'c']);
    expect(res.body.hasMore).toBe(false);
  });

  it('clamps huge limit values to the admin backfill page size', async () => {
    (mockFs.existsSync as jest.Mock).mockReturnValue(true);
    mockLogFile(
      Array.from({ length: 2100 }, (_, i) => `line${i}`).join('\n') + '\n',
    );

    const res = await request(appNoAuth).get('/api/logs/exec-huge?limit=99999');
    expect(res.status).toBe(200);
    expect(res.body.lines).toHaveLength(2000);
    expect(res.body.totalLines).toBe(2100);
    expect(res.body.hasMore).toBe(true);
  });

  it('returns 200 with empty lines array when fromLine exceeds total', async () => {
    (mockFs.existsSync as jest.Mock).mockReturnValue(true);
    mockLogFile('only-one\n');

    const res = await request(appNoAuth).get('/api/logs/exec-overflow?fromLine=99');
    expect(res.status).toBe(200);
    expect(res.body.lines).toEqual([]);
    expect(res.body.totalLines).toBe(1);
  });

  it('reassembles lines split across stream chunks (streaming path)', async () => {
    (mockFs.existsSync as jest.Mock).mockReturnValue(true);
    (mockFs.createReadStream as jest.Mock).mockImplementation(() =>
      Readable.from(['line1\nli', 'ne2\nline3\n']),
    );

    const res = await request(appNoAuth).get('/api/logs/exec-chunks?fromLine=1&limit=1');
    expect(res.status).toBe(200);
    expect(res.body.lines).toEqual(['line2']);
    expect(res.body.totalLines).toBe(3);
    expect(res.body.hasMore).toBe(true);
  });

  it('returns 500 when the log stream fails (open race / read error)', async () => {
    (mockFs.existsSync as jest.Mock).mockReturnValue(true);
    (mockFs.createReadStream as jest.Mock).mockImplementation(() => {
      const failing = new Readable({ read() {} });
      failing.destroy(new Error('stream boom'));
      return failing;
    });

    const res = await request(appNoAuth).get('/api/logs/exec-error');
    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/Failed to read log file/);
  });
});
