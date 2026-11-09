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
    allowPrivateNetwork: true,
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
import * as downloadLib from '../lib/download';

const mockFs = fs as jest.Mocked<typeof fs>;
const _mockCp = childProcess as jest.Mocked<typeof childProcess>;

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

async function closeServer(server: http.Server): Promise<void> {
  server.closeAllConnections?.();
  await new Promise<void>((resolve, reject) =>
    server.close((err) => {
      if (err && (err as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING') reject(err);
      else resolve();
    }),
  );
}

// ---------------------------------------------------------------------------
// POST /api/update-package — payload validation
// ---------------------------------------------------------------------------
describe('POST /api/update-package — payload validation', () => {
  const app = makeApp();
  // R114：`fs` 在本文件被整体 mock，独占临时目录必须走 requireActual。
  const actualFs = jest.requireActual('fs') as typeof fs;
  let spyCwd: jest.SpyInstance;
  let cwdDir: string;

  beforeEach(() => {
    // The accepted-URL tests kick off a real async download against an
    // unreachable port. Redirect process.cwd() so the route's temp
    // .pkg-updates writes land outside the repository (previously the real
    // repo dir kept a stray .pkg-updates directory after every run, and a
    // slow createWriteStream could race with later tests' fs cleanup).
    //
    // R114（2026-11-06）：目录名**必须每次唯一**（`mkdtemp`）——此前是固定
    // `/tmp/acf-up-validation`：本机**并行**跑两个测试实例（例如流水线 worker 与
    // 主会话同时跑 guards）时，两边会把 `.pkg-updates` 写进同一个目录、互相看到
    // 对方的残留/半成品 ⇒ 假红/假绿（R113 容器按前缀互杀的同类问题在文件系统上的
    // 形态）。用 mkdtemp + 本 describe 内清理，做到「只碰自己的目录」。
    cwdDir = actualFs.mkdtempSync(path.join(os.tmpdir(), 'acf-up-validation-'));
    spyCwd = jest.spyOn(process, 'cwd').mockReturnValue(cwdDir);
  });

  afterEach(() => {
    spyCwd.mockRestore();
    actualFs.rmSync(cwdDir, { recursive: true, force: true });
  });

  it('R114: 伪 cwd 目录名每次唯一（并行实例不共用 /tmp 固定路径）', () => {
    // 红：固定名 `acf-up-validation`（不含随机后缀）⇒ basename 恒等于该串。
    expect(path.basename(process.cwd())).not.toBe('acf-up-validation');
    expect(path.basename(process.cwd())).toMatch(/^acf-up-validation-/);
    // 目录确实存在且为空（本 describe 自己造、自己清）。
    expect(actualFs.existsSync(cwdDir)).toBe(true);
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
    expect(res.body.error).toBe('downloadUrl 不是合法的 URL');
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
    const downloadSpy = jest.spyOn(downloadLib, 'downloadFile').mockRejectedValue(
      new Error('mocked download failure'),
    );
    try {
      // Route accepts the URL; async download will start but is mocked out.
      // We only care the status is not 400 at the validation stage.
      const res = await request(app)
        .post('/api/update-package')
        .send({ packageId: 'pkg-002', downloadUrl: 'http://10.255.255.1:1/pkg.zip', version: '2.0.0', checksum: 'b'.repeat(64) });
      expect(res.status).toBe(200);
      expect(res.body.accepted).toBe(true);
      await waitForUpdateToSettle(app);
    } finally {
      downloadSpy.mockRestore();
    }
  });

  it('accepts https: scheme in downloadUrl', async () => {
    const downloadSpy = jest.spyOn(downloadLib, 'downloadFile').mockRejectedValue(
      new Error('mocked download failure'),
    );
    try {
      const res = await request(app)
        .post('/api/update-package')
        .send({ packageId: 'pkg-003', downloadUrl: 'https://10.255.255.1:1/pkg.zip', version: '3.0.0', checksum: 'c'.repeat(64) });
      expect(res.status).toBe(200);
      expect(res.body.accepted).toBe(true);
      await waitForUpdateToSettle(app);
    } finally {
      downloadSpy.mockRestore();
    }
  });

  // E-43（DEEP_REVIEW 0ef3bbe）：本端点只下载+校验，不就地替换/重启。响应必须
  // 把这个能力边界说清楚（旧头注释自称 "extract and replace → self-update"，
  // 与实现不符，运维/UI 会误以为已升级）。
  it('E-43: declares download-only semantics instead of an in-place self-update', async () => {
    const downloadSpy = jest.spyOn(downloadLib, 'downloadFile').mockRejectedValue(
      new Error('mocked download failure'),
    );
    try {
      const res = await request(app)
        .post('/api/update-package')
        .send({ packageId: 'pkg-e43', downloadUrl: 'http://10.255.255.1:1/pkg.zip', version: '5.0.0', checksum: 'e'.repeat(64) });

      expect(res.status).toBe(200);
      expect(res.body.accepted).toBe(true);
      expect(res.body.mode).toBe('download-only');
      // 文案不得再暗示已就地应用/重启；必须点明「只下载」
      expect(res.body.message).toMatch(/下载/i);
      expect(res.body.message).not.toMatch(/self-?update|restart|replaced|applied/i);
      await waitForUpdateToSettle(app);
    } finally {
      downloadSpy.mockRestore();
    }
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

  // R63（2026-11-06）：本 describe 的判据是**下载/校验/上报**链路，不是 SSRF 闸；
  // 而本地夹具服务器只能绑 `127.0.0.1`，契约 `networkPolicy.addresses.loopback.
  // allowedUnderPrivateNetwork = false` 落地后真实闸会拒掉每一个夹具 URL。
  // 故在此把闸打桩（闸自身由 `lib/ssrf-guard.spec.ts` 覆盖）。
  let guardSpies: jest.SpyInstance[] = [];
  beforeEach(() => {
    const guard = require('../lib/ssrf-guard') as typeof import('../lib/ssrf-guard');
    guardSpies = [
      jest.spyOn(guard, 'assertSafeHttpUrl').mockImplementation(() => {}),
      jest.spyOn(guard, 'assertSafeDnsResolution').mockResolvedValue([]),
    ];
  });
  afterEach(() => {
    for (const spy of guardSpies) spy.mockRestore();
    guardSpies = [];
  });

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
    // P10: manifest 落盘（installed-packages.ts 的 writePackageManifest）走
    // 同步 writeFileSync/renameSync——真实落盘，供下方 manifest 断言。
    (mockFs.writeFileSync as jest.Mock).mockImplementation(((p: string, data: string) => {
      actualFs.writeFileSync(p, data);
      return undefined;
    }) as never);
    (mockFs.renameSync as jest.Mock).mockImplementation(((from: string, to: string) => {
      actualFs.renameSync(from, to);
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
    const _realCwd = process.cwd();
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
      // P10: checksum 验证通过 → manifest 落盘（心跳 installedPackages 的事实源），
      // 形状含推送载荷透传的 name/type/version 与 checksum。
      const manifestPath = path.join(tmpDir, '.pkg-updates', 'manifests', 'pkg-download-test.json');
      expect(actualFs.existsSync(manifestPath)).toBe(true);
      const manifest = JSON.parse(actualFs.readFileSync(manifestPath, 'utf-8'));
      expect(manifest).toEqual(
        expect.objectContaining({
          packageId: 'pkg-download-test',
          version: '9.9.9',
          checksum,
        }),
      );
      expect(typeof manifest.downloadedAt).toBe('string');
    } finally {
      spyCwd.mockRestore();
      await closeServer(server);
      actualFs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 20_000);

  // R74-A1（安全面四轴审计·轴 2 完整性）：checksum 校验是「下载链唯一的
  // 内容完整性闸」——download.ts 只保证字节上限与半成品清理，篡改检测全靠这里
  // （update-package.ts:148-155）。此用例此前缺失：只有 "缺 checksum → 400"
  // 和 "正确 checksum → downloaded"，**不匹配**这条最关键的路径零覆盖。
  it('rejects a checksum mismatch, reports failed and removes the downloaded file', async () => {
    const payload = 'tampered-executor-package-body';
    const server = actualHttp.createServer((_req, res) => {
      res.writeHead(200);
      res.end(payload);
    });
    const port = await listen(server);
    const tmpDir = actualFs.mkdtempSync(path.join(require('os').tmpdir(), 'acf-up-sum-'));
    const spyCwd = jest.spyOn(process, 'cwd').mockReturnValue(tmpDir);
    const wrongChecksum = 'f'.repeat(64); // 与 payload 的真实 sha256 必然不同
    const tmpFile = path.join(tmpDir, '.pkg-updates', 'pkg-sum-test.zip');
    try {
      post.mockResolvedValue({ data: {} });
      const res = await request(app)
        .post('/api/update-package')
        .send({
          packageId: 'pkg-sum-test',
          name: 'executor',
          version: '9.9.7',
          downloadUrl: `http://127.0.0.1:${port}/executor.zip`,
          checksum: wrongChecksum,
        });
      expect(res.status).toBe(200);
      expect(res.body.accepted).toBe(true);

      // 等到失败回执真正推出（推回执发生在 catch 里、unlink 之后）
      let pushed: unknown[] | undefined;
      for (let i = 0; i < 200; i++) {
        pushed = post.mock.calls.find((c: unknown[]) => c[0] === '/api/executor-packages/push-result');
        const settled = await request(app).get('/api/update-package/status');
        if (pushed && settled.body.inProgress === false) break;
        await new Promise((r) => setTimeout(r, 25));
      }
      expect(pushed).toBeDefined();
      expect((pushed as unknown[])[1]).toEqual(
        expect.objectContaining({
          packageId: 'pkg-sum-test',
          status: 'failed',
          error: expect.stringMatching(/校验和不匹配/),
        }),
      );
      // 完整性校验失败的包**不得留在磁盘上**（半成品清理）
      expect(actualFs.existsSync(tmpFile)).toBe(false);
      // P10: 校验失败同样**不写 manifest**——manifest 是「校验通过的已安装
      // 事实」，篡改/失败品绝不能经心跳伪装成已安装。
      expect(actualFs.existsSync(path.join(tmpDir, '.pkg-updates', 'manifests', 'pkg-sum-test.json'))).toBe(false);
    } finally {
      spyCwd.mockRestore();
      await closeServer(server);
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

      // P10: 下载失败（HTTP 500）同样不写 manifest——半成品不算已安装事实。
      expect(
        actualFs.existsSync(path.join(tmpDir, '.pkg-updates', 'manifests', 'pkg-fail-test.json')),
      ).toBe(false);
      expect(
        actualFs.existsSync(path.join(tmpDir, '.pkg-updates', 'manifests', 'pkg-fail-test-2.json')),
      ).toBe(false);
    } finally {
      spyCwd.mockRestore();
      await closeServer(server);
      actualFs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 20_000);
});

// ---------------------------------------------------------------------------
// R98（2026-11-06）：**地址级拒绝**的判据（此前本文件只有 scheme 级用例）。
//
// 现状盲区：`download behaviour` describe 为了把本地夹具服务器（只能绑
// 127.0.0.1）跑通，把 `assertSafeHttpUrl` 桩掉了 ⇒ 那一组用例的 200 断言
// **不反映受限地址的真实行为**；而本文件其它用例只测了 `file:` 之类的 scheme
// 拒绝。⇒ 若路由里的 SSRF 闸被移除/降级，本套件**仍然全绿**（假信心）。
// 本组用**真实闸**补上「受限地址 ⇒ 400」这一格。
// ---------------------------------------------------------------------------
describe('R98: downloadUrl 的 SSRF 地址闸（真实闸，不桩）', () => {
  const app = makeApp();
  it.each([
    ['云元数据', 'http://169.254.169.254/latest/meta-data/x.zip'],
    ['CGNAT', 'http://100.64.0.1/x.zip'],
    ['loopback', 'http://127.0.0.1:8080/x.zip'],
    ['IPv6 link-local', 'http://[fe80::1]/x.zip'],
  ])('%s ⇒ 400（受限网络地址）', async (_label, downloadUrl) => {
    const res = await request(app)
      .post('/api/update-package')
      .send({ packageId: 'pkg-r98', downloadUrl, version: '1.0.0', checksum: 'a'.repeat(64) });
    expect(res.status).toBe(400);
    expect(String(res.body.error)).toMatch(/受限网络地址|无效的 URL/);
  });
});
