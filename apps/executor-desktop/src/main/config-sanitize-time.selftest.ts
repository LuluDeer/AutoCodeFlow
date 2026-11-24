/**
 * ③ 静默时段时刻（HH:MM）消毒 + SYNC 对齐 selftest（node:assert，无 Electron）。
 *
 * 从 config-sanitize.selftest.ts 拆出：时刻字段的合法/非法消毒与
 * config-store defaults 对齐断言独立成文件，压住长自测脚本的体量棘轮。
 *
 * 钉死的行为：
 *  · 合法 HH:MM 保留并去空白；非法 / 非字符串回落字段默认时刻（不丢键）；
 *  · TIME_FIELDS 每个键必须出现在 config-store.ts 且进 defaults 块。
 *
 * Run via: npm run test:main
 */
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { TIME_FIELDS, sanitizeConfigInput } from './config-sanitize';

function main(): void {
  // ── 时刻消毒：合法保留 / 坏值回落默认 ────────────────────────
  for (const rule of TIME_FIELDS) {
    const clean = sanitizeConfigInput({ [rule.key]: ' 07:30 ' })[rule.key];
    assert.strictEqual(clean, '07:30', `${rule.key} 合法时刻保留并去空白`);
    for (const bad of ['25:99', '12:60', 'abc', '', 42, null, undefined, {}]) {
      assert.strictEqual(
        sanitizeConfigInput({ [rule.key]: bad })[rule.key],
        rule.fallback,
        `${rule.key} 非法时刻回落默认`,
      );
    }
  }

  // ── SYNC：时刻字段必须进 config-store 源码与 defaults ────────
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'config-store.ts'), 'utf-8');
  for (const rule of TIME_FIELDS) {
    assert.ok(new RegExp(`\\b${rule.key}\\b`).test(src), `config-store.ts 未出现字段 ${rule.key}`);
  }
  const defaultsBlock = /const defaults = \{([\s\S]*?)\n\} satisfies/.exec(src);
  assert.ok(defaultsBlock, 'SYNC: config-store.ts 找不到 defaults 块');
  for (const rule of TIME_FIELDS) {
    assert.ok(
      new RegExp(`\\b${rule.key}\\s*:`).test(defaultsBlock![1]),
      `SYNC: ${rule.key} 未进 config-store defaults（旧配置升级后读到 undefined）`,
    );
  }

  console.log('config-sanitize-time selftest: all assertions passed');
}

main();
