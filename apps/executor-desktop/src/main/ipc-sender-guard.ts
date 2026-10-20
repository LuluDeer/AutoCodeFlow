/**
 * SEC-IPC-SENDER（R86-A1 轴 1）：渲染进程 → 主进程 IPC 的 **sender 白名单闸**。
 *
 * ## 为什么需要
 *
 * Electron 安全清单第 17 条：`ipcMain.handle/on` 必须校验消息来源。本仓库此前
 * 43 个 handler 的签名一律是 `(_event, ...args)`——事件对象被**显式丢弃**，
 * 于是主进程对「谁在调我」零判断：任何拿到 webContents 的执行上下文（渲染层
 * XSS 注入点、被 devtools 附加的调试会话、将来新增的窗口/子 frame）都能直接
 * 调用 `executor:stop`、`apps:uninstall`、`updater:install`、`config:save`
 * 这类有主进程能力（文件读写 / shell / spawn / 退出安装）的通道。
 *
 * window-manager.ts 已经做了导航/弹窗/webview 三道守卫（hardenWindow），
 * 但那是"别把页面导到远端"，与"谁可以调 IPC"是两件事：渲染层的**任意**
 * 执行上下文（含同源子 frame）都在同一 webContents 上，且 electron 不区分
 * main frame 与 sub frame 的 invoke。故这里补上第二道：只接受**我们自己加载的
 * 页面**（生产：dist/renderer/index.html 同目录下的 file: 页；开发：
 * VITE_DEV_SERVER_URL 的**同源**页）的**主 frame**。
 *
 * ## 设计纪律
 *
 * - 判定器纯 Node（无 electron import）→ selftest 直接驱动，不必拉 Electron；
 * - 单一注册入口：ipc-handlers.ts 把 electron 的 ipcMain 别名成 electronIpcMain，
 *   本地 `ipcMain` 由 createGuardedIpcMain 产出——**没有"忘了包一层"的可能**
 *   （想绕过必须显式 import 第二个 ipcMain，TS 会因重复声明直接报错）；
 * - fail-closed：URL 缺失/不可解析/senderFrame 已销毁/子 frame 一律拒绝，
 *   拒绝时抛错（渲染层的 invoke 变成 rejected promise，不会被误当成成功）。
 *
 * ## 已知边界（不假装覆盖）
 *
 * 本闸判的是 **URL 与 frame 身份**，不是进程身份：同一 app 内被注入的脚本
 * 仍在合法 frame 里，本闸拦不住它（那需要按 channel 做能力分级，见报告遗留）。
 */

import * as path from 'path';
import { fileURLToPath } from 'url';

/** 拒绝时的错误前缀（渲染层/日志可据此区分"被闸拦下"与"handler 自己抛错"）。 */
export const IPC_SENDER_REJECTED = 'IPC sender rejected';

/** 生产/开发两种可信来源的锚点。 */
export interface TrustedSenderPolicy {
  /** 开发模式的 Vite dev server（与 window-manager.loadPage 的 loadURL 同源）。 */
  devServerUrl?: string | null;
  /** 生产渲染层入口 index.html 的绝对路径（file: 判定的锚点）。 */
  rendererIndexPath?: string | null;
}

/** 从 IPC 事件里抽出的最小 sender 描述（保持本模块与 electron 类型解耦）。 */
export interface SenderDescriptor {
  /** 发送方 frame 的 URL（可能为 null：frame 已销毁）。 */
  url?: string | null;
  /** 是否为子 frame（iframe）。主 frame 才允许驱动 IPC。 */
  isSubFrame?: boolean;
}

export type SenderVerdict = { ok: true } | { ok: false; reason: string };

/** Windows 路径大小写不敏感（与 path-domain.normalizeForCompare 同口径）。 */
function foldPath(p: string): string {
  return process.platform === 'win32' ? p.toLowerCase() : p;
}

/** 把 URL 的 origin 取出来；不可解析返回 null（fail-closed）。 */
export function safeOrigin(raw: string): string | null {
  try {
    const u = new URL(raw);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.origin;
  } catch {
    return null;
  }
}

/** file: URL → 绝对路径；非 file:/不可解析返回 null。 */
function fileUrlToPath(raw: string): string | null {
  try {
    const u = new URL(raw);
    if (u.protocol !== 'file:') return null;
    return path.resolve(fileURLToPath(u));
  } catch {
    return null;
  }
}

function isWithinRoot(candidate: string, root: string): boolean {
  const c = foldPath(candidate);
  const r = foldPath(root);
  return c === r || c.startsWith(r.endsWith(path.sep) ? r : r + path.sep);
}

/**
 * 判定一个 frame URL 是否可信。
 *
 * - 生产：file: 且解析出的路径落在 rendererIndexPath 的**同目录**下
 *   （`loadFile(RENDERER_INDEX, {hash})` 产生的 URL 带 #hash，pathname 不含它）；
 * - 开发：与 devServerUrl **同源**（origin 全等，绝不用 startsWith——`startsWith`
 *   会把 http://localhost:5173.evil.tld 判成可信，这类前缀绕过是经典错误）；
 * - 其余（about:blank / data: / 远端 https / 空串 / 解析失败）一律拒绝。
 */
export function isTrustedSenderUrl(rawUrl: unknown, policy: TrustedSenderPolicy): boolean {
  if (typeof rawUrl !== 'string' || rawUrl.trim() === '') return false;
  const devOrigin = typeof policy.devServerUrl === 'string' ? safeOrigin(policy.devServerUrl) : null;
  if (devOrigin !== null) {
    const origin = safeOrigin(rawUrl);
    if (origin !== null) return origin === devOrigin;
  }
  const indexPath = typeof policy.rendererIndexPath === 'string' ? policy.rendererIndexPath : '';
  if (indexPath !== '') {
    const candidate = fileUrlToPath(rawUrl);
    if (candidate !== null) return isWithinRoot(candidate, path.dirname(path.resolve(indexPath)));
  }
  return false;
}

/** 完整判定：URL 可信 **且** 是主 frame。 */
export function checkSender(desc: SenderDescriptor, policy: TrustedSenderPolicy): SenderVerdict {
  if (desc.isSubFrame === true) {
    return { ok: false, reason: 'sender is a sub frame (iframes must not drive IPC)' };
  }
  if (typeof desc.url !== 'string' || desc.url.trim() === '') {
    return { ok: false, reason: 'sender frame url unavailable (destroyed frame?)' };
  }
  if (!isTrustedSenderUrl(desc.url, policy)) {
    return { ok: false, reason: `untrusted sender url: ${desc.url}` };
  }
  return { ok: true };
}

/** 结构化的 electron 事件面（只用到这两个属性，避免 import electron 类型）。 */
interface IpcEventLike {
  senderFrame?: { url?: string; parent?: unknown } | null;
  sender?: { getURL?: () => string } | null;
}

/**
 * 从 IPC 事件抽出 SenderDescriptor。
 *
 * - 主 frame 判据：WebFrameMain.parent === null（子 frame 指向父 frame）。
 *   `parent` 属性在结构上缺失时按主 frame 处理（不因运行时形状差异误杀）；
 * - senderFrame 为 null（frame 已销毁）时**不回退**到 sender.getURL()：
 *   该接口给的是"当前页面 URL"，与"这条消息是哪个 frame 发的"不是一回事，
 *   回退等于给销毁态 frame 开后门，故直接返回空 url → 上层 fail-closed。
 */
export function describeSender(event: IpcEventLike | null | undefined): SenderDescriptor {
  const frame = event?.senderFrame ?? null;
  if (!frame) return { url: null, isSubFrame: false };
  const url = typeof frame.url === 'string' ? frame.url : null;
  const isSubFrame = frame.parent !== undefined && frame.parent !== null;
  return { url, isSubFrame };
}

export interface GuardedIpcMainDeps {
  /** 每次调用都重新取策略（dev/packaged 切换、窗口重建后仍然正确）。 */
  policy: () => TrustedSenderPolicy;
  /** 可选日志面（生产注入 electron-log）。 */
  log?: { warn: (msg: string) => void };
}

/** electron ipcMain 的结构子集（handle/on/handleOnce 三个注册面）。 */
export interface RawIpcMainLike {
  handle: (channel: string, listener: (event: any, ...args: any[]) => any) => void;
  on?: (channel: string, listener: (event: any, ...args: any[]) => any) => unknown;
  handleOnce?: (channel: string, listener: (event: any, ...args: any[]) => any) => void;
}

/** 被闸包住之后的注册面（形状与 ipcMain 的对应方法一致）。 */
export interface GuardedIpcMain {
  handle: (channel: string, listener: (event: any, ...args: any[]) => any) => void;
  on: (channel: string, listener: (event: any, ...args: any[]) => unknown) => unknown;
}

/**
 * 产出「所有注册面都过 sender 闸」的 ipcMain 替身。
 *
 * handle：不可信来源 → 抛错（invoke 侧 rejected，不会拿到任何 handler 返回值）；
 * on：不可信来源 → 直接不调用 listener（单向通道没有回执，静默丢弃 + 落日志）。
 */
export function createGuardedIpcMain(
  raw: RawIpcMainLike,
  deps: GuardedIpcMainDeps,
): GuardedIpcMain {
  const reject = (channel: string, verdict: { ok: false; reason: string }): Error => {
    deps.log?.warn(`${IPC_SENDER_REJECTED}: ${channel} (${verdict.reason})`);
    return new Error(`${IPC_SENDER_REJECTED}: ${channel}`);
  };

  return {
    handle(channel, listener) {
      raw.handle(channel, (event, ...args) => {
        const verdict = checkSender(describeSender(event), deps.policy());
        if (!verdict.ok) throw reject(channel, verdict);
        return listener(event, ...args);
      });
    },
    on(channel, listener) {
      const wrapped = (event: any, ...args: any[]): unknown => {
        const verdict = checkSender(describeSender(event), deps.policy());
        if (!verdict.ok) {
          reject(channel, verdict);
          return undefined;
        }
        return listener(event, ...args);
      };
      return raw.on ? raw.on(channel, wrapped) : undefined;
    },
  };
}
