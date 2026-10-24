/**
 * R3-B（部署模型评审 2026-10-23 §4.3 / §P5，executor-node 侧）：设备级应用版本
 * 事实扫描 —— 心跳可选键 `deployedApps` 的数据源。
 *
 * 扫描对象是 deploy.ts 的落盘布局（同一事实的写面/读面，本模块只读不写）。
 * 5c（评审 2026-10-23 §9.7）后**双布局并存**（迁移窗口：旧目录不搬，靠 prune
 * 自然淘汰；新部署落两段）：
 *
 *   <workDir>/apps/<appId>/
 *     ├─ app.json    ← deploy 成功时写（deploy.ts「app.json 元数据」段）：
 *                      appName / runMode / lastVersion / lastDeployedAt …
 *                      （commit 20a0b841 之前的旧部署没有这份文件）
 *     ├─ current     ← 软链/junction → releases/ 下的活 release
 *     └─ releases/
 *          ├─ <version>/<deploymentId>[-suffix]/   ← 新两段（2026-10-24 起）：
 *          │    目录名即版本，组内多部署共享同一版本
 *          └─ <version>-<deploymentId>[-suffix]/   ← 旧单段（迁移窗口兼容）：
 *               版本从目录名后缀反解（UUID/短 hash 定位）
 *
 * ## 与桌面端清单（executor-desktop/src/main/app-inventory.ts）的口径关系
 *
 * 同一磁盘布局的两份**独立**读面：桌面端面向本地 UI（每 release 一行，含日志
 * 名回溯）；本模块面向中台心跳（每应用一行）。releaseKey → 版本的归一规则
 * （UUID 形状定位 → 短 hash 尾回退 → 唯一后缀剥除重试）与桌面端 splitReleaseKey
 * 逐条对齐（见下方三个正则）；5c 两段布局两边都改为「目录名/首段即版本」，
 * 旧反解链只服务旧目录（迁移窗口结束后可一并删除）。不做共享收敛：
 * executor-desktop 不依赖 executor-node 的源码（各自独立构建，桌面端只把
 * executor-node 当子进程管理），跨 app 引入会让桌面端打包长出对执行器模块图
 * 的依赖，成本高于两份小函数保持对齐。
 *
 * ## R3 联动：currentReleaseKey 值形态变化（admin 零改动）
 *
 * 5c 后新部署的 currentReleaseKey 形如 `<version>/<deploymentId>`（含唯一后缀
 * 时为 `<version>/<deploymentId>-<suffix>`），旧值形如 `<version>-<deploymentId>`。
 * admin 侧对 releaseKey 只做**等值比对**（executor.service.ts 幂等短路 + entity
 * varchar 存储），不解析其结构；版本判定走 currentVersion（本模块归一产物），
 * resolveVersionFollowPackage 只读 currentVersion。executor_app_versions 表的
 * currentReleaseKey 历史值因此混两种形态——不影响任何判定路径，读面展示按
 * 原样字符串处理（本处注释即 admin 侧零改动的依据）。
 *
 * ## fail-honest 纪律（评审 §4.3：不造假数据）
 *
 * · apps/ 不存在 → 空数组（真事实：本机从未部署过应用，不是失败）；
 * · apps/ 不可读等目录级失败 → 抛错，由心跳组装点省略整键（collect 函数兜住）；
 * · 单应用读失败 → 跳过该应用并 warn（数组内省略，其余应用照报）；
 * · 单字段不可判定（无 current / 缺 app.json / releaseKey 解析不出版本）→
 *   该字段 null / 该元素不进 retainedVersions，绝不用 appId 或目录名冒充版本。
 */
import * as fs from 'fs';
import * as path from 'path';
import { config } from './config';
import { logger } from './logger';
import { isSafePathSegment } from './safe-path';

/** 心跳 deployedApps 条目（R3-B 契约，与 admin 侧 DTO 逐字段一致，不得擅改）。 */
export interface DeployedAppFact {
  appId: string;
  /** current 指向的活版本；软链缺失/悬空 → null。 */
  currentVersion: string | null;
  /** current 软链目标的 basename（releaseKey 原样）；无软链/断链 → null。 */
  currentReleaseKey: string | null;
  /** releases/ 现存目录归一出的版本集合（prune 后即磁盘真值；排序稳定）。 */
  retainedVersions: string[];
  runMode: 'once' | 'daemon' | 'scheduled' | null;
  /** app.json.lastDeployedAt（ISO，部署侧写入）；缺失/不可解析 → null。 */
  lastDeployedAt: string | null;
}

// ↓ 三条归一规则与 executor-desktop/src/main/app-inventory.ts 的 splitReleaseKey
// （UUID_ANYWHERE_RE / LOOSE_TAIL_RE / RELEASE_SUFFIX_RE）逐条对齐——改任何一条
// 都必须两边同步（见模块头「口径关系」）。
/** deploymentId 是 UUID（admin 侧 app_deployments 主键）：按形状定位，而不是
 *  从左切第一个 '-'（版本号本身可含 '-'，如预发布标签）。 */
const UUID_ANYWHERE_RE =
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
/** 老格式/短 hash 尾（如 `1.0.1-dae29737`）：semver 前缀 + 8 位以上 hex 尾。 */
const LOOSE_TAIL_RE = /^(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.]+)?)-([0-9a-f]{8,})$/i;
/** resolveReleasePaths 给重复部署加的唯一后缀（`-<ts36>-<pid36>-<seq36>`）。 */
const RELEASE_SUFFIX_RE = /-[0-9a-z]+-[0-9a-z]+-[0-9a-z]+$/;

function parseReleaseVersionDirect(key: string): string | null {
  const uuid = UUID_ANYWHERE_RE.exec(key);
  if (uuid) {
    // UUID 之后的一切（唯一后缀）都是发布细节，不属于版本身份。
    return key.slice(0, uuid.index).replace(/-+$/, '') || null;
  }
  const loose = LOOSE_TAIL_RE.exec(key);
  if (loose) return loose[1];
  return null;
}

/**
 * releaseKey → 版本号（无法判定 → null，不猜）。
 * 与桌面端 splitReleaseKey 的 version 分支同源：直接解析失败时剥唯一后缀再试
 * 一次，且**只在剥掉后确实能解析时才采用**（否则 `not-a-release-key` 这类异常
 * 目录名会被误伤成 `not`）。
 */
export function parseReleaseVersion(releaseKey: string): string | null {
  const direct = parseReleaseVersionDirect(releaseKey);
  if (direct !== null) return direct;
  const stripped = releaseKey.replace(RELEASE_SUFFIX_RE, '');
  if (stripped !== releaseKey) return parseReleaseVersionDirect(stripped);
  return null;
}

/**
 * 5c 双布局的 releaseKey → 版本：`<version>/<deploymentId>[-suffix]` 取首段；
 * 旧单段 `<version>-<deploymentId>[-suffix]` 走 parseReleaseVersion 反解。
 * 两段键的首段是 deploy.ts normalizeReleasePart 的产物（白名单字符、无分隔符），
 * 无需再过形态闸；解析不出（异常键）→ null，不猜。
 */
function versionFromReleaseKey(releaseKey: string): string | null {
  const slash = releaseKey.indexOf('/');
  if (slash > 0) {
    const head = releaseKey.slice(0, slash);
    return head !== '' ? head : null;
  }
  return parseReleaseVersion(releaseKey);
}

/** deploy.ts 落盘的 <appRoot>/app.json 里本模块关心的字段（缺失/损坏 → 全 null）。 */
interface AppMetaFacts {
  runMode: 'once' | 'daemon' | 'scheduled' | null;
  lastVersion: string | null;
  lastDeployedAt: string | null;
}

function readAppMeta(appRoot: string): AppMetaFacts {
  const empty: AppMetaFacts = {
    runMode: null,
    lastVersion: null,
    lastDeployedAt: null,
  };
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(path.join(appRoot, 'app.json'), 'utf-8'));
  } catch {
    return empty; // 旧部署没有这份文件 / 内容损坏：如实置 null
  }
  if (!parsed || typeof parsed !== 'object') return empty;
  const meta = parsed as Record<string, unknown>;
  const runMode =
    meta.runMode === 'once' || meta.runMode === 'daemon' || meta.runMode === 'scheduled'
      ? meta.runMode
      : null;
  const lastVersion =
    typeof meta.lastVersion === 'string' && meta.lastVersion.trim() !== ''
      ? meta.lastVersion
      : null;
  // 写侧是 new Date().toISOString()；不可解析（被手改/截断）的不采信。
  const lastDeployedAt =
    typeof meta.lastDeployedAt === 'string' &&
    !Number.isNaN(Date.parse(meta.lastDeployedAt))
      ? meta.lastDeployedAt
      : null;
  return { runMode, lastVersion, lastDeployedAt };
}

/**
 * current 软链/junction → 指向的 releaseKey（相对 releases/，POSIX 形态）。
 * 悬空/缺失/不可读 → null。走 realpathSync（与桌面端 readCurrentReleaseKey
 * 同判据）：Windows junction 与 POSIX dir 软链都能解析，断链在 resolve 阶段
 * 抛 ENOENT。
 *
 * 5c（§9.7）双布局：新两段 releases/<version>/<deploymentId> 的 basename 只剩
 * deploymentId（版本段丢失），必须取**相对 releases/ 的整段**；旧单段布局的
 * 相对路径无 '/'，原样即 releaseKey。realpath 已把软链解析到真实绝对路径，
 * relative(releasesDir, …) 对两种布局统一产出 '<version>/<deploymentId>' 或
 * '<version>-<deploymentId>'。
 */
function readCurrentReleaseKey(currentLink: string): string | null {
  try {
    const real = fs.realpathSync(currentLink);
    const releasesDir = path.join(path.dirname(currentLink), 'releases');
    const rel = path.relative(releasesDir, real);
    if (rel.startsWith('..') || path.isAbsolute(rel)) return null; // 指向 releases/ 之外：不归一
    return rel.split(path.sep).join('/');
  } catch {
    return null;
  }
}

/**
 * 扫描单个应用。返回 null = 该应用本轮不可判定（调用方跳过并 warn）。
 * releases/ 不存在（ENOENT）不算失败：部署中/从未成功发布的应用仍进清单，
 * 与桌面端 listDeployedApps 的口径一致。
 */
function scanOneApp(appId: string, appRoot: string): DeployedAppFact | null {
  // 列 apps/ 与读该应用之间可能被 uninstall 删目录（并发竞争）——目录已不在
  // 就静默跳过，既不算失败也不报幽灵条目。
  try {
    if (!fs.statSync(appRoot).isDirectory()) return null;
  } catch {
    return null;
  }

  const currentReleaseKey = readCurrentReleaseKey(path.join(appRoot, 'current'));
  const meta = readAppMeta(appRoot);

  const retained = new Set<string>();
  try {
    const releasesDir = path.join(appRoot, 'releases');
    const entries = fs.readdirSync(releasesDir, {
      withFileTypes: true,
    });
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      // 5c 双布局识别：releases/<version>/（组目录）——目录名即版本，不再
      // 反解；组内 <deploymentId>/ 子目录共享同一版本（retained 去重即得）。
      // 版本目录名仍过 parseReleaseVersion 的形态闸（strip 唯一后缀后需能
      // 解析出版本语义——目录名本身就是版本号，直接解析必过；异常名不进
      // 清单，与旧布局同一 fail-honest 姿态）。
      const nested = fs.readdirSync(path.join(releasesDir, e.name), {
        withFileTypes: true,
      });
      const hasReleaseChild = nested.some((c) => c.isDirectory());
      if (hasReleaseChild) {
        // 新两段：组目录（含至少一个部署子目录）——目录名即版本。
        retained.add(e.name);
        continue;
      }
      // 旧单段：releases/<version>-<deploymentId>/（组目录里没有部署子目录
      // 的两段空壳也落进这条兜底——按旧规则反解，解析不出就不进清单）。
      const version = parseReleaseVersion(e.name);
      // 解析不出的目录名（异常/外部产物）不进清单——不用原名冒充版本。
      if (version !== null) retained.add(version);
    }
  } catch (err: any) {
    if (err?.code !== 'ENOENT') {
      logger.warn(
        `[deployed-apps] releases/ 不可读，本轮跳过应用 ${appId}: ${err?.message ?? err}`,
      );
      return null;
    }
    // ENOENT：无任何 release 的应用目录，retainedVersions 为空数组（真事实）。
  }

  // currentVersion 描述 current 指向的**活**版本：软链缺失/悬空 → null（app.json
  // 的 lastVersion 只是「最后一次部署」的事实，不代表当前活版本）；软链在 →
  // 优先 app.json.lastVersion（部署侧切 current 与写 app.json 相邻，正常恒等于
  // 活 release 的版本），缺失时由 releaseKey 归一兜底：两段取首段（目录名即
  // 版本），旧单段走后缀反解。
  const currentVersion = currentReleaseKey
    ? (meta.lastVersion ?? versionFromReleaseKey(currentReleaseKey))
    : null;

  return {
    appId,
    currentVersion,
    currentReleaseKey,
    retainedVersions: [...retained].sort(),
    runMode: meta.runMode,
    lastDeployedAt: meta.lastDeployedAt,
  };
}

/**
 * 全量扫描 <workDir>/apps/<appId>/（每个应用目录一条），产出 deployedApps
 * 契约数组（按 appId 排序，输出稳定）。apps/ 不存在 → []；apps/ 目录级
 * 不可读 → 抛错（由 collectDeployedAppsForHeartbeat 兜成「省略整键」）。
 */
export function scanDeployedApps(workDir: string): DeployedAppFact[] {
  const appsDir = path.join(workDir, 'apps');
  let appDirents: fs.Dirent[];
  try {
    appDirents = fs.readdirSync(appsDir, { withFileTypes: true });
  } catch (err: any) {
    if (err?.code === 'ENOENT') return [];
    throw err;
  }

  const facts: DeployedAppFact[] = [];
  for (const d of appDirents) {
    if (!d.isDirectory()) continue;
    // apps/ 只收 deploy 创建的 appId 形态目录（isSafePathSegment 与部署写侧
    // 同一判据，见 buildDeploymentPaths）；外部/异常目录名不是「已部署应用」。
    if (!isSafePathSegment(d.name)) continue;
    const fact = scanOneApp(d.name, path.join(appsDir, d.name));
    if (fact) facts.push(fact);
  }
  return facts.sort((a, b) => (a.appId < b.appId ? -1 : a.appId > b.appId ? 1 : 0));
}

/**
 * TTL 缓存：心跳默认 30s 一拍，全量扫盘（apps/* × releases/* 的 readdir/stat）
 * 不必每拍都做（对齐桌面端 collectReleaseAppNames 的缓存思路）。部署成功后
 * deploy.ts 主动失效（invalidateDeployedAppsCache），「部署完成 → 下一次心跳
 * 上报新 current/retained」不受 TTL 拖延；TTL 兜住的是 uninstall/prune 等不经
 * deploy.ts 的磁盘变化。
 */
let cache: { workDir: string; at: number; value: DeployedAppFact[] } | null = null;

/** 部署成功后由 deploy.ts 调用：事实已变，下次心跳重扫。 */
export function invalidateDeployedAppsCache(): void {
  cache = null;
}

/** 测试钩子：清缓存（对齐 heartbeat-state 的 resetAdminStatusForTest 先例）。 */
export function resetDeployedAppsCacheForTest(): void {
  cache = null;
}

/**
 * 心跳组装点专用入口（sync：扫的是少量目录的元数据，量级与 deploy.ts 的同步
 * fs 用法一致）。命中缓存或扫描成功 → 契约数组；扫描失败 → **undefined**——
 * JSON 序列化丢键 =「未上报」（admin 保留旧值），心跳本体照发。
 *
 * 注意与 collectInterpreters 的降级差异：那边失败收敛为空数组（「已上报且池
 * 为空」是可采信的事实），这边失败必须省略整键——apps/ 不可读时我们并不知
 * 道有没有应用，空数组会把「未知」伪装成「无应用」。
 */
export function collectDeployedAppsForHeartbeat(): DeployedAppFact[] | undefined {
  const workDir = config.workDir;
  if (
    cache &&
    cache.workDir === workDir &&
    Date.now() - cache.at < config.deployedAppsScanTtlSeconds * 1000
  ) {
    return cache.value;
  }
  try {
    const value = scanDeployedApps(workDir);
    cache = { workDir, at: Date.now(), value };
    return value;
  } catch (err: unknown) {
    cache = null; // 失败结果不缓存（非事实）
    logger.warn(
      `[deployed-apps] 扫描失败，本轮心跳不带 deployedApps 键: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return undefined;
  }
}
