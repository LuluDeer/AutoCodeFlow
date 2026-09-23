import fs from 'fs';
import path from 'path';

/**
 * 本地已部署应用清单（AppsPage 数据源）——按执行器**真实**的磁盘布局解析。
 *
 * 背景（用户报障：「执行器的应用显示」不对）：
 * executor-node 的 release 布局是
 *
 *   <workDir>/apps/<appId>/
 *     ├─ current                → 指向 releases/<version>-<deploymentId> 的软链/junction
 *     ├─ releases/
 *     │    └─ <version>-<deploymentId>/   ← 真正的一次部署，app.log 在这里
 *     └─ tmp/
 *
 * （见 executor-node/src/routes/deploy.ts::resolveDeploymentPaths —— appRoot 取
 *   apps/<appId>，releasesDir 取 <appRoot>/releases，releaseKey 为
 *   `${version}-${deploymentId}`，finalReleaseDir 为 releases/<releaseKey>。）
 *
 * 而本 IPC 原先按 `apps/<appId>/<deploymentId>/app.log` 逐层下钻——即把
 * appRoot 的**直接子目录**当成 deploymentId。实际那些子目录是
 * `releases` / `tmp` / `current`，于是：
 *   · 列表把 `releases`、`tmp`、`current` 当成三个「部署」列出来（假条目），
 *     `releaseKey` 里的版本号与 deploymentId 全部丢失；
 *   · 真正的 app.log 位于 releases/<key>/app.log，永远匹配不到
 *     `<appRoot>/<deploymentId>/app.log`，所以每一行都显示「无日志」——
 *     用户点不进任何日志，即使应用正在正常输出。
 *
 * 本模块把布局知识收敛到一处并做成纯函数（可被 selftest 直接调用，避免
 * ipc-handlers.ts 顶层 `import electron` 导致裸 node 无法加载——先例
 * meta-files.ts / config-sanitize.ts）。
 */

/** 一个 releaseKey：`${version}-${deploymentId}`（version 可含 '.'，deploymentId 是 UUID）。 */
export interface AppReleaseEntry {
  appId: string;
  /** app.json 里记录的真实应用名；缺失（旧部署）时回落为 appId。 */
  appName: string;
  /** releaseKey 中的 deploymentId 部分（无法解析时为原始 releaseKey）。 */
  deploymentId: string;
  /** releaseKey 中的 version 部分（无法解析时为 null）。 */
  version: string | null;
  /** releaseKey 原样（releases/ 下的目录名）。 */
  releaseKey: string;
  /** 是否为 current 指向的即时版本。 */
  isCurrent: boolean;
  hasLog: boolean;
  logPath: string;
  deployDir: string;
}

/** <appRoot>/app.json（executor-node 部署成功时落盘的元数据）。 */
interface AppMeta {
  appName?: string;
  runtime?: string;
  gitRepo?: string | null;
  gitBranch?: string | null;
}

/**
 * 读 app.json。缺失/损坏一律返回 null——**不猜**，由 UI 回落显示 appId
 * （旧部署没有这份文件，不能因此让整个列表报错）。
 */
function readAppMeta(appRoot: string): AppMeta | null {
  try {
    const raw = fs.readFileSync(path.join(appRoot, 'app.json'), 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as AppMeta) : null;
  } catch {
    return null;
  }
}

/**
 * deploymentId 是 UUID（admin-api 的 app_deployments.id 为 uuid 主键）。
 * 从 releaseKey 尾部把 UUID 摘出来：版本号本身可能含 '-'（预发布标签），
 * 所以**从右往左**按最后 5 段匹配 UUID，而不是从左切第一个 '-'。
 */
const UUID_TAIL_RE =
  /^(.*)-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

export function splitReleaseKey(releaseKey: string): {
  version: string | null;
  deploymentId: string;
} {
  const m = UUID_TAIL_RE.exec(releaseKey);
  if (!m) {
    // 无法解析（异常目录名）：不用假数据冒充，deploymentId 回落为原名，
    // version 置 null 由 UI 如实显示。
    return { version: null, deploymentId: releaseKey };
  }
  return { version: m[1] || null, deploymentId: m[2] };
}

/** current 是指向 releases/<releaseKey> 的软链/junction；读出它的 basename。 */
function readCurrentReleaseKey(currentLink: string): string | null {
  try {
    if (!fs.existsSync(currentLink)) return null;
    const target = fs.realpathSync(currentLink);
    return path.basename(target);
  } catch {
    // 悬空链（目标已被删）——不作数，其余 release 照常列出。
    return null;
  }
}

/**
 * 列出本地所有已部署应用（每个 release 一行）。
 *
 * 容错策略与既有 listApps 一致：单条目 stat/readdir 失败只跳过该条目
 * （并发删除等正常目录竞争），但**目录级**失败（apps/ 不可读等）向上抛，
 * 由渲染层显示错误条，而不是冒充「暂无已部署应用」。
 */
export function listDeployedApps(workDir: string | undefined): AppReleaseEntry[] {
  if (!workDir) return [];
  const appsDir = path.join(workDir, 'apps');
  if (!fs.existsSync(appsDir)) return [];

  const result: AppReleaseEntry[] = [];
  const appIds = fs.readdirSync(appsDir).filter((d: string) => {
    try {
      return fs.statSync(path.join(appsDir, d)).isDirectory();
    } catch {
      return false;
    }
  });

  for (const appId of appIds) {
    const appRoot = path.join(appsDir, appId);
    const releasesDir = path.join(appRoot, 'releases');
    const currentKey = readCurrentReleaseKey(path.join(appRoot, 'current'));
    // 用户报障（看不出是哪个应用）：app.json 由 executor-node 在部署成功时落盘。
    // 旧部署没有该文件 → 回落显示 appId，绝不因此让列表失败。
    const meta = readAppMeta(appRoot);
    const appName =
      typeof meta?.appName === 'string' && meta.appName.trim()
        ? meta.appName
        : appId;

    // releases/ 尚不存在（部署进行中/从未成功发布）也要列出应用——
    // 否则「刚点部署、正在解压」这段时间应用在整个页面里凭空消失。
    let releaseKeys: string[] = [];
    if (fs.existsSync(releasesDir)) {
      try {
        releaseKeys = fs
          .readdirSync(releasesDir)
          .filter((d: string) => {
            try {
              return fs.statSync(path.join(releasesDir, d)).isDirectory();
            } catch {
              return false;
            }
          })
          // 最近发布的排前面（releaseKey 前缀是版本号，字典序不可靠——
          // 用目录 mtime 倒序，与 executor 侧 pruneOldReleases 同一判据）。
          .sort((a: string, b: string) => {
            const mt = (n: string) => {
              try {
                return fs.statSync(path.join(releasesDir, n)).mtimeMs;
              } catch {
                return 0;
              }
            };
            return mt(b) - mt(a);
          });
      } catch {
        continue; // 单应用 releases 读失败：跳过该应用，不影响其余
      }
    }

    if (releaseKeys.length === 0) {
      // 应用目录存在但无任何 release（部署失败在解压阶段、或已被 prune 干净）。
      result.push({
        appId,
        appName,
        deploymentId: appId,
        version: null,
        releaseKey: '',
        isCurrent: false,
        hasLog: false,
        logPath: '',
        deployDir: appRoot,
      });
      continue;
    }

    for (const releaseKey of releaseKeys) {
      const deployDir = path.join(releasesDir, releaseKey);
      const logPath = path.join(deployDir, 'app.log');
      const { version, deploymentId } = splitReleaseKey(releaseKey);
      result.push({
        appId,
        appName,
        deploymentId,
        version,
        releaseKey,
        isCurrent: currentKey === releaseKey,
        hasLog: fs.existsSync(logPath),
        logPath,
        deployDir,
      });
    }
  }

  return result;
}
