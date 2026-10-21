#!/usr/bin/env node
/**
 * 打包产物冒烟：直接运行 electron-builder --dir 的输出，验证「发布形态」。
 *
 *   cd apps/executor-desktop
 *   npx electron-builder --linux dir --publish never
 *   npm run verify:v2:packaged
 *
 * 与 verify:v2 的区别：这里加载的是 **app.asar 内的 renderer-v2 / preload**，
 * 以及 `resources/` 下的 executor sidecar —— 覆盖 asar 路径、extraResources 布局、
 * packaged 分支（app.isPackaged=true）。
 *
 * 说明：
 *   - 打包态刻意不提供 ACF_OPEN_STATUS 逃生门，所以用「首次启动」形态
 *     （configured=false → #wizard 独立窗口）拿到窗口；
 *   - Linux 未安装 4755 chrome-sandbox 时需 --no-sandbox；
 *   - 可用 ACF_PACKAGED_BINARY 指定其它平台的产物路径。
 */
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('@playwright/test');

const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(here, '..');
const port = Number(process.env.ACF_CDP_PORT ?? 9333);

const defaultBinary = {
  linux: path.join(appDir, 'dist-electron', 'linux-unpacked', 'executor-desktop'),
  win32: path.join(appDir, 'dist-electron', 'win-unpacked', 'AutoCodeFlow Executor.exe'),
  darwin: path.join(
    appDir,
    'dist-electron',
    'mac',
    'AutoCodeFlow Executor.app',
    'Contents',
    'MacOS',
    'AutoCodeFlow Executor',
  ),
}[process.platform];

const binary = process.env.ACF_PACKAGED_BINARY ?? defaultBinary;
if (!binary || !fs.existsSync(binary)) {
  console.error(`[verify:packaged] packaged binary not found: ${binary}`);
  console.error('  run: npx electron-builder --linux dir --publish never');
  process.exit(1);
}

const failures = [];
const check = (label, ok, extra = '') => {
  if (ok) console.log(`  PASS  ${label}${extra ? ` — ${extra}` : ''}`);
  else {
    failures.push(label);
    console.error(`  FAIL  ${label}${extra ? ` — ${extra}` : ''}`);
  }
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const portOpen = (target) =>
  new Promise((resolve) => {
    const socket = net.connect({ port: target, host: '127.0.0.1' });
    socket.setTimeout(400);
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('timeout', () => { socket.destroy(); resolve(false); });
    socket.once('error', () => resolve(false));
  });

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'acf-packaged-'));
const { execFileSync } = await import('node:child_process');
execFileSync(process.execPath, [path.join(appDir, 'scripts', 'seed-v2-harness.mjs'), userData], {
  stdio: 'ignore',
});
const configPath = path.join(userData, 'config.json');
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
config.configured = false;
fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

const args = [`--remote-debugging-port=${port}`];
if (process.platform === 'linux') args.push('--no-sandbox');
const child = spawn(binary, args, {
  env: { ...process.env, ELECTRON_USER_DATA_DIR: userData },
  detached: true,
  stdio: 'ignore',
});

try {
  let ready = false;
  for (let i = 0; i < 80 && !ready; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      ready = res.ok;
    } catch {
      /* retry */
    }
    if (!ready) await sleep(250);
  }
  check('packaged app exposes CDP', ready);

  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const context = browser.contexts()[0];
  let page = null;
  for (let i = 0; i < 40 && !page; i += 1) {
    page = context.pages().find((candidate) => candidate.url().includes('app.asar'));
    if (!page) await sleep(250);
  }
  if (!page) throw new Error('no app.asar page found');
  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(1200);

  const url = page.url();
  check(
    'loads renderer from app.asar',
    url.includes('app.asar') && url.includes('renderer-v2/index.html#wizard'),
    url,
  );

  const heading = (await page.getByRole('heading').first().textContent().catch(() => '')) ?? '';
  check('wizard window renders', heading.length > 0, heading);

  const cfg = await page.evaluate(async () => {
    const value = await window.electronAPI.getConfig();
    return { name: value.executorName, configured: value.configured };
  });
  check('preload bridge works in packaged build', cfg.name === 'executor-v2-harness', JSON.stringify(cfg));

  const beforeStart = await portOpen(9123);
  await page.evaluate(() => window.electronAPI.startExecutor());
  let started = false;
  for (let i = 0; i < 40 && !started; i += 1) {
    await sleep(250);
    started = await portOpen(9123);
  }
  check('packaged executor sidecar starts', !beforeStart && started);

  await page.evaluate(() => window.electronAPI.stopExecutor());
  let stopped = false;
  for (let i = 0; i < 40 && !stopped; i += 1) {
    await sleep(250);
    stopped = !(await portOpen(9123));
  }
  check('packaged executor sidecar stops', stopped);

  await page.screenshot({
    path: path.resolve(appDir, '..', 'executor-desktop-v2', 'screenshots', 'packaged-wizard.png'),
  });
  await browser.close();
} finally {
  try { process.kill(-child.pid, 'SIGTERM'); } catch { /* already gone */ }
  await sleep(500);
  fs.rmSync(userData, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error(`[verify:packaged] ${failures.length} check(s) failed`);
  process.exit(1);
}
console.log('[verify:packaged] all checks passed');
