/**
 * F-27（UIUX 审计 2026-10-25）：ui-texts selftest（node:assert，无测试框架）。
 * 直接驱动 src/main/ui-texts.ts 的真实实现（该模块无 electron 依赖）：
 *   · 双语文案表键位对齐（两语言必须提供同一组键，防止只改一种语言造成
 *     静默缺键——与 tray-texts.selftest / renderer.selftest 的 N-04 同意图）；
 *   · zh/en 每条值非空；
 *   · 同一键在两语言中的 {var} 占位符集合必须一致（插值不漏填/错位）；
 *   · uiText 插值与缺键回退行为；
 *   · 通知/对话框消费面的关键键必须存在（防止键名重命名后调用点静默回退
 *     到键名本身）。
 * Run via: npm run test:main
 */
import * as assert from 'node:assert';
import { UI_TEXTS, uiText, uiTextPlaceholderNames } from './ui-texts';

function main(): void {
  const zh = UI_TEXTS.zh;
  const en = UI_TEXTS.en;

  // ── 键位对齐 + 非空 + 占位符一致 ─────────────────────────────
  assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort(), 'locale key sets must match');
  assert.ok(Object.keys(zh).length > 0, 'text table must not be empty');
  for (const key of Object.keys(zh)) {
    const a = zh[key];
    const b = en[key];
    assert.ok(typeof a === 'string' && a.trim() !== '', `zh.${key} must be a non-empty string`);
    assert.ok(typeof b === 'string' && b.trim() !== '', `en.${key} must be a non-empty string`);
    assert.deepEqual(
      uiTextPlaceholderNames(a).sort(),
      uiTextPlaceholderNames(b).sort(),
      `placeholder sets must match for key ${key}`,
    );
  }

  // ── uiText：直出 / 插值 / 缺键回退 ──────────────────────────
  assert.equal(uiText('zh', 'dialog.confirm.cancel'), '取消');
  assert.equal(uiText('en', 'dialog.confirm.cancel'), 'Cancel');
  assert.equal(
    uiText('zh', 'notify.task.durationSuffix', { duration: '5s' }),
    '耗时 5s',
    '插值：数字/字符串均可',
  );
  assert.equal(
    uiText('zh', 'notify.updateAvailable.body', { version: '1.9.4' }),
    '新版本 1.9.4 已可升级，可在状态页下载安装',
  );
  assert.equal(
    uiText('en', 'notify.updateAvailable.bodyCached', { version: '1.9.4' }),
    'Version 1.9.4 was downloaded earlier and can be installed directly from the status page (reusing the local cache).',
  );
  assert.equal(uiText('zh', 'no.such.key'), 'no.such.key', '缺键回退键名本身（肉眼可见）');

  // ── 消费面关键键必须存在（键名重命名 → 这里红，而不是调用点静默回退）──
  const requiredKeys = [
    // notifier.ts
    'notify.executorOffline.title', 'notify.executorOffline.body',
    'notify.taskSuccess.title', 'notify.taskFailed.title',
    'notify.task.durationSuffix', 'notify.task.exitCodeSuffix',
    'notify.updateAvailable.title', 'notify.updateAvailable.body', 'notify.updateAvailable.bodyCached',
    // ipc-handlers.ts 对话框
    'dialog.confirm.cancel', 'dialog.confirm.continue', 'dialog.confirm.message',
    'dialog.restart.accept', 'dialog.restart.defer', 'dialog.restart.message', 'dialog.restart.detail',
    'dialog.exportConfig.title', 'dialog.importConfig.title',
    'dialog.exportDiagnostics.title', 'dialog.exportExecLog.title',
  ];
  for (const key of requiredKeys) {
    assert.ok(key in zh && key in en, `required ui-text key missing: ${key}`);
  }

  console.log('ui-texts selftest: all assertions passed (F-27 zh/en key parity, non-empty, placeholder parity, interpolation, consumer keys)');
}

main();
