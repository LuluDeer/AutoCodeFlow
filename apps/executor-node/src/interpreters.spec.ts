/**
 * WS5 —— `interpreters.ts` 单元测试。
 *
 * 这里的断言全部围绕 CONTRACT.md §3.2/§3.3 的**硬约束**展开，而不是围绕实现
 * 细节：版本闸门（NFR-03）、池白名单（NFR-02）、前缀匹配的点号陷阱、
 * 单条损坏不致命（AC-14b）、探测缓存（NFR-10）、并发去重与全局有界下载队列
 * （D13/NFR-16）、以及 uv 定位的四级顺序。
 *
 * 真实 uv 的端到端行为另见 `interpreters.integration.spec.ts`（默认跳过）。
 */

import path from 'path';
import fs from 'fs';

jest.mock('./logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.mock('./config', () => ({
  config: {
    uvPythonInstallDir: '/pool-interpreters',
    uvBin: '',
    uvPythonInstallMirror: '',
    interpreterDownloadTimeoutMs: 300_000,
    interpreterDownloadConcurrency: 2,
  },
}));

jest.mock('./run-command', () => ({
  runCommand: jest.fn(),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { runCommand } = require('./run-command') as { runCommand: jest.Mock };
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { config } = require('./config') as {
  config: {
    uvPythonInstallDir: string;
    uvBin: string;
    uvPythonInstallMirror: string;
    interpreterDownloadTimeoutMs: number;
    interpreterDownloadConcurrency: number;
  };
};

import {
  InterpreterUnavailableError,
  ONLINE_DOWNLOAD_MIN,
  RUNTIME_VERSION_MAX,
  RUNTIME_VERSION_MIN,
  __resetForTests,
  discoverInstalled,
  ensureVersion,
  interpreterSnapshot,
  invalidateCache,
  isOnlineDownloadable,
  isSupportedVersion,
  normalizeRuntimeVersion,
  poolSummary,
  resolvePythonBin,
  resolveUvBin,
} from './interpreters';

const POOL = path.resolve('/pool-interpreters');

/** 造一条 `uv python list --output-format json` 条目。 */
function entry(version: string, p: string, key?: string) {
  return {
    key: key ?? `cpython-${version}-${process.platform === 'win32' ? 'windows-x86_64' : 'linux-x86_64'}-none`,
    version,
    version_parts: {
      major: parseInt(version.split('.')[0], 10),
      minor: parseInt(version.split('.')[1], 10),
      patch: parseInt(version.split('.')[2] ?? '0', 10),
    },
    path: p,
    symlink: null,
    url: null,
    implementation: 'cpython',
  };
}

/** 池内某版本解释器的规范路径。 */
function poolBin(version: string): string {
  // 平台三元组：Windows 的 libc 槽位是 `none`，Linux 是 `gnu`（不带 `-none` 后缀）。
  const platform = process.platform === 'win32' ? 'windows-x86_64-none' : 'linux-x86_64-gnu';
  const exe = process.platform === 'win32' ? 'python.exe' : 'bin/python3';
  return path.join(POOL, `cpython-${version}-${platform}`, ...exe.split('/'));
}

/** 从 poolBin 路径提取池目录名（平台无关）。 */
function poolDirName(version: string): string {
  return path.relative(POOL, poolBin(version)).split(path.sep)[0];
}

/**
 * 让 `fs.readdirSync(poolRoot())` 返回给定条目名，并逐个目录给出一组候选文件。
 * 供 D-15 的本地扫描兜底用例使用（需要真的"看见"池目录内容）。
 */
function mockPoolDirs(names: string[], filesByDir: Record<string, string[]> = {}): void {
  (fs.readdirSync as unknown as jest.Mock).mockImplementation((p: string) => {
    if (path.resolve(String(p)) === path.resolve(config.uvPythonInstallDir)) {
      return names as never;
    }
    // 目录内列举（若被调用）
    for (const [dir, files] of Object.entries(filesByDir)) {
      if (path.resolve(String(p)) === path.resolve(path.join(config.uvPythonInstallDir, dir))) {
        return files.map((f) => path.basename(f)) as never;
      }
    }
    return [] as never;
  });
}

/** 让 fs.statSync/accessSync 认为给定路径都是可执行文件。 */
function mockExecutableFiles(paths: string[]): void {  const set = new Set(paths.map((p) => path.resolve(p)));
  (fs.statSync as unknown as jest.Mock).mockImplementation((p: string) => {
    if (!set.has(path.resolve(p))) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    return { isFile: () => true, isDirectory: () => false };
  });
  (fs.accessSync as unknown as jest.Mock).mockImplementation((p: string) => {
    if (!set.has(path.resolve(p))) throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
  });
}

/** 默认 runCommand 行为：`uv --version` 成功 + `python list` 返回给定条目。 */
function mockUv(entries: unknown[], opts: { listStatus?: number; listStdout?: string } = {}) {
  runCommand.mockImplementation(async (cmd: string, args: string[]) => {
    if (args[0] === '--version') return { status: 0, stdout: 'uv 0.8.17', stderr: '' };
    if (args[0] === 'python' && args[1] === 'list') {
      if (opts.listStatus !== undefined && opts.listStatus !== 0) {
        return { status: opts.listStatus, stdout: '', stderr: 'boom' };
      }
      return {
        status: 0,
        stdout: opts.listStdout ?? JSON.stringify(entries),
        stderr: '',
      };
    }
    return { status: 0, stdout: '', stderr: '' };
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  __resetForTests();
  config.uvPythonInstallDir = '/pool-interpreters';
  config.uvBin = '';
  config.uvPythonInstallMirror = '';
  config.interpreterDownloadTimeoutMs = 300_000;

  jest.spyOn(fs, 'mkdirSync').mockReturnValue(undefined as never);
  jest.spyOn(fs, 'readdirSync').mockReturnValue([] as never);
  jest.spyOn(fs, 'rmSync').mockReturnValue(undefined as never);
  // 默认 realpath 为恒等（测试里的路径已是规范形式）；需要验证 junction 去重
  // 的用例会自己覆盖它。
  jest.spyOn(fs, 'realpathSync').mockImplementation((p) => String(p) as never);
  jest.spyOn(fs, 'statSync').mockImplementation(() => {
    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  });
  jest.spyOn(fs, 'accessSync').mockImplementation(() => undefined);
});

afterEach(() => {
  jest.restoreAllMocks();
});

// ---------------------------------------------------------------------------

describe('interpreters: version gate (NFR-03)', () => {
  it.each(['3.7', '3.13', '3.14', '3.10'])('accepts %s', (v) => {
    expect(normalizeRuntimeVersion(v)).toBe(v);
  });

  it('trims surrounding whitespace', () => {
    expect(normalizeRuntimeVersion('  3.12  ')).toBe('3.12');
  });

  it.each([
    '3.7.9', // 带补丁号 —— 会污染 .venvs 目录名与 uv argv
    '3',
    '3.',
    '.7',
    '../x',
    '--index-url',
    '3.13; rm -rf /',
    '',
    ' ',
    'v3.13',
  ])('rejects %j before it can reach uv argv', (v) => {
    expect(() => normalizeRuntimeVersion(v)).toThrow(/Invalid runtimeVersion/);
  });

  it.each([null, undefined, 3.13, {}, []])('rejects non-string %p', (v) => {
    expect(() => normalizeRuntimeVersion(v)).toThrow(/Invalid runtimeVersion/);
  });
});

describe('interpreters: supported range & online downloadability', () => {
  it('range bounds are 3.7 ~ 3.14 (CONTRACT.md §1.1)', () => {
    expect(RUNTIME_VERSION_MIN).toBe('3.7');
    expect(RUNTIME_VERSION_MAX).toBe('3.14');
    expect(ONLINE_DOWNLOAD_MIN).toBe('3.8');
  });

  it.each(['3.7', '3.8', '3.12', '3.14'])('%s is supported', (v) => {
    expect(isSupportedVersion(v)).toBe(true);
  });

  it.each(['3.6', '3.15', '4.0'])('%s is outside the supported range', (v) => {
    expect(isSupportedVersion(v)).toBe(false);
  });

  it('3.7 is supported but NOT online-downloadable (CONTRACT.md §0)', () => {
    expect(isSupportedVersion('3.7')).toBe(true);
    expect(isOnlineDownloadable('3.7')).toBe(false);
  });

  it.each(['3.8', '3.9', '3.12', '3.14'])('%s is online-downloadable', (v) => {
    expect(isOnlineDownloadable(v)).toBe(true);
  });

  it.each(['3.6', '3.7', '3.15', 'garbage'])('%s is not online-downloadable', (v) => {
    expect(isOnlineDownloadable(v)).toBe(false);
  });
});

describe('interpreters: uv resolution order (CONTRACT.md §3.3)', () => {
  it('prefers UV_BIN when it is an executable file', async () => {
    config.uvBin = process.platform === 'win32' ? 'D:\\tools\\uv.exe' : '/tools/uv';
    mockExecutableFiles([config.uvBin]);

    await expect(resolveUvBin()).resolves.toEqual({ path: config.uvBin, source: 'env' });
    // 显式指定后不该再去 PATH 探测。
    expect(runCommand).not.toHaveBeenCalled();
  });

  it('falls back to PATH when UV_BIN points at a non-existent file', async () => {
    config.uvBin = '/nope/uv';
    mockExecutableFiles([]);
    mockUv([]);

    await expect(resolveUvBin()).resolves.toEqual({ path: 'uv', source: 'path' });
  });

  it('falls back to the bundled binary when uv is not on PATH', async () => {
    const resources = path.resolve('/electron-resources');
    (process as unknown as { resourcesPath?: string }).resourcesPath = resources;
    const bundled = path.join(resources, 'uv', process.platform === 'win32' ? 'uv.exe' : 'uv');
    mockExecutableFiles([bundled]);
    runCommand.mockResolvedValue({ status: null, stdout: '', stderr: 'spawn uv ENOENT' });

    try {
      await expect(resolveUvBin()).resolves.toEqual({ path: bundled, source: 'bundled' });
    } finally {
      delete (process as unknown as { resourcesPath?: string }).resourcesPath;
    }
  });

  it('reports missing when nothing is available (bare node: no process.resourcesPath)', async () => {
    // 裸 node 下 process.resourcesPath 是 undefined —— 拼接不能产出
    // 'undefined/uv/uv' 这种看似存在的候选。
    expect((process as unknown as { resourcesPath?: string }).resourcesPath).toBeUndefined();
    runCommand.mockResolvedValue({ status: null, stdout: '', stderr: 'spawn uv ENOENT' });

    await expect(resolveUvBin()).resolves.toEqual({ path: null, source: 'missing' });
  });

  it('caches the resolution', async () => {
    mockUv([]);
    await resolveUvBin();
    await resolveUvBin();
    expect(runCommand).toHaveBeenCalledTimes(1);
  });
});

describe('interpreters: discoverInstalled', () => {
  it('keeps only pool-managed interpreters and drops system / PATH shims', async () => {
    const inPool = poolBin('3.12.11');
    mockUv([
      // 池内 —— 保留
      entry('3.12.11', inPool),
      // 系统 Python —— 池外，必须剔除
      entry('3.14.6', 'C:\\Python314\\python.exe'),
      // uv 在 ~/.local/bin 装的 PATH shim —— 池外，必须剔除
      entry('3.11.13', 'C:\\Users\\x\\.local\\bin\\python3.11.exe'),
    ]);
    mockExecutableFiles([inPool, 'C:\\Python314\\python.exe', 'C:\\Users\\x\\.local\\bin\\python3.11.exe']);

    const found = await discoverInstalled();

    expect(found.map((e) => e.version)).toEqual(['3.12.11']);
    expect(found[0].path).toBe(inPool);
    expect(found[0].available).toBe(true);
    expect(found[0].discoveredAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('resolves RELATIVE paths from uv against the spawn cwd (real uv does this)', async () => {
    // 实测：池位于 cwd 之下时 uv 输出相对路径 `.tmp-uvprobe\cpython-...\python.exe`。
    const rel = path.relative(POOL, poolBin('3.9.25'));
    mockUv([entry('3.9.25', rel)]);
    mockExecutableFiles([poolBin('3.9.25')]);

    const found = await discoverInstalled();

    expect(found).toHaveLength(1);
    expect(found[0].path).toBe(poolBin('3.9.25'));
    expect(path.isAbsolute(found[0].path)).toBe(true);
  });

  it('drops a single corrupt entry without throwing (AC-14b)', async () => {
    const good = poolBin('3.12.11');
    const missing = poolBin('3.9.25');
    mockUv([entry('3.12.11', good), entry('3.9.25', missing)]);
    // 只有 good 真的存在 —— missing 是"注册了但文件没了"的损坏条目。
    mockExecutableFiles([good]);

    const found = await discoverInstalled();

    // 剔除而非标记 available:false：清单的消费者是 admin 调度过滤，留下一个
    // "能派单但必然失败"的假阳性比少报更糟（对齐 python 的 usable 过滤）。
    expect(found.map((e) => e.version)).toEqual(['3.12.11']);
    expect(found.every((e) => e.available)).toBe(true);
  });

  it('drops malformed JSON records (missing path / bad version) without throwing', async () => {
    const good = poolBin('3.12.11');
    mockUv([
      entry('3.12.11', good),
      { version: '3.9.25' }, // 没有 path
      { path: poolBin('3.8.20') }, // 没有 version
      { path: poolBin('3.8.20'), version: 'not-a-version' },
      null,
      'garbage',
    ]);
    mockExecutableFiles([good, poolBin('3.8.20')]);

    const found = await discoverInstalled();

    expect(found.map((e) => e.version)).toEqual(['3.12.11']);
  });

  it('deduplicates the same path listed twice (uv lists junctions + real dirs)', async () => {
    const bin = poolBin('3.9.25');
    mockUv([entry('3.9.25', bin), entry('3.9.25', bin)]);
    mockExecutableFiles([bin]);

    const found = await discoverInstalled();
    expect(found).toHaveLength(1);
  });

  it('collapses uv\'s junction alias + real dir into ONE entry (real uv behaviour)', async () => {
    // 实测：uv 装 3.12 会同时留下 `cpython-3.12-<platform>-none`（junction）
    // 和 `cpython-3.12.13-<platform>-none`（真实目录），`uv python list` 两个
    // 都报。不按 realpath 去重就会上报两个 3.12.13。
    const real = poolBin('3.12.13');
    const alias = path.join(POOL, `cpython-3.12-${process.platform === 'win32' ? 'windows-x86_64' : 'linux-x86_64'}-none`,
      ...(process.platform === 'win32' ? ['python.exe'] : ['bin', 'python3']));
    mockUv([entry('3.12.13', alias), entry('3.12.13', real)]);
    mockExecutableFiles([alias, real]);
    (fs.realpathSync as unknown as jest.Mock).mockImplementation((p: string) =>
      path.resolve(String(p)) === path.resolve(alias) ? real : String(p),
    );

    const found = await discoverInstalled();

    expect(found).toHaveLength(1);
    expect(found[0].path).toBe(real);
    expect(found[0].version).toBe('3.12.13');
  });

  it('drops a junction that escapes the pool (NFR-02 symlink escape)', async () => {
    const inside = poolBin('3.12.13');
    const outside = path.resolve('/etc/evil/python');
    mockUv([entry('3.12.13', inside)]);
    mockExecutableFiles([inside, outside]);
    (fs.realpathSync as unknown as jest.Mock).mockReturnValue(outside);

    const found = await discoverInstalled();

    expect(found).toEqual([]);
    expect(resolvePythonBin('3.12')).toBeNull();
  });

  it('returns [] (no throw) when uv python list fails outright AND the pool is empty', async () => {
    mockUv([], { listStatus: 2 });
    // 注意语义变化（CONTRACT.md §0.3 / D-15）：uv 整体失败**不再直接报空池**，
    // 而是退到本地目录扫描。池确实是空的，所以兜底也扫不到东西 → 空。
    await expect(discoverInstalled()).resolves.toEqual([]);
  });

  it('recovers healthy interpreters from a local scan when uv fails (D-15)', async () => {
    // 为什么必须兜底：实测池内只要有一个**同平台但不可运行**的条目，
    // `uv python list` 就整体非零退出，并且**连健康条目也一并吞掉**。
    // 报"空池"会让执行器对 admin 宣称零解释器 → 所有声明版本的任务被拒，
    // 而池里的健康版本其实仍可用。一个局部损坏不该放大成整个特性不可用。
    const healthy = poolBin('3.12.11');
    const dirName = poolDirName('3.12.11');
    mockExecutableFiles([healthy]);
    mockPoolDirs([dirName], {
      [dirName]: [healthy],
    });
    mockUv([], { listStatus: 2 }); // uv 整体失败（模拟池里有坏条目）

    const found = await discoverInstalled({ force: true });
    expect(found.map((e) => e.version)).toEqual(['3.12.11']);
    expect(found[0].available).toBe(true);
  });

  it('the local-scan fallback skips foreign-platform entries (D-14/D-15)', async () => {
    // 共享卷里 coexists 着 glibc/musl/Windows 产物；外来平台的 python3 在 POSIX 上
    // 带 +x 位、isExecutable 会放行，但它在这台机器上**跑不起来**。
    // 用与本机**不同**的平台三元组作为外来平台（平台无关断言）。
    const foreignPlatform = process.platform === 'win32' ? 'linux-x86_64-gnu' : 'windows-x86_64-none';
    const foreign = path.join(POOL, `cpython-3.12.11-${foreignPlatform}`, 'bin', 'python3');
    mockExecutableFiles([foreign]);
    mockPoolDirs([`cpython-3.12.11-${foreignPlatform}`], {
      [`cpython-3.12.11-${foreignPlatform}`]: [foreign],
    });
    mockUv([], { listStatus: 2 });

    const found = await discoverInstalled({ force: true });
    // 外来平台 token 与本机不同 → 必须被剔除。
    expect(found).toEqual([]);
  });

  it('returns [] (no throw) when uv python list emits unparseable JSON and the pool is empty', async () => {
    mockUv([], { listStdout: 'not json at all' });
    await expect(discoverInstalled()).resolves.toEqual([]);
  });

  it('returns [] (no throw) when uv is entirely missing and the pool is empty', async () => {
    runCommand.mockResolvedValue({ status: null, stdout: '', stderr: 'spawn uv ENOENT' });
    await expect(discoverInstalled()).resolves.toEqual([]);
  });

  it('caches within the TTL — the 30s heartbeat must not spawn uv every beat (NFR-10)', async () => {
    const bin = poolBin('3.12.11');
    mockUv([entry('3.12.11', bin)]);
    mockExecutableFiles([bin]);

    await discoverInstalled();
    await discoverInstalled();
    await discoverInstalled();

    const listCalls = runCommand.mock.calls.filter(
      (c) => (c[1] as string[])[1] === 'list',
    );
    expect(listCalls).toHaveLength(1);
  });

  it('force bypasses the cache; invalidateCache() clears it', async () => {
    const bin = poolBin('3.12.11');
    mockUv([entry('3.12.11', bin)]);
    mockExecutableFiles([bin]);

    await discoverInstalled();
    await discoverInstalled({ force: true });
    invalidateCache();
    await discoverInstalled();

    const listCalls = runCommand.mock.calls.filter(
      (c) => (c[1] as string[])[1] === 'list',
    );
    expect(listCalls).toHaveLength(3);
  });

  it('passes a credential-free, pool-scoped env to uv (UV_PYTHON_DOWNLOADS=manual survives)', async () => {
    const bin = poolBin('3.12.11');
    mockUv([entry('3.12.11', bin)]);
    mockExecutableFiles([bin]);

    await discoverInstalled();

    const call = runCommand.mock.calls.find((c) => (c[1] as string[])[1] === 'list')!;
    const env = call[2].env as NodeJS.ProcessEnv;
    expect(env.UV_PYTHON_INSTALL_DIR).toBe(POOL);
    expect(env.UV_PYTHON_DOWNLOADS).toBe('manual');
    expect(env.UV_NO_PROGRESS).toBe('1');
    // 执行器密钥绝不能经 env 流到 uv（白名单纪律）。
    expect(env.EXECUTOR_SHARED_TOKEN).toBeUndefined();
    expect(env.EXECUTION_CALLBACK_SECRET).toBeUndefined();
  });
});

describe('interpreters: resolvePythonBin prefix matching (NFR-02)', () => {
  beforeEach(async () => {
    const bins = [poolBin('3.13.13'), poolBin('3.7.9')];
    mockUv([entry('3.13.13', bins[0]), entry('3.7.9', bins[1])]);
    mockExecutableFiles(bins);
    await discoverInstalled();
  });

  it('returns the pool path for an exact minor match', () => {
    expect(resolvePythonBin('3.13')).toBe(poolBin('3.13.13'));
  });

  it('does NOT let "3.1" match "3.13.x" — the prefix must include the dot', () => {
    expect(resolvePythonBin('3.1')).toBeNull();
  });

  it('does NOT let "3" match anything', () => {
    expect(resolvePythonBin('3')).toBeNull();
  });

  it('returns null for an uninstalled version', () => {
    expect(resolvePythonBin('3.12')).toBeNull();
  });

  it('returns null for a malformed version (never reaches argv/paths)', () => {
    expect(resolvePythonBin('3.7.9')).toBeNull();
    expect(resolvePythonBin('../etc')).toBeNull();
    expect(resolvePythonBin('')).toBeNull();
  });

  it('offline-prefilled 3.7 IS resolvable (pool membership, not downloadability)', () => {
    expect(resolvePythonBin('3.7')).toBe(poolBin('3.7.9'));
  });

  it('returns null while the discovery cache is cold', () => {
    invalidateCache();
    expect(resolvePythonBin('3.13')).toBeNull();
  });

  it('never returns a path outside the pool root', async () => {
    invalidateCache();
    mockUv([entry('3.12.11', 'C:\\Windows\\System32\\python.exe')]);
    mockExecutableFiles(['C:\\Windows\\System32\\python.exe']);
    await discoverInstalled();
    expect(resolvePythonBin('3.12')).toBeNull();
  });
});

describe('interpreters: poolSummary / interpreterSnapshot', () => {
  it('reports the install dir and only available versions', async () => {
    const good = poolBin('3.12.11');
    mockUv([entry('3.12.11', good), entry('3.9.25', poolBin('3.9.25'))]);
    mockExecutableFiles([good]);
    await discoverInstalled();

    expect(interpreterSnapshot().map((e) => e.version)).toEqual(['3.12.11']);
    // 上报结构里不得出现内部字段 `resolved`。
    expect(Object.keys(interpreterSnapshot()[0]).sort()).toEqual(
      ['available', 'discoveredAt', 'path', 'version'],
    );
  });

  it('poolSummary reads the DIRECTORY, not the discovery cache (failure-path safety)', () => {
    // 留痕发生在失败路径上：不能因为"要记录失败原因"再 spawn 一次 uv。
    (fs.readdirSync as unknown as jest.Mock).mockReturnValue([
      'cpython-3.12.11-windows-x86_64-none',
      'cpython-3.7.9-windows-x86_64-none',
      'cpython-3.9-windows-x86_64-none',
      '.cache',
      '.temp',
      'not-a-pool-entry',
    ]);

    // 完全没有探测过（缓存为空）也必须能报出池内容。
    expect(poolSummary()).toEqual({
      installDir: POOL,
      versions: ['3.12.11', '3.7.9', '3.9'],
    });
    expect(runCommand).not.toHaveBeenCalled();
  });

  it('poolSummary tolerates an unreadable pool dir', () => {
    (fs.readdirSync as unknown as jest.Mock).mockImplementation(() => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
    expect(poolSummary()).toEqual({ installDir: POOL, versions: [] });
  });

  it('is empty before any discovery', () => {
    (fs.readdirSync as unknown as jest.Mock).mockReturnValue([]);
    expect(poolSummary().versions).toEqual([]);
    expect(interpreterSnapshot()).toEqual([]);
  });
});

describe('interpreters: ensureVersion', () => {
  it('reuses a pooled interpreter without spawning a download', async () => {
    const bin = poolBin('3.12.11');
    mockUv([entry('3.12.11', bin)]);
    mockExecutableFiles([bin]);

    await expect(ensureVersion('3.12')).resolves.toBe(bin);

    const installs = runCommand.mock.calls.filter(
      (c) => (c[1] as string[])[0] === 'python' && (c[1] as string[])[1] === 'install',
    );
    expect(installs).toHaveLength(0);
  });

  it('throws uv_missing when uv is unavailable (declared-version tasks fail loudly)', async () => {
    runCommand.mockResolvedValue({ status: null, stdout: '', stderr: 'spawn uv ENOENT' });

    await expect(ensureVersion('3.12')).rejects.toMatchObject({
      name: 'InterpreterUnavailableError',
      version: '3.12',
      reason: 'uv_missing',
    });
  });

  it('rejects a malformed version BEFORE any uv invocation (NFR-03)', async () => {
    mockUv([]);
    await expect(ensureVersion('3.7.9')).rejects.toThrow(/Invalid runtimeVersion/);
    await expect(ensureVersion('--index-url')).rejects.toThrow(/Invalid runtimeVersion/);
    expect(runCommand).not.toHaveBeenCalled();
  });

  it('3.7 absent from the pool → not_downloadable, with offline pre-provisioning guidance', async () => {
    mockUv([]);

    const err: InterpreterUnavailableError = await ensureVersion('3.7').catch((e) => e);

    expect(err).toBeInstanceOf(InterpreterUnavailableError);
    expect(err.reason).toBe('not_downloadable');
    // 运维必须能从消息里直接读出"该往哪放什么"。
    // 注意：模板**不得写死补丁号**（3.6/3.5 走同一分支），且**不得在三元组之后
    // 再补 `-none`**——实测那样会被 uv 静默忽略 / 判为非法请求（CONTRACT.md §0.2）。
    expect(err.detail).toMatch(/cpython-3\.7\.x-/);
    expect(err.detail).toMatch(/cpython-<full-version>-<uv platform triple>/);
    expect(err.detail).toMatch(/do NOT append an extra "-none"/i);
    // 给出 uv 的真实平台词汇（而非 pbs 发布名）。
    expect(err.detail).toMatch(/linux-x86_64-gnu/);
    expect(err.detail).toMatch(/windows-x86_64-none/);
    expect(err.detail).not.toMatch(/linux-[a-z0-9_]+-(gnu|musl)-none/);
    expect(err.detail).not.toMatch(/x86_64-unknown-linux-gnu/);
    expect(err.detail).not.toMatch(/x86_64-pc-windows-msvc/);
    expect(err.detail).toMatch(/pre-provision/i);
    expect(err.message).toMatch(/^interpreter 3\.7 unavailable/);
  });

  it('a version above the supported range → not_downloadable (no wasted uv call)', async () => {
    mockUv([]);
    const err: InterpreterUnavailableError = await ensureVersion('3.15').catch((e) => e);
    expect(err.reason).toBe('not_downloadable');
    expect(err.detail).toMatch(/outside the supported range/);
  });

  it('downloads a missing version and returns the verified pool path', async () => {
    const bin = poolBin('3.11.13');
    let listed: unknown[] = [];
    runCommand.mockImplementation(async (_cmd: string, args: string[]) => {
      if (args[0] === '--version') return { status: 0, stdout: 'uv 0.8.17', stderr: '' };
      if (args[0] === 'python' && args[1] === 'list') {
        return { status: 0, stdout: JSON.stringify(listed), stderr: '' };
      }
      if (args[0] === 'python' && args[1] === 'install') {
        listed = [entry('3.11.13', bin)]; // 下载后池里就有了
        mockExecutableFiles([bin]);
        return { status: 0, stdout: 'Installed Python 3.11.13', stderr: '' };
      }
      return { status: 0, stdout: '', stderr: '' };
    });

    await expect(ensureVersion('3.11')).resolves.toBe(bin);

    const install = runCommand.mock.calls.find((c) => (c[1] as string[])[1] === 'install')!;
    expect(install[1]).toEqual(['python', 'install', '--no-config', '--no-progress', '3.11']);
  });

  it('forwards the abort signal into the uv install child (NETOPT-D P2-1)', async () => {
    // P2-1: 停机/杀端点 abort 必须到达 uv python install 的 runCommand signal——
    // 否则 detached 下载子进程在 executor 退出后继续下载（孤儿进程家族）。
    const bin = poolBin('3.11.13');
    const controller = new AbortController();
    let listed: unknown[] = [];
    runCommand.mockImplementation(async (_cmd: string, args: string[]) => {
      if (args[0] === '--version') return { status: 0, stdout: 'uv 0.8.17', stderr: '' };
      if (args[0] === 'python' && args[1] === 'list') {
        return { status: 0, stdout: JSON.stringify(listed), stderr: '' };
      }
      if (args[0] === 'python' && args[1] === 'install') {
        listed = [entry('3.11.13', bin)]; // 下载后池里就有了
        mockExecutableFiles([bin]);
        return { status: 0, stdout: 'Installed Python 3.11.13', stderr: '' };
      }
      return { status: 0, stdout: '', stderr: '' };
    });

    await expect(ensureVersion('3.11', { signal: controller.signal })).resolves.toBe(bin);

    const install = runCommand.mock.calls.find((c) => (c[1] as string[])[1] === 'install')!;
    expect((install[2] as { signal?: AbortSignal }).signal).toBe(controller.signal);

    // NETOPT-F P3-1: 主下载链上的两个探针（--version / python list）同样必须
    // 收 signal——否则停机 abort 时探针跑到自身超时才停（10s/30s），槽位释放
    // 拖过 main.ts 5s 硬杀窗口、终态回调丢失。install 已钉，探针未钉。
    const versionProbe = runCommand.mock.calls.find(
      (c) => (c[1] as string[])[0] === '--version',
    )!;
    expect((versionProbe[2] as { signal?: AbortSignal }).signal).toBe(controller.signal);
    const listProbe = runCommand.mock.calls.find(
      (c) => (c[1] as string[])[0] === 'python' && (c[1] as string[])[1] === 'list',
    )!;
    expect((listProbe[2] as { signal?: AbortSignal }).signal).toBe(controller.signal);

    // 已触发 abort 的 signal 也照常透传（run-command 对 aborted signal 立即树杀）。
    // 修复：mock 模拟 run-command 的 abort 语义（收到 aborted signal 立即抛）——
    // 原写法在 abort 后命中 :683 填好的池缓存，掩盖了 abort 语义（resolve 而非 reject）。
    controller.abort();
    runCommand.mockImplementation(
      async (
        _cmd: string,
        args: string[],
        opts?: { signal?: AbortSignal },
      ) => {
        if (opts?.signal?.aborted) throw new Error('aborted');
        if (args[0] === '--version') return { status: 0, stdout: 'uv 0.8.17', stderr: '' };
        if (args[0] === 'python' && args[1] === 'list') {
          return { status: 0, stdout: '[]', stderr: '' }; // 池空，强制走下载
        }
        return { status: 0, stdout: '', stderr: '' };
      },
    );
    // :683 的成功下载已填好 discoverInstalled 的 TTL 缓存——force 刷新为
    // "空池"，否则 ensureVersion 入口缓存命中直接返回 bin，掩盖 abort 语义。
    await discoverInstalled({ force: true });
    await expect(ensureVersion('3.11', { signal: controller.signal })).rejects.toThrow();
  });

  it('NETOPT-F P3-2: shares one in-flight install per version; an abort of the shared download fails both waiters (known limitation)', async () => {
    // 已知限制固化：B 复用 A 的 in-flight 下载（同一 pending），A abort 树杀后
    // B 也以 interpreter_unavailable 同败——不无限共享，失败后格子清理、后续
    // 执行重新下载。此测试钉住共享语义 + 同败行为，防无意改回"各自下载"。
    const bin = poolBin('3.11.13');
    let releaseInstall!: (v: unknown) => void;
    const installGate = new Promise((resolve) => {
      releaseInstall = resolve;
    });
    runCommand.mockImplementation(
      async (
        _cmd: string,
        args: string[],
        opts?: { signal?: AbortSignal },
      ) => {
        if (opts?.signal?.aborted) throw new Error('aborted');
        if (args[0] === '--version') return { status: 0, stdout: 'uv 0.8.17', stderr: '' };
        if (args[0] === 'python' && args[1] === 'list') {
          return { status: 0, stdout: '[]', stderr: '' }; // 池恒空 → 每次走下载
        }
        if (args[0] === 'python' && args[1] === 'install') {
          await installGate; // 下载挂起，直到 abort 或显式释放
          // 模拟 run-command 的 abort 语义：收到已 abort 的 signal 立即树杀抛错
          //（与 :692 既有用例同款）——否则 install 返回 status 0 会走 corrupt 分支。
          if (opts?.signal?.aborted) throw new Error('aborted');
          return { status: 0, stdout: '', stderr: '' };
        }
        return { status: 0, stdout: '', stderr: '' };
      },
    );
    await discoverInstalled({ force: true });

    // A/B 各自持自己的 abort 信号（真实场景是两个 execution 的 controller）：
    // A 的 abort 树杀共享下载（install 进程挂在 A 的 signal 上），复用了同一
    // pending 的 B 也同败——这正是本测试要钉的"共享下载 abort 已知限制"。
    const controllerA = new AbortController();
    const controllerB = new AbortController();
    const pA = ensureVersion('3.11', { signal: controllerA.signal }); // A 占 in-flight 格
    // 等 A 真正走到 installVersion（install runCommand 调用发生）——ensureVersion
    // 先 await discoverInstalled 再 set inFlight，一次 setImmediate 不够。
    const hasInstallCall = () =>
      runCommand.mock.calls.some(
        (c) => (c[1] as string[])[0] === 'python' && (c[1] as string[])[1] === 'install',
      );
    for (let i = 0; i < 200 && !hasInstallCall(); i++) {
      await new Promise((r) => setImmediate(r));
    }
    expect(hasInstallCall()).toBe(true);
    const pB = ensureVersion('3.11', { signal: controllerB.signal }); // B 复用

    // 共享语义的本质：**同一版本只发起一次下载**（install runCommand 计数 1）。
    // 不钉 promise 引用相等——pB 可能命中 inFlight 格（直接复用）或在全局下载
    // 队列排队（withDownloadSlot 并发闸），两者都表现为"无第二次 install"；
    // 钉引用会把实现细节耦合进测试。
    expect(
      runCommand.mock.calls.filter(
        (c) => (c[1] as string[])[0] === 'python' && (c[1] as string[])[1] === 'install',
      ),
    ).toHaveLength(1);
    // A/B 均挂起在共享下载上（未各自 resolve）。
    const pAState = await Promise.race([
      pA.then(() => 'resolved', () => 'rejected'),
      new Promise<string>((r) => setTimeout(() => r('pending'), 50)),
    ]);
    const pBState = await Promise.race([
      pB.then(() => 'resolved', () => 'rejected'),
      new Promise<string>((r) => setTimeout(() => r('pending'), 50)),
    ]);
    expect(pAState).toBe('pending');
    expect(pBState).toBe('pending');

    // A abort → 树杀共享下载 → A 与 B 同败（B 不 abort，纯粹被共享 pending 拖累）。
    controllerA.abort();
    releaseInstall(undefined);
    await expect(pA).rejects.toThrow(/aborted/);
    await expect(pB).rejects.toThrow(/aborted/);

    // 失败后格子清理：下一次 ensureVersion 重新发起下载（不再复用失败格）。
    controller2: {
      const c2 = new AbortController();
      // 失败格子清理后的重试：install 成功后列表刷新必须能看到新条目，否则
      // installVersion 的"成功后重探"走 corrupt 分支（install 后 list 仍空）。
      let listed2: unknown[] = [];
      runCommand.mockImplementation(
        async (_cmd: string, args: string[], opts?: { signal?: AbortSignal }) => {
          if (opts?.signal?.aborted) throw new Error('aborted');
          if (args[0] === '--version') return { status: 0, stdout: 'uv 0.8.17', stderr: '' };
          if (args[0] === 'python' && args[1] === 'list') {
            return { status: 0, stdout: JSON.stringify(listed2), stderr: '' };
          }
          if (args[0] === 'python' && args[1] === 'install') {
            listed2 = [entry('3.11.13', bin)];
            mockExecutableFiles([bin]);
            return { status: 0, stdout: 'Installed', stderr: '' };
          }
          return { status: 0, stdout: '', stderr: '' };
        },
      );
      await expect(ensureVersion('3.11', { signal: c2.signal })).resolves.toBe(bin);
    }
  });

  it('passes --mirror when configured', async () => {
    config.uvPythonInstallMirror = 'https://mirror.internal/pypi';
    const bin = poolBin('3.11.13');
    let listed: unknown[] = [];
    runCommand.mockImplementation(async (_cmd: string, args: string[]) => {
      if (args[0] === '--version') return { status: 0, stdout: 'uv 0.8.17', stderr: '' };
      if (args[1] === 'list') return { status: 0, stdout: JSON.stringify(listed), stderr: '' };
      if (args[1] === 'install') {
        listed = [entry('3.11.13', bin)];
        mockExecutableFiles([bin]);
        return { status: 0, stdout: '', stderr: '' };
      }
      return { status: 0, stdout: '', stderr: '' };
    });

    await ensureVersion('3.11');

    const install = runCommand.mock.calls.find((c) => (c[1] as string[])[1] === 'install')!;
    expect(install[1]).toEqual([
      'python', 'install', '--no-config', '--no-progress',
      '--mirror', 'https://mirror.internal/pypi', '3.11',
    ]);
    expect((install[2].env as NodeJS.ProcessEnv).UV_PYTHON_INSTALL_MIRROR).toBe(
      'https://mirror.internal/pypi',
    );
  });

  it('non-zero uv exit → download_failed carrying uv stderr', async () => {
    runCommand.mockImplementation(async (_cmd: string, args: string[]) => {
      if (args[0] === '--version') return { status: 0, stdout: 'uv', stderr: '' };
      if (args[1] === 'list') return { status: 0, stdout: '[]', stderr: '' };
      return { status: 2, stdout: '', stderr: 'error: something exploded' };
    });

    const err: InterpreterUnavailableError = await ensureVersion('3.11').catch((e) => e);
    expect(err.reason).toBe('download_failed');
    expect(err.detail).toMatch(/something exploded/);
  });

  it('network-ish failures are classified mirror_unreachable', async () => {
    runCommand.mockImplementation(async (_cmd: string, args: string[]) => {
      if (args[0] === '--version') return { status: 0, stdout: 'uv', stderr: '' };
      if (args[1] === 'list') return { status: 0, stdout: '[]', stderr: '' };
      return { status: 1, stdout: '', stderr: 'Caused by: tcp connect error' };
    });

    const err: InterpreterUnavailableError = await ensureVersion('3.11').catch((e) => e);
    expect(err.reason).toBe('mirror_unreachable');
  });

  it('uv reporting success but nothing usable appearing → corrupt + cleanup', async () => {
    const rmSpy = fs.rmSync as unknown as jest.Mock;
    runCommand.mockImplementation(async (_cmd: string, args: string[]) => {
      if (args[0] === '--version') return { status: 0, stdout: 'uv', stderr: '' };
      if (args[1] === 'list') return { status: 0, stdout: '[]', stderr: '' };
      return { status: 0, stdout: 'Installed Python 3.11.13', stderr: '' };
    });
    (fs.readdirSync as unknown as jest.Mock).mockReturnValue([
      `cpython-3.11.13-${process.platform === 'win32' ? 'windows-x86_64' : 'linux-x86_64'}-none`,
      'cpython-3.12.11-windows-x86_64-none',
    ]);

    const err: InterpreterUnavailableError = await ensureVersion('3.11').catch((e) => e);

    expect(err.reason).toBe('corrupt');
    // 只清损坏的那个版本，绝不波及别的版本。
    expect(rmSpy).toHaveBeenCalledTimes(1);
    expect(String(rmSpy.mock.calls[0][0])).toContain('cpython-3.11.13-');
  });

  it('timeout → download_timeout (distinct from a real download failure)', async () => {
    const realNow = Date.now;
    let clock = 1_000_000;
    Date.now = () => clock;
    runCommand.mockImplementation(async (_cmd: string, args: string[]) => {
      if (args[0] === '--version') return { status: 0, stdout: 'uv', stderr: '' };
      if (args[1] === 'list') return { status: 0, stdout: '[]', stderr: '' };
      clock += 5_000; // 模拟 run-command 在预算用尽后 SIGKILL 进程树
      return { status: null, stdout: '', stderr: '' };
    });

    try {
      const err: InterpreterUnavailableError = await ensureVersion('3.11', {
        timeoutMs: 5_000,
      }).catch((e) => e);
      expect(err.reason).toBe('download_timeout');
      expect(err.detail).toMatch(/within 5000ms/);
    } finally {
      Date.now = realNow;
    }
  });
});

describe('interpreters: concurrency (D13/NFR-16)', () => {
  it('per-version de-dup: concurrent ensureVersion(x) downloads exactly once', async () => {
    const bin = poolBin('3.11.13');
    let listed: unknown[] = [];
    let installCalls = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));

    runCommand.mockImplementation(async (_cmd: string, args: string[]) => {
      if (args[0] === '--version') return { status: 0, stdout: 'uv', stderr: '' };
      if (args[1] === 'list') return { status: 0, stdout: JSON.stringify(listed), stderr: '' };
      installCalls++;
      await gate;
      listed = [entry('3.11.13', bin)];
      mockExecutableFiles([bin]);
      return { status: 0, stdout: '', stderr: '' };
    });

    const a = ensureVersion('3.11');
    const b = ensureVersion('3.11');
    const c = ensureVersion('3.11');
    release();

    await expect(Promise.all([a, b, c])).resolves.toEqual([bin, bin, bin]);
    expect(installCalls).toBe(1);
  });

  it('bounded download queue: at most DOWNLOAD_CONCURRENCY (default 2) in flight across versions', async () => {
    const bins = [poolBin('3.11.13'), poolBin('3.12.11')];
    let listed: unknown[] = [];
    let concurrent = 0;
    let maxConcurrent = 0;

    runCommand.mockImplementation(async (_cmd: string, args: string[]) => {
      if (args[0] === '--version') return { status: 0, stdout: 'uv', stderr: '' };
      if (args[1] === 'list') return { status: 0, stdout: JSON.stringify(listed), stderr: '' };
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise((r) => setTimeout(r, 5));
      concurrent--;
      const requested = (args as string[])[args.length - 1];
      const bin = requested === '3.11' ? bins[0] : bins[1];
      listed = [...listed, entry(requested === '3.11' ? '3.11.13' : '3.12.11', bin)];
      mockExecutableFiles(bins);
      return { status: 0, stdout: '', stderr: '' };
    });

    await expect(Promise.all([ensureVersion('3.11'), ensureVersion('3.12')])).resolves.toEqual(
      bins,
    );
    // 有界并发（默认 2）：不同版本允许并行（>1），但不超过配置上限（≤2）——
    // 这是 D13 从"全局单队列"放宽后的新契约。
    expect(maxConcurrent).toBeGreaterThan(1);
    expect(maxConcurrent).toBeLessThanOrEqual(2);
  });

  it('a failed download does not poison the queue for later versions', async () => {
    const bin = poolBin('3.12.11');
    let listed: unknown[] = [];
    runCommand.mockImplementation(async (_cmd: string, args: string[]) => {
      if (args[0] === '--version') return { status: 0, stdout: 'uv', stderr: '' };
      if (args[1] === 'list') return { status: 0, stdout: JSON.stringify(listed), stderr: '' };
      if ((args as string[])[args.length - 1] === '3.11') {
        return { status: 2, stdout: '', stderr: 'error: nope' };
      }
      listed = [entry('3.12.11', bin)];
      mockExecutableFiles([bin]);
      return { status: 0, stdout: '', stderr: '' };
    });

    await expect(ensureVersion('3.11')).rejects.toBeInstanceOf(InterpreterUnavailableError);
    // 队列必须已放行：否则一次失败会把之后所有版本永久钉死。
    await expect(ensureVersion('3.12')).resolves.toBe(bin);
  });

  it('waiters re-check the pool instead of re-downloading', async () => {
    const bin = poolBin('3.11.13');
    let listed: unknown[] = [];
    let installCalls = 0;
    runCommand.mockImplementation(async (_cmd: string, args: string[]) => {
      if (args[0] === '--version') return { status: 0, stdout: 'uv', stderr: '' };
      if (args[1] === 'list') return { status: 0, stdout: JSON.stringify(listed), stderr: '' };
      installCalls++;
      await new Promise((r) => setTimeout(r, 5));
      listed = [entry('3.11.13', bin)];
      mockExecutableFiles([bin]);
      return { status: 0, stdout: '', stderr: '' };
    });

    // 两个不同版本并发：第二个在队列里等到第一个装完后，自己的 install 仍会
    // 执行（版本不同），但**同一版本**的第三个请求必须走缓存命中。
    const [first, second] = await Promise.all([ensureVersion('3.11'), ensureVersion('3.11')]);
    expect(first).toBe(bin);
    expect(second).toBe(bin);
    expect(installCalls).toBe(1);
  });
});
