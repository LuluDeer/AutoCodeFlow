import request from 'supertest';
import express from 'express';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import * as childProcess from 'child_process';
import { EventEmitter } from 'events';
import type { AddressInfo } from 'net';

jest.mock('fs');
jest.mock('child_process');
jest.mock('../config', () => ({
  config: {
    workDir: '/tmp/test-workdir',
    npmRegistryUrl: '',
    pythonRegistryUrl: '',
    token: 'test-shared-token',
  },
}));
jest.mock('../logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../admin-client', () => ({
  post: jest.fn().mockResolvedValue({ data: {} }),
}));

import {
  buildDeploymentPaths,
  deployRouter,
  downloadPackage,
  findUnsafeZipEntries,
  shouldReportProcessExit,
  suppressNextRestartExitReport,
} from './deploy';
import * as downloadLib from '../lib/download';
import { buildChildEnv } from '../env-whitelist';

const app = express();
app.use(express.json());
app.use('/api', deployRouter);

const mockFs = fs as jest.Mocked<typeof fs>;
const mockCp = childProcess as jest.Mocked<typeof childProcess>;

async function closeServer(server: http.Server): Promise<void> {
  server.closeAllConnections?.();
  await new Promise<void>((resolve, reject) =>
    server.close((err) => {
      if (err && (err as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING') reject(err);
      else resolve();
    }),
  );
}

async function waitForDeploymentStatus(post: jest.Mock, status: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (post.mock.calls.some((call: unknown[]) =>
      call[0] === '/api/app-deployments/heartbeat' && (call[1] as any).status === status,
    )) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(post.mock.calls.some((call: unknown[]) =>
    call[0] === '/api/app-deployments/heartbeat' && (call[1] as any).status === status,
  )).toBe(true);
}

beforeEach(() => {
  jest.clearAllMocks();
  (mockFs.existsSync as jest.Mock).mockReturnValue(false);
  (mockFs.mkdirSync as jest.Mock).mockReturnValue(undefined);
});

describe('POST /api/deploy validation', () => {
  const basePayload = {
    deploymentId: 'deploy-1',
    applicationId: 'app-1',
    appName: 'Demo App',
    gitRepo: 'https://example.com/repo.git',
    gitBranch: 'main',
    runtime: 'node',
    runMode: 'scheduled',
  };

  it('rejects path traversal in deploymentId before creating work directories', async () => {
    const res = await request(app)
      .post('/api/deploy')
      .send({ ...basePayload, deploymentId: '../escape' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/deploymentId/i);
    expect(mockFs.mkdirSync).not.toHaveBeenCalled();
  });

  it('rejects path traversal in applicationId before creating work directories', async () => {
    const res = await request(app)
      .post('/api/deploy')
      .send({ ...basePayload, applicationId: '../../escape' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/applicationId/i);
    expect(mockFs.mkdirSync).not.toHaveBeenCalled();
  });

  it('rejects non-http package URLs before async deployment starts', async () => {
    const res = await request(app)
      .post('/api/deploy')
      .send({
        ...basePayload,
        gitRepo: null,
        packageUrl: 'file:///etc/passwd',
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/packageUrl|scheme|http/i);
    expect(mockFs.mkdirSync).not.toHaveBeenCalled();
  });

  it('accepts safe ids with an http package URL', async () => {
    const { post } = require('../admin-client') as { post: jest.Mock };
    const downloadSpy = jest.spyOn(downloadLib, 'downloadFile').mockRejectedValue(
      new Error('mocked package download failure'),
    );
    try {
      const res = await request(app)
        .post('/api/deploy')
        .send({
          ...basePayload,
          gitRepo: null,
          packageUrl: 'http://127.0.0.1:1/app.zip',
        });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true, deploymentId: 'deploy-1' });
      await waitForDeploymentStatus(post, 'failed');
    } finally {
      downloadSpy.mockRestore();
    }
  });
});

describe('restart exit reporting', () => {
  it('suppresses only the next exit report for an in-place restart', () => {
    suppressNextRestartExitReport('deploy-1');

    expect(shouldReportProcessExit('deploy-1')).toBe(false);
    expect(shouldReportProcessExit('deploy-1')).toBe(true);
    expect(shouldReportProcessExit('deploy-2')).toBe(true);
  });
});

describe('versioned deployment paths', () => {
  it('builds immutable release paths and a current pointer', () => {
    // W-03: production uses path.join, so assert with path.join too — the old
    // hardcoded '/tmp/work/apps/...' forward-slash strings only held on POSIX.
    const paths = buildDeploymentPaths('/tmp/work', 'app-1', 'deploy-1', '1.2.0');

    expect(paths.appRoot).toBe(path.join('/tmp/work', 'apps', 'app-1'));
    expect(paths.releaseKey).toBe('1.2.0-deploy-1');
    expect(paths.finalReleaseDir).toBe(path.join('/tmp/work', 'apps', 'app-1', 'releases', '1.2.0-deploy-1'));
    expect(paths.extractDir).toBe(path.join('/tmp/work', 'apps', 'app-1', 'tmp', '1.2.0-deploy-1-extracting'));
    expect(paths.currentLink).toBe(path.join('/tmp/work', 'apps', 'app-1', 'current'));
  });

  it('keeps same-version redeploys isolated by deployment id', () => {
    const first = buildDeploymentPaths('/tmp/work', 'app-1', 'deploy-1', '1.2.0');
    const second = buildDeploymentPaths('/tmp/work', 'app-1', 'deploy-2', '1.2.0');

    expect(first.finalReleaseDir).not.toBe(second.finalReleaseDir);
  });

  it('sanitizes version text before using it in a path', () => {
    const paths = buildDeploymentPaths('/tmp/work', 'app-1', 'deploy-1', '../v1+build');

    expect(paths.releaseKey).toBe('v1-build-deploy-1');
    expect(paths.finalReleaseDir).toBe(path.join('/tmp/work', 'apps', 'app-1', 'releases', 'v1-build-deploy-1'));
  });
});

// ---------------------------------------------------------------------------
// S6: pure zip-entry traversal validator (platform-agnostic, so it runs the
// same on win32 and POSIX — the win32 PowerShell listing branch feeds it the
// exact same entry names the Linux `unzip -Z1` branch does).
// ---------------------------------------------------------------------------
describe('findUnsafeZipEntries', () => {
  it('accepts a normal relative entry list', () => {
    expect(
      findUnsafeZipEntries(['index.js', 'src/app.ts', 'assets/logo.png', 'README.md']),
    ).toEqual([]);
  });

  it('flags POSIX absolute paths', () => {
    expect(findUnsafeZipEntries(['/etc/passwd'])).toEqual(['/etc/passwd']);
  });

  it('flags parent-directory traversal with forward slashes', () => {
    expect(findUnsafeZipEntries(['../escape.txt'])).toEqual(['../escape.txt']);
    expect(findUnsafeZipEntries(['a/../../b'])).toEqual(['a/../../b']);
  });

  it('flags traversal smuggled with backslashes (mixed separators)', () => {
    expect(findUnsafeZipEntries(['..\\escape.txt'])).toEqual(['..\\escape.txt']);
    expect(findUnsafeZipEntries(['a\\..\\..\\b'])).toEqual(['a\\..\\..\\b']);
  });

  it('flags Windows drive-letter and UNC absolute paths', () => {
    expect(findUnsafeZipEntries(['C:\\Windows\\system32\\evil.dll'])).toEqual([
      'C:\\Windows\\system32\\evil.dll',
    ]);
    expect(findUnsafeZipEntries(['D:/evil.txt'])).toEqual(['D:/evil.txt']);
    expect(findUnsafeZipEntries(['\\\\server\\share\\evil.txt'])).toEqual([
      '\\\\server\\share\\evil.txt',
    ]);
  });

  it('returns every violating entry, preserving order', () => {
    const unsafe = findUnsafeZipEntries([
      'ok.txt',
      '../a',
      'also-ok/deep/file.js',
      '/abs',
    ]);
    expect(unsafe).toEqual(['../a', '/abs']);
  });

  it('does not flag a filename that merely contains ".." without a segment boundary', () => {
    // "a..b" is a single safe segment; only a standalone ".." segment escapes.
    expect(findUnsafeZipEntries(['a..b', 'x...y', 'foo..bar.js'])).toEqual([]);
  });
});

describe('downloadPackage authentication', () => {
  const actualFs = jest.requireActual('fs') as typeof fs;

  function listen(server: http.Server): Promise<number> {
    return new Promise((resolve) =>
      server.listen(0, '127.0.0.1', () => {
        resolve((server.address() as AddressInfo).port);
      }),
    );
  }

  it('sends the executor shared token as Bearer and strips it on cross-host redirect', async () => {
    const authHeaders: Array<string | undefined> = [];
    const serverB = http.createServer((req, res) => {
      authHeaders.push(req.headers.authorization);
      res.writeHead(200);
      res.end('payload');
    });
    const portB = await listen(serverB);
    const serverA = http.createServer((req, res) => {
      authHeaders.push(req.headers.authorization);
      // 127.0.0.1 → localhost 视为跨主机重定向
      res.writeHead(302, { location: `http://localhost:${portB}/pkg.zip` });
      res.end();
    });
    const portA = await listen(serverA);

    (mockFs.createWriteStream as jest.Mock).mockImplementation((p: string) =>
      actualFs.createWriteStream(p),
    );
    // W-20: '/tmp/...' resolves to <cwd drive>:\tmp on Windows (absent on the
    // GH runner → ENOENT). os.tmpdir() is the portable temp location.
    const dest = path.join(os.tmpdir(), `acf-download-test-${Date.now()}.bin`);
    try {
      await downloadPackage(`http://127.0.0.1:${portA}/pkg.zip`, dest);
      expect(authHeaders).toEqual(['Bearer test-shared-token', undefined]);
      expect(actualFs.readFileSync(dest, 'utf8')).toBe('payload');
    } finally {
      await closeServer(serverA);
      await closeServer(serverB);
      try {
        actualFs.unlinkSync(dest);
      } catch {
        /* already removed */
      }
    }
  });

  it('omits the Authorization header when no token is configured', async () => {
    const { config } = require('../config') as { config: { token?: string } };
    const saved = config.token;
    config.token = '';
    let seenAuth: string | undefined = 'unset';
    const server = http.createServer((req, res) => {
      seenAuth = req.headers.authorization;
      res.writeHead(200);
      res.end('ok');
    });
    const port = await listen(server);
    (mockFs.createWriteStream as jest.Mock).mockImplementation((p: string) =>
      actualFs.createWriteStream(p),
    );
    const dest = path.join(os.tmpdir(), `acf-download-test-notoken-${Date.now()}.bin`); // W-20
    try {
      await downloadPackage(`http://127.0.0.1:${port}/pkg.zip`, dest);
      expect(seenAuth).toBeUndefined();
    } finally {
      config.token = saved;
      await closeServer(server);
      try {
        actualFs.unlinkSync(dest);
      } catch {
        /* already removed */
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Async deploy pipeline (P2: spawnSync froze the event loop) + env whitelist
// ---------------------------------------------------------------------------
describe('POST /api/deploy — async pipeline', () => {
  const basePayload = {
    deploymentId: 'deploy-async',
    applicationId: 'app-1',
    appName: 'Demo App',
    gitRepo: 'https://example.com/repo.git',
    gitBranch: 'main',
    runtime: 'node',
    runMode: 'scheduled',
  };

  function okChild(onClose?: (code: number) => void) {
    const events = new EventEmitter();
    const child = {
      stdout: { on: jest.fn() },
      stderr: { on: jest.fn() },
      on: jest.fn((event: string, cb: Function) => {
        if (event === 'close') setImmediate(() => cb(0));
        if (event === 'exit' && onClose) setImmediate(() => onClose(0));
        if (event === 'exit' && !onClose) events.once(event, (code: number) => cb(code));
        if (event === 'error') events.once(event, (err: Error) => cb(err));
      }),
      once: jest.fn((event: string, cb: Function) => {
        events.once(event, (...args: unknown[]) => (cb as (a: unknown) => void)(args[0]));
      }),
      kill: jest.fn(),
      emit: (event: string, ...args: unknown[]) => events.emit(event, ...args),
    };
    return child;
  }

  async function waitFor(predicate: () => boolean, tries = 200): Promise<void> {
    for (let i = 0; i < tries && !predicate(); i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(predicate()).toBe(true);
  }

  it('completes a git deployment fully asynchronously (no spawnSync anywhere)', async () => {
    (mockCp.spawn as jest.Mock).mockImplementation(() => okChild());
    const res = await request(app).post('/api/deploy').send(basePayload);
    expect(res.status).toBe(200);

    const { post } = require('../admin-client') as { post: jest.Mock };
    await waitFor(() =>
      post.mock.calls.some(
        (c: unknown[]) => c[0] === '/api/app-deployments/heartbeat' && (c[1] as any).status === 'running',
      ),
    );
    expect(mockCp.spawnSync).not.toHaveBeenCalled();
  });

  it('passes the validated branch to git clone when one is specified', async () => {
    (mockCp.spawn as jest.Mock).mockImplementation(() => okChild());
    const res = await request(app)
      .post('/api/deploy')
      .send({ ...basePayload, gitBranch: 'release-1' });
    expect(res.status).toBe(200);

    await waitFor(() =>
      (mockCp.spawn as jest.Mock).mock.calls.some(
        (c: unknown[]) => (c[1] as string[])[0] === 'clone',
      ),
    );
    const cloneCall = (mockCp.spawn as jest.Mock).mock.calls.find(
      (c: unknown[]) => (c[1] as string[])[0] === 'clone',
    ) as [string, string[]];
    const args = cloneCall[1];
    const branchIdx = args.indexOf('--branch');
    expect(branchIdx).toBeGreaterThan(-1);
    expect(args[branchIdx + 1]).toBe('release-1');
  });

  it('omits --branch entirely when gitBranch is empty (clones remote default)', async () => {
    (mockCp.spawn as jest.Mock).mockImplementation(() => okChild());
    const res = await request(app)
      .post('/api/deploy')
      .send({ ...basePayload, gitBranch: '' });
    expect(res.status).toBe(200);

    await waitFor(() =>
      (mockCp.spawn as jest.Mock).mock.calls.some(
        (c: unknown[]) => (c[1] as string[])[0] === 'clone',
      ),
    );
    const cloneCall = (mockCp.spawn as jest.Mock).mock.calls.find(
      (c: unknown[]) => (c[1] as string[])[0] === 'clone',
    ) as [string, string[]];
    const args = cloneCall[1];
    // S12: an empty/undefined gitBranch must never reach git as a bad
    // `--branch` argument — the flag is dropped so git clones the default HEAD.
    expect(args).not.toContain('--branch');
    expect(args).not.toContain('');
    expect(args).toContain('https://example.com/repo.git');
    expect(args[args.length - 1]).toBe('.');
  });

  it('startApp env contains only whitelisted vars plus app envVars (no executor secrets)', async () => {
    process.env.EXECUTOR_SHARED_TOKEN = 'top-secret';
    process.env.EXECUTOR_SECRET = 'legacy-secret';
    process.env.NOT_WHITELISTED = 'leak-me';
    (mockFs.existsSync as jest.Mock).mockReturnValue(true);
    (mockFs.createWriteStream as jest.Mock).mockReturnValue({
      on: jest.fn(),
      end: jest.fn(),
      write: jest.fn(),
    });
    (mockCp.spawn as jest.Mock).mockImplementation(() => okChild());

    try {
      const res = await request(app)
        .post('/api/deploy')
        .send({ ...basePayload, runMode: 'daemon', env: { APP_MODE: 'prod' } });
      expect(res.status).toBe(200);

      await waitFor(() =>
        (mockCp.spawn as jest.Mock).mock.calls.some(
          (c: unknown[]) => (c[1] as string[]).includes('index.js'),
        ),
      );
      const startCall = (mockCp.spawn as jest.Mock).mock.calls.find(
        (c: unknown[]) => (c[1] as string[]).includes('index.js'),
      );
      const [cmd, args, opts] = startCall as [string, string[], Record<string, unknown>];
      expect(cmd).toBe('node');
      expect(args).toEqual(['index.js']);
      const env = opts.env as Record<string, string | undefined>;
      expect(env.EXECUTOR_SHARED_TOKEN).toBeUndefined();
      expect(env.EXECUTOR_SECRET).toBeUndefined();
      expect(env.NOT_WHITELISTED).toBeUndefined();
      expect(env.APP_MODE).toBe('prod');
      expect(env.PATH).toBeDefined();
      // detached so app-stop can kill the whole process group
      expect(opts.detached).toBe(process.platform !== 'win32');
    } finally {
      delete process.env.EXECUTOR_SHARED_TOKEN;
      delete process.env.EXECUTOR_SECRET;
      delete process.env.NOT_WHITELISTED;
    }
  });

  it('npm install subprocess env is whitelisted too (no executor secrets)', async () => {
    process.env.EXECUTOR_SHARED_TOKEN = 'top-secret';
    (mockFs.existsSync as jest.Mock).mockReturnValue(true);
    (mockCp.spawn as jest.Mock).mockImplementation(() => okChild());

    // W-03: production spawns npm.cmd with shell:true on win32 (deploy.ts:92-96)
    // — the test must look for the platform's command name.
    const npmBin = process.platform === 'win32' ? 'npm.cmd' : 'npm';

    try {
      const res = await request(app)
        .post('/api/deploy')
        .send({ ...basePayload, env: { APP_MODE: 'prod' } });
      expect(res.status).toBe(200);

      await waitFor(() =>
        (mockCp.spawn as jest.Mock).mock.calls.some(
          (c: unknown[]) => (c[0] as string) === npmBin,
        ),
      );
      const npmCall = (mockCp.spawn as jest.Mock).mock.calls.find(
        (c: unknown[]) => (c[0] as string) === npmBin,
      );
      const env = (npmCall as [string, string[], { env: Record<string, string | undefined> }])[2].env;
      expect(env.EXECUTOR_SHARED_TOKEN).toBeUndefined();
      expect(env.APP_MODE).toBe('prod');
      expect(env.PATH).toBeDefined();
    } finally {
      delete process.env.EXECUTOR_SHARED_TOKEN;
    }
  });

  it('app-stop kills the app process group (POSIX) / process tree via taskkill (win32)', async () => {
    const killSpy = jest.spyOn(process, 'kill').mockImplementation(() => true);
    (mockFs.existsSync as jest.Mock).mockReturnValue(true);
    (mockFs.createWriteStream as jest.Mock).mockReturnValue({
      on: jest.fn(),
      end: jest.fn(),
      write: jest.fn(),
    });
    const child = okChild();
    (child as unknown as { pid: number }).pid = 5555;
    (mockCp.spawn as jest.Mock).mockImplementation(() => child);

    try {
      const res = await request(app)
        .post('/api/deploy')
        .send({ ...basePayload, runMode: 'daemon' });
      expect(res.status).toBe(200);
      await waitFor(() => (mockCp.spawn as jest.Mock).mock.calls.some((c) => (c[1] as string[]).includes('index.js')));

      const stopRes = await request(app).post('/api/app-stop').send({ deploymentId: 'deploy-async' });
      expect(stopRes.status).toBe(200);
      if (process.platform !== 'win32') {
        expect(killSpy).toHaveBeenCalledWith(-5555, 'SIGTERM');
      } else {
        // W-03 (windows-findings): no negative-pid group kill on win32 —
        // killProcessTree tree-kills via taskkill /T /F.
        expect(mockCp.spawn).toHaveBeenCalledWith(
          'taskkill',
          ['/T', '/F', '/PID', '5555'],
          expect.objectContaining({ stdio: 'ignore' }),
        );
      }

      // unblock pending timers by simulating exit
      child.emit('exit', 0);
    } finally {
      killSpy.mockRestore();
    }
  });
});
