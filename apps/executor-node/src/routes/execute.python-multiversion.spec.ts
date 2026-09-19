/**
 * WS5（python_task_upload_and_multiversion）—— executor-node python 分支
 * 与 executor-python 的**全对等**行为验证（CONTRACT.md §3.3）。
 *
 * 本文件只测"改造新增/变更的行为"，不改动 `execute.spec.ts` 里既有的 63KB
 * 断言集。两条兼容红线在这里被显式钉死：
 *   §4.6 —— 无版本无依赖的 python 任务必须仍是 `python3 <entrypoint>`；
 *   §4.4 —— 存量 `gitRepo` + `applicationId` 行必须仍走 git 渠道。
 */

import request from 'supertest';
import express from 'express';
import * as fs from 'fs';
import * as path from 'path';
import * as childProcess from 'child_process';

// ---------------------------------------------------------------------------
// Mocks（与 execute.spec.ts 同构，保持两套 harness 行为一致）
// ---------------------------------------------------------------------------

jest.mock('fs');
jest.mock('child_process');
jest.mock('axios');
// 下载链（SSRF 闸 + 流式落盘）在 lib/download.spec.ts 里已有独立覆盖；本文件
// 关心的是**渠道选择**（zip 渠道是否被触发、被谁抢占），所以把下载替身化，
// 从而能确定性地断言"用了哪个 URL / 有没有被调用"，而不依赖网络与真实归档。
jest.mock('../lib/download');
// 解压安全语义（zip-slip/符号链接/炸弹）由 zip-safety.spec.ts 逐条覆盖；本文件
// 只关心**渠道选择与调用顺序**，故替身化。
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
  // 工厂内不能引用外部作用域变量（jest 提升限制），故就地 require 并用
  // **同一套 path 语义**算出池根——测试侧用同样的表达式得到同一个值。
  // 用 path.resolve 而不是字面量 '/tmp/interpreters'：在 win32 上
  // `path.resolve('/tmp/x')` 会带上当前盘符（E:\tmp\x），而 interpreters.ts 的
  // `poolRoot()` 与 `isInsidePool()` 正是按 resolved 路径比较的；两侧不一致会
  // 让每个池内条目都被判成"池外"而静默丢弃。
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
      // WS5
      uvPythonInstallDir: nodePath.resolve('/tmp/interpreters'),
      uvBin: nodePath.resolve('/usr/local/bin/uv'),
      uvPythonInstallMirror: '',
      pypiRegistryUrl: '',
      interpreterDownloadTimeoutMs: 300_000,
      packageDownloadMaxBytes: 200 * 1024 * 1024,
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
  // P2 磁盘水位：mock 默认"无压力"，各用例行为与引入前一致。
  diskUsagePercent: jest.fn(() => 0),
  DISK_CRITICAL_PERCENT: 95,
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

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

import {
  executeRouter,
  listActiveVenvDirNames,
  mergeRequirements,
  parsePackageRequirements,
  venvDirName,
  venvPythonBin,
} from './execute';
import { pushCallback } from '../callback';
import { taskWorkerManager } from '../task-worker';
import { config as testConfig } from '../config';
import { downloadFile } from '../lib/download';
import { safeExtractZip } from '../zip-safety';
import { __resetForTests as resetInterpreters, ensureVersion } from '../interpreters';

const mockFs = fs as jest.Mocked<typeof fs>;
const mockCp = childProcess as jest.Mocked<typeof childProcess>;
const mockDownloadFile = downloadFile as jest.MockedFunction<typeof downloadFile>;
const mockSafeExtractZip = safeExtractZip as jest.MockedFunction<typeof safeExtractZip>;

/** 与 config mock 同一套 path 语义（见上方 jest.mock 工厂注释）。 */
const POOL_DIR = path.resolve('/tmp/interpreters');
const UV_BIN = path.resolve('/usr/local/bin/uv');
/**
 * 与 config mock 里的字面量**逐字节相同**：execute.ts 用
 * `path.join(config.workDir, …)` 拼 venv 路径，测试必须用同一个原串做同样的
 * 拼接才拿得到同一个字符串（用 path.resolve 反而会引入盘符差异）。
 */
const WORK_DIR = '/tmp/test-workdir';

/** 池内某个完整版本的"解释器文件"绝对路径。 */
function poolPython(fullVersion: string, platformTag = 'x-none'): string {
  const dir = path.join(POOL_DIR, `cpython-${fullVersion}-${platformTag}`);
  return process.platform === 'win32'
    ? path.join(dir, 'python.exe')
    : path.join(dir, 'bin', 'python3');
}

/** 池内某版本的目录（pyvenv.cfg 的 home 指向它）。 */
function poolHome(fullVersion: string, platformTag = 'x-none'): string {
  return path.join(POOL_DIR, `cpython-${fullVersion}-${platformTag}`);
}

// ---------------------------------------------------------------------------
// 状态化假文件系统
// ---------------------------------------------------------------------------
// 本文件关心的路径很少（池解释器、venv 目录、pyvenv.cfg），但它们的**存在性
// 与内容**决定了代码走哪条分支。用"整表 mockReturnValue"没法表达"删掉之后就
// 不存在了"，而 venv 重建用例恰恰依赖这一点，所以这里做一个最小的、会随
// rmSync 变化的状态机。
const fsFiles = new Set<string>();
const fsDirs = new Set<string>();
const fsContents = new Map<string, string>();
const fsListings = new Map<string, string[]>();

function resetFakeFs(): void {
  fsFiles.clear();
  fsDirs.clear();
  fsContents.clear();
  fsListings.clear();
}

/** 登记一个"存在且可执行"的池内解释器文件。 */
function addPoolInterpreter(fullVersion: string, platformTag = 'x-none'): string {
  const p = poolPython(fullVersion, platformTag);
  fsFiles.add(p);
  fsDirs.add(poolHome(fullVersion, platformTag));
  return p;
}

/** 登记一个健康的 venv（python 可执行 + pyvenv.cfg 指向仍存在的池解释器）。 */
function addHealthyVenv(venvDir: string, home: string, versionInfo: string): string {
  const py = venvPythonBin(venvDir);
  fsDirs.add(venvDir);
  fsFiles.add(py);
  fsContents.set(path.join(venvDir, 'pyvenv.cfg'), `home = ${home}\nversion_info = ${versionInfo}\n`);
  return py;
}

function installFakeFs(): void {
  (mockFs.existsSync as jest.Mock).mockImplementation(
    (p: any) => fsFiles.has(String(p)) || fsDirs.has(String(p)),
  );
  (mockFs.statSync as jest.Mock).mockImplementation((p: any) => {
    const s = String(p);
    const isFile = fsFiles.has(s);
    return {
      isFile: () => isFile,
      isDirectory: () => fsDirs.has(s),
      isSymbolicLink: () => false,
      size: fsContents.get(s)?.length ?? 0,
      mtimeMs: 0,
    };
  });
  (mockFs.readFileSync as jest.Mock).mockImplementation((p: any) => fsContents.get(String(p)) ?? '');
  (mockFs.readdirSync as jest.Mock).mockImplementation((p: any) => fsListings.get(String(p)) ?? []);
  // rmSync 必须真的把路径从状态里摘掉——"删掉重建"用例的全部意义就在这里。
  (mockFs.rmSync as jest.Mock).mockImplementation((p: any) => {
    const s = String(p);
    fsFiles.delete(s);
    fsDirs.delete(s);
    fsContents.delete(s);
    fsListings.delete(s);
    for (const set of [fsFiles, fsDirs]) {
      for (const k of [...set]) if (k.startsWith(s + path.sep)) set.delete(k);
    }
  });
  (mockFs.mkdirSync as jest.Mock).mockImplementation((p: any) => {
    fsDirs.add(String(p));
  });
  (mockFs.writeFileSync as jest.Mock).mockImplementation((p: any, data: any) => {
    fsFiles.add(String(p));
    fsContents.set(String(p), String(data));
  });
  (mockFs.chmodSync as jest.Mock).mockReturnValue(undefined);
  // SEC-04 路径闸门用 lstat/realpath 判定符号链接逃逸；不桩掉的话
  // `validateExecutionWorkDir` 会抛 → 每个请求都被 400 拒掉（harness 陷阱，
  // 与 execute.spec.ts 的默认桩一致）。
  (mockFs.lstatSync as jest.Mock).mockReturnValue({
    isSymbolicLink: () => false,
    isDirectory: () => true,
    isFile: () => false,
  });
  (mockFs.realpathSync as unknown as jest.Mock).mockImplementation((p: string) => p);
}

/**
 * 覆盖 config 字段。
 *
 * 真实 config.ts 里 uv/python 相关字段是 **getter**（惰性读 env），TS 因此把
 * 它们视为只读；但本文件的 `jest.mock('../config')` 把 config 换成了一个普通
 * 对象字面量，运行期是可写的。这里用一次显式转型把"测试替身可写"这件事表达
 * 出来，而不是在每个用例里散落 `as any`。
 */
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

/**
 * 让出足够多的事件循环轮次，等异步 prepare 链路跑完。
 *
 * 为什么不能只 `setImmediate` 一次（实测踩坑）：声明 `runtimeVersion` 的 python
 * 任务在 prepare 阶段要串行经过「探测池（spawn uv）→ 建 venv（spawn uv）→
 * pip install（spawn uv）」多次**假的** spawn，每次假 spawn 都通过
 * `setImmediate(cb)` 在 close 事件上回调，且中间还夹着若干 `await`。
 * 单轮 `setImmediate` 只够推进一步，于是 `runPrepared` 永远没被调用、
 * `prepared` 保持 `null`，表现为"5 个用例莫名失败"——**是被测代码没问题、
 * 而是测试没等够**。多轮 drain 后全部通过。
 */
const flushAsync = async () => {
  for (let i = 0; i < 40; i += 1) {
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setTimeout(r, 1));
  }
};

/** spawn 桩：记录每次调用，按命令名返回可控结果。 */
interface SpawnCall {
  cmd: string;
  args: string[];
  opts: any;
}

/** 该 spawn 调用是不是 uv（cmd 是**绝对路径**，不是字面量 'uv'）。 */
function isUvCall(c: SpawnCall): boolean {
  return c.cmd === UV_BIN || path.basename(c.cmd).startsWith('uv');
}

/** 该 spawn 调用是不是 `uv venv`（子命令在 args[0]）。 */
function isUvVenvCall(c: SpawnCall): boolean {
  return isUvCall(c) && c.args[0] === 'venv';
}

/** 该 spawn 调用是不是 `uv pip install`。 */
function isUvPipCall(c: SpawnCall): boolean {
  return isUvCall(c) && c.args[0] === 'pip';
}

/**
 * 默认 uv 应答器：`--version` 成功、`python list` 报告给定的池内解释器、
 * 其余（venv/pip/install）成功。真实 uv 的 argv 形态见 interpreters.ts：
 *   uv --version
 *   uv python list --only-installed --output-format json --no-config --no-progress
 *   uv python install --no-config --no-progress [--mirror <m>] <X.Y>
 *   uv venv [--python <abs>] --no-project <dir>
 *   uv pip install --python <venvPy> [--index-url <u>] <reqs...>
 */
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

/** 捕获 prepared task（含 cmd/args/env），供断言实际执行形态。 */
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

function failedCallback() {
  return (pushCallback as jest.Mock).mock.calls
    .map((c) => c[0])
    .find((p: any) => p.status === 'failed');
}

beforeEach(() => {
  jest.clearAllMocks();
  mockActiveWorkdirSets.length = 0;
  Atomics.store(_runningCountArr, 0, 0);
  setConfig({
    workDir: WORK_DIR,
    pypiRegistryUrl: '',
    uvPythonInstallMirror: '',
    uvBin: UV_BIN,
    uvPythonInstallDir: POOL_DIR,
  });

  // 解释器模块持有探测缓存与 uv 解析缓存，跨用例必须重置（否则第二个用例会
  // 复用第一个用例的池快照，让"池为空"这类断言失真）。
  resetInterpreters();
  resetFakeFs();
  installFakeFs();
  // 默认 uv 应答：探测到空池（各用例按需覆盖为"池内有 X"）。
  installSpawnRecorder(uvResponder([]));
  mockDownloadFile.mockResolvedValue(0);
});

// ===========================================================================
// 纯函数：D4 合并 / requirements 解析 / venv 路径
// ===========================================================================

describe('mergeRequirements (D4/AC-04a/b)', () => {
  it('unions package + task requirements', () => {
    expect(mergeRequirements(['requests'], ['flask'])).toEqual(['requests', 'flask']);
  });

  it('task-level entries WIN over same-named package entries', () => {
    expect(mergeRequirements(['requests==2.31.0'], ['requests==2.32.0'])).toEqual([
      'requests==2.32.0',
    ]);
  });

  it('keeps the package entry\'s POSITION when the task overrides it', () => {
    // 顺序稳定是契约的一部分：同名覆盖不该把条目挪到末尾。
    expect(
      mergeRequirements(['a==1', 'b==1', 'c==1'], ['b==2', 'd==1']),
    ).toEqual(['a==1', 'b==2', 'c==1', 'd==1']);
  });

  it('matches names case-insensitively and ignores extras/markers/constraints', () => {
    expect(mergeRequirements(['Requests>=2'], ['requests[socks]==2.31'])).toEqual([
      'requests[socks]==2.31',
    ]);
    expect(mergeRequirements(['requests ; python_version<"3.8"'], ['requests'])).toEqual([
      'requests',
    ]);
  });

  it('applies PEP 503 normalization (-/_/. are equivalent)', () => {
    expect(mergeRequirements(['zope.interface==5'], ['zope-interface==6'])).toEqual([
      'zope-interface==6',
    ]);
  });

  it('is stable and repeatable', () => {
    const pkg = ['a', 'b'];
    const task = ['b', 'c'];
    expect(mergeRequirements(pkg, task)).toEqual(mergeRequirements(pkg, task));
  });

  it('handles empty / undefined inputs', () => {
    expect(mergeRequirements(undefined, undefined)).toEqual([]);
    expect(mergeRequirements([], ['x'])).toEqual(['x']);
    expect(mergeRequirements(['x'], [])).toEqual(['x']);
  });

  it('ignores blank and non-string entries', () => {
    expect(mergeRequirements(['  ', 'a'], ['', 'b'])).toEqual(['a', 'b']);
    expect(mergeRequirements([null as any, 'a'], [undefined as any])).toEqual(['a']);
  });

  it('deduplicates within a single list', () => {
    expect(mergeRequirements(['a==1', 'a==2'], [])).toEqual(['a==2']);
  });
});

describe('parsePackageRequirements', () => {
  it('parses plain specs and strips comments/blank lines', () => {
    expect(
      parsePackageRequirements('# comment\nrequests==2.31.0\n\n  flask>=2  # inline\n'),
    ).toEqual(['requests==2.31.0', 'flask>=2']);
  });

  it('drops pip option lines (index-hijack vectors) instead of passing them to uv', () => {
    // `-` 开头的行会被 uv 当**选项**解析（--index-url 等），是索引劫持向量。
    expect(
      parsePackageRequirements('--index-url https://evil.example/simple\n-r other.txt\nrequests\n'),
    ).toEqual(['requests']);
  });

  it('drops URLs, paths and pip section headers', () => {
    expect(
      parsePackageRequirements(
        '[global]\nhttps://example.com/x.whl\nfile:///tmp/x.whl\n./local\n~/x\nrequests\n',
      ),
    ).toEqual(['requests']);
  });

  it('handles CRLF and returns [] for empty input', () => {
    expect(parsePackageRequirements('a\r\nb\r\n')).toEqual(['a', 'b']);
    expect(parsePackageRequirements('')).toEqual([]);
  });

  // NETOPT-6⑤：与 executor-python _parse_requirements_file 逐字同形的对齐
  // 用例——同一个包在两个执行器上必须解析出同一依赖集。
  it('strips a UTF-8 BOM on the first line (NETOPT-6⑤)', () => {
    expect(parsePackageRequirements('\ufeffrequests>=2\nflask\n')).toEqual([
      'requests>=2',
      'flask',
    ]);
  });

  it.each(['\u2028', '\u2029', '\x0b', '\x0c'])(
    'does not split lines on %s (parity with the python executor)',
    (separator) => {
      // python 侧旧实现（str.splitlines）会在这里切出两条 spec；统一后
      // U+2028/U+2029/VT/FF 原样留在行内，两侧一致。
      expect(parsePackageRequirements(`requests>=2${separator}flask\n`)).toEqual([
        `requests>=2${separator}flask`,
      ]);
    },
  );

  it('does not treat a bare CR as a line separator', () => {
    expect(parsePackageRequirements('a\rb\n')).toEqual(['a\rb']);
  });
});

describe('venvDirName (D6/FR-16)', () => {
  it('is byte-for-byte the bare taskId when no version is declared (AC-10a)', () => {
    expect(venvDirName('task-1', null)).toBe('task-1');
    expect(venvDirName('task-1', undefined)).toBe('task-1');
    expect(venvDirName('task-1', '')).toBe('task-1');
  });

  it('appends the version signature when declared (AC-16a)', () => {
    expect(venvDirName('task-1', '3.7')).toBe('task-1-3.7');
    expect(venvDirName('task-1', '3.13')).toBe('task-1-3.13');
  });

  it('never lets a declared-version change reuse the old venv', () => {
    expect(venvDirName('t', '3.7')).not.toBe(venvDirName('t', '3.13'));
    expect(venvDirName('t', '3.7')).not.toBe(venvDirName('t', null));
  });
});

describe('venvPythonBin', () => {
  it('is platform-aware (win32 Scripts\\python.exe vs POSIX bin/python3)', () => {
    const bin = venvPythonBin('/tmp/v');
    if (process.platform === 'win32') {
      expect(bin).toBe(path.join('/tmp/v', 'Scripts', 'python.exe'));
    } else {
      expect(bin).toBe(path.join('/tmp/v', 'bin', 'python3'));
    }
  });
});

// ===========================================================================
// 兼容红线 §4.6：无版本无依赖 → 逐字节不变的 python3
// ===========================================================================

describe('COMPAT RED LINE §4.6 — no version, no requirements', () => {
  it('spawns `python3 <entrypoint>` with no uv/venv involvement at all', async () => {
    const calls = installSpawnRecorder(uvResponder([]));
    const { res, prepared } = await capturePrepared(
      { runtime: 'python', entrypoint: 'main.py' },
      'exec-compat-1',
    );

    expect(res.status).toBe(200);
    expect(prepared.error).toBeUndefined();
    expect(prepared.task.cmd).toBe(process.platform === 'win32' ? 'python.exe' : 'python3');
    expect(prepared.task.args).toEqual(['main.py']);
    // 关键：整条 prepare 链路里**没有**任何 uv 调用。
    expect(calls.filter(isUvCall)).toEqual([]);
  });

  it('does not create a venv directory', async () => {
    installSpawnRecorder(uvResponder([]));
    await capturePrepared({ runtime: 'python', entrypoint: 'main.py' }, 'exec-compat-2');
    const mkdirCalls = (mockFs.mkdirSync as jest.Mock).mock.calls.map((c) => String(c[0]));
    expect(mkdirCalls.some((p) => p.includes('.venvs'))).toBe(false);
  });

  it('still works when uv is entirely unavailable (backward compatibility)', async () => {
    // uv 不可用只影响"声明了版本"的任务；存量任务必须照常运行。
    setConfig({ uvBin: '' });
    installSpawnRecorder(() => ({ code: null, stderr: 'spawn uv ENOENT' }));
    const { prepared } = await capturePrepared(
      { runtime: 'python', entrypoint: 'main.py' },
      'exec-compat-3',
    );
    expect(prepared.error).toBeUndefined();
    expect(prepared.task.cmd).toBe(process.platform === 'win32' ? 'python.exe' : 'python3');
  });

  it('an empty requirements array is still the no-deps path', async () => {
    installSpawnRecorder(uvResponder([]));
    const { prepared } = await capturePrepared(
      { runtime: 'python', entrypoint: 'main.py', requirements: [] },
      'exec-compat-4',
    );
    expect(prepared.task.cmd).toBe(process.platform === 'win32' ? 'python.exe' : 'python3');
  });
});

// ===========================================================================
// 兼容红线 §4.4：codeSource 优先级 git > glue > application_zip
// ===========================================================================

describe('COMPAT RED LINE §4.4 — code-source precedence', () => {
  it('legacy row with BOTH gitRepo and applicationId → git channel, NO zip download', async () => {
    // 这是本特性最重要的回归用例：历史行里 applicationId 只是个弱引用，
    // 不表示"代码来自上传的包"。若按 applicationId 触发 zip 渠道，就会先
    // clone 再解压覆盖，静默改变存量任务的结果。
    const calls = installSpawnRecorder((cmd, args) => {
      if (path.basename(cmd).startsWith('uv')) return uvResponder([])(cmd, args);
      return { code: 0 };
    });
    const { prepared } = await capturePrepared(
      {
        runtime: 'python',
        entrypoint: 'main.py',
        gitRepo: 'https://example.com/repo.git',
        applicationId: 'app-legacy-1',
        packageUrl: 'http://admin-api:3105/api/uploads/app-legacy-1/package.zip',
      },
      'exec-prec-1',
    );

    // 走了 git（clone 子进程），且**下载链一次都没被调用**（zip 渠道没被抢占）。
    expect(calls.some((c) => c.cmd === 'git')).toBe(true);
    expect(mockDownloadFile).not.toHaveBeenCalled();
    // 依然用系统解释器（无版本声明）
    expect(prepared.task.cmd).toBe(process.platform === 'win32' ? 'python.exe' : 'python3');
  });

  it('glueSource + applicationId → glue wins, no zip channel', async () => {
    const calls = installSpawnRecorder(uvResponder([]));
    const { prepared } = await capturePrepared(
      {
        runtime: 'python',
        glueSource: 'print("glue")',
        glueLanguage: 'python',
        applicationId: 'app-legacy-2',
        packageUrl: 'http://admin-api:3105/api/uploads/app-legacy-2/package.zip',
      },
      'exec-prec-2',
    );

    expect(prepared.task.args).toEqual(['glue_script.py']);
    expect(mockDownloadFile).not.toHaveBeenCalled();
    expect(calls.filter(isUvCall)).toEqual([]);
  });

  it('codeSource=application_zip + applicationId + packageUrl → zip channel fires', async () => {
    const { prepared } = await capturePrepared(
      {
        runtime: 'python',
        entrypoint: 'main.py',
        codeSource: 'application_zip',
        applicationId: 'app-zip-1',
        packageUrl: 'http://admin-api:3105/api/uploads/app-zip-1/package.zip',
      },
      'exec-prec-3',
    );

    // zip 渠道确实被触发：下载链被调用一次，URL 是派发载荷里的 packageUrl，
    // 落点是 workDir/package.zip。
    expect(mockDownloadFile).toHaveBeenCalledTimes(1);
    const [url, dest] = mockDownloadFile.mock.calls[0];
    expect(url).toBe('http://admin-api:3105/api/uploads/app-zip-1/package.zip');
    expect(dest).toBe(path.join(WORK_DIR, 'exec-prec-3', 'package.zip'));
    // 解压到 workDir（safeExtractZip 自身的安全语义由 zip-safety.spec.ts 覆盖）。
    expect(mockSafeExtractZip).toHaveBeenCalledTimes(1);
    expect(mockSafeExtractZip.mock.calls[0][1]).toBe(path.join(WORK_DIR, 'exec-prec-3'));
    expect(prepared.error).toBeUndefined();
  });

  it('codeSource=application_zip without packageUrl → explicit clear failure', async () => {
    installSpawnRecorder(uvResponder([]));
    await capturePrepared(
      {
        runtime: 'python',
        entrypoint: 'main.py',
        codeSource: 'application_zip',
        applicationId: 'app-zip-2',
      },
      'exec-prec-4',
    );

    const fail = failedCallback();
    expect(fail).toBeTruthy();
    expect(fail.errorMessage).toMatch(/packageUrl/);
    // 绝不静默跑一个空工作目录。
    expect(fail.failureReason).toBe('package_fetch_failed');
    // 更不该"没包也去下载"。
    expect(mockDownloadFile).not.toHaveBeenCalled();
  });

  it('applicationId WITHOUT packageUrl (ambiguous legacy) → NOT the zip channel', async () => {
    const calls = installSpawnRecorder(uvResponder([]));
    const { prepared } = await capturePrepared(
      { runtime: 'python', entrypoint: 'main.py', applicationId: 'app-legacy-3' },
      'exec-prec-5',
    );
    expect(prepared.error).toBeUndefined();
    expect(prepared.task.cmd).toBe(process.platform === 'win32' ? 'python.exe' : 'python3');
    expect(calls.filter(isUvCall)).toEqual([]);
    expect(mockDownloadFile).not.toHaveBeenCalled();
  });

  it('a package-supplied manifest.yaml cannot hijack the entrypoint', async () => {
    // 位置纪律：loadManifest 必须在 zip 解压**之前**跑完，否则包里的
    // manifest.yaml 能改 entrypoint/runtime/requirements —— 上传者就能借此
    // 越过任务配置（admin 派发载荷里的 entrypoint 才是权威值）。
    //
    // 注意断言方向：这里钉的是「解压发生时 manifest **已经**读完」。
    // 原先的断言方向恰好相反（钉住"manifest 在解压后才读"），名字写着
    // "cannot hijack" 却把有漏洞的次序锁成了期望值——属于"名字与断言背离"
    // 的假绿。修 product 的同时必须把断言翻正，否则修复会被这条测试判红。
    const { loadManifest } = require('../manifest');
    let manifestLoadedBeforeExtract = false;
    (loadManifest as jest.Mock).mockImplementationOnce(() => {
      manifestLoadedBeforeExtract = true;
      return {};
    });
    mockSafeExtractZip.mockImplementationOnce(() => {
      // 解压时 manifest 必须已经读完（workDir 此刻应当是空的）。
      expect(manifestLoadedBeforeExtract).toBe(true);
      return { entries: 1, bytes: 1 };
    });

    await capturePrepared(
      {
        runtime: 'python',
        entrypoint: 'main.py',
        codeSource: 'application_zip',
        applicationId: 'app-zip-order',
        packageUrl: 'http://admin-api:3105/api/uploads/app-zip-order/package.zip',
      },
      'exec-prec-order',
    );
    expect(mockSafeExtractZip).toHaveBeenCalled();
    expect(manifestLoadedBeforeExtract).toBe(true);
  });
});

// ===========================================================================
// 声明版本 → 解释器解析 + venv
// ===========================================================================

describe('declared runtimeVersion', () => {
  it('rejects a malformed version explicitly (never silently ignored)', async () => {
    installSpawnRecorder(uvResponder([]));
    await capturePrepared(
      { runtime: 'python', entrypoint: 'main.py', runtimeVersion: '3.7.9' },
      'exec-ver-bad',
    );
    const fail = failedCallback();
    expect(fail).toBeTruthy();
    expect(fail.errorMessage).toMatch(/Invalid runtimeVersion/);
  });

  it('rejects a command-injection-shaped version before any argv use', async () => {
    const calls = installSpawnRecorder(uvResponder([]));
    await capturePrepared(
      { runtime: 'python', entrypoint: 'main.py', runtimeVersion: '--index-url' },
      'exec-ver-inject',
    );
    const fail = failedCallback();
    expect(fail).toBeTruthy();
    expect(fail.errorMessage).toMatch(/Invalid runtimeVersion/);
    // 恶意值绝不能出现在任何 uv argv 里。
    for (const c of calls) {
      expect(c.args.join(' ')).not.toContain('--index-url');
    }
  });

  it('reports interpreter_unavailable for 3.7 (uv cannot download it)', async () => {
    // CONTRACT.md §0 实测：uv 只提供 3.8~3.14 的下载；3.7 只能离线预填。
    // 我们必须在**发起安装之前**就判定并给出可操作的指引。
    const calls = installSpawnRecorder(uvResponder([]));

    await capturePrepared(
      { runtime: 'python', entrypoint: 'main.py', runtimeVersion: '3.7' },
      'exec-ver-unavail',
    );

    const fail = failedCallback();
    expect(fail).toBeTruthy();
    expect(fail.failureReason).toBe('interpreter_unavailable');
    // AC-12a 模板：带请求版本、原因与池快照。
    expect(fail.errorMessage).toMatch(/解释器 3\.7 无法获取/);
    expect(fail.errorMessage).toMatch(/not_downloadable/);
    expect(fail.errorMessage).toMatch(/已缓存/);
    // P2-2 回归：必须含 CONTRACT.md:315 的「候选执行器: <appName>[已缓存: …]」
    // 段，与 python `_interpreter_failure_result` 逐段对齐——缺这一段时调度侧
    // 无法从消息里读出"该改派到哪台执行器"。反证：把模板尾部改回
    // `；已缓存: …`（无候选执行器段），本断言立即转红。
    expect(fail.errorMessage).toMatch(/；候选执行器: [^[\]]+\[已缓存: [^]]*\]/);
    // 关键：明知不可下载就不该白跑一次 install（省一次网络往返与 300s 预算）。
    expect(calls.some((c) => isUvCall(c) && c.args[1] === 'install')).toBe(false);
  });

  it('3.7 预填指引不得给出多补了 -none 的目录名 (CONTRACT.md §0.2)', async () => {
    // 实测坑：`cpython-3.7.9-linux-x86_64-gnu-none` 被 uv 判为非法请求 / 静默忽略。
    // 目录名全形是 `cpython-<完整版本>-<uv三元组>`，三元组之后没有东西。
    installSpawnRecorder(uvResponder([]));
    const err: any = await ensureVersion('3.7').then(() => null).catch((e: any) => e);
    expect(err).toBeTruthy();
    const detail: string = err.detail ?? err.message;
    // 不得出现 `-<triple>-none` 这种"三元组之后再补 -none"的形态。
    expect(detail).not.toMatch(/linux-[a-z0-9_]+-(gnu|musl)-none/);
    expect(detail).not.toMatch(/<platform>-none/);
    // 不得写死补丁号 `.9`（3.6/3.5 走同一分支）。
    expect(detail).not.toMatch(/cpython-3\.7\.9-/);
    // 必须显式警告不要补 -none，并给出 uv 的真实词汇。
    expect(detail).toMatch(/do NOT append an extra "-none"/);
    expect(detail).toMatch(/linux-x86_64-gnu/);
  });

  it('reports interpreter_unavailable when the uv download itself fails', async () => {
    const calls = installSpawnRecorder((cmd, args) => {
      if (!path.basename(cmd).startsWith('uv')) return { code: 0 };
      if (args[0] === '--version') return { code: 0, stdout: 'uv 0.8.17\n' };
      if (args[0] === 'python' && args[1] === 'list') return { code: 0, stdout: '[]' };
      if (args[0] === 'python' && args[1] === 'install') {
        return {
          code: 2,
          stderr: 'error: Failed to download cpython-3.11.15-windows-x86_64-none (network unreachable)',
        };
      }
      return { code: 0 };
    });

    await capturePrepared(
      { runtime: 'python', entrypoint: 'main.py', runtimeVersion: '3.11' },
      'exec-ver-dlfail',
    );

    // 3.11 是可下载版本 → 确实尝试了 install，然后因下载失败而失败。
    expect(calls.some((c) => isUvCall(c) && c.args[1] === 'install')).toBe(true);
    const fail = failedCallback();
    expect(fail.failureReason).toBe('interpreter_unavailable');
    expect(fail.errorMessage).toMatch(/解释器 3\.11 无法获取/);

    // FR-12/AC-12a 对等：解释器类失败必须**同时**上报结构化快照，形状与
    // python 侧 `_interpreter_failure_result` 的 `result.interpreter` 一致。
    // 只发文本时 admin 侧无法机器判定"该派到哪台执行器"。
    // 反证：删掉 execute.ts 里 pushCallback 的 `result: err.snapshot` 分支，
    // 本例立即转红（fail.result 为 undefined）。
    expect(fail.result).toBeTruthy();
    const snap = (fail.result as any).interpreter;
    expect(snap).toBeTruthy();
    expect(snap.requested).toBe('3.11');
    expect(snap.resolved).toBeNull();
    expect(typeof snap.reason).toBe('string');
    expect(snap.reason.length).toBeGreaterThan(0);
    expect(typeof snap.detail).toBe('string');
    // pool 快照是"该下载还是该离线预填"的第一手信息，必须带上。
    expect(snap.pool).toBeTruthy();
    expect(Array.isArray(snap.pool.versions)).toBe(true);
    // 线上契约是 **snake_case `install_dir`**（python `_pool_summary` 同形，
    // admin-web `normalizePool` 只读这个键）。若这里发成本地的 camelCase
    // `installDir`，池目录一栏会永远渲染成 `-` —— 属于"看着有数据其实读不到"
    // 的静默失配，故用键集合钉死。
    expect(Object.keys(snap.pool).sort()).toEqual(['install_dir', 'versions']);
    expect(typeof snap.pool.install_dir).toBe('string');
  });

  it('passes an ABSOLUTE pool path to `uv venv --python` (D8: never a bare version)', async () => {
    const poolBin = addPoolInterpreter('3.12.13');
    const calls = installSpawnRecorder(uvResponder([{ version: '3.12.13', path: poolBin }]));

    await capturePrepared(
      { runtime: 'python', entrypoint: 'main.py', runtimeVersion: '3.12' },
      'exec-ver-abs',
    );

    const venvCall = calls.find(isUvVenvCall);
    expect(venvCall).toBeTruthy();
    const pyIdx = venvCall!.args.indexOf('--python');
    expect(pyIdx).toBeGreaterThanOrEqual(0);
    expect(path.isAbsolute(venvCall!.args[pyIdx + 1])).toBe(true);
    expect(venvCall!.args[pyIdx + 1]).toBe(poolBin);
    // 绝不能是裸版本号（那会触发 uv 的隐式下载语义，绕过 D13 的全局单下载队列）。
    expect(venvCall!.args[pyIdx + 1]).not.toBe('3.12');
    // AC-10a：`--no-project <dir>` 形态不变。
    expect(venvCall!.args).toContain('--no-project');
    // 池内已有 → 绝不该再去 install。
    expect(calls.some((c) => isUvCall(c) && c.args[1] === 'install')).toBe(false);
  });

  it('sets UV_PYTHON_DOWNLOADS=manual on uv children (D8 hardening)', async () => {
    const poolBin = addPoolInterpreter('3.12.13');
    const calls = installSpawnRecorder(uvResponder([{ version: '3.12.13', path: poolBin }]));

    await capturePrepared(
      { runtime: 'python', entrypoint: 'main.py', runtimeVersion: '3.12' },
      'exec-venv-env',
    );

    // `uv --version` 是**纯能力探测**（下载任何东西都不涉及），它走
    // `buildChildEnv()` 的最小环境是刻意的：探测阶段不该被解释器池的配置污染。
    // 因此 D8 的不变量只约束**会碰解释器/依赖的** uv 调用。
    const uvCalls = calls.filter(isUvCall).filter((c) => c.args[0] !== '--version');
    expect(uvCalls.length).toBeGreaterThan(0);
    for (const c of uvCalls) {
      // 关键：manual 让"venv 阶段绝不隐式下载"成为 uv 自身强制的不变量。
      expect(c.opts.env.UV_PYTHON_DOWNLOADS).toBe('manual');
      expect(c.opts.env.UV_PYTHON_INSTALL_DIR).toBe(POOL_DIR);
      // 执行器密钥绝不能流到 uv。
      expect(c.opts.env.EXECUTOR_SHARED_TOKEN).toBeUndefined();
      expect(c.opts.env.EXECUTION_SECRET).toBeUndefined();
      expect(c.opts.env.EXECUTION_CALLBACK_SECRET).toBeUndefined();
    }
    // 反向保证：确实覆盖到了建 venv（本用例无 requirements，故不会有 pip 阶段）。
    expect(uvCalls.some((c) => c.args[0] === 'venv')).toBe(true);
    expect(uvCalls.some((c) => c.args[0] === 'python' && c.args[1] === 'install')).toBe(false);
  });

  it('uses the venv interpreter as cmd when a venv is built', async () => {
    const poolBin = addPoolInterpreter('3.12.13');
    const venvDir = path.join(WORK_DIR, '.venvs', 'taskV-3.12');
    const venvPy = venvPythonBin(venvDir);

    const calls = installSpawnRecorder(uvResponder([{ version: '3.12.13', path: poolBin }]));

    const { prepared } = await capturePrepared(
      {
        id: 'taskV',
        runtime: 'python',
        entrypoint: 'main.py',
        runtimeVersion: '3.12',
        requirements: ['requests'],
      },
      'exec-venv-cmd',
    );

    expect(prepared.error).toBeUndefined();
    // 建在带版本签名的目录里（D6/AC-16a），并以池内**绝对路径**为 --python。
    const venvCall = calls.find(isUvVenvCall)!;
    expect(venvCall.args[venvCall.args.indexOf('--python') + 1]).toBe(poolBin);
    expect(venvCall.args[venvCall.args.length - 1]).toBe(venvDir);
    // 依赖装进该 venv。
    const pipCall = calls.find(isUvPipCall)!;
    expect(pipCall.args[pipCall.args.indexOf('--python') + 1]).toBe(venvPy);
    expect(pipCall.args[pipCall.args.length - 1]).toBe('requests');
    // cmd 用的是 venv 内解释器。
    expect(prepared.task.cmd).toBe(venvPy);
    expect(prepared.task.args).toEqual(['main.py']);
  });

  it('passes --index-url when a private PyPI registry is configured', async () => {
    setConfig({ pypiRegistryUrl: 'https://pypi.internal/simple' });
    const home = poolHome('3.12.13');
    addPoolInterpreter('3.12.13');
    const venvDir = path.join(WORK_DIR, '.venvs', 'taskR');
    const venvPy = addHealthyVenv(venvDir, home, '3.12.13');

    const calls = installSpawnRecorder(uvResponder([]));

    const { prepared } = await capturePrepared(
      { id: 'taskR', runtime: 'python', entrypoint: 'main.py', requirements: ['requests'] },
      'exec-registry',
    );

    expect(prepared.error).toBeUndefined();
    const pipCall = calls.find(isUvPipCall);
    expect(pipCall).toBeTruthy();
    const idx = pipCall!.args.indexOf('--index-url');
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(pipCall!.args[idx + 1]).toBe('https://pypi.internal/simple');
    // 依赖装进既有 venv，用绝对解释器路径。
    expect(pipCall!.args[pipCall!.args.indexOf('--python') + 1]).toBe(venvPy);
    // 健康的 venv 不该被重建。
    expect(calls.some(isUvVenvCall)).toBe(false);
  });

  it('no-version + requirements → `uv venv --no-project` (argv unchanged, AC-10a)', async () => {
    const venvDir = path.join(WORK_DIR, '.venvs', 'taskNV');
    const calls = installSpawnRecorder(uvResponder([]));

    await capturePrepared(
      { id: 'taskNV', runtime: 'python', entrypoint: 'main.py', requirements: ['requests'] },
      'exec-nv',
    );

    const venvCall = calls.find(isUvVenvCall);
    expect(venvCall).toBeTruthy();
    // 无版本分支：argv 里**不得**出现 --python（AC-10a 逐字节不变）。
    expect(venvCall!.args).toEqual(['venv', '--no-project', venvDir]);
  });

  it('rebuilds a venv whose backing pool interpreter disappeared', async () => {
    // python 侧实测确认的坑：venv 里的 python 只是 shim，真解释器在池里。
    // 池被回收后 venvDir.exists() 仍为真，旧逻辑会"复用"一个死 venv。
    const venvDir = path.join(WORK_DIR, '.venvs', 'taskDead');
    const goneHome = poolHome('3.9.25'); // 故意不登记 → 池内解释器已消失
    addHealthyVenv(venvDir, goneHome, '3.9.25');

    const calls = installSpawnRecorder(uvResponder([]));

    await capturePrepared(
      { id: 'taskDead', runtime: 'python', entrypoint: 'main.py', requirements: ['requests'] },
      'exec-dead-venv',
    );

    // 必须删除并重建，而不是带着死 venv 往下跑。
    const rmCalls = (mockFs.rmSync as jest.Mock).mock.calls.map((c) => String(c[0]));
    expect(rmCalls).toContain(venvDir);
    expect(calls.some(isUvVenvCall)).toBe(true);
  });

  it('reuses a healthy cached venv without rebuilding it (AC-16b)', async () => {
    const home = poolHome('3.12.13');
    addPoolInterpreter('3.12.13');
    const venvDir = path.join(WORK_DIR, '.venvs', 'taskHealthy-3.12');
    const venvPy = addHealthyVenv(venvDir, home, '3.12.13');

    const calls = installSpawnRecorder(uvResponder([]));

    const { prepared } = await capturePrepared(
      {
        id: 'taskHealthy',
        runtime: 'python',
        entrypoint: 'main.py',
        runtimeVersion: '3.12',
        requirements: [],
      },
      'exec-healthy-venv',
    );

    // 复用命中：既没有 venv 重建，也没有 pip 安装，且不碰解释器池。
    expect(calls.filter(isUvCall)).toEqual([]);
    expect(prepared.task.cmd).toBe(venvPy);
  });

  it('rebuilds when the cached venv was built for a different version (AC-15b)', async () => {
    // 目录键撞车（或人为改了声明版本）时，复用会让任务悄悄跑在错误版本上。
    const home = poolHome('3.9.25');
    addPoolInterpreter('3.9.25');
    const venvDir = path.join(WORK_DIR, '.venvs', 'taskMismatch-3.12');
    addHealthyVenv(venvDir, home, '3.9.25'); // 里面其实是 3.9

    const poolBin312 = addPoolInterpreter('3.12.13');
    const calls = installSpawnRecorder(
      uvResponder([
        { version: '3.9.25', path: poolHome('3.9.25') },
        { version: '3.12.13', path: poolBin312 },
      ]),
    );

    await capturePrepared(
      {
        id: 'taskMismatch',
        runtime: 'python',
        entrypoint: 'main.py',
        runtimeVersion: '3.12',
      },
      'exec-mismatch-venv',
    );

    const rmCalls = (mockFs.rmSync as jest.Mock).mock.calls.map((c) => String(c[0]));
    expect(rmCalls).toContain(venvDir);
    const venvCall = calls.find(isUvVenvCall)!;
    // 必须用 3.12 的池内路径重建，而不是沿用 3.9 的环境。
    expect(venvCall.args[venvCall.args.indexOf('--python') + 1]).toBe(poolBin312);
  });

  it('glue + declared version runs with the declared interpreter (AC-11a)', async () => {
    const poolBin = addPoolInterpreter('3.11.15');
    const calls = installSpawnRecorder(uvResponder([{ version: '3.11.15', path: poolBin }]));

    const { prepared } = await capturePrepared(
      {
        runtime: 'python',
        glueSource: 'print(1)',
        glueLanguage: 'python',
        runtimeVersion: '3.11',
      },
      'exec-glue-ver',
    );

    // glue 渠道不建 venv、不装依赖，但要用声明的解释器。
    expect(prepared.task.cmd).toBe(poolBin);
    expect(prepared.task.args).toEqual(['glue_script.py']);
    expect(calls.some(isUvVenvCall)).toBe(false);
    expect(calls.some(isUvPipCall)).toBe(false);
  });

  it('does not build a venv for glue even with requirements', async () => {
    const calls = installSpawnRecorder(uvResponder([]));
    await capturePrepared(
      { runtime: 'python', glueSource: 'print(1)', glueLanguage: 'python', requirements: ['requests'] },
      'exec-glue-nodeps',
    );
    expect(calls.some(isUvVenvCall)).toBe(false);
    expect(calls.some(isUvPipCall)).toBe(false);
  });

  it('runtimeVersion on a node task is ignored (NG-02 scope boundary)', async () => {
    const calls = installSpawnRecorder(uvResponder([]));
    const { prepared } = await capturePrepared(
      { runtime: 'node', entrypoint: 'index.js', runtimeVersion: '3.11' },
      'exec-node-ver',
    );
    expect(prepared.task.cmd).toBe(process.platform === 'win32' ? 'node.exe' : 'node');
    expect(calls.filter(isUvCall)).toEqual([]);
  });
});

// ===========================================================================
// 活跃 venv 的 TTL 保护（三处同源纪律）
// ===========================================================================

describe('active venv protection for the TTL sweep', () => {
  it('exposes the versioned venv dir name while an execution is live', async () => {
    const poolBin = addPoolInterpreter('3.12.13');

    // 让 worker 持有执行不完成，使 entry 留在 liveExecutions 里。
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    (taskWorkerManager.execute as jest.Mock).mockImplementationOnce(
      async (_t: string, _e: string, _task: any, _p: any, _oc?: () => void, runPrepared?: any) => {
        if (runPrepared) await runPrepared(() => undefined);
        await held;
      },
    );
    installSpawnRecorder(uvResponder([{ version: '3.12.13', path: poolBin }]));

    await request(app).post('/api/execute').send({
      executionId: 'exec-live-venv',
      task: { id: 'taskLive', runtime: 'python', entrypoint: 'main.py', runtimeVersion: '3.12' },
    });
    await flushAsync();

    // 版本签名必须体现在保护集里：裸 taskId `taskLive` 保护不到
    // `taskLive-3.12` 这个目录（这正是"三处同源"要防的漏保护）。
    expect(listActiveVenvDirNames()).toContain('taskLive-3.12');

    release();
    await flushAsync();
  });

  it('does not report a venv dir for executions that never built one', async () => {
    installSpawnRecorder(uvResponder([]));
    const { prepared } = await capturePrepared(
      { id: 'taskPlain', runtime: 'python', entrypoint: 'main.py' },
      'exec-no-venv',
    );
    expect(prepared.task.cmd).toBe(process.platform === 'win32' ? 'python.exe' : 'python3');
    // 无 venv 的执行不产生保护项（否则保护集会无意义地膨胀）。
    expect(listActiveVenvDirNames()).not.toContain('taskPlain');
  });
});
