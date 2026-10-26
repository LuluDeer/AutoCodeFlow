/**
 * P2-3 self-check：应用名回溯的「增量尾读 + 全量回溯节流」（node:assert，无
 * 测试框架）。app-name-recovery.ts 是纯模块（fs + 可注入 I/O 面），这里用
 * 真实临时目录 + 计数包装的 I/O 逐分支驱动真实实现。
 * Run via: npm run test:main
 *
 * 覆盖：
 *  - 核心回归：连续两次调用且文件仅追加 → 第二次**不触发全文件读**
 *    （readFile 调用计数断言），且追加段里的新映射必须被增量捡到；
 *  - 签名未变 → 零 I/O 复用缓存（旧语义保持）；
 *  - 全量回溯节流：窗口内新增的日志分片不立刻全量读；窗口打开后补扫；
 *  - 截断/轮转（size 回退）→ 该文件状态重置、退回全量读；
 *  - 合并语义：最新文件优先（与旧实现一致）、app.json 权威不被覆盖
 *    （applyRecoveredAppNames 回归锚）。
 */
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  applyRecoveredAppNames,
  collectReleaseAppNames,
  parseReleaseAppNames,
  resetReleaseAppNameCache,
  type ReleaseScanIo,
} from './app-name-recovery';

function nameLine(appName: string, releaseKey: string): string {
  return `[deploy] Current release for ${appName} now points to ${releaseKey}`;
}

function main(): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acf-namerec-'));

  try {
    const today = 'executor-2026-10-25.log';
    const todayPath = path.join(dir, today);
    const KEY_A = '1.0.0-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const KEY_B = '1.0.1-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

    // ── 1. 首次调用：全量读建立基线 ────────────────────────────────────
    resetReleaseAppNameCache();
    fs.writeFileSync(todayPath, `${nameLine('refund-sync', KEY_A)}\n`, 'utf-8');
    let readFileCalls = 0;
    let readSliceCalls = 0;
    const countingIo: ReleaseScanIo = {
      readFile: (p) => {
        readFileCalls++;
        return fs.readFileSync(p, 'utf-8');
      },
      readSlice: (p, from) => {
        readSliceCalls++;
        const fd = fs.openSync(p, 'r');
        try {
          const size = fs.fstatSync(fd).size;
          const buf = Buffer.allocUnsafe(size - from);
          fs.readSync(fd, buf, 0, buf.length, from);
          return buf.toString('utf-8');
        } finally {
          fs.closeSync(fd);
        }
      },
      sizeOf: (p) => fs.statSync(p).size,
      now: () => nowMs,
    };
    let nowMs = 1_000_000;

    const first = collectReleaseAppNames(dir, countingIo);
    assert.strictEqual(readFileCalls, 1, '首次调用必须全量读建立基线');
    assert.strictEqual(first.get(KEY_A), 'refund-sync');

    // ── 2. 签名未变：零文件读复用缓存 ─────────────────────────────────
    collectReleaseAppNames(dir, countingIo);
    assert.strictEqual(readFileCalls, 1, '签名未变不得重读文件');
    assert.strictEqual(readSliceCalls, 0, '签名未变不得做任何增量读');

    // ── 3. 核心回归：仅追加 → 第二次不触发全文件读，增量捡到新映射 ────
    fs.appendFileSync(todayPath, `${nameLine('billing-sync', KEY_B)}\n`, 'utf-8');
    const second = collectReleaseAppNames(dir, countingIo);
    assert.strictEqual(readFileCalls, 1, 'P2-3 核心：文件仅追加时第二次调用不得全文件重读');
    assert.strictEqual(readSliceCalls, 1, '追加段必须走增量尾读');
    assert.strictEqual(second.get(KEY_B), 'billing-sync', '增量段的新映射必须被捡到');
    assert.strictEqual(second.get(KEY_A), 'refund-sync', '既有映射不得丢失');
    // 再追加一次仍走增量（节流不再影响有状态文件）。
    const KEY_C = '2.0.0-cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    fs.appendFileSync(todayPath, `${nameLine('report-sync', KEY_C)}\n`, 'utf-8');
    const third = collectReleaseAppNames(dir, countingIo);
    assert.strictEqual(readFileCalls, 1, '运行期持续追加也绝不升级成全文件重读');
    assert.strictEqual(third.get(KEY_C), 'report-sync');

    // ── 4. 全量回溯节流：窗口内新分片不全量读，窗口打开后补扫 ──────────
    const yesterday = 'executor-2026-10-24.log';
    const yesterdayPath = path.join(dir, yesterday);
    const KEY_D = '0.9.0-dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    fs.writeFileSync(yesterdayPath, `${nameLine('legacy-sync', KEY_D)}\n`, 'utf-8');
    nowMs += 10_000; // 仍在 60s 窗口内
    const throttled = collectReleaseAppNames(dir, countingIo);
    assert.strictEqual(readFileCalls, 1, '节流窗口内的全量请求必须被跳过');
    assert.ok(!throttled.has(KEY_D), '窗口内新分片的映射暂缺（60s 后补上）');
    nowMs += 61_000; // 窗口打开
    const afterWindow = collectReleaseAppNames(dir, countingIo);
    assert.strictEqual(readFileCalls, 2, '窗口打开后必须补全量读');
    assert.strictEqual(afterWindow.get(KEY_D), 'legacy-sync', '补扫必须捡到新分片的映射');
    // 补扫后签名未变：再次调用零读（retryFullScanAt 已清，快路径恢复）。
    collectReleaseAppNames(dir, countingIo);
    assert.strictEqual(readFileCalls, 2, '补扫完成后快路径必须恢复');
    // 即使签名不变，窗口打开后的快路径也让位已在上组覆盖；这里钉
    // 「补扫被跳过后日志静默」的变体：窗口内出现新文件、签名不再变化，
    // 窗口打开后的下一次调用仍必须补扫（retryFullScanAt 快路径让位）。
    // 用**全新目录**隔离计数（主目录已有多份历史文件会污染 readFile 计数）。
    {
      resetReleaseAppNameCache();
      const quietDir = path.join(dir, 'quiet');
      fs.mkdirSync(quietDir, { recursive: true });
      readFileCalls = 0;
      readSliceCalls = 0;
      nowMs = 2_000_000;
      const f1 = path.join(quietDir, 'executor-2026-10-23.log');
      fs.writeFileSync(f1, `${nameLine('d1', 'k1')}\n`, 'utf-8');
      collectReleaseAppNames(quietDir, countingIo); // 首扫（全量）
      assert.strictEqual(readFileCalls, 1);
      nowMs += 5_000;
      const f2 = path.join(quietDir, 'executor-2026-10-22.log');
      fs.writeFileSync(f2, `${nameLine('d2', 'k2')}\n`, 'utf-8');
      assert.ok(!collectReleaseAppNames(quietDir, countingIo).has('k2'), '窗口内新文件被节流跳过');
      nowMs += 100_000; // 窗口已开，且文件此后不再变化（签名不变）
      const recovered = collectReleaseAppNames(quietDir, countingIo);
      assert.strictEqual(readFileCalls, 2, '签名未变也必须让位补扫');
      assert.strictEqual(recovered.get('k2'), 'd2', '静默新文件的映射必须被补扫捡回');
    }

    // ── 5. 截断/轮转（size 回退）→ 状态重置、退回全量读 ────────────────
    resetReleaseAppNameCache();
    readFileCalls = 0;
    readSliceCalls = 0;
    nowMs = 3_000_000;
    fs.writeFileSync(todayPath, `${nameLine('first-run', 'k-a')}\n${nameLine('extra', 'k-z')}\n`, 'utf-8');
    collectReleaseAppNames(dir, countingIo);
    const beforeCalls = readFileCalls;
    fs.writeFileSync(todayPath, `${nameLine('re-deployed', 'k-b')}\n`, 'utf-8'); // 截断重写（变小）
    const afterTruncate = collectReleaseAppNames(dir, countingIo);
    assert.strictEqual(readFileCalls, beforeCalls + 1, 'size 回退必须退回全量读（且不受节流约束）');
    assert.strictEqual(afterTruncate.get('k-b'), 're-deployed');
    assert.ok(!afterTruncate.has('k-a'), '被截断掉的映射不得残留');
    assert.ok(!afterTruncate.has('k-z'), '被截断掉的映射不得残留（第二行）');

    // ── 6. 合并语义：最新文件优先 + applyRecoveredAppNames 权威锚 ──────
    {
      resetReleaseAppNameCache();
      const newer = path.join(dir, 'executor-2026-10-26.log');
      fs.writeFileSync(newer, `${nameLine('newer-name', 'k-shared')}\n`, 'utf-8');
      fs.writeFileSync(yesterdayPath, `${nameLine('older-name', 'k-shared')}\n`, 'utf-8');
      const names = collectReleaseAppNames(dir);
      assert.strictEqual(names.get('k-shared'), 'newer-name', '最新日志优先（旧实现语义保持）');
      const entries = [
        { appName: 'authoritative', releaseKey: 'k-shared' },
        { appName: null, releaseKey: 'k-shared' },
        { appName: null, releaseKey: 'k-missing' },
      ];
      const merged = applyRecoveredAppNames(entries, names);
      assert.strictEqual(merged[0].appName, 'authoritative', 'app.json 权威值绝不被日志推断覆盖');
      assert.strictEqual(merged[1].appName, 'newer-name');
      assert.strictEqual(merged[2].appName, null, '回溯不到就如实保持 null（不用 appId 冒充）');
    }

    // ── 7. parseReleaseAppNames 回归锚（行格式漂移立即红） ─────────────
    {
      const hits = parseReleaseAppNames(
        [
          '2026-10-25 10:00:00 [deploy] Current release for refund-sync now points to 1.0.0-k',
          'noise line without keyword',
          '[deploy] Current release for   spaced-name   now points to   1.0.1-k2   ',
          '[deploy] Current release for  now points to 1.0.2-k3', // 空 appName：丢弃
        ].join('\n'),
      );
      assert.deepStrictEqual(
        hits,
        [
          { releaseKey: '1.0.0-k', appName: 'refund-sync' },
          { releaseKey: '1.0.1-k2', appName: 'spaced-name' },
        ],
      );
    }

    // ── 8. 目录缺失：回溯不可用（空 Map，不是异常） ────────────────────
    resetReleaseAppNameCache();
    assert.deepStrictEqual(
      Array.from(collectReleaseAppNames(path.join(dir, 'no-such-dir')).entries()),
      [],
    );
    assert.deepStrictEqual(Array.from(collectReleaseAppNames(undefined).entries()), []);

    console.log('app-name-recovery selftest: all assertions passed (incremental tail read, no full re-read on append, 60s full-rescan throttle, truncate reset, newest-file-wins)');
  } finally {
    resetReleaseAppNameCache();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

main();
