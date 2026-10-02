/**
 * B-3② self-check：更新「已下载」持久化标记（node:assert，无测试框架）。
 * update-marker.ts 是纯 Node 模块，这里用真实临时目录驱动真实实现。
 * Run via: npm run test:main
 *
 * 覆盖：写读回环、损坏/缺失/形状不符一律 null（绝不抛）、版本比对语义、
 * 以及 updater.ts 的接线结构守卫（downloaded 落标记 / available 带旗标）。
 */
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  UPDATE_MARKER_FILE,
  updateMarkerPath,
  writeDownloadedUpdateMarker,
  readDownloadedUpdateMarker,
  isSameDownloadedVersion,
} from './update-marker';

function main(): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acf-updmark-'));
  try {
    // ── 1. 写读回环 ────────────────────────────────────────────────
    assert.strictEqual(
      writeDownloadedUpdateMarker(dir, '1.6.6', 1_700_000_000_000),
      true,
      '正常写入返回 true',
    );
    assert.strictEqual(fs.existsSync(updateMarkerPath(dir)), true, '标记文件存在');
    assert.strictEqual(path.basename(updateMarkerPath(dir)), UPDATE_MARKER_FILE);
    const marker = readDownloadedUpdateMarker(dir);
    assert.notStrictEqual(marker, null);
    assert.deepStrictEqual(marker, { version: '1.6.6', at: 1_700_000_000_000 });

    // ── 2. 版本比对语义 ────────────────────────────────────────────
    assert.strictEqual(isSameDownloadedVersion(marker, '1.6.6'), true, '同版本命中');
    assert.strictEqual(isSameDownloadedVersion(marker, '1.6.7'), false, '新版本不命中');
    assert.strictEqual(isSameDownloadedVersion(null, '1.6.6'), false, '无标记不命中');
    assert.strictEqual(isSameDownloadedVersion(marker, ''), false, '空版本号不命中');

    // ── 3. 损坏/缺失/形状不符：null，绝不抛 ────────────────────────
    fs.writeFileSync(updateMarkerPath(dir), 'not json {{{', 'utf-8');
    assert.strictEqual(readDownloadedUpdateMarker(dir), null, '坏 JSON → null');
    fs.writeFileSync(updateMarkerPath(dir), JSON.stringify({ version: 42, at: 'x' }), 'utf-8');
    assert.strictEqual(readDownloadedUpdateMarker(dir), null, '形状不符（类型错）→ null');
    fs.writeFileSync(updateMarkerPath(dir), JSON.stringify({ version: '', at: 1 }), 'utf-8');
    assert.strictEqual(readDownloadedUpdateMarker(dir), null, '空版本号 → null');
    fs.writeFileSync(updateMarkerPath(dir), JSON.stringify({ version: '1.6.6' }), 'utf-8');
    assert.strictEqual(readDownloadedUpdateMarker(dir), null, '缺 at 字段 → null');
    fs.rmSync(updateMarkerPath(dir));
    assert.strictEqual(readDownloadedUpdateMarker(dir), null, '文件缺失 → null');
    // 目录不可写时写入 best-effort 失败而非抛
    const bogusDir = path.join(dir, 'nope', 'deeper');
    assert.strictEqual(writeDownloadedUpdateMarker(bogusDir, '1.0.0', 1), false, '目录不存在 → false（不抛）');

    // ── 4. SYNC 结构守卫：updater.ts 真的接上了标记 ────────────────
    const updaterSrc = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'main', 'updater.ts'),
      'utf-8',
    );
    assert.ok(
      /writeDownloadedUpdateMarker\(updateMarkerDir\(\), version, Date\.now\(\)\)/.test(updaterSrc),
      'SYNC: update-downloaded 事件必须落持久化标记',
    );
    assert.ok(
      /isSameDownloadedVersion\(\s*readDownloadedUpdateMarker\(updateMarkerDir\(\)\),\s*remote,?\s*\)/.test(updaterSrc),
      'SYNC: update-available 必须与标记比对（同版本 → previouslyDownloaded）',
    );
    assert.ok(
      updaterSrc.includes("previouslyDownloaded"),
      'SYNC: available 广播载荷必须带 previouslyDownloaded 旗标',
    );

    console.log('update-marker selftest: all assertions passed (round-trip, corrupt-safe, version match, updater wiring)');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

main();
