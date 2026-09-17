/**
 * python_task_multiversion self-check for the desktop executor's uv wiring.
 * Run via: npm run test:main
 *
 * 覆盖的都是"客户端执行器与 python 执行器功能对等"的必要条件，且每一条都
 * 对应一个**曾经容易写错、错了却很难发现**的点：
 *   1. 池目录默认落点必须在 userData（安装目录只读，放那里 uv 必然写失败）；
 *   2. 显式配置优先，空白串视为未配置（用户清空输入框的场景）；
 *   3. 没自带 uv 时返回 null 而**不抛**（缺 uv 是降级，不是致命错误）；
 *   4. `UV_PYTHON_DOWNLOADS=manual` 必须始终下发（D8：venv 阶段绝不隐式下载）；
 *   5. 空值不得写成空串环境变量（否则会覆盖掉用户在系统里配的值）。
 */
import * as assert from 'node:assert';
import {
  buildUvChildEnv,
  resolveBundledUvPath,
  resolveInterpretersDir,
  uvExecutableName,
  type UvPathInputs,
} from './uv-paths';

function inputs(overrides: Partial<UvPathInputs> = {}): UvPathInputs {
  return {
    isPackaged: false,
    resourcesPath: '/app/resources',
    appPath: '/repo/apps/executor-desktop',
    userDataDir: '/home/u/.config/AutoCodeFlow',
    platform: 'linux',
    existsFile: () => false,
    ...overrides,
  };
}

function main(): void {
  // ---- 1. uv 可执行文件名随平台 ----
  assert.strictEqual(uvExecutableName('win32'), 'uv.exe');
  assert.strictEqual(uvExecutableName('linux'), 'uv');
  assert.strictEqual(uvExecutableName('darwin'), 'uv');

  // ---- 2. 池目录：显式配置优先；空白串视为未配置 ----
  assert.strictEqual(
    resolveInterpretersDir('/data/acf/interpreters', '/home/u/.config/ACF'),
    '/data/acf/interpreters',
    '显式配置必须原样采用',
  );
  for (const blank of ['', '   ', undefined, null]) {
    assert.strictEqual(
      resolveInterpretersDir(blank as any, '/home/u/.config/ACF'),
      '/home/u/.config/ACF/interpreters',
      `${JSON.stringify(blank)} 必须回退到 userData 默认`,
    );
  }
  // 关键：默认落点不得在安装目录（Program Files 只读）。
  const win = resolveInterpretersDir('', 'C:\\Users\\u\\AppData\\Roaming\\AutoCodeFlow');
  assert.ok(
    win.endsWith('interpreters'),
    `Windows 默认池目录应以 interpreters 结尾，实际 ${win}`,
  );

  // ---- 3. 自带 uv 探测：找不到返回 null 且不抛 ----
  assert.strictEqual(
    resolveBundledUvPath(inputs({ existsFile: () => false })),
    null,
    '没有自带 uv 时必须返回 null',
  );
  // 打包态优先看 resourcesPath/uv/<bin>
  let seen: string[] = [];
  const packaged = resolveBundledUvPath(
    inputs({
      isPackaged: true,
      resourcesPath: '/opt/app/resources',
      platform: 'win32',
      existsFile: (c) => {
        seen.push(c);
        return c === '/opt/app/resources\\uv\\uv.exe' || c === '/opt/app/resources/uv/uv.exe';
      },
    }),
  );
  assert.ok(packaged, `打包态应找到自带 uv，探测过的候选：${seen.join(' | ')}`);
  assert.ok(/uv(\.exe)?$/.test(packaged!), `必须指向 uv 可执行文件，实际 ${packaged}`);
  assert.ok(seen.some((c) => c.includes('resources')), '打包态必须探测 resourcesPath 下的 uv');

  // 开发态：appPath/resources/uv/<bin>
  const dev = resolveBundledUvPath(
    inputs({
      isPackaged: false,
      appPath: '/repo/apps/executor-desktop',
      existsFile: (c) => c === '/repo/apps/executor-desktop/resources/uv/uv',
    }),
  );
  assert.strictEqual(dev, '/repo/apps/executor-desktop/resources/uv/uv');

  // 存在性判定抛异常时不得冒泡（坏符号链接/权限不足）。
  assert.strictEqual(
    resolveBundledUvPath(
      inputs({
        existsFile: () => {
          throw new Error('EACCES');
        },
      }),
    ),
    null,
    'existsFile 抛异常时必须吞掉并返回 null，绝不冒泡',
  );

  // ---- 4. 子进程环境：manual 恒定下发 ----
  const env = buildUvChildEnv({
    uvBin: '/opt/app/resources/uv/uv',
    interpretersDir: '/home/u/.config/ACF/interpreters',
  });
  assert.strictEqual(
    env.UV_PYTHON_DOWNLOADS,
    'manual',
    'D8：UV_PYTHON_DOWNLOADS=manual 必须始终下发（venv 阶段绝不隐式下载）',
  );
  assert.strictEqual(env.UV_PYTHON_INSTALL_DIR, '/home/u/.config/ACF/interpreters');
  assert.strictEqual(env.UV_BIN, '/opt/app/resources/uv/uv');

  // ---- 5. 空值不得写成空串环境变量 ----
  const sparse = buildUvChildEnv({
    uvBin: null,
    interpretersDir: '/pool',
    mirror: '   ',
    pypiRegistryUrl: '',
    downloadTimeoutMs: 0,
  });
  assert.ok(
    !('UV_BIN' in sparse),
    'uvBin 为 null 时不得写 UV_BIN（让 executor-node 走 PATH 兜底）',
  );
  assert.ok(!('UV_PYTHON_INSTALL_MIRROR' in sparse), '空白 mirror 不得写环境变量');
  assert.ok(!('PYPI_REGISTRY_URL' in sparse), '空 registry 不得写环境变量');
  assert.ok(
    !('INTERPRETER_DOWNLOAD_TIMEOUT_MS' in sparse),
    '0/缺省超时不得写环境变量',
  );

  // 有值时才写。
  const full = buildUvChildEnv({
    uvBin: '/uv',
    interpretersDir: '/pool',
    mirror: 'https://mirror.internal/uv',
    pypiRegistryUrl: 'https://pypi.internal/simple',
    downloadTimeoutMs: 300000,
  });
  assert.strictEqual(full.UV_PYTHON_INSTALL_MIRROR, 'https://mirror.internal/uv');
  assert.strictEqual(full.PYPI_REGISTRY_URL, 'https://pypi.internal/simple');
  assert.strictEqual(full.INTERPRETER_DOWNLOAD_TIMEOUT_MS, '300000');

  console.log('[selftest] desktop uv wiring: OK');
  console.log(`[selftest]   default interpreters dir: ${resolveInterpretersDir('', '/home/u/.config/ACF')}`);
}

main();
