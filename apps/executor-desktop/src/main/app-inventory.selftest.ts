/**
 * 用户报障回归 selftest：执行器「本地已部署应用」列表的目录布局解析。
 *
 * 背景：executor-node 的真实布局是
 *   <workDir>/apps/<appId>/releases/<version>-<deploymentId>/app.log
 * （外加 current 软链、tmp 暂存）。而 apps:list 原实现把 appRoot 的**直接
 * 子目录**当成 deploymentId 下钻（apps/<appId>/<deploymentId>/app.log），于是：
 *   · 把 releases / tmp / current 当成「部署」列出（假条目，版本号丢失）；
 *   · 真实 app.log 位于 releases/<key>/ 下，永不匹配 → 每行恒显示「无日志」，
 *     用户点不开任何日志。
 *
 * 本 selftest 用**真实文件系统**构造上述布局（不 mock fs——deploy-fs.spec 的
 * 教训：全 mock fs 会让目录布局类缺陷整体逃逸），断言：
 *   1) 只列出 releases/ 下的真实版本，绝不出现 releases/tmp/current 假条目；
 *   2) app.log 存在时 hasLog=true 且 logPath 指向真实文件（可被读取）；
 *   3) releaseKey 正确拆出 version 与 deploymentId（含版本号带 '-' 的情形）；
 *   4) current 软链指向的那条被标记 isCurrent；
 *   5) 无 release 的应用不出假行（给一条显式的空占位，供 UI 如实呈现）。
 *
 * Run via: npm run test:main
 */
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { listDeployedApps, splitReleaseKey } from './app-inventory';

const APP_A = '11111111-1111-4111-8111-111111111111';
const DEP_A1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const DEP_A2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const APP_B = '22222222-2222-4222-8222-222222222222';

function main(): void {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'acf-appinv-'));
  const appsDir = path.join(workDir, 'apps');

  try {
    // ── 应用 A：两个 release + current 软链指向较新的那个 ──────────────
    const aRoot = path.join(appsDir, APP_A);
    const aReleases = path.join(aRoot, 'releases');
    fs.mkdirSync(aReleases, { recursive: true });
    fs.mkdirSync(path.join(aRoot, 'tmp'), { recursive: true });

    const keyA1 = `1.0.0-${DEP_A1}`;
    const keyA2 = `1.0.1-${DEP_A2}`;
    const dirA1 = path.join(aReleases, keyA1);
    const dirA2 = path.join(aReleases, keyA2);
    fs.mkdirSync(dirA1, { recursive: true });
    fs.mkdirSync(dirA2, { recursive: true });
    fs.writeFileSync(path.join(dirA1, 'app.log'), 'old run\n');
    fs.writeFileSync(path.join(dirA2, 'app.log'), 'listening on :8080\n');

    // 用户报障（看不出是哪个应用）：executor-node 部署成功时在 appRoot 落
    // app.json；列表据此显示真实应用名而不是 UUID。
    fs.writeFileSync(
      path.join(aRoot, 'app.json'),
      JSON.stringify({
        appId: APP_A,
        appName: '订单同步服务',
        runtime: 'node',
        runMode: 'daemon',
      }),
    );

    // current → 较新的 release（同 executor 侧的 switchCurrentRelease 语义）。
    fs.symlinkSync(dirA2, path.join(aRoot, 'current'), 'junction');

    // ── 应用 B：目录存在但没有任何 release（部署失败在解压阶段）────────
    fs.mkdirSync(path.join(appsDir, APP_B), { recursive: true });

    const entries = listDeployedApps(workDir);

    // 1) 绝不把 releases/tmp/current 当部署列出来（原缺陷的假条目）。
    for (const bogus of ['releases', 'tmp', 'current']) {
      assert.ok(
        !entries.some((e) => e.deploymentId === bogus || e.releaseKey === bogus),
        `假条目 "${bogus}" 不应出现在应用列表里（原缺陷形态）`,
      );
    }

    // 2) 应用 A 必须精确列出两个真实 release。
    const aEntries = entries.filter((e) => e.appId === APP_A);
    assert.strictEqual(aEntries.length, 2, `应用 A 应有 2 个 release，实际 ${aEntries.length}`);
    assert.deepStrictEqual(
      aEntries.map((e) => e.releaseKey).sort(),
      [keyA1, keyA2].sort(),
    );

    // 3) app.log 必须被找到——原实现这里恒为 false（用户报障的「无日志」）。
    const a2 = aEntries.find((e) => e.releaseKey === keyA2)!;
    assert.strictEqual(a2.hasLog, true, 'app.log 存在时必须 hasLog=true（原实现恒 false）');
    assert.strictEqual(a2.version, '1.0.1');
    assert.strictEqual(a2.deploymentId, DEP_A2);
    assert.strictEqual(fs.readFileSync(a2.logPath, 'utf-8'), 'listening on :8080\n');

    // 4) current 指向的那条被标记 isCurrent，另一条不是。
    assert.strictEqual(a2.isCurrent, true, 'current 指向的 release 必须标记 isCurrent');
    const a1 = aEntries.find((e) => e.releaseKey === keyA1)!;
    assert.strictEqual(a1.isCurrent, false);
    assert.strictEqual(a1.version, '1.0.0');
    assert.strictEqual(a1.deploymentId, DEP_A1);

    // 5) 无 release 的应用：给一条空占位（UI 才能如实显示），而不是凭空消失。
    const bEntries = entries.filter((e) => e.appId === APP_B);
    assert.strictEqual(bEntries.length, 1, '无 release 的应用应有一条显式占位');
    assert.strictEqual(bEntries[0].hasLog, false);
    assert.strictEqual(bEntries[0].releaseKey, '');
    // 没有 app.json → appName 必须是 **null**（"本机没记录过名字"），不能回落
    // 成 appId。反证：旧实现回落为 appId，UI 就把 UUID 当应用名渲染——正是用户
    // 报障的「显示的应用也是ID形式 我都看不出是什么应用」。null 让 UI 能区分
    // 「有名字」与「没名字」并给出可操作提示（见 app-name-recovery.ts）。
    assert.strictEqual(
      bEntries[0].appName,
      null,
      'app.json 缺失时 appName 必须为 null（不得用 appId 冒充应用名）',
    );

    // 6) app.json 存在时显示真实应用名（用户报障的另一半：看不出是哪个应用）。
    assert.strictEqual(a1.appName, '订单同步服务', 'app.json 的 appName 必须被读到');
    assert.strictEqual(a2.appName, '订单同步服务');
    // runMode 必须透出：UI 靠它解释「scheduled 模式只部署不启动，所以没有
    // app.log 是正常的」——没有它，「无日志」会被误读成故障。
    assert.strictEqual(a1.runMode, 'daemon', 'app.json 的 runMode 必须透出');

    // ── 用户报障核心回归：resolveReleasePaths 加唯一后缀的目录 ─────────
    // 同 (version, deploymentId) 重复部署时，executor 不覆盖活目录，而是另起
    // `releases/<key>-<ts36>-<pid36>-<seq36>`（deploy.ts::resolveReleasePaths）。
    // 旧解析器用 `^…-<uuid>$` 锚定结尾 → 这类目录一律解析失败，实测输出
    // `{version: null, deploymentId: '1.0.1-dae29737-…-muczolhj-8t4-1'}`，
    // 于是 UI 显示「版本未知」+ 一整串不可读 ID，且与同应用下正常解析的行并排。
    // 下面的字符串取自本机真实目录名（非构造）。
    const REAL_SUFFIXED = '1.0.1-dae29737-f8f2-423f-a0bf-7044b4b8988b-muczolhj-8t4-1';
    const suffixed = splitReleaseKey(REAL_SUFFIXED);
    assert.strictEqual(suffixed.version, '1.0.1', '带唯一后缀的目录必须解析出版本号');
    assert.strictEqual(
      suffixed.deploymentId,
      'dae29737-f8f2-423f-a0bf-7044b4b8988b',
      '带唯一后缀的目录必须解析出真实 deploymentId（后缀不属于部署身份）',
    );
    // 短 hash 老格式 + 唯一后缀（本机另一批真实目录形态）。
    const REAL_SUFFIXED_SHORT = '1.0.0-dae29737-f8f2-423f-a0bf-7044b4b8988b-muatp8dy-lv4-1';
    const suffixedShort = splitReleaseKey(REAL_SUFFIXED_SHORT);
    assert.strictEqual(suffixedShort.version, '1.0.0');
    assert.strictEqual(
      suffixedShort.deploymentId,
      'dae29737-f8f2-423f-a0bf-7044b4b8988b',
    );
    // 反证：后缀剥离**不得**误伤异常目录名。`not-a-release-key` 恰好满足
    // `-a-b-c` 后缀形状，若实现无条件剥离就会解析成 version=null,
    // deploymentId='not'——伪造出一个看起来合理的部署 ID。
    const stillWeird = splitReleaseKey('not-a-release-key');
    assert.strictEqual(
      stillWeird.deploymentId,
      'not-a-release-key',
      '后缀剥离只在剥完确实能解析时才允许采用（反证：不得把异常目录名切碎）',
    );

    // ── 用户报障：app.log 轮转后仍须算「有日志」──────────────────────
    // startApp 在启动新进程前把 app.log → .1 → .2 → .3（APP_LOG_KEEP=3）。
    // 于是「app.log 不存在但 app.log.1 存在」是合法状态（应用已停机/刚轮转）。
    // 旧实现只看 app.log → 显示「无日志」，用户点不进那份真实存在的历史输出。
    const keyA3 = `1.0.2-${DEP_A1}`;
    const dirA3 = path.join(aReleases, keyA3);
    fs.mkdirSync(dirA3, { recursive: true });
    fs.writeFileSync(path.join(dirA3, 'app.log.1'), 'rotated output\n');
    const rotated = listDeployedApps(workDir).find((e) => e.releaseKey === keyA3)!;
    assert.strictEqual(
      rotated.hasLog,
      true,
      'app.log 已轮转为 app.log.1 时必须仍算有日志（原实现恒 false）',
    );
    assert.strictEqual(rotated.logPath, path.join(dirA3, 'app.log.1'));
    // 无任何日志的 release 仍须如实为 false（反证：不能因为放宽就恒真）。
    fs.mkdirSync(path.join(aReleases, `1.0.3-${DEP_A2}`), { recursive: true });
    const noLog = listDeployedApps(workDir).find((e) => e.releaseKey === `1.0.3-${DEP_A2}`)!;
    assert.strictEqual(noLog.hasLog, false, '一份日志都没有时必须如实为 false');
    assert.strictEqual(noLog.logPath, '');

    // ── releaseKey 拆分：版本号含 '-'（预发布标签）不能切错 ────────────
    const pre = splitReleaseKey(`1.0.0-beta.1-${DEP_A1}`);
    assert.strictEqual(pre.version, '1.0.0-beta.1', '版本号内的 "-" 不应被当成 UUID 分隔符');
    assert.strictEqual(pre.deploymentId, DEP_A1);

    // 老格式短 hash（deploymentId 只有 8 位 hex，非完整 UUID）：宽松回退必须
    // 还原版本号——原实现整体回落为 deploymentId、version=null，UI 显示
    // 「版本未知 1.0.1-da」与「v1.0.1 dae29737」并排的矛盾形态（用户截图报障）。
    const shortHash = splitReleaseKey('1.0.1-dae29737');
    assert.strictEqual(shortHash.version, '1.0.1', '短 hash 老格式必须解析出版本号');
    assert.strictEqual(shortHash.deploymentId, 'dae29737');
    const shortHashPre = splitReleaseKey('1.0.0-beta.1-dae29737');
    assert.strictEqual(shortHashPre.version, '1.0.0-beta.1', '老格式带预发布标签同样要切对');
    assert.strictEqual(shortHashPre.deploymentId, 'dae29737');

    // 非 releaseKey（异常目录名）：不伪造数据，version 置 null 如实呈现。
    const weird = splitReleaseKey('not-a-release-key');
    assert.strictEqual(weird.version, null);
    assert.strictEqual(weird.deploymentId, 'not-a-release-key');

    // deployedAt：release 目录 mtime 必须透出（同版本多次部署靠它区分行）。
    assert.strictEqual(typeof a2.deployedAt, 'number', 'release 条目必须带 deployedAt');
    assert.ok((a2.deployedAt as number) > 0);
    assert.strictEqual(bEntries[0].deployedAt, null, '无 release 占位行 deployedAt 为 null');

    // ── 边界：无 workDir / 无 apps 目录 → 空列表（不是异常） ───────────
    assert.deepStrictEqual(listDeployedApps(undefined), []);
    assert.deepStrictEqual(
      listDeployedApps(path.join(workDir, 'no-such-dir')),
      [],
    );

    console.log('app-inventory.selftest: OK');
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

main();
