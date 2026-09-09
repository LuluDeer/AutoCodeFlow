import { app, BrowserWindow } from 'electron';
import { autoUpdater } from 'electron-updater';
import log from './logger';

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
      return;
    }
    log.info(`updater: update available ${local} -> ${remote}`);
    broadcast(UPDATE_EVENTS.available, { version: remote, current: local });
  });

  autoUpdater.on('update-not-available', (info) => {
    log.info(`updater: up to date (${String(info.version ?? 'unknown')})`);
  });

  autoUpdater.on('download-progress', (p) => {
    broadcast(UPDATE_EVENTS.available, {
      version: '',
      current: app.getVersion(),
      progress: Math.round(p.percent),
    });
  });

  autoUpdater.on('update-downloaded', (info) => {
    log.info(`updater: update downloaded (${String(info.version ?? 'unknown')})`);
    broadcast(UPDATE_EVENTS.downloaded, { version: String(info.version ?? '') });
  });

  autoUpdater.on('error', (err) => {
    // 静默失败：离线/私服无网络/404 都只落日志，不打扰用户
    log.warn(`updater: check failed (silently ignored): ${err.message}`);
    broadcast(UPDATE_EVENTS.error, { message: err.message });
  });

  checkTimer = setTimeout(() => {
    void checkForUpdates();
  }, UPDATE_CHECK_DELAY_MS);
  checkTimer.unref();
}

/** 触发一次检查（延迟检查与 renderer 主动刷新共用）。静默吞错。 */
export async function checkForUpdates(): Promise<void> {
  try {
    await autoUpdater.checkForUpdates();
  } catch (err: any) {
    log.warn(`updater: checkForUpdates failed (silently ignored): ${err?.message ?? err}`);
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
