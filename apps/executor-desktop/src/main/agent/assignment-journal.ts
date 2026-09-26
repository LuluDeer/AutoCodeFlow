/**
 * P7d（agent-and-deployment）：指派本地日志——崩溃恢复的最小持久层。
 *
 * ## 它解决什么
 * 两个此前断链的场景（P7c 交接残差）：
 * 1. **澄清回复的持久消费**：执行器发出澄清后进程崩溃/重启，回复随 poll
 *    重发时必须还能找到「当时问了什么、预算用到哪」——回复在落盘并消费
 *    之后才向中台 ACK，确认前的重发靠本日志幂等去重。
 * 2. **崩溃后已领取指派的重领**：running 阶段崩溃后，重启的 host 据此
 *    向中台请求按 id 重发该单（工作区仍在，问答历史与预算计数延续）。
 *
 * ## 纪律
 * - **先落盘后发送**：澄清的幂等键（clientClarificationId）必须先持久化
 *   再发请求——崩溃窗口内重发同键，中台按幂等键去重，不产生第二条澄清。
 * - **写临时文件 + rename**：崩溃不会留下半截 JSON；读侧对坏文件按
 *   「无日志」处理（如实降级，不抛——调用方是轮询循环）。
 * - **不做加密**：日志内容 = 中台下发的 SOP 载荷与问答历史，不含本机
 *   凭据（token 走 config-store 的加密信封，不经过这里）。
 */

import * as fs from 'fs';
import * as path from 'path';
import type { GateCounters } from './gates';
import type { SopPayload } from './runtime';

/** 本地日志目录：<workDir>/agent-journal/。 */
export function journalDirFor(workDir: string): string {
  return path.join(workDir, 'agent-journal');
}

/** 发出过澄清（已落盘待回复）。 */
export interface JournalAsked {
  /** 幂等键（先落盘后发送的前提——崩溃重发同键不产生第二条澄清）。 */
  clientClarificationId: string;
  /** 发送时的预估轮次（中台的权威轮次随回复返回，仅供展示）。 */
  round: number;
  question: string;
}

/** 已消费的澄清回复（按 clarificationId 幂等去重的依据）。 */
export interface JournalReply {
  clarificationId: string;
  clientClarificationId: string | null;
  round: number;
  resolution: 'answered' | 'sop_amended' | 'escalated_to_human';
  answer: string | null;
  newSopVersion: string | null;
}

export interface AssignmentJournal {
  assignmentId: string;
  sop: SopPayload;
  /** running = 循环在跑；awaiting_reply = 已发澄清等中台回复。 */
  phase: 'running' | 'awaiting_reply';
  pendingQuestion: string | null;
  asked: JournalAsked[];
  replies: JournalReply[];
  /**
   * 闸门计数（跨续跑连续）：澄清续跑不重置预算——否则「问一轮→续跑清零」
   * 就是预算规避通道；墙钟自首次迭代起算的纪律在崩溃恢复后依然成立。
   */
  counters: GateCounters | null;
  /** 续跑期间累计的 GUI 动作数（40 上限按指派累计，不随续跑清零）。 */
  guiActionsUsed: number;
  /**
   * 澄清发送失败的原因（null = 已送达或无待发）。非空时 tick 会用**同一个**
   * clientClarificationId 重试——幂等键保证重试不会产生第二条澄清。
   */
  lastSendError: string | null;
  updatedAt: string;
}

/** 超过此时长的日志按陈旧清理——对应工单多半已被中台超时治理收走。 */
export const JOURNAL_STALE_MS = 7 * 24 * 60 * 60 * 1000;

/** assignmentId 来自中台载荷（不可信输入），不得携带路径语义。 */
function safeId(assignmentId: string): string {
  const cleaned = assignmentId.replace(/[^A-Za-z0-9_-]/g, '_');
  return cleaned.length > 0 && cleaned.length <= 128
    ? cleaned
    : cleaned.slice(0, 128) || 'unknown';
}

function journalPath(dir: string, assignmentId: string): string {
  return path.join(dir, `${safeId(assignmentId)}.json`);
}

/** 原子落盘（tmp + rename）：崩溃不产生半截 JSON。写失败如实上抛——调用方决定降级。 */
export function saveAssignmentJournal(dir: string, journal: AssignmentJournal): void {
  fs.mkdirSync(dir, { recursive: true });
  const record: AssignmentJournal = { ...journal, updatedAt: new Date().toISOString() };
  const target = journalPath(dir, journal.assignmentId);
  const tmp = `${target}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(record), 'utf8');
  fs.renameSync(tmp, target);
}

/** 读取指派日志；不存在/损坏按 null 处理（恢复语义：没有历史就当首跑）。 */
export function loadAssignmentJournal(dir: string, assignmentId: string): AssignmentJournal | null {
  try {
    const raw = fs.readFileSync(journalPath(dir, assignmentId), 'utf8');
    const parsed = JSON.parse(raw) as AssignmentJournal;
    if (!parsed || typeof parsed !== 'object' || parsed.assignmentId !== assignmentId) return null;
    if (parsed.phase !== 'running' && parsed.phase !== 'awaiting_reply') return null;
    if (!parsed.sop || typeof parsed.sop !== 'object' || !parsed.sop.contentHash) return null;
    return {
      ...parsed,
      asked: Array.isArray(parsed.asked) ? parsed.asked : [],
      replies: Array.isArray(parsed.replies) ? parsed.replies : [],
      guiActionsUsed: typeof parsed.guiActionsUsed === 'number' ? parsed.guiActionsUsed : 0,
      lastSendError: typeof parsed.lastSendError === 'string' ? parsed.lastSendError : null,
    };
  } catch {
    return null;
  }
}

/** 列出全部日志（崩溃恢复的扫描入口），损坏条目跳过。 */
export function listAssignmentJournals(dir: string): AssignmentJournal[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const out: AssignmentJournal[] = [];
  for (const name of names) {
    if (!name.endsWith('.json') || name.endsWith('.tmp')) continue;
    const id = name.slice(0, -'.json'.length);
    const j = loadAssignmentJournal(dir, id);
    if (j) out.push(j);
  }
  return out;
}

/** 终态（delivered/failed/escalated…）后清理；不存在时静默。 */
export function clearAssignmentJournal(dir: string, assignmentId: string): void {
  try {
    fs.rmSync(journalPath(dir, assignmentId), { force: true });
  } catch {
    /* 清理失败无害——陈旧日志由 pruneStaleJournals 兜底 */
  }
}

/** 清理超时长的陈旧日志，返回被清理的 assignmentId 列表。 */
export function pruneStaleJournals(dir: string, now: number = Date.now()): string[] {
  const pruned: string[] = [];
  for (const j of listAssignmentJournals(dir)) {
    const t = new Date(j.updatedAt).getTime();
    if (Number.isFinite(t) && now - t >= JOURNAL_STALE_MS) {
      clearAssignmentJournal(dir, j.assignmentId);
      pruned.push(j.assignmentId);
    }
  }
  return pruned;
}
