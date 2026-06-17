import * as http from 'http';
import log from './logger';

export type HeartbeatStatus = 'online' | 'offline';
type StatusCallback = (status: HeartbeatStatus) => void;

const INTERVAL_MS = 10_000;
const TIMEOUT_MS = 3_000;
const FAILURE_THRESHOLD = 2;

export class HeartbeatMonitor {
  private timer: ReturnType<typeof setInterval> | null = null;
  private failCount = 0;
  private port = 8002;
  private onStatus: StatusCallback | null = null;
  private lastStatus: HeartbeatStatus | null = null;

  setCallback(cb: StatusCallback): void {
    this.onStatus = cb;
  }

  start(port: number): void {
    this.stop();
    this.port = port;
    this.failCount = 0;
    this.timer = setInterval(() => this.check(), INTERVAL_MS);
    // 立即检查一次
    setTimeout(() => this.check(), 1_500);
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private check(): void {
    const req = http.get(
      `http://127.0.0.1:${this.port}/health/live`,
      { timeout: TIMEOUT_MS },
      (res) => {
        res.resume(); // 消耗响应体，避免内存泄漏
        if (res.statusCode === 200) {
          // 进程存活：只重置失败计数，不主动发 online。
          // online/offline 由 executor-node 日志中的 admin 心跳结果决定。
          this.failCount = 0;
        } else {
          this.handleFailure(`HTTP ${res.statusCode}`);
        }
      },
    );

    req.on('error', (err) => this.handleFailure(err.message));
    req.on('timeout', () => {
      req.destroy();
      this.handleFailure('timeout');
    });
  }

  private handleFailure(reason: string): void {
    this.failCount++;
    log.debug(`Heartbeat failure #${this.failCount}: ${reason}`);
    if (this.failCount >= FAILURE_THRESHOLD) {
      this.emit('offline');
    }
  }

  private emit(status: HeartbeatStatus): void {
    if (status !== this.lastStatus) {
      this.lastStatus = status;
      this.onStatus?.(status);
    }
  }
}
