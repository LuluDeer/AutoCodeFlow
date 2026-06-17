import request from 'supertest';
import express from 'express';
import * as fs from 'fs';
import * as path from 'path';
import * as childProcess from 'child_process';

// Mock everything before importing the router
jest.mock('fs');
jest.mock('child_process');
jest.mock('../config', () => ({
  config: {
    workDir: '/tmp/test-workdir',
    appName: 'test-executor',
    executorAddress: 'localhost:8002',
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

// ---------------------------------------------------------------------------
// POST /api/update-package — payload validation
// ---------------------------------------------------------------------------
describe('POST /api/update-package — payload validation', () => {
  const app = makeApp();

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
      .send({ packageId: 'pkg-001', downloadUrl: 'file:///etc/passwd', version: '1.0.0' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/scheme|not allowed|invalid|http/i);
  });

  it('returns 400 for ftp: scheme in downloadUrl', async () => {
    const res = await request(app)
      .post('/api/update-package')
      .send({ packageId: 'pkg-001', downloadUrl: 'ftp://example.com/pkg.zip', version: '1.0.0' });
    expect(res.status).toBe(400);
  });

  it('accepts http: scheme in downloadUrl', async () => {
    // Route accepts the URL; async download will start but is mocked out.
    // We only care the status is not 400 at the validation stage.
    const res = await request(app)
      .post('/api/update-package')
      .send({ packageId: 'pkg-002', downloadUrl: 'http://example.com/pkg.zip', version: '2.0.0' });
    expect(res.status).not.toBe(400);
  });

  it('accepts https: scheme in downloadUrl', async () => {
    const res = await request(app)
      .post('/api/update-package')
      .send({ packageId: 'pkg-003', downloadUrl: 'https://example.com/pkg.zip', version: '3.0.0' });
    expect(res.status).not.toBe(400);
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
      .send({ packageId: 'pkg-001', downloadUrl: 'file:///etc/passwd' }); // blocked by url validation
    expect(res.status).not.toBe(401);
    expect(res.status).toBe(400); // blocked by URL scheme check, not auth
  });
});
