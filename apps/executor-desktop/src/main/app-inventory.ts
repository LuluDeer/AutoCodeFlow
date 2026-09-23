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
  /**
   * app.json 里记录的真实应用名。
   *
   * **null 表示「本地没有记录过这个名字」**，而不是「名字等于 appId」。
   * 旧实现回落到 appId（UUID）会让 UI 把不可读的 ID 当名字渲染（用户报障
   * 「显示的应用也是ID形式 我都看不出是什么应用」），也让「有名字」与
   * 「没名字」在类型上不可区分——UI 无从给出「这是旧版本部署，本机没留名字」
   * 这种可操作的提示。故此处如实返回 null，由调用方决定回落展示形态。
   */
  appName: string | null;
  /** releaseKey 中的 deploymentId 部分（无法解析时为原始 releaseKey）。 */
  deploymentId: string;
  /** releaseKey 中的 version 部分（无法解析时为 null）。 */
  version: string | null;
  /** releaseKey 原样（releases/ 下的目录名）。 */
  releaseKey: string;
  /** 是否为 current 指向的即时版本。 */
  isCurrent: boolean;
  /** release 目录的 mtime（部署时间），同版本多次部署时靠它区分；读取失败为 null。 */
  deployedAt: number | null;
  /** 是否存在可读的应用日志（含轮转后的 app.log.1/.2/.3）。 */
  hasLog: boolean;
  /** 最新一份应用日志的路径（无日志时为空串）。 */
  logPath: string;
  /** 本次 release 的目录（app.log 所在层）。 */
  deployDir: string;
  /** 应用根目录（跨 release 稳定，含 app.json/current/releases/tmp）。 */
  appRoot: string;
  /**
   * 部署时的 runMode（app.json 记录；旧部署无此字段时为 null）。
   *
   * UI 用它解释「为什么这个应用没有 app.log」：`scheduled` 模式**只部署不启动**
   * （见 deploy.ts 的 runMode 分支——只有 daemon/once 才调 startApp，而 app.log
   * 由 startApp 创建），所以没有 app.log 是**正常**的，不是故障。
   */
  runMode: string | null;
}

/** <appRoot>/app.json（executor-node 部署成功时落盘的元数据）。 */
interface AppMeta {
  appName?: string;
  runtime?: string;
  gitRepo?: string | null;
  gitBranch?: string | null;
  runMode?: string;
}

/**
 * 读 app.json。缺失/损坏一律返回 null——**不猜**，由调用方如实呈现
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
 * 从 releaseKey 里把 UUID 摘出来：版本号本身可能含 '-'（预发布标签），
 * 所以**匹配 UUID 的形状**而不是从左切第一个 '-'。
 *
 * 与旧实现的差别（本轮修的真实缺陷）：旧实现用 `^…-<uuid>$` **锚定结尾**，
 * 于是凡是被 `resolveReleasePaths` 加了唯一后缀的目录一律解析失败。
 */
const UUID_ANYWHERE_RE =
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/**
 * 宽松回退：老格式/短 hash 的 releaseKey（如 `1.0.1-dae29737`，deploymentId
 * 只有 8 位 hex、不是完整 UUID）配不上 UUID 匹配——原实现把整个 releaseKey
 * 回落成 deploymentId 且 version=null，于是 UI 显示「版本未知 1.0.1-da」，
 * 与正常解析出的「v1.0.1 dae29737」并排出现，自相矛盾（用户截图报障）。
 * 这里按「semver 前缀 + 8 位以上 hex 尾」再试一次，能把版本号如实还原。
 */
const LOOSE_TAIL_RE = /^(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.]+)?)-([0-9a-f]{8,})$/i;

/**
 * `resolveReleasePaths` 给重复部署加的**唯一后缀**：
 *   `${Date.now().toString(36)}-${process.pid.toString(36)}-${releasePathSeq.toString(36)}`
 * （deploy.ts:686），形如 `-muczolhj-8t4-1`。
 *
 * 为什么必须显式剥掉：同 (version, deploymentId) 重复部署时，executor 会把新
 * release 发到 `releases/<key>-<后缀>` 而不是覆盖活目录。**本机真实目录**：
 *   releases/1.0.1-dae29737-f8f2-423f-a0bf-7044b4b8988b-muczolhj-8t4-1
 * 旧解析器对它的输出是 `{version: null, deploymentId: '1.0.1-dae…'}` ——
 * 即「版本未知」+ 一整串不可读 ID，且与同一应用下正常解析的行并排显示。
 */
const RELEASE_SUFFIX_RE = /-[0-9a-z]+-[0-9a-z]+-[0-9a-z]+$/;

function parseReleaseKey(key: string): {
  version: string | null;
  deploymentId: string;
} | null {
  const uuid = UUID_ANYWHERE_RE.exec(key);
  if (uuid) {
    // UUID 之后的一切（唯一后缀）都是发布细节，不属于版本/部署身份。
    const version = key.slice(0, uuid.index).replace(/-+$/, '');
    return { version: version || null, deploymentId: uuid[0] };
  }
  const loose = LOOSE_TAIL_RE.exec(key);
  if (loose) {
    return { version: loose[1], deploymentId: loose[2] };
  }
  return null;
}

export function splitReleaseKey(releaseKey: string): {
  version: string | null;
  deploymentId: string;
} {
  const direct = parseReleaseKey(releaseKey);
  if (direct) return direct;

  // 短 hash 老格式 + 唯一后缀（`1.0.1-dae29737-muczolhj-8t4-1`）：上面两条都
  // 配不上（LOOSE 要求以 hex 结尾，而结尾是后缀的序号）。剥掉后缀再试一次。
  //
  // 只在**剥掉后确实能解析**时才采用——否则会把 `not-a-release-key` 这类
  // 异常目录名误伤成 `not`（见下方回落分支与 selftest 的反证断言）。
  const stripped = releaseKey.replace(RELEASE_SUFFIX_RE, '');
  if (stripped !== releaseKey) {
    const retry = parseReleaseKey(stripped);
    if (retry) return retry;
  }

  // 无法解析（异常目录名）：不用假数据冒充，deploymentId 回落为原名，
  // version 置 null 由 UI 如实显示。
  return { version: null, deploymentId: releaseKey };
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
 * 应用日志候选名，**按新鲜度排序**。
 *
 * `app.log` 是当前写入目标；`startApp` 在启动新进程前调用
 * `rotateAppLogIfNeeded`（app.log → .1 → .2 → .3，最旧丢弃，见 deploy.ts 的
 * APP_LOG_KEEP=3）。所以「app.log 不存在但 app.log.1 存在」是**合法状态**
 * （应用已停机、或刚轮转过），此时必须仍算「有日志」——旧实现只看 app.log，
 * 会把这种部署显示成「无日志」，用户点不进那份真实存在的历史输出。
 */
const APP_LOG_CANDIDATES = ['app.log', 'app.log.1', 'app.log.2', 'app.log.3'];

/** 返回最新一份存在的应用日志路径；一份都没有时返回空串。 */
function resolveAppLogPath(deployDir: string): string {
  for (const name of APP_LOG_CANDIDATES) {
    const candidate = path.join(deployDir, name);
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      // 不存在/不可读：试下一份
    }
  }
  return '';
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
    // app.json 由 executor-node 在部署成功时落盘（跨 release 稳定）。
    // 旧部署没有该文件 → appName 为 null，由调用方（日志回溯 + UI 回落）处理。
    const meta = readAppMeta(appRoot);
    const appName =
      typeof meta?.appName === 'string' && meta.appName.trim()
        ? meta.appName
        : null;
    const runMode =
      typeof meta?.runMode === 'string' && meta.runMode.trim()
        ? meta.runMode
        : null;

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
        deployedAt: null,
        hasLog: false,
        logPath: '',
        deployDir: appRoot,
        appRoot,
        runMode,
      });
      continue;
    }

    for (const releaseKey of releaseKeys) {
      const deployDir = path.join(releasesDir, releaseKey);
      const logPath = resolveAppLogPath(deployDir);
      const { version, deploymentId } = splitReleaseKey(releaseKey);
      // mtime 即部署完成时间（executor 侧 pruneOldReleases 同一判据）——
      // 同一版本号多次部署时，UI 靠它把行区分开。stat 失败给 null，不影响列出。
      let deployedAt: number | null = null;
      try {
        deployedAt = fs.statSync(deployDir).mtimeMs;
      } catch {
        deployedAt = null;
      }
      result.push({
        appId,
        appName,
        deploymentId,
        version,
        releaseKey,
        isCurrent: currentKey === releaseKey,
        deployedAt,
        hasLog: logPath !== '',
        logPath,
        deployDir,
        appRoot,
        runMode,
      });
    }
  }

  return result;
}
