/**
 * 桌面端加固定向自测（dev 模式 updater 回执 + 跨端类型契约）。
 *
 * 运行：node src/__tests__/desktop-hardening.selftest.mjs
 *
 * 覆盖边界：
 *  - updater.ts 的纯闸门：未打包 ⇒ ok:false + 稳定哨兵 + development:true；
 *  - ipc-handlers.ts 的 updater:check 必须把闸门结果原样回给渲染层；
 *  - io-result.ts 的中文分支：development 提示独立，旧 Linux 哨兵文案保留；
 *  - electron-api.d.ts / theme-init.ts 的跨端类型声明与去强转。
 *
 * 类型本体由 electron-api.d.ts 内的编译期断言承担，跟随
 * `npm run typecheck:renderer` 一起被 tsc 检查。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, '..');
const readSrc = (rel) => readFileSync(join(SRC, rel), 'utf8');

let checked = 0;
const check = (name, fn) => {
  fn();
  checked += 1;
  console.log(`  ok - ${name}`);
};

const updaterSource = readSrc('main/updater.ts');
const ipcSource = readSrc('main/ipc-handlers.ts');
const dtsSource = readSrc('renderer/electron-api.d.ts');
const themeInitSource = readSrc('renderer/theme/theme-init.ts');

/** 与 updater.ts 纯闸门同构的行为副本；下方源码守卫钉住两者同步。 */
function resolveUpdaterCheckSupportModel(isPackaged, selfUpdateSupported) {
  if (!isPackaged) {
    return { ok: false, error: 'UPDATER_UNSUPPORTED_INSTALL', development: true };
  }
  if (!selfUpdateSupported) {
    return { ok: false, error: 'UPDATER_UNSUPPORTED_INSTALL' };
  }
  return { ok: true };
}

await check('dev 模式 updater:check 回 ok:false + 稳定哨兵 + development 标记', () => {
  assert.deepStrictEqual(resolveUpdaterCheckSupportModel(false, true), {
    ok: false,
    error: 'UPDATER_UNSUPPORTED_INSTALL',
    development: true,
  });
  assert.deepStrictEqual(resolveUpdaterCheckSupportModel(false, false), {
    ok: false,
    error: 'UPDATER_UNSUPPORTED_INSTALL',
    development: true,
  });
});

await check('打包态保留 Linux 非 AppImage 哨兵，正常安装放行', () => {
  assert.deepStrictEqual(resolveUpdaterCheckSupportModel(true, false), {
    ok: false,
    error: 'UPDATER_UNSUPPORTED_INSTALL',
  });
  assert.deepStrictEqual(resolveUpdaterCheckSupportModel(true, true), { ok: true });
});

await check('updater.ts 真实现与行为副本同构（稳定码与分支锁定）', () => {
  assert.match(
    updaterSource,
    /export const UPDATER_UNSUPPORTED_INSTALL = 'UPDATER_UNSUPPORTED_INSTALL' as const;/,
  );
  const start = updaterSource.indexOf('export function resolveUpdaterCheckSupport(');
  const end = updaterSource.indexOf('/**\n * 纯函数：semver', start);
  assert.ok(start >= 0 && end > start, '定位 resolveUpdaterCheckSupport 失败');
  const fn = updaterSource.slice(start, end);
  assert.match(fn, /if \(!isPackaged\) \{/);
  assert.match(
    fn,
    /return \{ ok: false, error: UPDATER_UNSUPPORTED_INSTALL, development: true \};/,
  );
  assert.match(fn, /if \(!selfUpdateSupported\) \{/);
  assert.match(fn, /return \{ ok: false, error: UPDATER_UNSUPPORTED_INSTALL \};/);
  assert.match(fn, /return \{ ok: true \};/);
});

await check('ipc updater:check 先把闸门结果回给渲染层，再跑真实检查', () => {
  const start = ipcSource.indexOf("ipcMain.handle('updater:check'");
  const end = ipcSource.indexOf("ipcMain.handle('updater:download'", start);
  assert.ok(start >= 0 && end > start, '定位 updater:check handler 失败');
  const handler = ipcSource.slice(start, end);
  assert.match(handler, /resolveUpdaterCheckSupport\(/);
  assert.match(handler, /app\.isPackaged/);
  assert.match(handler, /isSelfUpdateSupported\(process\.platform, process\.env\.APPIMAGE\)/);
  assert.match(handler, /if \(!support\.ok\) return support;/);
  assert.match(handler, /await checkForUpdatesUserInitiated\(\);/);
  assert.doesNotMatch(
    handler,
    /return \{ ok: false, error: 'UPDATER_UNSUPPORTED_INSTALL' \};/,
    '旧的内联哨兵分支已撤除，统一走纯闸门',
  );
});

const { planUpdateCheckText, UPDATER_DEV_UNSUPPORTED_TEXT } = await import(
  '../renderer/pages/config/io-result.ts'
);
const texts = {
  initiated: '已发起检查',
  unsupportedInstall: '请用包管理器升级',
  unsupportedSentinel: 'UPDATER_UNSUPPORTED_INSTALL',
};

await check('渲染层 development 分支给出中文提示', () => {
  assert.equal(
    UPDATER_DEV_UNSUPPORTED_TEXT,
    '开发模式不支持自更新检查',
    '中文提示单一事实源',
  );
  assert.equal(
    planUpdateCheckText(
      { ok: false, error: 'UPDATER_UNSUPPORTED_INSTALL', development: true },
      texts,
    ),
    '开发模式不支持自更新检查',
  );
  assert.equal(
    planUpdateCheckText(
      { ok: false, error: 'UPDATER_UNSUPPORTED_INSTALL', development: true },
      { ...texts, devUnsupported: '自定义文案' },
    ),
    '自定义文案',
    '页面注入文案时优先用注入值',
  );
});

await check('旧 Linux 非 AppImage 哨兵与未知错误文案保持原语义', () => {
  assert.equal(
    planUpdateCheckText({ ok: false, error: 'UPDATER_UNSUPPORTED_INSTALL' }, texts),
    '请用包管理器升级',
  );
  assert.equal(planUpdateCheckText({ ok: false, error: 'NETWORK_DOWN' }, texts), 'NETWORK_DOWN');
  assert.equal(planUpdateCheckText({ ok: true }, texts), '已发起检查');
});

await check('switch-tab payload 复用 TabSwitchDetail，不复制定义', () => {
  assert.match(dtsSource, /import type \{ TabSwitchDetail \} from '\.\/tab-switch';/);
  assert.match(
    dtsSource,
    /export type SwitchTabPayload = string \| \(Pick<TabSwitchDetail, 'historyExecutionId'> & \{ tab: string \}\);/,
  );
  assert.match(
    dtsSource,
    /onSwitchTab: \(cb: \(payload: SwitchTabPayload\) => void\) => \(\) => void;/,
  );
  assert.match(dtsSource, /type _SwitchTabAcceptsString = Assert<string extends SwitchTabPayload \? true : false>;/);
  assert.match(dtsSource, /type _SwitchTabAcceptsDetail = Assert</);
});

await check('bootTheme 同步快照声明补齐，theme-init 去掉类型缺口强转', () => {
  assert.match(dtsSource, /bootTheme: ThemeMode \| null;/);
  assert.match(dtsSource, /type _BootThemeSnapshot = Assert</);
  assert.match(themeInitSource, /parseThemeMode\(window\.electronAPI\?\.bootTheme\)/);
  assert.doesNotMatch(themeInitSource, /as unknown as/);
  assert.doesNotMatch(themeInitSource, /bootThemeRaw/);
});

console.log(`desktop-hardening.selftest: ${checked} checks passed`);
