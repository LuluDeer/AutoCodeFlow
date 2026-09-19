import { ChildProcess, spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { app, BrowserWindow } from 'electron';
import { AppConfig } from './config-store';
import { decryptToken } from './token-crypto';
import log from './logger';
import {
  buildExecutorChildEnv,
  buildUvChildEnv,
  resolveBundledUvPath as resolveBundledUvPathPure,
  resolveInterpretersDir as resolveInterpretersDirPure,
} from './uv-paths';
import { listLocalIPv4s } from './network-util';
import { LineSplitter } from './child-line-splitter';

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
   * R23: admin registration/heartbeat verdict. F-2 后主判据为
   * /health/admin-status 结构化状态（applyAdminStatus）；inferStatusFromLog
   * 仅作旧内嵌 bundle（无该端点）的降级回退。为 'failed'（Register/Heartbeat
   * 失败且无成功信号）时，/health/live 存活**不得**把托盘翻回 'online'。
   */
  private adminRegistration: 'unknown' | 'registered' | 'failed' = 'unknown';
  /**
   * NETOPT-2⑦: 子进程输出按行缓冲（一个 data chunk ≠ 一行）。每次 start()
   * 重建；进程退出时 flush 冲洗残留半行。详见 child-line-splitter.ts 头注。
   */
  private stdoutSplitter = new LineSplitter((line) => this.emitChildLine(line, false));
  private stderrSplitter = new LineSplitter((line) => this.emitChildLine(line, true));

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
      // 与子进程的全部环境契约集中在 buildExecutorChildEnv（纯函数、有自检）：
      // 那里记录了 BIND_ADDRESS / EXECUTOR_ALLOW_PRIVATE_NETWORK 两个
      // "漏了不报错、只是永远不工作"的键为什么必须存在。
      ...buildExecutorChildEnv({
        appName: config.executorName,
        port: config.executorPort,
        bindAddress: config.executorHost,
        executorHost: config.executorHost,
        executorAddressPublic: config.executorAddressPublic,
        // 「对外地址」留空 + 默认通配监听（0.0.0.0）时，用第一块真实网卡兜底，
        // 绝不能把 0.0.0.0 注册给 admin（reserved，无条件被拒，见 uv-paths 注释）。
        fallbackLanIp: listLocalIPv4s()[0] ?? '',
        // P3-1：设置页日志级别透传给 executor-node（此前 config.logLevel 是
        // 没有任何消费者的死字段）。
        logLevel: config.logLevel,
        adminApiUrl: config.adminApiUrl,
        workDir: config.workDir,
        maxConcurrentTasks: config.maxConcurrentTasks,
        // SEC-NEW-1: config may hold the enc:ss: envelope — resolve to the real
        // secret for the child env (the only consumer that needs plaintext).
        sharedToken: resolveToken(config),
      }),
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

    // 4-4（audit-r4）：桌面端任务进程不让抢占 UI——Windows 下调低子进程
    // 优先级为 BelowNormal（无 Linux niceness 等价物；POSIX 保持默认，避免
    // 在生产 Linux 上误伤任务吞吐）。best-effort：失败不阻断启动。
    // NETOPT-2⑧: 此前为这一条调用一次性 spawn powershell——每次启动执行器都
    // 拉起一个 PowerShell 进程（冷启动数百 ms～秒级 CPU + 一闪而过的黑窗风险）。
    // 改用 Node 内建 os.setPriority（Node ≥10.14）：同步、零进程开销、跨版本
    // 稳定。失败（如被组策略/安全软件限制）仅 warn，不阻断启动。
    if (process.platform === 'win32' && this.proc.pid !== undefined) {
      try {
        os.setPriority(this.proc.pid, os.constants.priority.PRIORITY_BELOW_NORMAL);
      } catch (err) {
        log.warn(
          `Failed to set executor priority to BelowNormal: ${err instanceof Error ? err.message : err}`,
        );
      }
    }

    // Start health-polling as primary online/offline signal
    this.startHealthPoll(config.executorPort);

    // NETOPT-2⑦: data 回调只做按行缓冲拆分——此前每个 chunk 直送
    // handleChildOutput，多行 chunk / 跨块半行都会让合法 JSON 行进不了
    // 结构化通道（详见 child-line-splitter.ts 头注）。
    this.proc.stdout?.on('data', (chunk: Buffer) => {
      this.stdoutSplitter.feed(chunk.toString('utf-8'));
    });

    this.proc.stderr?.on('data', (chunk: Buffer) => {
      this.stderrSplitter.feed(chunk.toString('utf-8'));
    });

    this.proc.on('exit', (code, signal) => {
      log.info(`Executor exited: code=${code} signal=${signal}`);
      // NETOPT-2⑦: 退出时冲洗残留半行（不以换行结束的最后一行也算一行）。
      this.stdoutSplitter.flush();
      this.stderrSplitter.flush();
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
   * F-2（中台↔执行器深度审查）：/health/admin-status 的结构化状态（语义解析）。
   *
   * 判据契约（与 executor-node routes/health.ts 的端点注释一一对应）：
   * - `heartbeatStatus === 'ok'`（或等价地 registration==='registered'）→ 在线；
   * - `heartbeatStatus === 'failed'` 或 `registration === 'failed'` → 离线；
   * - `unknown` / 端点不可用 / 字段缺失（旧 bundle）→ **维持现状，不降级**
   *   （启动早期从未成功过心跳是正常态，不得据此把托盘打回 offline）。
   *
   * 旧实现只靠日志文本匹配（inferStatusFromLog），executor-node 侧日志文案
   * 一经 i18n/重构即静默失效——托盘显示「在线」但执行器实际已离线。结构化
   * 端点优先；日志推断保留为旧内嵌 bundle 的降级回退（双通道互为保险）。
   */
  private applyAdminStatus(
    data:
      | {
          registration?: string;
          heartbeatStatus?: string;
          lastHeartbeatTime?: string | null;
          adminApiReachable?: boolean | null;
        }
      | undefined
      | null,
  ): void {
    if (!data || typeof data !== 'object') return;
    if (data.heartbeatStatus === 'ok') {
      this.adminRegistration = 'registered';
    } else if (
      data.heartbeatStatus === 'failed' ||
      data.registration === 'failed'
    ) {
      this.adminRegistration = 'failed';
    }
    // 'unknown' / 字段缺失 → 维持现状（不降级、不越权断言在线）。
  }

  /**
   * 探测本地执行器的 /health/admin-status（结构化 admin 连通性视图）。
   * 成功解析出有效形状时返回数据；端点 404（旧 bundle）或任何失败返回 null，
   * 由调用方回退到日志推断通道。
   */
  private fetchAdminStatus(
    port: number,
  ): Promise<{
    registration?: string;
    heartbeatStatus?: string;
    lastHeartbeatTime?: string | null;
    adminApiReachable?: boolean | null;
  } | null> {
    return new Promise((resolve) => {
      const httpMod = require('http') as typeof import('http');
      const req = httpMod.get(
        { hostname: '127.0.0.1', port, path: '/health/admin-status', timeout: 3000 },
        (res) => {
          res.resume();
          if (!res.statusCode || res.statusCode >= 400) {
            resolve(null);
            return;
          }
          let raw = '';
          res.on('data', (c: Buffer) => {
            raw += c.toString();
          });
          res.on('end', () => {
            try {
              const parsed = JSON.parse(raw) as Record<string, unknown>;
              resolve(
                typeof parsed === 'object' && parsed !== null
                  ? (parsed as {
                      registration?: string;
                      heartbeatStatus?: string;
                      lastHeartbeatTime?: string | null;
                      adminApiReachable?: boolean | null;
                    })
                  : null,
              );
            } catch {
              resolve(null);
            }
          });
        },
      );
      req.on('error', () => resolve(null));
      req.on('timeout', () => {
        req.destroy();
        resolve(null);
      });
    });
  }

  /**
   * Start polling executor-node's /health/live endpoint. This is a
   * liveness signal only: R23 — a passing poll must not override a known
   * admin-registration failure (see adminRegistration / applyAdminStatus).
   * F-2: 每轮同时拉取 /health/admin-status 结构化状态并优先采用。
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
        // F-2: 结构化 admin 状态优先（端点 404/超时 → null → 回退日志推断）
        const adminStatus = await this.fetchAdminStatus(port);
        if (gen !== this.healthPollGen) return;
        this.applyAdminStatus(adminStatus);

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
          // tray must show offline until a success signal clears the flag.
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
   * `adminRegistration`. F-2: 结构化 /health/admin-status 端点已是主判据；
   * 本方法降级为旧 bundle 的**回退通道**（端点 404/不可用时的兜底），日志
   * 文案演进不再承担状态判定的唯一职责。语义保持：'online' 由 admin 面
   * 心跳结果决定，而非本地 liveness 单独决定。
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

  /**
   * NETOPT-2⑦: 单行交付点（LineSplitter 的回调）。日志格式与旧实现逐字一致
   * （stdout → log.info `[executor] …`，stderr → log.warn `[executor:err] …`），
   * 差别只在「按行」而非「按 chunk」。
   */
  private emitChildLine(line: string, isErr: boolean): void {
    if (isErr) {
      log.warn(`[executor:err] ${line.trim()}`);
    } else {
      log.info(`[executor] ${line.trim()}`);
    }
    this.handleChildOutput(line, isErr);
  }

  private broadcastLog(line: string): void {
    BrowserWindow.getAllWindows().forEach((win) => {
      if (!win.isDestroyed()) {
        win.webContents.send('executor:log-line', line);
      }
    });
  }

  /**
   * 6-1（audit-r4）：结构化解析子进程输出。
   *
   * executor-node 在 LOG_FORMAT=json 下输出单行 JSON 日志（logger.ts 的
   * json 格式：timestamp/level/message + 元字段 + traceId）。旧实现只把
   * 输出原样 pipe 进日志文件，错误分类完全依赖人工读文本。这里对 JSON 行
   * 做无副作用解析：
   *   - 解析成功 → 额外广播 `executor:log-structured` 结构化事件（渲染层可
   *     按级别/字段渲染，设置页日志面无需再 regex 猜级别）；
   *   - 解析失败（文本行/截断）→ 走既有文本通道，行为与旧版逐字节一致。
   * 文本推断（inferStatusFromLog）不受影响——结构化通道只是加量，不改判据。
   */
  private handleChildOutput(line: string, isErr: boolean): void {
    const trimmed = line.trim();
    if (trimmed) {
      this.broadcastLog(line);
      this.inferStatusFromLog(line);
      if (trimmed.startsWith('{')) {
        try {
          const parsed = JSON.parse(trimmed) as Record<string, unknown>;
          if (parsed && typeof parsed === 'object') {
            BrowserWindow.getAllWindows().forEach((win) => {
              if (!win.isDestroyed()) {
                win.webContents.send('executor:log-structured', {
                  ...parsed,
                  channel: isErr ? 'stderr' : 'stdout',
                });
              }
            });
          }
        } catch {
          // 非 JSON（文本行/部分块）：走既有文本通道，行为不变。
        }
      }
    }
  }
}
