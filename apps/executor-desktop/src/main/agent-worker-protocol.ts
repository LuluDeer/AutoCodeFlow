/**
 * N-06①：agent-worker 主进程 ↔ 子进程的 stdio JSON 行协议（纯类型 + 收口守卫）。
 *
 * 通道约定：**stdout 只承载协议**（一行一个 JSON）；stderr 承载 worker 日志
 * （自由文本，主进程转发进 electron-log）。任何一端不得向 stdout 打印非协议
 * 内容——库的偶发 console.log 会毒化协议流，worker 侧统一在入口拦 console。
 *
 * 消息方向：
 *   主 → worker：init / config / tick / withdraw / shutdown
 *   worker → 主：ready / tick-result / withdraw-done / stats / log
 *
 * 纪律：解析走 fail-closed——畸形消息丢弃并回 log，绝不带病进入状态机
 * （同 gui.ts 的动作消毒哲学）。
 */

import type { AgentHostConfig, AgentHostStats } from './agent/agent-host';

/** 主 → worker：创建托管（首个 tick 前必须先到）。 */
export interface AgentWorkerInit {
  t: 'init';
  /** 执行器地址（poll/report 的 body.address 双标识）。 */
  address: string;
  /** Agent 沙箱工作区根。 */
  workDir: string;
  /** 托管配置（executorToken 已在主进程解密为明文——CollabClient 的 Bearer）。 */
  config: AgentHostConfig;
}

/** 主 → worker：配置热更新（config:save 后推送；worker 缓存，host 经 getConfig 读）。 */
export interface AgentWorkerConfigUpdate {
  t: 'config';
  config: AgentHostConfig;
}

/** 主 → worker：跑一轮托管（单飞行由主进程 agentTickPromise 与 worker 双侧保证）。 */
export interface AgentWorkerTick {
  t: 'tick';
}

/** 主 → worker：撤销 Agent 能力（worker 侧沿用 AgentHost 的 working 延后语义）。 */
export interface AgentWorkerWithdraw {
  t: 'withdraw';
}

/**
 * 主 → worker：收尾退出——等当前指派跑完（终态回报 + 能力撤销）再 exit(0)。
 * 仅身份替换用；应用退出走 kill（SIGKILL 兜底），journal 的 running 阶段
 * 恢复语义与崩溃一致。
 */
export interface AgentWorkerShutdown {
  t: 'shutdown';
}

export type AgentWorkerRequest =
  | AgentWorkerInit
  | AgentWorkerConfigUpdate
  | AgentWorkerTick
  | AgentWorkerWithdraw
  | AgentWorkerShutdown;

/** worker → 主：协议握手（主进程等它之后才发 tick）。 */
export interface AgentWorkerReady {
  t: 'ready';
  /** worker 进程内 packageRoot 解析到的 browsers.json 是否可读（诊断用，非闸）。 */
  playwrightContract: { browsersJson: boolean };
}

export interface AgentWorkerTickResult {
  t: 'tick-result';
  worked: boolean;
  detail?: string;
}

export interface AgentWorkerWithdrawDone {
  t: 'withdraw-done';
}

export interface AgentWorkerStats {
  t: 'stats';
  stats: AgentHostStats;
}

/** worker → 主：stderr 日志之外的显式状态行（预留；当前 stderr 直通）。 */
export interface AgentWorkerLog {
  t: 'log';
  level: 'info' | 'warn' | 'error';
  line: string;
}

export type AgentWorkerEvent =
  | AgentWorkerReady
  | AgentWorkerTickResult
  | AgentWorkerWithdrawDone
  | AgentWorkerStats
  | AgentWorkerLog;

/** 解析主进程→worker 的请求；畸形返回 null（调用方丢弃并记日志）。 */
export function parseAgentWorkerRequest(line: string): AgentWorkerRequest | null {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  switch (r.t) {
    case 'init':
      if (typeof r.address !== 'string' || !r.address ||
          typeof r.workDir !== 'string' || !r.workDir ||
          !isAgentHostConfig(r.config)) {
        return null;
      }
      return r as unknown as AgentWorkerInit;
    case 'config':
      return isAgentHostConfig(r.config) ? (r as unknown as AgentWorkerConfigUpdate) : null;
    case 'tick':
      return r as unknown as AgentWorkerTick;
    case 'withdraw':
      return r as unknown as AgentWorkerWithdraw;
    case 'shutdown':
      return r as unknown as AgentWorkerShutdown;
    default:
      return null;
  }
}

/** 解析 worker→主进程的事件；畸形返回 null。 */
export function parseAgentWorkerEvent(line: string): AgentWorkerEvent | null {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  switch (r.t) {
    case 'ready':
      if (!r.playwrightContract || typeof r.playwrightContract !== 'object' ||
          typeof (r.playwrightContract as Record<string, unknown>).browsersJson !== 'boolean') {
        return null;
      }
      return r as unknown as AgentWorkerReady;
    case 'tick-result':
      if (typeof r.worked !== 'boolean') return null;
      if (r.detail !== undefined && typeof r.detail !== 'string') return null;
      return r as unknown as AgentWorkerTickResult;
    case 'withdraw-done':
      return r as unknown as AgentWorkerWithdrawDone;
    case 'stats':
      if (!isAgentHostStats(r.stats)) return null;
      return r as unknown as AgentWorkerStats;
    case 'log':
      if (r.level !== 'info' && r.level !== 'warn' && r.level !== 'error') return null;
      if (typeof r.line !== 'string') return null;
      return r as unknown as AgentWorkerLog;
    default:
      return null;
  }
}

/** AgentHostConfig 的最小形状校验（字段面宽松——host 内部还有权限档位消毒）。 */
function isAgentHostConfig(v: unknown): v is AgentHostConfig {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const c = v as Record<string, unknown>;
  return typeof c.agentEnabled === 'boolean' &&
    typeof c.adminApiUrl === 'string' &&
    typeof c.executorToken === 'string' &&
    !!(c.agent && typeof c.agent === 'object' && !Array.isArray(c.agent));
}

/** AgentHostStats 的形状校验（托盘/状态页消费，字段缺一不可）。 */
export function isAgentHostStats(v: unknown): v is AgentHostStats {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const s = v as Record<string, unknown>;
  return typeof s.working === 'boolean' &&
    (s.lastAssignmentId === null || typeof s.lastAssignmentId === 'string') &&
    (s.lastOutcome === null || typeof s.lastOutcome === 'string') &&
    typeof s.processed === 'number' &&
    (s.lastEffectiveProfile === null || typeof s.lastEffectiveProfile === 'string');
}
