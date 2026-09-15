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
 * Run via: npm run test:main
 */
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

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
): { lines: string[]; totalLines: number; error?: string } {
  try {
    const { size } = fs.statSync(filePath);
    let cursor = logCursors.get(filePath);

    if (!cursor || size < cursor.offset) {
      cursor = { offset: 0, totalLines: 0 };
      logCursors.set(filePath, cursor);
    }

    if (fromLine === 0 && cursor.totalLines !== 0) {
      cursor = { offset: 0, totalLines: 0 };
      logCursors.set(filePath, cursor);
    }

    if (fromLine > cursor.totalLines) {
      const content = fs.readFileSync(filePath, 'utf-8');
      const allLines = content.split('\n').filter((l) => l.length > 0);
      return { lines: allLines.slice(fromLine), totalLines: allLines.length };
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

  // 场景 6：fromLine 超前于缓存（UI 状态被重置）走全量兜底且不崩
  {
    const f = path.join(dir, 'fwd.log');
    fs.writeFileSync(f, 'l1\nl2\nl3\n');
    const r = readLogIncremental(f, 99);
    assert.deepStrictEqual(r.lines, [], '超前 fromLine 应返回空');
    assert.strictEqual(r.totalLines, 3);
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
]) {
  assert.ok(ipcSource.includes(needle), `SYNC: ipc-handlers.ts 缺少增量读实现片段: ${needle}`);
}
assert.ok(
  !/const allLines = content\.split\('\\n'\)\.filter\(\(l: string\) => l\.length > 0\);\s*\n\s*const totalLines = allLines\.length;\s*\n\s*const lines = allLines\.slice\(fromLine\);/.test(ipcSource),
  'SYNC: ipc-handlers.ts 似乎退回了全量 readFileSync+slice 实现（PERF-DSK-01 性能回归）',
);

console.log('log-incremental selftest: all assertions passed (6 scenarios + sync guard)');
