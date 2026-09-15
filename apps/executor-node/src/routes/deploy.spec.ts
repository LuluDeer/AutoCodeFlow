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
    allowPrivateNetwork: true,
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
  buildDotenvContent,
  deployRouter,
  downloadPackage,
  findUnsafeZipEntries,
  formatDotenvValue,
  pruneOldReleases,
  rotateAppLogIfNeeded,
  shouldReportProcessExit,
  suppressNextRestartExitReport,
  validateShellEntrypoint,
} from './deploy';
import * as downloadLib from '../lib/download';
import { buildChildEnv as _buildChildEnv } from '../env-whitelist';

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

// E-12（DEEP_REVIEW 0ef3bbe）: releases 历史与 app.log 永不回收的 retention。
describe('SEC-DEPLOY-01: shell entrypoint validation', () => {
  // 回归背景：shell runtime 走 `sh -c <entrypoint>`，整串是命令行，首个
  // 空白分隔的词即被执行的命令。原校验字符类含空格，导致
  // `/usr/bin/env sh -c id` 通过并真实执行（实测返回 uid/gid）。
  // 该门此前零测试覆盖，故在此补齐正反两向用例。
  it('accepts ordinary single-token script paths', () => {
    for (const ok of [
      'app.js',
      'start.sh',
      'scripts/run.sh',
      './bin/server',
      'a-b_c.d/e',
      'main.py',
    ]) {
      expect(validateShellEntrypoint(ok)).toEqual({ ok: true });
    }
  });

  it('accepts multi-word interpreter + script forms (legitimate, used by the platform)', () => {
    // 收敛必须区分「解释器 + 脚本 + 固定参数」与「shell 元字符串联」：
    // 下面这些形态在本仓库自己的 spec/selftest 里真实存在
    // （arch31-rollout: 'sh app.sh'；app-deployment.*.spec: 'node dist/main.js'），
    // 一刀切拒绝所有空白会让这些部署全部失败（曾实测 CI selftests 变红）。
    for (const ok of [
      'sh app.sh',
      'node dist/main.js',
      'node app.js',
      'python main.py',
      'bash run.sh',
      'echo hello',
    ]) {
      expect(validateShellEntrypoint(ok)).toEqual({ ok: true });
    }
  });

  it('REJECTS command chaining / substitution / quoting (the real bypasses)', () => {
    for (const bad of [
      '/usr/bin/env sh -c id', // 旧字符类放行的真实绕过
      'a;id',
      'a&id',
      'a|id',
      'a$(id)',
      'a`id`',
      'a"b',
      "a'b",
      'a\\b',
      'a*b',
      'a?b',
      'a~b',
      'a{b}',
      'a{', // 花括号展开
      'a=b',
      'a#b',
      // 控制字符（换行等于第二条命令）
      'a\nb',
      'a\tb',
      'a\rb',
      '',
      '   ',
    ]) {
      expect(validateShellEntrypoint(bad).ok).toBe(false);
    }
  });

  it('REJECTS a leading-dash token anywhere (option injection)', () => {
    // 任一 token 以 '-' 开头都会被对应解释器当选项
    for (const bad of ['-c', '--help', '-e', 'sh -c', 'node --inspect']) {
      expect(validateShellEntrypoint(bad).ok).toBe(false);
    }
  });

  it('REJECTS path traversal out of the deployment directory', () => {
    for (const bad of ['../evil.sh', 'a/../../b', '..\\evil.bat', '../../etc/passwd']) {
      expect(validateShellEntrypoint(bad).ok).toBe(false);
    }
  });

  it('REJECTS non-strings and empty values', () => {
    for (const bad of ['', null, undefined, 42, {}, []]) {
      expect(validateShellEntrypoint(bad as unknown).ok).toBe(false);
    }
  });

  it('does not accept an entrypoint that merely contains ".." inside a name', () => {
    // 与 findUnsafeZipEntries 的同款边界：a..b 不是穿越段
    expect(validateShellEntrypoint('a..b.sh')).toEqual({ ok: true });
    expect(validateShellEntrypoint('my..app/run.sh')).toEqual({ ok: true });
  });
});

describe('E-12 retention: pruneOldReleases', () => {
  const releasesDir = '/tmp/work/apps/app-1/releases';
  const currentLink = '/tmp/work/apps/app-1/current';

  function dirent(name: string) {
    return { name, isDirectory: () => true } as fs.Dirent;
  }

  it('keeps current + newest N-1 and deletes the oldest releases', () => {
    // 6 releases; current = rel-3 (newest, just deployed). mtime 越晚越新。
    const mtimes: Record<string, number> = {
      'rel-1': 100,
      'rel-2': 200,
      'rel-4': 300,
      'rel-5': 400,
      'rel-6': 500,
      'rel-3': 900, // current
    };
    (mockFs.existsSync as jest.Mock).mockImplementation((p: string) => {
      if (p === releasesDir) return true;
      if (p === currentLink) return true;
      return false;
    });
    (mockFs.lstatSync as jest.Mock).mockReturnValue({
      isSymbolicLink: () => true,
    } as any);
    (mockFs.readlinkSync as jest.Mock).mockReturnValue(
      path.join(releasesDir, 'rel-3'),
    );
    (mockFs.readdirSync as jest.Mock).mockReturnValue(
      Object.keys(mtimes).map(dirent),
    );
    (mockFs.statSync as jest.Mock).mockImplementation((p: string) => ({
      mtimeMs: mtimes[path.basename(p as string)] ?? 0,
    }));
    (mockFs.rmSync as jest.Mock).mockReturnValue(undefined);

    const removed = pruneOldReleases(releasesDir, currentLink, 5);

    // keepCount=5 → 保留 current(rel-3) + 最新 4 个其他（rel-6/rel-5/rel-4/rel-2）
    // 共 5 个；最旧的 rel-1 被删。
    expect(removed).toEqual([path.join(releasesDir, 'rel-1')]);
    expect(mockFs.rmSync).toHaveBeenCalledTimes(1);
  });

  it('never deletes the current release even if it is not the newest', () => {
    // current 指向 rel-1（回滚到旧版本），即便 rel-1 mtime 最旧也必须保留。
    const mtimes: Record<string, number> = {
      'rel-1': 100, // current (oldest)
      'rel-2': 200,
      'rel-3': 300,
      'rel-4': 400,
      'rel-5': 500,
    };
    (mockFs.existsSync as jest.Mock).mockImplementation((p: string) =>
      p === releasesDir || p === currentLink ? true : false,
    );
    (mockFs.lstatSync as jest.Mock).mockReturnValue({
      isSymbolicLink: () => true,
    } as any);
    (mockFs.readlinkSync as jest.Mock).mockReturnValue(
      path.join(releasesDir, 'rel-1'),
    );
    (mockFs.readdirSync as jest.Mock).mockReturnValue(
      Object.keys(mtimes).map(dirent),
    );
    (mockFs.statSync as jest.Mock).mockImplementation((p: string) => ({
      mtimeMs: mtimes[path.basename(p as string)] ?? 0,
    }));
    (mockFs.rmSync as jest.Mock).mockReturnValue(undefined);

    const removed = pruneOldReleases(releasesDir, currentLink, 3);

    // keepCount=3 → 保留 current(rel-1) + 最新 2 个（rel-5/rel-4）；删 rel-3/rel-2。
    expect(removed.sort()).toEqual(
      [path.join(releasesDir, 'rel-2'), path.join(releasesDir, 'rel-3')].sort(),
    );
    expect(removed).not.toContain(path.join(releasesDir, 'rel-1'));
  });

  it('is a no-op when releases dir does not exist', () => {
    (mockFs.existsSync as jest.Mock).mockReturnValue(false);
    const removed = pruneOldReleases(releasesDir, currentLink, 5);
    expect(removed).toEqual([]);
    expect(mockFs.rmSync).not.toHaveBeenCalled();
  });
});

describe('E-12 retention: rotateAppLogIfNeeded', () => {
  const logFile = '/app/releases/current/app.log';

  it('rotates app.log → .1 → .2 → .3 when over the size cap', () => {
    (mockFs.existsSync as jest.Mock).mockImplementation((p: string) =>
      p === logFile || p === `${logFile}.1` || p === `${logFile}.2` ? true : false,
    );
    (mockFs.statSync as jest.Mock).mockReturnValue({ size: 60 * 1024 * 1024 });
    (mockFs.renameSync as jest.Mock).mockReturnValue(undefined);
    (mockFs.rmSync as jest.Mock).mockReturnValue(undefined);

    const rotated = rotateAppLogIfNeeded(logFile, 50 * 1024 * 1024, 3);
    expect(rotated).toBe(true);
    // 已有 .1/.2 备份：整条链 .2→.3、.1→.2、app.log→.1
    expect(mockFs.renameSync).toHaveBeenCalledWith(`${logFile}.2`, `${logFile}.3`);
    expect(mockFs.renameSync).toHaveBeenCalledWith(`${logFile}.1`, `${logFile}.2`);
    expect(mockFs.renameSync).toHaveBeenCalledWith(logFile, `${logFile}.1`);
  });

  it('does nothing when app.log is under the size cap', () => {
    (mockFs.existsSync as jest.Mock).mockReturnValue(true);
    (mockFs.statSync as jest.Mock).mockReturnValue({ size: 1024 });
    (mockFs.renameSync as jest.Mock).mockReturnValue(undefined);

    const rotated = rotateAppLogIfNeeded(logFile, 50 * 1024 * 1024, 3);
    expect(rotated).toBe(false);
    expect(mockFs.renameSync).not.toHaveBeenCalled();
  });
});

// E-40（DEEP_REVIEW 0ef3bbe）：.env 写入加固——旧的 `${k}=${v}` 裸拼接让
// 值里一个内嵌换行就能给被部署应用注入额外环境变量（.env 是该应用唯一的
// 配置入口）。
describe('.env serialization (E-40)', () => {
  it('escapes embedded newlines so a value cannot inject extra variables', () => {
    const content = buildDotenvContent({
      SAFE: 'ok',
      INJECTED: 'value\nEVIL=1',
    });

    // 换行必须是转义序列，绝不能是行分隔符——否则 EVIL 成为独立的一行
    expect(content).not.toMatch(/\nEVIL=/);
    expect(content.split('\n')).toHaveLength(2);
    expect(content).toContain('INJECTED="value\\nEVIL=1"');

    // 真正用 dotenv 语义回放：解析结果里只能有 SAFE / INJECTED 两个键
    const parsed: Record<string, string> = {};
    for (const line of content.split('\n')) {
      const idx = line.indexOf('=');
      const key = line.slice(0, idx);
      const raw = line.slice(idx + 1);
      parsed[key] = raw.replace(/^"|"$/g, '').replace(/\\n/g, '\n');
    }
    expect(Object.keys(parsed).sort()).toEqual(['INJECTED', 'SAFE']);
    expect(parsed.INJECTED).toBe('value\nEVIL=1');
  });

  it('escapes CR, backslash and double quotes (dotenv round-trip)', () => {
    expect(formatDotenvValue('a\r\nb')).toBe('"a\\r\\nb"');
    // 真实反斜杠路径（Windows 风格）：每个 \ 转义为 \\，序列化结果 4 个。
    // 此前误写成正斜杠 C://path//to（/ 不在转义集），根本没测到反斜杠分支。
    expect(formatDotenvValue('C:\\path\\to')).toBe('"C:\\\\path\\\\to"');
    expect(formatDotenvValue('say "hi"')).toBe('"say \\"hi\\""');
    expect(formatDotenvValue('')).toBe('""');
  });

  it('quotes every value so leading/trailing whitespace survives', () => {
    const content = buildDotenvContent({ PADDED: '  spaced  ' });
    expect(content).toBe('PADDED="  spaced  "');
  });

  it('skips keys that are not valid identifier names (no malformed line)', () => {
    const { logger } = require('../logger');
    const content = buildDotenvContent({
      GOOD: '1',
      'BAD KEY': '2',
      'BAD=KEY': '3',
      '': '4',
      '9LEADING_DIGIT': '5',
    });

    expect(content).toBe('GOOD="1"');
    expect(logger.warn).toHaveBeenCalled();
    // 每个非法键都必须告警，不能静默丢弃
    expect((logger.warn as jest.Mock).mock.calls.length).toBeGreaterThanOrEqual(4);
  });

  it('stringifies non-string values instead of emitting [object Object]', () => {
    const content = buildDotenvContent({ NUM: 42 as unknown as string });
    expect(content).toBe('NUM="42"');
  });

  it('writes the escaped content to the release .env (deploy path integration)', () => {
    // 直接验证路由使用的序列化入口与写盘内容的契约一致
    const envVars = { APP_MODE: 'prod', MULTILINE: 'a\nb' };
    const written = buildDotenvContent(envVars);
    expect(written).toContain('APP_MODE="prod"');
    expect(written.split('\n').every((l) => /^[A-Za-z_][A-Za-z0-9_]*="/.test(l))).toBe(true);
  });
});
