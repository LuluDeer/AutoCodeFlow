/**
 * 阶段 A（ADR-044）selftest：独立工作台窗口的三条硬契约。
 *
 *  1. preload 白名单形态 —— **从 workbench.ts 源码提取实际 ipcRenderer channel
 *     字面量集合**，与允许集做严格差集；禁用集逐项存在性否决。改源码注释没用，
 *     只有真的把 channel 加回去才会红（变异反证见回报）。 mutation-residue-ok: 说明反证判据非残留变异体
 *  2. loadURL / 导航白名单 —— 拒绝 javascript:/file:/data:/任意 host，
 *     只接受配置的中台同源 http(s) 与同源相对路径。
 *  3. 独立 session partition + 四项 webPreferences 安全配置逐项断言，
 *     并与四页 sharedWebPreferences() 的 defaultSession 形态做差异断言。
 *
 * Run via: npm run test:main（新增条目由主控集成）
 */
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  WORKBENCH_CHANNELS,
  WORKBENCH_CHANNEL_VALUES,
  WORKBENCH_SENDER_FLAG,
  WORKBENCH_SESSION_PARTITION,
  buildWorkbenchWebPreferences,
  isAllowedWorkbenchUrl,
  isWorkbenchSender,
  normalizePartition,
  resolveWorkbenchNavigation,
  resolveWorkbenchUrl,
} from './workbench-window';
import {
  createGuardedIpcMain,
  isTrustedSenderUrl,
  type RawIpcMainLike,
} from './ipc-sender-guard';

const ROOT = path.join(__dirname, '..');
const PRELOAD_SRC = path.join(ROOT, 'src', 'preload', 'workbench.ts');
const WINDOW_SRC = path.join(ROOT, 'src', 'main', 'workbench-window.ts');
const FOUR_PAGE_SRC = path.join(ROOT, 'src', 'main', 'window-manager.ts');
const BASE = 'http://admin.example.local:3105';

function check(label: string, fn: () => void): void {
  fn();
  console.log(`ok - ${label}`);
}

// ── 1. preload 实际暴露的 channel 集合（不是注释 / 命名） ───────────────
{
  const source = fs.readFileSync(PRELOAD_SRC, 'utf8');
  const exposed = new Set<string>();
  const re = /\bipcRenderer\.(?:invoke|invokeSync|send|sendSync|on|once|postMessage)\(\s*['"]([^'"]+)['"]/g;
  for (const match of source.matchAll(re)) exposed.add(match[1]);

  const expected = ['workbench:getUrl', 'workbench:navigate', 'workbench:close'];
  check('workbench preload expose 的 channel 集合严格等于三项白名单', () => {
    assert.deepStrictEqual([...exposed].sort(), [...expected].sort());
    assert.deepStrictEqual([...WORKBENCH_CHANNEL_VALUES].sort(), [...expected].sort());
    assert.strictEqual(WORKBENCH_CHANNELS.getUrl, 'workbench:getUrl');
    assert.strictEqual(WORKBENCH_CHANNELS.navigate, 'workbench:navigate');
    assert.strictEqual(WORKBENCH_CHANNELS.close, 'workbench:close');
    assert.ok(source.includes("exposeInMainWorld('workbenchApi'"), '必须挂在 workbenchApi 命名空间');
  });

  // 禁用集：出现一次就红（含注释里出现也算——src 里刻意不写这些字面量）。
  const forbidden = [
    'config:save', 'config:get', 'executor:stop', 'executor:start',
    'apps:uninstall', 'updater:install', 'agent:get-status', 'config:import',
  ];
  check('workbench preload 绝不含执行器配置/凭据/子进程/卸载/更新 channel', () => {
    for (const channel of forbidden) {
      assert.ok(!source.includes(channel), `workbench preload 泄漏执行器 channel: ${channel}`);
    }
  });

  check('四页全量桥不是工作台 preload（避免共用 PRELOAD_PATH 回潮）', () => {
    assert.ok(!source.includes('bridge-args'), '工作台桥不得复用执行器全量桥依赖');
    assert.ok(!source.includes('electronAPI'), '工作台不得挂四页的 electronAPI 命名空间');
  });
}

// ── 2. loadURL / 导航白名单 ────────────────────────────────────────────
{
  check('resolveWorkbenchUrl 拼接 /workbench，且不硬编码 localhost', () => {
    assert.strictEqual(resolveWorkbenchUrl(BASE), `${BASE}/workbench`);
    assert.strictEqual(resolveWorkbenchUrl(`${BASE}/`), `${BASE}/workbench`);
    assert.strictEqual(resolveWorkbenchUrl(`${BASE}/prefix/`), `${BASE}/prefix/workbench`);
    assert.strictEqual(resolveWorkbenchUrl('https://acf.example.org'), 'https://acf.example.org/workbench');
  });

  check('配置缺失 / 非法协议 / userinfo → 抛明确错误', () => {
    for (const bad of [
      '', '   ', 'javascript:alert(1)', 'file:///etc/passwd', 'data:text/html,x',
      'ftp://admin.example.local', 'http://user:pw@admin.example.local:3105',
      'not-a-url', null, undefined, 42,
    ]) {
      assert.throws(() => resolveWorkbenchUrl(bad), /工作台地址未配置或非法/,
        `非法基址必须拒绝: ${JSON.stringify(bad)}`);
    }
  });

  check('导航白名单只放中台同源 http(s)，拒绝 javascript:/file:/任意 host', () => {
    const workbenchUrl = resolveWorkbenchUrl(BASE);
    for (const ok of [`${BASE}/login`, `${BASE}/artifacts?x=1`, workbenchUrl]) {
      assert.ok(isAllowedWorkbenchUrl(ok, workbenchUrl), `同源 URL 必须放行: ${ok}`);
    }
    for (const bad of [
      'javascript:alert(1)', 'file:///etc/passwd', 'data:text/html,x', 'about:blank',
      'https://evil.example.org/workbench', 'http://admin.example.local:3105.evil.tld/',
      '//evil.example.org/', '', null, undefined, 42,
    ]) {
      assert.ok(!isAllowedWorkbenchUrl(bad, workbenchUrl), `非白名单 URL 必须拒绝: ${JSON.stringify(bad)}`);
    }
  });

  check('workbench:navigate 只接受同源相对路径（防开放重定向）', () => {
    const workbenchUrl = resolveWorkbenchUrl(BASE);
    assert.strictEqual(resolveWorkbenchNavigation('/inbox', workbenchUrl), `${BASE}/inbox`);
    assert.strictEqual(resolveWorkbenchNavigation('/workbench?goal=1', workbenchUrl), `${BASE}/workbench?goal=1`);
    for (const bad of [
      'https://evil.example.org/', '//evil.example.org/', 'javascript:alert(1)',
      'file:///etc/passwd', '', 'inbox', null, 42,
    ]) {
      assert.throws(() => resolveWorkbenchNavigation(bad, workbenchUrl), /工作台导航/,
        `非法导航参数必须拒绝: ${JSON.stringify(bad)}`);
    }
  });
}

// ── 3. 独立 partition / 四项安全配置 ───────────────────────────────────
{
  const prefs = buildWorkbenchWebPreferences();
  check('独立 session partition（persist:acf-workbench，非 defaultSession）', () => {
    assert.strictEqual(prefs.partition, 'persist:acf-workbench');
    assert.strictEqual(WORKBENCH_SESSION_PARTITION, 'persist:acf-workbench');
    assert.notStrictEqual(prefs.partition, '', '四页用 defaultSession(partition="")，工作台必须不同');
    assert.ok(prefs.partition.startsWith('persist:'), '工作台会话需持久化但独立');
  });
  check('contextIsolation:true', () => assert.strictEqual(prefs.contextIsolation, true));
  check('nodeIntegration:false', () => assert.strictEqual(prefs.nodeIntegration, false));
  check('webviewTag:false', () => assert.strictEqual(prefs.webviewTag, false));
  check('sandbox:true 且 preload 指向独立 workbench.js', () => {
    assert.strictEqual(prefs.sandbox, true);
    assert.ok(String(prefs.preload).replace(/\\/g, '/').endsWith('/preload/workbench.js'));
    assert.ok(!String(prefs.preload).includes('index.js'));
  });

  check('createWorkbenchWindow 真用该配置 + loadURL，不挂 webview 标签', () => {
    const source = fs.readFileSync(WINDOW_SRC, 'utf8');
    assert.ok(source.includes('webPreferences: buildWorkbenchWebPreferences()'));
    assert.ok(source.includes('win.loadURL(workbenchUrl)'), '必须 loadURL 而非 webview/loadFile 任意页');
    assert.ok(source.includes("session.fromPartition(WORKBENCH_SESSION_PARTITION)"));
    assert.ok(source.includes('[WORKBENCH_SENDER_FLAG] = WORKBENCH_SESSION_PARTITION'),
      '工作台 webContents 必须打显式 partition 标记（真机 session.partition 读不到值）');
    assert.ok(source.includes("win.webContents.on('will-navigate'"));
    assert.ok(source.includes("win.webContents.on('will-redirect'"));
    assert.ok(source.includes('will-attach-webview'));
  });

  check('四页 sharedWebPreferences() 仍用 defaultSession + 全量 preload/index.js', () => {
    const source = fs.readFileSync(FOUR_PAGE_SRC, 'utf8');
    const start = source.indexOf('function sharedWebPreferences()');
    assert.ok(start >= 0, '四页 webPreferences 源锚点必须存在');
    const end = source.indexOf('\n}', start);
    const block = source.slice(start, end);
    assert.ok(!block.includes('partition:'), '四页不得被工作台 partition 污染');
    assert.ok(block.includes('PRELOAD_PATH'), '四页仍走全量桥');
    assert.ok(source.includes("path.join(__dirname, '../preload/index.js')"));
  });
}

// ── 4. 双向 IPC 隔离：闸的真行为 ───────────────────────────────────────
{
  check('工作台 sender 闸只认中台 origin，四页 file: 页发 workbench:* 被拒', () => {
    const workbenchUrl = resolveWorkbenchUrl(BASE);
    let registered: ((event: unknown, ...args: unknown[]) => unknown) | null = null;
    const raw = {
      handle: (_channel: string, listener: (event: unknown, ...args: unknown[]) => unknown) => {
        registered = listener;
      },
      on: () => undefined,
    } as RawIpcMainLike;
    const guarded = createGuardedIpcMain(raw, { policy: () => ({ devServerUrl: workbenchUrl }) });
    guarded.handle('workbench:getUrl', () => 'ok');
    assert.ok(registered !== null);
    const handler = registered as (event: unknown, ...args: unknown[]) => unknown;
    assert.strictEqual(
      handler({ senderFrame: { url: `${BASE}/workbench`, parent: null } }),
      'ok',
      '工作台自己的同源主 frame 可调用',
    );
    assert.throws(
      () => handler({ senderFrame: { url: 'file:///app/dist/renderer/index.html#status', parent: null } }),
      /IPC sender rejected/,
      '四页 file: 页调到 workbench:* 也必须被拒',
    );
  });

  check('四页 sender 策略拒绝工作台远端 URL（反方向隔离）', () => {
    const workbenchUrl = resolveWorkbenchUrl(BASE);
    assert.strictEqual(
      isTrustedSenderUrl(workbenchUrl, {
        devServerUrl: null,
        rendererIndexPath: '/app/dist/renderer/index.html',
      }),
      false,
    );
  });

  check('session.partition 归一：persist: 前缀两形态指向同一分区', () => {
    assert.strictEqual(normalizePartition(WORKBENCH_SESSION_PARTITION), 'acf-workbench');
    assert.strictEqual(normalizePartition('acf-workbench'), 'acf-workbench');
    assert.notStrictEqual(normalizePartition(''), 'acf-workbench');
    assert.strictEqual(normalizePartition(null), null);
    assert.strictEqual(normalizePartition(42), null);
  });

  check('handler 层 isWorkbenchSender 无窗口时 fail-closed', () => {
    assert.strictEqual(isWorkbenchSender(null), false);
    assert.strictEqual(isWorkbenchSender(undefined), false);
    assert.strictEqual(isWorkbenchSender({ id: 1, session: { partition: WORKBENCH_SESSION_PARTITION } }), false);
    assert.strictEqual(isWorkbenchSender({ id: 1, session: { partition: 'acf-workbench' } }), false);
    assert.strictEqual(isWorkbenchSender({ id: 1, [WORKBENCH_SENDER_FLAG]: WORKBENCH_SESSION_PARTITION }), false);
  });
}

console.log('\nworkbench-window selftest passed');
