/**
 * P2-1：执行器 start/stop 生命周期操作的**在飞互斥原语**（纯模块、无
 * electron 依赖，lifecycle-mutex.selftest.ts 逐分支断言；ExecutorProcess
 * 只注入 body，形态对齐 tray.ts B7 runStartStop 的"决策下沉"先例）。
 *
 * ## 为什么需要
 *
 * ExecutorProcess.start 在 spawn 前有多次 await（端口可达性探测 1.5s、
 * 等旧执行器释放端口最长 10s），整个窗口内 `this.proc` 仍为 null：
 *   · 此窗口内 `executor:stop` 走 `!this.proc` 分支被**吞**——用户点了停止，
 *     执行器照常被拉起；
 *   · 快速双击 start → 两个调用都过了 `if (this.proc) return` 早退闸 →
 *     双 spawn（第二个绑不上端口秒退，只留一行日志）。
 * 托盘路径早有 B7 互斥（runStartStop 的 in-flight 布尔，点击级忽略），但
 * IPC 面（executor:start / executor:stop）此前没有，且布尔互斥只能"忽略"，
 * 救不了上面第一条（stop 被吞）。
 *
 * ## 语义
 *
 *  · **同向并发**：复用在飞 promise（双击 start 只 spawn 一次；两个共享
 *    调用方拿到同一个 Promise 实例，同时落定）；
 *  · **反向并发**：等待对向在飞操作**落定后**再执行自己——启动探测窗口期
 *    的 stop 不再被吞，而是等 start 结束（子进程已 spawn）后如实执行停机；
 *    stop 排空期（最长 30s）内来的 start 同理排队，不会撞上正在退出的进程；
 *  · **失败透传**：body 抛错时在飞标志当次释放，错误原样抛给每一个共享
 *    调用方（托盘侧自吞落日志，IPC 侧 reject 给渲染层），互斥不 wedge；
 *  · 无死锁：一个操作只可能等"先于自己入场的对向操作"，不存在互相等待。
 */

/** 生命周期操作方向。 */
export type LifecycleOp = 'start' | 'stop';

export interface LifecycleMutex {
  /**
   * 运行一个生命周期操作。同向在飞 → 返回同一个 promise；对向在飞 → 排队。
   * body 的 rejection 原样透传给所有共享调用方。
   */
  run(op: LifecycleOp, body: () => Promise<void>): Promise<void>;
  /** 指定方向是否有操作在飞（观测/测试用）。 */
  inFlight(op: LifecycleOp): boolean;
}

export function createLifecycleMutex(): LifecycleMutex {
  const inFlightPromises = new Map<LifecycleOp, Promise<void>>();

  const run = (op: LifecycleOp, body: () => Promise<void>): Promise<void> => {
    const existing = inFlightPromises.get(op);
    // 同向在飞：直接共享（快速双击 start 的第二个调用在这里合并）。
    if (existing) return existing;

    const opposite: LifecycleOp = op === 'start' ? 'stop' : 'start';
    const oppositeInFlight = inFlightPromises.get(opposite);
    const p: Promise<void> = (async () => {
      // 反向在飞：等它落定（成功/失败都放行——前一个操作的失败不该把
      // 排队中的操作也吞掉），此刻 this.proc 已有终值，stop 不会被吞。
      if (oppositeInFlight) {
        await oppositeInFlight.catch(() => undefined);
      }
      await body();
    })();
    inFlightPromises.set(op, p);

    // 落定后释放标志（只释放自己这一条，防 ABA：期间可能有新操作已入场）。
    // 分离链的 catch 防 unhandledRejection——p 本身的 rejection 由共享调用方
    // 消费，这条只服务 finally 的清理职责。
    void p
      .finally(() => {
        if (inFlightPromises.get(op) === p) inFlightPromises.delete(op);
      })
      .catch(() => undefined);

    return p;
  };

  return {
    run,
    inFlight: (op) => inFlightPromises.has(op),
  };
}
