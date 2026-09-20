import { app, BrowserWindow } from 'electron';
import { autoUpdater } from 'electron-updater';
import log from './logger';
import { createRunCheck } from './updater-runcheck';

/**
 * DSK-03: 桌面自动更新（双源）。
 *
 * 源选择（优先级从高到低）：
 *  1) env AUTOUPDATE_URL —— 通用 HTTP 源（generic provider）。走
 *     executor-packages 通道/私有化部署的自定义更新服务器，目录布局与
 *     electron-builder 产物一致（latest-linux.yml + *.AppImage / *.deb）。
 *  2) electron-builder.yml 的 publish 段（provider: github，
 *     LuluDeer/AutoCodeFlow）—— 默认源，读取 GitHub Releases 上的
 *     latest-linux.yml 与对应安装包（打包时 electron-builder 会把
 *     app-update.yml 写进 resources/，electron-updater 自动加载）。
 *
 * 行为约束：
 *  - 仅生产环境启用（app.isPackaged 守卫在 initUpdater 调用方）；
 *  - 启动后延迟 30s 再检查，避开启动窗口的网络/IO 高峰；
 *  - autoDownload=false：检测到新版本只通知渲染层，用户确认后才下载安装；
 *  - 离线/私服无网/4xx/5xx 一律静默（log.warn 落盘），绝不打扰用户；
 *  - 版本回退（远端 <= 本地）不通知，isAvailable 保持 false。
 */

/** 启动后延迟检查的毫秒数。 */
export const UPDATE_CHECK_DELAY_MS = 30_000;

/** updater IPC 事件通道名（preload 侧同名暴露）。 */
export const UPDATE_EVENTS = {
  available: 'updater:available',
  /** 下载进度（0-100）——独立通道，避免与 available 的 version 字段互相污染 */
  progress: 'updater:progress',
  downloaded: 'updater:downloaded',
  error: 'updater:error',
} as const;

/**
 * 纯函数：semver 比较语义的「a 是否严格新于 b」。
 *  - 支持数值段与预发布段（-alpha.1 < 正式版；alpha.2 > alpha.1）；
 *  - 相等返回 false；回退（a 更旧）返回 false；
 *  - 解析失败的输入视为「不新于」，绝不触发升级弹窗。
 * 放在 selftest 里逐条断言（dist-selftest/updater.selftest.js）。
 */
export function isNewerVersion(a: string, b: string): boolean {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return false;
  if (pa.cmp(pb) !== 0) return pa.cmp(pb) > 0;
  return false;
}

/** 预发布标识排序权重：数字段按数值比，字符串段按字典序比（semver 规则）。 */
function comparePrerelease(l: string[], r: string[]): number {
  if (l.length === 0 && r.length === 0) return 0;
  // 无预发布段 > 有预发布段（1.0.0 > 1.0.0-alpha）
  if (l.length === 0) return 1;
  if (r.length === 0) return -1;
  const len = Math.max(l.length, r.length);
  for (let i = 0; i < len; i++) {
    const li = l[i];
    const ri = r[i];
    if (li === undefined) return -1; // 更短的一方更小
    if (ri === undefined) return 1;
    const ln = /^\d+$/.test(li);
    const rn = /^\d+$/.test(ri);
    if (ln && rn) {
      const d = Number(li) - Number(ri);
      if (d !== 0) return d > 0 ? 1 : -1;
    } else if (ln !== rn) {
      return ln ? -1 : 1; // 数字段 < 字符串段（semver 规则）
    } else {
      if (li !== ri) return li < ri ? -1 : 1;
    }
  }
  return 0;
}

interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
  pre: string[];
  cmp(other: ParsedVersion): number;
}

function parseVersion(v: string): ParsedVersion | null {
  if (typeof v !== 'string') return null;
  const m = v.trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/);
  if (!m) return null;
  const major = Number(m[1]);
  const minor = Number(m[2]);
  const patch = Number(m[3]);
  const pre = m[4] ? m[4].split('.') : [];
  return {
    major,
    minor,
    patch,
    pre,
    cmp(o: ParsedVersion): number {
      if (major !== o.major) return major > o.major ? 1 : -1;
      if (minor !== o.minor) return minor > o.minor ? 1 : -1;
      if (patch !== o.patch) return patch > o.patch ? 1 : -1;
      return comparePrerelease(pre, o.pre);
    },
  };
}

/** 解析 AUTOUPDATE_URL；空/非法返回 null（回落 GitHub 源）。 */
function resolveGenericFeedUrl(): string | null {
  const raw = process.env.AUTOUPDATE_URL;
  if (!raw || raw.trim() === '') return null;
  try {
    const u = new URL(raw.trim());
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.toString();
  } catch {
    return null;
  }
}

/** 检查计时器（initUpdater 幂等用的句柄）。 */
let checkTimer: NodeJS.Timeout | null = null;

// NETOPT-C P3: updater:error 的显性化开关——用户主动检查 / 用户确认的下载
// 才广播；后台定时检查保持静默（离线/私服 404 不打扰用户）。
// NETOPT-D P3-1 / NETOPT-E P3-1 / NETOPT-E P2-4: runCheck 互斥 + 归因局部化
// 状态机（后台在飞→用户串行等待、用户在飞→后台跳过、error 只认最近发起方）
// 已抽到 updater-runcheck.ts（无 electron 依赖，selftest 直接驱动真实实现）。
// 这里只保留 downloading（下载显性流程标记，不属于检查状态机）。
// NETOPT-E P2-4: electron-updater 的 checkForUpdates 返回 Promise<UpdateCheckResult | null>，
// 状态机只认 Promise<void>——包一层丢弃返回值（检查周期语义只关心完成/失败）。
const runCheckState = createRunCheck(() =>
  autoUpdater.checkForUpdates().then(() => undefined),
);
let downloading = false;

/**
 * 初始化并启动延迟检查。仅生产环境调用（index.ts 里 app.isPackaged 守卫）。
 * 幂等：重复调用只挂一次 timer。
 */
export function initUpdater(): void {
  if (checkTimer) return;

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  // electron-updater 的 logger 接口与 electron-log 方法名兼容（info/warn/error…）
  autoUpdater.logger = log;

  const genericUrl = resolveGenericFeedUrl();
  if (genericUrl) {
    // 双源之 B：通用 HTTP 源（env 覆盖），供私有化/executor-packages 通道
    autoUpdater.setFeedURL({ provider: 'generic', url: genericUrl });
    log.info(`updater: generic feed ${genericUrl}`);
  }
  // 无 env 时保持打包生成的 app-update.yml（github provider），无需显式 setFeedURL

  autoUpdater.on('update-available', (info) => {
    const remote = String(info.version ?? '');
    const local = app.getVersion();
    // 兜底比较：generic 源的 latest-linux.yml 若被手写错（<= 本地版本），
    // electron-updater 某些 provider 组合不会自行拦截，这里统一再挡一道。
    if (!isNewerVersion(remote, local)) {
      log.info(`updater: remote ${remote} not newer than local ${local}, ignored`);
      // NETOPT-D P3-3: 检查周期结束（无论结果）复位 surface 标志——
      // 防残留：用户主动检查成功后，后续任意 error（如下载阶段的意外事件）
      // 仍被按用户检查归因而广播。
      runCheckState.resetSurface();
      return;
    }
    log.info(`updater: update available ${local} -> ${remote}`);
    runCheckState.resetSurface();
    broadcast(UPDATE_EVENTS.available, { version: remote, current: local });
  });

  autoUpdater.on('update-not-available', (info) => {
    log.info(`updater: up to date (${String(info.version ?? 'unknown')})`);
    runCheckState.resetSurface();
  });

  autoUpdater.on('download-progress', (p) => {
    // DSK-05：进度走独立通道。旧形态复用 available 通道并传 version:''，
    // 会把渲染层已记下的「待升级版本号」覆盖成空字符串，提示文案随即丢版本号。
    broadcast(UPDATE_EVENTS.progress, {
      percent: Math.round(p.percent),
      transferred: p.transferred,
      total: p.total,
      bytesPerSecond: p.bytesPerSecond,
    });
  });

  autoUpdater.on('update-downloaded', (info) => {
    log.info(`updater: update downloaded (${String(info.version ?? 'unknown')})`);
    broadcast(UPDATE_EVENTS.downloaded, { version: String(info.version ?? '') });
  });

  autoUpdater.on('error', (err) => {
    // NETOPT-C P3: 后台定时检查（启动 30s）离线/私服 404 是常态噪音，只落
    // 日志不打扰用户；仅用户主动检查（updater:check）或正在下载（DSK-03
    // 用户确认后的显性流程）时才广播 error 让渲染层显性化。
    // NETOPT-D P3-1: 标志在 runCheck 发起时覆盖（latest 语义），error 事件与
    // 检查调用异步到达，按"最近一次发起"归因。
    // NETOPT-D P3-3: 归因完成后立即复位——error 是检查周期的终结事件之一，
    // 复位不会吞掉本次 surface 判断（surface 已取局部值），只防残留污染
    // 后续后台检查的错误归类。
    log.warn(`updater: check/download error: ${err.message}`);
    const surface = runCheckState.surfaceError || downloading;
    runCheckState.resetSurface();
    if (surface) {
      broadcast(UPDATE_EVENTS.error, { message: err.message });
    }
  });

  checkTimer = setTimeout(() => {
    void checkForUpdates();
  }, UPDATE_CHECK_DELAY_MS);
  checkTimer.unref();
}

/** 后台/静默检查：错误只落日志（NETOPT-C P3）。 */
export async function checkForUpdates(): Promise<void> {
  await runCheck(false);
}

/** 用户主动检查（ipc updater:check）：错误经 updater:error 广播显性化。 */
export async function checkForUpdatesUserInitiated(): Promise<void> {
  await runCheck(true);
}

/**
 * 检查入口（互斥 + 归因局部化，NETOPT-E P3-1 / P2-4）。
 * 状态机本体在 updater-runcheck.ts（createRunCheck），此处只委托：
 *  - 后台发起（initUpdater 定时 tick / 静默入口）：in-flight 已有检查（无论
 *    谁发起）→ 复用同一 promise（跳过），不排队、不覆盖归因——后台检查是
 *    软性的，用户检查进行中不必再排一队，且避免 latest 覆盖把后台噪音 error
 *    张冠李戴给用户。注意：并发调用**复用 in-flight promise**，并非 reject
 *    （electron-updater 只拒绝并发 checkForUpdates 本身）。
 *  - 用户发起（ipc updater:check）：若后台检查在飞，先等它结束（失败不阻
 *    断）再**串行发起自己的检查**；surfaceError 只在本次检查周期内置位、
 *    结束即复位——error 事件只认真正在跑的这次检查的发起方。
 * 这取代了 NETOPT-D P3-1 的"latest 语义"：那版并发时后台先起、用户后点，
 * 用户复用后台 in-flight 检查并把 latest 覆盖为 true，后台噪音 error 被
 * 广播给用户、而用户自己的错误（若有）被静默。
 */
function runCheck(userInitiated: boolean): Promise<void> {
  return userInitiated ? runCheckState.user() : runCheckState.background();
}

/** 用户确认后执行：下载新版本（autoDownload=false 时的显式下载入口）。 */
export async function downloadUpdate(): Promise<void> {
  downloading = true;
  try {
    await autoUpdater.downloadUpdate();
  } catch (err: any) {
    // 下载失败经 autoUpdater 'error' 事件广播（downloading 标记在位），
    // 此处仍落日志兜底
    log.warn(`updater: downloadUpdate failed: ${err?.message ?? err}`);
  } finally {
    downloading = false;
  }
}

/** 用户确认后执行：下载完成的前提下退出并安装。 */
export function quitAndInstall(): void {
  // electron-updater 6.x：isUpdaterActive() 为 false 时 quitAndInstall 直接 no-op
  if (!autoUpdater.isUpdaterActive()) {
    log.warn('updater: quitAndInstall called but no update downloaded, ignored');
    return;
  }
  setImmediate(() => {
    autoUpdater.quitAndInstall();
  });
}

/** 给所有存活窗口广播事件（无边框窗口可能一个都没开）。 */
function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(channel, payload);
    }
  }
}
