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
  decideScan,
  pruneSeenByLiveFiles,
  shouldNotifyExecutorStatus,
} from './notifier-rules';

/** 轮询 workDir/meta 的间隔（ms）。终态由 executor-node 落盘，轮询即可，
 *  无需新增 IPC 通道。 */
export const META_POLL_INTERVAL_MS = 4_000;

/**
 * NETOPT-E P2-5: 增量水位线——已见过的定稿 meta 文件名集合（file → seenAt）。
 * 此前每 4s 对 meta 目录全量 readdir + 全量 stat（pickRecentMetaFiles），而
 * meta 文件只在 history:clear 时删除，N 随任务数无界增长；数千文件后每轮
 * 轮询都同步列目录 + 全量 stat 打 libuv 线程池。改为增量：只有不在本集合
 * 内的文件才 stat/parse（running 中或写入中途读坏的不入集合，下轮重看）。
 * readdir 本身仍全量（没有按 mtime 索引的目录 API），但 stat/parse 只对增量。
 */
export class Notifier {
  private enabled = true;
  private timer: ReturnType<typeof setInterval> | null = null;
  private metaDir: string | null = null;
  /** NETOPT-F P3-1: 扫描重入守卫——慢盘时上一轮 Promise.all 未归零、下一轮
   *  轮询又进 scanMetaDir 时直接跳过（seenStatus 去重不丢通知，只是双倍 I/O）。 */
  private scanning = false;
  /** NETOPT-F P2-1: 首扫静默追平——桌面重启/切 workDir 后第一轮只填
   *  seenStatus/knownFiles 水位线、不弹通知：重启前已终态的任务用户已看过
   *  或已过期，重启后新落终态的任务（不在 knownFiles）正常通知。 */
  private firstScanDone = false;
  /** executionId → 上次见到的 status（success/failed/running），用于去重。 */
  private seenStatus: Map<string, string> = new Map();
  /** 已见过的定稿 meta 文件名（增量水位线，NETOPT-E P2-5）——不再重复
   *  stat/parse；running 中或读坏的不入集合。value 记录 seenAt（供未来
   *  mtime 失效比较；当前 executionId 为平台 UUID 唯一、meta 被 TTL 删后
   *  不会重写同名文件，故 mtime 失效是理论缺口，不实现）。 */
  private knownFiles: Map<string, number> = new Map();
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
    this.timer = setInterval(() => {
      void this.scanMetaDir();
    }, META_POLL_INTERVAL_MS);
    // 轮询定时器不阻止退出（对齐 updater.ts checkTimer.unref() 先例）
    this.timer.unref?.();
  }

  stopMetaPolling(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.metaDir = null;
    // NETOPT-F P3: workDir 切换/执行器停止后清空水位线——新 workDir 是全新
    // 事件源，残留的 knownFiles/seenStatus 会让"撞同名"场景静默丢通知
    // （UUID 文件名当前不会真撞，纯防御收口；也避免跨实例残留 seenStatus
    // 误拦新实例的重复通知判断）。
    this.knownFiles = new Map();
    this.seenStatus = new Map();
    // NETOPT-F P2-1: 停止后首扫标记复位——下次 start 的首轮重新静默追平。
    this.firstScanDone = false;
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
  private async scanMetaDir(): Promise<void> {
    if (!this.metaDir || !this.enabled) return;
    if (this.scanning) return; // NETOPT-F P3-1: 重入守卫
    this.scanning = true;
    try {
    const metaDir = this.metaDir;
    let names: string[];
    try {
      // NETOPT-F P3-4: readdir 同步改 fs.promises（配合异步解析，不阻塞主线程）
      names = (await fs.promises.readdir(metaDir)).filter((f) => f.endsWith('.json'));
    } catch {
      return; // 目录尚未创建（还没有任务跑过）——正常
    }
    const fresh = names.filter((f) => !this.knownFiles.has(f));
    // NETOPT-G P1-1: seenStatus 按本轮磁盘存在性懒清（history:clear / meta
    // TTL 清扫后回收死条目）——每轮都做（即使无 fresh，删除是外部动作）。
    this.seenStatus = pruneSeenByLiveFiles(this.seenStatus, new Set(names));
    if (fresh.length === 0) return;
    // NETOPT-E P3-3: 文件解析异步化（fs.promises + Promise.all）——同步
    // readFileSync 会阻塞 Electron 主线程；读坏（写入中途被扫到）返回 null、
    // 不入集合、下轮重看（与旧 for 循环语义一致）。
    const items = await Promise.all(
      fresh.map(async (f) => {
        try {
          return { file: f, raw: JSON.parse(await fs.promises.readFile(path.join(metaDir, f), 'utf-8')) };
        } catch {
          return null;
        }
      }),
    );
    // NETOPT-G P1-1: 决策全部下沉到纯函数 decideScan（notifier-rules.ts，
    // selftest 钉死五例语义锁）——本类只做 I/O 与弹窗。firstScanDone 的
    // 置位/复位仍在本类（生命周期状态，非决策）。
    const decision = decideScan(
      items.filter((x): x is { file: string; raw: unknown } => x !== null),
      this.seenStatus,
      this.knownFiles,
      !this.firstScanDone,
    );
    this.seenStatus = decision.newSeen;
    this.knownFiles = decision.newKnown;
    for (const c of decision.toNotify) {
      const title = c.event.status === 'success' ? '任务执行成功' : '任务执行失败';
      this.notify(title, c.event.taskName);
    }
    } finally {
      this.scanning = false;
      // NETOPT-F P2-1: 无论首轮是空扫/异常/正常，一轮结束后标记完成——
      // 下一轮开始以 normal 路径通知新任务。
      this.firstScanDone = true;
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
