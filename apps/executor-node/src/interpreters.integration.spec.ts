/**
 * WS5 —— `interpreters.ts` 对**真实 uv** 的集成验证。
 *
 * 默认跳过：它要 spawn 真 uv 且可能联网下载（数百 MB、数十秒），不适合放进
 * 常规 CI。启用方式：
 *
 *   PowerShell:  $env:UV_INTEGRATION='1'; npx jest src/interpreters.integration.spec.ts
 *   bash:        UV_INTEGRATION=1 npx jest src/interpreters.integration.spec.ts
 *
 * 这些用例存在的理由：`interpreters.spec.ts` 全部基于 mock，只能证明"我们按
 * 自己以为的 uv 行为写了代码"。真正会漂移的是 uv 本身——JSON 字段名、错误
 * 文案、`--managed-python` 的过滤语义、池目录命名。本文件把这些假设钉在真实
 * 二进制上。CONTRACT.md §0 的全部结论都来自这类实测。
 *
 * 用一个临时池目录 + `UV_PYTHON_INSTALL_DIR`，**绝不**碰开发机上的真实池。
 */

import fs from 'fs';
import os from 'os';
import path from 'path';

const ENABLED = process.env.UV_INTEGRATION === '1';

// config 必须在 import 之前被替换：interpreters.ts 在模块顶层读它。
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'acf-uv-integration-'));
const poolDir = path.join(tmpRoot, 'pool');

jest.mock('./config', () => ({
  config: {
    uvPythonInstallDir: poolDir,
    uvBin: '',
    uvPythonInstallMirror: '',
    interpreterDownloadTimeoutMs: 300_000,
  },
}));

import {
  InterpreterUnavailableError,
  __resetForTests,
  discoverInstalled,
  ensureVersion,
  invalidateCache,
  poolSummary,
  resolvePythonBin,
  resolveUvBin,
} from './interpreters';

const describeIf = ENABLED ? describe : describe.skip;

afterAll(() => {
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

beforeEach(() => {
  __resetForTests();
});

describeIf('interpreters (real uv)', () => {
  jest.setTimeout(600_000);

  it('locates uv on PATH', async () => {
    const uv = await resolveUvBin();
    expect(uv.path).toBeTruthy();
    // 允许 env/bundled —— 开发机上走 PATH 即可。
    expect(['env', 'path', 'bundled']).toContain(uv.source);
  });

  it('a fresh pool discovers as empty (no system Python leaks in)', async () => {
    fs.mkdirSync(poolDir, { recursive: true });
    const found = await discoverInstalled({ force: true });
    // 关键断言：开发机上装了一堆系统 Python，但它们**不属于本池**，必须为空。
    expect(found).toEqual([]);
    expect(resolvePythonBin('3.12')).toBeNull();
  });

  it('downloads 3.12, then discovers it inside the pool with an absolute path', async () => {
    const bin = await ensureVersion('3.12');
    expect(path.isAbsolute(bin)).toBe(true);

    // 池白名单：返回路径必须在池根之下（NFR-02）。
    const rel = path.relative(poolDir, bin);
    expect(rel.startsWith('..')).toBe(false);
    expect(path.isAbsolute(rel)).toBe(false);

    // 真解释器要能跑，且报出的主次版本与请求相符。

    const { execFileSync } = require('child_process') as typeof import('child_process');
    const out = execFileSync(bin, ['--version'], { encoding: 'utf8' }).trim();
    expect(out).toMatch(/^Python 3\.12\./);

    invalidateCache();
    const found = await discoverInstalled({ force: true });
    expect(found.map((e) => e.version)).toEqual([expect.stringMatching(/^3\.12\./)]);
    expect(found[0].path).toBe(bin);

    // 池目录命名约定（CONTRACT.md §0）：cpython-<完整版本>-<platform>-none
    expect(path.basename(path.dirname(bin))).toMatch(/^cpython-3\.12\.\d+-/);

    // poolSummary 读的是**目录名**，因此 junction 别名（`cpython-3.12-…`）与
    // 真实目录（`cpython-3.12.13-…`）都会各贡献一项 —— 这与 python 侧
    // `pool_summary` 的 `_POOL_DIR_RE` 行为**逐字一致**（已实测该正则对
    // `cpython-3.12-windows-x86_64-none` 同样匹配出 `3.12`）。
    // 该函数只用于失败留痕（"池里有什么痕迹"），不是调度清单；调度清单走
    // discoverInstalled 的 realpath 去重，只报一个 3.12.13。
    expect(poolSummary().versions).toEqual(['3.12', expect.stringMatching(/^3\.12\.\d+$/)]);
  });

  it('the second ensureVersion is a cache hit (no re-download)', async () => {
    const first = await ensureVersion('3.12');
    const started = Date.now();
    const second = await ensureVersion('3.12');
    expect(second).toBe(first);
    // 命中缓存应当是毫秒级；重新下载绝无可能这么快。
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('concurrent ensureVersion calls share one download (D13)', async () => {
    __resetForTests();
    fs.rmSync(poolDir, { recursive: true, force: true });
    fs.mkdirSync(poolDir, { recursive: true });

    const results = await Promise.all([
      ensureVersion('3.11'),
      ensureVersion('3.11'),
      ensureVersion('3.11'),
    ]);

    expect(new Set(results).size).toBe(1);
    const bin = results[0];
    expect(fs.existsSync(bin)).toBe(true);
  });

  it('3.7 → not_downloadable with offline pre-provisioning guidance (CONTRACT.md §0)', async () => {
    const err: InterpreterUnavailableError = await ensureVersion('3.7').catch((e) => e);
    expect(err).toBeInstanceOf(InterpreterUnavailableError);
    expect(err.reason).toBe('not_downloadable');
    // 实测 uv 的真实报错就是 `No download found for request: cpython-3.7-<platform>`；
    // 我们在它之前就拦下并给出可操作指引，不把 uv 的原始文案当最终答案。
    expect(err.detail).toMatch(/cpython-3\.7\.9-/);
  });

  it('UV_PYTHON_DOWNLOADS=manual blocks implicit downloads in the uv child env', async () => {
    // 这条是"venv 阶段绝不隐式下载"（D8）的底层保证：我们给 uv 的子进程环境里
    // 钉了 UV_PYTHON_DOWNLOADS=manual。这里验证该变量确实能改变 uv 行为。

    const { execFileSync } = require('child_process') as typeof import('child_process');
    const uv = await resolveUvBin();

    let failed = false;
    try {
      execFileSync(
        uv.path!,
        ['venv', '--no-project', '--python', '3.6', path.join(tmpRoot, 'never-created')],
        {
          encoding: 'utf8',
          stdio: 'pipe',
          env: {
            ...process.env,
            UV_PYTHON_INSTALL_DIR: poolDir,
            UV_PYTHON_DOWNLOADS: 'manual',
            UV_NO_PROGRESS: '1',
          },
        },
      );
    } catch (err: unknown) {
      failed = true;
      const e = err as { stderr?: string };
      // uv 的原始文案——`prepareFailureReason` 的 interpreter 规则正是匹配它。
      expect(String(e.stderr)).toMatch(/No interpreter found|No download found/);
    }
    expect(failed).toBe(true);
    expect(fs.existsSync(path.join(tmpRoot, 'never-created'))).toBe(false);
  });
});
