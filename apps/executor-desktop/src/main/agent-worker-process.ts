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
import { DEFAULT_GATE_LIMITS } from './agent/gates';
import type { AgentHostConfig, AgentHostStats } from './agent/agent-host';
import {
  parseAgentWorkerEvent,
  parseAgentWorkerRequest,
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

/**
 * B：tick 看门狗的等待上限。取值理由（不拍脑袋）：
 *  - 一轮 tick 的**合法**耗时上限就是单指派墙钟上限——闸门
 *    （agent/gates.ts 的 DEFAULT_GATE_LIMITS.maxWallClockMs）到点才终止，
 *    低于它就会把正在跑长指派的健康 worker 误杀；
 *  - 再加 15 分钟收尾余量（终态上报、浏览器清理、下一次轮询窗口）。
 * 更高的值只是让卡死的 worker 多空转，没有收益；更低的值会制造假阳性。
 * 复用闸门常量而不是照抄 "2h" 字面量：闸门上限一旦调整，看门狗自动跟随
 * （否则 4h 上限的合法指派会被 2h 的看门狗杀掉）。
 */
const TICK_WATCHDOG_MS = DEFAULT_GATE_LIMITS.maxWallClockMs + 15 * 60 * 1000;

/** P3-1：死管道日志的安全形态——只提取消息类型，绝不记载荷（config 消息
 * 携带 executorToken，任何截断长度都可能把凭据前缀写进日志）。 */
function deadLineType(line: string): string {
  return parseAgentWorkerRequest(line)?.t ?? 'unparseable';
}

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
  /**
   * B：tick 看门狗覆盖值（毫秒）。生产不传（用 TICK_WATCHDOG_MS）；
   * selftest 注入缩短值，否则一个用例要跑 2 小时。
   */
  tickTimeoutMs?: number;
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
  /** B：tick 看门狗句柄（tick 落定 / worker 退出时清除，见 armTickWatchdog）。 */
  private tickWatchdog: NodeJS.Timeout | null = null;
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
    // PIPE-EPIPE（2026-10-27 审计轮 #7）：stdin 必须挂 'error' 监听。
    //
    // 竞态：worker 退出（崩溃自愈重启 / shutdown 超时 SIGKILL）与 30s 一次的
    // tick 写管道之间没有任何同步——`child.stdin` 此时仍是 writable，write()
    // 落在一个已断开的管道上，Node 按 EventEmitter 语义**同步 emit 'error'**；
    // 没有监听者时它变成 uncaughtException → index.ts 的 crash-guard 弹
    // 「重启即可恢复」并**退出整个桌面端**。一次 worker 自愈竞态就此被放大成
    // "应用自己关了"（用户视角：RPA 客户端莫名退出）。
    // 照抄同仓先例 gui-windows.ts:319（那里的 GUI 脚本管道已有同样的监听）。
    // 语义：管道断开是"worker 没了"，由 exit 回调与下次 tick 自愈处理，
    // 这里只需要不让它升级成进程级异常。
    child.stdin?.on('error', () => undefined);
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
      // B：写出去之后立刻挂看门狗——writeLine 在管道已断时只落日志不发数据，
      // 那种情况下 tickPending 同样会永远悬着，看门狗一并兜住。
      this.armTickWatchdog();
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

  /**
   * B：给在飞的 tick 挂看门狗。
   *
   * 故障形态：worker 活着、也收到了 tick，但**不回 tick-result**（stdin 半死、
   * worker 主循环卡死、浏览器子进程把事件循环堵住）。旧实现里 tickPending
   * 永不落定 ⇒ 本 handle 恒为 single-flight ⇒ index.ts 的 agentTickPromise
   * 永不清空 ⇒ 后续 tick 全被跳过：托管永久空转；身份状态机看到
   * tickInFlight 恒真，换 token / 改 workDir / 关 agentEnabled 全部永久
   * defer ⇒ 旧 worker 继续用旧身份收单（安全面）。
   *
   * 处理：让 tickPending **落定**为超时形态（不 reject——调用链上没有人为它
   * 挂 catch，reject 会变成 unhandled rejection 杀掉主进程），再 kill worker；
   * 下一次 tick 走 !alive 分支自愈重启（init 带最新配置＝最新身份），身份
   * 状态机随即可以 replace。日志只记超时毫秒数，不记任何载荷（与 deadLineType
   * 同一条纪律）。
   */
  private armTickWatchdog(): void {
    this.clearTickWatchdog();
    const timeoutMs = this.deps.tickTimeoutMs ?? TICK_WATCHDOG_MS;
    const timer = setTimeout(() => {
      this.tickWatchdog = null;
      const resolve = this.tickPending;
      // tick-result 恰好在这一刻到达：清理竞态的残余回调不得误杀 worker。
      if (!resolve) return;
      this.tickPending = null;
      this.deps.log.error(
        `[agent-worker] tick watchdog fired after ${timeoutMs}ms without tick-result — killing worker`,
      );
      resolve({ worked: false, detail: `tick timeout after ${timeoutMs}ms (worker killed)` });
      this.kill();
    }, timeoutMs);
    timer.unref?.();
    this.tickWatchdog = timer;
  }

  private clearTickWatchdog(): void {
    if (this.tickWatchdog) {
      clearTimeout(this.tickWatchdog);
      this.tickWatchdog = null;
    }
  }

  private writeLine(line: string): void {
    if (!this.alive) {
      // P3-1：死管道日志只记消息类型，不记载荷——载荷可能携带 executorToken
      // （config 消息全量下发，token 在前 80 字符内），截断日志等于把凭据
      // 前缀写进 electron-log。
      this.deps.log.warn(`[agent-worker] write while dead: t=${deadLineType(line)}`);
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
        this.clearTickWatchdog();
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
    this.clearTickWatchdog();
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
