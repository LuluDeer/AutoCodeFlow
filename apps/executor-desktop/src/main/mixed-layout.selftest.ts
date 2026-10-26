/**
 * 混合布局深度验证 selftest（ec2184ec/5c 后的缺口补齐）：用一个**真实的
 * tmpdir** 同时造出 executor 磁盘上可能并存的四种形态——
 *
 *   M1 旧单段：releases/<version>-<deploymentId>/           （升级前部署）
 *   M2 新两段：releases/<version>/<deploymentId>/           （5c 起部署）
 *   M3 current 软链 → 新两段（跨两层深度的相对形态 '<v>/<d>'）
 *   M4 current 软链 → 旧单段（相对形态即目录名本身）
 *
 * ——并把它们放进**同一个应用**的 releases/（真迁移窗口）再断言：
 *   · listDeployedApps/collectReleaseLeaves 的展开（组下钻、单段原样、无重复）；
 *   · splitReleaseKey 的反解（version 归一 / deploymentId / 唯一后缀剥除）；
 *   · readCurrentReleaseKey 的相对形态（M3 两段、M4 单段）与 isCurrent 对齐；
 *   · resolveReleaseDir 两段白名单/containment 与磁盘真目录互相印证；
 *   · deleteReleaseDir/canDeleteRelease 在两段布局下的真实删除语义；
 *   · sweepAppReleases 版本组裁剪（M3/M4 两种 current 形态的组豁免、
 *     组内 running 跳过、跨界误删防护）。
 *
 * 为什么不并入既有 selftest 的 mock：app-inventory.selftest 只在「纯两段应用」
 * 上验过 isCurrent；本文件专攻**同应用混布**下 current 归一（'v/d' vs 'v-d'）
 * 与 retention 的版本组豁免——这正是真实 fs 才能暴露（软链 realpath、组目录
 * 下钻、mtime 排序交互）的缺陷面。形态对齐 deploy-fs.spec.ts（mkdtempSync
 * 造目录树，不 mock fs）。
 *
 * Run via: npm run test:main
 */
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { listDeployedApps, splitReleaseKey } from './app-inventory';
import { sweepAppReleases } from './release-retention';
import {
  canDeleteRelease,
  deleteReleaseDir,
  readCurrentReleaseKey,
  resolveAppRoot,
  resolveReleaseDir,
} from './app-uninstall';

/** 测试常量：真实形状的 UUID（与 admin-api 的 app_deployments.id 同形）。 */
const APP_M = '12345678-1234-4789-8123-123456789abc';
const DEP_1 = 'aaaaaaaa-10ab-43ba-8c2d-aabbccddeeff';
const DEP_2 = 'bbbbbbbb-20cd-45bc-8d3e-bbccddeeffaa';
const DEP_3 = 'cccccccc-30ef-47bd-8e4f-ccddeeffaabb';

/** resolveReleasePaths 同款唯一后缀（deploy.ts:686 的 ts36-pid36-seq36）。 */
const SUFFIX = '-m4c1h8-8t4-1x';

/** 造一个部署目录（两段 key 用 '/' 分隔自动落两层）并返回其绝对路径。 */
function seedRelease(
  releasesDir: string,
  key: string,
  opts: { log?: string; mtime?: Date } = {},
): string {
  const dir = path.join(releasesDir, ...key.split('/'));
  fs.mkdirSync(dir, { recursive: true });
  if (opts.log !== undefined) fs.writeFileSync(path.join(dir, 'app.log'), opts.log);
  if (opts.mtime) fs.utimesSync(dir, opts.mtime, opts.mtime);
  return dir;
}

/** current 软链（junction 语义，POSIX 下退化为 symlink——deploy-fs.spec 同款）。 */
function setCurrent(appRoot: string, releasesDir: string, key: string): void {
  fs.symlinkSync(
    path.join(releasesDir, ...key.split('/')),
    path.join(appRoot, 'current'),
    'junction',
  );
}

/** 释放目录 mtime 钉成递增（保证「新→旧」排序确定，不受创建顺序影响）。 */
function pinMtime(dir: string, at: number): void {
  const t = new Date(Date.UTC(2026, 5, 1, 0, 0, at));
  fs.utimesSync(dir, t, t);
}

async function main(): Promise<void> {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'acf-mixed-'));
  const appRoot = path.join(workDir, 'apps', APP_M);
  const releases = path.join(appRoot, 'releases');

  try {
    // ════ 场景 M1–M4：同一 releases/ 内四种形态并存 ═══════════════════
    // 时间线（新→旧）：2.0.0/DEP_3(9) > 2.0.0/DEP_3+suffix(8) > 2.0.0/DEP_2(7)
    //   > 1.9.0-DEP_2(6) > 1.5.0-DEP_1(5)。current 指两段 DEP_3。
    const twoSegLatest = `2.0.0/${DEP_3}`;
    const twoSegSuffixed = `2.0.0/${DEP_3}${SUFFIX}`;
    const twoSegOlder = `2.0.0/${DEP_2}`;
    const oneSegNewer = `1.9.0-${DEP_2}`;
    const oneSegOldest = `1.5.0-${DEP_1}`;

    seedRelease(releases, twoSegLatest, { log: 'two-seg live\n', mtime: new Date(Date.UTC(2026, 5, 1, 0, 0, 9)) });
    seedRelease(releases, twoSegSuffixed, { mtime: new Date(Date.UTC(2026, 5, 1, 0, 0, 8)) });
    seedRelease(releases, twoSegOlder, { log: 'older dep in group\n', mtime: new Date(Date.UTC(2026, 5, 1, 0, 0, 7)) });
    seedRelease(releases, oneSegNewer, { log: 'legacy single\n', mtime: new Date(Date.UTC(2026, 5, 1, 0, 0, 6)) });
    seedRelease(releases, oneSegOldest, { log: 'legacy oldest\n', mtime: new Date(Date.UTC(2026, 5, 1, 0, 0, 5)) });
    pinMtime(path.join(releases, '2.0.0'), 6); // 组目录 mtime 介于组员之间（真实：创建即落盘）
    fs.mkdirSync(path.join(appRoot, 'tmp'), { recursive: true });
    fs.writeFileSync(
      path.join(appRoot, 'app.json'),
      JSON.stringify({ appName: '混合布局回归', runMode: 'daemon' }),
    );
    setCurrent(appRoot, releases, twoSegLatest); // M3：current → 两段

    // ── A. inventory 展开：四类条目一行一个，releaseKey 形态各自正确 ──
    let entries = (await listDeployedApps(workDir)).filter((e) => e.appId === APP_M);
    assert.strictEqual(entries.length, 5, `混合布局应展开出 5 行，实际 ${entries.length}：${entries.map((e) => e.releaseKey).join(', ')}`);
    const byKey = new Map(entries.map((e) => [e.releaseKey, e]));

    const m2 = byKey.get(twoSegLatest)!;
    assert.ok(m2, 'M2 两段 releaseKey（<v>/<d>）必须被列出');
    assert.strictEqual(m2.version, '2.0.0', '两段 version 取首段');
    assert.strictEqual(m2.deploymentId, DEP_3, '两段 deploymentId 取尾段');
    assert.strictEqual(m2.isCurrent, true, 'M3 current 指两段时该行必须 isCurrent');
    assert.strictEqual(m2.hasLog, true);
    assert.strictEqual(m2.logPath, path.join(releases, '2.0.0', DEP_3, 'app.log'));
    assert.strictEqual(m2.deployDir, path.join(releases, '2.0.0', DEP_3), '两段 deployDir 必须落两层');

    const m2s = byKey.get(twoSegSuffixed)!;
    assert.ok(m2s, '带唯一后缀的组内部署也必须一行');
    assert.strictEqual(m2s.version, '2.0.0');
    assert.strictEqual(m2s.deploymentId, DEP_3, '尾段唯一后缀不属于部署身份（严格形状剥除）');
    assert.strictEqual(m2s.isCurrent, false);

    const m2o = byKey.get(twoSegOlder)!;
    assert.ok(m2o, '同组多个部署目录各自成行（不下钻即丢）');
    assert.strictEqual(m2o.deploymentId, DEP_2);
    assert.strictEqual(m2o.isCurrent, false);

    const m1n = byKey.get(oneSegNewer)!;
    assert.ok(m1n, 'M1 旧单段必须原样一行（不因新增两段而回归）');
    assert.strictEqual(m1n.version, '1.9.0', '旧单段 version 反解自目录名');
    assert.strictEqual(m1n.deploymentId, DEP_2);
    assert.strictEqual(m1n.isCurrent, false, 'current 指两段时旧单段行不得误标 isCurrent');
    assert.strictEqual(m1n.hasLog, true);
    assert.strictEqual(m1n.logPath, path.join(releases, oneSegNewer, 'app.log'));

    const m1o = byKey.get(oneSegOldest)!;
    assert.strictEqual(m1o.version, '1.5.0');
    assert.strictEqual(m1o.deploymentId, DEP_1);

    // 同一 deploymentId 在两种布局各有一行（真实：跨版本重复部署），不得去重。
    assert.strictEqual(
      entries.filter((e) => e.deploymentId === DEP_2).length,
      2,
      '同一 deploymentId 在旧单段与新两段各一行，不得互相吞并',
    );
    // 展开不得把版本组目录本身当一行（假条目反证）。
    assert.ok(!byKey.has('2.0.0'), '版本组目录不得成为独立行（只下钻不出组行）');

    // ── B. splitReleaseKey 纯函数面：混合形态的反解与归一 ─────────────
    assert.deepStrictEqual(splitReleaseKey(twoSegLatest), { version: '2.0.0', deploymentId: DEP_3 });
    assert.deepStrictEqual(splitReleaseKey(twoSegSuffixed), { version: '2.0.0', deploymentId: DEP_3 });
    assert.deepStrictEqual(splitReleaseKey(oneSegNewer), { version: '1.9.0', deploymentId: DEP_2 });
    assert.deepStrictEqual(splitReleaseKey(`2.0.0-beta.1/${DEP_1}`), { version: '2.0.0-beta.1', deploymentId: DEP_1 });
    assert.strictEqual(splitReleaseKey('2.0.0').version, null, '裸版本目录名（空组）不解析成部署');

    // ── C. readCurrentReleaseKey 的两种相对形态 ────────────────────────
    assert.strictEqual(
      readCurrentReleaseKey(appRoot),
      twoSegLatest,
      'M3：current 指两段时必须返回 <v>/<d> 整段（basename 会丢版本段）',
    );
    // M4：current 改指旧单段——相对形态即目录名本身，且 isCurrent 跟随切换。
    fs.rmSync(path.join(appRoot, 'current'));
    setCurrent(appRoot, releases, oneSegNewer);
    assert.strictEqual(
      readCurrentReleaseKey(appRoot),
      oneSegNewer,
      "M4：current 指旧单段时返回目录名原样（不带 '/')",
    );
    entries = (await listDeployedApps(workDir)).filter((e) => e.appId === APP_M);
    const m4cur = entries.find((e) => e.releaseKey === oneSegNewer)!;
    const m2After = entries.find((e) => e.releaseKey === twoSegLatest)!;
    assert.strictEqual(m4cur.isCurrent, true, 'M4：current 指旧单段时该行 isCurrent');
    assert.strictEqual(m2After.isCurrent, false, 'current 切走后原两段行必须撤下 isCurrent');

    // ── D. uninstall 路径解析：两段/单段 key 落到磁盘真目录 ────────────
    const twoSegResolve = resolveReleaseDir(workDir, APP_M, twoSegLatest);
    assert.strictEqual(twoSegResolve.ok, true, '两段 releaseKey 必须可解析');
    if (twoSegResolve.ok) {
      assert.strictEqual(twoSegResolve.releaseDir, path.join(releases, '2.0.0', DEP_3));
      assert.ok(fs.existsSync(twoSegResolve.releaseDir), '解析结果必须真实存在于磁盘');
    }
    const oneSegResolve = resolveReleaseDir(workDir, APP_M, oneSegNewer);
    assert.strictEqual(oneSegResolve.ok, true, '旧单段 releaseKey 照旧可解析');
    if (oneSegResolve.ok) {
      assert.strictEqual(oneSegResolve.releaseDir, path.join(releases, oneSegNewer));
      assert.ok(fs.existsSync(oneSegResolve.releaseDir));
    }
    assert.strictEqual(resolveAppRoot(workDir, APP_M).ok, true);
    // 反证：三段（穿越面）与空段仍拒。
    assert.strictEqual(resolveReleaseDir(workDir, APP_M, '2.0.0/d/x').ok, false);
    assert.strictEqual(resolveReleaseDir(workDir, APP_M, '2.0.0/').ok, false);

    // ── E. canDeleteRelease 闸门 + deleteReleaseDir 真实删除 ──────────
    // current（现指旧单段 oneSegNewer）不可删；两段非 current 可删且删得掉。
    assert.strictEqual(
      canDeleteRelease({
        releaseKey: twoSegLatest,
        currentKey: readCurrentReleaseKey(appRoot),
        runningDeploymentId: null,
        deploymentId: DEP_3,
      }).ok,
      true,
      '非 current 的两段 release 必须可删（否则新布局下撤销部署名存实亡）',
    );
    assert.strictEqual(
      canDeleteRelease({
        releaseKey: oneSegNewer,
        currentKey: readCurrentReleaseKey(appRoot),
        runningDeploymentId: null,
        deploymentId: DEP_2,
      }).ok,
      false,
      'current 指旧单段时该行必须被闸门拒绝',
    );
    const delTwoSeg = deleteReleaseDir(path.join(releases, '2.0.0', DEP_2));
    assert.strictEqual(delTwoSeg.ok, true, '删除两段 release 目录不得抛错');
    assert.strictEqual(fs.existsSync(path.join(releases, '2.0.0', DEP_2)), false, '两段目标必须真被删掉');
    assert.strictEqual(fs.existsSync(path.join(releases, '2.0.0', DEP_3)), true, '同组其他部署不得被误删');
    assert.strictEqual(fs.existsSync(path.join(releases, oneSegNewer)), true, '旧单段不得被误删');
    assert.strictEqual(fs.existsSync(path.join(appRoot, 'current')), true, 'current 链不得被误删');

    // ════ 场景 R：retention 版本组裁剪（每次重建目录树，直接子级钉 mtime） ═
    // retention 的保留单位是 releases/ 的**直接子目录**：两段布局下即版本组
    // 目录（'3.0.0'），旧单段下即 release 目录本身（'1.9.0-<dep>'）。混合
    // 布局 = 同一 releases/ 下两种直接子级并存。mtime 全部显式钉死（新→旧
    // 排序确定，不依赖创建顺序/文件系统时间精度）。
    interface RChild {
      kind: 'group' | 'single';
      dir: string; // 直接子目录名
      deps: string[]; // group: 组内部署；single: [该 release 的 deploymentId]
      mtimeSec: number;
    }
    const buildR = (children: RChild[]): void => {
      for (const c of children) {
        if (c.kind === 'group') {
          for (const dep of c.deps) seedRelease(releases, `${c.dir}/${dep}`);
          pinMtime(path.join(releases, c.dir), c.mtimeSec);
        } else {
          seedRelease(releases, c.dir);
          pinMtime(path.join(releases, c.dir), c.mtimeSec);
        }
      }
    };
    const rebuild = async (
      children: RChild[],
      currentKeyOnDisk: string,
      running: ReadonlySet<string> | null,
      keep: number,
    ) => {
      fs.rmSync(path.join(appRoot, 'current'), { force: true });
      fs.rmSync(releases, { recursive: true, force: true });
      buildR(children);
      setCurrent(appRoot, releases, currentKeyOnDisk);
      return await sweepAppReleases({
        workDir,
        fetchRunningDeploymentIds: async () => running,
        keep,
      });
    };

    // R1（M3 形态）：current 指最新两段组；候选是两个旧单段 → 都淘汰。
    {
      const children: RChild[] = [
        { kind: 'group', dir: '3.0.0', deps: [DEP_3], mtimeSec: 40 },
        { kind: 'group', dir: '2.0.0', deps: [DEP_2], mtimeSec: 39 },
        { kind: 'single', dir: `1.9.0-${DEP_2}`, deps: [DEP_2], mtimeSec: 38 },
        { kind: 'single', dir: `1.5.0-${DEP_1}`, deps: [DEP_1], mtimeSec: 37 },
      ];
      const sweep = await rebuild(children, `3.0.0/${DEP_3}`, new Set(), 2);
      const outcome = sweep.apps.find((a) => a.appId === APP_M)!;
      assert.ok(outcome, 'sweep 必须扫到混合布局应用');
      assert.deepStrictEqual(
        outcome.deleted.sort(),
        [`1.9.0-${DEP_2}`, `1.5.0-${DEP_1}`].sort(),
        'keep=2：两个旧单段（最旧候选）被淘汰，current 组与次新组保留',
      );
      assert.ok(!fs.existsSync(path.join(releases, `1.9.0-${DEP_2}`)), '旧单段候选必须真被删');
      assert.ok(!fs.existsSync(path.join(releases, `1.5.0-${DEP_1}`)));
      assert.ok(fs.existsSync(path.join(releases, '3.0.0', DEP_3)), 'current 组（两段）保留');
      assert.ok(fs.existsSync(path.join(releases, '2.0.0', DEP_2)), '次新组保留');
    }

    // R2（M4 形态）：current 指**最旧**的旧单段（回滚）→ 闸门按整键拒绝，
    // 只有另一候选被淘汰。
    {
      const children: RChild[] = [
        { kind: 'group', dir: '3.0.0', deps: [DEP_3], mtimeSec: 40 },
        { kind: 'group', dir: '2.0.0', deps: [DEP_2], mtimeSec: 39 },
        { kind: 'single', dir: `1.9.0-${DEP_2}`, deps: [DEP_2], mtimeSec: 38 },
        { kind: 'single', dir: `1.5.0-${DEP_1}`, deps: [DEP_1], mtimeSec: 37 },
      ];
      const sweep = await rebuild(children, `1.5.0-${DEP_1}`, new Set(), 2);
      const outcome = sweep.apps.find((a) => a.appId === APP_M)!;
      assert.deepStrictEqual(
        outcome.deleted,
        [`1.9.0-${DEP_2}`],
        'M4：current 指旧单段时该键被闸门拒绝，仅淘汰另一最旧候选',
      );
      assert.ok(
        fs.existsSync(path.join(releases, `1.5.0-${DEP_1}`)),
        'current 指向的旧单段必须留在磁盘',
      );
      assert.ok(
        outcome.skipped.some((s) => s.startsWith(`1.5.0-${DEP_1}`)),
        'current 候选必须进 skipped 并带原因',
      );
    }

    // R2b（M3 回滚形态）：current 指**最旧两段组**。候选键是组目录名
    // （'1.5.0'），currentKey 是 '1.5.0/<dep>'——豁免必须按「current 所在
    // 版本组」判定，否则回滚后一轮清扫就会删掉正在生效的版本组（current
    // 悬空、应用直接不可用）。
    {
      const children: RChild[] = [
        { kind: 'group', dir: '3.0.0', deps: [DEP_3], mtimeSec: 40 },
        { kind: 'group', dir: '2.0.0', deps: [DEP_2], mtimeSec: 39 },
        { kind: 'group', dir: '1.5.0', deps: [DEP_1], mtimeSec: 38 },
        { kind: 'single', dir: `1.0.0-${DEP_2}`, deps: [DEP_2], mtimeSec: 37 },
      ];
      const sweep = await rebuild(children, `1.5.0/${DEP_1}`, new Set(), 2);
      const outcome = sweep.apps.find((a) => a.appId === APP_M)!;
      assert.ok(
        !outcome.deleted.includes('1.5.0'),
        'M3 回滚：current 指向的两段版本组绝不能被淘汰（组键 ≠ currentKey 整键，须按组豁免）',
      );
      assert.ok(
        fs.existsSync(path.join(releases, '1.5.0', DEP_1)),
        'current 组的部署目录必须留在磁盘',
      );
      assert.deepStrictEqual(outcome.deleted, [`1.0.0-${DEP_2}`], '其余最旧候选照常淘汰');
      assert.ok(
        outcome.skipped.some((s) => s.startsWith('1.5.0')),
        'current 组候选应进 skipped 并带原因',
      );
    }

    // R3：running 部署在候选**两段组**内 → 整组跳过（保守闸门，混合布局下
    // 与旧单段的 running 判定并存）。
    {
      const children: RChild[] = [
        { kind: 'group', dir: '3.0.0', deps: [DEP_3], mtimeSec: 40 },
        { kind: 'group', dir: '2.0.0', deps: [DEP_2], mtimeSec: 39 },
        { kind: 'group', dir: '1.5.0', deps: [DEP_1], mtimeSec: 38 },
        { kind: 'single', dir: `1.0.0-${DEP_2}`, deps: [DEP_2], mtimeSec: 37 },
      ];
      const sweep = await rebuild(children, `3.0.0/${DEP_3}`, new Set([DEP_1]), 2);
      const outcome = sweep.apps.find((a) => a.appId === APP_M)!;
      assert.deepStrictEqual(
        outcome.deleted,
        [`1.0.0-${DEP_2}`],
        'running 所在的候选组整组跳过，仅淘汰无闸门命中的最旧候选',
      );
      assert.ok(fs.existsSync(path.join(releases, '1.5.0', DEP_1)), 'running 部署所在目录保留');
      assert.ok(fs.existsSync(path.join(releases, '3.0.0', DEP_3)), 'current 组保留');
      assert.ok(
        outcome.skipped.some((s) => s.startsWith('1.5.0')),
        'running 组候选应进 skipped',
      );
    }

    console.log('mixed-layout.selftest: OK');
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
