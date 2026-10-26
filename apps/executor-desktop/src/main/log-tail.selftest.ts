/**
 * NETOPT-2⑥ selftest：logs:getToday 尾部窗口读（readLastLines）的语义不变量。
 *
 * 背景：ipc-handlers 的 logs:getToday 原实现 readFileSync 整读当天日志 +
 * split + slice(-500)——主进程一次数 MB～数十 MB 的同步 I/O，状态窗口每次
 * 打开都卡一下。改为 openSync + fstat.size + 尾部 256KB 窗口读再取尾 500 行。
 *
 * 该逻辑含「窗口起点半行丢弃 / 行边界判定 / <500 行语义兼容」等易错点，
 * 与 log-incremental.selftest.ts 同策略：把核心算法复制到本文件断言语义，
 * 文末 SYNC GUARD 直接检查 ipc-handlers.ts 源码——既防实现漂移，也防有人
 * 把 logs:getToday 改回整读（性能回归立即变红）。
 *
 * 语义锚点：旧实现 content.split('\n') 在文件以 \n 结尾时会产生尾随 ''
 * 元素且 slice(-500) 不滤空——新实现刻意保持一致（场景 1 钉死），UI 侧
 * （StatusWindow 逐行渲染）对空行无感。
 *
 * 为何复制而非 import：ipc-handlers.ts 顶层 import electron，裸 node 下
 * 加载即失败（同 log-incremental.selftest.ts 的处置）。
 *
 * F-22（UIUX 审计 2026-10-25）扩展：readLogIncremental 的「fromLine=0 且游标
 * 新建」首读分支改走尾窗扫描（scanLogTail）——log:read / apps:log:read 两条
 * 查看器路径此前把整个文件全量过桥，渲染层只留 1500/2400 行。scanLogTail 抽在
 * 纯 Node 模块 log-tail-scan.ts（零 electron 依赖），本文件**直接 import 真实现**
 * 做行为断言（无 SYNC 副本）；与游标口径的对齐论证见该模块头注。接线锚点由
 * 文末 SYNC GUARD 钉住（log:read / apps:log:read 必须仍走 readLogIncremental，
 * readLogIncremental 必须仍走 scanLogTail）。
 *
 * Run via: npm run test:main
 */
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
// F-22：scanLogTail 是纯 Node 模块——直接驱动真实现（无 SYNC 副本）。
import { LOG_TAIL_MAX_LINES, scanLogTail } from './log-tail-scan';

// ── SYNC：与 src/main/ipc-handlers.ts 的 readLastLines 等价实现 ──
const LOG_TAIL_WINDOW_BYTES = 256 * 1024;

function readLastLines(
  filePath: string,
  maxLines: number = 500,
  windowBytes: number = LOG_TAIL_WINDOW_BYTES,
): string[] {
  let fd: number | undefined;
  try {
    fd = fs.openSync(filePath, 'r');
    const size = fs.fstatSync(fd).size;
    if (size === 0) return [];
    const start = Math.max(0, size - windowBytes);
    const length = size - start;
    const buf = Buffer.allocUnsafe(length);
    const read = fs.readSync(fd, buf, 0, length, start);
    const text = buf.subarray(0, read).toString('utf-8');
    // CRLF 剥离（2026-10-04）：Windows 落盘 \r\n 按 \n 切分后每行残留尾部 \r，
    // 渲染层 OUTER_LOG_RE 的 (.*)$ 因 . 不匹配 \r 而整行失配——历史日志退化
    // 为原始双时间戳显示。这是对旧实现语义的一次「刻意偏离」，场景 8 钉死。
    const lines = text.split('\n').map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line));
    // 窗口起点不在行首时，首元素是被截断的半行——丢弃。
    if (start > 0) {
      const boundary = Buffer.allocUnsafe(1);
      fs.readSync(fd, boundary, 0, 1, start - 1);
      if (boundary[0] !== 0x0a) {
        lines.shift();
      }
    }
    return lines.slice(-maxLines);
  } catch {
    return [];
  } finally {
    if (fd !== undefined) {
      fs.closeSync(fd);
    }
  }
}

// ── 断言 ─────────────────────────────────────────────────────────────
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acf-logtail-'));

try {
  // 场景 1：小文件（< 窗口）——与旧实现「整读 + split + slice(-500)」逐字一致，
  // 包括文件以 \n 结尾时 split 产生的尾随 '' 元素也保留（行为兼容锚点）。
  {
    const f = path.join(dir, 'small.log');
    fs.writeFileSync(f, 'l1\nl2\nl3\n');
    const expectedOld = fs.readFileSync(f, 'utf-8').split('\n').slice(-500);
    assert.deepStrictEqual(readLastLines(f), expectedOld, '小文件语义与旧实现不一致');
    assert.deepStrictEqual(readLastLines(f), ['l1', 'l2', 'l3', '']);
  }

  // 场景 2：空文件 / 不存在的文件不崩且返回空
  {
    const f = path.join(dir, 'empty.log');
    fs.writeFileSync(f, '');
    assert.deepStrictEqual(readLastLines(f), [], '空文件应返回空');
    assert.deepStrictEqual(readLastLines(path.join(dir, 'nope.log')), [], '缺失文件应返回空');
  }

  // 场景 3：大文件（> 窗口）——只取尾 500 行且行序正确。
  // 用小窗口参数模拟「行数远超 maxLines」，再用 >256KB 的真实文件钉住默认
  // 窗口参数路径（窗口内行数仍 > 500）。
  {
    const f = path.join(dir, 'big.log');
    const total = 2000;
    const lines: string[] = [];
    for (let i = 1; i <= total; i++) lines.push(`line-${String(i).padStart(5, '0')}`);
    fs.writeFileSync(f, lines.join('\n') + '\n');
    const tail = readLastLines(f);
    assert.strictEqual(tail.length, 500, '默认应取尾 500 行');
    // 旧实现语义：尾随 '' 元素占据 slice(-500) 的最后一个位置，
    // 因此 500 个元素 = line-01502..line-02000 + ''（line-01501 被挤出）。
    assert.strictEqual(tail[0], 'line-01502', '尾 500 行的起点错位');
    assert.strictEqual(tail[498], 'line-02000', '尾 500 行的终点错位');
    assert.strictEqual(tail[499], '', '尾随空元素语义与旧实现不一致');

    // >256KB 真实窗口路径：每行 ~305B × 2000 行 ≈ 610KB
    const f2 = path.join(dir, 'big-real.log');
    const lines2 = lines.map((l) => l + 'x'.repeat(294));
    fs.writeFileSync(f2, lines2.join('\n') + '\n');
    const tail2 = readLastLines(f2);
    assert.strictEqual(tail2.length, 500, '真实 256KB 窗口下仍取尾 500 行');
    assert.strictEqual(tail2[498], lines2[total - 1], '真实窗口尾行错位');
  }

  // 场景 4：窗口起点落在半行中间——半行必须被丢弃（不得出现残缺行）。
  {
    const f = path.join(dir, 'partial.log');
    // 每行 = A×100 + '#i' + '\n' = 103B；前缀 'HEAD' 使 200B 窗口起点落进行中
    const long = 'A'.repeat(100);
    const rows = Array.from({ length: 10 }, (_, i) => `${long}#${i}\n`);
    fs.writeFileSync(f, 'HEAD' + rows.join(''));
    const tail = readLastLines(f, 500, 200);
    for (const l of tail) {
      assert.ok(
        l === '' || new RegExp(`^A{100}#\\d$`).test(l),
        `窗口内出现残缺半行: ${JSON.stringify(l.slice(0, 30))}`,
      );
    }
    assert.ok(!tail.join('\n').includes('HEAD'), '窗口前内容不应出现');
  }

  // 场景 5：窗口起点恰在行边界（start-1 为 \n）——首元素是完整行，必须保留。
  {
    const f = path.join(dir, 'boundary.log');
    // 每行恰好 50 字节（49 内容 + \n）：窗口 150B → start=350 正落在行边界
    const rows = Array.from(
      { length: 10 },
      (_, i) => `row-${String(i).padStart(2, '0')}`.padEnd(49) + '\n',
    );
    fs.writeFileSync(f, rows.join(''));
    const tail = readLastLines(f, 500, 150);
    // split 元素不含换行符：预期 = rows[7..9] 的内容部分 + 尾随 ''
    assert.deepStrictEqual(
      tail,
      [rows[7].slice(0, -1), rows[8].slice(0, -1), rows[9].slice(0, -1), ''],
      '行边界对齐的窗口应保留全部窗口内整行',
    );
  }

  // 场景 6：maxLines 截断生效（含尾随 '' 语义）
  {
    const f = path.join(dir, 'cap.log');
    fs.writeFileSync(f, 'a\nb\nc\nd\ne\n');
    assert.deepStrictEqual(readLastLines(f, 2), ['e', ''], 'maxLines 截断失效');
  }

  // 场景 7：UTF-8 多字节字符不被窗口起点切坏
  {
    const f = path.join(dir, 'utf8.log');
    const rows = Array.from({ length: 50 }, (_, i) => `任务日志第 ${i} 行——执行器输出✓\n`);
    fs.writeFileSync(f, rows.join(''));
    const tail = readLastLines(f, 10, 512);
    assert.strictEqual(tail.length, 10, '窗口内行数充足时应取满 maxLines');
    // 不出现替换符（U+FFFD）——多字节序列未被窗口边界切碎
    for (const l of tail) {
      assert.ok(!l.includes('\uFFFD'), `多字节字符被切坏: ${JSON.stringify(l.slice(0, 20))}`);
    }
    assert.strictEqual(tail[8], '任务日志第 49 行——执行器输出✓', '末行内容错位');
    assert.strictEqual(tail[9], '', '尾随空元素语义与旧实现不一致');
  }
  // 场景 8：CRLF 行尾（Windows 真实落盘形态）——尾部 \r 必须剥离。
  // 回归背景：残留 \r 使渲染层 normalizeLogLine 的 (.*)$ 正则整行失配，
  // 历史日志全部退化为关键词猜测的原始双时间戳显示。
  {
    const f = path.join(dir, 'crlf.log');
    fs.writeFileSync(f, '[2026-10-04 10:00:00.000] [info]  App ready\r\n[2026-10-04 10:00:01.000] [warn]  slow op\r\n');
    assert.deepStrictEqual(
      readLastLines(f),
      ['[2026-10-04 10:00:00.000] [info]  App ready', '[2026-10-04 10:00:01.000] [warn]  slow op', ''],
      'CRLF 行尾的 \\r 残留必须剥离（否则渲染层规范化正则失配）',
    );
  }

  // ── F-22：scanLogTail（log:read / apps:log:read 首读尾窗）───────────────
  // 语义锚点：与 readLogIncremental 的游标口径逐字一致——非空行计数、
  // 不剥 \r、文件尾未终结行 withheld、空行占字节但不计行。
  {
    // 小文件：全量语义（行/行数/游标偏移/未截断）。
    const f = path.join(dir, 'scan-small.log');
    fs.writeFileSync(f, 'l1\nl2\nl3\n');
    const scan = scanLogTail(f);
    assert.ok(scan, '正常文件不得返回 null');
    assert.deepStrictEqual(scan.lines, ['l1', 'l2', 'l3'], '小文件尾窗应等于全文件');
    assert.strictEqual(scan.totalLines, 3, 'totalLines 必须是游标口径（非空完整行）');
    assert.strictEqual(
      scan.consumedBytes,
      fs.statSync(f).size,
      '游标偏移必须落在 EOF（文件以 \\n 结尾）',
    );
    assert.strictEqual(scan.truncated, false, '未截断必须如实上报 false');

    // 空文件 / 不存在的文件。
    fs.writeFileSync(path.join(dir, 'scan-empty.log'), '');
    const scanEmpty = scanLogTail(path.join(dir, 'scan-empty.log'));
    assert.ok(scanEmpty, '空文件不是错误');
    assert.deepStrictEqual(scanEmpty.lines, []);
    assert.strictEqual(scanEmpty.totalLines, 0);
    assert.strictEqual(
      scanLogTail(path.join(dir, 'scan-missing.log')),
      null,
      '缺失文件返回 null（调用方回落旧路径兜底）',
    );

    // 行数超过尾窗：只留尾部 maxLines 行、totalLines 精确、truncated 如实，
    // 且「totalLines - lines.length」正好是渲染层全局行号的首行号 - 1。
    const big = path.join(dir, 'scan-big.log');
    const total = 5000;
    const bigLines = Array.from({ length: total }, (_, i) => `line-${String(i + 1).padStart(5, '0')}`);
    fs.writeFileSync(big, bigLines.join('\n') + '\n');
    const scanBig = scanLogTail(big);
    assert.ok(scanBig);
    assert.strictEqual(scanBig.lines.length, LOG_TAIL_MAX_LINES, '默认尾窗 3000 行（1500/2400 消费口径 + 余量）');
    assert.strictEqual(scanBig.lines[0], 'line-02001', '尾窗首行错位');
    assert.strictEqual(scanBig.lines[LOG_TAIL_MAX_LINES - 1], 'line-05000', '尾窗末行错位');
    assert.strictEqual(scanBig.totalLines, total, 'totalLines 必须是全文件精确值（不是窗口内行数）');
    assert.strictEqual(scanBig.truncated, true, '截断必须如实上报');
    assert.strictEqual(scanBig.totalLines - scanBig.lines.length, 2000, '全局行号换算口径漂移');
    // 自定义 maxLines 仍精确。
    const scan2 = scanLogTail(big, 2);
    assert.ok(scan2);
    assert.deepStrictEqual(scan2.lines, ['line-04999', 'line-05000']);
    assert.strictEqual(scan2.truncated, true);

    // CRLF：**不剥** \r（游标口径——本路径没有 readLastLines 的渲染层配套），
    // 且 \r 计入游标偏移。
    const crlf = path.join(dir, 'scan-crlf.log');
    fs.writeFileSync(crlf, 'a\r\nb\r\n');
    const scanCrlf = scanLogTail(crlf);
    assert.ok(scanCrlf);
    assert.deepStrictEqual(scanCrlf.lines, ['a\r', 'b\r'], 'scanLogTail 沿用游标口径（不剥 \\r）');
    assert.strictEqual(scanCrlf.totalLines, 2);
    assert.strictEqual(scanCrlf.consumedBytes, 6, '\\r 必须计入游标偏移（a\\r\\n b\\r\\n 共 6 字节）');

    // 空行：与游标路径同口径——不计行数、不返回，但字节计入偏移。
    const blanks = path.join(dir, 'scan-blanks.log');
    fs.writeFileSync(blanks, 'a\n\nb\n');
    const scanBlanks = scanLogTail(blanks);
    assert.ok(scanBlanks);
    assert.deepStrictEqual(scanBlanks.lines, ['a', 'b'], '空行不得混入行缓冲');
    assert.strictEqual(scanBlanks.totalLines, 2, '空行不计入游标 totalLines');
    assert.strictEqual(scanBlanks.consumedBytes, fs.statSync(blanks).size, '空行的字节必须计入游标偏移');

    // 文件尾未终结行：withheld（不计不交），游标停最后一个 \n 之后。
    const partial = path.join(dir, 'scan-partial.log');
    fs.writeFileSync(partial, 'done\nhalf');
    const scanPartial = scanLogTail(partial);
    assert.ok(scanPartial);
    assert.deepStrictEqual(scanPartial.lines, ['done'], '未终结的尾行不得提前交付');
    assert.strictEqual(scanPartial.totalLines, 1);
    assert.strictEqual(scanPartial.consumedBytes, 5, '游标必须停在最后一个 \\n 之后');

    // 多字节字符跨 1MB 读块边界：StringDecoder 必须接住（不出现 U+FFFD）。
    const mb = path.join(dir, 'scan-mb-boundary.log');
    // 1048575 个 ASCII 字节 + 3 字节 '任' → 该字符横跨第一个 1MB 块边界。
    fs.writeFileSync(mb, 'x'.repeat(1024 * 1024 - 1) + '任' + '-tail\nend\n');
    const scanMb = scanLogTail(mb);
    assert.ok(scanMb);
    assert.strictEqual(scanMb.lines.length, 2);
    assert.ok(scanMb.lines[0].endsWith('任-tail'), `跨块多字节被切坏: ...${scanMb.lines[0].slice(-12)}`);
    assert.ok(!scanMb.lines[0].includes('\uFFFD'), '跨块多字节出现替换符');
    assert.strictEqual(scanMb.totalLines, 2);
  }
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}

// ── SYNC GUARD：确认 ipc-handlers.ts 内 logs:getToday 已走 readLastLines，
// 且没有任何残留的整读实现。若有人把 handler 改回 readFileSync 整读
// （NETOPT-2⑥ 性能回归），这里立即变红。
// 路径解析：本文件编译到 dist-selftest/，源码在同级 src/main。
const ipcSourcePath = path.join(__dirname, '..', 'src', 'main', 'ipc-handlers.ts');
const ipcSource = fs.readFileSync(ipcSourcePath, 'utf-8');
for (const needle of [
  'function readLastLines(',
  'const LOG_TAIL_WINDOW_BYTES = 256 * 1024;',
  'const lines = readLastLines(filePath, 500);',
]) {
  assert.ok(ipcSource.includes(needle), `SYNC: ipc-handlers.ts 缺少尾部窗口读实现片段: ${needle}`);
}
// 抽取 logs:getToday handler 到下一个 ipcMain.handle 之间的源码段做负断言
const startIdx = ipcSource.indexOf("ipcMain.handle('logs:getToday'");
assert.ok(startIdx !== -1, 'SYNC: 找不到 logs:getToday handler');
const nextIdx = ipcSource.indexOf('ipcMain.handle', startIdx + 10);
const handlerBody = ipcSource.slice(startIdx, nextIdx);
assert.ok(!handlerBody.includes('readFileSync'), 'SYNC: logs:getToday 仍有整读残留（NETOPT-2⑥ 性能回归）');
assert.ok(handlerBody.includes('readLastLines'), 'SYNC: logs:getToday 未调用 readLastLines');

// ── F-22 SYNC GUARD：log:read / apps:log:read 两条查看器路径必须仍走
// readLogIncremental，且其首读分支必须仍走 scanLogTail 尾窗。任何一处被
// 改回整读/全量过桥（性能回归），这里立即变红。
for (const needle of [
  "import { scanLogTail } from './log-tail-scan';",
  'const scan = scanLogTail(filePath);',
  'truncated: scan.truncated',
]) {
  assert.ok(ipcSource.includes(needle), `SYNC: ipc-handlers.ts 缺少 F-22 尾窗首读实现片段: ${needle}`);
}
function handlerBodyOf(name: string): string {
  const idx = ipcSource.indexOf(`ipcMain.handle('${name}'`);
  assert.ok(idx !== -1, `SYNC: 找不到 handler ${name}`);
  const next = ipcSource.indexOf('ipcMain.handle', idx + 10);
  return ipcSource.slice(idx, next >= 0 ? next : undefined);
}
assert.ok(
  handlerBodyOf('log:read').includes('readLogIncremental(target, fromLine)'),
  'SYNC: log:read 必须经 readLogIncremental（增量游标语义不得被绕过）',
);
assert.ok(
  handlerBodyOf('apps:log:read').includes('readLogIncremental(target, fromLine)'),
  'SYNC: apps:log:read 必须经 readLogIncremental（增量游标语义不得被绕过）',
);

console.log('log-tail selftest: all assertions passed (8 + F-22 scan scenarios + sync guard)');
