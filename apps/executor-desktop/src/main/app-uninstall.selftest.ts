/**
 * 用户报障回归 selftest：本地「撤销部署（删除）」与「应用名回溯」。
 *
 * 背景（两条真实报障）：
 *   1) 「客户端本地无法查看部署的应用文件夹 也无法撤销部署(删除)」——桌面端
 *      此前完全没有删除/打开目录的能力；
 *   2) 「显示的应用也是ID形式 我都看不出是什么应用」——旧部署没有 app.json，
 *      列表只能显示 appId（UUID）。
 *
 * 本 selftest 用**真实文件系统**验证删除的路径校验与保护条件（不 mock fs：
 * 目录布局/软链类缺陷在全 mock 下会整体逃逸），断言：
 *   · resolveAppRoot/resolveReleaseDir 的白名单 + containment 拒绝越界路径；
 *   · current 指向的版本不可删（删了应用直接不可用）；
 *   · 运行中的版本不可删；
 *   · uninstallApp 在 executor 可达时走路由、**被拒时不回落本地删除**、
 *     连不上时才回落本地删除（且确实删掉了目录）；
 *   · 日志回溯出的 releaseKey→appName 只填 null 条目、绝不覆盖 app.json。
 *
 * Run via: npm run test:main
 */
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  isSafeAppId,
  resolveAppRoot,
  resolveReleaseDir,
  canDeleteRelease,
  readCurrentReleaseKey,
  deleteReleaseDir,
  uninstallApp,
  type LocalRouteResult,
} from './app-uninstall';
import {
  parseReleaseAppNames,
  applyRecoveredAppNames,
  collectReleaseAppNames,
  resetReleaseAppNameCache,
} from './app-name-recovery';

const APP_A = '11111111-1111-4111-8111-111111111111';
const DEP_A1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const DEP_A2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

/** 造一个已部署应用的磁盘布局（与 executor-node 的真实布局同形）。 */
function seedApp(workDir: string, appId: string, keys: string[]): string {
  const appRoot = path.join(workDir, 'apps', appId);
  const releases = path.join(appRoot, 'releases');
  fs.mkdirSync(releases, { recursive: true });
  fs.mkdirSync(path.join(appRoot, 'tmp'), { recursive: true });
  for (const key of keys) {
    const dir = path.join(releases, key);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'app.log'), `log for ${key}\n`);
  }
  if (keys.length > 0) {
    fs.symlinkSync(
      path.join(releases, keys[keys.length - 1]),
      path.join(appRoot, 'current'),
      'junction',
    );
  }
  return appRoot;
}

async function main(): Promise<void> {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'acf-uninst-'));

  try {
    // ── 路径校验：白名单 + containment ────────────────────────────────
    assert.strictEqual(isSafeAppId(APP_A), true);
    for (const bad of ['', '.', '..', 'a/b', 'a\\b', '../x', '/abs', null, 42]) {
      assert.strictEqual(isSafeAppId(bad), false, `isSafeAppId 必须拒绝 ${String(bad)}`);
    }
    // 反证：即便 appId 过了白名单，解析结果也必须落在 <workDir>/apps 内。
    const okRoot = resolveAppRoot(workDir, APP_A);
    assert.strictEqual(okRoot.ok, true);
    if (okRoot.ok) {
      assert.strictEqual(okRoot.appRoot, path.join(workDir, 'apps', APP_A));
    }
    // 遍历/绝对路径必须被拒（否则 rm -rf 能打到任意目录）。
    for (const evil of ['../..', '..', 'a/b', 'C:\\Windows', '/etc']) {
      const r = resolveAppRoot(workDir, evil);
      assert.strictEqual(r.ok, false, `越界 appId ${evil} 必须被拒`);
    }
    // releaseKey 同样受约束，且必须落在 <appsRoot>/<appId>/releases 内。
    assert.strictEqual(resolveReleaseDir(workDir, APP_A, '../..').ok, false);
    assert.strictEqual(resolveReleaseDir(workDir, APP_A, 'a/b').ok, false);
    const okRel = resolveReleaseDir(workDir, APP_A, `1.0.0-${DEP_A1}`);
    assert.strictEqual(okRel.ok, true);
    if (okRel.ok) {
      assert.strictEqual(
        okRel.releaseDir,
        path.join(workDir, 'apps', APP_A, 'releases', `1.0.0-${DEP_A1}`),
      );
    }

    // ── 保护条件：current / 运行中 不可删 ─────────────────────────────
    const appRoot = seedApp(workDir, APP_A, [`1.0.0-${DEP_A1}`, `1.0.1-${DEP_A2}`]);
    const currentKey = readCurrentReleaseKey(appRoot);
    assert.strictEqual(currentKey, `1.0.1-${DEP_A2}`, 'current 必须解析到最新 release');
    const delCurrent = canDeleteRelease({
      releaseKey: `1.0.1-${DEP_A2}`,
      currentKey,
      runningDeploymentId: null,
      deploymentId: DEP_A2,
    });
    assert.strictEqual(delCurrent.ok, false, '当前生效版本必须不可删');
    if (!delCurrent.ok) assert.match(delCurrent.reason, /当前生效/);
    const delRunning = canDeleteRelease({
      releaseKey: `1.0.0-${DEP_A1}`,
      currentKey,
      runningDeploymentId: DEP_A1,
      deploymentId: DEP_A1,
    });
    assert.strictEqual(delRunning.ok, false, '运行中的版本必须不可删');
    if (!delRunning.ok) assert.match(delRunning.reason, /正在运行/);
    // 非 current、未运行的历史版本可以删。
    assert.strictEqual(
      canDeleteRelease({
        releaseKey: `1.0.0-${DEP_A1}`,
        currentKey,
        runningDeploymentId: null,
        deploymentId: DEP_A1,
      }).ok,
      true,
      '既非 current 也未运行的历史版本必须可删（否则"撤销部署"名存实亡）',
    );

    // ── 删单个 release：只删目标目录，current 与其他 release 完好 ─────
    const target = path.join(appRoot, 'releases', `1.0.0-${DEP_A1}`);
    const del = deleteReleaseDir(target);
    assert.strictEqual(del.ok, true);
    assert.strictEqual(fs.existsSync(target), false, '目标 release 目录必须被删除');
    assert.strictEqual(
      fs.existsSync(path.join(appRoot, 'releases', `1.0.1-${DEP_A2}`)),
      true,
      '其他 release 不得被误删',
    );
    assert.strictEqual(
      fs.existsSync(path.join(appRoot, 'current')),
      true,
      'current 链不得被误删',
    );
    // 幂等：再删一次不抛错。
    assert.strictEqual(deleteReleaseDir(target).ok, true);

    // ── 卸载整个应用 ─────────────────────────────────────────────────
    // ① executor 可达且成功 → 走 executor（唯一会先停 daemon 的路径）。
    let posted: { path: string; body: unknown } | null = null;
    const viaExecutor = await uninstallApp({
      workDir,
      appId: APP_A,
      post: async (p, body) => {
        posted = { path: p, body };
        return {
          ok: true,
          reached: true,
          status: 200,
          body: { ok: true, stopped: ['d1'], removed: true },
        };
      },
    });
    assert.strictEqual(viaExecutor.ok, true);
    assert.strictEqual(viaExecutor.mode, 'executor');
    assert.deepStrictEqual(viaExecutor.stopped, ['d1']);
    assert.strictEqual(posted!.path, '/api/app-uninstall');
    assert.deepStrictEqual(posted!.body, { appId: APP_A });
    assert.strictEqual(
      fs.existsSync(appRoot),
      true,
      '走 executor 路由时桌面端不得自行删目录（由 executor 删，否则漏掉停 daemon）',
    );

    // ①b **HTTP 200 但目录没删掉**：executor 的 /app-uninstall 把 rmSync 失败
    // catch 进应答体、状态码仍是 200（deploy.ts 的 `{ok:true, removed, error}`）。
    // 只看状态码会把「没删掉」报成成功——用户以为清干净了、实际还在。
    const hiddenFail = await uninstallApp({
      workDir,
      appId: APP_A,
      post: async (): Promise<LocalRouteResult> => ({
        ok: true,
        reached: true,
        status: 200,
        body: { ok: true, stopped: ['d1'], removed: false, error: 'EBUSY: resource busy' },
      }),
    });
    assert.strictEqual(
      hiddenFail.ok,
      false,
      'HTTP 200 但 removed=false 必须判为失败（反证：不得只看状态码）',
    );
    assert.match(String(hiddenFail.error), /EBUSY/);
    // 已停掉的进程仍要如实回报（部分成功），否则用户不知道应用是否还在跑。
    assert.deepStrictEqual(hiddenFail.stopped, ['d1']);

    // ② executor 可达但**拒绝**（如路径校验失败）→ 绝不回落本地删除。
    const refused = await uninstallApp({
      workDir,
      appId: APP_A,
      post: async (): Promise<LocalRouteResult> => ({
        ok: false,
        reached: true,
        status: 400,
        error: 'appId 非法',
      }),
    });
    assert.strictEqual(refused.ok, false);
    assert.strictEqual(refused.mode, 'executor');
    assert.strictEqual(refused.error, 'appId 非法');
    assert.strictEqual(
      fs.existsSync(appRoot),
      true,
      '执行器明确拒绝时不得绕过它 rm -rf（会丢掉"停 daemon"这一步）',
    );

    // ③ executor 连不上 → 回落本地删除（此时无进程登记，删目录是安全的）。
    const offline = await uninstallApp({
      workDir,
      appId: APP_A,
      post: async (): Promise<LocalRouteResult> => ({
        ok: false,
        reached: false,
        error: 'ECONNREFUSED',
      }),
    });
    assert.strictEqual(offline.ok, true);
    assert.strictEqual(offline.mode, 'local');
    assert.strictEqual(fs.existsSync(appRoot), false, 'executor 未运行时必须真的删掉目录');
    // 幂等：目录已不存在时再卸载一次仍返回成功。
    const again = await uninstallApp({
      workDir,
      appId: APP_A,
      post: async (): Promise<LocalRouteResult> => ({ ok: false, reached: false }),
    });
    assert.strictEqual(again.ok, true, '重复卸载必须幂等成功（目录本就不存在）');

    // ④ 越界 appId 在**发起任何请求之前**就被拒（不给 executor 送脏参数）。
    let called = false;
    const evilUninstall = await uninstallApp({
      workDir,
      appId: '../../etc',
      post: async () => {
        called = true;
        return { ok: true, reached: true };
      },
    });
    assert.strictEqual(evilUninstall.ok, false);
    assert.strictEqual(called, false, '越界 appId 不得触达 executor');

    // ── 应用名回溯（日志 → releaseKey→appName）────────────────────────
    // 真实日志行形态（取自本机 executor-2026-09-2*.log）。
    const KEY = '1.0.1-dae29737-f8f2-423f-a0bf-7044b4b8988b-muczolhj-8t4-1';
    const sample = [
      '2026-09-23 02:10:11 [info] [deploy] Downloading package...',
      `2026-09-23 02:10:12 [info] [deploy] Current release for refund-sync now points to ${KEY}`,
      '2026-09-23 02:10:12 [info] [deploy] Deployment complete',
      '[deploy] Current release for 订单同步服务 now points to 1.0.0-dae29737-f8f2-423f-a0bf-7044b4b8988b',
    ].join('\n');
    const hits = parseReleaseAppNames(sample);
    assert.strictEqual(hits.length, 2, '只应识别真正的 Current release 行');
    assert.deepStrictEqual(hits[0], { releaseKey: KEY, appName: 'refund-sync' });
    // 反证：不含关键字的行不得被误匹配（否则会把无关文本当成应用名）。
    assert.deepStrictEqual(parseReleaseAppNames('[deploy] Current release for x'), []);
    assert.deepStrictEqual(parseReleaseAppNames('now points to nothing'), []);

    // 合并：只填 appName===null 的条目，**绝不**覆盖 app.json 的权威值。
    const merged = applyRecoveredAppNames(
      [
        { appName: null, releaseKey: KEY, tag: 'recovered' },
        { appName: '权威名字', releaseKey: KEY, tag: 'authoritative' },
        { appName: null, releaseKey: 'unknown-key', tag: 'unresolved' },
      ],
      new Map([[KEY, 'refund-sync']]),
    );
    assert.strictEqual(merged[0].appName, 'refund-sync', 'null 条目应被回溯值填补');
    assert.strictEqual(
      merged[1].appName,
      '权威名字',
      'app.json 是权威来源，绝不被日志推断覆盖',
    );
    assert.strictEqual(
      merged[2].appName,
      null,
      '回溯不到时必须保持 null（不得用 appId 或空串冒充名字）',
    );

    // ── collectReleaseAppNames：真实日志目录 + 缓存 ───────────────────
    const logDir = path.join(workDir, 'logs');
    fs.mkdirSync(logDir, { recursive: true });
    fs.writeFileSync(
      path.join(logDir, 'executor-2026-09-23.log'),
      `[deploy] Current release for refund-sync now points to ${KEY}\n`,
    );
    resetReleaseAppNameCache();
    const names = collectReleaseAppNames(logDir);
    assert.strictEqual(names.get(KEY), 'refund-sync');
    // 非 executor-YYYY-MM-DD.log 的文件不参与（避免把任意文件当日志解析）。
    fs.writeFileSync(path.join(logDir, 'main.log'), 'garbage');
    resetReleaseAppNameCache();
    assert.strictEqual(collectReleaseAppNames(logDir).get(KEY), 'refund-sync');
    // 目录不存在 → 空 Map（不是异常）。
    assert.strictEqual(collectReleaseAppNames(path.join(workDir, 'nope')).size, 0);
    assert.strictEqual(collectReleaseAppNames(undefined).size, 0);

    console.log('app-uninstall.selftest: OK');
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

void main();
