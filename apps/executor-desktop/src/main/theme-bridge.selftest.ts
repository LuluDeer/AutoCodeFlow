/**
 * ⑤ 暗色分面：主进程主题纯决策层 selftest（node:assert，无 Electron）。
 *
 * 钉死的行为：
 *  · 模式归一：合法三态直通；非法 / 缺省 / 非字符串一律回落 'system'；
 *  · 解析：light/dark 不受系统偏好影响；system 跟随 prefersDark；
 *  · resolveStoredTheme 一步完成坏值归一 + 解析。
 *
 * Run via: npm run test:main
 */
import * as assert from 'node:assert';
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

  console.log('theme-bridge selftest: all assertions passed');
}

main();
