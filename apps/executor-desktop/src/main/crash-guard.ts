/**
 * B-1：主进程全局崩溃兜底的**决策层**（纯模块、无 electron 依赖，可被
 * crash-guard.selftest.ts 在裸 Node 下逐分支断言；Electron 面在 index.ts
 * 接线，形态对齐 tray-texts.ts / updater-runcheck.ts 的"决策下沉"先例）。
 *
 * ## 为什么需要（审计 B-1）
 *
 * index.ts 此前没有 process.on('uncaughtException' / 'unhandledRejection')。
 * 定时器回调（heartbeat / healthPoll / 托盘菜单）一旦抛错就是未捕获异常：
 * Windows 上 Electron 弹一次错误对话框后进程行为不可预期——托盘可能消失且
 * 无自愈，而 executor-node 子进程既收不到 HTTP 停机请求也没人杀，成孤儿
 * 继续占 8002 端口接任务；桌面重启后新实例 spawn 会 EADDRINUSE（秒退、只留
 * 日志），任务反而继续打到孤儿上。
 *
 * ## 兜底语义（本模块决定；index.ts 只提供 Electron 原语）
 *
 *  - 记录：每次都 logError（含 origin 与 stack），绝不吞；
 *  - dialog：仅第一次弹 showErrorBox（防崩溃风暴弹窗轰炸），文案按
 *    tray-texts 同款 locale 判定双语；
 *  - 退出：仅在**尚未在退出流程中**时调用 quitApp()——index.ts 的
 *    before-quit 已有"停心跳 → 优雅停 executor-node → 再 quit"的完整停机序
 *    （优雅停机语义与既有生命周期同源，不另起一套）；已在退出流程中（崩溃
 *    发生在 before-quit 链内）时不再叠加 quit，交给既有链的 finally 兜底；
 *  - 防挂死：quitApp 后若既有停机链挂死（正常上限 30s 排空），硬超时
 *    forceExit；quitApp 本身抛错立即 forceExit；
 *  - 红线：handle() 自身绝不抛（兜底内再抛 = 兜底失效）。
 *
 * 为什么不做 relaunch：全仓没有 app.relaunch 先例，崩溃循环重启会把一次性
 * 故障放大成无限重启风暴；本兜底选择"优雅退出 + 既有开机自启/用户手动拉起"
 * 的最小语义。
 */
import { TRAY_TEXTS, type TrayLocale } from './tray-texts';

/** 崩溃对话框文案（按 tray-texts 同款 locale 判定取表）。 */
export const CRASH_DIALOG_TEXTS: Record<TrayLocale, { title: string; body: string }> = {
  zh: {
    title: 'AutoCodeFlow Executor 遇到内部错误',
    body:
      '桌面端主进程发生未处理的异常，即将保存现场并退出。\n' +
      '正在运行的执行器子进程会被一并优雅停止（正在执行的任务可能中断）。\n' +
      '详细信息见用户数据目录 logs/ 下的当日日志；重启应用即可恢复。',
  },
  en: {
    title: 'AutoCodeFlow Executor hit an internal error',
    body:
      'The desktop main process hit an unhandled exception and is about to exit.\n' +
      'The executor child process will be stopped gracefully first (running tasks may be interrupted).\n' +
      'See today\'s log under the logs/ folder of the user data directory. Relaunch the app to recover.',
  },
};

/** 格式化一条崩溃记录（origin + 可读的错误形态；非 Error 也如实呈现）。 */
export function formatCrashMessage(origin: string, err: unknown): string {
  let detail: string;
  if (err instanceof Error) {
    detail = err.stack || err.message;
  } else if (typeof err === 'string') {
    detail = err;
  } else {
    try {
      detail = JSON.stringify(err);
    } catch {
      detail = String(err);
    }
  }
  return `[fatal:${origin}] ${detail}`;
}

export interface CrashGuardDeps {
  /** 每次崩溃都调用（对应 log.error）。 */
  logError: (message: string) => void;
  /** 仅第一次崩溃调用（对应 dialog.showErrorBox）。 */
  showErrorBox: (title: string, body: string) => void;
  /** locale 判定（tray-texts 同款：index.ts 传 () => resolveTrayLocale(() => app.getLocale())）。 */
  locale: () => TrayLocale;
  /** before-quit 停机链是否已在跑（true = 退出由既有链负责，本兜底不叠加）。 */
  isQuitting: () => boolean;
  /** 优雅退出（app.quit() —— 触发 before-quit 的既有停机序）。 */
  quitApp: () => void;
  /** 硬退出兜底（process.exit）。 */
  forceExit: (code: number) => void;
  /** 定时器注入（默认 setTimeout + unref；selftest 注入手动触发）。 */
  armForceExit?: (fn: () => void, ms: number) => void;
  /** quitApp 后等待停机链完成的硬上限。 */
  forceExitTimeoutMs?: number;
}

export interface CrashGuard {
  /** 未捕获异常 / 未处理 rejection 的统一入口。绝不抛。 */
  handle: (origin: string, err: unknown) => void;
  /** 仅供自检：是否已请求过退出。 */
  hasRequestedQuit(): boolean;
}

/** quitApp 后等待既有停机链（最长 30s 任务排空）完成的硬上限。 */
export const CRASH_FORCE_EXIT_TIMEOUT_MS = 40_000;

export function createCrashGuard(deps: CrashGuardDeps): CrashGuard {
  const arm = deps.armForceExit ?? ((fn, ms) => {
    const t = setTimeout(fn, ms);
    t.unref?.();
  });
  const timeoutMs = deps.forceExitTimeoutMs ?? CRASH_FORCE_EXIT_TIMEOUT_MS;

  let dialogShown = false;
  let quitRequested = false;

  const guard: CrashGuard = {
    handle(origin, err) {
      try {
        deps.logError(formatCrashMessage(origin, err));
      } catch {
        /* 记录失败也不能让兜底抛 */
      }

      try {
        if (!dialogShown) {
          dialogShown = true;
          const texts = CRASH_DIALOG_TEXTS[deps.locale()] ?? CRASH_DIALOG_TEXTS.zh;
          deps.showErrorBox(texts.title, texts.body);
        }
      } catch {
        /* 对话框失败（app 未 ready 等）不阻断退出 */
      }

      try {
        if (deps.isQuitting()) {
          // 崩溃发生在既有停机链（before-quit）内：退出由该链的 finally 兜底，
          // 这里叠加 quit 只会重入。仍保持"每次都记录 + 一次 dialog"。
          return;
        }
        if (quitRequested) return; // 重入守卫：退出流程只发起一次
        quitRequested = true;
        arm(() => {
          // 停机链挂死（正常上限 30s 排空）时强制退出，绝不让崩溃后吊死。
          try {
            deps.forceExit(1);
          } catch {
            /* 最后一级，无事可做 */
          }
        }, timeoutMs);
        deps.quitApp();
      } catch {
        try {
          deps.forceExit(1);
        } catch {
          /* 最后一级，无事可做 */
        }
      }
    },
    hasRequestedQuit() {
      return quitRequested;
    },
  };
  return guard;
}
