#!/usr/bin/env node
/**
 * V2 视觉回归：在真壳里按固定窗口尺寸截取关键页面，与基线做像素比对。
 *
 *   npm run visual:v2          # 与基线比对（CI）
 *   npm run visual:v2:update   # 重写基线（人工确认改动后）
 *
 * 稳定性措施：
 *   - 每次运行重新 seed 一份隔离 userData（相对时间、历史条数保持稳定）；
 *   - 注入 CSS 关闭动画/过渡/光标闪烁；
 *   - 状态页的日志区用 Playwright `mask` 盖住（内容随时间流动）。
 *
 * 差异阈值：0.2% 像素；超过则输出 diff 图并退出 1。
 */
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';

const require = createRequire(import.meta.url);
const { _electron: electron } = require('@playwright/test');

const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(here, '..');
const baselineDir = path.join(appDir, 'e2e-v2', 'baseline');
const diffDir = path.join(appDir, 'e2e-v2', 'diffs');
const update = process.argv.includes('--update');
const THRESHOLD = Number(process.env.VISUAL_THRESHOLD ?? '0.002');

const FREEZE_CSS = `*, *::before, *::after {
  animation: none !important;
  transition: none !important;
  caret-color: transparent !important;
}`;

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'acf-visual-'));
execFileSync(process.execPath, [path.join(appDir, 'scripts', 'seed-v2-harness.mjs'), userData], {
  stdio: 'ignore',
});

fs.mkdirSync(baselineDir, { recursive: true });
fs.mkdirSync(diffDir, { recursive: true });

const failures = [];
const captured = new Map();

function compare(name, file) {
  const baselineFile = path.join(baselineDir, `${name}.png`);
  if (update) {
    fs.copyFileSync(file, baselineFile);
    console.log(`  UPDATE ${name} -> ${path.relative(appDir, baselineFile)}`);
    return;
  }
  if (!fs.existsSync(baselineFile)) {
    failures.push(`${name}: missing baseline (run npm run visual:v2:update)`);
    console.error(`  FAIL  ${name}: missing baseline`);
    return;
  }
  const current = PNG.sync.read(fs.readFileSync(file));
  const baseline = PNG.sync.read(fs.readFileSync(baselineFile));
  if (current.width !== baseline.width || current.height !== baseline.height) {
    failures.push(`${name}: size ${current.width}x${current.height} != ${baseline.width}x${baseline.height}`);
    console.error(`  FAIL  ${name}: image size changed`);
    return;
  }
  const diff = new PNG({ width: current.width, height: current.height });
  const changed = pixelmatch(current.data, baseline.data, diff.data, current.width, current.height, {
    threshold: 0.1,
  });
  const ratio = changed / (current.width * current.height);
  if (ratio > THRESHOLD) {
    const diffFile = path.join(diffDir, `${name}.diff.png`);
    fs.writeFileSync(diffFile, PNG.sync.write(diff));
    failures.push(`${name}: ${(ratio * 100).toFixed(2)}% pixels differ -> ${path.relative(appDir, diffFile)}`);
    console.error(`  FAIL  ${name}: ${(ratio * 100).toFixed(2)}% pixels differ`);
  } else {
    console.log(`  PASS  ${name} (${(ratio * 100).toFixed(3)}% diff)`);
  }
}

async function capture(page, name, mask = []) {
  const file = update ? path.join(baselineDir, `${name}.png`) : path.join(userData, `${name}.png`);
  await page.screenshot({
    path: file,
    animations: 'disabled',
    mask,
    // 用日志区底色盖住滚动内容，基线仍可人工阅读。
    maskColor: '#f7f8fa',
  });
  captured.set(name, file);
  if (!update) compare(name, file);
}

// ── 主窗：状态 / 历史 / 应用 / 配置 ────────────────────────────────
const app = await electron.launch({
  args: ['.', '--no-sandbox'],
  cwd: appDir,
  executablePath: require('electron'),
  env: { ...process.env, ACF_OPEN_STATUS: '1', ELECTRON_USER_DATA_DIR: userData },
});

try {
  const page = await app.firstWindow();
  await page.waitForTimeout(1800);
  await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    win.setContentSize(1440, 900);
    win.center();
  });
  await page.waitForTimeout(700);
  await page.addStyleTag({ content: FREEZE_CSS });

  const logViewport = page.locator('main [data-log-viewport]').first();
  await capture(page, 'status', (await logViewport.count()) > 0 ? [logViewport] : []);

  await page.locator('aside nav button').nth(1).click();
  await page.waitForTimeout(500);
  await capture(page, 'history');

  await page.locator('aside nav button').nth(2).click();
  await page.waitForTimeout(500);
  await capture(page, 'apps');

  await page.locator('aside nav button').nth(3).click();
  await page.waitForTimeout(500);
  await capture(page, 'config');
} finally {
  await app.close();
}

// ── 独立向导窗口 ──────────────────────────────────────────────────
const wizardUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'acf-visual-wizard-'));
fs.copyFileSync(path.join(userData, 'config.json'), path.join(wizardUserData, 'config.json'));
const wizardConfig = JSON.parse(fs.readFileSync(path.join(wizardUserData, 'config.json'), 'utf8'));
wizardConfig.configured = false;
fs.writeFileSync(path.join(wizardUserData, 'config.json'), JSON.stringify(wizardConfig, null, 2));

const wizardApp = await electron.launch({
  args: ['.', '--no-sandbox'],
  cwd: appDir,
  executablePath: require('electron'),
  env: { ...process.env, ELECTRON_USER_DATA_DIR: wizardUserData },
});

try {
  const page = await wizardApp.firstWindow();
  await page.waitForTimeout(1600);
  await page.addStyleTag({ content: FREEZE_CSS });
  await capture(page, 'wizard');
} finally {
  await wizardApp.close();
  fs.rmSync(wizardUserData, { recursive: true, force: true });
  fs.rmSync(userData, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error(`[visual:v2] ${failures.length} page(s) regressed`);
  process.exit(1);
}
console.log(
  update
    ? '[visual:v2] baselines updated'
    : `[visual:v2] all pages match baselines (threshold ${(THRESHOLD * 100).toFixed(2)}%)`,
);
