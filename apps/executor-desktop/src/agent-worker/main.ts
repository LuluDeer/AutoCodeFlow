/**
 * N-06①：Agent 托管 worker——07 §4.2「Agent 以独立子进程形式运行」的完整形态。
 *
 * 主进程（agent-worker-process.ts）以 `process.execPath` + `ELECTRON_RUN_AS_NODE=1`
 * spawn 本文件（esbuild 单文件 bundle，见 scripts/bundle-agent-worker.cjs），
 * 避免重计算/长任务占用 Electron 主进程（07 §4.2 原始动机；此前 host 本体
 * 以主进程内组件运行的阶段性取舍在此收口）。
 *
 * 通道契约（见 agent-worker-protocol.ts）：
 *   stdout = JSON 行协议（唯一用途，禁止打印任何其他内容）
 *   stderr = 日志（自由文本，主进程转发 electron-log）
 *
 * 职责切分（与旧主进程内实现逐条对齐）：
 *   · 定时器节奏仍由主进程驱动（tick 消息），语义不变——host.tick 恒 0 等待。
 *   · 配置热更新：主进程 config:save 后推 config 消息，worker 缓存最新值；
 *     host 的 getConfig 闭包读缓存——「设置页改完即生效」语义保持。
 *   · single-flight：主进程 agentTickPromise 之外，worker 侧再挡一层
 *     （协议重复投递不并发跑两个指派——旧实现在 host.tick 内部的保证）。
 *   · 身份替换：主进程 withdraw → shutdown；worker 等当前指派跑完再退出
 *     （旧实现 host 对象在内存里自然跑完，语义等价；journal running 阶段的
 *     崩溃恢复让硬杀也安全——应用退出即硬杀路径）。
 */

import * as fs from 'fs';
import * as path from 'path';
import { createInterface } from 'readline';
import { AgentHost, type AgentHostConfig, type AgentHostStats } from '../main/agent/agent-host';
import { CollabClient } from '../main/agent/collab-client';
import { killInFlightTreesSync, sweepStaleTrialTrees } from '../main/agent/kill-tree';
import { AGENT_WORKSPACE_DIRNAME } from '../main/agent/workspace';
import {
  parseAgentWorkerRequest,
  type AgentWorkerRequest,
  type AgentWorkerStats,
} from '../main/agent-worker-protocol';

/** stdout 只承载协议：把 console 全部劫持到 stderr，防库的偶发打印毒化协议流。 */
for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
  // eslint-disable-next-line no-console
  console[level] = (...args: unknown[]) => {
    process.stderr.write(`[worker-console.${level}] ${args.map(String).join(' ')}\n`);
  };
}

function send(msg: unknown): void {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

function workerLog(line: string): void {
  process.stderr.write(`[agent-worker] ${line}\n`);
}

/** packageRoot 契约自检（bundle 布局：__dirname=dist/，两个 JSON 在上一级）。 */
function checkPlaywrightContract(): { browsersJson: boolean } {
  try {
    const packageRoot = path.join(__dirname, '..');
    fs.accessSync(path.join(packageRoot, 'browsers.json'), fs.constants.R_OK);
    return { browsersJson: true };
  } catch {
    return { browsersJson: false };
  }
}

let cachedConfig: AgentHostConfig | null = null;
let host: AgentHost | null = null;
let tickInFlight = false;
let shuttingDown = false;

function ensureHost(req: Extract<AgentWorkerRequest, { t: 'init' }>): void {
  // P2-4：启动即清扫上一次 worker 死亡（SIGKILL 硬杀/崩溃）遗留的孤儿试跑树。
  // best-effort：仅 Linux（/proc/<pgid>/cmdline 归属校验防 pid 复用误杀）；
  // Windows 的 Job Object 注入形态未实现（登记于 kill-tree.ts 头注）。
  try {
    const swept = sweepStaleTrialTrees(path.join(req.workDir, AGENT_WORKSPACE_DIRNAME), workerLog);
    if (swept > 0) workerLog(`startup sweep: killed ${swept} orphan trial tree(s) from previous worker`);
  } catch { /* 清扫失败不阻塞启动——下一轮试跑/闸门仍是主防线 */ }
  cachedConfig = req.config;
  if (host) return; // init 幂等：重复 init 不重建（主进程不会发，防御性保留）
  host = new AgentHost({
    address: req.address,
    workDir: req.workDir,
    // 配置热更新语义：读的是缓存最新值，主进程 config:save 后推送
    getConfig: () => cachedConfig as AgentHostConfig,
    client: new CollabClient({
      baseUrl: req.config.adminApiUrl,
      // 主进程已在 init 前解密（enc: 信封不落 worker 协议之外的面）
      token: req.config.executorToken,
    }),
  });
  workerLog(`host created (address=${req.address}, workDir=${req.workDir})`);
}

function pushStats(): void {
  if (!host) return;
  const stats: AgentHostStats = { ...host.stats };
  const msg: AgentWorkerStats = { t: 'stats', stats };
  send(msg);
}

/**
 * P2-4：worker 退出前的统一收口——先杀在飞试跑树再退。
 * 试跑是 detached 进程组（组杀的前提），worker 一死它的超时定时器就没了，
 * 不在这里补杀 = 孤儿树存活到永久。SIGKILL 硬杀路径无法拦截（OS 语义），
 * 那部分由启动清扫（sweepStaleTrialTrees）兜底。
 */
function exitWorker(code: number): void {
  try {
    const killed = killInFlightTreesSync();
    if (killed > 0) workerLog(`exit: killed ${killed} in-flight trial tree(s) before exit`);
  } catch { /* 退出路径上尽力而为 */ }
  process.exit(code);
}

/** 等当前指派跑完再退出（身份替换的优雅收尾；journal 让硬杀同样安全）。 */
function shutdownWhenIdle(): void {
  if (shuttingDown) return;
  shuttingDown = true;
  const wait = () => {
    if (!host || !host.stats.working) {
      workerLog('idle → exit(0)');
      exitWorker(0);
    }
    setTimeout(wait, 1_000).unref?.();
  };
  wait();
}

function handleRequest(req: AgentWorkerRequest): void {
  switch (req.t) {
    case 'init':
      ensureHost(req);
      pushStats();
      return;
    case 'config':
      // 身份字段（baseUrl/token/address/workDir）变化必须走主进程的
      // replace（杀 worker 重建）——这里只接受同身份下的档位/开关热更新。
      cachedConfig = req.config;
      return;
    case 'tick': {
      if (!host) {
        workerLog('tick before init — ignored');
        return;
      }
      if (tickInFlight) {
        // 与旧 host.tick 内部 single-flight 同语义：跳过而不是排队。
        send({ t: 'tick-result', worked: false, detail: 'single-flight: already working' });
        return;
      }
      tickInFlight = true;
      host.tick()
        .then((result) => {
          send({ t: 'tick-result', worked: result.worked, ...(result.detail !== undefined ? { detail: result.detail } : {}) });
        })
        .catch((err: unknown) => {
          // AgentHost.tick 理论上不抛（全部收敛进结果/回报）；兜底如实上报。
          send({ t: 'tick-result', worked: false, detail: `worker tick error: ${err instanceof Error ? err.message : String(err)}` });
        })
        .finally(() => {
          tickInFlight = false;
          pushStats();
        });
      return;
    }
    case 'withdraw':
      if (!host) return;
      // P3-4：working 时 withdrawCapabilities 只登记 withdrawAfterWork——真正的
      // 撤权发生在指派终态回报之后的 finally。此刻回执 withdraw-done 仅代表
      // 「登记成功」，撤权存在一个残窗；能力租约（runWithJournal 的 30s 续报
      // 定时器）+ finally 撤权保证最迟一个租约周期内生效，残窗自愈。协议不扩
      // 展字段（N-06 契约不动），残窗以日志如实登记。
      if (host.stats.working) {
        workerLog('withdraw deferred: assignment in flight — capability lease ≤30s, withdrawn at terminal report');
      }
      host.withdrawCapabilities()
        .then(() => send({ t: 'withdraw-done' }))
        .catch((err: unknown) => workerLog(`withdraw failed: ${err instanceof Error ? err.message : String(err)}`))
        .finally(() => pushStats());
      return;
    case 'shutdown':
      shutdownWhenIdle();
      return;
  }
}

function main(): void {
  const rl = createInterface({ input: process.stdin, terminal: false });
  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    const req = parseAgentWorkerRequest(trimmed);
    if (!req) {
      // P3-1：畸形请求不回显载荷（可能含 token 的 config 会被整行回显进日志）
      // ——记长度即可定位流量异常，内容绝不落日志。
      workerLog(`malformed request dropped (len=${trimmed.length})`);
      return;
    }
    try {
      handleRequest(req);
    } catch (err) {
      workerLog(`handler error on ${req.t}: ${err instanceof Error ? err.message : String(err)}`);
    }
  });
  rl.on('close', () => {
    // 主进程退出/管道断开——立即退出，不等待（应用退出是硬杀语义；
    // 指派中断由 journal running 阶段恢复，与崩溃一致）。
    // P2-4：退出前先杀在飞试跑树（detached 组不会随父进程死）。
    exitWorker(0);
  });
  process.on('SIGTERM', () => exitWorker(0));
  process.on('SIGINT', () => exitWorker(0));
  // worker 自身未捕获异常：立即退出（主进程按意外退出处理并自愈重启），
  // 绝不带病吞掉——host 的错误收敛只覆盖指派处理面。
  process.on('uncaughtException', (err) => {
    workerLog(`uncaught exception: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
    exitWorker(1);
  });

  send({ t: 'ready', playwrightContract: checkPlaywrightContract() });
  // working 状态的推流：处理期间 stats 会中途变化（working/lastOutcome），
  // 主进程托盘 2s 轮询快照——这里 1s 差量推一次，主进程零变化即不重建菜单。
  setInterval(() => pushStats(), 1_000).unref?.();
}

main();
