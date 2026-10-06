/**
 * N-06①：agent-worker 子进程的托管 handle（主进程侧）。
 *
 * 与 executor-process.ts（executor-node 托管）同姿态，但协议面小得多：
 * worker 无 HTTP 面、无端口、无心跳探针——主进程的 30s 定时器直接驱动 tick，
 * 状态经 stats 消息差量回推。本模块零 electron import（spawn 入口与环境由
 * 调用方经 resolveAgentWorkerEntry / buildAgentWorkerSpawnEnv 注入，见
 * agent-worker-paths.ts），selftest 可在裸 node 下跑真协议。
 *
 * 生命周期语义（逐条对齐旧主进程内 AgentHost 的行为）：
 *   · 意外退出：清空在飞请求（tick 如实返回 failed detail），标记 dead；
 *     下一次 tick 自愈重启（init 带最新配置）。journal 的 running 阶段恢复
 *     保证重领不丢预算——与进程内崩溃恢复同源。
 *   · 身份替换：调用方先 withdraw（worker 沿用 AgentHost 的 working 延后
 *     语义）再 shutdownWhenIdle（等当前指派跑完自行 exit）。
 *   · 应用退出：kill()（SIGKILL 兜底）——中断的指派由 journal 恢复。
 */

import { spawn, type ChildProcess } from 'child_process';
import { LineSplitter } from './child-line-splitter';
import type { AgentHostConfig, AgentHostStats } from './agent/agent-host';
import {
  parseAgentWorkerEvent,
  type AgentWorkerReady,
} from './agent-worker-protocol';

/** 注入的日志面（生产为 electron-log；selftest 可换 console 静音桩）。 */
export interface AgentWorkerLogger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

/** shutdownWhenIdle 后仍未退出的兜底上限——超过任何闸门预算（单指派时长
 * 上限按 GateLimits 面收敛），到点强杀并记日志，绝不留下僵尸 worker。 */
const SHUTDOWN_IDLE_KILL_AFTER_MS = 2 * 60 * 60 * 1000;

export interface AgentWorkerHandleDeps {
  address: string;
  workDir: string;
  /** 最新配置快照；refreshConfig 更新它，(重)spawn 时随 init 下发。 */
  config: AgentHostConfig;
  /** resolveAgentWorkerEntry 的产物（bundle 入口绝对路径）。 */
  entryPath: string;
  /** buildAgentWorkerSpawnEnv 的产物（含 ELECTRON_RUN_AS_NODE 等）。 */
  spawnEnv: NodeJS.ProcessEnv;
  log: AgentWorkerLogger;
  /** stats 差量到达回调（index.ts 据此刷新托盘，不必等 2s 轮询）。 */
  onStats?: (stats: AgentHostStats) => void;
  /** 意外退出回调（托管链诊断用；自愈由 tick 驱动，这里只通知）。 */
  onUnexpectedExit?: (info: { code: number | null; signal: NodeJS.Signals | null }) => void;
}

const IDLE_STATS: AgentHostStats = {
  working: false,
  lastAssignmentId: null,
  lastOutcome: null,
  processed: 0,
  lastEffectiveProfile: null,
};

export class AgentWorkerHandle {
  private readonly deps: AgentWorkerHandleDeps;
  private child: ChildProcess | null = null;
  private readySettle: { resolve: (v: AgentWorkerReady) => void; reject: (e: Error) => void } | null = null;
  private readyPromise: Promise<AgentWorkerReady> | null = null;
  private tickPending: ((result: { worked: boolean; detail?: string }) => void) | null = null;
  private withdrawPending: (() => void) | null = null;
  private shutdownKillTimer: NodeJS.Timeout | null = null;
  private intentionalStop = false;
  private ownStats: AgentHostStats = { ...IDLE_STATS };

  constructor(deps: AgentWorkerHandleDeps) {
    this.deps = deps;
  }

  /** worker 是否存活（spawn 过且未退出）。 */
  get alive(): boolean {
    return this.child !== null && this.child.exitCode === null && this.child.signalCode === null;
  }

  /** 最近一次 worker 上报的托管状态快照（worker 死后保留最后读数）。 */
  get stats(): AgentHostStats {
    return this.ownStats;
  }

  /** 启动（幂等：已存活即返回既有 ready promise）。 */
  start(): Promise<AgentWorkerReady> {
    if (this.alive && this.readyPromise) return this.readyPromise;
    this.intentionalStop = false;
    if (this.child) {
      // 上一次的退出回调可能还挂着——先摘除，避免旧 exit 误报意外退出。
      this.child.removeAllListeners();
      this.child = null;
    }
    this.ownStats = { ...IDLE_STATS };
    const child = spawn(process.execPath, [this.deps.entryPath], {
      env: this.deps.spawnEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;
    this.readyPromise = new Promise<AgentWorkerReady>((resolve, reject) => {
      this.readySettle = { resolve, reject };
      child.once('error', reject);
      child.once('exit', () => reject(new Error('[agent-worker] exited before ready')));
    });
    // spawn 路径（syncAgentHostWithConfig）不 await ready——提前挂 catch
    // 防 unhandled rejection；tick() 等待方仍能拿到同一个 rejection。
    this.readyPromise.catch(() => undefined);
    const settle = this.readySettle;
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    const stdoutSplit = new LineSplitter((line) => this.onProtocolLine(line, this.readySettle));
    child.stdout?.on('data', (chunk: string) => stdoutSplit.feed(chunk));
    child.stdout?.on('end', () => stdoutSplit.flush());
    const stderrSplit = new LineSplitter((line) => {
      if (line.trim()) this.deps.log.info(`[agent-worker] ${line}`);
    });
    child.stderr?.on('data', (chunk: string) => stderrSplit.feed(chunk));
    child.stderr?.on('end', () => stderrSplit.flush());
    child.once('exit', (code, signal) => this.onExit(code, signal));
    // init 立即下发——同一管道有序，worker 必然先发 ready 再处理 init，
    // 主进程不必等 ready 也可以安全发送。
    this.writeLine(JSON.stringify({
      t: 'init',
      address: this.deps.address,
      workDir: this.deps.workDir,
      config: this.deps.config,
    }));
    return this.readyPromise;
  }

  /** 配置热更新（config:save 后调用；worker 死时只更新快照，随下次 spawn 生效）。 */
  refreshConfig(config: AgentHostConfig): void {
    this.deps.config = config;
    if (this.alive) {
      this.writeLine(JSON.stringify({ t: 'config', config }));
    }
  }

  /**
   * 停用语义（关闭开关 / 身份替换共用）：等效旧实现的 getConfig 实时失配——
   * 先把 agentEnabled=false 下发给 worker（否则指派终态的 finally 撤权会因
   * 缓存配置仍为 true 而被跳过，能力残留中台），再撤权（working 延后），
   * 最后等空闲退出。handle 保留（dead 态），同身份再启用时 tick 自愈重启。
   */
  async disableAndStopAfterWork(): Promise<void> {
    const disabled: AgentHostConfig = { ...this.deps.config, agentEnabled: false };
    this.deps.config = disabled;
    if (this.alive) {
      this.writeLine(JSON.stringify({ t: 'config', config: disabled }));
    }
    await this.withdraw();
    await this.shutdownWhenIdle();
  }

  /**
   * 跑一轮托管。worker 已死则先自愈重启；已在飞行中返回 single-flight 语义
   * （与旧 host.tick 内部保证一致：跳过而不是排队）。
   */
  async tick(): Promise<{ worked: boolean; detail?: string }> {
    if (this.tickPending) return { worked: false, detail: 'single-flight: already working' };
    if (!this.alive) {
      try {
        await this.start();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.deps.log.error(`[agent-worker] respawn failed: ${msg}`);
        return { worked: false, detail: `worker respawn failed: ${msg}` };
      }
    }
    return new Promise((resolve) => {
      this.tickPending = resolve;
      this.writeLine(JSON.stringify({ t: 'tick' }));
    });
  }

  /** 撤销 Agent 能力（working 时由 worker 侧延后到指派终态之后）。 */
  async withdraw(): Promise<void> {
    if (!this.alive) return;
    return new Promise((resolve) => {
      this.withdrawPending = resolve;
      this.writeLine(JSON.stringify({ t: 'withdraw' }));
    });
  }

  /** 身份替换的优雅收尾：等当前指派跑完 worker 自行退出；超时强杀兜底。 */
  async shutdownWhenIdle(): Promise<void> {
    if (!this.alive) return;
    const child = this.child!;
    this.writeLine(JSON.stringify({ t: 'shutdown' }));
    this.shutdownKillTimer = setTimeout(() => {
      if (this.child === child && child.exitCode === null) {
        this.deps.log.warn('[agent-worker] shutdown idle timeout — killing worker');
        this.intentionalStop = true;
        child.kill('SIGKILL');
      }
    }, SHUTDOWN_IDLE_KILL_AFTER_MS);
    this.shutdownKillTimer.unref?.();
    await new Promise<void>((resolve) => child.once('exit', () => resolve()));
  }

  /** 硬杀（应用退出路径）。 */
  kill(): void {
    this.intentionalStop = true;
    if (this.shutdownKillTimer) {
      clearTimeout(this.shutdownKillTimer);
      this.shutdownKillTimer = null;
    }
    if (this.alive) this.child!.kill('SIGKILL');
  }

  private writeLine(line: string): void {
    if (!this.alive) {
      this.deps.log.warn(`[agent-worker] write while dead: ${line.slice(0, 80)}`);
      return;
    }
    this.child!.stdin?.write(`${line}\n`);
  }

  private onProtocolLine(
    line: string,
    readySettle: { resolve: (v: AgentWorkerReady) => void; reject: (e: Error) => void } | null,
  ): void {
    if (!line.trim()) return;
    const event = parseAgentWorkerEvent(line);
    if (!event) {
      this.deps.log.warn(`[agent-worker] malformed event dropped: ${line.slice(0, 120)}`);
      return;
    }
    switch (event.t) {
      case 'ready': {
        if (readySettle) {
          const resolve = readySettle.resolve;
          this.readySettle = null;
          this.readyPromise = null;
          resolve(event);
        }
        this.deps.log.info(`[agent-worker] ready (browsers.json readable=${event.playwrightContract.browsersJson})`);
        return;
      }
      case 'tick-result': {
        const resolve = this.tickPending;
        this.tickPending = null;
        resolve?.({ worked: event.worked, ...(event.detail !== undefined ? { detail: event.detail } : {}) });
        return;
      }
      case 'withdraw-done': {
        const resolve = this.withdrawPending;
        this.withdrawPending = null;
        resolve?.();
        return;
      }
      case 'stats': {
        this.ownStats = event.stats;
        this.deps.onStats?.(event.stats);
        return;
      }
      case 'log':
        // 预留通道；当前 worker 日志走 stderr 直通。
        this.deps.log[event.level](`[agent-worker] ${event.line}`);
        return;
    }
  }

  private onExit(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.shutdownKillTimer) {
      clearTimeout(this.shutdownKillTimer);
      this.shutdownKillTimer = null;
    }
    const wasReady = this.readyPromise === null;
    this.child = null;
    this.readyPromise = null;
    this.readySettle = null;
    // 在飞请求收敛：tick 如实失败，withdraw 放行（能力残留由下一轮
    // advertise/withdraw 自愈——与旧实现的进程内崩溃语义一致）。
    if (this.tickPending) {
      const resolve = this.tickPending;
      this.tickPending = null;
      resolve({ worked: false, detail: 'worker exited during tick' });
    }
    if (this.withdrawPending) {
      const resolve = this.withdrawPending;
      this.withdrawPending = null;
      resolve();
    }
    if (this.intentionalStop) return;
    this.deps.log.error(`[agent-worker] unexpected exit (code=${code}, signal=${signal}, wasReady=${wasReady})`);
    this.deps.onUnexpectedExit?.({ code, signal });
  }
}
