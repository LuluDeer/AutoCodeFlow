/**
 * PERF-DSK-01 selftest：日志增量读取的语义不变量。
 *
 * 背景：ipc-handlers 的 log:read 原实现每次轮询都全量 readFileSync + split，
 * 渲染层运行期 1.5s 轮询一次，大日志下呈平方级 I/O。改为按字节偏移增量读
 * （readLogIncremental）。该逻辑含"半行 withhold / 截断重建 / 字节偏移"
 * 等易错点，因此把核心算法抽到本文件同名函数并与 ipc-handlers.ts 内的实现
 * 保持同步（SYNC 守卫见文末断言，形态对齐 updater.selftest.ts 的副本策略）。
 *
 * 为何复制而非 import：ipc-handlers.ts 顶层 import electron，裸 node 下
 * 加载即失败（同 updater.selftest.ts 对 electron-updater 的处置）。
 *
 * F-22（UIUX 审计 2026-10-25）：readLogIncremental 新增「fromLine=0 且游标
 * 新建 → 尾窗扫描（scanLogTail）」首读分支——大日志首读不再全量过桥，返回值
 * 带 truncated 截断口径。scanLogTail 抽在纯 Node 模块 log-tail-scan.ts，本
 * 文件的 SYNC 副本直接 import 真实现（行为断言见 log-tail.selftest.ts；本
 * 文件聚焦「尾窗首读 → 增量续读」的游标衔接不变量）。
 *
 * Run via: npm run test:main
 */
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { scanLogTail } from './log-tail-scan';

// ── SYNC：与 src/main/ipc-handlers.ts 的 readLogIncremental 等价实现 ──
interface LogCursor {
  offset: number;
  totalLines: number;
}
const logCursors = new Map<string, LogCursor>();
const LOG_CURSOR_LIMIT = 64;

function readLogIncremental(
  filePath: string,
  fromLine: number,
): { lines: string[]; totalLines: number; truncated?: boolean; error?: string } {
  try {
    const { size } = fs.statSync(filePath);
    let cursor = logCursors.get(filePath);
    let freshCursor = false;

    if (!cursor || size < cursor.offset) {
      cursor = { offset: 0, totalLines: 0 };
      logCursors.set(filePath, cursor);
      freshCursor = true;
    }

    if (fromLine === 0 && cursor.totalLines !== 0) {
      cursor = { offset: 0, totalLines: 0 };
      logCursors.set(filePath, cursor);
      freshCursor = true;
    }

    // F-22：首读尾窗分支（与 ipc-handlers.ts 的实现逐字同步——SYNC 副本）。
    if (fromLine === 0 && (freshCursor || cursor.totalLines === 0)) {
      const scan = scanLogTail(filePath);
      if (scan) {
        cursor.offset = scan.consumedBytes;
        cursor.totalLines = scan.totalLines;
        return { lines: scan.lines, totalLines: scan.totalLines, truncated: scan.truncated };
      }
    }

    if (fromLine > cursor.totalLines) {
      // P3-1：旧实现此处 readFileSync 整文件全量 split；改为 scanLogTail
      // 尾窗重建（与生产实现逐字同步——SYNC 副本）。
      const scan = scanLogTail(filePath);
      if (!scan) {
        return { lines: [], totalLines: 0 };
      }
      cursor.offset = scan.consumedBytes;
      cursor.totalLines = scan.totalLines;
      const skip = Math.max(0, fromLine - (scan.totalLines - scan.lines.length));
      return {
        lines: scan.lines.slice(skip),
        totalLines: scan.totalLines,
        truncated: scan.truncated,
      };
    }

    const length = size - cursor.offset;
    if (length <= 0) {
      return { lines: [], totalLines: cursor.totalLines };
    }
    const fd = fs.openSync(filePath, 'r');
    let chunk: string;
    try {
      const buf = Buffer.allocUnsafe(length);
      const read = fs.readSync(fd, buf, 0, length, cursor.offset);
      chunk = buf.subarray(0, read).toString('utf-8');
    } finally {
      fs.closeSync(fd);
    }

    const lastNl = chunk.lastIndexOf('\n');
    if (lastNl === -1) {
      return { lines: [], totalLines: cursor.totalLines };
    }
    const consumable = chunk.slice(0, lastNl);
    const newLines = consumable.split('\n').filter((l) => l.length > 0);

    cursor.offset += Buffer.byteLength(chunk.slice(0, lastNl + 1), 'utf-8');
    cursor.totalLines += newLines.length;

    const skip = Math.max(0, fromLine - (cursor.totalLines - newLines.length));
    return { lines: newLines.slice(skip), totalLines: cursor.totalLines };
  } catch {
    return { lines: [], totalLines: 0 };
  } finally {
    if (logCursors.size > LOG_CURSOR_LIMIT) {
      const keys = Array.from(logCursors.keys()).slice(0, logCursors.size - LOG_CURSOR_LIMIT);
      for (const k of keys) logCursors.delete(k);
    }
  }
}

// ── 断言 ─────────────────────────────────────────────────────────────
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acf-loginc-'));

try {
  // 场景 1：分批追加（模拟轮询）——累计行序必须与一次性全量读完全一致
  {
    const f = path.join(dir, 'x.log');
    const expected: string[] = [];
    const got: string[] = [];
    let fromLine = 0;
    for (let batch = 1; batch <= 5; batch++) {
      const added: string[] = [];
      for (let i = 1; i <= 4; i++) added.push(`batch${batch}-line${i}`);
      fs.appendFileSync(f, added.join('\n') + '\n');
      expected.push(...added);
      const r = readLogIncremental(f, fromLine);
      got.push(...r.lines);
      fromLine = r.totalLines;
      assert.strictEqual(r.totalLines, expected.length, `batch ${batch} totalLines 漂移`);
    }
    assert.deepStrictEqual(got, expected, '增量读取累计结果与全量读不一致（丢行或重复）');
  }

  // 场景 2：尾部半行必须 withheld（否则会发出半行且下轮重复计数）
  {
    const f = path.join(dir, 'y.log');
    fs.writeFileSync(f, 'complete-line\npartial');
    let r = readLogIncremental(f, 0);
    assert.deepStrictEqual(r.lines, ['complete-line'], '尾部半行被提前发出');
    fs.appendFileSync(f, '-finished\n');
    r = readLogIncremental(f, r.totalLines);
    assert.deepStrictEqual(r.lines, ['partial-finished'], '补全后的行未正确交付');
  }

  // 场景 3：fromLine=0 语义为「从头重读」（UI 刷新按钮）
  {
    const f = path.join(dir, 'z.log');
    fs.writeFileSync(f, 'a\nb\nc\n');
    readLogIncremental(f, 0);
    const r = readLogIncremental(f, 0);
    assert.deepStrictEqual(r.lines, ['a', 'b', 'c'], 'fromLine=0 未重读全部');
    assert.strictEqual(r.totalLines, 3);
  }

  // 场景 4：文件被截断/轮转（size 回退）后不得丢内容或错位
  {
    const f = path.join(dir, 'r.log');
    fs.writeFileSync(f, 'old1\nold2\nold3\n');
    readLogIncremental(f, 0);
    fs.writeFileSync(f, 'new1\nnew2\n');
    const r = readLogIncremental(f, 0);
    assert.deepStrictEqual(r.lines, ['new1', 'new2'], '截断后读取错位');
    assert.strictEqual(r.totalLines, 2);
  }

  // 场景 5：UTF-8 多字节边界（按字节偏移切分不得切坏字符）
  {
    const f = path.join(dir, 'u.log');
    const cn = ['任务开始执行', '中文日志行二', '完成✓'];
    fs.writeFileSync(f, cn.join('\n') + '\n');
    const r = readLogIncremental(f, 0);
    assert.deepStrictEqual(r.lines, cn, '多字节字符被截断');
  }

  // 场景 6：fromLine 超前于缓存（UI 状态被重置）走尾窗重建兜底且不崩
  {
    const f = path.join(dir, 'fwd.log');
    fs.writeFileSync(f, 'l1\nl2\nl3\n');
    const r = readLogIncremental(f, 99);
    assert.deepStrictEqual(r.lines, [], '超前 fromLine 应返回空');
    assert.strictEqual(r.totalLines, 3);
    // P3-1：重建分支必须把游标落到「最后完整行」——后续增量读从文件尾
    // 无缝续上（旧全量兜底不重建游标，下一轮会重复读到旧行）。
    fs.appendFileSync(f, 'l4\n');
    const r2 = readLogIncremental(f, r.totalLines);
    assert.deepStrictEqual(r2.lines, ['l4'], '尾窗重建后增量读必须从 EOF 续上');
    assert.strictEqual(r2.totalLines, 4);
  }

  // 场景 6b（P3-1）：超长文件的超前 fromLine 重建受尾窗上限约束且行号对齐
  {
    const f = path.join(dir, 'fwd-big.log');
    const rows = Array.from({ length: 4000 }, (_, i) => `row-${String(i + 1).padStart(5, '0')}`);
    fs.writeFileSync(f, rows.join('\n') + '\n');
    // 模拟游标被 LRU 驱逐后 UI 从旧行号续读：旧实现此处整文件 readFileSync
    // + 全量 split（主进程内存尖峰），新实现走 scanLogTail 尾窗（内存与文件
    // 大小无关），返回行按 fromLine 对齐、全局行号 = totalLines - len
    //（fromLine 为 0 基行号：3999 = 第 4000 行）。
    const r = readLogIncremental(f, 3999);
    assert.deepStrictEqual(r.lines, ['row-04000'], 'fromLine 对齐必须给出该全局行号上的行');
    assert.strictEqual(r.totalLines, 4000);
    assert.strictEqual(r.truncated, true, '尾窗截断口径必须如实上报');
    // 超前出界的 fromLine 与旧全量实现同语义：返回空（但游标仍重建到 EOF）。
    const r2 = readLogIncremental(f + '-nope', 99);
    assert.deepStrictEqual(r2.lines, []);
  }

  // 场景 7（F-22）：大文件首读走尾窗——行数封顶、totalLines 精确、truncated
  // 如实；后续增量读从文件尾无缝续上，全局行号（firstLineNo = total - len）
  // 与首读末行精确衔接，且增量响应不带截断口径（渲染层按 undefined 保持现状）。
  {
    const f = path.join(dir, 'big-tail.log');
    const total = 5000;
    const bigLines = Array.from({ length: total }, (_, i) => `line-${String(i + 1).padStart(5, '0')}`);
    fs.writeFileSync(f, bigLines.join('\n') + '\n');
    const first = readLogIncremental(f, 0);
    assert.strictEqual(first.lines.length, 3000, '首读必须只返回尾窗（3000 行）而非全文件');
    assert.strictEqual(first.totalLines, total, 'totalLines 必须是全文件精确值');
    assert.strictEqual(first.truncated, true, '首读截断必须如实上报');
    assert.strictEqual(first.lines[0], 'line-02001', '尾窗首行错位');
    assert.strictEqual(first.totalLines - first.lines.length, 2000, '全局行号换算口径漂移');

    fs.appendFileSync(f, 'tail-a\ntail-b\n');
    const inc = readLogIncremental(f, first.totalLines);
    assert.deepStrictEqual(inc.lines, ['tail-a', 'tail-b'], '尾窗后续增量读必须无缝续上（不丢不重）');
    assert.strictEqual(inc.totalLines, total + 2);
    assert.strictEqual(inc.truncated, undefined, '增量响应不得携带截断口径');
    assert.strictEqual(inc.totalLines - inc.lines.length, first.totalLines, '增量行号必须紧接首读末行');
  }

  // 场景 8（F-22）：fromLine=0 刷新（游标已存在）同样走尾窗，且刷新后游标
  // 状态与首读等价——继续增量不丢不重。
  {
    const f = path.join(dir, 'refresh-tail.log');
    const rows = Array.from({ length: 3200 }, (_, i) => `row-${String(i + 1).padStart(5, '0')}`);
    fs.writeFileSync(f, rows.join('\n') + '\n');
    const r1 = readLogIncremental(f, 0);
    assert.strictEqual(r1.lines.length, 3000);
    assert.strictEqual(r1.truncated, true);

    fs.appendFileSync(f, 'row-03201\n');
    const r2 = readLogIncremental(f, r1.totalLines);
    assert.deepStrictEqual(r2.lines, ['row-03201'], '刷新前的增量读失效');

    const r3 = readLogIncremental(f, 0);
    assert.strictEqual(r3.lines.length, 3000, '刷新（fromLine=0）必须重新走尾窗');
    assert.strictEqual(r3.totalLines, 3201, '刷新后 totalLines 必须精确');
    assert.strictEqual(r3.truncated, true);
    assert.strictEqual(r3.lines[2999], 'row-03201', '刷新尾窗必须包含最新行');

    const r4 = readLogIncremental(f, r3.totalLines);
    assert.deepStrictEqual(r4.lines, [], '刷新后游标已到 EOF，增量读应为空');
    assert.strictEqual(r4.totalLines, 3201);
  }
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}

// ── SYNC GUARD：确认 ipc-handlers.ts 内仍是同一套增量逻辑 ──
// 若有人把实现改回全量 readFileSync+slice（性能回归），或改了游标字段名，
// 这里立即变红。
// 路径解析：本文件编译到 dist-selftest/，而 tsconfig.selftest 的 rootDir 是
// src/main——所以 __dirname 是 <app>/dist-selftest，源码在同级的 src/main。
const ipcSourcePath = path.join(__dirname, '..', 'src', 'main', 'ipc-handlers.ts');
const ipcSource = fs.readFileSync(ipcSourcePath, 'utf-8');
for (const needle of [
  'function readLogIncremental(',
  'const logCursors = new Map<string, LogCursor>();',
  'const lastNl = chunk.lastIndexOf',
  'cursor.offset += Buffer.byteLength',
  'return readLogIncremental(target, fromLine);',
  // F-22：首读尾窗分支的接线锚点（实现本体由 log-tail.selftest 行为驱动）。
  'const scan = scanLogTail(filePath);',
  'truncated: scan.truncated',
]) {
  assert.ok(ipcSource.includes(needle), `SYNC: ipc-handlers.ts 缺少增量读实现片段: ${needle}`);
}
assert.ok(
  !/const allLines = content\.split\('\\n'\)\.filter\(\(l: string\) => l\.length > 0\);\s*\n\s*const totalLines = allLines\.length;\s*\n\s*const lines = allLines\.slice\(fromLine\);/.test(ipcSource),
  'SYNC: ipc-handlers.ts 似乎退回了全量 readFileSync+slice 实现（PERF-DSK-01 性能回归）',
);

console.log('log-incremental selftest: all assertions passed (8 scenarios + sync guard)');
