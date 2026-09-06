import { Logger } from "@nestjs/common";

/**
 * OPS-P3b: SIGTERM/SIGINT 停机兜底强制超时。
 *
 * 背景：main.ts 的 `app.enableShutdownHooks()` 正常路径会等 BullMQ
 * `worker.close()` 排空 in-flight job——极端情况（Redis 不可达、job 卡死）
 * 会挂死到 K8s 的 SIGKILL 才终止。main.ts 已有的 10s 强制退出
 * （gracefulFatalShutdown）只覆盖 fatal 路径（unhandledRejection /
 * uncaughtException），信号驱动的优雅停机路径没有兜底。
 *
 * 本工具在收到停机信号后启动一个 15s 的 unref 定时器强制
 * `process.exit(1)`（非零退出码让编排系统照常重启）；进程正常到达
 * 'exit'（排空完成）时 clearTimeout。对齐 executor-node 的 45s 保险
 * 思路——admin-api 的 close 只做 HTTP drain + worker.close，15s 足够。
 *
 * 与 Nest 自身信号监听并存：Nest 的 hook 负责 close()，本 guard 只
 * 负责 arm 定时器，不改变正常路径行为。
 */
export const SHUTDOWN_FORCE_EXIT_MS = 15_000;
export const SHUTDOWN_SIGNALS = ["SIGTERM", "SIGINT", "SIGBREAK"] as const;

export interface ShutdownForceGuard {
  /** 启动强制退出定时器（幂等：重复调用不叠加定时器） */
  arm: () => void;
  /** 取消已启动的定时器 */
  dispose: () => void;
}

export function installShutdownForceExitGuard(
  signals: readonly string[] = SHUTDOWN_SIGNALS,
  timeoutMs: number = SHUTDOWN_FORCE_EXIT_MS,
  logger: Pick<Logger, "error"> = new Logger("ShutdownGuard"),
): ShutdownForceGuard {
  let timer: NodeJS.Timeout | null = null;

  const arm = (): void => {
    if (timer) return;
    timer = setTimeout(() => {
      logger.error(
        `[SHUTDOWN] Graceful shutdown did not finish within ${timeoutMs}ms — forcing exit(1)`,
      );
      process.exit(1);
    }, timeoutMs);
    // unref：正常排空完成、事件循环自然抽干时，本定时器不阻止退出
    timer.unref();
  };

  const dispose = (): void => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };

  for (const signal of signals) {
    process.on(signal, arm);
  }
  // 进程无论走 process.exit(0)（Nest hook）还是事件循环抽干自然退出，
  // 'exit' 都会触发——在此 clearTimeout 即"正常退出完成时取消兜底"。
  process.on("exit", dispose);

  return { arm, dispose };
}
