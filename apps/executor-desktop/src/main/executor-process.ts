import { ChildProcess, spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { app, BrowserWindow } from 'electron';
import { AppConfig } from './config-store';
import { decryptToken } from './token-crypto';
import log from './logger';
import {
  buildUvChildEnv,
  resolveBundledUvPath as resolveBundledUvPathPure,
  resolveInterpretersDir as resolveInterpretersDirPure,
} from './uv-paths';

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

/**
 * 定位随客户端分发的 uv（python_task_multiversion）。
 * 决策逻辑在 `uv-paths.ts`（纯函数、可自检）；这里只注入 Electron 的运行时值。
 */
export function resolveBundledUvPath(): string | null {
  return resolveBundledUvPathPure({
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    appPath: app.getAppPath(),
    userDataDir: app.getPath('userData'),
    platform: process.platform,
    existsFile: (candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile(),
  });
}

/**
 * 解释器缓存池目录（`UV_PYTHON_INSTALL_DIR`）。
 *
 * 默认落在 `userData` 而不是安装目录：Windows 上安装目录通常是
 * `Program Files`，标准用户无写权限，uv 下载解释器会直接失败；且卸载/升级
 * 不该连带删掉已下载的解释器（每版本几十 MB）。用户可用 config.uvPythonInstallDir 覆盖。
 */
export function resolveInterpretersDir(config: AppConfig): string {
  return resolveInterpretersDirPure(config.uvPythonInstallDir, app.getPath('userData'));
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

    // ---- python_task_multiversion：uv 与解释器池 ----
    // 客户端执行器与 python 执行器**功能对等**：声明了 runtimeVersion 的任务
    // 同样要走 uv 的多版本解释器。这里只负责把"用哪个 uv、池放哪"告诉子进程，
    // 具体解析链与回退由 executor-node 自己决定（UV_BIN → PATH → bundled）。
    const bundledUv = resolveBundledUvPath();
    const configuredUv = (config.uvPath || '').trim();
    const uvBin = configuredUv || bundledUv || null;
    if (configuredUv) {
      // 用户显式指定优先于自带（例如内网自建 uv 分发）。
      log.info(`Using configured uv (uvPath): ${configuredUv}`);
    } else if (bundledUv) {
      log.info(`Using bundled uv: ${bundledUv}`);
    } else if (!env.UV_BIN) {
      // 不覆盖用户可能已在系统环境里设的 UV_BIN。
      log.info(
        'No bundled uv found; executor-node will fall back to PATH lookup. ' +
          'Tasks declaring a Python runtimeVersion need uv available.',
      );
    }
    const interpretersDir = resolveInterpretersDir(config);
    Object.assign(
      env,
      buildUvChildEnv({
        uvBin,
        interpretersDir,
        mirror: config.uvPythonInstallMirror,
        pypiRegistryUrl: config.pypiRegistryUrl,
        downloadTimeoutMs: config.interpreterDownloadTimeoutMs,
      }),
    );
    // 环境里已有 UV_BIN（用户系统级配置）且我们没自带/没显式指定时，
    // buildUvChildEnv 不会写 UV_BIN，此处保持原值即可（已被 ...process.env 带入）。
    log.info(`Interpreter pool dir: ${interpretersDir}`);

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
   * 首次 3s 延迟检查的句柄。此前该 setTimeout 未保存句柄，stopHealthPoll()
   * 只能清掉 interval——若在启动后 3s 内停止执行器（或进程立即崩溃），
   * 这一次 check 仍会触发，对已停止/已被新实例占用的端口发出探测请求，
   * 并把状态回写成 online/offline（覆盖正确的 stopped）。故与 interval
   * 一并纳入 stopHealthPoll 统一取消。
   */
  private healthPollFirstTimer: ReturnType<typeof setTimeout> | null = null;
  /** 代际计数：stop 后仍在飞的 check 回调凭此丢弃过期结果。 */
  private healthPollGen = 0;

  /**
   * Start polling executor-node's /health/live endpoint. This is a
   * liveness signal only: R23 — a passing poll must not override a known
   * admin-registration failure (see adminRegistration / inferStatusFromLog).
   */
  private startHealthPoll(port: number): void {
    this.stopHealthPoll();
    const gen = ++this.healthPollGen;
    // Poll every 8 seconds; first check after 3s to allow executor to start
    let firstCheck = true;
    const check = async () => {
      // 代际守卫：stop 之后（或已被新一次 start 取代）的在飞请求必须丢弃，
      // 否则会在执行器已停止后把状态改回 online/offline。
      if (gen !== this.healthPollGen) return;
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
        if (gen !== this.healthPollGen) return;
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
        if (gen !== this.healthPollGen) return;
        // Only flip to offline if we were previously online/pending — ignore during initial startup grace
        if (!firstCheck && (this.currentStatus === 'online' || this.currentStatus === 'pending')) {
          this.notifyStatus('offline');
        }
      }
      firstCheck = false;
    };
    // First check after 3s to allow the executor to bind its port
    this.healthPollFirstTimer = setTimeout(check, 3000);
    this.healthPollTimer = setInterval(check, 8000);
  }

  private stopHealthPoll(): void {
    // 递增代际，令所有在飞/待发的 check 回调立即失效
    this.healthPollGen++;
    if (this.healthPollFirstTimer) {
      clearTimeout(this.healthPollFirstTimer);
      this.healthPollFirstTimer = null;
    }
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
