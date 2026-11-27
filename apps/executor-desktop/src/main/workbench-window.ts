/**
 * 阶段 A（ADR-044）：业务人员「独立工作台窗口」。
 *
 * 与四页（status/config/history/apps）**并存但隔离**：
 *  - 独立 BrowserWindow + 独立 session partition（`persist:acf-workbench`），
 *    不共享 defaultSession 的缓存 / cookie / localStorage / 权限闸门；
 *  - 独立 preload（`src/preload/workbench.ts`），只暴露导航/会话相关的最小
 *    API，执行器配置 / 凭据 / 子进程 / 卸载 / 更新 channel 刻意不暴露；
 *  - 只 loadURL 配置里的中台地址 + `/workbench`；导航守卫白名单同源 http(s)，
 *    `javascript:` / `file:` / 任意 host 一律拒绝；
 *  - webview tag 全局关闭（window-manager 的 `webviewTag:false` + 本窗口守卫），
 *    因此这里走 `win.loadURL()` 而不是 webview 标签。
 *
 * 阶段 B（会话能力：goal → preview → commit → 审批 → 记录）与本模块无关，
 * 本轮只做窗口 + 隔离 + 接入中台 Workbench 页面本身。
 *
 * 本模块刻意**不静态 import electron**：`require('electron')` 只在真正创建窗口
 * 时发生，于是 selftest 可以在裸 Node 里直接驱动下面的纯判定函数与
 * `buildWorkbenchWebPreferences()`（与仓库 ipc-sender-guard 同一纪律）。
 */

/** 工作台专属 session partition（四页用 defaultSession，partition 为空串）。 */
export const WORKBENCH_SESSION_PARTITION = 'persist:acf-workbench';

/**
 * Electron 的 `session.partition` 返回值**不带 `persist:` 前缀**（persist: 只是
 * 「持久化」标志，不是分区名本身）。IPC 事件里拿到的是 `acf-workbench`，
 * 而 BrowserWindow 构造参数里写的是 `persist:acf-workbench`——两处必须归一后再比，
 * 否则工作台自己的窗口会被 handler 层误判为外部页面（真机实测踩过）。
 */
export function normalizePartition(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  return raw.startsWith('persist:') ? raw.slice('persist:'.length) : raw;
}

/**
 * WebContents 上的**显式 partition 标记**（真机实测：Electron 45 的
 * `webContents.session.partition` 在 IPC 事件里读不到值，单靠它做 handler 层
 * 收窄会把工作台自己的调用误杀）。窗口创建时打标，handler 层读同一个标记；
 * 同时保留 session.partition 判定作为另一路证据。
 */
export const WORKBENCH_SENDER_FLAG = '__acfWorkbenchPartition';

import * as path from 'path';

/** 生产构建时第二个 preload 的产物路径（bundle-preload.cjs 单文件 esbuild）。 */
export const WORKBENCH_PRELOAD_PATH = path.join(__dirname, '../preload/workbench.js');

/** 中台业务工作台路由（admin-web /workbench 对业务人员开放）。 */
export const WORKBENCH_PATH = '/workbench';

/** 工作台 preload 允许过桥的 channel —— 白名单的唯一事实源。 */
export const WORKBENCH_CHANNELS = {
  getUrl: 'workbench:getUrl',
  navigate: 'workbench:navigate',
  close: 'workbench:close',
} as const;

export type WorkbenchChannel = (typeof WORKBENCH_CHANNELS)[keyof typeof WORKBENCH_CHANNELS];

export const WORKBENCH_CHANNEL_VALUES: readonly WorkbenchChannel[] = Object.values(WORKBENCH_CHANNELS);

/** 主进程侧可选日志面（注入 electron-log；裸 Node selftest 可省略）。 */
export interface WorkbenchLog {
  info(message: string): void;
  warn(message: string): void;
}

const NO_LOG: WorkbenchLog = { info: () => undefined, warn: () => undefined };

/** 配置缺失 / 非法时的统一错误文案（不硬编码 localhost，不泄漏配置原文）。 */
function invalidWorkbenchUrlError(): Error {
  return new Error(
    '工作台地址未配置或非法：请先在执行器配置里填写合法的 http(s) 中台地址（adminApiUrl），再打开工作台。',
  );
}

/**
 * 校验中台基址并归一成 origin+pathname（去尾部斜杠、去 query/hash）。
 *
 * 只接受 http/https + 非空 host；拒绝 userinfo（URL 里带凭据是钓鱼/日志泄漏面），
 * 拒绝非 http(s) 协议（javascript:/file:/data: 等）。空串 → 明确错误，不回落
 * localhost——业务人员工作台绝不能被静默导到本机任意页面。
 */
export function normalizeWorkbenchBaseUrl(raw: unknown): string {
  if (typeof raw !== 'string' || raw.trim() === '') throw invalidWorkbenchUrlError();
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw invalidWorkbenchUrlError();
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw invalidWorkbenchUrlError();
  if (url.hostname === '' || url.username !== '' || url.password !== '') throw invalidWorkbenchUrlError();
  const pathname = url.pathname.replace(/\/+$/, '');
  return `${url.origin}${pathname === '/' ? '' : pathname}`;
}

/** 配置的中台地址 → 工作台 URL（拼接 `/workbench`）。 */
export function resolveWorkbenchUrl(rawBaseUrl: unknown): string {
  return `${normalizeWorkbenchBaseUrl(rawBaseUrl)}${WORKBENCH_PATH}`;
}

/**
 * 导航白名单：目标必须是 http(s) 且与配置的中台**同源**。
 *
 * 用 origin 全等而不是 host 前缀（前缀判据会把 `https://admin.evil.tld` 放行）；
 * `javascript:` / `file:` / `data:` / `about:` / 协议相对 URL 在这里统一被拒。
 * 同源任意路径放行（中台可能重定向到 /login，那是正常业务流）。
 */
export function isAllowedWorkbenchUrl(raw: unknown, baseUrl: string): boolean {
  if (typeof raw !== 'string' || raw.trim() === '') return false;
  let target: URL;
  let base: URL;
  try {
    target = new URL(raw.trim());
    base = new URL(baseUrl);
  } catch {
    return false;
  }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') return false;
  if (target.hostname === '') return false;
  return target.origin === base.origin;
}

/**
 * preload 的 `workbench:navigate` 参数收窄：只接受同源**相对路径**。
 * 不接受绝对 URL（防开放重定向）——业务人员只能在工作台自己的路由间跳转。
 */
export function resolveWorkbenchNavigation(target: unknown, baseUrl: string): string {
  if (typeof target !== 'string' || !target.startsWith('/') || target.startsWith('//')) {
    throw new Error('工作台导航只接受同源相对路径');
  }
  let url: URL;
  try {
    url = new URL(target, baseUrl);
  } catch {
    throw new Error('工作台导航参数非法');
  }
  if (!isAllowedWorkbenchUrl(url.href, baseUrl)) throw new Error('工作台导航目标不在白名单内');
  return url.href;
}

/**
 * 工作台窗口的 webPreferences —— 四项安全配置的唯一事实源（selftest 逐项钉住）。
 * `partition` 与 `preload` 是它与四页 `sharedWebPreferences()` 的两处硬差异。
 */
export function buildWorkbenchWebPreferences(
  preloadPath: string = WORKBENCH_PRELOAD_PATH,
): Electron.WebPreferences {
  return {
    preload: preloadPath,
    partition: WORKBENCH_SESSION_PARTITION,
    contextIsolation: true,
    nodeIntegration: false,
    // SEC-DSK-01：显式沙箱；preload 是自包含单文件（esbuild），无相对 require。
    sandbox: true,
    // webview tag 全局关闭（window-manager:128 / :209-213），这里再显式关一次，
    // 工作台页面只能通过主进程 loadURL 导航，不能挂任意 <webview>。
    webviewTag: false,
    devTools: true,
  };
}

/** 当前工作台窗口（供 IPC handler 收窄 / 关闭 / 导航复用）。 */
let workbenchWindow: import('electron').BrowserWindow | null = null;

export function getWorkbenchWindow(): import('electron').BrowserWindow | null {
  return workbenchWindow;
}

/**
 * IPC handler 层的第二道闸：除 createGuardedIpcMain 的 URL 闸之外，还要求
 * 发送方就是本模块创建的窗口（webContents.id 全等）**且**来自独立 partition。
 * 任一不满足即拒——四页 renderer 与任意外部页面都调不到 workbench:* channel。
 */
export function isWorkbenchSender(sender: {
  id?: number;
  session?: { partition?: string };
  [WORKBENCH_SENDER_FLAG]?: string;
} | null | undefined): boolean {
  if (!sender) return false;
  const win = workbenchWindow;
  const sameWindow = win !== null && !win.isDestroyed() && win.webContents.id === sender.id;
  const flagged = sender[WORKBENCH_SENDER_FLAG] === WORKBENCH_SESSION_PARTITION;
  const viaSession = normalizePartition(sender.session?.partition)
    === normalizePartition(WORKBENCH_SESSION_PARTITION);
  return sameWindow && (flagged || viaSession);
}

/** 工作台 session 的默认全拒权限闸门（不污染 defaultSession，也不放行任何 Web 权限）。 */
function installWorkbenchPermissionPolicy(ses: import('electron').Session): void {
  ses.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  ses.setPermissionCheckHandler(() => false);
}

export interface CreateWorkbenchWindowOptions {
  /** 运行期读取配置里的中台地址（通常是 `() => configStore.get('adminApiUrl')`）。 */
  getWorkbenchUrl: () => unknown;
  log?: WorkbenchLog;
}

/** 创建（或聚焦）独立工作台窗口；配置缺失时抛明确错误，绝不静默降级。 */
export function createWorkbenchWindow(options: CreateWorkbenchWindowOptions): import('electron').BrowserWindow {
  const logger = options.log ?? NO_LOG;
  const workbenchUrl = resolveWorkbenchUrl(options.getWorkbenchUrl());

  if (workbenchWindow && !workbenchWindow.isDestroyed()) {
    workbenchWindow.show();
    workbenchWindow.focus();
    return workbenchWindow;
  }

  // 运行时才拉 electron：本模块保持裸 Node 可 import（selftest 直驱纯函数）。
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { BrowserWindow, session } = require('electron') as typeof import('electron');

  installWorkbenchPermissionPolicy(session.fromPartition(WORKBENCH_SESSION_PARTITION));

  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    show: false,
    backgroundColor: '#ffffff',
    // 工作台是业务人员当 agent 用的常驻窗口，不记忆四页的窗口状态文件。
    webPreferences: buildWorkbenchWebPreferences(),
  });
  workbenchWindow = win;
  // 打显式 partition 标记：IPC handler 层的第二道闸据此识别工作台窗口，
  // 不依赖 webContents.session.partition（真机读不到，见 WORKBENCH_SENDER_FLAG 注释）。
  (win.webContents as unknown as Record<string, unknown>)[WORKBENCH_SENDER_FLAG] = WORKBENCH_SESSION_PARTITION;

  // 与四页 hardenWindow 同形态的三道守卫，但判据换成「中台同源」，
  // 否则工作台到 /login 的正常跳转会被四页那套 file:/dev-server 判据拦死。
  win.webContents.on('will-navigate', (event, url) => {
    if (!isAllowedWorkbenchUrl(url, workbenchUrl)) {
      event.preventDefault();
      logger.warn(`[workbench] blocked navigation to ${url}`);
    }
  });
  win.webContents.on('will-redirect', (event, url) => {
    if (!isAllowedWorkbenchUrl(url, workbenchUrl)) {
      event.preventDefault();
      logger.warn(`[workbench] blocked redirect to ${url}`);
    }
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    logger.warn(`[workbench] blocked window.open to ${url}`);
    return { action: 'deny' };
  });
  win.webContents.on('will-attach-webview', (event) => {
    event.preventDefault();
    logger.warn('[workbench] blocked webview attach');
  });

  let shown = false;
  const doShow = () => {
    if (shown || win.isDestroyed()) return;
    shown = true;
    win.show();
  };
  win.once('ready-to-show', doShow);
  const showTimer = setTimeout(doShow, 3000);
  showTimer.unref?.();
  win.once('closed', () => {
    clearTimeout(showTimer);
    if (workbenchWindow === win) workbenchWindow = null;
  });

  // SEC-DSK-01：只 loadURL 配置白名单地址（中台 Workbench / 登录页），
  // 不使用 webview tag，也不 loadFile 任何本地页面。
  void win.loadURL(workbenchUrl);
  logger.info('[workbench] window opened');
  return win;
}
