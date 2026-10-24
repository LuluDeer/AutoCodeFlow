/**
 * P10（executor 包版本收敛）：installedPackages 扫描 / TTL 缓存 / 心跳收集器
 * / manifest 原子写（形态对齐 deployed-apps.spec.ts）。
 *
 * 覆盖：manifest 写入形状与 tmp+rename 原子性（无 .tmp 残留）、多 manifest
 * 扫描与排序、损坏 JSON / 缺字段条目跳过且不毒化整份清单、非 packageId 形态
 * 文件排除、manifests/ 不存在 → 空数组、目录级不可读 → 抛错（收集器兜成
 * 省略整键）、TTL 命中与主动失效、缓存键含 baseDir。
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

jest.mock('./logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import { logger } from './logger';
import {
  collectInstalledPackages,
  invalidateInstalledPackagesCache,
  MANIFESTS_DIRNAME,
  resetInstalledPackagesCacheForTest,
  scanInstalledPackages,
  writePackageManifest,
} from './installed-packages';

// 测试数据：packageId 取 admin 侧真实形态（UUID），name/type/version 取推送
// 载荷透传形态（type ∈ ExecutorPackageType：node|python|universal）。
const PKG_A = '11111111-1111-4111-8111-111111111111';
const PKG_B = '22222222-2222-4222-8222-222222222222';
const PKG_C = '33333333-3333-4333-8333-333333333333';

function makeBaseDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'acf-installed-pkgs-'));
}

/** update-package.ts 落盘形态的 manifest（经写面函数，保证读写两侧同源）。 */
function seedManifest(
  baseDir: string,
  m: {
    packageId: string;
    name?: string;
    type?: string;
    version?: string;
    checksum?: string;
  },
): void {
  writePackageManifest(baseDir, {
    downloadedAt: '2026-10-24T10:00:00.000Z',
    ...m,
  });
}

describe('writePackageManifest（update-package.ts 的写面）', () => {
  it('checksum 验证通过后写入完整形状；tmp+rename 后无 .tmp 残留', () => {
    const baseDir = makeBaseDir();
    const p = writePackageManifest(baseDir, {
      packageId: PKG_A,
      name: 'node-runtime',
      type: 'node',
      version: '22.0.0',
      checksum: 'a'.repeat(64),
      downloadedAt: '2026-10-24T10:00:00.000Z',
    });

    expect(p).toBe(path.join(baseDir, MANIFESTS_DIRNAME, `${PKG_A}.json`));
    const onDisk = JSON.parse(fs.readFileSync(p, 'utf-8'));
    expect(onDisk).toEqual({
      packageId: PKG_A,
      name: 'node-runtime',
      type: 'node',
      version: '22.0.0',
      checksum: 'a'.repeat(64),
      downloadedAt: '2026-10-24T10:00:00.000Z',
    });
    // 原子写不留半成品（读面按后缀忽略 .tmp，但残留本身就是写面未收敛）
    const leftovers = fs
      .readdirSync(path.join(baseDir, MANIFESTS_DIRNAME))
      .filter((f) => f.includes('.tmp'));
    expect(leftovers).toEqual([]);
  });

  it('同 packageId 重复推送（多版本覆盖）整文件替换，不残留旧字段', () => {
    const baseDir = makeBaseDir();
    seedManifest(baseDir, {
      packageId: PKG_A,
      name: 'python-runtime',
      type: 'python',
      version: '3.11.0',
    });
    // 覆盖推送：version 变了，name 也变了——旧值不得以「半份 JSON」形态渗漏
    seedManifest(baseDir, {
      packageId: PKG_A,
      name: 'python-runtime',
      type: 'python',
      version: '3.12.0',
      checksum: 'b'.repeat(64),
    });
    const files = fs.readdirSync(path.join(baseDir, MANIFESTS_DIRNAME));
    expect(files).toEqual([`${PKG_A}.json`]); // 一条 manifest，不是两条
    const m = JSON.parse(
      fs.readFileSync(path.join(baseDir, MANIFESTS_DIRNAME, files[0]), 'utf-8'),
    );
    expect(m.version).toBe('3.12.0');
  });

  it('packageId 不安全 → 抛错（写面防御，文件名来自它）', () => {
    const baseDir = makeBaseDir();
    expect(() =>
      writePackageManifest(baseDir, {
        packageId: '../escape',
        name: 'x',
        type: 'node',
        version: '1.0.0',
      }),
    ).toThrow();
  });
});

describe('scanInstalledPackages', () => {
  it('多 manifest → 契约数组（name/version 排序稳定，type 原样透传）', () => {
    const baseDir = makeBaseDir();
    seedManifest(baseDir, { packageId: PKG_B, name: 'uv', type: 'python', version: '0.7.12' });
    seedManifest(baseDir, { packageId: PKG_A, name: 'node-runtime', type: 'node', version: '22.0.0' });
    seedManifest(baseDir, { packageId: PKG_C, name: 'universal-agent', type: 'universal', version: '1.0.0' });

    expect(scanInstalledPackages(baseDir)).toEqual([
      { name: 'node-runtime', type: 'node', version: '22.0.0' },
      { name: 'universal-agent', type: 'universal', version: '1.0.0' },
      { name: 'uv', type: 'python', version: '0.7.12' },
    ]);
  });

  it('损坏 JSON → 跳过该条并 warn，其余照报（不毒化整份清单）', () => {
    const baseDir = makeBaseDir();
    seedManifest(baseDir, { packageId: PKG_A, name: 'node-runtime', type: 'node', version: '22.0.0' });
    fs.writeFileSync(
      path.join(baseDir, MANIFESTS_DIRNAME, `${PKG_B}.json`),
      '{ not valid json',
    );

    const out = scanInstalledPackages(baseDir);
    expect(out).toEqual([{ name: 'node-runtime', type: 'node', version: '22.0.0' }]);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining(`${PKG_B}.json`),
    );
  });

  it('缺 name/type/version 之一 → 跳过该条（不造默认值）', () => {
    const baseDir = makeBaseDir();
    seedManifest(baseDir, { packageId: PKG_A, name: 'node-runtime', type: 'node', version: '22.0.0' });
    // 只有 packageId + downloadedAt，无版本事实
    fs.writeFileSync(
      path.join(baseDir, MANIFESTS_DIRNAME, `${PKG_B}.json`),
      JSON.stringify({ packageId: PKG_B, downloadedAt: '2026-10-24T10:00:00.000Z' }),
    );

    const out = scanInstalledPackages(baseDir);
    expect(out).toEqual([{ name: 'node-runtime', type: 'node', version: '22.0.0' }]);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining(PKG_B));
  });

  it('非 manifest 文件（.tmp 残留/子目录/异常文件名）排除', () => {
    const baseDir = makeBaseDir();
    seedManifest(baseDir, { packageId: PKG_A, name: 'node-runtime', type: 'node', version: '22.0.0' });
    const dir = path.join(baseDir, MANIFESTS_DIRNAME);
    fs.writeFileSync(path.join(dir, `.tmp-junk`), 'junk');
    fs.writeFileSync(path.join(dir, 'readme.txt'), 'not a manifest');
    fs.mkdirSync(path.join(dir, 'subdir.json')); // 同后缀目录，非文件

    expect(scanInstalledPackages(baseDir)).toEqual([
      { name: 'node-runtime', type: 'node', version: '22.0.0' },
    ]);
  });

  it('manifests/ 不存在 → 空数组（从未成功下载过：真事实，非失败）', () => {
    const baseDir = makeBaseDir();
    expect(scanInstalledPackages(baseDir)).toEqual([]);
  });

  it('manifests/ 目录级不可读 → 抛错（由收集器兜成省略整键）', () => {
    const baseDir = makeBaseDir();
    fs.writeFileSync(path.join(baseDir, MANIFESTS_DIRNAME), 'not a directory');
    expect(() => scanInstalledPackages(baseDir)).toThrow();
  });
});

describe('collectInstalledPackages（缓存 + 失败语义）', () => {
  const ORIGINAL_CWD = process.cwd();

  afterEach(() => {
    jest.useRealTimers();
    resetInstalledPackagesCacheForTest();
  });

  afterAll(() => {
    process.chdir(ORIGINAL_CWD);
  });

  function chdirToFreshRoot(): string {
    // 收集器扫 <cwd>/.pkg-updates/manifests——重定向 cwd 到隔离临时根
    const root = makeBaseDir();
    process.chdir(root);
    return root;
  }

  it('TTL 内命中缓存；过期后重扫（不经写面的磁盘变化兜底）', () => {
    jest.useFakeTimers();
    const root = chdirToFreshRoot();
    seedManifest(path.join(root, '.pkg-updates'), {
      packageId: PKG_A,
      name: 'node-runtime',
      type: 'node',
      version: '22.0.0',
    });

    const first = collectInstalledPackages()!;
    expect(first).toEqual([{ name: 'node-runtime', type: 'node', version: '22.0.0' }]);

    // TTL（复用 DEPLOYED_APPS_SCAN_TTL_SECONDS 默认 60s）内：缓存命中，不重扫
    seedManifest(path.join(root, '.pkg-updates'), {
      packageId: PKG_B,
      name: 'uv',
      type: 'python',
      version: '0.7.12',
    });
    jest.advanceTimersByTime(59_999);
    expect(collectInstalledPackages()).toEqual(first);

    // 越过 TTL：重扫看到新包
    jest.advanceTimersByTime(2);
    expect(collectInstalledPackages()!).toHaveLength(2);
  });

  it('invalidateInstalledPackagesCache（manifest 落盘后的主动失效）立即重扫', () => {
    const root = chdirToFreshRoot();
    const updates = path.join(root, '.pkg-updates');
    expect(collectInstalledPackages()).toEqual([]);

    seedManifest(updates, { packageId: PKG_A, name: 'node-runtime', type: 'node', version: '22.0.0' });
    invalidateInstalledPackagesCache(); // update-package.ts 落盘后调用
    expect(collectInstalledPackages()!).toEqual([
      { name: 'node-runtime', type: 'node', version: '22.0.0' },
    ]);
  });

  it('cwd 变化不复用旧缓存（缓存键含 baseDir）', () => {
    const rootA = chdirToFreshRoot();
    seedManifest(path.join(rootA, '.pkg-updates'), {
      packageId: PKG_A,
      name: 'node-runtime',
      type: 'node',
      version: '22.0.0',
    });
    expect(collectInstalledPackages()![0].name).toBe('node-runtime');

    const rootB = makeBaseDir();
    process.chdir(rootB);
    expect(collectInstalledPackages()).toEqual([]); // rootB 无 manifests/
  });

  it('manifests/ 不存在 → 空数组（可上报的「无安装包」事实）', () => {
    chdirToFreshRoot();
    expect(collectInstalledPackages()).toEqual([]);
  });

  it('目录级扫描失败 → undefined（心跳省略整键）、warn、且失败结果不缓存', () => {
    const root = chdirToFreshRoot();
    fs.writeFileSync(path.join(root, '.pkg-updates'), 'not a directory');

    expect(collectInstalledPackages()).toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('installed-packages'),
    );

    // 失败不缓存：磁盘修复后下一次调用立即可见（无需等 TTL）
    fs.rmSync(path.join(root, '.pkg-updates'));
    seedManifest(path.join(root, '.pkg-updates'), {
      packageId: PKG_A,
      name: 'node-runtime',
      type: 'node',
      version: '22.0.0',
    });
    expect(collectInstalledPackages()!).toEqual([
      { name: 'node-runtime', type: 'node', version: '22.0.0' },
    ]);
  });
});
