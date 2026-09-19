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
 * Run via: npm run test:main
 */
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

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
    const lines = text.split('\n');
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

console.log('log-tail selftest: all assertions passed (7 scenarios + sync guard)');
