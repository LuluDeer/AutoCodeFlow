#!/usr/bin/env node
'use strict';

/**
 * verify-desktop-workbench-bridge harness
 *
 * 真机 Electron 验收：工作台独立窗口 + 精简后的 window.workbenchApi 桥。
 * 只依赖本包已有的 electron 与 @playwright/test；不构建、不改产品源码、不碰主配置。
 *
 * 全部步骤严格串行；任何断言失败即非零退出，skip 计数恒为 0。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const strict = require('assert').strict;
const { _electron: electron } = require('@playwright/test');
const ELECTRON_BIN = require('electron');

const DESKTOP = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(DESKTOP, '..', '..');
const APP_ENTRY = path.join(DESKTOP, 'dist', 'main', 'index.js');
const WB_PRELOAD = path.join(DESKTOP, 'dist', 'preload', 'workbench.js');
const MAIN_PRELOAD = path.join(DESKTOP, 'dist', 'preload', 'index.js');

const EXPECTED_INVOKE_CHANNELS = [
  'workbench:cancelAgentAssignment',
  'workbench:getDesktopContext',
  'workbench:getRecentAgentEvents',
  'workbench:pickLocalFiles',
];
const EXPECTED_EVENT_CHANNEL = 'workbench:agentEvent';
const EXPECTED_API_KEYS = [
  'cancelAgentAssignment',
  'getDesktopContext',
  'getRecentAgentEvents',
  'onAgentEvent',
  'pickLocalFiles',
];
const WORKBENCH_FLAG = 'persist:acf-workbench';
const FIRST_WINDOW_TIMEOUT_MS = 40_000;

function parseArgs(argv) {
  let evidenceDir = '';
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--evidence-dir' && argv[i + 1]) {
      evidenceDir = path.resolve(argv[i + 1]);
      i += 1;
    }
  }
  if (!evidenceDir) {
    throw new Error('缺少 --evidence-dir <absolute-path>');
  }
  fs.mkdirSync(evidenceDir, { recursive: true });
  return {
    evidenceDir,
    commandsPath: path.join(evidenceDir, 'commands.txt'),
    resultPath: path.join(evidenceDir, 'result.json'),
    assertionsPath: path.join(evidenceDir, 'assertions.json'),
  };
}

const paths = parseArgs(process.argv.slice(2));
const startedAt = new Date().toISOString();

function now() {
  return new Date().toISOString();
}

function appendCommand(line) {
  fs.appendFileSync(paths.commandsPath, `[${now()}] ${line}\n`, 'utf8');
}

function safe(value) {
  if (value === undefined) return null;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return String(value);
  }
}

function brief(value, max = 2000) {
  const text = typeof value === 'string' ? value : JSON.stringify(safe(value));
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function uniqueSorted(values) {
  return Array.from(new Set(values)).sort();
}

const assertions = [];

function flushAssertions() {
  const passed = assertions.filter((a) => a.status === 'pass').length;
  const failed = assertions.filter((a) => a.status === 'fail').length;
  fs.writeFileSync(
    paths.assertionsPath,
    JSON.stringify({
      generatedAt: now(),
      ok: failed === 0,
      total: assertions.length,
      passed,
      failed,
      skipped: 0,
      assertions,
    }, null, 2) + '\n',
    'utf8',
  );
  return { total: assertions.length, passed, failed, skipped: 0 };
}

async function assertThat(id, name, fn) {
  const begun = Date.now();
  appendCommand(`ASSERT ${id}: ${name}`);
  try {
    const detail = await fn();
    assertions.push({
      id,
      name,
      status: 'pass',
      durationMs: Date.now() - begun,
      detail: safe(detail),
    });
    flushAssertions();
    return detail;
  } catch (error) {
    assertions.push({
      id,
      name,
      status: 'fail',
      durationMs: Date.now() - begun,
      error: error instanceof Error ? `${error.message}\n${error.stack || ''}` : String(error),
    });
    flushAssertions();
    throw error;
  }
}

function recordDirect(id, name, ok, detail) {
  assertions.push({
    id,
    name,
    status: ok ? 'pass' : 'fail',
    detail: safe(detail),
  });
  flushAssertions();
}

let failure = null;
let resultWritten = false;
let finalizing = false;
let finalizePromise = null;
let signalReceived = null;

let electronApp = null;
let stubServer = null;
let userDataDir = null;

const cleanup = {
  startedAt: null,
  electronAppClosed: false,
  stubServerClosed: false,
  userDataRemoved: false,
  errors: [],
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function closeElectron() {
  if (electronApp === null) {
    cleanup.electronAppClosed = true;
    return;
  }
  try {
    await Promise.race([
      electronApp.close(),
      sleep(10_000).then(() => { throw new Error('electronApp.close timeout'); }),
    ]);
    cleanup.electronAppClosed = true;
  } catch (error) {
    try {
      const proc = electronApp.process();
      if (proc && !proc.killed) proc.kill('SIGKILL');
      cleanup.electronAppClosed = proc ? proc.killed : false;
    } catch (killError) {
      cleanup.errors.push(`electron kill: ${killError.message}`);
    }
    cleanup.errors.push(`electron close: ${error.message}`);
  }
}

async function closeStubServer() {
  if (stubServer === null) {
    cleanup.stubServerClosed = true;
    return;
  }
  try {
    if (stubServer.listening) {
      await new Promise((resolve) => {
        const timer = setTimeout(() => {
          try { stubServer.closeAllConnections?.(); } catch { /* already closed */ }
          resolve();
        }, 3000);
        timer.unref?.();
        stubServer.close(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    try { stubServer.closeAllConnections?.(); } catch { /* already closed */ }
    cleanup.stubServerClosed = !stubServer.listening;
  } catch (error) {
    cleanup.errors.push(`stub server close: ${error.message}`);
  }
}

async function removeUserData() {
  if (userDataDir === null) {
    cleanup.userDataRemoved = true;
    return;
  }
  try {
    fs.rmSync(userDataDir, { recursive: true, force: true });
    cleanup.userDataRemoved = !fs.existsSync(userDataDir);
  } catch (error) {
    cleanup.errors.push(`userData remove: ${error.message}`);
  }
}

async function cleanupAll() {
  if (cleanup.startedAt) return cleanup;
  cleanup.startedAt = now();
  appendCommand('CLEANUP: electron app -> stub server -> temp userData');
  await closeElectron();
  await closeStubServer();
  await removeUserData();
  return cleanup;
}

function summary() {
  const passed = assertions.filter((a) => a.status === 'pass').length;
  const failed = assertions.filter((a) => a.status === 'fail').length;
  return { total: assertions.length, passed, failed, skipped: 0 };
}

function writeResult(exitCode, force = false) {
  if (resultWritten && !force) return;
  resultWritten = true;
  const s = summary();
  const cleanupOk = cleanup.electronAppClosed && cleanup.stubServerClosed && cleanup.userDataRemoved;
  fs.writeFileSync(paths.resultPath, JSON.stringify({
    ok: exitCode === 0 && s.failed === 0 && cleanupOk,
    exitCode,
    startedAt,
    finishedAt: now(),
    signalReceived,
    failure,
    assertionSummary: { ...s, ok: s.failed === 0 },
    cleanup: { ...cleanup, ok: cleanupOk },
    evidence: {
      commandsPath: paths.commandsPath,
      assertionsPath: paths.assertionsPath,
      resultPath: paths.resultPath,
    },
    scope: {
      repoRoot: REPO_ROOT,
      desktopRoot: DESKTOP,
      appEntry: APP_ENTRY,
      workbenchPreload: WB_PRELOAD,
      mainPreload: MAIN_PRELOAD,
      userDataDir,
    },
  }, null, 2) + '\n', 'utf8');
}

function finalize(exitCode) {
  if (finalizePromise) return finalizePromise;
  finalizing = true;
  finalizePromise = (async () => {
    await cleanupAll();
    const cleanupOk = cleanup.electronAppClosed && cleanup.stubServerClosed && cleanup.userDataRemoved;
    recordDirect('A17', '清理状态：Electron app / stub server / 临时 userData', cleanupOk, {
      ...cleanup,
    });
    const finalExitCode = cleanupOk ? exitCode : (exitCode === 0 ? 1 : exitCode);
    writeResult(finalExitCode);
    process.exitCode = finalExitCode;
  })();
  return finalizePromise;
}

function onSignal(signal) {
  if (signalReceived) return;
  signalReceived = signal;
  failure = { message: `interrupted by ${signal}`, stack: null };
  const code = signal === 'SIGINT' ? 130 : 143;
  finalize(code).finally(() => {
    writeResult(code, true);
    process.exit(code);
  });
}

process.on('SIGINT', () => onSignal('SIGINT'));
process.on('SIGTERM', () => onSignal('SIGTERM'));

function readSource(file) {
  if (!fs.existsSync(file)) throw new Error(`构建产物不存在：${file}`);
  return fs.readFileSync(file, 'utf8');
}

function extractChannels(source) {
  const invokes = [];
  const events = [];
  const invokeRe = /(?:[A-Za-z_$][\w$]*\s*\.\s*)?ipcRenderer\s*\.\s*invoke\s*\(\s*(['"])([^'"`]+)\1/g;
  const eventRe = /(?:[A-Za-z_$][\w$]*\s*\.\s*)?ipcRenderer\s*\.\s*(?:on|once|removeListener|removeAllListeners)\s*\(\s*(['"])([^'"`]+)\1/g;
  let match;
  while ((match = invokeRe.exec(source)) !== null) invokes.push(match[2]);
  while ((match = eventRe.exec(source)) !== null) events.push(match[2]);
  return { invokes: uniqueSorted(invokes), events: uniqueSorted(events) };
}

function stubHtml() {
  return '<!doctype html><html lang="zh"><head><meta charset="utf-8">'
    + '<title>wb-bridge-fixture</title></head><body>'
    + '<div id="fixture">workbench bridge fixture</div>'
    + '</body></html>\n';
}

async function startStubServer() {
  const server = http.createServer((req, res) => {
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
    });
    res.end(stubHtml());
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  stubServer = server;
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('stub server address unavailable');
  return { port: address.port, baseUrl: `http://127.0.0.1:${address.port}` };
}

function electronEnv() {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  env.DISPLAY = process.env.DISPLAY || ':0';
  env.XAUTHORITY = process.env.XAUTHORITY || '/run/user/1000/.mutter-Xwaylandauth.MA3IZ3';
  env.LANG = 'zh_CN.UTF-8';
  env.LC_ALL = 'zh_CN.UTF-8';
  return env;
}

async function run() {
  appendCommand(`PRECONDITION: 主控必须先重建 dist/preload/workbench.js；本 harness 不执行构建。`);

  await assertThat('A01', '构建产物齐全', () => {
    strict.ok(fs.existsSync(APP_ENTRY), `缺少 ${APP_ENTRY}`);
    strict.ok(fs.existsSync(WB_PRELOAD), `缺少 ${WB_PRELOAD}`);
    strict.ok(fs.existsSync(MAIN_PRELOAD), `缺少 ${MAIN_PRELOAD}`);
    return { appEntry: APP_ENTRY, workbenchPreload: WB_PRELOAD, mainPreload: MAIN_PRELOAD };
  });

  await assertThat('A02', 'dist/preload/workbench.js channel 集合 == 4 invoke + 1 event', () => {
    const source = readSource(WB_PRELOAD);
    const { invokes, events } = extractChannels(source);
    strict.deepStrictEqual(invokes, EXPECTED_INVOKE_CHANNELS);
    strict.deepStrictEqual(events, [EXPECTED_EVENT_CHANNEL]);
    return { invokes, events };
  });

  await assertThat('A03', 'dist/preload/workbench.js 无退役 channel 且只暴露 workbenchApi', () => {
    const source = readSource(WB_PRELOAD);
    const retired = source.match(/workbench:(?:getUrl|navigate|close)\b/g) || [];
    strict.deepStrictEqual(retired, [], `仍含退役 channel: ${retired.join(', ')}`);
    const exposeCount = (source.match(/(?:[A-Za-z_$][\w$]*\s*\.\s*)?contextBridge\s*\.\s*exposeInMainWorld\s*\(/g) || []).length;
    strict.strictEqual(exposeCount, 1, `exposeInMainWorld 调用数=${exposeCount}`);
    strict.match(source, /exposeInMainWorld\s*\(\s*['"]workbenchApi['"]/);
    return { retired, exposeCount };
  });

  const stub = await assertThat('A04', 'HTTP stub 在 127.0.0.1 同源启动', async () => {
    const started = await startStubServer();
    const response = await new Promise((resolve, reject) => {
      http.get(`${started.baseUrl}/workbench`, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, body }));
      }).on('error', reject);
    });
    strict.strictEqual(response.status, 200);
    strict.match(response.body, /workbench bridge fixture/);
    return started;
  });

  await assertThat('A05', '隔离 userData/config.json 写入，未触碰主配置', () => {
    userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'acf-wb-bridge-'));
    const configPath = path.join(userDataDir, 'config.json');
    const fixturePath = path.join(userDataDir, 'wb-bridge-fixture.txt');
    const fixtureContent = 'wb-bridge-pick-fixture\n';
    fs.writeFileSync(fixturePath, fixtureContent, 'utf8');
    fs.writeFileSync(configPath, JSON.stringify({
      configured: true,
      adminApiUrl: stub.baseUrl,
      executorName: 'wb-bridge-fixture',
      agentEnabled: false,
      autoStart: false,
      autoStartExecutor: false,
      theme: 'light',
      uiLanguage: 'en',
    }, null, 2) + '\n', 'utf8');
    strict.ok(fs.existsSync(configPath));
    strict.ok(fs.existsSync(fixturePath));
    return { userDataDir, configPath, fixturePath, fixtureContent };
  });

  const fixturePath = path.join(userDataDir, 'wb-bridge-fixture.txt');
  const fixtureContent = fs.readFileSync(fixturePath, 'utf8');

  appendCommand(`_electron.launch executablePath=<electron> args=[--no-sandbox,--disable-dev-shm-usage,--lang=zh-CN,${APP_ENTRY},--workbench] env.ELECTRON_USER_DATA_DIR=${userDataDir}`);
  electronApp = await electron.launch({
    executablePath: ELECTRON_BIN,
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--lang=zh-CN',
      APP_ENTRY,
      '--workbench',
    ],
    env: { ...electronEnv(), ELECTRON_USER_DATA_DIR: userDataDir },
  });

  let wbPage = null;
  await assertThat('A06', '工作台首窗 40s 内加载同源 stub', async () => {
    const page = await electronApp.firstWindow({ timeout: FIRST_WINDOW_TIMEOUT_MS });
    await page.waitForURL(new RegExp(`${stub.baseUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/workbench`), { timeout: FIRST_WINDOW_TIMEOUT_MS });
    await page.waitForFunction(
      () => Boolean(window.workbenchApi),
      null,
      { timeout: FIRST_WINDOW_TIMEOUT_MS },
    );
    wbPage = page;
    return { url: page.url(), title: await page.title() };
  });

  await assertThat('A07', 'window.workbenchApi keys 严格等于 5', async () => {
    const keys = await wbPage.evaluate(() => Object.keys(window.workbenchApi).sort());
    strict.deepStrictEqual(keys, EXPECTED_API_KEYS);
    return { keys };
  });

  await assertThat('A08', 'getDesktopContext 只读调用', async () => {
    const context = await wbPage.evaluate(() => window.workbenchApi.getDesktopContext());
    strict.deepStrictEqual(Object.keys(context).sort(), ['agentEnabled', 'executorName', 'platformConfigured']);
    strict.strictEqual(context.executorName, 'wb-bridge-fixture');
    strict.strictEqual(context.agentEnabled, false);
    strict.strictEqual(context.platformConfigured, true);
    strict.ok(!JSON.stringify(context).includes('adminApiUrl'));
    strict.ok(!JSON.stringify(context).includes('executorToken'));
    strict.ok(!JSON.stringify(context).includes('workDir'));
    return { context };
  });

  await assertThat('A09', 'getRecentAgentEvents 只读调用', async () => {
    const events = await wbPage.evaluate(() => window.workbenchApi.getRecentAgentEvents());
    strict.ok(Array.isArray(events), 'getRecentAgentEvents 必须返回数组');
    strict.ok(events.length <= 20, `回放长度=${events.length} 超过 20`);
    return { count: events.length };
  });

  await assertThat('A10', '主进程 patch dialog.showOpenDialog', async () => {
    const patched = await electronApp.evaluate(({ dialog }, filePath) => {
      const fn = async () => ({
        canceled: false,
        filePaths: [filePath],
        bookmarks: [],
        checkboxChecked: false,
      });
      try {
        dialog.showOpenDialog = fn;
      } catch {
        Object.defineProperty(dialog, 'showOpenDialog', {
          value: fn,
          configurable: true,
          writable: true,
        });
      }
      return { type: typeof dialog.showOpenDialog, patched: dialog.showOpenDialog === fn };
    }, fixturePath);
    strict.strictEqual(patched.type, 'function');
    strict.strictEqual(patched.patched, true);
    return patched;
  });

  await assertThat('A11', 'pickLocalFiles 只返回白名单字段且无路径', async () => {
    const picked = await wbPage.evaluate(() => window.workbenchApi.pickLocalFiles());
    strict.ok(Array.isArray(picked));
    strict.strictEqual(picked.length, 1);
    const item = picked[0];
    strict.deepStrictEqual(Object.keys(item).sort(), ['mimeType', 'name', 'size', 'textPreview']);
    strict.strictEqual(item.name, 'wb-bridge-fixture.txt');
    strict.strictEqual(item.size, Buffer.byteLength(fixtureContent, 'utf8'));
    strict.strictEqual(item.mimeType, 'text/plain');
    strict.ok(item.textPreview.includes('wb-bridge-pick-fixture'));
    const serialized = JSON.stringify(picked);
    strict.ok(!serialized.includes(fixturePath), '载荷含 userData 路径');
    strict.ok(!serialized.includes(userDataDir), '载荷含隔离目录');
    strict.ok(!serialized.includes('/tmp/'), '载荷含 /tmp 路径');
    strict.ok(!serialized.includes('file://'), '载荷含 file:// URL');
    return { item };
  });

  await assertThat('A12', '渲染层 onAgentEvent 订阅成功', async () => {
    const unsubscribeType = await wbPage.evaluate(() => {
      window.__wbBridgeEvents = [];
      window.__wbBridgeUnsubscribe = window.workbenchApi.onAgentEvent((event) => {
        window.__wbBridgeEvents.push(event);
      });
      return typeof window.__wbBridgeUnsubscribe;
    });
    strict.strictEqual(unsubscribeType, 'function');
    return { unsubscribeType };
  });

  const firstMarker = 'WB_BRIDGE_EVENT_1';
  await assertThat('A13', '主进程 push workbench:agentEvent，渲染层收到', async () => {
    const sent = await electronApp.evaluate(({ BrowserWindow }, { channel, payload }) => {
      const win = BrowserWindow.getAllWindows().find((candidate) =>
        !candidate.isDestroyed()
        && candidate.webContents
        && candidate.webContents.__acfWorkbenchPartition === 'persist:acf-workbench');
      if (!win) throw new Error('未找到工作台窗口');
      win.webContents.send(channel, payload);
      return { windowId: win.id, url: win.webContents.getURL() };
    }, { channel: EXPECTED_EVENT_CHANNEL, payload: { seq: 1, kind: 'status', payload: { marker: firstMarker } } });

    await wbPage.waitForFunction(
      (marker) => (window.__wbBridgeEvents || []).some((event) => event && event.payload && event.payload.marker === marker),
      firstMarker,
      { timeout: 10_000 },
    );
    const events = await wbPage.evaluate(() => window.__wbBridgeEvents);
    strict.ok(events.some((event) => event?.payload?.marker === firstMarker));
    return { sent, received: events.length };
  });

  await assertThat('A14', 'unsubscribe 后不再收到 workbench:agentEvent', async () => {
    await wbPage.evaluate(() => {
      window.__wbBridgeUnsubscribe();
      window.__wbBridgeEvents = [];
    });
    const secondMarker = 'WB_BRIDGE_EVENT_AFTER_UNSUB';
    await electronApp.evaluate(({ BrowserWindow }, { channel, payload }) => {
      const win = BrowserWindow.getAllWindows().find((candidate) =>
        !candidate.isDestroyed()
        && candidate.webContents
        && candidate.webContents.__acfWorkbenchPartition === 'persist:acf-workbench');
      if (!win) throw new Error('未找到工作台窗口');
      win.webContents.send(channel, payload);
    }, { channel: EXPECTED_EVENT_CHANNEL, payload: { seq: 2, kind: 'status', payload: { marker: secondMarker } } });

    await wbPage.waitForTimeout(700);
    const events = await wbPage.evaluate(() => window.__wbBridgeEvents);
    strict.deepStrictEqual(events, []);
    return { afterUnsubscribeCount: events.length };
  });

  await assertThat('A15', 'cancelAgentAssignment 返回 {ok:boolean}', async () => {
    const result = await wbPage.evaluate(() => window.workbenchApi.cancelAgentAssignment());
    strict.deepStrictEqual(Object.keys(result), ['ok']);
    strict.strictEqual(typeof result.ok, 'boolean');
    return { result };
  });

  await assertThat('A16', '四页窗口 electronAPI 无 workbenchApi', async () => {
    const fourPageUrl = `${stub.baseUrl}/four-page-probe`;
    const windowPromise = electronApp.waitForEvent('window', { timeout: FIRST_WINDOW_TIMEOUT_MS });
    const created = await electronApp.evaluate(({ BrowserWindow }, { preloadPath, url }) => {
      const win = new BrowserWindow({
        width: 900,
        height: 600,
        show: false,
        webPreferences: {
          preload: preloadPath,
          partition: '',
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          webviewTag: false,
        },
      });
      win.loadURL(url);
      return { id: win.id };
    }, { preloadPath: MAIN_PRELOAD, url: fourPageUrl });

    const fourPagePage = await windowPromise;
    await fourPagePage.waitForFunction(
      () => Boolean(window.electronAPI),
      null,
      { timeout: FIRST_WINDOW_TIMEOUT_MS },
    );
    const probe = await fourPagePage.evaluate(() => {
      const keys = Object.keys(window.electronAPI || {}).sort();
      return {
        electronApiPresent: Boolean(window.electronAPI),
        hasWorkbenchApiOnElectronApi: keys.includes('workbenchApi'),
        hasWorkbenchApiGlobal: typeof window.workbenchApi !== 'undefined',
        hasOpenWorkbench: keys.includes('openWorkbench'),
        keyCount: keys.length,
      };
    });
    strict.strictEqual(probe.electronApiPresent, true);
    strict.strictEqual(probe.hasWorkbenchApiOnElectronApi, false);
    strict.strictEqual(probe.hasWorkbenchApiGlobal, false);
    strict.strictEqual(probe.hasOpenWorkbench, true);
    await fourPagePage.close();
    return { created, probe };
  });
}

(async () => {
  let exitCode = 0;
  try {
    await run();
  } catch (error) {
    exitCode = 1;
    failure = {
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? (error.stack || null) : null,
    };
    console.error(`[wb-bridge] FAIL: ${failure.message}`);
  } finally {
    await finalize(exitCode);
  }
  const s = summary();
  console.log(`[wb-bridge] ${exitCode === 0 ? 'PASS' : 'FAIL'} assertions=${s.passed}/${s.total} skipped=${s.skipped}`);
  console.log(`[wb-bridge] evidence: ${paths.evidenceDir}`);
})();
