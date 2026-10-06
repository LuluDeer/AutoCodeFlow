import fs from 'fs';
import path from 'path';

/**
 * getHistory 推送化（战役遗留 #4）：workDir/meta 目录的**文件变更哨**。
 *
 * 背景：历史页与状态页此前各自 10s setInterval 轮询 history:get——同一份
 * IPC 双页各拉一遍，且变更到达被平均拉平 5s 延迟。meta 目录由 executor-node
 * 子进程写（主进程只读），推送源天然只能是**文件系统事件**：
 *   fs.watch(metaDir) → debounce → onChange 回调（index.ts 广播
 *   history:changed 给所有窗口，两个页面各自刷新一次）。
 *
 * 为什么不是给渲染层直接 watch：渲染进程没有 fs；为什么不是 executor 子进程
 * 发通知：跨进程协议改动面大（子进程是既有 HTTP 服务，桌面端是它的消费者），
 * 文件系统事件在本机就能闭环。
 *
 * 可靠性纪律（fs.watch 的平台差异是出了名的）：
 * - debounce 合并突发（一次任务完成 = meta 写入 + 状态改写多次事件 → 1 次回调）；
 * - 目录不存在（workDir 未建/未配）不报错——挂重试定时器，目录出现后自动接管；
 * - watch 句柄报错/关闭（目录被删、网络盘断开）→ 同样进重试循环，绝不静默死亡；
 * - onChange 抛错只落 console（watcher 本身是旁路信号源，消费方刷新失败由
 *   渲染层兜底轮询兜住——60s 低频轮询保留为 fs.watch 失灵的最后一道网）。
 */

/** 事件 debounce 窗口：任务完成的 meta 写入通常连续 2-4 个事件。 */
export const HISTORY_WATCH_DEBOUNCE_MS = 800;

/** 目录不可用时的重试间隔（workDir 迟建/被清扫重建的收敛速度）。 */
export const HISTORY_WATCH_RETRY_MS = 5_000;

export interface HistoryWatcherOptions {
  /** 变更（debounce 后）回调。回调内不得假设目录仍存在。 */
  onChange: () => void;
  /** 测试注入：默认 fs.watch。 */
  watchImpl?: (dir: string, listener: () => void) => { close: () => void };
  /** 测试注入：默认 setTimeout/set clearTimeout（走 unref）。 */
  schedule?: (fn: () => void, ms: number) => unknown;
  cancel?: (handle: unknown) => void;
}

export class HistoryWatcher {
  private readonly onChange: () => void;
  private readonly watchImpl: NonNullable<HistoryWatcherOptions['watchImpl']>;
  private readonly schedule: NonNullable<HistoryWatcherOptions['schedule']>;
  private readonly cancel: NonNullable<HistoryWatcherOptions['cancel']>;

  private dir: string | null = null;
  private watcher: { close: () => void } | null = null;
  private debounceHandle: unknown = null;
  private retryHandle: unknown = null;
  private stopped = true;

  constructor(options: HistoryWatcherOptions) {
    this.onChange = options.onChange;
    this.watchImpl = options.watchImpl ?? ((dir, listener) => {
      const w = fs.watch(dir, listener);
      return w as unknown as { close: () => void };
    });
    this.schedule = options.schedule ?? ((fn, ms) => {
      const t = setTimeout(fn, ms);
      // 旁路信号源不阻止退出（对齐 notifier/updater 定时器先例）
      (t as NodeJS.Timeout).unref?.();
      return t;
    });
    this.cancel = options.cancel ?? ((h) => clearTimeout(h as NodeJS.Timeout));
  }

  /**
   * 接管 meta 目录（幂等，语义对齐 notifier.startMetaPolling：同实例换目录
   * 即 re-arm，水位无关——本类无水位，只报「有变化」）。null = 未配置
   * workDir，停表等待下一次配置保存触发的 re-arm。
   */
  start(metaDir: string | null): void {
    this.stopInternal();
    this.stopped = false;
    if (!metaDir) return;
    this.dir = metaDir;
    this.tryWatch();
  }

  stop(): void {
    this.stopInternal();
  }

  /** 测试观测：当前是否已挂上 watch 句柄（目录可用且未停止）。 */
  isActive(): boolean {
    return this.watcher !== null;
  }

  private stopInternal(): void {
    this.stopped = true;
    if (this.watcher) {
      try { this.watcher.close(); } catch { /* 已关闭 */ }
      this.watcher = null;
    }
    if (this.debounceHandle !== null) {
      this.cancel(this.debounceHandle);
      this.debounceHandle = null;
    }
    if (this.retryHandle !== null) {
      this.cancel(this.retryHandle);
      this.retryHandle = null;
    }
    this.dir = null;
  }

  /** 目录可用即挂 watch；不可用（不存在/被打开失败）挂重试。 */
  private tryWatch(): void {
    if (this.stopped || !this.dir) return;
    const target = this.dir;
    try {
      // 目录不存在时 fs.watch 会抛——统一走重试路径
      if (!fs.existsSync(target)) throw new Error('meta dir missing');
      this.watcher = this.watchImpl(target, () => this.onEvent());
      // 目录被删/不可用时 Node 会发 error 或句柄失效——这里主动探测兜底：
      // 自续的低频活性检查保证「句柄悄悄死亡」也能恢复（fs.watch 对网络盘/
      // 目录重建的失效不总发事件）。
      this.scheduleLiveness();
    } catch {
      this.watcher = null;
      if (!this.stopped && this.retryHandle === null) {
        this.retryHandle = this.schedule(() => {
          this.retryHandle = null;
          if (!this.stopped) this.tryWatch();
        }, HISTORY_WATCH_RETRY_MS);
      }
    }
  }

  /** 自续活性检查：目录消失/句柄死亡 → 关旧柄重挂；健康则下一周期再来。 */
  private scheduleLiveness(): void {
    if (this.stopped) return;
    this.retryHandle = this.schedule(() => {
      this.retryHandle = null;
      if (this.stopped || !this.dir) return;
      if (!fs.existsSync(this.dir)) {
        // 目录消失：关掉旧句柄进重试循环（重建后自动接管）
        if (this.watcher) {
          try { this.watcher.close(); } catch { /* 已关闭 */ }
          this.watcher = null;
        }
        this.tryWatch();
        return;
      }
      if (!this.watcher) {
        this.tryWatch();
        return;
      }
      this.scheduleLiveness();
    }, HISTORY_WATCH_RETRY_MS);
  }

  /** 突发合并：窗口内多次事件 → 一次回调。 */
  private onEvent(): void {
    if (this.stopped) return;
    if (this.debounceHandle !== null) return;
    this.debounceHandle = this.schedule(() => {
      this.debounceHandle = null;
      if (this.stopped) return;
      try {
        this.onChange();
      } catch (err) {
        console.error('[history-watcher] onChange failed:', err);
      }
    }, HISTORY_WATCH_DEBOUNCE_MS);
  }
}

/** meta 目录的规范拼装（index.ts/ipc-handlers 同口径，避免两处 path.join 漂移）。 */
export function metaDirFor(workDir: string | null | undefined): string | null {
  if (!workDir) return null;
  return path.join(workDir, 'meta');
}
