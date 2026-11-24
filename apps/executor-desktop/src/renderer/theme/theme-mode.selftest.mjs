import assert from 'node:assert/strict';
import {
  THEME_STORAGE_KEY,
  applyThemeAttribute,
  parseThemeMode,
  readStoredMode,
  resolveTheme,
  writeStoredMode,
} from './theme-mode.ts';

// 伪 Storage（Map 承载），裸 Node 下驱动读写与持久化键断言。
function fakeStorage(initial = {}) {
  const m = new Map(Object.entries(initial));
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    _map: m,
  };
}

// 1. parseThemeMode：合法三态原样归一；非法/缺省回落 system。
assert.equal(parseThemeMode('light'), 'light');
assert.equal(parseThemeMode('dark'), 'dark');
assert.equal(parseThemeMode('system'), 'system');
for (const bad of [undefined, null, 'foo', 42, '', true, {}]) {
  assert.equal(parseThemeMode(bad), 'system', `非法值 ${String(bad)} 回落 system`);
}

// 2. resolveTheme：显式 light/dark 不随系统偏好翻转；system 跟随 prefersDark。
assert.equal(resolveTheme('light', true), 'light');
assert.equal(resolveTheme('light', false), 'light');
assert.equal(resolveTheme('dark', true), 'dark');
assert.equal(resolveTheme('dark', false), 'dark');
assert.equal(resolveTheme('system', true), 'dark');
assert.equal(resolveTheme('system', false), 'light');

// 3. readStoredMode：读出合法值；损坏值回落 system；存储不可用回落 system。
assert.equal(readStoredMode(fakeStorage({ [THEME_STORAGE_KEY]: 'dark' })), 'dark');
assert.equal(readStoredMode(fakeStorage({ [THEME_STORAGE_KEY]: 'neon' })), 'system');
assert.equal(readStoredMode(fakeStorage()), 'system');
assert.equal(readStoredMode(null), 'system');

// 4. writeStoredMode：写入约定键；存储不可用不抛错。
const storage = fakeStorage();
writeStoredMode('dark', storage);
assert.equal(storage._map.get(THEME_STORAGE_KEY), 'dark');
assert.doesNotThrow(() => writeStoredMode('system', null));

// 5. applyThemeAttribute：data-theme + color-scheme 双写根元素。
const root = { dataset: {}, style: {} };
applyThemeAttribute(root, 'dark');
assert.equal(root.dataset.theme, 'dark');
assert.equal(root.style.colorScheme, 'dark');
applyThemeAttribute(root, 'light');
assert.equal(root.dataset.theme, 'light');
assert.equal(root.style.colorScheme, 'light');

console.log('theme-mode selftest: all assertions passed');
