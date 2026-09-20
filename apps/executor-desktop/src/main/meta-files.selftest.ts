/**
 * NETOPT-E P2-1 selftest：pickRecentMetaFiles 的候选集不得在 mtime 排序
 * 之前按字典序截断。
 *
 * 背景：meta 文件名是 UUID（notifier 自认"字典序与写入时间无关"）。旧实现
 * 先 names.slice(0, 2000) 再 stat 排序——meta 目录超 2000 后，最近写入的
 * 终态 meta 落在 2001+ 区间永久不进候选：notifier 终态通知与 history:get
 * 历史面板同时静默丢失，且无截断提示。修法：slice 只做并发批大小控制
 * （分批 stat 防 10 万文件打爆 libuv 线程池队列），全部候选参与排序后再
 * slice(limit)。
 *
 * 本文件直接 import src/main/meta-files.ts（纯 fs/path，不依赖 electron），
 * 文末 SYNC GUARD 检查源码里不存在"排序前截断候选集"的旧形态，防回归。
 *
 * Run via: npm run test:main
 */
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pickRecentMetaFiles } from './meta-files';

async function main(): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acf-metafiles-'));
  const metaDir = path.join(dir, 'meta');
  fs.mkdirSync(metaDir, { recursive: true });

  // 2005 个 meta：文件名 m<i>.json（i 越大写入越新，mtime 显式递增——
  // readdir 顺序与写入时间无关，必须靠 mtime 判定"最近"）。
  const COUNT = 2005;
  const LIMIT = 500;
  const base = Date.now() - COUNT * 1000;
  for (let i = 0; i < COUNT; i++) {
    const f = path.join(metaDir, `m${String(i).padStart(4, '0')}.json`);
    fs.writeFileSync(f, JSON.stringify({ status: 'succeeded', i }));
    fs.utimesSync(f, new Date(base + i * 1000), new Date(base + i * 1000));
  }

  try {
    // 主场景：最近 LIMIT 个必须全部被选中，且一个不混入更旧的文件。
    const picked = await pickRecentMetaFiles(metaDir, LIMIT);
    assert.strictEqual(picked.length, LIMIT, `expected ${LIMIT} files, got ${picked.length}`);
    const expectedLatest = new Set(
      Array.from({ length: LIMIT }, (_, k) => `m${String(COUNT - 1 - k).padStart(4, '0')}.json`),
    );
    for (const f of picked) {
      assert.ok(expectedLatest.has(f), `recent file ${f} should be picked`);
    }
    // 旧实现（先 slice(2000) 再排序）会返回 m1505..m1999 区间，把最新 5 个
    // （m2000..m2004）排除——上面断言已拒绝该形态。

    // 空目录与 0 上限边界。
    const empty = path.join(dir, 'empty');
    fs.mkdirSync(empty);
    assert.deepStrictEqual(await pickRecentMetaFiles(empty, 10), []);
    assert.strictEqual((await pickRecentMetaFiles(metaDir, 0)).length, 0);

    // ── NETOPT-E P3-3: 单 stat 失败容错（.catch(()=>0) 不击穿整批）──
    // Node CJS 单例：selftest 与 meta-files.ts 共享同一 fs 模块对象，可临时
    // patch fs.promises.stat 模拟"readdir 与 stat 之间文件被删"的 EBADF。
    // broken 文件 mtime 兜底为 0 → 排序垫底 → 在 LIMIT=500 窗口外被排除，
    // 但整批仍返回 LIMIT 个合法候选（不 reject）。
    const broken = path.join(metaDir, 'm-broken.json');
    fs.writeFileSync(broken, JSON.stringify({ status: 'succeeded', i: -1 }));
    const origStat = fs.promises.stat;
    (fs.promises.stat as unknown) = (p: string) =>
      p.includes('m-broken') ? Promise.reject(new Error('EBADF')) : origStat(p);
    try {
      const picked2 = await pickRecentMetaFiles(metaDir, LIMIT);
      assert.strictEqual(
        picked2.length,
        LIMIT,
        '单个 stat 失败必须兜底为 mtime 0，不得击穿整批',
      );
      assert.ok(
        !picked2.includes('m-broken.json'),
        'stat 失败文件（mtime 0）应垫底并被 slice(limit) 排除',
      );
    } finally {
      (fs.promises.stat as unknown) = origStat;
    }

    // ── SYNC GUARD：源码不得存在"排序前截断候选集"的旧形态 ──
    // selftest 产物在 dist-selftest/ 下，源文件在 src/main/ —— __dirname 直拼
    // 会 ENOENT（指向 dist-selftest/meta-files.ts）。
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'meta-files.ts'), 'utf-8');
    assert.ok(
      !/names\.slice\(\s*0\s*,\s*\d+\s*\)/.test(src),
      'meta-files.ts must not pre-truncate the candidate list before sorting',
    );

    console.log(`meta-files.selftest OK (${COUNT} metas, limit=${LIMIT})`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

void main();
