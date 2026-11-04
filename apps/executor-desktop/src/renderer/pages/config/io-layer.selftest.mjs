/**
 * R7-B：配置 IO 层的**取数面自检 + 实现体唯一性**（源码文本契约的加固面）。
 *
 * 背景：设置页的检查更新 / 配置导出导入 / 诊断报告导出的实现已从
 * `ConfigPage.tsx` 搬进 `pages/config/use-config-io.ts`（写路径 + 状态）与
 * `pages/config/io-result.ts`（结果归一的纯函数）。源码文本契约必须读**实现
 * 真正所在的文件**——只读页面的话，搬一次文件守卫就静默变成"还在、但牙没了"。
 *
 * 这里钉两件事（都是 STC-073 先例的同一处置思路："另有一条断言钉住实现只在
 * 协作者、Facade 侧只剩转发"）：
 *
 *   ① **取数面自检**：本页读到的三个文件必须各自含预期锚点。锚点不在位时报
 *      "取数面漏了文件（实现又被搬到别处？）"，而不是让下游断言红成
 *      "代码真的没了"——两者的处置完全不同（前者是守卫自身坏了）。
 *   ② **实现体唯一性**：五条 IO 写路径实现体在 IO 层**各恰好一份**，且**不得
 *      回流页面**。只查"锚点存在"是不够的：实现体被复制一份、或被搬到第三个
 *      文件时，"存在"仍然成立 ⇒ 必须用计数钉住"唯一一份"。
 *
 * 刻意留在 `renderer.selftest.mjs` 之外的原因：那一份文件已在体量基线里
 * （棘轮只许降不许增），守卫越写越长会先撞上体量红线；把它放进
 * `pages/config/` 下与被测实现同目录，既让"守卫与实现在一起"成立，也让
 * 本文件对基线棘轮零影响（<600 非注释行、最长函数 <300）。
 *
 * 由 `renderer.selftest.mjs` 尾部 import 驱动（`npm run test:renderer`）。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const here = resolve(import.meta.dirname);
const read = (rel) => readFileSync(resolve(here, rel), 'utf8');

const configPage = read('../ConfigPage.tsx');
const ioLayer = read('./use-config-io.ts');
const ioResult = read('./io-result.ts');

let checked = 0;
const check = (cond, msg) => {
  checked += 1;
  if (!cond) throw new Error(`R7-B 配置 IO 取数面: ${msg}`);
};

// ── ① 取数面自检：三个文件各自必须含预期锚点 ─────────────────────────
for (const [file, src, anchors] of [
  ['pages/ConfigPage.tsx', configPage, [
    // A-3 哨兵字面量与它的 i18n 映射必须留在页面（跨进程契约：主进程
    // ipc-handlers.ts 回的是同一个字面量，主进程侧 selftest 以
    // ConfigPage.tsx 为取数面钉住"哨兵 ⇒ 双语文案、不得内联中文"）。
    'UPDATER_UNSUPPORTED_INSTALL',
    "t('cfg.gen.updateUnsupportedInstall')",
    // 按钮接线仍必须在页面（IO 层没有 JSX）。
    'exportDiagnostics',
    'exportConfig',
    'importConfig',
  ]],
  ['pages/config/use-config-io.ts', ioLayer, [
    'exportDiagnosticReport',
    'planImportResult',
    'setAutoLaunch',
    'try',
  ]],
  ['pages/config/io-result.ts', ioResult, [
    'cfg.io.importFailed',
    'cfg.io.diagnosticFailed',
    'planUpdateCheckText',
  ]],
]) {
  for (const anchor of anchors) {
    check(src.includes(anchor),
      `${file} 缺锚点「${anchor}」——取数面漏了文件（IO 实现又被搬到别处？），不是代码真的没了`);
  }
}

// ── ② 实现体唯一性：各恰好一份，且不得回流页面 ───────────────────────
const IO_BODIES = [
  'async function exportDiagnostics',
  'async function importConfig',
  'async function exportConfig',
  'async function checkUpdate',
  'function toggleAutoLaunch',
];
for (const body of IO_BODIES) {
  const n = ioLayer.split(body).length - 1;
  check(n === 1, `${body} 在 IO 层出现 ${n} 次（应为 1）——实现体被复制或搬到了取数面之外`);
  check(!configPage.includes(body),
    `ConfigPage 又长回了 ${body} 的实现体——IO 写路径应只在 pages/config/use-config-io.ts（页面只留接线）`);
}
// 结果归一的四个纯函数同样各恰好一份（同一理由）。
for (const fn of ['planExportResult(', 'planImportResult(', 'planDiagnosticsResult(', 'planUpdateCheckText(']) {
  const n = ioLayer.split(fn).length - 1;
  check(n === 1, `${fn} 在 IO 层出现 ${n} 次（应为 1）——结果归一的实现被复制或搬到了取数面之外`);
}

// ── ③ 页面侧只留接线：三处状态位仍由页面消费（JSX 里读得到） ─────────
for (const anchor of ['ioBusy', 'ioMsg', 'diagBusy', 'diagMsg', 'checking', 'checkMsg']) {
  check(configPage.includes(anchor), `页面不再消费 ${anchor}——IO 层的状态没有出口（JSX 接线丢了？）`);
}

// ── ④ 实现面的纪律（PLAN-EXECUTOR-DESKTOP-UX 5.2 的"接线 + 纪律"随实现
//    一起搬过来）：旧版 preload 缺通道必须降级、失败必须页内可见、reject 后
//    按钮必须能再点（try/catch/finally）。这三条原本锚在 ConfigPage.tsx 上，
//    实现搬走后继续锚页面就变成"断言实现体在页面"（假红/假绿两向都可能）
//    ⇒ 按 STC-073 先例改为锚实现真正所在的文件。 ─────────────────────
check(ioLayer.includes("typeof window.electronAPI.exportDiagnosticReport === 'function'"),
  '诊断导出必须做 typeof 守卫（旧 preload 下会同步抛异常导致白屏）');
check(ioLayer.includes('diagMsg') && ioResult.includes('cfg.io.diagnosticFailed'),
  '诊断导出失败必须页内可见（diagMsg + cfg.io.diagnosticFailed）');
check(/async function exportDiagnostics\(\)[\s\S]{0,900}?try\s*\{[\s\S]{0,600}?\}\s*catch[\s\S]{0,400}?\}\s*finally\s*\{/.test(ioLayer),
  'exportDiagnostics 必须 try/catch/finally（否则失败后按钮永久禁用）');
// 导出/导入同理：两条链路各自的 try/catch/finally 不得缺（同一缺陷形态）
check(/async function exportConfig\(\)[\s\S]{0,900}?try\s*\{[\s\S]{0,600}?\}\s*catch[\s\S]{0,400}?\}\s*finally\s*\{/.test(ioLayer),
  'exportConfig 必须 try/catch/finally（否则失败后按钮永久禁用）');
check(/async function importConfig\(\)[\s\S]{0,2000}?try\s*\{[\s\S]{0,1200}?\}\s*catch[\s\S]{0,400}?\}\s*finally\s*\{/.test(ioLayer),
  'importConfig 必须 try/catch/finally（否则失败后按钮永久禁用）');
check(/async function checkUpdate\(\)[\s\S]{0,900}?try\s*\{[\s\S]{0,600}?\}\s*catch[\s\S]{0,400}?\}\s*finally\s*\{/.test(ioLayer),
  'checkUpdate 必须 try/catch/finally（否则失败后按钮永久禁用）');
// F-38：检查更新的 6s 自动清除定时器必须随卸载清理
check(/checkMsgTimerRef[\s\S]{0,200}?clearTimeout/.test(ioLayer),
  'checkMsg 的 6s 定时器必须在卸载时清理（F-38：否则对已卸载组件 setState）');

// ── ⑤ A-3 跨进程契约：**去注释后**仍须在页面里 ────────────────────────
// 主进程侧 updater.selftest.ts 以 ConfigPage.tsx 的 includes 断言"哨兵 ⇒ 双语
// 文案"；`includes` 会被**注释**满足（哨兵字面量在解释性注释里出现过多次）。
// 本条比它更强：剥掉注释后再查，确保哨兵字面量与 i18n 映射是**代码**里的
// 活字面量，而不是注释里的回声。跨进程契约（主进程回的就是这个字面量）一旦
// 被"注释满足"，A-3 的"不得内联中文"守卫就形同虚设。
{
  const codeOnly = configPage
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  check(codeOnly.includes("'UPDATER_UNSUPPORTED_INSTALL'"),
    'A-3 哨兵字面量必须作为代码里的活字面量存在（注释里出现不算）');
  check(codeOnly.includes("t('cfg.gen.updateUnsupportedInstall')"),
    'A-3 哨兵必须映射成 i18n 双语文案（不得内联中文）');
}

console.log(`R7-B 配置 IO 取数面: ${checked} 条断言通过（取数面自检 / 实现体唯一性 / 页面接线）`);
