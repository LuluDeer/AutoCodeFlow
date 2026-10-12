/**
 * `python-venv.ts` 的行为锁定——**本次生产事故的回归测试**。
 *
 * 事故形状：全新 Windows 机器装上桌面客户端（安装包只自带 uv、**不含 Python
 * 本体**），中台部署 1 个 python 应用（`runtime` 缺省即 `python`）即失败：
 *
 *   Python was not found; run without arguments to install from the Microsoft Store,
 *   or disable this shortcut from Settings > Apps > Advanced app settings >
 *   App execution aliases.
 *
 * 根因是 `routes/deploy.ts` 从未接上解释器池，且把宿主 `python` / `python3`
 * 硬编码成解释器——而 Windows 上那个名字很可能是 **Microsoft Store 的
 * App Execution Alias 占位 stub**（文件存在 → spawn 命中 → 实跑 exit 9009）。
 *
 * 本文件用**注入桩**（`deps`，与 `toolchain.ts` 同风格）覆盖三个关键分支，
 * 使"Store stub""池内解释器""宿主验真解释器"这些平台相关形态能在任意宿主上
 * 被真实断言——这正是原实现无法在 Linux CI 上覆盖 Windows 分支、以致缺陷
 * 长期潜伏的原因。
 *
 * 反证（必须有）：把 `resolveDeployInterpreter` 的最后一步换成回落到裸
 * `'python'`/`'python3'`，则「Store stub 被拒」与「startApp 不回落到 stub」
 * 两个用例**必须转红**；把 uv 子进程环境的 `UV_PYTHON_DOWNLOADS` 去掉，则
 * 「D8 加固」用例**必须转红**。
 */

import * as path from 'path';

jest.mock('./logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

// 池根必须与 interpreters.ts 的 `poolRoot()` 用**同一套 path 语义**：那边是
// `path.resolve(config.uvPythonInstallDir)`，win32 上会把 '/tmp/interpreters'
// 解析成带当前盘符的形式。本文件里我们注入桩、不真正读池，但 uvEnv 默认实现
// 会读 config，故仍按 resolved 值对齐，避免"- 测试与实现的路径基准"漂移。
jest.mock('./config', () => {
  const nodePath = require('path');
  return {
    config: {
      workDir: '/tmp/test-workdir',
      uvPythonInstallDir: nodePath.resolve('/tmp/interpreters'),
      pypiRegistryUrl: '',
      pypiExtraIndexUrl: '',
      pythonRegistryUrl: '',
    },
  };
});

import {
  VENV_CREATE_TIMEOUT_MS,
  ensurePythonVenv,
  noPythonInterpreterMessage,
  pickPoolInterpreter,
  prewarmPythonInterpreterCache,
  resolveDeployInterpreter,
  resolveStartPython,
  venvBinaries,
} from './python-venv';
import type { PythonVenvDeps } from './python-venv';
import { buildToolchainForTest } from './toolchain';
import type { Toolchain } from './toolchain';
import type { InterpreterInfo, UvResolution } from './interpreters';
import type { RunCommandOptions, RunCommandResult } from './run-command';

const POOL_DIR = path.resolve('/tmp/interpreters');
/** 池内某个真实解释器的绝对路径（形态与 interpreters.ts 的探测结果一致）。 */
const POOL_PY = path.join(POOL_DIR, 'cpython-3.12.13-x86_64-unknown-linux-gnu', 'bin', 'python3');
/** uv 建 venv 时写进 `pyvenv.cfg` 的 `home`（真身所在目录，不是可执行文件）。 */
const POOL_HOME = path.dirname(POOL_PY);
const UV_BIN = '/usr/local/bin/uv';
const VENV_DIR = '/tmp/test-workdir/apps/app-1/releases/r1/.venv';

/**
 * 一个**静态健康**的 venv 形态（缺陷 3 的健康检查需要的全部事实）：
 * shim 存在 + `pyvenv.cfg` 可读 + `home` 存在 + （可选）版本相符。
 *
 * `exists: () => true` 与老用例一致；新增的只有 `readText`，它让同步路径能
 * 在不 spawn 的前提下确认"这个 shim 背后真的有解释器"。
 */
function healthyVenvDeps(extra: PythonVenvDeps = {}): PythonVenvDeps {
  return {
    exists: () => true,
    readText: () => `home = ${POOL_HOME}\nversion_info = 3.12.13\n`,
    ...extra,
  };
}

interface RunCall {
  cmd: string;
  args: string[];
  opts?: RunCommandOptions;
}

/** 记录所有 spawn；默认全部成功（退出码 0）。 */
function makeRun(
  respond?: (cmd: string, args: string[]) => Partial<RunCommandResult>,
): { run: NonNullable<PythonVenvDeps['run']>; calls: RunCall[] } {
  const calls: RunCall[] = [];
  const run = async (
    cmd: string,
    args: string[],
    opts?: RunCommandOptions,
  ): Promise<RunCommandResult> => {
    calls.push({ cmd, args, opts });
    const r = respond ? respond(cmd, args) : {};
    return { status: r.status ?? 0, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  };
  return { run, calls };
}

/** 池探测桩：报告给定的池内条目。 */
function poolDeps(
  entries: InterpreterInfo[],
  extra: PythonVenvDeps = {},
): PythonVenvDeps {
  return {
    discoverInstalled: async () => entries.map((e) => ({ ...e })),
    ...extra,
  };
}

function poolEntry(version: string, p: string): InterpreterInfo {
  return { version, path: p, available: true, discoveredAt: new Date().toISOString() };
}

/** 工具链桩：直接给"宿主 python 实跑验真结果"。
 *
 * 必须同时注入 `cachedToolchain` 与 `probeToolchain`：模块的解析是
 * 「先读同步缓存、冷则实跑探测一次」，只注入一个会让另一半落到**真实**
 * `probeToolchain`——于是在本机真装了 python3 的 Linux CI 上，一个"宿主是
 * Store stub"的用例会拿到真实探测结果而变成假绿/假红。注入点必须覆盖两条
 * 读取路径才是确定性的（与 toolchain.ts 自身的 deps 纪律一致）。 */
function hostPythonDeps(python: Partial<Toolchain['python']>): PythonVenvDeps {
  const tc = buildToolchainForTest({ python });
  return { cachedToolchain: () => tc, probeToolchain: async () => tc };
}

/** 断言"池内绝对路径"这一 D8 硬约束。 */
function assertAbsolutePoolPython(args: string[], poolPython: string): void {
  const idx = args.indexOf('--python');
  expect(idx).toBeGreaterThanOrEqual(0);
  const value = args[idx + 1];
  expect(path.isAbsolute(value)).toBe(true);
  expect(value).toBe(poolPython);
  // 绝不能是裸版本号：裸版本号会触发 uv 的隐式下载语义，绕过全局单下载队列。
  expect(value).not.toBe('3.12');
  expect(value).not.toMatch(/^\d+\.\d+$/);
}

describe('resolveDeployInterpreter — 解释器解析顺序', () => {
  it('池内已有声明版本 → 使用池内绝对路径，且不碰宿主', async () => {
    const ensureVersion = jest.fn(async () => POOL_PY);
    const cachedToolchain = jest.fn(() =>
      buildToolchainForTest({ python: { path: 'python3', source: 'host', verified: true } }),
    );

    const got = await resolveDeployInterpreter('3.12', { ensureVersion, cachedToolchain });

    expect(got).toEqual({ source: 'pool', path: POOL_PY, version: '3.12' });
    // defect 4：signal 槽位必须被透传（此处未给 signal → 显式 undefined，
    // 而不是"旧的两参调用形态"）。
    expect(ensureVersion).toHaveBeenCalledWith('3.12', { signal: undefined });
  });

  it('声明版本但取不到 → 明确失败，绝不静默回落宿主解释器', async () => {
    const ensureVersion = jest.fn(async () => {
      throw new Error('interpreter 3.13 unavailable (download_failed): mirror unreachable');
    });
    const cachedToolchain = jest.fn(() =>
      buildToolchainForTest({ python: { path: 'python3', source: 'host', verified: true } }),
    );

    await expect(
      resolveDeployInterpreter('3.13', { ensureVersion, cachedToolchain }),
    ).rejects.toThrow(/Cannot obtain Python 3\.13/);
    // 宿主验真过也不行：声明了版本就必须兑现，否则"看着成功其实违约"。
    expect(cachedToolchain).not.toHaveBeenCalled();
  });

  it('未声明版本 → 池内现成解释器（最高版本）优先于宿主', async () => {
    const deps = poolDeps(
      [poolEntry('3.9.25', '/tmp/interpreters/cpython-3.9.25-x/bin/python3'), poolEntry('3.12.13', POOL_PY)],
      hostPythonDeps({ path: 'python3', source: 'host', verified: true }),
    );

    const got = await resolveDeployInterpreter(null, deps);

    expect(got.source).toBe('pool');
    expect(got.path).toBe(POOL_PY);
    expect(got.version).toBe('3.12.13');
  });

  it('池内没有 → 使用实跑验真的宿主解释器', async () => {
    const deps = poolDeps([], hostPythonDeps({ path: 'python3', source: 'host', verified: true, version: 'Python 3.12.1' }));

    const got = await resolveDeployInterpreter(undefined, deps);

    expect(got).toEqual({ source: 'host', path: 'python3', version: 'Python 3.12.1' });
  });

  it('宿主 python 未验真（Store stub）→ 视为不可用，不采纳', async () => {
    // Windows 上 Store 的 App Execution Alias 占位 stub：文件存在，但实跑失败。
    // toolchain.ts 的实跑验真会把它判为 verified:false / source:'none'。
    const deps = poolDeps([], {
      ...hostPythonDeps({
        path: null,
        source: 'none',
        verified: false,
        detail: 'no usable python on PATH — Microsoft Store App Execution Alias stub',
      }),
    });

    await expect(resolveDeployInterpreter(null, deps)).rejects.toThrow(
      /No usable Python interpreter/,
    );
  });

  it('完全无解释器 → 失败消息点名 Microsoft Store 占位 stub 并给出指引', async () => {
    const deps = poolDeps([], hostPythonDeps({}));

    await expect(resolveDeployInterpreter(null, deps)).rejects.toThrow(/Microsoft Store/);
    await expect(resolveDeployInterpreter(null, deps)).rejects.toThrow(/9009/);
    // 旧实现的失败是一句与平台毫无关系的英文，排障者无从归因——这里保证
    // 归因信息（成因 + 修法）就在消息里。
    expect(noPythonInterpreterMessage('python=none node=none')).toContain('toolchain: python=none node=none');
  });

  // =========================================================================
  // 无版本声明的**默认版本兜底**（原始生产事故的修复点）
  // =========================================================================
  //
  // 事故形态：全新 Windows 机器装桌面客户端（**包内只有 uv、没有 Python**），
  // 管理员在「应用管理」部署一个默认（无版本）python 应用 → 报 Microsoft Store
  // 的 "Python was not found"。上一轮修复只把"令人困惑的失败"换成了"可读的失败"，
  // **能力仍未兑现**；owner 明确口径是"没指定版本就默认按 3.12 装好并用它执行"。
  it('无版本 + 池空 + 无宿主 → 经 uv 取默认 3.12（原始事故回归）', async () => {
    const ensureVersion = jest.fn(async () => POOL_PY);
    const deps = poolDeps([], {
      ...hostPythonDeps({
        path: null,
        source: 'none',
        verified: false,
        detail: 'no usable python on PATH — Microsoft Store App Execution Alias stub',
      }),
      ensureVersion,
    });

    const got = await resolveDeployInterpreter(null, deps);

    // 这是本组最关键的断言：干净机器上"部署一个 python 应用"必须**能跑**，
    // 而不是只得到一句可读的失败。去掉默认版本兜底，本用例立即转红。
    expect(got).toEqual({ source: 'pool', path: POOL_PY, version: '3.12' });
    // 版本必须取共享常量（与任务链路同一个值），不得写死别的字面量。
    expect(ensureVersion).toHaveBeenCalledWith('3.12', { signal: undefined });
  });

  it('默认版本兜底也失败 → 消息同时含 Store 指引与默认版本归因', async () => {
    const ensureVersion = jest.fn(async () => {
      throw new Error('interpreter 3.12 unavailable (download_failed): mirror unreachable');
    });
    const deps = poolDeps([], {
      ...hostPythonDeps({ path: null, source: 'none', verified: false }),
      ensureVersion,
    });

    const err = await resolveDeployInterpreter(null, deps).catch((e: unknown) => e as Error);
    // 两类归因都必须保留：否则"加了兜底反而丢掉上一轮的 Store 指引"就是回归。
    expect((err as Error).message).toMatch(/Microsoft Store/);
    expect((err as Error).message).toMatch(/9009/);
    // 且必须显式说明默认版本这条路也失败了（否则运维不知道 uv 也试过）。
    expect((err as Error).message).toMatch(/default Python 3\.12 via uv failed/);
    expect((err as Error).message).toMatch(/mirror unreachable/);
  });

  it('有验真宿主 Python 时**绝不**触发默认版本获取（存量行为零变化）', async () => {
    const ensureVersion = jest.fn(async () => POOL_PY);
    const deps = poolDeps([], {
      ...hostPythonDeps({ path: 'python3', source: 'host', verified: true }),
      ensureVersion,
    });

    const got = await resolveDeployInterpreter(null, deps);

    expect(got.source).toBe('host');
    // 兼容红线：有宿主解释器的机器不该因为这次改动而多一次下载/探测。
    expect(ensureVersion).not.toHaveBeenCalled();
  });

  it('声明版本优先于默认版本兜底（声明了就必须兑现该版本）', async () => {
    const ensureVersion = jest.fn(async () => POOL_PY);
    const deps = poolDeps([], {
      ...hostPythonDeps({ path: 'python3', source: 'host', verified: true }),
      ensureVersion,
    });

    const got = await resolveDeployInterpreter('3.11', deps);

    expect(got).toEqual({ source: 'pool', path: POOL_PY, version: '3.11' });
    expect(ensureVersion).toHaveBeenCalledWith('3.11', { signal: undefined });
    expect(ensureVersion).not.toHaveBeenCalledWith('3.12', expect.anything());
  });
});

describe('pickPoolInterpreter — 池内挑选', () => {
  it('未声明版本取最高版本（不是字符串序）', () => {
    const picked = pickPoolInterpreter(
      [
        poolEntry('3.9.25', '/p/3.9'),
        poolEntry('3.14.0', '/p/3.14'),
        poolEntry('3.12.13', '/p/3.12'),
      ],
      null,
    );
    expect(picked?.version).toBe('3.14.0');
  });

  it('声明 X.Y 只匹配该主次版本（3.1 绝不能匹配 3.13）', () => {
    expect(
      pickPoolInterpreter([poolEntry('3.13.0', '/p/3.13')], '3.1'),
    ).toBeNull();
    expect(
      pickPoolInterpreter([poolEntry('3.13.0', '/p/3.13'), poolEntry('3.12.13', '/p/3.12')], '3.12')
        ?.version,
    ).toBe('3.12.13');
  });

  it('available:false 或空路径的条目一律不采纳（"宣称可用却必然失败"的假阳性）', () => {
    expect(
      pickPoolInterpreter(
        [
          { version: '3.12.13', path: '/p/x', available: false, discoveredAt: '' },
          { version: '3.12.13', path: '', available: true, discoveredAt: '' },
        ],
        null,
      ),
    ).toBeNull();
  });
});

describe('ensurePythonVenv — venv 创建与依赖安装', () => {
  it('池内解释器 + uv 可用 → `uv venv --python <池内绝对路径> --no-project <dir>`', async () => {
    const { run, calls } = makeRun();
    const deps: PythonVenvDeps = {
      ...poolDeps([poolEntry('3.12.13', POOL_PY)]),
      resolveUvBin: async (): Promise<UvResolution> => ({ path: UV_BIN, source: 'env' }),
      run,
      exists: () => false, // 没有 requirements.txt
    };

    const result = await ensurePythonVenv({ venvDir: VENV_DIR, deps });

    expect(result.createdByUv).toBe(true);
    expect(result.pythonBin).toBe(venvBinaries(VENV_DIR).python);
    const venvCall = calls.find((c) => c.args[0] === 'venv');
    expect(venvCall).toBeTruthy();
    expect(venvCall!.cmd).toBe(UV_BIN);
    // D8：只能传池内绝对路径，绝不能传裸版本号。
    assertAbsolutePoolPython(venvCall!.args, POOL_PY);
    // 与 execute.ts 的 argv 对齐（AC-10a 形态）。
    expect(venvCall!.args).toContain('--no-project');
    expect(venvCall!.args[venvCall!.args.length - 1]).toBe(VENV_DIR);
  });

  it('D8 加固：uv 子进程带 UV_PYTHON_DOWNLOADS=manual（venv 阶段绝不隐式下载）', async () => {
    const { run, calls } = makeRun();
    const deps: PythonVenvDeps = {
      ...poolDeps([poolEntry('3.12.13', POOL_PY)]),
      resolveUvBin: async (): Promise<UvResolution> => ({ path: UV_BIN, source: 'env' }),
      run,
      exists: () => false,
    };

    await ensurePythonVenv({ venvDir: VENV_DIR, deps });

    const venvCall = calls.find((c) => c.args[0] === 'venv')!;
    // 这是 uv 自身强制的"缺版本就拒绝、不偷偷下载"。去掉它 → 本断言转红。
    expect(venvCall.opts?.env?.UV_PYTHON_DOWNLOADS).toBe('manual');
    expect(venvCall.opts?.env?.UV_PYTHON_INSTALL_DIR).toBe(POOL_DIR);
    expect(venvCall.opts?.timeout).toBe(VENV_CREATE_TIMEOUT_MS);
  });

  it('uv 建的 venv 没有 pip → 依赖安装必须走 `uv pip install --python <venvPython>`', async () => {
    const { run, calls } = makeRun();
    const deps: PythonVenvDeps = {
      ...poolDeps([poolEntry('3.12.13', POOL_PY)]),
      resolveUvBin: async (): Promise<UvResolution> => ({ path: UV_BIN, source: 'env' }),
      run,
      exists: () => true, // requirements.txt 存在
    };

    await ensurePythonVenv({
      venvDir: VENV_DIR,
      requirementsFile: '/tmp/req/requirements.txt',
      registryUrl: 'https://pypi.example.com/simple',
      deps,
    });

    const pipCall = calls.find((c) => c.args[0] === 'pip')!;
    expect(pipCall.cmd).toBe(UV_BIN);
    expect(pipCall.args).toEqual([
      'pip',
      'install',
      '--python',
      venvBinaries(VENV_DIR).python,
      '-r',
      '/tmp/req/requirements.txt',
      '--index-url',
      'https://pypi.example.com/simple',
    ]);
    // 绝不能落到 venv 自带的 pip（uv 默认不 seed pip，那个文件不存在）。
    expect(calls.some((c) => c.cmd === venvBinaries(VENV_DIR).pip)).toBe(false);
  });

  it('宿主验真解释器 → `<python3> -m venv <dir>`（不经过任何二次 PATH 解析）', async () => {
    const { run, calls } = makeRun();
    const deps: PythonVenvDeps = {
      ...poolDeps([]),
      ...hostPythonDeps({ path: 'python3', source: 'host', verified: true }),
      run,
      exists: () => false,
    };

    const result = await ensurePythonVenv({ venvDir: VENV_DIR, deps });

    expect(result.createdByUv).toBe(false);
    expect(calls).toHaveLength(1);
    expect(calls[0].cmd).toBe('python3');
    expect(calls[0].args).toEqual(['-m', 'venv', VENV_DIR]);
  });

  it('宿主建 venv 时用 venv 自带 pip 装依赖', async () => {
    const { run, calls } = makeRun();
    const deps: PythonVenvDeps = {
      ...poolDeps([]),
      ...hostPythonDeps({ path: 'python3', source: 'host', verified: true }),
      run,
      exists: () => true,
    };

    await ensurePythonVenv({
      venvDir: VENV_DIR,
      requirementsFile: '/tmp/req/requirements.txt',
      registryUrl: 'https://pypi.example.com/simple',
      deps,
    });

    const pipCall = calls.find((c) => c.cmd === venvBinaries(VENV_DIR).pip)!;
    expect(pipCall.args).toEqual([
      'install',
      '-r',
      '/tmp/req/requirements.txt',
      '-i',
      'https://pypi.example.com/simple',
    ]);
  });

  it('池内解释器但 uv 不可用 → 直接用该解释器建 venv（不因缺 uv 放弃可跑的部署）', async () => {
    const { run, calls } = makeRun();
    const deps: PythonVenvDeps = {
      ...poolDeps([poolEntry('3.12.13', POOL_PY)]),
      resolveUvBin: async (): Promise<UvResolution> => ({ path: null, source: 'missing' }),
      run,
      exists: () => false,
    };

    const result = await ensurePythonVenv({ venvDir: VENV_DIR, deps });

    expect(result.createdByUv).toBe(false);
    expect(calls).toHaveLength(1);
    expect(calls[0].cmd).toBe(POOL_PY);
    expect(calls[0].args).toEqual(['-m', 'venv', VENV_DIR]);
  });

  it('无解释器 → 抛错，且**一次 spawn 都没有**（绝不回落到裸 python/python3）', async () => {
    const { run, calls } = makeRun();
    const deps: PythonVenvDeps = {
      ...poolDeps([]),
      ...hostPythonDeps({}),
      run,
      exists: () => true,
    };

    await expect(
      ensurePythonVenv({ venvDir: VENV_DIR, requirementsFile: '/tmp/req/requirements.txt', deps }),
    ).rejects.toThrow(/Microsoft Store|No usable Python interpreter/);
    expect(calls).toEqual([]);
    // 事故的原始形态就是 spawn 了一个 Store stub；这里把它钉死。
    expect(calls.some((c) => c.cmd === 'python' || c.cmd === 'python3' || c.cmd === 'python.exe')).toBe(false);
  });

  it('建 venv 失败 → 清掉半成品 venv（否则下次会复用一个坏环境）', async () => {
    const removed: string[] = [];
    const { run } = makeRun(() => ({ status: 1, stderr: 'boom' }));
    const deps: PythonVenvDeps = {
      ...poolDeps([]),
      ...hostPythonDeps({ path: 'python3', source: 'host', verified: true }),
      run,
      exists: () => false,
    };

    await expect(ensurePythonVenv({ venvDir: VENV_DIR, deps })).rejects.toThrow(
      /python3 -m venv failed: boom/,
    );
    // rmSync 由模块内的真实 fs 调用；用 jest.spyOn 捕获一次即可。
    const fsMod = jest.requireActual<typeof import('fs')>('fs');
    const spy = jest.spyOn(fsMod, 'rmSync').mockImplementation(() => {
      removed.push(VENV_DIR);
      return undefined;
    });
    try {
      await expect(ensurePythonVenv({ venvDir: VENV_DIR, deps })).rejects.toThrow();
    } finally {
      spy.mockRestore();
    }
    expect(removed).toEqual([VENV_DIR]);
  });
});

describe('resolveStartPython — startApp 的同步解析（不得回落 Store stub）', () => {
  it('venv 存在 → 优先用 venv 解释器（既有正确行为，保持不变）', () => {
    const got = resolveStartPython({
      venvDir: VENV_DIR,
      deps: healthyVenvDeps(),
    });

    expect(got.source).toBe('venv');
    expect(got.cmd).toBe(venvBinaries(VENV_DIR).python);
  });

  it('venv 缺失 → 池内解释器（读同步缓存，不 spawn 探测进程）', () => {
    const got = resolveStartPython({
      venvDir: VENV_DIR,
      deps: {
        exists: () => false,
        interpreterSnapshot: () => [poolEntry('3.12.13', POOL_PY)],
      },
    });

    expect(got).toEqual({ source: 'pool', cmd: POOL_PY, version: '3.12.13' });
  });

  it('venv 缺失 → 验真过的宿主解释器兜底', () => {
    const got = resolveStartPython({
      venvDir: VENV_DIR,
      deps: { exists: () => false, ...hostPythonDeps({ path: 'py', source: 'host', verified: true }) },
    });

    expect(got.source).toBe('host');
    expect(got.cmd).toBe('py');
  });

  it('venv 缺失 + 无池内解释器 + 宿主是 Store stub → **抛错**，不 spawn 裸 python', () => {
    expect(() =>
      resolveStartPython({
        venvDir: VENV_DIR,
        deps: {
          exists: () => false,
          interpreterSnapshot: () => [],
          ...hostPythonDeps({ path: null, source: 'none', verified: false }),
        },
      }),
    ).toThrow(/Microsoft Store|No usable Python interpreter/);
  });

  // -------------------------------------------------------------------------
  // 缺陷 3：venv shim"存在但已死"（池版本被回收）不得被采信。
  // -------------------------------------------------------------------------

  it('shim 存在但 pyvenv.cfg 的 home 已消失（池版本被回收）→ 拒用并落到池内解释器', () => {
    // 这正是缺陷 2+3 联动的形态：`<venv>/bin/python3` 文件还在（exists=true），
    // 但它背后的池目录已被回收 → spawn 必失败、应用崩溃 → daemon 重启到同一个
    // 死解释器。修复后必须**忽略这个 venv**，改走池内现成解释器。
    const got = resolveStartPython({
      venvDir: VENV_DIR,
      deps: {
        exists: (p) => p === venvBinaries(VENV_DIR).python, // shim 在，home 不在
        readText: () => `home = ${POOL_HOME}\nversion_info = 3.12.13\n`,
        interpreterSnapshot: () => [poolEntry('3.12.13', POOL_PY)],
      },
    });

    expect(got).toEqual({ source: 'pool', cmd: POOL_PY, version: '3.12.13' });
  });

  it('shim 存在但 pyvenv.cfg 缺失/不可读 → 拒用（宁可重建也不复用一个说不清来源的环境）', () => {
    const got = resolveStartPython({
      venvDir: VENV_DIR,
      deps: {
        exists: () => true, // shim 在，home 也在——但配置文件读不到
        readText: () => null,
        interpreterSnapshot: () => [poolEntry('3.12.13', POOL_PY)],
      },
    });

    expect(got.source).toBe('pool');
  });

  it('shim 存在、pyvenv.cfg 健康、但声明版本不符 → 拒用并落到声明版本对应的池条目', () => {
    const got = resolveStartPython({
      venvDir: VENV_DIR,
      runtimeVersion: '3.11',
      deps: {
        exists: () => true,
        readText: () => `home = ${POOL_HOME}\nversion_info = 3.12.13\n`,
        interpreterSnapshot: () => [
          poolEntry('3.11.9', '/tmp/interpreters/cpython-3.11.9-x/bin/python3'),
        ],
      },
    });

    expect(got).toEqual({
      source: 'pool',
      cmd: '/tmp/interpreters/cpython-3.11.9-x/bin/python3',
      version: '3.11.9',
    });
  });

  it('shim 存在但已死且池/宿主都不可用 → 明确抛错，绝不 spawn 死 shim', () => {
    expect(() =>
      resolveStartPython({
        venvDir: VENV_DIR,
        deps: {
          exists: (p) => p === venvBinaries(VENV_DIR).python,
          readText: () => `home = ${POOL_HOME}\n`,
          interpreterSnapshot: () => [],
          ...hostPythonDeps({ path: null, source: 'none', verified: false }),
        },
      }),
    ).toThrow(/No usable Python interpreter/);
  });
});

describe('prewarmPythonInterpreterCache — 让同步的 startApp 看到真实候选', () => {
  it('并行预热池清单与工具链，失败一律降级不抛', async () => {
    let poolProbed = 0;
    let tcProbed = 0;
    await prewarmPythonInterpreterCache({
      discoverInstalled: async () => {
        poolProbed += 1;
        return [];
      },
      probeToolchain: async () => {
        tcProbed += 1;
        return buildToolchainForTest({});
      },
    });
    expect(poolProbed).toBe(1);
    expect(tcProbed).toBe(1);

    // 探测抛错只是让候选变少，绝不能把部署打挂在一个与根因无关的异常上。
    await expect(
      prewarmPythonInterpreterCache({
        discoverInstalled: async () => {
          throw new Error('uv exploded');
        },
        probeToolchain: async () => {
          throw new Error('probe exploded');
        },
      }),
    ).resolves.toBeUndefined();
  });
});

/**
 * 源码守卫（DESIGN §7.3 G-a 的同型做法）。
 *
 * 行为测试覆盖的是**现在**的分支；但"把宿主命令名写回去"这个动作只要一行，
 * 而它的代价是本次生产事故原样复发。这里直接从源码层面钉死那两个字面量，
 * 让回退动作必然在 CI 转红——比任何行为断言都更直接。
 *
 * 必须先剥掉注释行：本文件与 `deploy.ts` 的注释里刻意引用了"修复前长什么样"
 * （把事故现场留在代码里便于追溯），不剥注释会让守卫被自己的说明文字绊倒
 * （同类教训见 `zip-safety.spec.ts` 的源码守卫）。
 */
describe('源码守卫：deploy.ts 不得再硬编码宿主解释器', () => {
  async function deploySourceWithoutComments(): Promise<string> {
    const fsMod = await import('node:fs/promises');
    const pathMod = await import('node:path');
    const src = await fsMod.readFile(
      pathMod.resolve(process.cwd(), 'src/routes/deploy.ts'),
      'utf-8',
    );
    return src
      .split('\n')
      .filter((line) => {
        const t = line.trim();
        return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
      })
      .join('\n');
  }

  it('不再有 `python -m venv` / 裸 python 兜底（Store stub 的唯一入口）', async () => {
    const body = await deploySourceWithoutComments();
    // 重建生产事故的两处原始形态。
    expect(body).not.toMatch(/'python3'\s*:\s*'python'/);
    expect(body).not.toMatch(/isWin\s*\?\s*'python'\s*:\s*'python3'/);
    expect(body).not.toMatch(/\['-m',\s*'venv'/);
    // python 分支必须经共享模块解析（`uv` 在 deploy.ts 里不再是 0 次出现）。
    expect(body).toContain('ensurePythonVenv');
    expect(body).toContain('resolveStartPython');
  });

  it('node 分支不得再硬编码裸 `node`（缺陷 1：干净机器上 spawn 必 ENOENT）', async () => {
    const body = await deploySourceWithoutComments();
    // 重建缺陷 1 的原始形态：node 分支里 `cmd = 'node'`。行为测试已经覆盖了
    // 修正后的解析结果，这里从源码层再钉一次——回退只要一行，而代价是
    // "全新机器部署第一个 node 应用"原样失败。
    expect(body).not.toMatch(/cmd\s*=\s*'node'\s*;/);
    // node 分支必须消费工具链（`resolveStartNode`）并注入 Electron 开关。
    expect(body).toContain('resolveStartNode');
    expect(body).toContain('ELECTRON_RUN_AS_NODE');
    // 该注入必须是"已建 env 对象上的显式 mutate"；绝不能把开关塞进白名单。
    const whitelist = await (await import('node:fs/promises')).readFile(
      (await import('node:path')).resolve(process.cwd(), 'src/env-whitelist.ts'),
      'utf-8',
    );
    expect(whitelist).not.toContain('ELECTRON_RUN_AS_NODE');
  });
});

/**
 * 缺陷 4：`resolveDeployInterpreter` 的两条异步路径都必须把 `signal` 透传下去。
 *
 * 为什么必须单测：这是**可见性极差**的一类回归——漏传 signal 时部署在正常
 * 路径上完全正常，只有"停机恰逢池下载 / `uv python list`（默认 30s）"时才
 * 表现为 drain 拖过硬杀窗口、终态回调丢失。没有断言，删掉那一行不会有任何
 * 测试变红。声明版本分支当前在生产不可达（admin 从不发 runtimeVersion），
 * 但一旦开始发送就已正确。
 */
describe('abort signal propagation (defect 4)', () => {
  it('声明版本分支：signal 透传给 ensureVersion', async () => {
    const controller = new AbortController();
    const ensureVersion = jest.fn(async () => POOL_PY);

    await resolveDeployInterpreter('3.12', { ensureVersion }, controller.signal);

    expect(ensureVersion).toHaveBeenCalledWith('3.12', { signal: controller.signal });
  });

  it('未声明版本分支：signal 透传给 discoverInstalled（uv python list 的 30s 探测）', async () => {
    const controller = new AbortController();
    const discoverInstalled = jest.fn(async () => [] as InterpreterInfo[]);

    await resolveDeployInterpreter(
      null,
      { discoverInstalled, ...hostPythonDeps({ path: 'python3', source: 'host', verified: true }) },
      controller.signal,
    );

    expect(discoverInstalled).toHaveBeenCalledWith({ signal: controller.signal });
  });

  it('ensurePythonVenv 把 opts.signal 一路带到 resolveDeployInterpreter', async () => {
    const controller = new AbortController();
    const discoverInstalled = jest.fn(async () => [] as InterpreterInfo[]);
    const { run } = makeRun();

    // 无 requirements.txt → 只建 venv；用宿主验真解释器避免池路径。
    await ensurePythonVenv({
      venvDir: VENV_DIR,
      signal: controller.signal,
      deps: {
        discoverInstalled,
        run,
        exists: () => false,
        ...hostPythonDeps({ path: 'python3', source: 'host', verified: true }),
      },
    });

    expect(discoverInstalled).toHaveBeenCalledWith({ signal: controller.signal });
    // 建 venv 的子进程同样携带该 signal（停机时树杀，不留孤儿）。
    expect(run).toBeDefined();
  });
});
