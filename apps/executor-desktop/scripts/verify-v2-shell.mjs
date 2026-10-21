#!/usr/bin/env node
/**
 * V2 真壳验收：file:// 加载 + 真实 IPC + 关键页面断言。
 *
 * 用法：
 *   cd apps/executor-desktop-v2 && npm run build
 *   cd ../executor-desktop && npm run build:renderer-v2
 *   ACF_E2E_USER_DATA=/tmp/acf-v2-e2e npm run verify:v2
 *
 * 前置：userData 需已 seed（`node scripts/seed-v2-harness.mjs <dir>`）。
 * 退出码非 0 时打印失败项，可直接进 CI。
 */
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { _electron: electron } = require('@playwright/test');

const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(here, '..');
const v2Dist = path.join(appDir, 'dist', 'renderer-v2', 'index.html');
const userData = process.env.ACF_E2E_USER_DATA ?? path.join(appDir, '.v2-harness-userdata');
const screenshots = path.resolve(appDir, '..', 'executor-desktop-v2', 'screenshots');

if (!fs.existsSync(v2Dist)) {
  console.error('[verify:v2] missing dist/renderer-v2. Run: npm run build:renderer-v2');
  process.exit(1);
}
if (!fs.existsSync(path.join(userData, 'config.json'))) {
  console.error(`[verify:v2] missing config.json in ${userData}. Run: node scripts/seed-v2-harness.mjs ${userData}`);
  process.exit(1);
}

const portOpen = (port) =>
  new Promise((resolve) => {
    const socket = net.connect({ port, host: '127.0.0.1' });
    socket.setTimeout(500);
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('timeout', () => { socket.destroy(); resolve(false); });
    socket.once('error', () => resolve(false));
  });

// 每次验收都重新 seed，保证应用/历史/配置是一致的初始态（uninstall 会改目录）。
execFileSync(
  process.execPath,
  [path.join(appDir, 'scripts', 'seed-v2-harness.mjs'), userData],
  { stdio: 'ignore' },
);

const failures = [];
const pass = (label, extra = '') => console.log(`  PASS  ${label}${extra ? ` — ${extra}` : ''}`);
const check = (label, ok, extra = '') => {
  if (ok) pass(label, extra);
  else {
    failures.push(label);
    console.error(`  FAIL  ${label}${extra ? ` — ${extra}` : ''}`);
  }
};

const app = await electron.launch({
  args: ['.', '--no-sandbox'],
  cwd: appDir,
  executablePath: require('electron'),
  env: {
    ...process.env,
    // 不设 ACF_RENDERER：验证 V2 已是**默认**渲染层。
    ACF_OPEN_STATUS: '1',
    ELECTRON_USER_DATA_DIR: userData,
  },
});

try {
  const page = await app.firstWindow();
  const consoleErrors = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => consoleErrors.push(`pageerror: ${error.message}`));

  await page.waitForTimeout(2200);

  const url = page.url();
  check('default renderer is V2 (file://)', url.startsWith('file://') && url.includes('renderer-v2'), url);

  const h1 = (await page.locator('h1').first().textContent())?.trim() ?? '';
  check('status page rendered', ['状态', 'Status'].includes(h1), h1);

  const data = await page.evaluate(async () => {
    try {
      const [cfg, status, history] = await Promise.all([
        window.electronAPI.getConfig(),
        window.electronAPI.getStatus(),
        window.electronAPI.getHistory(),
      ]);
      return {
        bridge: true,
        name: cfg.executorName,
        port: cfg.executorPort,
        status: status.status,
        history: Array.isArray(history) ? history.length : -1,
      };
    } catch (error) {
      return { bridge: false, error: String(error) };
    }
  });
  check('preload bridge reachable', data.bridge === true, data.error ?? '');
  check('config:get returns seeded config', data.name === 'executor-v2-harness' && data.port === 9123, `${data.name}:${data.port}`);
  check('executor:status returns a status', typeof data.status === 'string', data.status);

  const updateApi = await page.evaluate(() =>
    ['downloadUpdate', 'installUpdate', 'onUpdateAvailable', 'onUpdateProgress', 'onUpdateDownloaded', 'onUpdateError'].every(
      (key) => typeof window.electronAPI[key] === 'function',
    ),
  );
  check('update API exposed by preload', updateApi);

  // 状态页「需要关注」→ 带筛选跳转历史
  await page.locator('[data-attention-row]').first().click();
  await page.waitForTimeout(700);
  const attentionH1 = (await page.locator('h1').first().textContent())?.trim() ?? '';
  const filteredHistoryRows = await page.locator('main [data-history-row]').count();
  check(
    'status attention opens filtered history',
    ['历史', 'History'].includes(attentionH1) && filteredHistoryRows === 1,
    `${attentionH1} / ${filteredHistoryRows} rows`,
  );
  await page.locator('aside nav button').nth(0).click();
  await page.waitForTimeout(500);

  const navCount = await page.locator('aside nav button').count();
  check('sidebar has production entries', navCount === 4, `${navCount} items`);

  await page.locator('aside nav button').nth(1).click();
  await page.waitForTimeout(700);
  const rows = await page.locator('main [data-history-row]').count();
  check('history renders real records', rows === data.history && rows > 0, `${rows} rows / ${data.history} from IPC`);

  // ── 清空历史：原生确认框打桩 → meta 文件真的被删 ─────────────────────
  await app.evaluate(({ dialog }) => {
    dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
  });
  const metaDir = path.join(userData, 'work', 'meta');
  const metaBefore = fs.readdirSync(metaDir).filter((file) => file.endsWith('.json')).length;
  check('history meta files present', metaBefore > 0, `${metaBefore} files`);
  await page.getByRole('button', { name: /^(清空历史|Clear history)$/ }).click();
  await page.waitForTimeout(400);
  await page.locator('[role="dialog"]').getByRole('button', { name: /^(清空|Clear)$/ }).click();
  await page.waitForTimeout(900);
  const metaAfter = fs.readdirSync(metaDir).filter((file) => file.endsWith('.json')).length;
  check('clear history deletes meta files', metaAfter === 0, `${metaBefore} -> ${metaAfter}`);
  const rowsAfterClear = await page.locator('main [data-history-row]').count();
  check('history list is empty after clear', rowsAfterClear === 0, `${rowsAfterClear} rows`);

  // ── 应用页：真实部署目录（2 个应用 / 3 个 release）──────────────────
  await page.locator('aside nav button').nth(2).click();
  await page.waitForTimeout(700);
  const appsText = await page.locator('main').innerText();
  check(
    'apps list shows deployed apps',
    appsText.includes('日报生成器') && appsText.includes('库存同步'),
    appsText.replace(/\s+/g, ' ').slice(0, 80),
  );
  const logButtons = page.getByRole('button', { name: /^(日志|Logs)$/ });
  const appRows = page.locator('main [data-app-row]');
  check('apps grouped per app (2 rows / 3 releases)', (await appRows.count()) === 2, `${await appRows.count()} rows`);

  // 版本管理：delete-release 需要 executor 在线（要能问到 app-status），临时拉起一次。
  await page.evaluate(() => window.electronAPI.startExecutor());
  let upForRelease = false;
  for (let i = 0; i < 40 && !upForRelease; i += 1) {
    await page.waitForTimeout(250);
    upForRelease = await portOpen(9123);
  }
  check('executor started for release management', upForRelease);

  const inventoryRow = page.locator('[data-app-row="app_inventory_sync"]');
  await inventoryRow.getByRole('button', { name: /^(日志|Logs)$/ }).click();
  await page.waitForTimeout(700);
  const releaseRows = page.locator('[data-release-row]');
  const releaseCount = await releaseRows.count();
  check('app detail lists all releases', releaseCount === 2, `${releaseCount} releases`);
  const oldRelease = page.locator('[data-release-row]').filter({ hasText: '1.9.0' });
  // 查看历史版本日志 → 返回当前版本
  await oldRelease.getByRole('button', { name: /查看该版本日志|View release log/ }).click();
  await page.waitForTimeout(700);
  const viewingText = await page.locator('[role="dialog"]').innerText();
  check('release log can be opened', /正在查看 1\.9\.0|Viewing 1\.9\.0/.test(viewingText), '');
  check('release log has lines', /18 行|18 lines/.test(viewingText));
  await page.getByRole('button', { name: /返回当前版本|Back to current/ }).click();
  await page.waitForTimeout(500);
  await oldRelease.getByRole('button', { name: /删除该版本|Delete release/ }).click();
  await page.waitForTimeout(1400);
  const releasesDir = path.join(userData, 'work', 'apps', 'app_inventory_sync', 'releases');
  check(
    'delete release removes its directory',
    !fs.existsSync(path.join(releasesDir, '1.9.0-22222222-2222-4222-8222-222222222222')),
  );
  check(
    'current release is kept',
    fs.existsSync(path.join(releasesDir, '2.0.1-33333333-3333-4333-8333-333333333333')),
  );
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  await page.evaluate(() => window.electronAPI.stopExecutor());
  for (let i = 0; i < 40 && (await portOpen(9123)); i += 1) {
    await page.waitForTimeout(250);
  }

  await logButtons.first().click();
  await page.waitForTimeout(700);
  const appLogText = await page.locator('[role="dialog"]').innerText();
  check('app log drawer reads real log', /tick #\d+/.test(appLogText));
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);

  // 卸载：确认框已在上面打桩为「继续」。
  const reportCard = page.locator('main [data-app-row]').filter({ hasText: '日报生成器' });
  await reportCard.getByRole('button', { name: /^(卸载|Uninstall)$/ }).click();
  await page.waitForTimeout(500);
  await page
    .locator('[role="dialog"]')
    .getByRole('button', { name: /^(卸载|Uninstall)$/ })
    .click();
  await page.waitForTimeout(1500);
  const removedAppDir = !fs.existsSync(path.join(userData, 'work', 'apps', 'app_report_daily'));
  check('uninstall deletes app directory', removedAppDir);
  const afterUninstall = await page.locator('main').innerText();
  check('apps list refreshes after uninstall', !afterUninstall.includes('日报生成器'));
  // 小窗口下 toast 会盖住底部保存条：等它自动消失再继续。
  await page.waitForTimeout(4200);

  // 批量卸载：剩下 1 个应用，全选后一次确认删除。
  await page.getByRole('checkbox', { name: /全选|Select all/ }).check();
  await page.waitForTimeout(300);
  const bulkBar = await page.locator('main').innerText();
  check('bulk selection shows bar', /已选 1 个|1 selected/.test(bulkBar));
  await page.getByRole('button', { name: /批量卸载|Uninstall selected/ }).click();
  await page.waitForTimeout(1800);
  const remainingAppDir = path.join(userData, 'work', 'apps', 'app_inventory_sync');
  check('bulk uninstall deletes remaining app', !fs.existsSync(remainingAppDir));
  const rowsAfterBulk = await page.locator('main [data-app-row]').count();
  check('apps list empty after bulk uninstall', rowsAfterBulk === 0, `${rowsAfterBulk} rows`);
  await page.waitForTimeout(4200);

  await page.locator('aside nav button').nth(3).click();
  await page.waitForTimeout(700);
  const urlValue = await page.locator('#adminApiUrl').inputValue();
  check('config form shows real config', urlValue.includes('8001'), urlValue);

  // ── 配置页保存：改字段 → 脏条 → 写盘 ───────────────────────────────
  await page.locator('#maxConcurrentTasks').fill('5');
  await page.getByRole('button', { name: /^(关于与更新|About & updates)$/ }).click();
  await page.waitForTimeout(300);
  await page.getByRole('combobox', { name: /界面语言|Interface language/ }).click();
  await page.getByRole('option', { name: /^English$/ }).click();
  await page.waitForTimeout(300);
  const dirtyText = await page.locator('main').innerText();
  check('config dirty bar appears', /\d+ 处未保存|\d+ unsaved/.test(dirtyText));
  await page.getByRole('button', { name: /^(保存配置|Save)$/ }).click();
  await page.waitForTimeout(2200);
  const savedConfig = JSON.parse(fs.readFileSync(path.join(userData, 'config.json'), 'utf8'));
  check(
    'config save persists to disk',
    savedConfig.maxConcurrentTasks === 5 && savedConfig.uiLanguage === 'en',
    `maxConcurrentTasks=${savedConfig.maxConcurrentTasks}, uiLanguage=${savedConfig.uiLanguage}`,
  );
  const headingAfterLang = (await page.locator('h1').first().textContent())?.trim() ?? '';
  check('language switch reloads UI', headingAfterLang === 'Status', headingAfterLang);

  // 托盘菜单通过主进程 `switch-tab` 切页（真实 IPC 方向：main → renderer）。
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.webContents.send('switch-tab', 'history');
  });
  await page.waitForTimeout(600);
  const switchedH1 = (await page.locator('h1').first().textContent())?.trim() ?? '';
  check('tray switch-tab navigates', ['历史', 'History'].includes(switchedH1), switchedH1);

  await page.screenshot({ path: path.join(screenshots, 'verify-config.png') });

  // ── 执行器生命周期：真实拉起 resources/executor-node，再停掉 ──────────
  await page.locator('aside nav button').nth(0).click();
  await page.waitForTimeout(400);
  await page.evaluate(() => {
    window.__statuses = [];
    window.electronAPI.onStatusChange((status) => window.__statuses.push(status));
  });

  const before = await portOpen(9123);
  check('executor port is free before start', before === false, before ? 'already in use' : '');

  await page.evaluate(() => window.electronAPI.startExecutor());
  let opened = false;
  for (let i = 0; i < 40 && !opened; i += 1) {
    await page.waitForTimeout(250);
    opened = await portOpen(9123);
  }
  check('executor starts and listens on 9123', opened);

  // 等 online（子进程健康探针首轮 1.5s）并让状态页补一次完整快照。
  let statusNow = null;
  for (let i = 0; i < 24; i += 1) {
    await page.waitForTimeout(250);
    statusNow = await page.evaluate(async () => {
      const s = await window.electronAPI.getStatus();
      return { running: s.running, status: s.status, pid: s.pid ?? null };
    });
    if (statusNow.status === 'online') break;
  }
  check('executor reaches online', statusNow?.status === 'online', JSON.stringify(statusNow));
  const events = await page.evaluate(() => window.__statuses);
  check('status events include pending → online', events.includes('pending') && events.includes('online'), events.join(','));

  await page.waitForTimeout(800);
  await page.screenshot({ path: path.join(screenshots, 'verify-running.png') });
  const runningCard = await page.locator('main').innerText();
  check('status page shows real pid/uptime', /PID \d+/.test(runningCard), runningCard.match(/PID \d+/)?.[0] ?? '');

  // 重启：stop + start，应换一个新的 PID 回到 online。
  const pidBeforeRestart = statusNow?.pid ?? null;
  await page.getByRole('button', { name: /^(重启|Restart)$/ }).click();
  let restarted = false;
  let pidAfterRestart = null;
  for (let i = 0; i < 80 && !restarted; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    const state = await page.evaluate(async () => {
      const current = await window.electronAPI.getStatus();
      return { status: current.status, pid: current.pid ?? null };
    });
    if (state.status === 'online' && state.pid && state.pid !== pidBeforeRestart) {
      restarted = true;
      pidAfterRestart = state.pid;
    }
  }
  check(
    'restart brings a new executor process online',
    restarted,
    `${pidBeforeRestart} -> ${pidAfterRestart ?? 'none'}`,
  );

  await page.evaluate(() => window.electronAPI.stopExecutor());
  let closed = false;
  for (let i = 0; i < 40 && !closed; i += 1) {
    await page.waitForTimeout(250);
    closed = !(await portOpen(9123));
  }
  const afterStop = await page.evaluate(async () => {
    const s = await window.electronAPI.getStatus();
    return { running: s.running, status: s.status };
  });
  check('executor stops and releases port', closed && afterStop.running === false, JSON.stringify(afterStop));

  check('no console errors', consoleErrors.length === 0, consoleErrors.slice(0, 2).join(' | '));

  // ── 渲染崩溃 → 错误边界 → 重试恢复 ────────────────────────────────
  await page.evaluate(() => localStorage.setItem('acf-v2-test-crash', '1'));
  await page.reload();
  await page.waitForTimeout(900);
  const boundaryVisible = (await page.getByRole('alert').count()) > 0;
  check('error boundary catches render crash', boundaryVisible);
  await page.screenshot({ path: path.join(screenshots, 'verify-error-boundary.png') });
  await page.evaluate(() => localStorage.removeItem('acf-v2-test-crash'));
  await page.getByRole('button', { name: /^(重试|Retry)$/ }).click();
  await page.waitForTimeout(700);
  const recoveredH1 = (await page.locator('h1').first().textContent())?.trim() ?? '';
  check('retry recovers from crash', ['状态', 'Status'].includes(recoveredH1), recoveredH1);
} finally {
  await app.close();
}

// ── 首次启动形态：独立向导窗口（V1 的 #wizard 窗口）─────────────────────
const wizardUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'acf-verify-wizard-'));
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
  check(
    'first run opens #wizard window',
    page.url().includes('renderer-v2/index.html#wizard'),
    page.url(),
  );
  const heading = (await page.getByRole('heading').first().textContent().catch(() => '')) ?? '';
  check('wizard window renders standalone UI', heading.length > 0, heading);
  check('wizard follows english locale', heading === 'Setup wizard', heading);
  await page.screenshot({ path: path.join(screenshots, 'verify-wizard.png') });

  // 走完五步：开始 → 连接 → 执行器 → 解释器源 → 完成
  await page.getByRole('button', { name: /^(开始配置|Get started)$/ }).click();
  await page.waitForTimeout(300);
  for (let step = 0; step < 3; step += 1) {
    await page.getByRole('button', { name: /^(下一步|Next)$/ }).click();
    await page.waitForTimeout(300);
  }

  // 关掉「保存后立即启动」，避免验收过程拉起 sidecar。
  const startSwitch = page.getByRole('switch', {
    name: /保存后立即启动执行器|Start the executor after saving/,
  });
  if ((await startSwitch.count()) > 0) await startSwitch.click();

  await page.getByRole('button', { name: /^(完成并保存|Save & finish)$/ }).click();

  let wizardClosed = false;
  for (let i = 0; i < 24 && !wizardClosed; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    wizardClosed = page.isClosed();
  }
  check('wizard window closes after save', wizardClosed);

  await new Promise((resolve) => setTimeout(resolve, 500));
  const savedConfig = JSON.parse(fs.readFileSync(path.join(wizardUserData, 'config.json'), 'utf8'));
  check(
    'wizard persists config to disk',
    savedConfig.configured === true &&
      savedConfig.executorName === 'executor-v2-harness' &&
      savedConfig.executorPort === 9123,
    JSON.stringify({
      configured: savedConfig.configured,
      name: savedConfig.executorName,
      port: savedConfig.executorPort,
    }),
  );
} finally {
  await wizardApp.close();
  fs.rmSync(wizardUserData, { recursive: true, force: true });
}

// ── 英文界面（全页）──────────────────────────────────────────────
const enUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'acf-verify-en-'));
fs.copyFileSync(path.join(userData, 'config.json'), path.join(enUserData, 'config.json'));
const enConfig = JSON.parse(fs.readFileSync(path.join(enUserData, 'config.json'), 'utf8'));
enConfig.uiLanguage = 'en';
enConfig.configured = true;
fs.writeFileSync(path.join(enUserData, 'config.json'), JSON.stringify(enConfig, null, 2));

const enApp = await electron.launch({
  args: ['.', '--no-sandbox'],
  cwd: appDir,
  executablePath: require('electron'),
  env: { ...process.env, ACF_OPEN_STATUS: '1', ELECTRON_USER_DATA_DIR: enUserData },
});

try {
  const page = await enApp.firstWindow();
  await page.waitForTimeout(1600);
  const statusHeading = (await page.locator('h1').first().textContent())?.trim() ?? '';
  check('english locale renders status', statusHeading === 'Status', statusHeading);

  await page.locator('aside nav button').nth(1).click();
  await page.waitForTimeout(500);
  const historyHeading = (await page.locator('h1').first().textContent())?.trim() ?? '';
  await page.locator('aside nav button').nth(3).click();
  await page.waitForTimeout(500);
  const settingsHeading = (await page.locator('h1').first().textContent())?.trim() ?? '';
  check(
    'english locale covers all pages',
    historyHeading === 'History' && settingsHeading === 'Settings',
    `${historyHeading} / ${settingsHeading}`,
  );
  await page.screenshot({ path: path.join(screenshots, 'verify-en.png') });
} finally {
  await enApp.close();
  fs.rmSync(enUserData, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error(`[verify:v2] ${failures.length} check(s) failed`);
  process.exit(1);
}
console.log('[verify:v2] all checks passed');
