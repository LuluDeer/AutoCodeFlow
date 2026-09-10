/**
 * DSK-04：系统通知 Electron 面。规则判断全部在 notifier-rules.ts（纯函数、
 * selftest 覆盖）；本模块只做三件事：
 *  1) 持有 Notification 开关（notifyEnabled，config-store 持久化）；
 *  2) 调用规则层决定是否通知，构造通知内容（不含 token / errorMessage /
 *     绝对路径——见 notifier-rules.ts 头注的安全约束）；
 *  3) 点击通知 → 聚焦状态窗口（windowManager 回调注入，避免循环引用，
 *     对齐 tray.ts 的回调注入形态）。
 *
 * Electron Notification 在裸 Node selftest 下不可用，因此本文件不进
 * selftest 编译面；可测逻辑全部下沉到 notifier-rules.ts。
 */
import { Notification } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import log from './logger';
import {
  ExecutorStatusLike,
  shouldNotifyExecutorStatus,
  shouldNotifyTaskTransition,
  summarizeExecMeta,
} from './notifier-rules';

/** 轮询 workDir/meta 的间隔（ms）。终态由 executor-node 落盘，轮询即可，
 *  无需新增 IPC 通道。 */
export const META_POLL_INTERVAL_MS = 4_000;

/** 单轮扫描的 meta 文件数上限（防御异常目录膨胀，正常远小于此）。 */
const META_SCAN_LIMIT = 500;

export class Notifier {
  private enabled = true;
  private timer: ReturnType<typeof setInterval> | null = null;
  private metaDir: string | null = null;
  /** executionId → 上次见到的 status（success/failed/running），用于去重。 */
  private seenStatus: Map<string, string> = new Map();
  /** 上次见到的执行器状态（离线通知的转移判断输入）。 */
  private lastExecutorStatus: ExecutorStatusLike | undefined;
  private onOpenStatus: (() => void) | null = null;

  /** 注入「点击通知 → 打开状态窗口」回调（index.ts 里接 windowManager）。 */
  set onOpenStatusCallback(cb: (() => void) | null) {
    this.onOpenStatus = cb;
  }

  /** 同步开关（config-store 启动时注入；IPC autolaunch 同款写法）。 */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * 启动 meta 目录轮询。metaDir 为空（未配置 workDir）时不启动——没有
   * 事件源就没有通知。
   */
  startMetaPolling(metaDir: string | null): void {
    this.stopMetaPolling();
    if (!metaDir) return;
    this.metaDir = metaDir;
    this.timer = setInterval(() => this.scanMetaDir(), META_POLL_INTERVAL_MS);
    // 轮询定时器不阻止退出（对齐 updater.ts checkTimer.unref() 先例）
    this.timer.unref?.();
  }

  stopMetaPolling(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.metaDir = null;
  }

  /** 执行器状态回调入口（index.ts 里接 executorProcess/heartbeat 回调）。 */
  onExecutorStatus(status: ExecutorStatusLike): void {
    if (shouldNotifyExecutorStatus(this.lastExecutorStatus, status)) {
      this.notify('执行器离线', '与平台的心跳连接已中断，请检查网络或平台状态');
    }
    this.lastExecutorStatus = status;
  }

  /** 单轮扫描 meta 目录：读终态 → 规则判断 → 通知。所有异常静默（通知
   *  是锦上添花，绝不因它打扰主流程）。 */
  private scanMetaDir(): void {
    if (!this.metaDir || !this.enabled) return;
    let files: string[];
    try {
      files = fs.readdirSync(this.metaDir).filter((f) => f.endsWith('.json'));
    } catch {
      return; // 目录尚未创建（还没有任务跑过）——正常
    }
    for (const file of files.slice(0, META_SCAN_LIMIT)) {
      const metaPath = path.join(this.metaDir, file);
      try {
        const raw = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
        const event = summarizeExecMeta(raw);
        if (!event) continue; // running / 非法 / 缺字段
        const prev = this.seenStatus.get(event.executionId);
        if (!shouldNotifyTaskTransition(prev, event.status)) continue;
        this.seenStatus.set(event.executionId, event.status);
        const title = event.status === 'success' ? '任务执行成功' : '任务执行失败';
        this.notify(title, event.taskName);
      } catch {
        // 单个 meta 文件读坏（写入中途被扫到等）——跳过，下轮再看
      }
    }
    // seenStatus 防膨胀：history-store 上限 500 条，这里对齐量级
    if (this.seenStatus.size > 1000) {
      this.seenStatus = new Map(Array.from(this.seenStatus.entries()).slice(-500));
    }
  }

  /** 弹系统通知。开关关闭 / 系统不支持 / 权限缺失时静默跳过。 */
  private notify(title: string, body: string): void {
    if (!this.enabled) return;
    try {
      if (!Notification.isSupported()) {
        log.debug(`notify skipped (not supported): ${title}`);
        return;
      }
      const n = new Notification({ title, body, silent: false });
      n.on('click', () => this.onOpenStatus?.());
      n.show();
      log.info(`notify: ${title} — ${body}`);
    } catch (err: any) {
      // Linux 无 libnotify / Windows 通知服务异常等——只落日志
      log.warn(`notify failed: ${err?.message ?? err}`);
    }
  }
}
