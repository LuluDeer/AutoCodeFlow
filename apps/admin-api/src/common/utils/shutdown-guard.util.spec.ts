import {
  installShutdownForceExitGuard,
  ShutdownForceGuard,
  SHUTDOWN_FORCE_EXIT_MS,
  SHUTDOWN_SIGNALS,
} from "./shutdown-guard.util";

/**
 * OPS-P3b: 信号停机兜底单测。用自定义事件名（process 的 EventEmitter 接受
 * 任意字符串事件）避免真实发信号；每个用例结束后摘除 guard 注册的监听器，
 * 防止跨用例泄漏。
 */
describe("installShutdownForceExitGuard (OPS-P3b)", () => {
  const TEST_SIGNAL = "shutdown-guard-spec-signal";
  // 自定义事件名绕开 NodeJS.Process 的 Signals-only 重载（listeners/emit
  // 等在该接口上被收窄到信号名），走 EventEmitter 通用视图。
  const proc = process as unknown as NodeJS.EventEmitter;
  let exitSpy: jest.SpyInstance;
  let logger: { error: jest.Mock };
  let installed: Array<{
    guard: ShutdownForceGuard;
    signal: string;
    exitBefore: number;
  }> = [];

  const install = (signals: readonly string[], timeoutMs: number) => {
    const exitBefore = proc.listenerCount("exit");
    const guard = installShutdownForceExitGuard(
      signals,
      timeoutMs,
      logger as never,
    );
    installed.push({ guard, signal: signals[0], exitBefore });
    return guard;
  };

  beforeEach(() => {
    jest.useFakeTimers();
    exitSpy = jest
      .spyOn(process, "exit")
      .mockImplementation(
        (() => undefined) as unknown as (code?: number) => never,
      );
    logger = { error: jest.fn() };
    installed = [];
  });

  afterEach(() => {
    // 摘除本用例 guard 注册的信号/exit 监听器
    for (const { signal, exitBefore } of installed) {
      const listeners = proc.listeners(signal) as Array<
        (...args: any[]) => void
      >;
      if (listeners.length > 0) {
        proc.removeListener(signal, listeners[listeners.length - 1]);
      }
      const exitListeners = proc.listeners("exit") as Array<
        (...args: any[]) => void
      >;
      // 保留安装前已存在的监听器，只移除新增的
      for (let i = exitListeners.length - 1; i >= exitBefore; i--) {
        proc.removeListener("exit", exitListeners[i]);
      }
    }
    jest.clearAllTimers();
    jest.useRealTimers();
    exitSpy.mockRestore();
  });

  it("arms a force-exit(1) timer once the signal fires", () => {
    install([TEST_SIGNAL], SHUTDOWN_FORCE_EXIT_MS);
    proc.emit(TEST_SIGNAL);

    jest.advanceTimersByTime(SHUTDOWN_FORCE_EXIT_MS - 1);
    expect(exitSpy).not.toHaveBeenCalled();

    jest.advanceTimersByTime(1);
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining("forcing exit(1)"),
    );
  });

  it("arm() is idempotent — repeated signals do not stack timers", () => {
    const guard = install([TEST_SIGNAL], 1000);
    guard.arm();
    guard.arm();
    proc.emit(TEST_SIGNAL);

    jest.advanceTimersByTime(1000);
    expect(exitSpy).toHaveBeenCalledTimes(1);
  });

  it("dispose() cancels the force exit (normal drain completed)", () => {
    const guard = install([TEST_SIGNAL], 1000);
    guard.arm();
    guard.dispose();

    jest.advanceTimersByTime(5000);
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("registers listeners on the requested signals and an exit cleanup", () => {
    const exitBefore = proc.listenerCount("exit");
    install([TEST_SIGNAL], 1000);
    expect(proc.listenerCount(TEST_SIGNAL)).toBe(1);
    // 'exit' 监听器 = 正常退出完成时的 clearTimeout 兜底
    expect(proc.listenerCount("exit")).toBe(exitBefore + 1);
  });

  it("defaults cover SIGTERM/SIGINT/SIGBREAK with a 15s budget", () => {
    expect(SHUTDOWN_SIGNALS).toEqual(["SIGTERM", "SIGINT", "SIGBREAK"]);
    expect(SHUTDOWN_FORCE_EXIT_MS).toBe(15_000);
  });
});
