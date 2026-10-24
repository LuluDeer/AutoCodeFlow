/**
 * R3-B（部署模型评审 2026-10-23 §4.3/§P5，executor-node 侧）：deployedApps
 * 扫描 / TTL 缓存 / 心跳收集器。
 *
 * 覆盖：目录/软链/app.json 解析、releaseKey 后缀归一（与桌面端 splitReleaseKey
 * 对齐的三条规则）、断链与缺 app.json 的 null 语义、prune 后 retainedVersions
 * 反映磁盘真值、缓存 TTL 命中与失效、扫描抛错时收集器返回 undefined（心跳
 * 省略整键）且失败结果不缓存。
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

jest.mock('./logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import { logger } from './logger';
import {
  collectDeployedAppsForHeartbeat,
  invalidateDeployedAppsCache,
  parseReleaseVersion,
  resetDeployedAppsCacheForTest,
  scanDeployedApps,
} from './deployed-apps';

// 测试数据：appId/deploymentId 均取 deploy.ts 实际写入的形态（UUID）。
const APP_A = '11111111-1111-4111-8111-111111111111';
const APP_B = '22222222-2222-4222-8222-222222222222';
const APP_C = '33333333-3333-4333-8333-333333333333';
const APP_EMPTY = '44444444-4444-4444-8444-444444444444';
const DEP_100 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const DEP_123 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const DEP_200 = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const DEP_300 = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

function makeWorkDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'acf-deployed-apps-'));
}

/** 造 releases/<releaseKey> 目录并返回其绝对路径（deploy.ts 落盘形态）。 */
function seedRelease(workDir: string, appId: string, releaseKey: string): string {
  const dir = path.join(workDir, 'apps', appId, 'releases', releaseKey);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** current 软链/junction → releases/<releaseKey>（switchCurrentRelease 形态）。 */
function setCurrent(workDir: string, appId: string, releaseKey: string): void {
  const appRoot = path.join(workDir, 'apps', appId);
  fs.symlinkSync(
    path.join(appRoot, 'releases', releaseKey),
    path.join(appRoot, 'current'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
}

function writeAppJson(workDir: string, appId: string, meta: Record<string, unknown>): void {
  fs.writeFileSync(
    path.join(workDir, 'apps', appId, 'app.json'),
    JSON.stringify(meta, null, 2),
    'utf-8',
  );
}

describe('parseReleaseVersion (与桌面端 splitReleaseKey 的 version 分支对齐)', () => {
  it.each([
    ['1.2.3-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', '1.2.3'],
    // resolveReleasePaths 的唯一后缀（UUID 已定位，后缀属于发布细节）
    ['1.2.3-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb-m4c1h8-8t4-1x', '1.2.3'],
    // 预发布标签里的 '-'：不能从左切第一个 '-'
    ['1.0.0-alpha.1-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', '1.0.0-alpha.1'],
    // 老格式短 hash 尾
    ['1.0.1-dae29737', '1.0.1'],
    // 短 hash + 唯一后缀（桌面端文档里的实测形态）
    ['1.0.1-dae29737-muczolhj-8t4-1', '1.0.1'],
  ])('%s → %s', (key, expected) => {
    expect(parseReleaseVersion(key)).toBe(expected);
  });

  it('解析不出 → null（不用原名冒充版本）', () => {
    expect(parseReleaseVersion('not-a-release-key')).toBeNull();
    // 剥掉后缀后仍解析不出的异常目录名不得被误伤成 "not"
    expect(parseReleaseVersion('not-a-release-key-8t4-1x-2y')).toBeNull();
  });
});

describe('scanDeployedApps', () => {
  it('从 deploy.ts 落盘布局解析 current/app.json/retained（完整事实链）', () => {
    const workDir = makeWorkDir();
    seedRelease(workDir, APP_A, `1.0.0-${DEP_100}`);
    seedRelease(workDir, APP_A, `1.2.3-${DEP_123}`);
    setCurrent(workDir, APP_A, `1.2.3-${DEP_123}`);
    writeAppJson(workDir, APP_A, {
      appId: APP_A,
      appName: 'refund-sync',
      runMode: 'daemon',
      lastVersion: '1.2.3',
      lastDeployedAt: '2026-10-23T10:00:00.000Z',
    });

    expect(scanDeployedApps(workDir)).toEqual([
      {
        appId: APP_A,
        currentVersion: '1.2.3',
        currentReleaseKey: `1.2.3-${DEP_123}`,
        retainedVersions: ['1.0.0', '1.2.3'],
        runMode: 'daemon',
        lastDeployedAt: '2026-10-23T10:00:00.000Z',
      },
    ]);
  });

  it('缺 app.json：currentVersion 由 releaseKey 归一兜底，runMode/lastDeployedAt 为 null', () => {
    const workDir = makeWorkDir();
    // 短 hash + 唯一后缀：同时验证「无 app.json 时的归一兜底」走完整剥后缀链
    seedRelease(workDir, APP_B, '2.0.0-dae29737-muczolhj-8t4-1');
    setCurrent(workDir, APP_B, '2.0.0-dae29737-muczolhj-8t4-1');

    expect(scanDeployedApps(workDir)).toEqual([
      {
        appId: APP_B,
        currentVersion: '2.0.0',
        currentReleaseKey: '2.0.0-dae29737-muczolhj-8t4-1',
        retainedVersions: ['2.0.0'],
        runMode: null,
        lastDeployedAt: null,
      },
    ]);
  });

  it('current 悬空：currentReleaseKey/currentVersion 均 null（app.json 的 lastVersion 不冒充活版本）', () => {
    const workDir = makeWorkDir();
    seedRelease(workDir, APP_C, `3.0.0-${DEP_300}`);
    const appRoot = path.join(workDir, 'apps', APP_C);
    // current 指向已被删除的 release（悬空链；realpath 解析即抛）
    fs.symlinkSync(
      path.join(appRoot, 'releases', `9.9.9-${DEP_300}`),
      path.join(appRoot, 'current'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    writeAppJson(workDir, APP_C, {
      runMode: 'once',
      lastVersion: '3.0.0',
      lastDeployedAt: '2026-10-23T11:00:00.000Z',
    });

    expect(scanDeployedApps(workDir)).toEqual([
      {
        appId: APP_C,
        currentVersion: null,
        currentReleaseKey: null,
        retainedVersions: ['3.0.0'],
        runMode: 'once',
        lastDeployedAt: '2026-10-23T11:00:00.000Z',
      },
    ]);
  });

  it('非 appId 形态目录排除；空应用目录仍上报（retainedVersions 为空是真事实）', () => {
    const workDir = makeWorkDir();
    fs.mkdirSync(path.join(workDir, 'apps', '__MACOSX', 'releases'), { recursive: true });
    fs.mkdirSync(path.join(workDir, 'apps', APP_EMPTY));

    expect(scanDeployedApps(workDir)).toEqual([
      {
        appId: APP_EMPTY,
        currentVersion: null,
        currentReleaseKey: null,
        retainedVersions: [],
        runMode: null,
        lastDeployedAt: null,
      },
    ]);
  });

  it('单应用 releases 不可读：跳过该应用并 warn，其余照报', () => {
    const workDir = makeWorkDir();
    fs.mkdirSync(path.join(workDir, 'apps', APP_A), { recursive: true });
    // releases 是普通文件 → readdirSync ENOTDIR（非 ENOENT）→ 单应用级失败
    fs.writeFileSync(path.join(workDir, 'apps', APP_A, 'releases'), 'not a dir');
    seedRelease(workDir, APP_B, `2.0.0-${DEP_200}`);
    setCurrent(workDir, APP_B, `2.0.0-${DEP_200}`);

    const facts = scanDeployedApps(workDir);
    expect(facts.map((f) => f.appId)).toEqual([APP_B]);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining(APP_A));
  });

  it('prune 后 retainedVersions 反映磁盘真值（去重、排序稳定）', () => {
    const workDir = makeWorkDir();
    seedRelease(workDir, APP_A, `1.0.0-${DEP_100}`);
    seedRelease(workDir, APP_A, `1.2.3-${DEP_123}`);
    // 同版本重复部署（resolveReleasePaths 另起带后缀目录）→ 归一后去重
    seedRelease(workDir, APP_A, `1.2.3-${DEP_123}-m4c1h8-8t4-1x`);
    setCurrent(workDir, APP_A, `1.2.3-${DEP_123}`);
    expect(scanDeployedApps(workDir)[0].retainedVersions).toEqual(['1.0.0', '1.2.3']);

    // pruneOldReleases 删掉最旧的 1.0.0 → 清单立即收缩
    fs.rmSync(path.join(workDir, 'apps', APP_A, 'releases', `1.0.0-${DEP_100}`), {
      recursive: true,
      force: true,
    });
    expect(scanDeployedApps(workDir)[0].retainedVersions).toEqual(['1.2.3']);
  });

  // ── 5c（§9.7）：双布局识别 ─────────────────────────────────────────────
  // 新两段 releases/<version>/<deploymentId>/ 目录名即版本；旧单段后缀反解。
  // 验收口径：混合布局下版本归一无重复。
  it('5c 新两段布局：组目录名即版本，组内多部署去重', () => {
    const workDir = makeWorkDir();
    // 新布局：2.0.0 组内两个部署（其一带唯一后缀——resolveReleasePaths 形态）。
    seedRelease(workDir, APP_A, '2.0.0/' + DEP_200);
    seedRelease(workDir, APP_A, `2.0.0/${DEP_200}-m4c1h8-8t4-1x`);
    seedRelease(workDir, APP_A, '2.1.0/' + DEP_300);
    setCurrent(workDir, APP_A, '2.1.0/' + DEP_300);
    writeAppJson(workDir, APP_A, {
      runMode: 'daemon',
      lastVersion: '2.1.0',
      lastDeployedAt: '2026-10-24T10:00:00.000Z',
    });

    expect(scanDeployedApps(workDir)).toEqual([
      {
        appId: APP_A,
        currentVersion: '2.1.0',
        currentReleaseKey: '2.1.0/' + DEP_300,
        retainedVersions: ['2.0.0', '2.1.0'], // 组内两部署归一成一个版本
        runMode: 'daemon',
        lastDeployedAt: '2026-10-24T10:00:00.000Z',
      },
    ]);
  });

  it('5c 混合布局：旧单段 + 新两段并存，版本归一无重复（验收口径）', () => {
    const workDir = makeWorkDir();
    // 同一版本 1.2.3 的旧单段目录与新两段组并存（迁移窗口的真实形态：
    // 升级执行器前部署的 1.2.3 是单段，升级后重装同版本落到两段组）。
    seedRelease(workDir, APP_A, `1.0.0-${DEP_100}`);
    seedRelease(workDir, APP_A, `1.2.3-${DEP_123}`);
    seedRelease(workDir, APP_A, '1.2.3/' + DEP_123);
    seedRelease(workDir, APP_A, `1.2.3/${DEP_123}-m4c1h8-8t4-1x`);
    setCurrent(workDir, APP_A, '1.2.3/' + DEP_123);

    const fact = scanDeployedApps(workDir)[0];
    expect(fact.retainedVersions).toEqual(['1.0.0', '1.2.3']); // 无重复
    expect(fact.currentVersion).toBe('1.2.3');
    expect(fact.currentReleaseKey).toBe('1.2.3/' + DEP_123);
  });

  it('5c 两段 current 悬空/缺 app.json：versionFromReleaseKey 首段兜底', () => {
    const workDir = makeWorkDir();
    seedRelease(workDir, APP_B, '2.0.0/' + DEP_200);
    setCurrent(workDir, APP_B, '2.0.0/' + DEP_200);
    // 无 app.json → currentVersion 由 releaseKey 首段归一兜底。

    expect(scanDeployedApps(workDir)).toEqual([
      {
        appId: APP_B,
        currentVersion: '2.0.0',
        currentReleaseKey: '2.0.0/' + DEP_200,
        retainedVersions: ['2.0.0'],
        runMode: null,
        lastDeployedAt: null,
      },
    ]);
  });

  it('apps/ 不存在 → 空数组（从未部署过：真事实，非失败）', () => {
    expect(scanDeployedApps(path.join(os.tmpdir(), 'acf-no-such-workdir-r3b'))).toEqual([]);
  });

  it('apps/ 目录级不可读 → 抛错（由收集器兜成省略整键）', () => {
    const workDir = makeWorkDir();
    fs.writeFileSync(path.join(workDir, 'apps'), 'not a directory');
    expect(() => scanDeployedApps(workDir)).toThrow();
  });
});

describe('collectDeployedAppsForHeartbeat（缓存 + 失败语义）', () => {
  const ORIGINAL_WORK_DIR = process.env.WORK_DIR;
  const ORIGINAL_TTL = process.env.DEPLOYED_APPS_SCAN_TTL_SECONDS;

  beforeAll(() => {
    // TTL 用默认 60s 断言命中/过期边界，不受宿主环境影响。
    delete process.env.DEPLOYED_APPS_SCAN_TTL_SECONDS;
  });

  afterEach(() => {
    jest.useRealTimers();
    resetDeployedAppsCacheForTest();
    if (ORIGINAL_WORK_DIR === undefined) delete process.env.WORK_DIR;
    else process.env.WORK_DIR = ORIGINAL_WORK_DIR;
  });

  afterAll(() => {
    if (ORIGINAL_TTL === undefined) delete process.env.DEPLOYED_APPS_SCAN_TTL_SECONDS;
    else process.env.DEPLOYED_APPS_SCAN_TTL_SECONDS = ORIGINAL_TTL;
  });

  it('TTL 内命中缓存；过期后重扫（deploy.ts 之外的下磁盘变化兜底）', () => {
    jest.useFakeTimers();
    const workDir = makeWorkDir();
    seedRelease(workDir, APP_A, `1.0.0-${DEP_100}`);
    process.env.WORK_DIR = workDir;

    const first = collectDeployedAppsForHeartbeat()!;
    expect(first).toHaveLength(1);
    expect(first[0].retainedVersions).toEqual(['1.0.0']);

    // TTL（默认 60s）内：磁盘变化不可见——缓存命中，不重扫
    seedRelease(workDir, APP_A, `1.2.3-${DEP_123}`);
    jest.advanceTimersByTime(59_999);
    expect(collectDeployedAppsForHeartbeat()).toEqual(first);

    // 越过 TTL：重扫看到新 release
    jest.advanceTimersByTime(2);
    expect(collectDeployedAppsForHeartbeat()![0].retainedVersions).toEqual([
      '1.0.0',
      '1.2.3',
    ]);
  });

  it('invalidateDeployedAppsCache（部署成功后的主动失效）立即重扫', () => {
    const workDir = makeWorkDir();
    seedRelease(workDir, APP_A, `1.0.0-${DEP_100}`);
    process.env.WORK_DIR = workDir;

    expect(collectDeployedAppsForHeartbeat()![0].retainedVersions).toEqual(['1.0.0']);
    seedRelease(workDir, APP_A, `1.2.3-${DEP_123}`);
    invalidateDeployedAppsCache();
    // 无需等 TTL：部署链路失效缓存后下一次心跳即上报新版本
    expect(collectDeployedAppsForHeartbeat()![0].retainedVersions).toEqual([
      '1.0.0',
      '1.2.3',
    ]);
  });

  it('workDir 变化不复用旧缓存（缓存键含 workDir）', () => {
    const workDirA = makeWorkDir();
    const workDirB = makeWorkDir();
    seedRelease(workDirA, APP_A, `1.0.0-${DEP_100}`);
    seedRelease(workDirB, APP_B, `2.0.0-${DEP_200}`);

    process.env.WORK_DIR = workDirA;
    expect(collectDeployedAppsForHeartbeat()![0].appId).toBe(APP_A);
    process.env.WORK_DIR = workDirB;
    expect(collectDeployedAppsForHeartbeat()![0].appId).toBe(APP_B);
  });

  it('apps/ 不存在 → 空数组（可上报的「无应用」事实）', () => {
    process.env.WORK_DIR = makeWorkDir();
    expect(collectDeployedAppsForHeartbeat()).toEqual([]);
  });

  it('目录级扫描失败 → undefined（心跳省略整键）、warn、且失败结果不缓存', () => {
    const workDir = makeWorkDir();
    fs.writeFileSync(path.join(workDir, 'apps'), 'not a directory');
    process.env.WORK_DIR = workDir;

    expect(collectDeployedAppsForHeartbeat()).toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('deployed-apps'));

    // 失败不缓存：磁盘修复后下一次调用立即可见（无需等 TTL）
    fs.rmSync(path.join(workDir, 'apps'));
    seedRelease(workDir, APP_A, `1.0.0-${DEP_100}`);
    const after = collectDeployedAppsForHeartbeat()!;
    expect(after).toHaveLength(1);
    expect(after[0].appId).toBe(APP_A);
  });
});
