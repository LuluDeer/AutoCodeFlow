/**
 * NETOPT-E P2-4: updater runCheck 状态机（互斥 + 归因局部化）。
 *
 * 抽为独立模块的原因：updater.ts 顶层 import electron/electron-updater，
 * selftest 环境（纯 node）无法加载该模块；状态机本身不依赖 electron，只
 * 依赖一个 `doCheck` 注入面，因此独立成文件后 updater-runcheck.selftest.ts
 * 可直接驱动真实实现（不再用"内联副本 + SYNC_GUARD"的弱形态）。
 *
 * 语义（与 NETOPT-E P3-1 一致）：
 *  - electron-updater 不支持并发 checkForUpdates，因此：
 *    · 后台发起（定时 tick / 静默入口）：in-flight 已有检查（无论谁发起）→
 *      直接返回同一 promise（跳过），不排队、不覆盖归因——后台检查是软性
 *      的，用户检查进行中不必再排一队，且避免模块级 latest 覆盖把后台噪音
 *      error 张冠李戴给用户。
 *    · 用户发起（ipc updater:check）：若后台检查在飞，先等它结束（失败不
 *      阻断）再**串行发起自己的检查**；surfaceError 只在本次检查周期内置
 *      位、结束即复位——error 事件只认真正在跑的这次检查的发起方。
 *  - token 与 checkPromise 同置同清（IIFE 内引用外层 const own 报 TS2454、
 *    命名函数表达式绑定函数自身报 TS2367；token 语义完全等价）。
 */
export interface UpdaterCheckState {
  /**
   * 最近一次发起的检查是否为用户主动（error 归因判定用）。
   * 用户检查发起后为 true，检查周期结束（成功/失败）即复位 false。
   */
  readonly surfaceError: boolean;
  /** 用户主动检查入口（ipc updater:check）。 */
  user(): Promise<void>;
  /** 后台/静默检查入口（定时 tick）。 */
  background(): Promise<void>;
  /**
   * 外部事件侧复位（update-available / update-not-available / error 到达时
   * 调用）：检查周期已经产生确定性结果，提前复位防后续下载阶段意外事件
   * （如下载错误）被按用户检查归因而广播。
   */
  resetSurface(): void;
}

/**
 * 构造 runCheck 状态机。`doCheck` 由调用方注入（生产为
 * `() => autoUpdater.checkForUpdates()`）。
 */
export function createRunCheck(doCheck: () => Promise<void>): UpdaterCheckState {
  let latestUserInitiated = false;
  let checkPromise: Promise<void> | null = null;
  let checkToken: object | null = null;

  return {
    get surfaceError(): boolean {
      return latestUserInitiated;
    },

    user(): Promise<void> {
      const prev = checkPromise;
      const token = {};
      checkToken = token;
      const own = (async () => {
        if (prev) {
          try {
            await prev;
          } catch {
            /* 后台检查失败不阻断用户检查 */
          }
        }
        latestUserInitiated = true;
        try {
          await doCheck();
        } catch {
          /* 错误经 error 事件按 surfaceError 归因广播；此处仅兜底（调用方落日志） */
        } finally {
          latestUserInitiated = false;
          if (checkToken === token) {
            checkToken = null;
            checkPromise = null;
          }
        }
      })();
      checkPromise = own;
      return own;
    },

    background(): Promise<void> {
      if (checkPromise) return checkPromise;
      const token = {};
      checkToken = token;
      const own = (async () => {
        try {
          await doCheck();
        } catch {
          /* 静默：后台检查错误只落日志，不打扰用户 */
        } finally {
          if (checkToken === token) {
            checkToken = null;
            checkPromise = null;
          }
        }
      })();
      checkPromise = own;
      return own;
    },

    resetSurface(): void {
      latestUserInitiated = false;
    },
  };
}

/**
 * 审计二轮 B-7①：周期检查调度器。
 *
 * 旧行为是 initUpdater 挂一个「启动 30s 后检查一次」的一次性 timer——之后
 * updater 永不再自检，除非用户手动点检查。这里把「检查完成后重挂下一轮」的
 * 调度抽成无 electron 依赖的纯状态机（同 createRunCheck 的可测性理由）：
 *  - start(initialDelayMs, intervalMs)：首轮延迟 initialDelayMs，之后**每轮
 *    检查完成（成功或失败）后**再挂 intervalMs——检查在飞时不叠加新 timer，
 *    一轮结束后才排下一轮；
 *  - run 与手动检查共用 runCheck 状态机（background 分支）：用户检查在飞时
 *    本调度复用其 in-flight promise（不并发、不覆盖归因），等它结束后才重挂；
 *  - run 的失败不终止周期（.catch 吞掉，调度只负责重挂）——离线/私服 404 是
 *    常态噪音，不能让一次网络故障把自动更新静默打死；
 *  - stop() 取消挂起的 timer（已进行中的检查不受影响）。
 */
export interface PeriodicCheck {
  start(initialDelayMs: number, intervalMs: number): void;
  stop(): void;
}

export function createPeriodicCheck(opts: {
  /** 单次检查执行体（生产为 runCheck(false)，selftest 注入 fake）。 */
  run: () => Promise<void>;
  /** 定时器注入面（生产 setTimeout，selftest 用受控时钟）。 */
  schedule: (fn: () => void, delayMs: number) => unknown;
  /** 取消注入面（生产 clearTimeout）。 */
  cancel: (handle: unknown) => void;
}): PeriodicCheck {
  let handle: unknown = null;
  let intervalMs = 0;
  let ticking = false;

  const arm = (delayMs: number): void => {
    if (handle !== null) {
      opts.cancel(handle);
      handle = null;
    }
    handle = opts.schedule(tick, delayMs);
  };

  const tick = (): void => {
    handle = null;
    if (ticking) return; // 理论不可达（在飞时不挂新 timer）——防御性兜底
    ticking = true;
    void opts
      .run()
      .catch(() => undefined)
      .then(() => {
        ticking = false;
        // 检查完成后重挂（成功/失败同权）；stop() 之后 intervalMs 归零即停。
        if (intervalMs > 0) arm(intervalMs);
      });
  };

  return {
    start(initialDelayMs, interval) {
      intervalMs = interval;
      arm(initialDelayMs);
    },
    stop() {
      intervalMs = 0;
      if (handle !== null) {
        opts.cancel(handle);
        handle = null;
      }
    },
  };
}
