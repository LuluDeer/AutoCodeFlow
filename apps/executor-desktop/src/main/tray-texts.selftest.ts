/**
 * 审计二轮 B-7②：tray-texts selftest（node:assert，无测试框架）。
 * 直接驱动 src/main/tray-texts.ts 的真实实现（该模块无 electron 依赖）：
 *   · locale 判定（en* 英文，其余回落中文，含空串/未知 locale）；
 *   · linux click 支持判定；
 *   · 双语文案表键位对齐（两语言必须提供同一组键/同一组函数，防止后续
 *     只改一种语言造成静默缺键）。
 * Run via: npm run test:main
 */
import * as assert from 'node:assert';
import { TRAY_TEXTS, resolveTrayLocale, traySupportsClick } from './tray-texts';

function main(): void {
  // ── locale 判定 ──────────────────────────────────────────────
  assert.equal(resolveTrayLocale(() => 'en-US'), 'en', 'en-US → en');
  assert.equal(resolveTrayLocale(() => 'en'), 'en', 'en → en');
  assert.equal(resolveTrayLocale(() => 'en_GB'), 'en', 'en_GB → en');
  assert.equal(resolveTrayLocale(() => 'zh-CN'), 'zh', 'zh-CN → zh');
  assert.equal(resolveTrayLocale(() => 'fr-FR'), 'zh', 'unknown locale falls back to zh');
  assert.equal(resolveTrayLocale(() => ''), 'zh', 'empty locale falls back to zh');
  // 大小写不敏感（个别平台报 EN-us 形态）
  assert.equal(resolveTrayLocale(() => 'EN-us'), 'en', 'case-insensitive en prefix');

  // ── linux click 支持 ────────────────────────────────────────
  assert.equal(traySupportsClick('darwin'), true, 'macOS supports tray click');
  assert.equal(traySupportsClick('win32'), true, 'Windows supports tray click');
  assert.equal(traySupportsClick('linux'), false, 'Linux AppIndicator has no click event');

  // ── 双语文案表键位对齐 ───────────────────────────────────────
  const zh = TRAY_TEXTS.zh;
  const en = TRAY_TEXTS.en;
  assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort(), 'locale key sets must match');
  for (const key of Object.keys(zh) as Array<keyof typeof zh>) {
    const a = zh[key];
    const b = en[key];
    assert.equal(typeof a, typeof b, `same value type for key ${key}`);
    if (typeof a === 'string') {
      assert.ok((a as string).length > 0, `zh.${key} must be non-empty`);
      assert.ok((b as string).length > 0, `en.${key} must be non-empty`);
    } else if (typeof a === 'function') {
      assert.equal(typeof b, 'function', `en.${key} function field`);
    } else {
      // Record 型字段（tooltip / statusLabel）：两侧的子键集合必须一致且非空
      assert.equal(typeof b, typeof a, `en.${key} record field`);
      assert.deepEqual(
        Object.keys(a as Record<string, string>).sort(),
        Object.keys(b as Record<string, string>).sort(),
        `en/zh.${key} record keys must match`,
      );
      for (const [k, v] of Object.entries(a as Record<string, string>)) {
        assert.ok(v.length > 0, `zh.${key}.${k} must be non-empty`);
        assert.ok((b as Record<string, string>)[k].length > 0, `en.${key}.${k} must be non-empty`);
      }
    }
  }
  for (const status of ['online', 'offline', 'pending', 'stopped'] as const) {
    assert.ok(zh.tooltip[status].length > 0, `zh.tooltip.${status} non-empty`);
    assert.ok(en.tooltip[status].length > 0, `en.tooltip.${status} non-empty`);
    assert.ok(zh.statusLabel[status].length > 0, `zh.statusLabel.${status} non-empty`);
    assert.ok(en.statusLabel[status].length > 0, `en.statusLabel.${status} non-empty`);
  }

  // 文案函数行为抽查
  assert.equal(zh.agentLine('工作中'), 'Agent：工作中');
  assert.equal(en.agentLine('working'), 'Agent: working');
  assert.equal(zh.agentSuffix('工作中'), '；Agent：工作中');
  assert.equal(en.agentSuffix('working'), '; Agent: working');
  assert.equal(zh.agentProcessedLine(3, '成功'), 'Agent 已处理 3 个指派；最近结果：成功');
  assert.equal(en.agentProcessedLine(3, 'ok'), 'Agent processed 3 assignments; last outcome: ok');

  // ── NETOPT-DEBT 双语收尾：Agent 活动/结果标签入表（消费方 agent-status-view）──
  // 键位对齐已由上方通用循环覆盖（agentActivity / agentOutcomes 是 Record 型字段），
  // 这里钉住具体值，防止改值时把收尾前的中文残留回去。
  assert.equal(zh.agentActivity.working, '正在处理指派');
  assert.equal(zh.agentActivity.workingAfterStop, '正在处理当前指派（已停止接新单）');
  assert.equal(zh.agentActivity.disabled, '未启用');
  assert.equal(zh.agentActivity.awaitingConfig, '已启用，等待完成连接配置');
  assert.equal(zh.agentActivity.polling, '已启用，正在轮询指派');
  assert.equal(zh.agentOutcomes.none, '暂无');
  assert.equal(zh.agentOutcomes.delivered, '候选应用已交付');
  assert.equal(en.agentActivity.working, 'Working on an assignment');
  assert.equal(en.agentActivity.disabled, 'Not enabled');
  assert.equal(en.agentActivity.polling, 'Enabled, polling for assignments');
  assert.equal(en.agentOutcomes.none, 'None yet');
  assert.equal(en.agentOutcomes.delivered, 'Candidate app delivered');
  assert.equal(en.agentOutcomes.permission_denied, 'Permission denied');

  console.log('tray-texts selftest: all assertions passed (bilingual table + locale/click rules)');
}

main();
