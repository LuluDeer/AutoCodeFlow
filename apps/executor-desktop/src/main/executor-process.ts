import { ChildProcess, spawn } from 'child_process';
import * as path from 'path';
import { app, BrowserWindow } from 'electron';
import { AppConfig } from './config-store';
import { decryptToken } from './token-crypto';
import log from './logger';

export type ExecutorStatus = 'stopped' | 'pending' | 'online' | 'offline';

type StatusChangeCallback = (status: ExecutorStatus) => void;

/** Resolve the stored token (plaintext or enc:ss: envelope) to plaintext. */
function resolveToken(config: AppConfig): string {
  try {
    return decryptToken(config.executorToken);
  } catch (err: any) {
    log.error(`Failed to resolve executor token: ${err?.message ?? err}`);
    return '';
  }
}

export class ExecutorProcess {
  private proc: ChildProcess | null = null;
  private stopping = false;
  private onStatusChange: StatusChangeCallback | null = null;
  private currentStatus: ExecutorStatus = 'stopped';
  /**
   * R23: admin registration/heartbeat verdict inferred from executor-node
   * log lines. The health poll is only a liveness signal — while this is
   * 'failed' (Register failed / Heartbeat failed seen, no success log yet),
   * a live /health/live must NOT flip the tray back to 'online'.
   */
  private adminRegistration: 'unknown' | 'registered' | 'failed' = 'unknown';

  getStatus(): ExecutorStatus {
    return this.currentStatus;
  }

  setStatusCallback(cb: StatusChangeCallback): void {
    this.onStatusChange = cb;
  }

  private notifyStatus(status: ExecutorStatus): void {
    this.currentStatus = status;
    this.onStatusChange?.(status);
    // 广播到所有渲染进程
    BrowserWindow.getAllWindows().forEach((win) => {
      if (!win.isDestroyed()) {
        win.webContents.send('executor:status-change', status);
      }
    });
  }

  private getEntryPath(): string {
    if (app.isPackaged) {
      return path.join(process.resourcesPath, 'executor-node', 'index.js');
    }
    // 开发时指向编译产物（resources/ 与 dist/ 同级，在 app root 下）
    return path.join(app.getAppPath(), 'resources', 'executor-node', 'index.js');
  }

  async start(config: AppConfig): Promise<void> {
    if (this.proc) {
      log.warn('ExecutorProcess.start() called but process is already running');
      return;
    }
    this.stopping = false;
    this.adminRegistration = 'unknown';
    this.notifyStatus('pending');

    const entryPath = this.getEntryPath();
    log.info(`Starting executor-node from: ${entryPath}`);

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      APP_NAME: config.executorName,
      PORT: String(config.executorPort),
      EXECUTOR_ADDRESS: `${config.executorHost}:${config.executorPort}`,
      EXECUTOR_ADDRESS_PUBLIC:
        config.executorAddressPublic || `${config.executorHost}:${config.executorPort}`,
      ADMIN_API_URL: config.adminApiUrl,
      WORK_DIR: config.workDir,
      MAX_CONCURRENT_TASKS: String(config.maxConcurrentTasks),
      // SEC-NEW-1: config may hold the enc:ss: envelope — resolve to the real
      // secret for the child env (the only consumer that needs plaintext).
      EXECUTOR_SHARED_TOKEN: resolveToken(config),
    };

    this.proc = spawn(process.execPath, [entryPath], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    // Start health-polling as primary online/offline signal
    this.startHealthPoll(config.executorPort);

    this.proc.stdout?.on('data', (chunk: Buffer) => {
      const line = chunk.toString();
      log.info(`[executor] ${line.trim()}`);
      this.broadcastLog(line);
      // 从日志文本推断 admin 注册/心跳状态
      this.inferStatusFromLog(line);
    });

    this.proc.stderr?.on('data', (chunk: Buffer) => {
      const line = chunk.toString();
      log.warn(`[executor:err] ${line.trim()}`);
      this.broadcastLog(line);
      // stderr 里也可能有心跳/注册日志
      this.inferStatusFromLog(line);
    });

    this.proc.on('exit', (code, signal) => {
      log.info(`Executor exited: code=${code} signal=${signal}`);
      this.proc = null;
      this.stopHealthPoll();
      if (!this.stopping) {
        this.notifyStatus('offline');
      } else {
        this.notifyStatus('stopped');
      }
    });

    this.proc.on('error', (err) => {
      log.error(`Failed to start executor: ${err.message}`);
      this.proc = null;
      this.stopHealthPoll();
      this.notifyStatus('offline');
    });
  }

  async stop(): Promise<void> {
    if (!this.proc) return;
    this.stopping = true;
    this.notifyStatus('pending');

    return new Promise((resolve) => {
      const proc = this.proc!;
      const finish = () => {
        clearTimeout(timer);
        this.proc = null;
        this.notifyStatus('stopped');
        resolve();
      };
      const timer = setTimeout(() => {
        log.warn('Graceful shutdown timeout (8s), force-killing');
        this.forceKillTree(proc);
        finish();
      }, 8_000);

      proc.once('exit', finish);

      // R-08 (windows-findings): on win32 child.kill('SIGTERM') is
      // TerminateProcess — it does NOT run executor-node's graceful
      // handler, and it leaves the task's own child processes running
      // as orphans. Tree-kill with taskkill /T /F so the whole executor +
      // its task tree is reaped. On POSIX, SIGTERM triggers the graceful
      // chain (drain + group kill) as designed.
      if (process.platform === 'win32') {
        this.forceKillTree(proc);
      } else {
        proc.kill('SIGTERM');
      }
    });
  }

  /** win32: kill the executor and every descendant process tree. */
  private forceKillTree(proc: ChildProcess): void {
    if (process.platform === 'win32' && proc.pid !== undefined) {
      try {
        spawn('taskkill', ['/T', '/F', '/PID', String(proc.pid)], { stdio: 'ignore' });
      } catch (_) {
        proc.kill('SIGKILL');
      }
    } else {
      try {
        proc.kill('SIGKILL');
      } catch (_) {
        /* already dead */
      }
    }
  }

  isRunning(): boolean {
    return this.proc !== null && this.proc.exitCode === null;
  }

  private healthPollTimer: ReturnType<typeof setInterval> | null = null;

  /**
   * Start polling executor-node's /health/live endpoint. This is a
   * liveness signal only: R23 — a passing poll must not override a known
   * admin-registration failure (see adminRegistration / inferStatusFromLog).
   */
  private startHealthPoll(port: number): void {
    this.stopHealthPoll();
    // Poll every 8 seconds; first check after 3s to allow executor to start
    let firstCheck = true;
    const check = async () => {
      try {
        const http = require('http') as typeof import('http');
        await new Promise<void>((resolve, reject) => {
          const req = http.get(
            { hostname: '127.0.0.1', port, path: '/health/live', timeout: 3000 },
            (res) => {
              res.resume();
              res.statusCode && res.statusCode < 400 ? resolve() : reject(new Error(`HTTP ${res.statusCode}`));
            },
          );
          req.on('error', reject);
          req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
        });
        if (this.adminRegistration === 'failed') {
          // Process alive but admin registration/heartbeat is failing: the
          // tray must show offline until a success log line clears the flag.
          if (this.currentStatus !== 'offline') {
            this.notifyStatus('offline');
          }
        } else if (this.currentStatus !== 'online') {
          this.notifyStatus('online');
        }
      } catch {
        // Only flip to offline if we were previously online/pending — ignore during initial startup grace
        if (!firstCheck && (this.currentStatus === 'online' || this.currentStatus === 'pending')) {
          this.notifyStatus('offline');
        }
      }
      firstCheck = false;
    };
    // First check after 3s to allow the executor to bind its port
    setTimeout(check, 3000);
    this.healthPollTimer = setInterval(check, 8000);
  }

  private stopHealthPoll(): void {
    if (this.healthPollTimer) {
      clearInterval(this.healthPollTimer);
      this.healthPollTimer = null;
    }
  }

  /**
   * Infer admin connectivity from executor-node log lines and record it in
   * `adminRegistration`. The health poll only proves liveness; per R23 the
   * 'online' verdict additionally requires that a known registration/
   * heartbeat failure has been cleared by a success log line (matching the
   * semantics heartbeat.ts documents: online is decided by admin-facing
   * heartbeat results, not by local liveness alone).
   */
  private inferStatusFromLog(line: string): void {
    // Registration/heartbeat success confirms admin connectivity beyond just liveness
    if (line.includes('Registered to admin-api') || line.includes('Heartbeat succeeded')) {
      this.adminRegistration = 'registered';
      if (this.currentStatus !== 'online') {
        this.notifyStatus('online');
      }
      return;
    }
    // Registration/heartbeat failure: process alive but admin unreachable
    if (line.includes('Register failed') || line.includes('Heartbeat failed')) {
      this.adminRegistration = 'failed';
      if (this.currentStatus === 'online' || this.currentStatus === 'pending') {
        this.notifyStatus('offline');
      }
    }
  }

  private broadcastLog(line: string): void {
    BrowserWindow.getAllWindows().forEach((win) => {
      if (!win.isDestroyed()) {
        win.webContents.send('executor:log-line', line);
      }
    });
  }
}
