#!/usr/bin/env node
// N-06①/②：把 agent-worker（Agent 托管子进程）打成独立单文件 bundle。
//
// 为什么用 esbuild 而不是 ncc（executor-node 的 bundle-executor.sh 形态）：
// playwright-core 的 Electron 启动器链（lib/server/electron/loader.ts 的 init
// 块含 chromiumSwitches，chromium.launch 即触发）在模块顶层 require("electron")
// 并访问 electron.app——ncc 0.45 无法把该模块映射到本地 stub（CLI 无 alias，
// API 的 externals 对 ncc 内部 relocate-loader 处理过的 node_modules 深层
// require 不生效，实测见 N-06 侦察记录），会把 electron 二进制（~223MB）拖进
// bundle；esbuild 的 --alias 原生支持，electron 在解析层就被替换为 stub，
// 资产零进入。esbuild 产物确定性同 ncc（同输入同输出），sha 闸同构。
//
// 产物布局（resources/agent-worker/，打包后为 <resourcesPath>/agent-worker/）：
//   dist/index.js          esbuild 单文件（CJS，playwright-core 内联、electron stub 内联）
//   dist/index.js.map
//   package.json           ← 复制自 playwright-core（运行时 packageRoot 契约）
//   browsers.json          ← 复制自 playwright-core（同上）
//
// 运行时契约（实测于 playwright-core 1.63.0 coreBundle.js）：
//   packageRoot = path.join(__dirname, "..")            // __dirname = dist/
//   require(path.join(packageRoot, "browsers.json"))     // 动态 require，打包器打不进
//   require(path.join(packageRoot, "package.json"))
// 即 bundle 必须放在 <X>/dist/，两个 JSON 在 <X>/——脚本据此布局并自检。
'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const DESKTOP = path.resolve(__dirname, '..');
const ENTRY = path.join(DESKTOP, 'src', 'agent-worker', 'main.ts');
const STAGE = path.join(DESKTOP, 'resources', 'agent-worker');
const ESBUILD = path.join(DESKTOP, 'node_modules', '.bin', 'esbuild');
const PW_CORE = path.join(DESKTOP, 'node_modules', 'playwright-core');

function main() {
  if (!fs.existsSync(ENTRY)) {
    console.error(`[bundle-agent-worker] entry missing: ${ENTRY}`);
    process.exit(1);
  }
  for (const f of ['browsers.json', 'package.json']) {
    if (!fs.existsSync(path.join(PW_CORE, f))) {
      console.error(`[bundle-agent-worker] playwright-core not installed under ${DESKTOP}`);
      process.exit(1);
    }
  }

  fs.rmSync(STAGE, { recursive: true, force: true });
  fs.mkdirSync(path.join(STAGE, 'dist'), { recursive: true });

  execFileSync(ESBUILD, [
    ENTRY,
    '--bundle',
    '--platform=node',
    '--format=cjs',
    // worker 以 ELECTRON_RUN_AS_NODE 跑纯 Node——worker 内绝不允许真的 require
    // 到 electron；playwright-core 的 Electron 启动器链指到 stub 包（见其头注）。
    `--alias:electron=${path.join(DESKTOP, 'src', 'agent-worker', 'electron-stub')}`,
    // 可选懒依赖（本机未安装、chromium 路径永不触达）：外置，运行时触达即如实失败。
    '--external:bufferutil',
    '--external:utf-8-validate',
    '--external:chromium-bidi',
    '--sourcemap',
    `--outfile=${path.join(STAGE, 'dist', 'index.js')}`,
  ], { stdio: 'inherit' });

  for (const f of ['browsers.json', 'package.json']) {
    fs.copyFileSync(path.join(PW_CORE, f), path.join(STAGE, f));
  }

  // 布局自检：packageRoot 契约的两条动态 require 目标必须存在。
  for (const f of ['browsers.json', 'package.json']) {
    if (!fs.existsSync(path.join(STAGE, f))) {
      console.error(`[bundle-agent-worker] missing runtime contract file: ${f}`);
      process.exit(1);
    }
  }
  const kb = (p) => `${(fs.statSync(p).size / 1024).toFixed(0)}KB`;
  console.log(`[bundle-agent-worker] done: dist/index.js=${kb(path.join(STAGE, 'dist', 'index.js'))} browsers.json=${kb(path.join(STAGE, 'browsers.json'))}`);
  bundlePlaywrightBrowser();
}

// ---------------------------------------------------------------------------
// N-06②：Playwright Chromium 随包分发（ACF_BUNDLE_PLAYWRIGHT=1 启用）。
//
// 复刻 bundle-executor.sh 的 uv 模式（本地 best-effort / 发布硬闸）：
//   · ACF_BUNDLE_PLAYWRIGHT=1          下载 chromium 到 resources/playwright/
//                                      （registry 形态，extraResources 拷贝）
//   · ACF_PLAYWRIGHT_SOURCE=<dir>      离线构建：直接拷贝既有 registry 目录
//   · ACF_PLAYWRIGHT_REQUIRED=1        发布闸——缺浏览器即 exit 1
//
// 与 uv 语义的刻意区分：没打进 uv 的包是**残包**（声明 runtimeVersion 的
// Python 任务全部不可用），REQUIRED 必须 exit 1；没打进 Chromium 的包是
// **能力降级**（worker 能力上报如实不含 browser，探测不可用不崩溃），发布闸
// 仍立——因为「包里带了 playwright-core 却永远找不到浏览器」只会让用户看到
// "点不出浏览器能力"而没有任何可诊断信号，发布流水线有权在出包前拦住它。
//
// revision 对齐纪律：下载必须用**同版本 playwright CLI**（node_modules/playwright，
// 与 bundle 内联的 playwright-core 同源同版）——registry 的 chromium-<rev> 编号
// 由 playwright-core 的 browsers.json 决定，跨版本下载的浏览器目录编号不一致
// 会导致 launch 时 "Executable doesn't exist"。脚本先断言两包版本一致。
//
// 只装 chromium-headless-shell（实测 266MB，全量 chromium 另需 393MB）：本仓
// 唯一 launch 点是 browser.ts 的 `chromium.launch({ headless: true })`，1.63
// 的 headless:true 走 headless-shell（只在 headless-shell 存在的 registry 上
// 实测 launch 成功）；recordVideo 需要的 ffmpeg-1011 由该目标一并下载。
// 打包态不支持有头 launch——能力面如实收窄，不是回归。
// ---------------------------------------------------------------------------
function bundlePlaywrightBrowser() {
  const browsersDest = path.join(DESKTOP, 'resources', 'playwright');
  const required = process.env.ACF_PLAYWRIGHT_REQUIRED === '1';

  const failOrWarn = (msg) => {
    if (required) {
      console.error(`[bundle-agent-worker] ERROR: ${msg}`);
      console.error('[bundle-agent-worker]   Refusing to produce a release installer without the agent browser:');
      console.error('[bundle-agent-worker]   the bundle carries playwright-core, but the browser capability probe');
      console.error('[bundle-agent-worker]   would silently report unavailable on every fresh device. Fix one of:');
      console.error('[bundle-agent-worker]     - set ACF_BUNDLE_PLAYWRIGHT=1 (needs network access to cdn)');
      console.error('[bundle-agent-worker]     - provide ACF_PLAYWRIGHT_SOURCE=/dir for an offline build');
      process.exit(1);
    }
    console.warn(`[bundle-agent-worker] WARN: ${msg} — worker will report browser capability as unavailable`);
  };

  if (process.env.ACF_BUNDLE_PLAYWRIGHT !== '1') {
    if (required) {
      failOrWarn('ACF_PLAYWRIGHT_REQUIRED=1 but ACF_BUNDLE_PLAYWRIGHT not enabled');
      return;
    }
    console.log('[bundle-agent-worker] playwright bundling skipped (set ACF_BUNDLE_PLAYWRIGHT=1 to enable)');
    return;
  }

  const playwrightPkg = JSON.parse(fs.readFileSync(path.join(DESKTOP, 'node_modules', 'playwright', 'package.json'), 'utf8'));
  const playwrightCorePkg = JSON.parse(fs.readFileSync(path.join(PW_CORE, 'package.json'), 'utf8'));
  if (playwrightPkg.version !== playwrightCorePkg.version) {
    failOrWarn(`playwright ${playwrightPkg.version} != playwright-core ${playwrightCorePkg.version} — browser registry revision would not match the bundled core`);
    return;
  }

  // 先清陈旧产物：上次成功留下的浏览器会让"这次下载失败"被静默掩盖，
  // 打包出的是旧 revision 却报成功（比缺浏览器更难查）。
  fs.rmSync(browsersDest, { recursive: true, force: true });

  const source = process.env.ACF_PLAYWRIGHT_SOURCE;
  if (source) {
    if (!fs.existsSync(source)) {
      failOrWarn(`ACF_PLAYWRIGHT_SOURCE does not exist: ${source}`);
      return;
    }
    fs.mkdirSync(browsersDest, { recursive: true });
    fs.cpSync(source, browsersDest, { recursive: true });
    console.log(`[bundle-agent-worker] browsers copied from ACF_PLAYWRIGHT_SOURCE → ${browsersDest}`);
  } else {
    const cli = path.join(DESKTOP, 'node_modules', 'playwright', 'cli.js');
    fs.mkdirSync(browsersDest, { recursive: true });
    const r = require('child_process').spawnSync(
      process.execPath,
      [cli, 'install', 'chromium-headless-shell'],
      {
        env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: browsersDest },
        stdio: 'inherit',
      },
    );
    if (r.status !== 0) {
      failOrWarn(`playwright install chromium-headless-shell failed (exit ${r.status})`);
      return;
    }
    console.log(`[bundle-agent-worker] chromium-headless-shell ${playwrightPkg.version} bundled → ${browsersDest}`);
  }

  // 落盘自检：headless-shell registry 目录必须真实存在（playwright 的目录名
  // 是 chromium_headless_shell-<rev>，rev 随版本变化——只认前缀，不写死编号）。
  const entries = fs.existsSync(browsersDest) ? fs.readdirSync(browsersDest) : [];
  if (!entries.some((e) => e.startsWith('chromium_headless_shell'))) {
    failOrWarn(`no chromium_headless_shell-* directory under ${browsersDest} after bundling`);
    return;
  }
  console.log(`[bundle-agent-worker] playwright browsers present: ${entries.join(', ')}`);
}

main();
