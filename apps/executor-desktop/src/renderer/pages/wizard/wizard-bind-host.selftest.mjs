/**
 * R5-T1：向导 bind host 纯函数自检（由 renderer.selftest.mjs 入口 import 驱动）。
 *
 * 两段：① 真执行 wizardBindHost 的取值表（含脏值安全回落）；② 源码锚点，
 * 钉住 checkPort / finish / canNext / 完成页摘要四处都接到同一函数，防止
 * 后续有人把硬编码 '0.0.0.0' 或「端口失败仍可下一步」改回去。
 */
import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { wizardBindHost, DEFAULT_WIZARD_BIND_HOST } from './wizard-bind-host.ts';

const eq = (actual, expected, msg) => assert.equal(actual, expected, msg);

// ── ① 取值表：空值回落 / 已存值沿用 / 脏值安全回落 ──────────────────────
eq(DEFAULT_WIZARD_BIND_HOST, '0.0.0.0', '缺省常量与 config-store 默认一致');

eq(wizardBindHost(undefined), '0.0.0.0', '首次安装（undefined）→ 回落默认');
eq(wizardBindHost(null), '0.0.0.0', '读取失败（null）→ 回落默认');
eq(wizardBindHost(''), '0.0.0.0', '空串 → 回落默认');
eq(wizardBindHost('   '), '0.0.0.0', '纯空白是脏值，等同未配置 → 回落默认');

eq(wizardBindHost('127.0.0.1'), '127.0.0.1', '仅本机回环：原样沿用');
eq(wizardBindHost('0.0.0.0'), '0.0.0.0', '全网卡默认：原样沿用');
eq(wizardBindHost('192.168.1.20'), '192.168.1.20', '指定网卡：原样沿用');
eq(wizardBindHost('::1'), '::1', 'IPv6 回环：原样沿用（不得被当脏值丢掉）');

// 脏值：非字符串一律回落，不把意外类型送进 IPC / bind。
for (const dirty of [0, 1, false, true, {}, [], ['127.0.0.1'], NaN]) {
  eq(wizardBindHost(dirty), '0.0.0.0', `脏值 ${String(dirty)} → 回落默认`);
}
// 合法值逐字节保留：不做 trim / 改写，和已落盘配置一致。
eq(wizardBindHost(' 127.0.0.1 '), ' 127.0.0.1 ', '非空合法串原样返回');

// ── ② 四处接线锚点（防硬编码回流） ─────────────────────────────────────
const here = resolve(import.meta.dirname);
const wizardSrc = readFileSync(resolve(here, '..', 'Wizard.tsx'), 'utf8');
const code = wizardSrc.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');

assert.match(code, /import\s*\{\s*wizardBindHost\s*\}\s*from\s*'\.\/wizard\/wizard-bind-host'/);
assert.match(code, /const bindHost\s*=\s*wizardBindHost\(wizardCfg\?\.executorHost\)/, '真源只算一次');
assert.match(code, /executorHost:\s*bindHost\b/, 'finish() 必须与探针同源');
assert.match(code, /checkPort\(form\.executorPort,\s*bindHost\)/, 'checkPort 必须按真实 bind host 探测');
assert.match(code, /portResult\?\.available\s*!==\s*false/, '端口探测失败必须拦住「下一步」');
assert.match(code, /wizard\.finish\.keyBindHost/, '完成页必须展示 bind host 摘要');
assert.doesNotMatch(code, /checkPort\(form\.executorPort,\s*'0\.0\.0\.0'\)/, '探针不得再硬编码全网卡');

console.log('wizard-bind-host selftest ok');
