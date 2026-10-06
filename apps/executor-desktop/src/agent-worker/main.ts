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

/** 等当前指派跑完再退出（身份替换的优雅收尾；journal 让硬杀同样安全）。 */
function shutdownWhenIdle(): void {
  if (shuttingDown) return;
  shuttingDown = true;
  const wait = () => {
    if (!host || !host.stats.working) {
      workerLog('idle → exit(0)');
      process.exit(0);
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
      workerLog(`malformed request dropped: ${trimmed.slice(0, 120)}`);
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
    process.exit(0);
  });
  process.on('SIGTERM', () => process.exit(0));
  process.on('SIGINT', () => process.exit(0));
  // worker 自身未捕获异常：立即退出（主进程按意外退出处理并自愈重启），
  // 绝不带病吞掉——host 的错误收敛只覆盖指派处理面。
  process.on('uncaughtException', (err) => {
    workerLog(`uncaught exception: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
    process.exit(1);
  });

  send({ t: 'ready', playwrightContract: checkPlaywrightContract() });
  // working 状态的推流：处理期间 stats 会中途变化（working/lastOutcome），
  // 主进程托盘 2s 轮询快照——这里 1s 差量推一次，主进程零变化即不重建菜单。
  setInterval(() => pushStats(), 1_000).unref?.();
}

main();
