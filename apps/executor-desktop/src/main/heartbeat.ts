import * as http from 'http';
import * as https from 'https';
import log from './logger';
// 与 executor-process（applyAdminStatus / inferStatusFromLog）共用同一份离线
// 迟滞判定（NETOPT-G P1-5）：连续 3 次失败、或距上次成功 >90s 才判离线。
// 此前本文件自带 FAILURE_THRESHOLD=2——10s 探针间隔下 20s 即判死，比中台
// 真实的 90s 判死激进得多，一次抖动就把托盘打成 offline。
import {
  advanceHeartbeatHysteresis,
  initialHeartbeatHysteresisState,
  type HeartbeatHysteresisState,
} from './notifier-rules';

export type HeartbeatStatus = 'online' | 'offline';
type StatusCallback = (status: HeartbeatStatus) => void;

const INTERVAL_MS = 10_000;
const TIMEOUT_MS = 3_000;
const DEFAULT_PORT = 8002;

/**
 * UX-DSK-PORT：端口必须是一个**可放进 URL** 的合法整数。
 *
 * 反证过的故障：`start(port)` 曾原样保存渲染层送来的值，而端口来自
 * `<input type="number">` 的 `parseInt()` —— 清空输入框得到 NaN。于是
 * `http.get('http://127.0.0.1:NaN/health/live')` 在**构造 URL 时同步抛出**
 * ERR_INVALID_URL（实测：不是走 'error' 事件，是直接 throw）。
 * 抛点位于 setInterval 回调 → 未捕获异常 → 主进程持续每 10s 抛一次，
 * 且 `failCount` 永不推进，托盘状态就永远停在 online/pending，用户看到
 * "在线"而执行器其实已经死了。
 *
 * 纯函数独立导出，便于自检（本文件顶层 import electron-log，无法在
 * 裸 node 下加载，与 path-domain/uv-paths 同一处置）。
 */
export function normalizeHeartbeatPort(port: unknown): number {
  const n = typeof port === 'number' ? port : parseInt(String(port ?? ''), 10);
  if (!Number.isFinite(n)) return DEFAULT_PORT;
  const i = Math.round(n);
  if (i < 1 || i > 65535) return DEFAULT_PORT;
  return i;
}

/**
 * F-3（中台↔执行器深度审查）：admin 探针 URL 的合法化——与 UX-DSK-PORT 同款
 * 反证：`http.get(url)` 在 URL 非法时**同步抛出**（ERR_INVALID_URL），若 adminApiUrl
 * 来自设置页输入框的脏值，会从 setInterval 回调冒泡成未捕获异常。这里统一收敛：
 * 非法/非 http(s)/无 host 一律返回 null（调用方跳过 admin 探针，不抛）。
 */
export function normalizeAdminProbeUrl(url: unknown): string | null {
  if (typeof url !== 'string' || !url.trim()) return null;
  const trimmed = url.trim();
  // F-3 残差：`https:///path` 这种「空 authority」会被 WHATWG 解析成单标签
  // 主机名（hostname='path'），空 hostname 判定抓不到。显式拒绝 `scheme:///`
  // 形态——它不是可探针的地址，按 F-3 语义回落 null。
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/\//.test(trimmed)) return null;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  if (!parsed.hostname) return null;
  return parsed.toString().replace(/\/+$/, '');
}

export class HeartbeatMonitor {
  private timer: ReturnType<typeof setInterval> | null = null;
  private immediateTimer: ReturnType<typeof setTimeout> | null = null;
  /** F-3: 本地 /health/live 与 admin /api/health **分通道**迟滞状态（各计各的，
   *  单通道合并计数会互相掩盖——同一轮内 admin 失败先到、本地成功后到会把
   *  admin 失败清零，AND 逻辑失效）。迟滞口径与 notifier-rules 同源：
   *  连续 3 次失败、或距上次成功 >90s 才判该通道离线。 */
  private localHysteresis: HeartbeatHysteresisState = initialHeartbeatHysteresisState();
  private adminHysteresis: HeartbeatHysteresisState = initialHeartbeatHysteresisState();
  private port = 8002;
  /** F-3: 直达中台的探针地址（如 http://localhost:3000）；未配置则跳过 admin 探针。 */
  private adminApiUrl: string | null = null;
  private onStatus: StatusCallback | null = null;
  private lastStatus: HeartbeatStatus | null = null;

  setCallback(cb: StatusCallback): void {
    this.onStatus = cb;
  }

  /**
   * F-3: 新增 adminApiUrl 参数——本地 /health/live 存活探针 + 中台 /api/health
   * 直达探针做 **AND 逻辑**：任一通道持续失败即判离线。此前 HeartbeatMonitor
   * 只探测本地端口，executor-node 子进程活着但其与中台的链路断开（如 VPN
   * 断裂）时，桌面仍显示"在线"——用户对中台断连无感知。executor-node 自身的
   * 心跳失败会被它自己的日志/结构化状态兜住（见 executor-process F-2），
   * 但桌面层面**独立**的直达探针让断连立即可见，不依赖子进程状态上报。
   */
  start(port: number, adminApiUrl?: string): void {
    this.stop();
    // UX-DSK-PORT：NaN 端口会让 http.get 在**构造 URL 时同步抛出**
    // ERR_INVALID_URL（不走 'error' 事件），未捕获异常从 setInterval 回调冒泡。
    this.port = normalizeHeartbeatPort(port);
    this.adminApiUrl = normalizeAdminProbeUrl(adminApiUrl);
    this.localHysteresis = initialHeartbeatHysteresisState();
    this.adminHysteresis = initialHeartbeatHysteresisState();
    this.timer = setInterval(() => this.check(), INTERVAL_MS);
    // 立即检查一次（句柄保存，stop() 必须能取消它 — R25）。
    // 启动误报窗口（NETOPT-G 同款口径）：首探 1.5s，此后每 10s 一轮，第 3 次
    // 失败发生在 1.5 + 2×10 = 21.5s——执行器慢启动 >21.5s 才可能被误判 offline，
    // 且子进程起来后的首次成功探针会经 recordSuccess 的恢复边沿把状态翻回
    // online（旧实现 FAILURE_THRESHOLD=2 时 11.5s 即判死且永不自愈）。
    this.immediateTimer = setTimeout(() => this.check(), 1_500);
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.immediateTimer !== null) {
      clearTimeout(this.immediateTimer);
      this.immediateTimer = null;
    }
  }

  /**
   * B-2：休眠唤醒后的迟滞锚点重置。
   *
   * 为什么需要：迟滞的两个判据——连续失败计数与「距上次成功 >90s」（
   * advanceHeartbeatHysteresis 的 silentTooLong）——都锚在 lastSuccessAt 上。
   * 机器休眠数小时后唤醒，lastSuccessAt 仍是**休眠前**的时刻，唤醒后的第一
   * 轮探针只要失败（网络栈尚未就绪是常态）就立即满足 silentTooLong → 弹
   * 「执行器离线」——典型的唤醒误报（全仓此前无任何 powerMonitor resume 处理）。
   *
   * 语义：两个通道都重置为「未判定」态（lastSuccessAt 清 null、失败计数清零）。
   * 重置后首轮失败在 advanceHeartbeatHysteresis 里只推进计数（lastSuccessAt
   * 为 null 时 silentTooLong 恒 false），连续 3 次失败才可能判死——即「跨
   * resume 后首轮只计数不判死」。随后立即补探一轮，尽快重建真实锚点。
   */
  resetForResume(): void {
    this.localHysteresis = initialHeartbeatHysteresisState();
    this.adminHysteresis = initialHeartbeatHysteresisState();
    // 未在运行（stop 后）时仅重置锚点即可，不需要也不应该发起探针。
    if (this.timer !== null) {
      this.check();
    }
  }

  private check(): void {
    // F-3: 双探针并行——本地存活 + 中台直达（AND：任一通道连续失败都判离线）。
    this.probe(`http://127.0.0.1:${this.port}/health/live`, 'local');
    if (this.adminApiUrl) {
      this.probe(`${this.adminApiUrl}/api/health`, 'admin');
    }
  }

  private probe(url: string, channel: 'local' | 'admin'): void {
    const requestImpl = url.startsWith('https:') ? https.get : http.get;
    const req = requestImpl(
      url,
      { timeout: TIMEOUT_MS },
      (res) => {
        res.resume(); // 消耗响应体，避免内存泄漏
        if (res.statusCode === 200) {
          // 进程/服务存活：只重置本通道失败计数，不主动发 online。
          // online/offline 由 executor-node 日志中的 admin 心跳结果决定。
          this.recordSuccess(channel);
        } else {
          this.recordFailure(channel, `HTTP ${res.statusCode} @ ${url}`);
        }
      },
    );

    req.on('error', (err) => this.recordFailure(channel, `${err.message} @ ${url}`));
    req.on('timeout', () => {
      req.destroy();
      this.recordFailure(channel, `timeout @ ${url}`);
    });
  }

  private recordSuccess(channel: 'local' | 'admin'): void {
    // 同一份迟滞判定：成功即清零该通道计数并锚定本次成功时刻（90s 静默判死
    // 的基准点）。
    const ev = advanceHeartbeatHysteresis(
      channel === 'local' ? this.localHysteresis : this.adminHysteresis,
      'ok',
      Date.now(),
    );
    if (channel === 'local') this.localHysteresis = ev.state;
    else this.adminHysteresis = ev.state;
    // 恢复边沿：此前判过 offline、且现在**所有启用通道**都恢复健康时才翻回
    // online——只发这一次（emit 自带 lastStatus 去重，健康期间每 10s 的成功
    // 探针不会重复发），修复"心跳判死 offline 后托盘永久卡离线"（旧实现
    // recordSuccess 只清零计数、从不 emit online，而 executor-process 自己的
    // currentStatus 一直是 online，其恢复路径不会触发——两路无人翻回）。
    if (this.lastStatus === 'offline' && this.allChannelsHealthy()) {
      this.emit('online');
    }
  }

  private recordFailure(channel: 'local' | 'admin', reason: string): void {
    const ev = advanceHeartbeatHysteresis(
      channel === 'local' ? this.localHysteresis : this.adminHysteresis,
      'failed',
      Date.now(),
    );
    if (channel === 'local') this.localHysteresis = ev.state;
    else this.adminHysteresis = ev.state;
    log.debug(
      `Heartbeat failure #${ev.state.consecutiveFailures} (${channel}): ${reason}`,
    );
    if (ev.offline) {
      this.emit('offline');
    }
  }

  /** AND 恢复判定：全部启用的探针通道当前都健康（连续失败计数均已清零）。 */
  private allChannelsHealthy(): boolean {
    if (this.localHysteresis.consecutiveFailures > 0) return false;
    if (this.adminApiUrl !== null && this.adminHysteresis.consecutiveFailures > 0) {
      return false;
    }
    return true;
  }

  private emit(status: HeartbeatStatus): void {
    if (status !== this.lastStatus) {
      this.lastStatus = status;
      this.onStatus?.(status);
    }
  }
}
