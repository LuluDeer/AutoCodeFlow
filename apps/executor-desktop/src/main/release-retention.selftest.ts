/**
 * B-13 self-check：releases 保留期自动清扫（node:assert，无测试框架）。
 * release-retention.ts 是纯 Node 模块，这里用**真实文件系统**（临时目录，
 * 形态对齐 app-uninstall.selftest）驱动真实实现。
 * Run via: npm run test:main
 *
 * 语义锁：
 *  - 每应用按 mtime 新→旧保留 RELEASE_RETENTION_KEEP 个，超出才清；
 *  - current 指向的版本绝不删（canDeleteRelease 闸门，与手动删除同语义）；
 *  - 执行器登记 running 的 deploymentId 绝不删；
 *  - 执行器状态未知（null）→ 本轮保守放弃（宁可不清，不冒险误删）；
 *  - 未超保留数 / releases 缺失 / workDir 缺失 → 无操作不报错；
 *  - 单应用删除失败不拖垮其余应用。
 */
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { RELEASE_RETENTION_KEEP, sweepAppReleases } from './release-retention';

const APP = '11111111-1111-4111-8111-111111111111';
const APP2 = '22222222-2222-4222-8222-222222222222';

/** 造 releases/<key> 目录并把 mtime 钉成递增（保证"新→旧"排序确定）。 */
function seedReleases(workDir: string, appId: string, keys: string[]): string {
  const appRoot = path.join(workDir, 'apps', appId);
  const releases = path.join(appRoot, 'releases');
  fs.mkdirSync(releases, { recursive: true });
  keys.forEach((key, i) => {
    const dir = path.join(releases, key);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'app.log'), `log for ${key}\n`);
    const t = new Date(Date.UTC(2026, 0, 1, 0, 0, i));
    fs.utimesSync(dir, t, t);
  });
  return appRoot;
}

function setCurrent(appRoot: string, releasesDir: string, key: string): void {
  // junction 指向 release 目录（readCurrentReleaseKey 走 realpath）
  fs.symlinkSync(path.join(releasesDir, key), path.join(appRoot, 'current'), 'junction');
}

function releaseKeysOnDisk(appRoot: string): string[] {
  const releases = path.join(appRoot, 'releases');
  if (!fs.existsSync(releases)) return [];
  return fs.readdirSync(releases).sort();
}

async function main(): Promise<void> {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'acf-retention-'));
  try {
    // ── 1. 常规清扫：8 个 release 保留 5，最旧 3 个被删 ─────────────
    {
      const appId = APP;
      const keys = [
        '1.0.0-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        '1.0.1-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        '1.0.2-cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        '1.0.3-dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        '1.0.4-eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
        '1.0.5-ffffffff-ffff-4fff-8fff-ffffffffffff',
        '1.0.6-11111111-1111-4111-9111-111111111111',
        '1.0.7-22222222-2222-4222-9222-222222222222',
      ];
      const appRoot = seedReleases(workDir, appId, keys);
      setCurrent(appRoot, path.join(appRoot, 'releases'), keys[7]); // current = 最新
      const outcome = await sweepAppReleases({
        workDir,
        fetchRunningDeploymentIds: async () => new Set(),
      });
      const app = outcome.apps.find((a) => a.appId === appId);
      assert.ok(app, '必须扫到该应用');
      assert.deepStrictEqual(
        app.deleted.sort(),
        [keys[0], keys[1], keys[2]].sort(),
        '超出保留数的最旧 3 个被删（按 mtime 新→旧保留 5）',
      );
      assert.strictEqual(app.skipped.length, 0);
      assert.deepStrictEqual(
        releaseKeysOnDisk(appRoot).sort(),
        keys.slice(3).sort(),
        '磁盘上只剩最新的 5 个',
      );
    }

    // ── 2. current 指向旧版本时也绝不删（闸门语义）────────────────────
    {
      const appId = APP2;
      const keys = [
        '2.0.0-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        '2.0.1-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        '2.0.2-cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        '2.0.3-dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        '2.0.4-eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
        '2.0.5-ffffffff-ffff-4fff-8fff-ffffffffffff',
        '2.0.6-11111111-1111-4111-9111-111111111111',
      ];
      const appRoot = seedReleases(workDir, appId, keys);
      // current 指向**最旧**的 2.0.0（回滚场景）：超保留数的候选里它最旧，
      // 但 current 绝不能删——应被 skipped 并保留在磁盘上。
      setCurrent(appRoot, path.join(appRoot, 'releases'), keys[0]);
      const outcome = await sweepAppReleases({
        workDir,
        fetchRunningDeploymentIds: async () => new Set(),
      });
      const app = outcome.apps.find((a) => a.appId === appId)!;
      assert.ok(!app.deleted.includes(keys[0]), 'current 指向的版本绝不删');
      assert.ok(
        app.skipped.some((s) => s.startsWith(keys[0])),
        'current 版本应进 skipped 且带原因',
      );
      assert.deepStrictEqual(app.deleted.sort(), [keys[1]].sort(), '其余最旧 1 个（2.0.1）被删');
      assert.ok(fs.existsSync(path.join(appRoot, 'releases', keys[0])), 'current 版本目录仍在');
    }

    // ── 3. 运行中的 daemon 版本不删 ──────────────────────────────────
    {
      const appId = '33333333-3333-4333-8333-333333333333';
      const keys = [
        '3.0.0-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        '3.0.1-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        '3.0.2-cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        '3.0.3-dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        '3.0.4-eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
        '3.0.5-ffffffff-ffff-4fff-8fff-ffffffffffff',
        '3.0.6-11111111-1111-4111-9111-111111111111',
      ];
      const appRoot = seedReleases(workDir, appId, keys);
      const runningDep = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'; // 3.0.0 的 deploymentId
      const outcome = await sweepAppReleases({
        workDir,
        fetchRunningDeploymentIds: async () => new Set([runningDep]),
      });
      const app = outcome.apps.find((a) => a.appId === appId)!;
      assert.ok(!app.deleted.includes(keys[0]), '执行器登记 running 的版本绝不删');
      assert.ok(app.skipped.some((s) => s.startsWith(keys[0])), 'running 版本应进 skipped');
      assert.deepStrictEqual(app.deleted, [keys[1]], '只有最旧且非 running 的 3.0.1 被删');
      assert.ok(fs.existsSync(path.join(appRoot, 'releases', keys[0])));
    }

    // ── 4. 执行器状态未知 → 整轮保守放弃 ─────────────────────────────
    {
      const appId = '44444444-4444-4444-8444-444444444444';
      const keys = Array.from({ length: 8 }, (_, i) => {
        const hex = String(i + 1).repeat(8);
        return `4.0.${i}-${hex}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`;
      });
      const appRoot = seedReleases(workDir, appId, keys);
      const before = releaseKeysOnDisk(appRoot);
      const outcome = await sweepAppReleases({
        workDir,
        fetchRunningDeploymentIds: async () => null,
      });
      assert.strictEqual(outcome.apps.length, 0, '状态未知：不做任何删除');
      assert.ok(outcome.errors.some((e) => e.includes('跳过')), '必须留下"保守跳过"的说明');
      assert.deepStrictEqual(releaseKeysOnDisk(appRoot), before, '磁盘零改动');
    }

    // ── 5. 未超保留数 / 缺目录 / 缺 workDir：无操作 ──────────────────
    {
      const appId = '55555555-5555-4555-8555-555555555555';
      const keys = Array.from({ length: RELEASE_RETENTION_KEEP }, (_, i) => {
        const hex = String(i + 1).repeat(8);
        return `5.0.${i}-${hex}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`;
      });
      const appRoot = seedReleases(workDir, appId, keys);
      const outcome = await sweepAppReleases({
        workDir,
        fetchRunningDeploymentIds: async () => new Set(),
      });
      const app = outcome.apps.find((a) => a.appId === appId)!;
      assert.strictEqual(app.deleted.length, 0, '未超保留数：零删除');
      assert.strictEqual(releaseKeysOnDisk(appRoot).length, RELEASE_RETENTION_KEEP);

      // 无 workDir：直接返回空
      const empty = await sweepAppReleases({ workDir: undefined, fetchRunningDeploymentIds: async () => new Set() });
      assert.strictEqual(empty.apps.length, 0);
      // apps 目录不存在：直接返回空
      const noDir = await sweepAppReleases({
        workDir: path.join(workDir, 'not-exist'),
        fetchRunningDeploymentIds: async () => new Set(),
      });
      assert.strictEqual(noDir.apps.length, 0);
    }

    // ── 6. 部分应用 releases 不可读：只记录，不影响其余应用 ──────────
    {
      const brokenApp = '66666666-6666-4666-8666-666666666666';
      const goodApp = '77777777-7777-4777-8777-777777777777';
      fs.mkdirSync(path.join(workDir, 'apps', brokenApp, 'releases'), { recursive: true });
      fs.writeFileSync(path.join(workDir, 'apps', brokenApp, 'releases', 'a-file'), 'x'); // 目录里混入文件
      const goodKeys = Array.from({ length: 7 }, (_, i) => {
        const hex = String(i + 1).repeat(8);
        return `7.0.${i}-${hex}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`;
      });
      seedReleases(workDir, goodApp, goodKeys);
      const outcome = await sweepAppReleases({
        workDir,
        fetchRunningDeploymentIds: async () => new Set(),
      });
      const good = outcome.apps.find((a) => a.appId === goodApp)!;
      assert.strictEqual(good.deleted.length, 2, '正常应用照常清扫');
      const broken = outcome.apps.find((a) => a.appId === brokenApp)!;
      assert.ok(broken.deleted.length === 0, '混入文件的应用不误删');
    }

    // ── 7. SYNC 结构守卫：触发点接线 ─────────────────────────────────
    {
      const read = (rel: string): string =>
        fs.readFileSync(path.join(__dirname, '..', 'src', 'main', rel), 'utf-8');
      const idx = read('index.ts');
      assert.ok(
        idx.includes('sweepReleasesWithCurrentConfig()'),
        'SYNC: index.ts 启动后必须触发保留期清扫',
      );
      assert.ok(
        idx.includes('executorProcess.onDeploySwitch'),
        'SYNC: index.ts 必须把部署成功日志钩子接到清扫',
      );
      const exec = read('executor-process.ts');
      assert.ok(
        exec.includes("line.includes('now points to')") && exec.includes('onDeploySwitch?.()'),
        'SYNC: executor-process 必须在部署切换日志行触发 onDeploySwitch',
      );
      const ipc = read('ipc-handlers.ts');
      assert.ok(
        ipc.includes('sweepAppReleases(') && ipc.includes('/api/app-status'),
        'SYNC: 清扫入口必须复用 /api/app-status 作为运行真值源',
      );
    }

    console.log('release-retention selftest: all assertions passed (keep-N by mtime, current/running gate, unknown-status bail, trigger wiring)');
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
