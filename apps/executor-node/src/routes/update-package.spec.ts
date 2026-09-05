import request from 'supertest';
import express from 'express';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as childProcess from 'child_process';
import * as http from 'http';
import type { AddressInfo } from 'net';

// Mock everything before importing the router
jest.mock('fs');
jest.mock('child_process');
jest.mock('../config', () => ({
  config: {
    workDir: '/tmp/test-workdir',
    appName: 'test-executor',
    executorAddress: 'localhost:8002',
    executorId: '',
    token: 'test-shared-token',
  },
}));
jest.mock('../logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../admin-client', () => ({
  adminClient: {
    reportExecutorStatus: jest.fn().mockResolvedValue(undefined),
  },
  // Named exports used by update-package route
  post: jest.fn().mockResolvedValue({ data: {} }),
  get: jest.fn().mockResolvedValue({ data: {} }),
  put: jest.fn().mockResolvedValue({ data: {} }),
  del: jest.fn().mockResolvedValue({ data: {} }),
  reportExecutorStatus: jest.fn().mockResolvedValue(undefined),
}));

import { updatePackageRouter } from './update-package';

const mockFs = fs as jest.Mocked<typeof fs>;
const mockCp = childProcess as jest.Mocked<typeof childProcess>;

const TEST_TOKEN = 'test-secret-token';

function makeApp(withAuth = false) {
  const app = express();
  app.use(express.json());
  if (withAuth) {
    app.use('/api', (req, res, next) => {
      const header = req.headers['authorization'] ?? '';
      const token = header.startsWith('Bearer ') ? header.slice(7) : '';
      if (token !== TEST_TOKEN) {
        res.status(401).json({ error: 'Invalid or missing executor token' });
        return;
      }
      next();
    });
  }
  app.use('/api', updatePackageRouter);
  return app;
}

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.EXECUTOR_SHARED_TOKEN;

  // Default fs mocks — directory exists, files writable
  (mockFs.existsSync as jest.Mock).mockReturnValue(true);
  (mockFs.mkdirSync as jest.Mock).mockReturnValue(undefined);
  (mockFs.writeFileSync as jest.Mock).mockReturnValue(undefined);
  (mockFs.unlinkSync as jest.Mock).mockReturnValue(undefined);
  (mockFs.readdirSync as jest.Mock).mockReturnValue([]);
  // Safe lstat — not a symlink
  (mockFs.lstatSync as jest.Mock).mockReturnValue({ isSymbolicLink: () => false } as any);
  (mockFs.realpathSync as unknown as jest.Mock).mockImplementation((p: string) => p);
});

afterEach(() => {
  delete process.env.EXECUTOR_SHARED_TOKEN;
});

async function waitForUpdateToSettle(app: express.Express): Promise<void> {
  // 25ms granularity over ~3s of sleeps: plenty of headroom for slow CI
  // machines (the flows under test are local+mocked and settle in ~ms), while
  // the explicit final assert turns a never-settling flow into a named test
  // failure instead of silently leaking an in-progress flag into the next test.
  for (let i = 0; i < 120; i++) {
    const res = await request(app).get('/api/update-package/status');
    if (res.body.inProgress === false) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  const res = await request(app).get('/api/update-package/status');
  expect(res.body.inProgress).toBe(false);
}

// ---------------------------------------------------------------------------
// POST /api/update-package — payload validation
// ---------------------------------------------------------------------------
describe('POST /api/update-package — payload validation', () => {
  const app = makeApp();
  let spyCwd: jest.SpyInstance;

  beforeEach(() => {
    // The accepted-URL tests kick off a real async download against an
    // unreachable port. Redirect process.cwd() so the route's temp
    // .pkg-updates writes land outside the repository (previously the real
    // repo dir kept a stray .pkg-updates directory after every run, and a
    // slow createWriteStream could race with later tests' fs cleanup).
    spyCwd = jest.spyOn(process, 'cwd').mockReturnValue(path.join(os.tmpdir(), 'acf-up-validation'));
  });

  afterEach(() => {
    spyCwd.mockRestore();
  });

  it('returns 400 when packageId is missing', async () => {
    const res = await request(app)
      .post('/api/update-package')
      .send({ downloadUrl: 'http://example.com/pkg.zip' });
    expect(res.status).toBe(400);
  });

  it('returns 400 when downloadUrl is missing', async () => {
    const res = await request(app)
      .post('/api/update-package')
      .send({ packageId: 'pkg-001' });
    expect(res.status).toBe(400);
  });

  it('returns 400 for non-http(s) downloadUrl (file: scheme)', async () => {
    const res = await request(app)
      .post('/api/update-package')
      .send({ packageId: 'pkg-001', downloadUrl: 'file:///etc/passwd', version: '1.0.0', checksum: 'a'.repeat(64) });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/scheme|not allowed|invalid|http/i);
  });

  it('rejects a relative downloadUrl without starting an update', async () => {
    const res = await request(app)
      .post('/api/update-package')
      .send({ packageId: 'pkg-001', downloadUrl: '/api/executor-packages/pkg-001/download', version: '1.0.0', checksum: 'a'.repeat(64) });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('downloadUrl is not a valid URL');
    expect((await request(app).get('/api/update-package/status')).body.inProgress).toBe(false);
  });

  it('returns 400 when checksum is missing', async () => {
    const res = await request(app)
      .post('/api/update-package')
      .send({ packageId: 'pkg-001', downloadUrl: 'http://example.com/pkg.zip', version: '1.0.0' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/checksum/i);
  });

  it('returns 400 for ftp: scheme in downloadUrl', async () => {
    const res = await request(app)
      .post('/api/update-package')
      .send({ packageId: 'pkg-001', downloadUrl: 'ftp://example.com/pkg.zip', version: '1.0.0', checksum: 'e'.repeat(64) });
    expect(res.status).toBe(400);
  });

  it('returns 400 for a packageId with path separators (traversal guard)', async () => {
    const res = await request(app)
      .post('/api/update-package')
      .send({ packageId: '../escape', downloadUrl: 'http://example.com/pkg.zip', version: '1.0.0', checksum: 'f'.repeat(64) });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/packageId/);
    expect(mockFs.writeFileSync).not.toHaveBeenCalled();
  });

  it('returns 400 for a packageId with unsafe characters (spaces, slashes)', async () => {
    const res = await request(app)
      .post('/api/update-package')
      .send({ packageId: 'pkg 001/evil', downloadUrl: 'http://example.com/pkg.zip', version: '1.0.0', checksum: 'f'.repeat(64) });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/packageId/);
  });

  it('accepts http: scheme in downloadUrl', async () => {
    // Route accepts the URL; async download will start but is mocked out.
    // We only care the status is not 400 at the validation stage.
    const res = await request(app)
      .post('/api/update-package')
      .send({ packageId: 'pkg-002', downloadUrl: 'http://127.0.0.1:1/pkg.zip', version: '2.0.0', checksum: 'b'.repeat(64) });
    expect(res.status).toBe(200);
    expect(res.body.accepted).toBe(true);
    await waitForUpdateToSettle(app);
  });

  it('accepts https: scheme in downloadUrl', async () => {
    const res = await request(app)
      .post('/api/update-package')
      .send({ packageId: 'pkg-003', downloadUrl: 'https://127.0.0.1:1/pkg.zip', version: '3.0.0', checksum: 'c'.repeat(64) });
    expect(res.status).toBe(200);
    expect(res.body.accepted).toBe(true);
    await waitForUpdateToSettle(app);
  });
});

// ---------------------------------------------------------------------------
// POST /api/update-package — authentication
// ---------------------------------------------------------------------------
describe('POST /api/update-package — authentication', () => {
  beforeEach(() => {
    process.env.EXECUTOR_SHARED_TOKEN = TEST_TOKEN;
  });

  it('returns 401 when no token is provided', async () => {
    const app = makeApp(true);
    const res = await request(app)
      .post('/api/update-package')
      .send({ packageId: 'pkg-001', downloadUrl: 'http://example.com/pkg.zip' });
    expect(res.status).toBe(401);
  });

  it('returns 401 when wrong token is provided', async () => {
    const app = makeApp(true);
    const res = await request(app)
      .post('/api/update-package')
      .set('Authorization', 'Bearer wrong')
      .send({ packageId: 'pkg-001', downloadUrl: 'http://example.com/pkg.zip' });
    expect(res.status).toBe(401);
  });

  it('passes through with correct token', async () => {
    const app = makeApp(true);
    // The request may fail at download time (no real HTTP), but should not be 401
    const res = await request(app)
      .post('/api/update-package')
      .set('Authorization', `Bearer ${TEST_TOKEN}`)
      .send({ packageId: 'pkg-001', downloadUrl: 'file:///etc/passwd', checksum: 'd'.repeat(64) }); // blocked by url validation
    expect(res.status).not.toBe(401);
    expect(res.status).toBe(400); // blocked by URL scheme check, not auth
  });
});

// ---------------------------------------------------------------------------
// POST /api/update-package — download behaviour (Bearer token, watchdog)
// ---------------------------------------------------------------------------
describe('POST /api/update-package — download behaviour', () => {
  const actualFs = jest.requireActual('fs') as typeof fs;
  const actualHttp = jest.requireActual('http') as typeof import('http');
  const actualCrypto = jest.requireActual('crypto') as typeof import('crypto');
  const { post } = jest.requireMock('../admin-client') as { post: jest.Mock };

  const app = makeApp();

  beforeEach(() => {
    // Restore real createWriteStream/readFile existence checks so the shared
    // downloader can actually stream a response from a local test server.
    (mockFs.createWriteStream as jest.Mock).mockImplementation((p: string) =>
      actualFs.createWriteStream(p),
    );
    (mockFs.createReadStream as unknown as jest.Mock).mockImplementation((p: string) =>
      actualFs.createReadStream(p),
    );
    (mockFs.existsSync as jest.Mock).mockImplementation((p: string) => actualFs.existsSync(p));
    (mockFs.mkdirSync as jest.Mock).mockImplementation(((dir: string) => {
      actualFs.mkdirSync(dir, { recursive: true });
      return undefined;
    }) as never);
    (mockFs.unlinkSync as jest.Mock).mockImplementation(((p: string) => {
      try { actualFs.unlinkSync(p); } catch { /* already gone */ }
      return undefined;
    }) as never);
  });

  function listen(server: http.Server): Promise<number> {
    return new Promise((resolve) =>
      server.listen(0, '127.0.0.1', () => {
        const address = server.address() as AddressInfo;
        resolve(address.port);
      }),
    );
  }

  it('downloads with the executor Bearer token, verifies checksum and reports downloaded', async () => {
    const seen: Array<string | undefined> = [];
    const payload = 'fake-executor-package-body';
    const checksum = actualCrypto.createHash('sha256').update(payload).digest('hex');
    const server = actualHttp.createServer((req, res) => {
      seen.push(req.headers.authorization);
      res.writeHead(200);
      res.end(payload);
    });
    const port = await listen(server);
    const tmpDir = actualFs.mkdtempSync(path.join(require('os').tmpdir(), 'acf-up-'));

    // Redirect process.cwd() so .pkg-updates lands in the temp dir
    const realCwd = process.cwd();
    const spyCwd = jest.spyOn(process, 'cwd').mockReturnValue(tmpDir);
    try {
      post.mockResolvedValue({ data: {} });
      const res = await request(app)
        .post('/api/update-package')
        .send({
          packageId: 'pkg-download-test',
          name: 'executor',
          version: '9.9.9',
          downloadUrl: `http://127.0.0.1:${port}/executor.zip`,
          checksum,
        });
      expect(res.status).toBe(200);
      expect(res.body.accepted).toBe(true);

      // Wait until the flow settles
      for (let i = 0; i < 200; i++) {
        const status = await request(app).get('/api/update-package/status');
        if (status.body.inProgress === false && seen.length > 0 && post.mock.calls.length > 0) break;
        await new Promise((r) => setTimeout(r, 25));
      }

      // Explicit settle assert — an exhausted early-exit loop must not skip
      // the assertions below with the flow still running.
      const settled = await request(app).get('/api/update-package/status');
      expect(settled.body.inProgress).toBe(false);

      expect(seen).toEqual(['Bearer test-shared-token']);
      const pushed = post.mock.calls.find((c: unknown[]) => c[0] === '/api/executor-packages/push-result');
      expect(pushed).toBeDefined();
      expect((pushed as unknown[])[1]).toEqual(
        expect.objectContaining({ packageId: 'pkg-download-test', status: 'downloaded' }),
      );
      // The downloaded file is kept for the deployment pipeline
      expect(actualFs.existsSync(path.join(tmpDir, '.pkg-updates', 'pkg-download-test.zip'))).toBe(true);
    } finally {
      spyCwd.mockRestore();
      server.close();
      actualFs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 20_000);

  it('releases updateInProgress when the download fails (no permanent 409)', async () => {
    const server = actualHttp.createServer((_req, res) => {
      res.writeHead(500);
      res.end('broken');
    });
    const port = await listen(server);
    const tmpDir = actualFs.mkdtempSync(path.join(require('os').tmpdir(), 'acf-up-fail-'));
    const spyCwd = jest.spyOn(process, 'cwd').mockReturnValue(tmpDir);
    try {
      const res = await request(app)
        .post('/api/update-package')
        .send({
          packageId: 'pkg-fail-test',
          name: 'executor',
          version: '9.9.8',
          downloadUrl: `http://127.0.0.1:${port}/executor.zip`,
          checksum: 'a'.repeat(64),
        });
      expect(res.status).toBe(200);

      await waitForUpdateToSettle(app);

      const status = await request(app).get('/api/update-package/status');
      expect(status.body.inProgress).toBe(false);
      // A subsequent update must not be rejected with 409
      const retry = await request(app)
        .post('/api/update-package')
        .send({
          packageId: 'pkg-fail-test-2',
          name: 'executor',
          version: '9.9.8',
          downloadUrl: `http://127.0.0.1:${port}/executor.zip`,
          checksum: 'a'.repeat(64),
        });
      expect(retry.status).not.toBe(409);
    } finally {
      spyCwd.mockRestore();
      server.close();
      actualFs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 20_000);
});
