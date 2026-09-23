import fs from 'fs';
import path from 'path';

/**
 * 本地卸载/删除已部署应用（用户报障：「无法撤销部署(删除)」）。
 *
 * ## 为什么必须让 executor 来删（而不是桌面端直接 rm -rf）
 *
 * executor-node 的 `/api/app-uninstall` 不只是删目录，它先**停掉本应用名下的
 * 全部 daemon**（同时扫 `runningAppRoots` 与 `daemonSpecs` 两张登记表），
 * 再 `rm -rf`。缺了这一步的后果在 deploy.ts 里有明确记录：
 *
 *   · `rm -rf` 不会杀死已启动进程（POSIX unlink 后 inode 存活），应用会
 *     「删了还在跑」；
 *   · 正在退避等待重启的 daemon 已从 runningApps 摘除、只剩 daemonSpecs 登记，
 *     只删目录会让它随后被定时器**重新拉起，指向已删除的目录**。
 *
 * 所以正常路径是回环调用 executor 的路由（它同时持有进程登记与路径白名单
 * 校验）。只有在 executor **根本没在监听**时才回落本地删除——此时进程已死，
 * 不存在会孤儿化或复活的 daemon，直接删目录是安全的。
 *
 * ## 与 admin 中台的关系
 *
 * 本操作只动**本机磁盘**，不删中台的部署记录。中台记录仍指向一个本机已不
 * 存在的应用，UI 必须把这点说清楚（用户否则会以为「中台也清干净了」）。
 * 反向（中台删记录 → 下发 app-uninstall）由 admin 侧既有链路负责。
 */

/** 与 executor-node 的 isSafePathSegment 同口径：单段目录名，禁分隔符/遍历/绝对形式。 */
const SAFE_SEGMENT_RE = /^[A-Za-z0-9._-]+$/;

export function isSafeAppId(appId: unknown): appId is string {
  return (
    typeof appId === 'string' &&
    appId.length > 0 &&
    appId !== '.' &&
    appId !== '..' &&
    SAFE_SEGMENT_RE.test(appId)
  );
}

/**
 * 纯函数：把 appId 解析成 apps 根下的绝对目录，并做**纵深**包含校验。
 *
 * 白名单之外再加一层 containment：即使将来白名单被放宽，rm -rf 目标也必须
 * 落在 `<workDir>/apps` 内（与 executor-node 的 app-uninstall 同款姿态）。
 */
export function resolveAppRoot(
  workDir: string | undefined,
  appId: unknown,
): { ok: true; appRoot: string } | { ok: false; error: string } {
  if (!workDir) return { ok: false, error: '未配置工作目录' };
  if (!isSafeAppId(appId)) return { ok: false, error: 'appId 含非法字符' };
  const appsRoot = path.resolve(workDir, 'apps');
  const appRoot = path.resolve(appsRoot, appId);
  if (appRoot === appsRoot || !appRoot.startsWith(appsRoot + path.sep)) {
    return { ok: false, error: 'appId 解析后落在 apps 目录之外' };
  }
  return { ok: true, appRoot };
}

/**
 * 纯函数：把 release 目录解析成绝对路径，并确认它**确实是**某应用的
 * `releases/<releaseKey>` 子目录（而不是任意传入的路径）。
 *
 * 删除单版本时渲染层传的是 `deployDir`（来自 apps:list）。这里不接受任意
 * 路径：必须是 `<appsRoot>/<appId>/releases/<key>` 这一固定深度，且每一段
 * 都过白名单——避免将来 IPC 参数被篡改成 `<appsRoot>` 本身或应用根目录。
 */
export function resolveReleaseDir(
  workDir: string | undefined,
  appId: unknown,
  releaseKey: unknown,
): { ok: true; releaseDir: string; appRoot: string } | { ok: false; error: string } {
  const root = resolveAppRoot(workDir, appId);
  if (!root.ok) return root;
  if (!isSafeAppId(releaseKey)) {
    return { ok: false, error: 'releaseKey 含非法字符' };
  }
  const releasesDir = path.join(root.appRoot, 'releases');
  const releaseDir = path.resolve(releasesDir, releaseKey);
  if (!releaseDir.startsWith(releasesDir + path.sep)) {
    return { ok: false, error: 'releaseKey 解析后落在 releases 目录之外' };
  }
  return { ok: true, releaseDir, appRoot: root.appRoot };
}

/**
 * 纯函数：读出 current 软链/junction 指向的 release 目录名（无 current 时为 null）。
 * 与 app-inventory.ts 的 readCurrentReleaseKey 同源语义，但这里需要它来**拒绝**
 * 删除当前生效的版本（删掉会让 current 悬空、应用直接不可用）。
 */
export function readCurrentReleaseKey(appRoot: string): string | null {
  try {
    const currentLink = path.join(appRoot, 'current');
    if (!fs.existsSync(currentLink)) return null;
    return path.basename(fs.realpathSync(currentLink));
  } catch {
    return null;
  }
}

/**
 * 纯函数：判定某个 release 能否被删除。
 *
 * 两条拒绝理由都必须在 UI 侧可见（而不是静默失败）：
 *   · `current` —— 当前生效版本，删了应用直接不可用（应先卸载整个应用，
 *     或先部署新版本让 current 移走）；
 *   · daemon 正在运行 —— 该版本的进程还在跑（Windows 上删文件会 EBUSY，
 *     POSIX 上会「删了还在跑」）。请先在中台停止应用。
 */
export function canDeleteRelease(input: {
  releaseKey: string;
  currentKey: string | null;
  runningDeploymentId?: string | null;
  deploymentId: string;
}): { ok: true } | { ok: false; reason: string } {
  if (!input.releaseKey) {
    return { ok: false, reason: '该应用下没有任何 release，无需删除' };
  }
  if (input.currentKey !== null && input.releaseKey === input.currentKey) {
    return {
      ok: false,
      reason: '这是当前生效的版本，删除会让应用不可用；请先部署新版本，或直接卸载整个应用',
    };
  }
  if (
    input.runningDeploymentId &&
    input.runningDeploymentId === input.deploymentId
  ) {
    return { ok: false, reason: '该版本的进程正在运行，请先在中台停止应用再删除' };
  }
  return { ok: true };
}

/** executor 回环调用的结果（不抛：任何失败都收敛成结构化结果）。 */
export interface LocalRouteResult {
  ok: boolean;
  /** 是否成功拿到 HTTP 应答（false = 连不上/超时，用于判定「executor 没在跑」）。 */
  reached: boolean;
  status?: number;
  body?: unknown;
  error?: string;
}

export interface UninstallOutcome {
  ok: boolean;
  /** executor = 走执行器路由（会先停 daemon）；local = 执行器未运行，直接删目录。 */
  mode: 'executor' | 'local';
  stopped?: string[];
  error?: string;
}

/**
 * 卸载整个应用：优先走 executor 路由（停 daemon + 删目录），executor 未监听
 * 时回落本地删除。
 *
 * 依赖以参数注入，便于用真实临时目录 + 假 post 做回归（本模块不 import
 * electron，可被裸 node 直接加载）。
 */
export async function uninstallApp(input: {
  workDir: string | undefined;
  appId: string;
  post: (
    routePath: string,
    body: unknown,
    timeoutMs: number,
  ) => Promise<LocalRouteResult>;
  exists?: (p: string) => boolean;
  removeDir?: (p: string) => void;
}): Promise<UninstallOutcome> {
  const root = resolveAppRoot(input.workDir, input.appId);
  if (!root.ok) return { ok: false, mode: 'executor', error: root.error };
  const { appRoot } = root;
  const exists = input.exists ?? ((p: string) => fs.existsSync(p));
  const removeDir =
    input.removeDir ?? ((p: string) => fs.rmSync(p, { recursive: true, force: true }));

  // ── 首选：executor 路由（唯一会先停 daemon 的路径）────────────────────
  const res = await input.post('/api/app-uninstall', { appId: input.appId }, 60_000);
  if (res.reached && res.ok) {
    // 关键：executor 的 /app-uninstall **即使 rm 失败也回 HTTP 200**，把失败
    // 藏在应答体里（deploy.ts: `{ ok: true, stopped, removed, ...(error ? {error} : {}) }`
    // ——rmSync 抛错只被 catch 成 error 字段，状态码不变）。
    // 只看状态码会把「目录没删掉」报成卸载成功，用户以为清干净了、实际还在。
    // 故这里以**应答体**为准：removed=false 或带 error 一律算失败。
    const body = (res.body ?? {}) as {
      stopped?: unknown;
      removed?: unknown;
      error?: unknown;
    };
    const stopped = Array.isArray(body.stopped) ? (body.stopped as string[]) : [];
    const removed = body.removed === true;
    if (removed && !body.error) {
      return { ok: true, mode: 'executor', stopped };
    }
    // 已经停掉的进程要如实回报（部分成功），否则用户不知道应用是否还在跑。
    return {
      ok: false,
      mode: 'executor',
      stopped,
      error:
        typeof body.error === 'string' && body.error
          ? `执行器未能删除部署目录：${body.error}`
          : removed
            ? '执行器删除部署目录时报错'
            : '执行器未删除任何文件（目录可能已不存在）',
    };
  }
  if (res.reached) {
    // 拿到了应答但被拒（400 路径校验 / 5xx 内部错误）：**不**回落本地删除。
    // 执行器明确表达了拒绝，绕过它去 rm -rf 会丢掉「停 daemon」这一步。
    return {
      ok: false,
      mode: 'executor',
      error: res.error ?? `执行器拒绝卸载（HTTP ${res.status ?? '?'}）`,
    };
  }

  // ── 回落：executor 没在监听 → 无进程登记，直接删目录是安全的 ──────────
  try {
    if (!exists(appRoot)) {
      return { ok: true, mode: 'local' }; // 幂等：目录本就不存在
    }
    removeDir(appRoot);
    return { ok: true, mode: 'local' };
  } catch (err) {
    return {
      ok: false,
      mode: 'local',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** 删除单个 release 目录（不删整个应用）。current/运行中的版本由调用方先拦。 */
export function deleteReleaseDir(
  releaseDir: string,
  removeDir: (p: string) => void = (p) =>
    fs.rmSync(p, { recursive: true, force: true }),
): { ok: boolean; error?: string } {
  try {
    removeDir(releaseDir);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
