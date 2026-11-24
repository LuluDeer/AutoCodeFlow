#!/usr/bin/env node
/**
 * demo-headless-agent 的 workDir 清理契约自检（纯静态、离线、零依赖）。
 *
 * 为什么不接 npm 门禁链：本文件守的是 `demo:headless-agent` —— 一个 真机
 * 演示脚本（要跑起来的 admin-api + LLM 才能走完），它刻意不进本地
 * test:guards 链；本自检只断言它的源码文本契约，随 demo 直接 node 运行：
 *   node scripts/demo-headless-agent.selftest.mjs
 *
 * 反证（有牙）：删掉任一处 cleanupOnFailure() 调用、或 helper 里的 rmSync、
 * 或把清理挪到成功 return 之后 —— 下述精确锚点断言立即转红；还原即转绿。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const target = path.join(root, 'scripts', 'demo-headless-agent.mjs');
const src = fs.readFileSync(target, 'utf8');

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`  ok - ${name}`);
}

console.log('demo-headless-agent.selftest (workDir cleanup contract)');

test('模块级 demoWorkDir = null 声明在 async IIFE 之前（失败 catch 够得到）', () => {
  const decl = src.search(/^let\s+demoWorkDir\s*=\s*null\s*;/m);
  const iife = src.indexOf('(async () => {');
  assert.ok(decl >= 0, '缺少模块级 let demoWorkDir = null');
  assert.ok(iife > decl, 'demoWorkDir 声明必须在 IIFE 之前');
});

test('cleanupOnFailure helper 用 rmSync(demoWorkDir, { recursive, force })', () => {
  const helper = src.indexOf('function cleanupOnFailure()');
  assert.ok(helper >= 0, '缺少 cleanupOnFailure helper');
  const helperEnd = src.indexOf('\n}\n', helper);
  const body = src.slice(helper, helperEnd >= 0 ? helperEnd + 2 : helper + 300);
  assert.match(body, /if \(demoWorkDir\)/, '必须判空后再删');
  assert.match(
    body,
    /fs\.rmSync\(demoWorkDir, \{ recursive: true, force: true \}\)/,
    'rmSync 必须作用于模块级 demoWorkDir 且 recursive/force 均为 true',
  );
});

test('mkdtemp 创建的 workDir 赋给模块级 demoWorkDir（创建后才谈清理）', () => {
  const mk = src.indexOf('const workDir = fs.mkdtempSync(');
  assert.ok(mk >= 0, '缺少 mkdtempSync 创建 workDir');
  const anchor = src.slice(mk, mk + 220);
  assert.match(
    anchor,
    /^const workDir = fs\.mkdtempSync\([\s\S]*?\);\s*\n\s*demoWorkDir = workDir;/,
    'mkdtemp 之后必须立即登记到 demoWorkDir',
  );
});

test('终态非 completed：cleanupOnFailure() 在 process.exit(1) 之前', () => {
  const term = src.indexOf("current !== 'completed'");
  const catchIdx = src.lastIndexOf('.catch(');
  assert.ok(term >= 0 && catchIdx > term, '定位终态分支失败');
  const slice = src.slice(term, catchIdx);
  const cleanup = slice.indexOf('cleanupOnFailure()');
  const exit = slice.indexOf('process.exit(1)');
  assert.ok(cleanup >= 0, '终态非 completed 分支缺少清理调用');
  assert.ok(exit > cleanup, '清理必须发生在 process.exit(1) 之前');
});

test('尾部 .catch：cleanupOnFailure() 在 process.exit(1) 之前（覆盖所有 throw）', () => {
  const catchIdx = src.lastIndexOf('.catch(');
  assert.ok(catchIdx >= 0, '缺少尾部 .catch');
  const tail = src.slice(catchIdx);
  const cleanup = tail.indexOf('cleanupOnFailure()');
  const exit = tail.indexOf('process.exit(1)');
  assert.ok(cleanup >= 0, '.catch 缺少清理调用');
  assert.ok(exit > cleanup, '.catch 中清理必须发生在 exit(1) 之前');
  assert.match(tail, /cleaned workDir: \$\{demoWorkDir\}/, '失败时应打印被清理路径');
});

test('成功路径保留 workDir 打印与 return，且不清理', () => {
  const print = src.indexOf('console.log(`  workDir: ${workDir}`)');
  assert.ok(print >= 0, '成功路径必须打印 workDir 供查看产物');
  const success = src.indexOf("console.log('✓ headless SOP assignment closed loop passed')");
  assert.ok(success >= 0, '成功标记丢失');
  const ret = src.indexOf('return;', success);
  assert.ok(ret > success && ret - success < 120, '成功路径应紧随 return');
  const catchIdx = src.lastIndexOf('.catch(');
  assert.ok(
    src.slice(success, catchIdx).indexOf('cleanupOnFailure()') < 0,
    '成功路径不得清理 workDir（产物要留给用户看）',
  );
});

console.log(`\n✓ ${passed} checks passed — demo-headless-agent workDir cleanup contract intact`);
