import { ChildProcess, spawn } from 'child_process';
import * as path from 'path';
import { app, BrowserWindow } from 'electron';
import { AppConfig } from './config-store';
import log from './logger';

export type ExecutorStatus = 'stopped' | 'pending' | 'online' | 'offline';

type StatusChangeCallback = (status: ExecutorStatus) => void;

export class ExecutorProcess {
  private proc: ChildProcess | null = null;
  private stopping = false;
  private onStatusChange: StatusChangeCallback | null = null;
  private currentStatus: ExecutorStatus = 'stopped';

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
      EXECUTOR_SHARED_TOKEN: config.executorToken,
    };

    this.proc = spawn(process.execPath, [entryPath], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

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
      if (!this.stopping) {
        this.notifyStatus('offline');
      } else {
        this.notifyStatus('stopped');
      }
    });

    this.proc.on('error', (err) => {
      log.error(`Failed to start executor: ${err.message}`);
      this.proc = null;
      this.notifyStatus('offline');
    });
  }

  async stop(): Promise<void> {
    if (!this.proc) return;
    this.stopping = true;
    this.notifyStatus('pending');

    return new Promise((resolve) => {
      const proc = this.proc!;
      const timer = setTimeout(() => {
        log.warn('Graceful shutdown timeout (8s), sending SIGKILL');
        proc.kill('SIGKILL');
        this.proc = null;
        this.notifyStatus('stopped');
        resolve();
      }, 8_000);

      proc.once('exit', () => {
        clearTimeout(timer);
        this.proc = null;
        this.notifyStatus('stopped');
        resolve();
      });

      // executor-node 监听了 SIGTERM 优雅退出
      proc.kill('SIGTERM');
    });
  }

  isRunning(): boolean {
    return this.proc !== null && this.proc.exitCode === null;
  }

  /**
   * 解析 executor-node 的日志文本，推断 admin 注册/心跳状态。
   * 进程存活不等于与 admin 连通，需要用日志来区分 online / offline。
   */
  private inferStatusFromLog(line: string): void {
    // 注册成功或心跳成功 → online
    if (line.includes('Registered to admin-api') || line.includes('Heartbeat succeeded')) {
      if (this.currentStatus !== 'online') {
        this.notifyStatus('online');
      }
      return;
    }
    // 注册失败或心跳失败 → offline（进程还在，但 admin 不可达）
    if (line.includes('Register failed') || line.includes('Heartbeat failed')) {
      if (this.currentStatus === 'online' || this.currentStatus === 'pending') {
        this.notifyStatus('offline');
      }
      return;
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
