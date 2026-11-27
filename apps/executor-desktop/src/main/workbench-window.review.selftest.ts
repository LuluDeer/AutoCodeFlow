/**
 * 独立验收审查 selftest（verify-wbwindow，只读审查产物，非生产源码）。
 *
 * 刻意不 import impl 的 workbench-window.selftest.ts：本文件独立复现
 * 「preload 实际 channel 集合 / BrowserWindow 安全配置 / URL 守卫 / IPC 双收窄 /
 * 四页桥未被污染」断言，并自带变异反证（全量 preload 必须真红）。 mutation-residue-ok: 此处仅描述反证方法非残留变异体
 *
 * test:main 是显式枚举脚本，不含本文件；手动运行：
 *   npx tsc --outDir dist-selftest --rootDir src/main --module node16 \
 *     --moduleResolution node16 --target ES2020 --lib ES2020 --strict \
 *     --esModuleInterop --skipLibCheck --resolveJsonModule --sourceMap false \
 *     src/main/workbench-window.review.selftest.ts
 *   node dist-selftest/workbench-window.review.selftest.js
 */
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  buildWorkbenchWebPreferences,
  isAllowedWorkbenchUrl,
  resolveWorkbenchUrl,
  WORKBENCH_CHANNELS,
  WORKBENCH_CHANNEL_VALUES,
  WORKBENCH_SESSION_PARTITION,
} from './workbench-window';

const ROOT = path.join(__dirname, '..');
const PRELOAD = path.join(ROOT, 'src', 'preload', 'workbench.ts');
const FULL_PRELOAD = path.join(ROOT, 'src', 'preload', 'index.ts');
const WINDOW = path.join(ROOT, 'src', 'main', 'workbench-window.ts');
const IPC = path.join(ROOT, 'src', 'main', 'workbench-ipc.ts');
const WINDOW_MGR = path.join(ROOT, 'src', 'main', 'window-manager.ts');

const EXPECTED_INVOKE = [
  'workbench:getDesktopContext',
  'workbench:cancelAgentAssignment',
  'workbench:pickLocalFiles',
  'workbench:getRecentAgentEvents',
].sort();

const EXPECTED_INVOKE_KEYS = [
  'getDesktopContext',
  'cancelAgentAssignment',
  'pickLocalFiles',
  'getRecentAgentEvents',
].sort();

const EXPECTED_EXPOSED = [
  ...EXPECTED_INVOKE,
  'workbench:agentEvent',
].sort();

const RETIRED = [
  'workbench:getUrl',
  'workbench:navigate',
  'workbench:close',
] as const;

const FORBIDDEN = [
  'config:save', 'config:get', 'config:import', 'executor:stop', 'executor:start',
  'apps:uninstall', 'updater:install', 'agent:get-status',
];

function readChannels(src: string): string[] {
  const found = new Set<string>();
  const re = /\bipcRenderer\.(?:invoke|invokeSync|send|sendSync|on|once|postMessage)\(\s*['"]([^'"]+)['"]/g;
  for (const m of src.matchAll(re)) found.add(m[1]);
  return [...found].sort();
}

function assertWhiteList(src: string, label: string): void {
  assert.deepStrictEqual(readChannels(src), EXPECTED_EXPOSED,
    `${label}: channel 集合必须严格等于四 invoke + 一 event`);
  for (const channel of FORBIDDEN) {
    assert.ok(!src.includes(channel), `${label}: 禁用 channel 出现 —— ${channel}`);
  }
}

let passed = 0;
function ok(label: string): void {
  passed += 1;
  console.log(`ok - ${label}`);
}

// ── 1. workbench preload 正面：代码级暴露面 ─────────────────────────────
{
  const src = fs.readFileSync(PRELOAD, 'utf8');
  assertWhiteList(src, 'workbench preload');
  assert.deepStrictEqual([...WORKBENCH_CHANNEL_VALUES].sort(), EXPECTED_INVOKE,
    'WORKBENCH_CHANNEL_VALUES 必须严格等于四 invoke，事件订阅不在其中');
  assert.deepStrictEqual(Object.keys(WORKBENCH_CHANNELS).sort(), EXPECTED_INVOKE_KEYS,
    'WORKBENCH_CHANNELS 的 key 也必须严格等于四 invoke');
  assert.ok(src.includes("exposeInMainWorld('workbenchApi'"), '必须挂独立 workbenchApi 命名空间');
  assert.ok(!src.includes('electronAPI'), '不得挂四页 electronAPI 命名空间');
  for (const forbiddenToken of ['filePath', 'executorToken', 'getConfig:', 'config:save:', 'shell:']) {
    assert.ok(!src.includes(forbiddenToken), `工作台桥不得出现 ${forbiddenToken}`);
  }
  ok('workbench preload 实际 channel 严格等于四 invoke + 一 event，禁用 channel 零出现');
}

// ── 2. 退役通道零出现：preload / channel 源 / ipc handler 源 ──────────────
{
  const src = fs.readFileSync(PRELOAD, 'utf8');
  const win = fs.readFileSync(WINDOW, 'utf8');
  const ipc = fs.readFileSync(IPC, 'utf8');
  for (const channel of RETIRED) {
    assert.ok(!src.includes(channel), `workbench preload 仍含退役 channel: ${channel}`);
    assert.ok(!win.includes(channel), `WORKBENCH_CHANNELS 源仍含退役 channel: ${channel}`);
    assert.ok(!ipc.includes(channel), `workbench-ipc handler 源仍含退役 channel: ${channel}`);
  }
  ok('退役三通道在三处源码中零出现');
}

// ── 3. 变异反证：全量 preload 必须让同一断言真红 ───────────────────────── mutation-residue-ok: 反证用例标题非残留变异体
{
  const full = fs.readFileSync(FULL_PRELOAD, 'utf8');
  let turnedRed = false;
  let reason = '';
  try {
    assertWhiteList(full, 'full preload');
  } catch (err) {
    turnedRed = true;
    reason = err instanceof Error ? err.message.split('\n')[0] : String(err);
  }
  assert.ok(turnedRed, `变异反证失败：全量 preload 竟通过白名单断言（断言不够严/假绿）：${reason}`); // mutation-residue-ok: 反证断言消息非残留变异体
  assert.ok(
    FORBIDDEN.some((channel) => full.includes(channel)),
    '全量 preload 必须确实含有禁用 channel，否则反证靶点无效',
  );
  ok(`变异反证成立：换成全量 preload 后断言真红（${reason.slice(0, 60)}…）`); // mutation-residue-ok: 反证成功消息非残留变异体
}

// ── 4. BrowserWindow 四项安全配置（独立断言，不依赖 impl selftest） ─────
{
  const prefs = buildWorkbenchWebPreferences();
  assert.strictEqual(prefs.partition, WORKBENCH_SESSION_PARTITION);
  assert.strictEqual(WORKBENCH_SESSION_PARTITION, 'persist:acf-workbench');
  assert.notStrictEqual(prefs.partition, '', '四页用 defaultSession，工作台必须独立');
  assert.strictEqual(prefs.contextIsolation, true);
  assert.strictEqual(prefs.nodeIntegration, false);
  assert.strictEqual(prefs.webviewTag, false);
  assert.strictEqual(prefs.sandbox, true);
  assert.ok(String(prefs.preload).replace(/\\/g, '/').endsWith('/preload/workbench.js'));
  ok('partition 独立 + contextIsolation/nodeIntegration/webviewTag/sandbox 逐项成立');
}

// ── 5. loadURL 安全：协议白名单 + 同源（导航 invoke 已退役） ──────────────
{
  const base = 'https://acf.example.org';
  const workbenchUrl = resolveWorkbenchUrl(base);
  assert.strictEqual(workbenchUrl, `${base}/workbench`);
  for (const bad of ['', 'javascript:alert(1)', 'file:///etc/passwd', 'data:text/html,x',
    'ftp://acf.example.org', 'http://u:p@acf.example.org', null, undefined, 42]) {
    assert.throws(() => resolveWorkbenchUrl(bad), /工作台地址未配置或非法/);
  }
  assert.ok(isAllowedWorkbenchUrl(`${base}/login`, workbenchUrl));
  for (const bad of ['javascript:alert(1)', 'file:///etc/passwd', 'data:text/html,x',
    'https://evil.tld/workbench', `${base}.evil.tld/`, '//evil.tld/', null]) {
    assert.strictEqual(isAllowedWorkbenchUrl(bad, workbenchUrl), false, `必须拒绝: ${JSON.stringify(bad)}`);
  }
  ok('loadURL 只接受 http(s)+配置同源；javascript:/file:/data:/任意 host 全拒');
}

// ── 6. 源码锚点：窗口真用独立配置 + IPC 双收窄 + 四页桥未污染 ────────────
{
  const win = fs.readFileSync(WINDOW, 'utf8');
  for (const [label, needle] of [
    ['独立 partition 常量', "WORKBENCH_SESSION_PARTITION = 'persist:acf-workbench'"],
    ['preload 指向 workbench.js', "path.join(__dirname, '../preload/workbench.js')"],
    ['window 使用独立 webPreferences', 'webPreferences: buildWorkbenchWebPreferences()'],
    ['独立 session', 'session.fromPartition(WORKBENCH_SESSION_PARTITION)'],
    ['loadURL 而非 loadFile', 'win.loadURL(workbenchUrl)'],
    ['will-navigate 守卫', "win.webContents.on('will-navigate'"],
    ['will-redirect 守卫', "win.webContents.on('will-redirect'"],
    ['webview attach 拒绝', 'will-attach-webview'],
  ] as const) {
    assert.ok(win.includes(needle), `workbench-window.ts 缺少锚点: ${label}`);
  }

  const ipc = fs.readFileSync(IPC, 'utf8');
  assert.ok(ipc.includes('createGuardedIpcMain('), 'IPC 必须有 guarded sender URL 闸');
  assert.ok(ipc.includes('isWorkbenchSender(event.sender)'), 'IPC 必须有 window/partition 双收窄');
  assert.ok(!/\bipcMain\.(?:handle|on)\(['"]workbench:/.test(ipc), '不得绕过 guarded 直注册 workbench channel');

  const wm = fs.readFileSync(WINDOW_MGR, 'utf8');
  assert.ok(wm.includes("path.join(__dirname, '../preload/index.js')"), '四页仍用全量桥');
  assert.ok(!wm.includes('persist:acf-workbench'), '四页 window-manager 不得被工作台 partition 污染');
  ok('窗口/IPC/四页桥源码锚点全部成立（含四页零污染）');
}

console.log(`\nworkbench-window.review selftest passed (${passed} checks)`);
