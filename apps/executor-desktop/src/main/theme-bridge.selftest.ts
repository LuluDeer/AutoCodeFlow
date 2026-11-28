/**
 * ⑤ 暗色分面：主进程主题纯决策层 selftest（node:assert，无 Electron）。
 *
 * 钉死的行为：
 *  · 模式归一：合法三态直通；非法 / 缺省 / 非字符串一律回落 'system'；
 *  · 解析：light/dark 不受系统偏好影响；system 跟随 prefersDark；
 *  · resolveStoredTheme 一步完成坏值归一 + 解析；
 *  · P3 首帧快照三端接线：主进程从 configStore.get('theme') 取值并经
 *    parseThemeMode 消毒；preload 同步过桥；theme-init 先于 localStorage 消费。
 *
 * Run via: npm run test:main
 */
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  parseThemeMode,
  resolveStoredTheme,
  resolveThemeMode,
} from './theme-bridge';

function main(): void {
  // ── parseThemeMode：合法直通 / 坏值回落 system ──────────────
  assert.equal(parseThemeMode('light'), 'light');
  assert.equal(parseThemeMode('dark'), 'dark');
  assert.equal(parseThemeMode('system'), 'system');
  for (const bad of [undefined, null, '', 'fr', 'DARK', 42, {}, []]) {
    assert.equal(parseThemeMode(bad), 'system', `坏值 ${String(bad)} 回落 system`);
  }

  // ── resolveThemeMode：显式态压过系统偏好；system 跟随偏好 ──
  assert.equal(resolveThemeMode('light', true), 'light');
  assert.equal(resolveThemeMode('dark', false), 'dark');
  assert.equal(resolveThemeMode('system', true), 'dark');
  assert.equal(resolveThemeMode('system', false), 'light');

  // ── resolveStoredTheme：坏原始值 + 偏好解析 ─────────────────
  assert.equal(resolveStoredTheme(undefined, false), 'light');
  assert.equal(resolveStoredTheme(undefined, true), 'dark');
  assert.equal(resolveStoredTheme('dark', false), 'dark');
  assert.equal(resolveStoredTheme('light', true), 'light');
  assert.equal(resolveStoredTheme('system', true), 'dark');

  // ── P3 首帧快照：值来自 config，且 theme-init 优先消费 ──────────────
  // 行为层：快照值域只有三态，坏值一律 system（上面 parseThemeMode 的用例已覆盖，
  // 这里钉"快照通道确实走这个归一函数"，避免哪天主进程绕开消毒裸透 config）。
  const readSrc = (rel: string): string =>
    fs.readFileSync(path.join(__dirname, '..', 'src', rel), 'utf8');
  const ipc = readSrc('main/ipc-handlers.ts');
  const bootStart = ipc.indexOf("ipcMain.on('theme:boot-snapshot'");
  assert.ok(bootStart >= 0, '主进程必须注册 theme:boot-snapshot 同步快照通道');
  const bootNext = ipc.indexOf('ipcMain.handle(', bootStart);
  const bootBlock = ipc.slice(bootStart, bootNext >= 0 ? bootNext : ipc.length);
  assert.ok(bootBlock.includes("configStore.get('theme')"), '快照必须取自 configStore.get(theme)');
  assert.ok(bootBlock.includes('parseThemeMode('), '快照必须经 parseThemeMode 消毒（只过三态）');
  assert.ok(!bootBlock.includes('getAll('), '快照不得把整份配置过桥（含 token 掩码等字段）');
  assert.ok(bootBlock.includes('event.returnValue'), '同步 IPC 必须写 event.returnValue');

  const preload = readSrc('preload/index.ts');
  assert.ok(
    preload.includes("ipcRenderer.sendSync('theme:boot-snapshot')"),
    'preload 必须在页面脚本前同步取快照',
  );
  assert.strictEqual(
    (preload.match(/ipcRenderer\.sendSync\(/g) ?? []).length,
    1,
    '同步过桥全仓只此一处（热路径一律 invoke）',
  );
  assert.ok(preload.includes('bootTheme: bootTheme'), 'preload 必须把快照挂进 electronAPI 单对象');

  const init = readSrc('renderer/theme/theme-init.ts');
  // 快照通道现形为 `parseThemeMode(window.electronAPI?.bootTheme)`（先消毒三态，
  // 再以 bootMode 身份进入 fallback）；旧断言只认 `bootThemeRaw` 变量名，属于
  // 前提过期——这里钉住真实链路：读快照在前，且 sanitized 值确实作为
  // readStoredModeOrFallback 的 fallback 实参。
  const bootIdx = init.indexOf('parseThemeMode(window.electronAPI?.bootTheme)');
  const fallbackIdx = init.indexOf('readStoredModeOrFallback(storage, bootMode)');
  assert.ok(
    bootIdx >= 0 && fallbackIdx > bootIdx,
    'theme-init 必须先读快照（经 parseThemeMode 归一）再作为 localStorage fallback',
  );
  assert.ok(!init.includes('readStoredMode(storage)'), '旧的无快照兜底路径不得残留');

  console.log('theme-bridge selftest: all assertions passed');
}

main();
