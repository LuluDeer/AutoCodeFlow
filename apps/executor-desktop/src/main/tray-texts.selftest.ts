/**
 * 审计二轮 B-7②：tray-texts selftest（node:assert，无测试框架）。
 * 直接驱动 src/main/tray-texts.ts 的真实实现（该模块无 electron 依赖）：
 *   · locale 判定（en* 英文，其余回落中文，含空串/未知 locale）；
 *   · i18n-DESK-01：**界面语言设置**（uiLanguage）优先于 app.getLocale()，
 *     'auto' = 跟随系统语言（zh*→zh，其余含未支持语言→en），非法值 = 默认英文（与渲染层 renderer.selftest.mjs
 *     的同一组用例对称——两端共用 ui-language.ts 的同一份规则）；
 *   · linux click 支持判定；
 *   · 双语文案表键位对齐（两语言必须提供同一组键/同一组函数，防止后续
 *     只改一种语言造成静默缺键）。
 * Run via: npm run test:main
 */
import * as assert from 'node:assert';
import { TRAY_TEXTS, resolveTrayLocale, traySupportsClick } from './tray-texts';
import { resolveUiLanguage } from './ui-language';

function main(): void {
  // ── locale 判定 ──────────────────────────────────────────────
  assert.equal(resolveTrayLocale(() => 'en-US'), 'en', 'en-US → en');
  assert.equal(resolveTrayLocale(() => 'en'), 'en', 'en → en');
  assert.equal(resolveTrayLocale(() => 'en_GB'), 'en', 'en_GB → en');
  assert.equal(resolveTrayLocale(() => 'zh-CN'), 'zh', 'zh-CN → zh');
  // LANG-DEFAULT：产品要求「默认英文，但优先跟随系统语言」——只有系统**确实是
  // 中文**才给中文，未支持语言（fr/空/未知）一律回落**英文**（旧口径是"非 en
  // 即中文"，一台法语机器会拿到中文界面）。
  assert.equal(resolveTrayLocale(() => 'fr-FR'), 'en', 'unsupported locale falls back to en');
  assert.equal(resolveTrayLocale(() => ''), 'en', 'empty locale falls back to en');
  // 大小写不敏感（个别平台报 EN-us 形态）
  assert.equal(resolveTrayLocale(() => 'EN-us'), 'en', 'case-insensitive en prefix');

  // ── i18n-DESK-01：界面语言**设置**优先于 app.getLocale() ─────────────
  // 反证过的真实缺口：改动前托盘只有「按系统语言自动判定」，用户在设置页
  // 选了语言也无处生效（英文系统上永远看不到中文托盘菜单）。以下三组断言
  // 钉住「显式设置赢」「auto = 跟随系统语言」「非法值 = 默认英文」。
  {
    // ① 显式设置赢过系统语言（两个方向都要，防止"只测试了 en 赢"）
    assert.equal(resolveTrayLocale(() => 'en-US', 'zh'), 'zh', "显式 'zh' 必须赢过 app.getLocale()='en-US'");
    assert.equal(resolveTrayLocale(() => 'zh-CN', 'en'), 'en', "显式 'en' 必须赢过 app.getLocale()='zh-CN'");
    // ② 'auto' = 跟随系统语言（产品要求：默认英文，但优先跟随系统语言）
    assert.equal(resolveTrayLocale(() => 'en-US', 'auto'), 'en', "'auto' + en-US → en（既有判定）");
    assert.equal(resolveTrayLocale(() => 'zh-CN', 'auto'), 'zh', "'auto' + zh-CN → zh（既有判定）");
    assert.equal(resolveTrayLocale(() => 'fr-FR', 'auto'), 'en', "'auto' + 未支持语言 → en（默认英文）");
    // ③ 非法值（手改 config.json 进来的值）→ 默认英文，而不是回落自动判定
    assert.equal(resolveTrayLocale(() => 'en-US', 'fr'), 'en', "非法值 'fr' 必须按默认英文，不得回落 en-US 判定");
    assert.equal(resolveTrayLocale(() => 'en-US', ''), 'en', "空串设置 → 默认英文");
    assert.equal(resolveTrayLocale(() => 'en-US', 42), 'en', '非字符串设置 → 默认英文');
    assert.equal(resolveTrayLocale(() => 'en-US', null), 'en', 'null 设置 → 默认英文');
    // ④ 大小写/空白归一化
    assert.equal(resolveTrayLocale(() => 'zh-CN', '  EN  '), 'en', '设置值大小写/空白不敏感');
    // ⑤ 显式设置下**不该**再读系统语言（读 = 判定层还在偷看 getLocale）
    let localeReads = 0;
    resolveTrayLocale(() => { localeReads++; return 'en-US'; }, 'zh');
    assert.equal(localeReads, 0, "显式设置生效时不得调用 getLocale()（否则是'设置没赢'的另一种写法）");
    // ⑥ 与判定层的**同一份**规则同源（tray-texts 只是收窄类型，不复制逻辑）
    assert.equal(resolveUiLanguage(() => 'en-US', 'zh'), resolveTrayLocale(() => 'en-US', 'zh'), 'SYNC: 托盘与 ui-language 判定必须同源');
  }

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

  // ── V4 审计 P2：托盘菜单拓展两个新项（checkUpdate / openLogFolder）──
  // e2e n10 用例2 按label 逐项匹配真实 Menu，这里逐字节钉值与其同源。
  assert.equal(zh.checkUpdate, '检查更新...', 'zh.checkUpdate（托盘 e2e 按 label 匹配）');
  assert.equal(zh.openLogFolder, '打开日志文件夹', 'zh.openLogFolder');
  assert.equal(en.checkUpdate, 'Check for Updates...', 'en.checkUpdate');
  assert.equal(en.openLogFolder, 'Open Log Folder', 'en.openLogFolder');

  console.log('tray-texts selftest: all assertions passed (bilingual table + locale/click rules)');
}

main();
