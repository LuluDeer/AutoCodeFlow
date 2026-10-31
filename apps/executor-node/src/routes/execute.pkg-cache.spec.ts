/**
 * R5b（部署模型评审 2026-10-23 §九 9.4-5b）—— zip 渠道包**字节缓存**的行为验证。
 *
 * 验收口径（评审 §七）：未部署设备首次运行 zip 任务 = 一次下载 + 本地缓存；
 * 第二次运行**零下载**（日志/调用计数可证），且 zip-safety 审查在缓存命中
 * 路径**每次执行照常执行**（红线：缓存只省下载，不做安全决策）。
 *
 * 红线用例对照（评审 §六 4/5）：
 *   - 只缓存完整下载成功的字节（下载 mock 写 dest 后才缓存）；
 *   - 缓存损坏（size 不符）→ 删条目回退网络，不 fail 任务；
 *   - 审查拒绝 → 坏条目被清除（首次下载恶意 / 缓存被替换两种来源一并覆盖）；
 *   - 并发同 URL 进程内串行，仅一次下载。
 *
 * harness 与 execute.python-multiversion.spec.ts 同构（config/fs/spawn/download
 * 全替身化）；差异点是假文件系统要**真支持 copyFileSync/renameSync/utimesSync
 * 与字节内容**——缓存的原子写（tmp→rename）与命中校验（size 比对）依赖这些
 * 语义，automock 的"恒 undefined"桩测不出真实分支。
 */

import request from 'supertest';
import express from 'express';
import * as fs from 'fs';
import * as path from 'path';
import * as childProcess from 'child_process';
import * as crypto from 'crypto';

// ---------------------------------------------------------------------------
// Mocks（与 execute.python-multiversion.spec.ts 同构）
// ---------------------------------------------------------------------------

jest.mock('fs');
jest.mock('child_process');
jest.mock('axios');
jest.mock('../lib/download');
jest.mock('../zip-safety', () => {
  class ZipSafetyErrorStub extends Error {
    violation: string;
    constructor(violation: string, message: string) {
      super(message);
      this.name = 'ZipSafetyError';
      this.violation = violation;
    }
  }
  return {
    ZipSafetyError: ZipSafetyErrorStub,
    safeExtractZip: jest.fn(() => ({ entries: 1, bytes: 1 })),
    vetZip: jest.fn(),
  };
});

jest.mock('../config', () => {
  const nodePath = require('path');
  return {
    config: {
      workDir: '/tmp/test-workdir',
      maxConcurrentTasks: 10,
      appName: 'test-executor',
      executorAddress: 'localhost:8002',
      taskTimeoutSeconds: 300,
      token: 'test-shared-secret',
      executionCallbackSecret: '',
      adminApiUrl: 'http://admin-api:3105',
      adminApiUrlInternal: 'http://admin-api:3105',
      npmRegistryUrl: '',
      npmRegistryToken: '',
      uvPythonInstallDir: nodePath.resolve('/tmp/interpreters'),
      uvBin: nodePath.resolve('/usr/local/bin/uv'),
      uvPythonInstallMirror: '',
      pypiRegistryUrl: '',
      interpreterDownloadTimeoutMs: 300_000,
      packageDownloadMaxBytes: 200 * 1024 * 1024,
      // R5b：默认预算充足；预算淘汰用例按需覆盖为小值。
      pkgCacheMaxBytes: 4 * 1024 * 1024 * 1024,
    },
  };
});

jest.mock('../logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const _sharedBuf = new SharedArrayBuffer(4);
const _runningCountArr = new Int32Array(_sharedBuf);
jest.mock('../scheduler', () => ({
  incrementRunning: jest.fn(),
  decrementRunning: jest.fn(),
  runningCount: 0,
  getRunningCountArray: jest.fn(() => _runningCountArr),
  getRunningCount: jest.fn(() => 0),
  registerRunningExecutionIdsProvider: jest.fn(),
  registerDeadLetterCountProvider: jest.fn(),
}));

jest.mock('../manifest', () => ({
  loadManifest: jest.fn(() => ({})),
  mergeTaskWithManifest: jest.fn((_task: any, _manifest: any) => _task),
}));

jest.mock('../callback', () => ({
  pushCallback: jest.fn(),
  truncateCallbackErrorMessage: jest.fn((m?: string) => m),
}));

const mockActiveWorkdirSets: any[] = [];
jest.mock('../file-logger', () => ({
  appendLog: jest.fn(),
  getDeadLetterCount: jest.fn(() => 0),
  registerActiveWorkdirProvider: jest.fn((fn: any) => mockActiveWorkdirSets.push(fn)),
  diskUsagePercent: jest.fn(() => 0),
  DISK_CRITICAL_PERCENT: 95,
  pinLogFilePath: jest.fn(),
  unpinLogFilePath: jest.fn(),
}));

jest.mock('../task-worker', () => {
  class ExecutionCancelledErrorStub extends Error {
    constructor(executionId: string) {
      super(`Execution ${executionId} was cancelled`);
      this.name = 'ExecutionCancelledError';
    }
  }
  return {
    ExecutionCancelledError: ExecutionCancelledErrorStub,
    taskWorkerManager: {
      execute: jest.fn(
        async (
          _taskId: string,
          _execId: string,
          _task: any,
          _params: any,
          onComplete?: () => void,
          runPrepared?: (a: () => void) => Promise<{ task: any; params: Record<string, any> }>,
        ) => {
          try {
            if (runPrepared) await runPrepared(() => undefined);
          } catch {
            if (onComplete) onComplete();
            return;
          }
          if (onComplete) onComplete();
        },
      ),
      cancelExecution: jest.fn(() => false),
    },
  };
});

jest.mock('../device-identity', () => ({
  getDeviceFingerprint: () => 'a'.repeat(64),
  DEVICE_IDENTITY_DIR_NAME: '.device-identity',
}));

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

import { executeRouter } from './execute';
import { taskWorkerManager } from '../task-worker';
import { config as testConfig } from '../config';
import { downloadFile } from '../lib/download';
import { safeExtractZip, ZipSafetyError } from '../zip-safety';
import { __resetPkgCacheQueuesForTests, PKG_CACHE_DIR_NAME } from '../pkg-cache';
import { appendLog } from '../file-logger';
import {
  buildToolchainForTest,
  seedToolchainForTest,
  invalidateToolchain,
} from '../toolchain';

const mockFs = fs as jest.Mocked<typeof fs>;
const mockCp = childProcess as jest.Mocked<typeof childProcess>;
const mockDownloadFile = downloadFile as jest.MockedFunction<typeof downloadFile>;
const mockSafeExtractZip = safeExtractZip as jest.MockedFunction<typeof safeExtractZip>;

const WORK_DIR = '/tmp/test-workdir';
const CACHE_DIR = path.join(WORK_DIR, PKG_CACHE_DIR_NAME);

/** URL → 缓存条目文件路径（与 pkg-cache.ts 同款派生）。 */
function cachePathsFor(url: string): { zip: string; meta: string } {
  const sha = crypto.createHash('sha256').update(url, 'utf8').digest('hex');
  return {
    zip: path.join(CACHE_DIR, `${sha}.zip`),
    meta: path.join(CACHE_DIR, `${sha}.meta.json`),
  };
}

// ---------------------------------------------------------------------------
// 状态化假文件系统：字节内容 + copy/rename/utimes 真语义 + 可控 mtime
// ---------------------------------------------------------------------------

const fsFiles = new Map<string, Buffer>();
const fsDirs = new Set<string>();
const fsMtimes = new Map<string, number>();
let mtimeClock = 1_700_000_000_000;

function tick(): number {
  mtimeClock += 10_000;
  return mtimeClock;
}

function resetFakeFs(): void {
  fsFiles.clear();
  fsDirs.clear();
  fsMtimes.clear();
}

function parentOf(p: string): string {
  return path.dirname(p);
}

function installFakeFs(): void {
  (mockFs.existsSync as jest.Mock).mockImplementation(
    (p: any) => fsFiles.has(String(p)) || fsDirs.has(String(p)),
  );
  (mockFs.statSync as jest.Mock).mockImplementation((p: any) => {
    const s = String(p);
    const buf = fsFiles.get(s);
    return {
      isFile: () => buf !== undefined,
      isDirectory: () => fsDirs.has(s),
      isSymbolicLink: () => false,
      size: buf ? buf.length : 0,
      mtimeMs: fsMtimes.get(s) ?? 0,
    };
  });
  (mockFs.readFileSync as jest.Mock).mockImplementation(
    (p: any) => fsFiles.get(String(p)) ?? Buffer.alloc(0),
  );
  (mockFs.readdirSync as jest.Mock).mockImplementation((p: any) => {
    const dir = String(p);
    const names = new Set<string>();
    for (const f of fsFiles.keys()) {
      if (parentOf(f) === dir) names.add(path.basename(f));
    }
    for (const d of fsDirs) {
      if (parentOf(d) === dir) names.add(path.basename(d));
    }
    return [...names];
  });
  (mockFs.rmSync as jest.Mock).mockImplementation((p: any) => {
    const s = String(p);
    fsFiles.delete(s);
    fsDirs.delete(s);
    fsMtimes.delete(s);
    for (const k of [...fsFiles.keys()]) {
      if (k.startsWith(s + path.sep)) {
        fsFiles.delete(k);
        fsMtimes.delete(k);
      }
    }
    for (const d of [...fsDirs]) {
      if (d.startsWith(s + path.sep)) fsDirs.delete(d);
    }
  });
  (mockFs.mkdirSync as jest.Mock).mockImplementation((p: any) => {
    fsDirs.add(String(p));
  });
  (mockFs.writeFileSync as jest.Mock).mockImplementation((p: any, data: any) => {
    fsFiles.set(String(p), Buffer.from(data));
    fsMtimes.set(String(p), tick());
  });
  // copy/rename/utimes 必须动真格：缓存的原子发布与 LRU 续期依赖它们。
  (mockFs.copyFileSync as jest.Mock).mockImplementation((a: any, b: any) => {
    const buf = fsFiles.get(String(a));
    if (buf === undefined) {
      throw Object.assign(new Error(`ENOENT: ${String(a)}`), { code: 'ENOENT' });
    }
    fsFiles.set(String(b), Buffer.from(buf));
    fsMtimes.set(String(b), tick());
  });
  (mockFs.renameSync as jest.Mock).mockImplementation((a: any, b: any) => {
    const buf = fsFiles.get(String(a));
    if (buf === undefined) {
      throw Object.assign(new Error(`ENOENT: ${String(a)}`), { code: 'ENOENT' });
    }
    fsFiles.delete(String(a));
    fsMtimes.delete(String(a));
    fsFiles.set(String(b), buf);
    fsMtimes.set(String(b), tick());
  });
  (mockFs.utimesSync as jest.Mock).mockImplementation((p: any) => {
    fsMtimes.set(String(p), tick());
  });
  (mockFs.chmodSync as jest.Mock).mockReturnValue(undefined);
  (mockFs.lstatSync as jest.Mock).mockReturnValue({
    isSymbolicLink: () => false,
    isDirectory: () => true,
    isFile: () => false,
  });
  (mockFs.realpathSync as unknown as jest.Mock).mockImplementation((p: string) => p);
}

/** 测试侧直接改假 fs 内容（绕过被测代码），模拟"缓存被外部替换/损坏"。 */
function seedFile(p: string, buf: Buffer, mtimeMs?: number): void {
  fsFiles.set(p, Buffer.from(buf));
  fsMtimes.set(p, mtimeMs ?? tick());
}

function fileBytes(p: string): Buffer | undefined {
  return fsFiles.get(p);
}

function setConfig(patch: Record<string, unknown>): void {
  Object.assign(testConfig as unknown as Record<string, unknown>, patch);
}

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api', executeRouter);
  return app;
}
const app = buildApp();

const flushAsync = async () => {
  for (let i = 0; i < 40; i += 1) {
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setTimeout(r, 1));
  }
};

interface SpawnCall {
  cmd: string;
  args: string[];
  opts: any;
}

function uvResponder(pool: { version: string; path: string }[]) {
  return (cmd: string, args: string[]): { code?: number | null; stderr?: string; stdout?: string } => {
    if (!path.basename(cmd).startsWith('uv')) return { code: 0 };
    if (args[0] === '--version') return { code: 0, stdout: 'uv 0.8.17\n' };
    if (args[0] === 'python' && args[1] === 'list') {
      return { code: 0, stdout: JSON.stringify(pool) };
    }
    return { code: 0 };
  };
}

function installSpawnRecorder(
  respond?: (cmd: string, args: string[]) => { code?: number | null; stderr?: string; stdout?: string },
): SpawnCall[] {
  const calls: SpawnCall[] = [];
  (mockCp.spawn as jest.Mock).mockImplementation((cmd: string, args: string[], opts: any) => {
    calls.push({ cmd, args, opts });
    const r = respond ? respond(cmd, args) : { code: 0 };
    const stdout = r.stdout ?? '';
    const stderr = r.stderr ?? '';
    return {
      stdout: { on: jest.fn((ev: string, cb: Function) => { if (ev === 'data' && stdout) cb(Buffer.from(stdout)); }) },
      stderr: { on: jest.fn((ev: string, cb: Function) => { if (ev === 'data' && stderr) cb(Buffer.from(stderr)); }) },
      on: jest.fn((event: string, cb: Function) => {
        if (event === 'close') setImmediate(() => cb(r.code ?? 0));
      }),
      kill: jest.fn(),
      pid: 4321,
    };
  });
  return calls;
}

function seedConventionalHostToolchain(): void {
  const win = process.platform === 'win32';
  seedToolchainForTest(
    buildToolchainForTest({
      python: { source: 'host', path: win ? 'python.exe' : 'python3', version: 'Python 3.12.4' },
      node: { source: 'host', path: win ? 'node.exe' : 'node', version: 'v24.19.0' },
      npm: { source: 'host', path: win ? 'npm.cmd' : 'npm', version: '11.17.0' },
      git: { source: 'host', path: win ? 'git.exe' : 'git', version: 'git version 2.43.0' },
    }),
  );
}

/** 捕获 prepared 结果（含错误形态），供断言 zip 渠道 prepare 链路。 */
async function capturePrepared(task: Record<string, unknown>, executionId = 'exec-p') {
  let prepared: any = null;
  (taskWorkerManager.execute as jest.Mock).mockImplementationOnce(
    async (_tid: string, _eid: string, _t: any, _p: any, onComplete?: () => void, runPrepared?: any) => {
      try {
        if (runPrepared) prepared = await runPrepared(() => undefined);
      } catch (err) {
        prepared = { error: err };
      }
      if (onComplete) onComplete();
    },
  );
  const res = await request(app).post('/api/execute').send({ executionId, task });
  await flushAsync();
  return { res, prepared };
}

/** 下载桩：写真实字节到 dest（与真实 downloadFile 的落盘语义一致）。 */
function installDownloadStub(bytesBySuffix: Array<[string, Buffer]>): void {
  (mockDownloadFile as jest.Mock).mockImplementation(
    (url: string, dest: string, _opts?: unknown) => {
      const hit = bytesBySuffix.find(([suffix]) => url.endsWith(suffix));
      const payload = hit ? hit[1] : Buffer.from('default-payload');
      fs.writeFileSync(dest, payload);
      return Promise.resolve(payload.length);
    },
  );
}

const ZIP_TASK_A = {
  runtime: 'python',
  entrypoint: 'main.py',
  codeSource: 'application_zip' as const,
  applicationId: 'app-r5b',
  packageUrl: 'http://admin-api:3105/api/uploads/app-r5b/pkg_1770000000000.zip',
};

const PAYLOAD_A = Buffer.from('PK-fake-zip-bytes-A' + '!'.repeat(64));

beforeEach(() => {
  jest.clearAllMocks();
  mockActiveWorkdirSets.length = 0;
  Atomics.store(_runningCountArr, 0, 0);
  setConfig({
    workDir: WORK_DIR,
    pypiRegistryUrl: '',
    uvPythonInstallMirror: '',
    uvBin: path.resolve('/usr/local/bin/uv'),
    uvPythonInstallDir: path.resolve('/tmp/interpreters'),
    pkgCacheMaxBytes: 4 * 1024 * 1024 * 1024,
  });
  invalidateToolchain();
  seedConventionalHostToolchain();
  resetFakeFs();
  installFakeFs();
  installSpawnRecorder(uvResponder([]));
  installDownloadStub([['pkg_1770000000000.zip', PAYLOAD_A]]);
  // clearAllMocks 不清除 mockImplementation（那是 resetAllMocks 的职责）——
  // "恶意包"用例给 safeExtractZip 装了持久抛错桩，这里显式重装默认成功桩，
  // 否则实现会跨用例泄漏（实测：后续 3 个用例全体假红）。
  (mockSafeExtractZip as jest.Mock).mockImplementation(() => ({ entries: 1, bytes: 1 }));
  __resetPkgCacheQueuesForTests();
});

// ===========================================================================
// R5b：zip 包字节缓存
// ===========================================================================

describe('R5b zip 包字节缓存（pkg-cache）', () => {
  it('首跑下载一次并写入缓存；二跑零下载，safeExtractZip 照常每次执行', async () => {
    // --- 首跑：miss → downloadFile → 缓存条目落盘 ---
    const first = await capturePrepared(ZIP_TASK_A, 'exec-r5b-1');
    expect(first.prepared.error).toBeUndefined();
    expect(mockDownloadFile).toHaveBeenCalledTimes(1);
    // 下载调用形态与无缓存时代逐字节一致：URL、落点 <workDir>/<execId>/package.zip。
    const [url, dest, opts] = (mockDownloadFile as jest.Mock).mock.calls[0];
    expect(url).toBe(ZIP_TASK_A.packageUrl);
    expect(dest).toBe(path.join(WORK_DIR, 'exec-r5b-1', 'package.zip'));
    expect((opts as any).signal).toBeTruthy();
    expect((opts as any).timeoutMs).toBe(120_000);
    expect((opts as any).maxBytes).toBe(200 * 1024 * 1024);

    const { zip, meta } = cachePathsFor(ZIP_TASK_A.packageUrl);
    expect(fs.existsSync(zip)).toBe(true);
    expect(fs.existsSync(meta)).toBe(true);
    expect(fileBytes(zip)).toEqual(PAYLOAD_A);
    const metaJson = JSON.parse((fileBytes(meta) as Buffer).toString('utf-8'));
    expect(metaJson.size).toBe(PAYLOAD_A.length);
    expect(metaJson.url).toBe(ZIP_TASK_A.packageUrl);

    // --- 二跑：hit → 零下载，字节复制到新执行目录，解压照常 ---
    const second = await capturePrepared(ZIP_TASK_A, 'exec-r5b-2');
    expect(second.prepared.error).toBeUndefined();
    expect(mockDownloadFile).toHaveBeenCalledTimes(1); // P2 验收：第二次零下载
    expect(fileBytes(path.join(WORK_DIR, 'exec-r5b-2', 'package.zip'))).toEqual(PAYLOAD_A);
    // 红线：审查不可被缓存跳过——两次执行各解压一次。
    expect(mockSafeExtractZip).toHaveBeenCalledTimes(2);
    expect(mockSafeExtractZip.mock.calls[1][1]).toBe(path.join(WORK_DIR, 'exec-r5b-2'));
  });

  it('缓存条目被替换为恶意 zip（同长度）→ ZipSafetyError 把关且坏条目被清除', async () => {
    await capturePrepared(ZIP_TASK_A, 'exec-r5b-evil-1');
    expect(mockDownloadFile).toHaveBeenCalledTimes(1);
    const { zip, meta } = cachePathsFor(ZIP_TASK_A.packageUrl);

    // 外部替换缓存字节：同长度 → 命中校验（size 比对）放行，把关只能靠
    // safeExtractZip——这正是"审查不可被缓存跳过"红线的攻击面表达。
    const evil = Buffer.concat([Buffer.from('EVIL!'), PAYLOAD_A.subarray(5)]);
    expect(evil.length).toBe(PAYLOAD_A.length);
    seedFile(zip, evil);
    // meta 不动（size 一致），确保走的是命中路径而非损坏回退路径。

    (mockSafeExtractZip as jest.Mock).mockImplementationOnce(() => {
      throw new ZipSafetyError('zip_slip', 'entry escapes the destination');
    });

    const second = await capturePrepared(ZIP_TASK_A, 'exec-r5b-evil-2');
    expect(second.prepared.error).toBeInstanceOf(Error);
    expect((second.prepared.error as Error).message).toMatch(/压缩包不安全或不合法/);
    // 命中路径被使用（没有再下载），审查拒绝后坏条目被清除。
    expect(mockDownloadFile).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(zip)).toBe(false);
    expect(fs.existsSync(meta)).toBe(false);
  });

  it('首次下载的包本身恶意 → 执行失败且不留缓存', async () => {
    (mockSafeExtractZip as jest.Mock).mockImplementation(() => {
      throw new ZipSafetyError('bad_archive', 'declared sizes exceed limits');
    });
    const first = await capturePrepared(ZIP_TASK_A, 'exec-r5b-badpkg-1');
    expect((first.prepared.error as Error).message).toMatch(/压缩包不安全或不合法/);
    const { zip, meta } = cachePathsFor(ZIP_TASK_A.packageUrl);
    // storeInCache 先于解压执行（下载成功即缓存字节），审查拒绝后由
    // purgePkgCacheEntry 清除——恶意字节绝不能留在缓存里反复命中。
    expect(fs.existsSync(zip)).toBe(false);
    expect(fs.existsSync(meta)).toBe(false);
  });

  it('并发同 URL → 进程内串行，仅一次下载，双方都拿到字节', async () => {
    // 下载桩带一个事件循环延迟：两个请求必须都进入 prepare 之后下载才完成，
    // 否则"第二次查缓存命中"与"串行排队"区分不出来。
    const payload = PAYLOAD_A;
    let downloadCalls = 0;
    (mockDownloadFile as jest.Mock).mockImplementation(
      (url: string, dest: string, _opts?: unknown) => {
        downloadCalls += 1;
        return (async () => {
          await new Promise((r) => setImmediate(r));
          await new Promise((r) => setImmediate(r));
          fs.writeFileSync(dest, payload);
          return payload.length;
        })();
      },
    );

    const results: any[] = [];
    (taskWorkerManager.execute as jest.Mock).mockImplementation(
      async (_tid: string, _eid: string, _t: any, _p: any, onComplete?: () => void, runPrepared?: any) => {
        try {
          if (runPrepared) results.push(await runPrepared(() => undefined));
        } catch (err) {
          results.push({ error: err });
        }
        if (onComplete) onComplete();
      },
    );

    const exec2 = ZIP_TASK_A;
    const [res1, res2] = await Promise.all([
      request(app).post('/api/execute').send({ executionId: 'exec-r5b-c-1', task: exec2 }),
      request(app).post('/api/execute').send({ executionId: 'exec-r5b-c-2', task: exec2 }),
    ]);
    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);
    await flushAsync();

    expect(downloadCalls).toBe(1); // 同 URL 只下载一次
    expect(results).toHaveLength(2);
    for (const r of results) expect(r.error).toBeUndefined();
    // 两个执行目录都拿到了字节（一个来自下载直落，一个来自缓存复制）。
    expect(fileBytes(path.join(WORK_DIR, 'exec-r5b-c-1', 'package.zip'))).toEqual(payload);
    expect(fileBytes(path.join(WORK_DIR, 'exec-r5b-c-2', 'package.zip'))).toEqual(payload);
    expect(mockSafeExtractZip).toHaveBeenCalledTimes(2);
  });

  it('缓存 size 不符 → 删除条目回退网络并修复缓存', async () => {
    await capturePrepared(ZIP_TASK_A, 'exec-r5b-corrupt-1');
    expect(mockDownloadFile).toHaveBeenCalledTimes(1);
    const { zip } = cachePathsFor(ZIP_TASK_A.packageUrl);

    // 损坏：zip 字节数与 meta.size 不再一致。
    seedFile(zip, Buffer.alloc(3));

    const second = await capturePrepared(ZIP_TASK_A, 'exec-r5b-corrupt-2');
    expect(second.prepared.error).toBeUndefined(); // fail-open 到网络，不 fail 任务
    expect(mockDownloadFile).toHaveBeenCalledTimes(2); // 回退网络重下
    // 缓存被修复：字节与 meta.size 重新一致。
    expect(fileBytes(zip)).toEqual(PAYLOAD_A);
    const { meta } = cachePathsFor(ZIP_TASK_A.packageUrl);
    expect(JSON.parse((fileBytes(meta) as Buffer).toString('utf-8')).size).toBe(PAYLOAD_A.length);
  });

  it('字节预算超限 → 按 mtime 淘汰最旧条目，新条目保留', async () => {
    const payloadB = Buffer.from('PK-fake-zip-bytes-B' + '#'.repeat(48));
    installDownloadStub([
      ['pkg_1770000000000.zip', PAYLOAD_A],
      ['pkg_1880000000000.zip', payloadB],
    ]);
    // 预算只容一个条目：存 B 后 A（更旧）被淘汰。
    setConfig({ pkgCacheMaxBytes: PAYLOAD_A.length });

    const taskB = {
      ...ZIP_TASK_A,
      applicationId: 'app-r5b-b',
      packageUrl: 'http://admin-api:3105/api/uploads/app-r5b-b/pkg_1880000000000.zip',
    };
    const first = await capturePrepared(ZIP_TASK_A, 'exec-r5b-evict-1');
    const second = await capturePrepared(taskB, 'exec-r5b-evict-2');
    expect(first.prepared.error).toBeUndefined();
    expect(second.prepared.error).toBeUndefined();
    expect(mockDownloadFile).toHaveBeenCalledTimes(2);

    const a = cachePathsFor(ZIP_TASK_A.packageUrl);
    const b = cachePathsFor(taskB.packageUrl);
    expect(fs.existsSync(a.zip)).toBe(false); // 最旧被淘汰
    expect(fs.existsSync(a.meta)).toBe(false);
    expect(fs.existsSync(b.zip)).toBe(true); // 新条目在预算内保留
    expect(fs.existsSync(b.meta)).toBe(true);
  });

  it('PKG_CACHE_MAX_BYTES=0 → 缓存显式关闭，每次执行都走网络（行为与无缓存时代一致）', async () => {
    setConfig({ pkgCacheMaxBytes: 0 });
    await capturePrepared(ZIP_TASK_A, 'exec-r5b-off-1');
    await capturePrepared(ZIP_TASK_A, 'exec-r5b-off-2');
    expect(mockDownloadFile).toHaveBeenCalledTimes(2);
    expect(fs.existsSync(path.join(CACHE_DIR))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 2026-10-31：取件来源进执行日志（用户反馈"每次都在重新下载"的可观测性修复）
// ---------------------------------------------------------------------------

describe('取件来源写入执行日志', () => {
  /** 收集 appendLog(executionId, message)——执行日志的唯一写面。 */
  function executionLogLines(): string[] {
    return (appendLog as jest.Mock).mock.calls.map(([, message]) => String(message));
  }

  it('未命中 → 日志点名"从网络下载并写入缓存"', async () => {
    await capturePrepared(ZIP_TASK_A, 'exec-src-miss');
    const lines = executionLogLines().filter((l) => l.includes('byte cache'));
    expect(lines.some((l) => l.includes('downloaded from network'))).toBe(true);
  });

  it('命中 → 日志点名"零网络往返"，且不再出现无条件下载措辞', async () => {
    await capturePrepared(ZIP_TASK_A, 'exec-src-hit-1');
    (appendLog as jest.Mock).mockClear();
    await capturePrepared(ZIP_TASK_A, 'exec-src-hit-2');

    expect(mockDownloadFile).toHaveBeenCalledTimes(1); // 第二次确实零下载
    const lines = executionLogLines();
    expect(lines.some((l) => l.includes('served from local byte cache'))).toBe(true);
    // 旧实现这里恒打 "Downloading package from ..."（无条件），正是误读根源。
    expect(lines.some((l) => l.includes('Downloading package from'))).toBe(false);
  });

  it('缓存显式关闭 → 日志明说关闭原因，不伪装成命中', async () => {
    setConfig({ pkgCacheMaxBytes: 0 });
    await capturePrepared(ZIP_TASK_A, 'exec-src-off');
    const lines = executionLogLines().filter((l) => l.includes('byte cache'));
    expect(lines.some((l) => l.includes('cache disabled'))).toBe(true);
    expect(lines.some((l) => l.includes('served from local byte cache'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 2026-10-31：purge 必须用缓存**实际键控的 URL**（同源改写场景）
// ---------------------------------------------------------------------------

describe('purge 键与缓存键同源', () => {
  it('packageUrl 被同源改写时，审查拒绝清除的是**改写后 URL** 的条目', async () => {
    // 生产形态的 packageUrl：admin 用 API_BASE_URL 拼 `${apiBase}/uploads/packages/...`
    // （application.controller.ts），**没有 `/api` 段**——改写函数的判据正是
    // `pathname.startsWith('/uploads/')`。既有 fixture 用的是 `/api/uploads/...`，
    // 因此从未走进改写分支（这也是本缺陷没被回归测到的原因）。
    const publicUrl =
      'https://acf.example.com/uploads/packages/app-r5b/abc123/pkg_1990000000000.zip';
    const task = { ...ZIP_TASK_A, packageUrl: publicUrl };

    await capturePrepared(task, 'exec-purge-rewrite-1');
    expect(mockDownloadFile).toHaveBeenCalledTimes(1);
    const effectiveUrl = (mockDownloadFile as jest.Mock).mock.calls[0][0] as string;
    // 前置条件：这次确实发生了改写，否则本用例退化成恒等场景（无意义）。
    expect(effectiveUrl).not.toBe(publicUrl);
    expect(effectiveUrl.startsWith('http://admin-api:3105/uploads/packages/')).toBe(true);

    const effectivePaths = cachePathsFor(effectiveUrl);
    expect(fs.existsSync(effectivePaths.zip)).toBe(true);

    (mockSafeExtractZip as jest.Mock).mockImplementationOnce(() => {
      throw new ZipSafetyError('zip_slip', 'entry escapes the destination');
    });
    const second = await capturePrepared(task, 'exec-purge-rewrite-2');
    expect(second.prepared.error).toBeInstanceOf(Error);
    expect(second.prepared.error.message).toMatch(/压缩包不安全或不合法/);

    // 坏条目必须被清掉（修复前传的是改写前的 packageUrl → 清的是不存在的条目，
    // 真正被命中的坏字节原样留下，下次继续命中继续失败）。
    expect(fs.existsSync(effectivePaths.zip)).toBe(false);
    expect(fs.existsSync(effectivePaths.meta)).toBe(false);
  });
});
