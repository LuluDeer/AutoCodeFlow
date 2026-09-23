/**
 * NETOPT-D P2-2 selftest：log:read 的日期分片扫描窗口不被 flat 残留文件挤空。
 *
 * 背景：ipc-handlers 的 log:read 扫描 workDir/logs 下全部条目（含 flat 残留
 * `.log`）字典序倒序取前 60。UUID 类 executionId 约半数以 a-f 开头，字典序
 * 倒排全在日期分片（YYYY-MM-DD）之前；残留 ≥60 个字母开头 flat 文件时，
 * top-60 内一个日期分片都没有——执行器把日志钉在 logs/<启动日>/<id>.log 后，
 * 当前任务日志静默空白。修法：扫描前先过滤出日期分片，flat 由独立兜底路径
 * 负责，不进扫描窗。
 *
 * 本文件把该扫描算法复制到此断言语义（同 log-incremental/log-tail 策略：
 * ipc-handlers.ts 顶层 import electron，裸 node 下加载即失败），文末 SYNC
 * GUARD 直接检查 ipc-handlers.ts 源码，防实现漂移。
 *
 * Run via: npm run test:main
 */
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// ── SYNC：与 src/main/ipc-handlers.ts log:read 的日期分片枚举等价实现 ──
// NETOPT-E P3-1: 副本随生产去 slice——NETOPT-D P3-1 已去掉 SCAN_LIMIT=60 魔数
//（/api/logs 口径：newest-first 扫描全部日期分片，无截断）；副本若再留 slice
// 就是"测试实现"与"生产实现"的漂移，回归 P2-2 不会红。
const DATE_DIR_RE = /^\d{4}-\d{2}-\d{2}$/;

function listDateShards(logsBase: string): string[] {
  if (!fs.existsSync(logsBase)) return [];
  return (fs.readdirSync(logsBase) as string[])
    .filter((n: string) => DATE_DIR_RE.test(n))
    .sort()
    .reverse();
}

function findLogFile(logsBase: string, executionId: string): string | undefined {
  for (const dateDir of listDateShards(logsBase)) {
    const candidate = path.join(logsBase, dateDir, `${executionId}.log`);
    if (fs.existsSync(candidate)) return candidate;
  }
  const flat = path.join(logsBase, `${executionId}.log`);
  if (fs.existsSync(flat)) return flat;
  return undefined;
}

// ── 断言 ─────────────────────────────────────────────────────────────
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acf-logread-'));

try {
  // 场景 1（NETOPT-D P2-2 主场景）：65 个字母开头 flat 残留 + 2 个日期分片，
  // 目标 id 落在日期分片里——必须命中。旧实现（不过滤）top-60 全是字母开头
  // flat，日期分片一个都扫不到 → 静默空白。
  {
    const logs = path.join(dir, 'logs');
    fs.mkdirSync(logs, { recursive: true });
    for (let i = 0; i < 65; i++) {
      // 字母开头的 UUID 类 id（a-f 前半字符），与真实残留形态一致
      const flatId = `a${String(i).padStart(2, '0')}face-cafe-${String(i).padStart(8, '0')}`;
      fs.writeFileSync(path.join(logs, `${flatId}.log`), `flat ${i}\n`);
    }
    const shardOld = '2026-09-18';
    const shardNew = '2026-09-19';
    fs.mkdirSync(path.join(logs, shardOld), { recursive: true });
    fs.mkdirSync(path.join(logs, shardNew), { recursive: true });
    const targetId = 'tgt-exec-0001';
    fs.writeFileSync(path.join(logs, shardOld, `${targetId}.log`), 'line-1\nline-2\n');

    const found = findLogFile(logs, targetId);
    assert.ok(found, 'flat 残留 65 个时日期分片内的目标日志必须命中');
    assert.strictEqual(path.basename(path.dirname(found!)), shardOld, '命中的应是启动日分片（newest-first 下旧分片仍可达）');

    // 反向验证：未过滤的实现在此场景下必然 miss（证明测试不是空转）
    const rawTop60 = (fs.readdirSync(logs) as string[])
      .sort().reverse().slice(0, 60);
    assert.ok(
      !rawTop60.some((n) => DATE_DIR_RE.test(n)),
      '前置条件失效：65 个字母 flat 未挤掉全部日期分片，场景无法复现 P2-2',
    );
  }

  // 场景 2：日期分片足够新时命中 newest 分片（newest-first 语义）
  {
    const logs = path.join(dir, 'logs2');
    fs.mkdirSync(logs, { recursive: true });
    fs.mkdirSync(path.join(logs, '2026-09-19'), { recursive: true });
    fs.mkdirSync(path.join(logs, '2026-09-20'), { recursive: true });
    const id = 'task-b';
    fs.writeFileSync(path.join(logs, '2026-09-19', `${id}.log`), 'old\n');
    fs.writeFileSync(path.join(logs, '2026-09-20', `${id}.log`), 'new\n');
    const found = findLogFile(logs, id);
    assert.ok(found, '日期分片场景应命中');
    assert.strictEqual(path.basename(path.dirname(found!)), '2026-09-20', '应优先 newest 分片');
  }

  // 场景 3：flat 兜底（无日期分片时目标在 flat）不受日期过滤影响
  {
    const logs = path.join(dir, 'logs3');
    fs.mkdirSync(logs, { recursive: true });
    const id = 'flat-only-id';
    fs.writeFileSync(path.join(logs, `${id}.log`), 'flat\n');
    assert.strictEqual(
      path.basename(findLogFile(logs, id)!),
      `${id}.log`,
      'flat 兜底路径不应被日期过滤破坏',
    );
  }

  // 场景 4：非日期目录（如 .venvs / workdir 其它残留）不进扫描窗
  {
    const logs = path.join(dir, 'logs4');
    fs.mkdirSync(logs, { recursive: true });
    fs.mkdirSync(path.join(logs, '.venvs'), { recursive: true });
    fs.mkdirSync(path.join(logs, 'callbacks'), { recursive: true });
    fs.mkdirSync(path.join(logs, '2026-09-18'), { recursive: true });
    const id = 'task-d';
    fs.writeFileSync(path.join(logs, '2026-09-18', `${id}.log`), 'x\n');
    const found = findLogFile(logs, id);
    assert.ok(found, '非日期目录不应干扰日期分片扫描');
    assert.strictEqual(path.basename(path.dirname(found!)), '2026-09-18');
  }
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}

// ── SYNC GUARD：确认 log:read 的日志解析在扫描前先过滤日期分片。
// 若有人把 filter 改回裸 readdirSync 全条目（P2-2 回归），这里立即变红。
//
// 2026-09 调整：解析逻辑从 log:read handler 内联抽成了
// `resolveExecutionLogFile()`（`history:reveal-log` 复用同一套解析——两处各写
// 一遍必然漂移，而"日志在哪个文件"是唯一事实）。守卫因此改为盯**该函数**，
// 而不是盯 handler 的字面文本：断言意图（过滤日期分片 + 禁 slice 截断）完全
// 不变，只是跟随实现搬家；若有人把过滤去掉，这里照样变红。
const ipcSourcePath = path.join(__dirname, '..', 'src', 'main', 'ipc-handlers.ts');
const ipcSource = fs.readFileSync(ipcSourcePath, 'utf-8');
assert.ok(
  ipcSource.includes('\\d{4}-\\d{2}-\\d{2}$'),
  'SYNC: ipc-handlers.ts 缺少日期分片正则',
);
const startIdx = ipcSource.indexOf('function resolveExecutionLogFile(');
assert.ok(startIdx !== -1, 'SYNC: 找不到 resolveExecutionLogFile（log:read 的解析实现）');
const nextFnIdx = ipcSource.indexOf('\nfunction ', startIdx + 10);
const handlerBody = ipcSource.slice(startIdx, nextFnIdx === -1 ? undefined : nextFnIdx);
const filterIdx = handlerBody.indexOf('.filter((n: string) =>');
assert.ok(filterIdx !== -1, 'SYNC: 解析未在 readdirSync 后过滤日期分片（P2-2 回归）');
assert.ok(
  handlerBody.slice(filterIdx, filterIdx + 200).includes('\\d{4}-\\d{2}-\\d{2}'),
  'SYNC: 解析的过滤不是日期分片正则（P2-2 回归）',
);
// 反证：log:read 必须**委托**给该解析函数。若有人另起一段内联扫描（绕过
// 过滤/域校验），上面盯函数的守卫就形同虚设——这条把它堵住。
const readHandlerIdx = ipcSource.indexOf("ipcMain.handle('log:read'");
assert.ok(readHandlerIdx !== -1, 'SYNC: 找不到 log:read handler');
const readHandlerBody = ipcSource.slice(
  readHandlerIdx,
  ipcSource.indexOf('ipcMain.handle', readHandlerIdx + 10),
);
assert.ok(
  readHandlerBody.includes('resolveExecutionLogFile('),
  'SYNC: log:read 未复用 resolveExecutionLogFile（可能出现绕过日期过滤的内联扫描）',
);
// NETOPT-E P3-2 / NETOPT-F P3: 整个 log:read handler **不允许**出现 slice(0,N)
// 截断（filter 前后都禁）——NETOPT-D P3-1 已去掉该魔数（与 /api/logs 无截断
// 口径对齐）。若有人把 slice 加回 filter 之后（超 N 天前的钉住分片读不到）或
// filter 之前（截断发生在日期过滤前，日期分片仍可能被挤掉——P2-2 复发），
// 这里立即变红。
// 用 \.slice( 形态匹配（方法调用），避免误伤注释里的 "slice(0,60)" 字样。
assert.ok(
  !/\.slice\s*\(\s*0\s*,/.test(handlerBody),
  'SYNC: log:read handler 出现 slice(0,N) 截断（filter 前或后，NETOPT-D P3-1 回归）',
);
// NETOPT-E P3-1: 副本的 listDateShards 也不得出现 slice(0,N)——副本留 slice
// 会让"生产已去截断"失去等价断言语义。限定函数体范围，避免误伤场景 1 的
//"反向验证"（那里刻意 slice(0,60) 模拟旧实现的前置条件）。
const selfSource = fs.readFileSync(__filename, 'utf-8');
const listFnIdx = selfSource.indexOf('function listDateShards');
const listFnBody = selfSource.slice(
  listFnIdx,
  selfSource.indexOf('function findLogFile', listFnIdx),
);
assert.ok(
  !/\.slice\s*\(\s*0\s*,/.test(listFnBody),
  'SYNC: 副本 listDateShards 出现 slice(0,N)（与生产去 slice 漂移）',
);

console.log('log-read-date-scan selftest: all assertions passed (4 scenarios + sync guard)');
