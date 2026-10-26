/**
 * P10（executor 包版本收敛）：设备级已安装执行器包清单 —— 心跳可选键
 * `installedPackages` 的数据源（形态对齐 deployed-apps.ts）。
 *
 * 扫描对象是 update-package.ts 的落盘事实（同一事实的写面/读面，写函数
 * writePackageManifest 也定义在本模块，读面与写面共享同一份 manifest 形状）：
 *
 *   <cwd>/.pkg-updates/
 *     ├─ <packageId>.zip|.tar.gz     ← download-only 制品（E-43：不就地应用）
 *     └─ manifests/<packageId>.json  ← checksum 验证通过后原子写（tmp+rename）：
 *                                      {packageId, name, type, version,
 *                                       checksum?, downloadedAt}
 *
 * ## 为什么以 manifest 而非 zip 为事实源
 * zip 只证明「下过」，不带 name/version/type（文件名只有 packageId）；manifest
 * 才是「装了哪个包的哪一版」的可判读事实。且 E-43 语义下 zip 会被部署流水线
 * 取走应用（应用后删除 zip ≠ 卸载），manifest 存续 = 已安装事实存续。zip 被
 * 清而 manifest 在 → 仍上报；manifest 被删 → 事实消失，扫描时如实缺省（不猜）。
 *
 * ## type 的取值口径（实测 admin 侧契约）
 * admin 侧 InstalledPackageDto.type **没有枚举**（自由字符串，≤32 字符，
 * normalizeInstalledPackages 只做非空校验）；上游事实源是 admin 推送载荷里的
 * pkg.type（executor-package.entity 的 ExecutorPackageType：node|python|
 * universal）。因此本模块**原样上报 manifest 里落盘的 type**（写面来自推送载荷），
 * 不发明新枚举值——admin 收到的就是它自己发出去的那个 type，闭环无漂移。
 *
 * ## fail-honest 纪律（与 deployed-apps.ts 同款）
 * · manifests/ 不存在 → 空数组（真事实：本机从未成功下载过任何执行器包）；
 * · manifests/ 目录级不可读 → 抛错，由收集器兜成「省略整键」；
 * · 单个 manifest 损坏/缺字段 → 跳过该条并 warn（数组内省略，其余照报）；
 *   name/type/version 三缺一即无法构成「装了哪个包的哪一版」事实（admin 侧
 *   normalizeInstalledPackages 对此整字段拒绝——读面逐条把关，别把整份清单
 *   的拒绝权留给中台），跳过而非造默认值。
 *
 * ## TTL 复用 DEPLOYED_APPS_SCAN_TTL_SECONDS 的理由
 * deployedApps 与 installedPackages 是同一份心跳载荷里的两份设备事实：同写面
 * 主动失效（部署成功/manifest 落盘即 invalidate）、同 30s 心跳节拍、同「TTL 只
 * 兜不经写面的磁盘变化」的定位。拆两个旋钮会让同一心跳里两份事实的新鲜度可以
 * 被配得不一致，而运维上不存在「要 installedPackages 比 deployedApps 更陈旧」
 * 的真实需求——一个心跳载荷一个新鲜度旋钮，少一个 env 就少一分误配面。
 */
import * as fs from 'fs';
import * as path from 'path';
import { config } from './config';
import { logger } from './logger';
import { isSafePathSegment } from './safe-path';

/** 心跳 installedPackages 条目（R3-B 契约，与 admin 侧 InstalledPackageReport
 * 逐字段一致，不得擅改）。 */
export interface InstalledPackageReport {
  name: string;
  type: string;
  version: string;
}

/** update-package.ts 落盘的 manifest 形状（写面见 writePackageManifest）。
 * name/type/version 由 admin 推送载荷透传；checksum/downloadedAt 供运维排查，
 * 不进心跳（心跳只报「装了哪个包的哪一版」）。 */
export interface PackageManifest {
  packageId: string;
  name?: string;
  type?: string;
  version?: string;
  checksum?: string;
  downloadedAt?: string;
}

/** .pkg-updates 根目录名（update-package.ts 制品落盘处，manifests/ 的父目录）。 */
export const PKG_UPDATES_DIRNAME = '.pkg-updates';
/** manifests 子目录名（写面 update-package.ts 与本读面共用）。 */
export const MANIFESTS_DIRNAME = 'manifests';
/** manifest 文件后缀。 */
export const MANIFEST_EXT = '.json';

/** 心跳组装点专用的根目录（与 update-package.ts 的 tmpDir 同一来源：cwd 下）。 */
function pkgUpdatesRoot(): string {
  return path.join(process.cwd(), PKG_UPDATES_DIRNAME);
}

/**
 * 原子写 manifest：同目录 tmp + rename（同文件系统保证 rename 原子；Node 的
 * rename 在 Windows 上同样覆盖已存在目标）。同 packageId 重复推送（多版本
 * 覆盖）时 rename 整文件替换旧 manifest——读面要么看到完整旧版、要么完整
 * 新版，绝无半份 JSON。写失败抛错（调用方决定语义），tmp 残留会被下一次
 * 同名写覆盖、且读面按后缀忽略。
 */
export function writePackageManifest(
  baseDir: string,
  manifest: PackageManifest,
): string {
  if (!isSafePathSegment(manifest.packageId)) {
    // 写面防御：路由已校验过 packageId，这里再挡一道（manifest 文件名来自它）。
    throw new Error(`packageId 含不受支持的字符: ${manifest.packageId}`);
  }
  const manifestsDir = path.join(baseDir, MANIFESTS_DIRNAME);
  fs.mkdirSync(manifestsDir, { recursive: true });
  const finalPath = path.join(manifestsDir, `${manifest.packageId}${MANIFEST_EXT}`);
  const tmpPath = path.join(
    manifestsDir,
    `.${manifest.packageId}${MANIFEST_EXT}.tmp`,
  );
  fs.writeFileSync(tmpPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf-8');
  fs.renameSync(tmpPath, finalPath);
  return finalPath;
}

/** 读单个 manifest 文件 → 心跳条目。损坏/缺字段 → null（调用方跳过并 warn）。 */
function readManifestFile(file: string): InstalledPackageReport | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch (err: unknown) {
    logger.warn(
      `[installed-packages] manifest 损坏，跳过 ${path.basename(file)}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    logger.warn(`[installed-packages] manifest 非对象，跳过 ${path.basename(file)}`);
    return null;
  }
  const m = parsed as Record<string, unknown>;
  const name = typeof m.name === 'string' ? m.name.trim() : '';
  const type = typeof m.type === 'string' ? m.type.trim() : '';
  const version = typeof m.version === 'string' ? m.version.trim() : '';
  if (!name || !type || !version) {
    logger.warn(
      `[installed-packages] manifest 缺 name/type/version 之一，跳过 ${path.basename(file)}`,
    );
    return null;
  }
  return { name, type, version };
}

/**
 * 全量扫描 <baseDir>/manifests/*.json，产出 installedPackages 契约数组（按
 * name/version 排序，输出稳定）。manifests/ 不存在 → []；目录级不可读 →
 * 抛错（由 collectInstalledPackages 兜成「省略整键」）。同 name 不同
 * packageId 的多个 manifest 各自成条（admin 侧契约不按 name 去重——两份
 * 制品都在磁盘上，就都是设备事实）。
 */
export function scanInstalledPackages(
  baseDir: string,
): InstalledPackageReport[] {
  const manifestsDir = path.join(baseDir, MANIFESTS_DIRNAME);
  let dirents: fs.Dirent[];
  try {
    dirents = fs.readdirSync(manifestsDir, { withFileTypes: true });
  } catch (err: any) {
    // ENOENT 的两种形态必须区分（2026-10-24 windows-node-tests 实测：Windows
    // 对「父路径是普通文件」的 readdir 也报 ENOENT，而非 Linux 的 ENOTDIR）：
    //  · 根目录存在且是目录、manifests/ 尚未创建 → 合法空清单（update-package
    //    首次成功下载前没有任何 manifest）；
    //  · 根路径不存在（全新环境）→ 同为合法空清单；
    //  · 根路径被普通文件占位 → 扫描失败，上抛由收集器兜成省略键——
    //    绝不能把「读不了」伪装成「没装过任何包」。
    if (err?.code === 'ENOENT') {
      try {
        if (!fs.existsSync(baseDir) || fs.statSync(baseDir).isDirectory()) {
          return [];
        }
      } catch {
        // stat 自身失败（权限等）——归入扫描失败路径
      }
    }
    throw err;
  }

  const out: InstalledPackageReport[] = [];
  for (const d of dirents) {
    if (!d.isFile()) continue;
    if (!d.name.endsWith(MANIFEST_EXT)) continue; // 原子写残留的 .tmp 等无关文件
    const stem = d.name.slice(0, -MANIFEST_EXT.length);
    // 非 packageId 形态文件名（外部/异常产物）不是「已安装包」事实。
    if (!isSafePathSegment(stem)) continue;
    const report = readManifestFile(path.join(manifestsDir, d.name));
    if (report) out.push(report);
  }
  return out.sort((a, b) =>
    a.name !== b.name
      ? a.name < b.name
        ? -1
        : 1
      : a.version < b.version
        ? -1
        : a.version > b.version
          ? 1
          : 0,
  );
}

/**
 * TTL 缓存（对齐 deployed-apps.ts 的 cache 形态）：manifest 数量是个位数，
 * 扫描本身极轻，但没必要每拍都扫。manifest 落盘后 update-package.ts 主动失效
 * （invalidateInstalledPackagesCache），「下载完成 → 下一次心跳上报新包」不受
 * TTL 拖延；TTL 兜住的是手工清理 manifests/ 等不经写面的磁盘变化。
 */
let cache: { baseDir: string; at: number; value: InstalledPackageReport[] } | null =
  null;

/** manifest 落盘后由 update-package.ts 调用：事实已变，下次心跳重扫。 */
export function invalidateInstalledPackagesCache(): void {
  cache = null;
}

/** 测试钩子：清缓存（对齐 resetDeployedAppsCacheForTest 先例）。 */
export function resetInstalledPackagesCacheForTest(): void {
  cache = null;
}

/**
 * 心跳组装点专用入口（sync：读的是少量小 JSON，量级与 deployed-apps 的同步
 * fs 用法一致）。命中缓存或扫描成功 → 契约数组（含 [] = 已上报且无安装包，
 * 真事实）；扫描失败 → **undefined**——JSON 序列化丢键 =「未上报」（admin
 * 保留旧值），心跳本体照发，绝不因扫描弄挂心跳。
 */
export function collectInstalledPackages(): InstalledPackageReport[] | undefined {
  const baseDir = pkgUpdatesRoot();
  if (
    cache &&
    cache.baseDir === baseDir &&
    Date.now() - cache.at < config.deployedAppsScanTtlSeconds * 1000
  ) {
    return cache.value;
  }
  try {
    const value = scanInstalledPackages(baseDir);
    cache = { baseDir, at: Date.now(), value };
    return value;
  } catch (err: unknown) {
    cache = null; // 失败结果不缓存（非事实）
    logger.warn(
      `[installed-packages] 扫描失败，本轮心跳不带 installedPackages 键: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return undefined;
  }
}
