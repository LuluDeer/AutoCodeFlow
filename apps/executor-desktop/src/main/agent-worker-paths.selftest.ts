/**
 * N-06①/②：agent-worker 路径与环境解析守卫（纯函数）。
 *
 * 钉住三方契约（scripts/bundle-agent-worker.cjs / electron-builder.yml
 * extraResources / 本模块）的解析面：任何一方挪动落点而没同步这里，selftest
 * 即红。Run via: npm run test:main
 */

import * as assert from 'node:assert';
import * as path from 'node:path';
import {
  buildAgentWorkerSpawnEnv,
  resolveAgentBrowsersPath,
  resolveAgentWorkerEntry,
} from './agent-worker-paths';

function main(): void {
  // 期望值一律用 path.join 构造（与实现的平台语义一致）：本 selftest 钉的是
  // 「落点 = 契约段拼接」（agent-worker/dist/index.js 在 resourcesPath/appPath
  // 下），不是分隔符形态——win32 下 path.join 产出反斜杠，硬编码 '/' 会在
  // Windows runner 上假红（desktop-v1.8.0 出包实测）。
  // ── 打包态落点：resourcesPath/agent-worker/dist/index.js ────────────
  const packaged = resolveAgentWorkerEntry({
    isPackaged: true,
    resourcesPath: '/opt/App/resources',
    appPath: '/opt/App/resources/app.asar',
  });
  assert.strictEqual(packaged, path.join('/opt/App/resources', 'agent-worker', 'dist', 'index.js'));

  // ── dev 态落点：appPath/resources/agent-worker/dist/index.js ────────
  const dev = resolveAgentWorkerEntry({
    isPackaged: false,
    resourcesPath: '/repo/node_modules/electron/dist',
    appPath: '/repo/apps/executor-desktop',
  });
  assert.strictEqual(
    dev,
    path.join('/repo/apps/executor-desktop', 'resources', 'agent-worker', 'dist', 'index.js'),
  );

  // ── 浏览器目录：打包态且存在才解析，其余一律 null ────────────────────
  assert.strictEqual(
    resolveAgentBrowsersPath({ isPackaged: true, resourcesPath: '/r', appPath: '/a' }, () => true),
    path.join('/r', 'playwright'),
  );
  assert.strictEqual(
    // ACF_BUNDLE_PLAYWRIGHT=0 的本地打包：目录不存在 → null（不注入 env）
    resolveAgentBrowsersPath({ isPackaged: true, resourcesPath: '/r', appPath: '/a' }, () => false),
    null,
  );
  assert.strictEqual(
    // dev 态永不注入（沿用 playwright 默认缓存）
    resolveAgentBrowsersPath({ isPackaged: false, resourcesPath: '/r', appPath: '/a' }, () => true),
    null,
  );

  // ── spawn env：ELECTRON_RUN_AS_NODE 恒设；PLAYWRIGHT_BROWSERS_PATH 条件注入 ──
  const envWithBrowsers = buildAgentWorkerSpawnEnv(
    { isPackaged: true, resourcesPath: '/r', appPath: '/a' },
    { PATH: '/bin', HOME: '/home/x' },
    () => true,
  );
  assert.strictEqual(envWithBrowsers.ELECTRON_RUN_AS_NODE, '1');
  assert.strictEqual(envWithBrowsers.PLAYWRIGHT_BROWSERS_PATH, path.join('/r', 'playwright'));
  assert.strictEqual(envWithBrowsers.PATH, '/bin', '基础 env 必须透传');

  const envWithoutBrowsers = buildAgentWorkerSpawnEnv(
    { isPackaged: true, resourcesPath: '/r', appPath: '/a' },
    { PATH: '/bin' },
    () => false,
  );
  assert.strictEqual(envWithoutBrowsers.ELECTRON_RUN_AS_NODE, '1');
  assert.strictEqual(
    envWithoutBrowsers.PLAYWRIGHT_BROWSERS_PATH,
    undefined,
    '浏览器目录不存在时不得注入 PLAYWRIGHT_BROWSERS_PATH（会指向空目录，' +
      '让 dev 缓存里已装好的浏览器也变得不可用）',
  );

  const envDev = buildAgentWorkerSpawnEnv(
    { isPackaged: false, resourcesPath: '/r', appPath: '/a' },
    {},
    () => true,
  );
  assert.strictEqual(envDev.ELECTRON_RUN_AS_NODE, '1');
  assert.strictEqual(envDev.PLAYWRIGHT_BROWSERS_PATH, undefined);

  console.log('agent-worker-paths.selftest: all assertions passed');
}

main();
