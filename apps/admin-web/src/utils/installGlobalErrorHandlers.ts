/**
 * DEEP-AUDIT D3-F-P2-1（2026-09-22）：全局未捕获异常兜底聚合。
 *
 * 背景：admin-web 此前全仓没有 window 'error' / 'unhandledrejection' 监听——
 * React 事件回调、SSE onmessage、setTimeout/Promise 链里抛出的未捕获异常/
 * rejection 只进浏览器 console，现场排障时只有用户口述。本模块在入口注册一对
 * 全局监听，把两类兜底事件聚合为带上下文的 console.error，便于抓现场：
 *
 *   - window 'error'（未捕获同步异常）：message + 文件/行列号 + error 对象摘要
 *   - window 'unhandledrejection'（未 catch 的 Promise rejection）：reason 摘要
 *
 * 纪律：
 *   - 不吞事件、不调用 preventDefault/stopImmediatePropagation——浏览器默认
 *     红叉/unhandled 行为保持不变，本监听只做「额外聚合」，不改应用语义。
 *   - 幂等：重复 install 不叠加监听器（模块级已装标记）。
 *   - 返回 uninstall() 仅供测试清理；生产入口只 install、不 uninstall。
 */

export interface InstalledGlobalErrorHandlers {
  /** 移除本模块注册的两个全局监听（测试用）。 */
  uninstall(): void;
}

let installed = false;

/** 把 unknown reason 收成 console 可序列化的摘要（Error 不直接打，避免循环引用/大对象刷屏）。 */
function summarizeReason(reason: unknown): unknown {
  if (reason instanceof Error) {
    return { name: reason.name, message: reason.message, stack: reason.stack };
  }
  return reason;
}

/**
 * 在 window 上注册全局 'error' / 'unhandledrejection' 聚合监听。
 * 重复调用幂等（已装则返回空 uninstall）。返回值用于测试拆除。
 */
export function installGlobalErrorHandlers(): InstalledGlobalErrorHandlers {
  if (installed) return { uninstall() {} };

  const onError = (event: ErrorEvent): void => {
    console.error('[admin-web][unhandled-error]', event.message || '(no message)', {
      filename: event.filename,
      lineno: event.lineno,
      colno: event.colno,
      error: summarizeReason(event.error),
    });
  };

  const onUnhandledRejection = (event: PromiseRejectionEvent): void => {
    console.error(
      '[admin-web][unhandled-rejection]',
      summarizeReason(event.reason),
    );
  };

  window.addEventListener('error', onError);
  window.addEventListener('unhandledrejection', onUnhandledRejection);
  installed = true;

  return {
    uninstall(): void {
      window.removeEventListener('error', onError);
      window.removeEventListener('unhandledrejection', onUnhandledRejection);
      installed = false;
    },
  };
}
