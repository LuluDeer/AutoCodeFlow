/**
 * NETOPT-2⑦ selftest：子进程输出按行缓冲（LineSplitter）。
 *
 * 背景：executor-process.ts 此前把每个 data chunk 当一行直送
 * handleChildOutput——多行 chunk / 跨块半行都会让合法 JSON 行的
 * JSON.parse 失败，结构化日志通道（executor:log-structured）静默失效。
 *
 * 拆分器本体在 child-line-splitter.ts（纯 Node、无 electron 依赖），
 * 本文件直接 import 断言行为（无需 SYNC 副本）；文末 SYNC GUARD 检查
 * executor-process.ts 的接线——两个流都走 splitter、退出时 flush、
 * 且不再有「chunk 直送」的旧模式。
 *
 * Run via: npm run test:main
 */
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { LineSplitter, MAX_PENDING_LINE_BYTES } from './child-line-splitter';

// ── 断言 ─────────────────────────────────────────────────────────────

/** 收集 onLine 回调的小工具。 */
function collect(): { lines: string[]; splitter: LineSplitter; feed: (s: string) => void; flush: () => void } {
  const lines: string[] = [];
  const splitter = new LineSplitter((l) => lines.push(l));
  return {
    lines,
    splitter,
    feed: (s) => splitter.feed(s),
    flush: () => splitter.flush(),
  };
}

// 场景 1：单行单块（最常见路径）
{
  const { lines, feed } = collect();
  feed('{"level":"info","message":"started"}\n');
  assert.deepStrictEqual(lines, ['{"level":"info","message":"started"}'], '单行单块失效');
}

// 场景 2：跨块半行——JSON 行被 pipe 边界截断，补全后必须完整交付
{
  const { lines, feed } = collect();
  feed('{"level":"inf');
  assert.deepStrictEqual(lines, [], '半行被提前发出');
  feed('o","message":"done"}\n');
  assert.deepStrictEqual(lines, ['{"level":"info","message":"done"}'], '跨块行未重组');
  // 重组结果必须是合法 JSON（结构化通道的命门）
  assert.deepStrictEqual(JSON.parse(lines[0]), { level: 'info', message: 'done' }, '重组后 JSON 不可解析');
}

// 场景 3：多行单块——多个合法 JSON 行挤在同一 chunk，必须逐行交付
{
  const { lines, feed } = collect();
  feed('{"n":1}\n{"n":2}\n{"n":3}\n');
  assert.deepStrictEqual(lines, ['{"n":1}', '{"n":2}', '{"n":3}'], '多行 chunk 未逐行拆分');
  for (const l of lines) JSON.parse(l); // 每行都必须可解析
}

// 场景 4：\r\n 行尾剥离（Windows 子进程输出）
{
  const { lines, feed } = collect();
  feed('a\r\nb\r\n');
  assert.deepStrictEqual(lines, ['a', 'b'], 'CRLF 未剥离或行数错误');
  // 文件中段出现空行（两个连续换行）→ 产出一个空行，行为与逐行语义一致
  feed('c\n\nd\n');
  assert.deepStrictEqual(lines.slice(2), ['c', '', 'd'], '空行未按行交付');
}

// 场景 5：结尾半行——进程退出时 flush 冲洗；纯空白缓冲不产出
{
  const { lines, feed, flush, splitter } = collect();
  feed('{"n":1}\npartial-no-newline');
  assert.deepStrictEqual(lines, ['{"n":1}'], '结尾半行被提前发出');
  flush();
  assert.deepStrictEqual(lines, ['{"n":1}', 'partial-no-newline'], 'flush 未冲洗残留半行');
  // 再次 flush 是空操作
  flush();
  assert.strictEqual(lines.length, 2, 'flush 不应重复产出');
  // 纯空白缓冲：flush 直接丢弃
  splitter.feed('   \t  ');
  flush();
  assert.strictEqual(lines.length, 2, '纯空白缓冲不应产出行');
}

// 场景 6：防失控上限——无换行的超长输出在 MAX_PENDING_LINE_BYTES 处冲出
{
  const { lines, feed } = collect();
  const oversized = 'x'.repeat(MAX_PENDING_LINE_BYTES + 1024);
  feed(oversized);
  assert.strictEqual(lines.length, 1, '超限缓冲未冲出');
  assert.strictEqual(lines[0].length, MAX_PENDING_LINE_BYTES + 1024, '超限冲出丢内容');
  // 冲出后缓冲复位：后续 feed 从干净状态开始
  feed('ok\n');
  assert.deepStrictEqual(lines.slice(1), ['ok'], '超限冲出后缓冲未复位');
}

// 场景 7：空块 / 纯换行块——不产出空 callback 风暴
{
  const { lines, feed } = collect();
  feed('');
  feed('\n');
  assert.deepStrictEqual(lines, [''], '换行块语义错误');
}

// ── SYNC GUARD：确认 executor-process.ts 的接线没有退回「chunk 直送」。 ──
// 路径解析：本文件编译到 dist-selftest/，源码在同级 src/main。
const procSourcePath = path.join(__dirname, '..', 'src', 'main', 'executor-process.ts');
const procSource = fs.readFileSync(procSourcePath, 'utf-8');
for (const needle of [
  "import { LineSplitter } from './child-line-splitter';",
  'this.stdoutSplitter.feed(chunk.toString',
  'this.stderrSplitter.feed(chunk.toString',
  'this.stdoutSplitter.flush();',
  'this.stderrSplitter.flush();',
]) {
  assert.ok(procSource.includes(needle), `SYNC: executor-process.ts 缺少按行缓冲接线片段: ${needle}`);
}
// 负断言：旧缺陷模式（data 回调里 chunk 直送 handleChildOutput）不得回归。
assert.ok(
  !/const line = chunk\.toString\(\);/.test(procSource),
  'SYNC: executor-process.ts 出现「chunk 当一行直送」旧模式（NETOPT-2⑦ 回归）',
);

console.log('child-line-splitter selftest: all assertions passed (7 scenarios + sync guard)');
