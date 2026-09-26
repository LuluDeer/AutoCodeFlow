/**
 * P7b（agent-and-deployment）：Agent 托管——指派生命周期的属主。
 *
 * ## 它管什么
 * 「一次指派从 poll 领取到回报/澄清」的完整编排：
 *   poll（拿工单 + sopPolicy + 澄清回复）→ 能力上报（含 browser 探测结果）→
 *   建沙箱工作区 → 环境探测 → **策略合并**（min(本地, 中台)）→
 *   runAgentLoop（LLM relay + 试跑 + 验收）→ 回报（completed/failed）
 *   或发澄清（clarification_requested）。
 *
 * ## P7d：澄清闭环 + 崩溃恢复
 * - **澄清回复消费**：poll 投递的 `clarification_reply` 落盘进本地日志
 *   （assignment-journal）后消费——answered/sop_amended 触发**续跑**
 *   （问答历史进规划/诊断上下文，闸门计数跨续跑连续）；续跑到达终态或
 *   进入下一轮澄清后才向中台 ACK。确认前中台重发，消费侧幂等去重。
 * - **崩溃重领**：running 阶段崩溃后，重启的 host 首次 poll 请求按 id
 *   重发该单；问答历史与预算计数从日志恢复——重跑不清零预算。
 * - **长跑心跳**：循环期间每 60s 上报进度——中台超时扫描对 in_progress
 *   超 10min 无心跳的工单判 stalled，而单轮 LLM 循环完全可能超过 10 分钟。
 *
 * ## 架构判断（与 07 §4.2「独立子进程」的关系，如实）
 * 设计文档要求 Agent 以独立子进程运行以避免重计算卡住 Electron 主进程。
 * 本实现把**重计算全部留在子进程里**（试跑 = spawn 解释器、浏览器 =
 * Playwright 的 Chromium 子进程、LLM = 网络等待），host 本体只做 I/O 编排，
 * 因此先以主进程内组件运行；「host 本身拆子进程」留到 P7d 做打包接线时
 * 一并处理（那时 agent worker 才有独立构建产物可执行）。这是如实的
 * 阶段性取舍，不是对 07 的偏离——爆炸半径隔离的目标（重活在子进程）已达成。
 *
 * ## 单飞行（single-flight）
 * `tick()` 正在处理指派时再次调用会被跳过——轮询循环是外部驱动（定时器），
 * 绝不能并发跑两个指派：沙箱工作区、闸门计数、报告归属都会互相污染。
 */

import { ensureWorkspace } from './workspace';
import { collectEnvironmentReport } from './perception';
import { probePlaywright } from './browser';
import { WindowsGuiDriver } from './gui-windows';
import {
  buildCandidatePackage,
  interpreterToRuntime,
} from './package-candidate';
import {
  mergeWithCenterPolicy,
  resolveLocalPermissions,
  allowsDirectTaskExecution,
  type CenterPolicyInput,
  type EffectiveAgentPermissions,
  type LocalAgentConfigInput,
} from './permission-profile';
import { runAgentLoop, type AgentLoopResult } from './loop';
import { buildLoopHandlers, newClarificationId, type SopPayload } from './runtime';
import type { CollabClient } from './collab-client';
import type { GateLimits } from './gates';
import { runIsolatedTask } from './isolated-runner';
import {
  clearAssignmentJournal,
  journalDirFor,
  listAssignmentJournals,
  loadAssignmentJournal,
  pruneStaleJournals,
  saveAssignmentJournal,
  type AssignmentJournal,
  type JournalAsked,
} from './assignment-journal';

/** 托管的最小配置面（渲染层消毒后的 config-store 读数）。 */
export interface AgentHostConfig {
  agentEnabled: boolean;
  adminApiUrl: string;
  executorToken: string;
  /** 细粒度档位输入（preset + 覆盖轴），交给 permission-profile 解析。 */
  agent: LocalAgentConfigInput;
}

export interface AgentHostDeps {
  address: string;
  workDir: string;
  /** 每次读取最新配置（设置页改完即生效，不用重启托管）。 */
  getConfig: () => AgentHostConfig;
  client: CollabClient;
  /** 轮询等待（交给调用方的定时器节奏决定；host 内部恒用 0 等待）。 */
  limits?: Partial<GateLimits> | null;
}

export interface AgentHostStats {
  working: boolean;
  lastAssignmentId: string | null;
  lastOutcome: string | null;
  processed: number;
  /** 最近一次生效档位（min(本地, 中台) 合并结果，审计可见）。 */
  lastEffectiveProfile: string | null;
}

interface PollAssignmentItem {
  kind: 'assignment';
  assignmentId: string;
  sop: SopPayload;
  maxRounds?: number;
}

/** poll 投递的澄清回复（P7d 双端 ACK：处理落盘后才 ACK）。 */
interface ReplyItem {
  kind: 'clarification_reply';
  assignmentId: string;
  clarificationId: string;
  clientClarificationId?: string | null;
  round?: number;
  resolution?: string;
  answer?: string | null;
  newSopVersion?: string | null;
  /** sop_amended 时中台附带的修订版本载荷。 */
  newSop?: unknown;
}

export class AgentHost {
  private ticking = false;
  private working = false;
  private centerPolicy: CenterPolicyInput | null = null;
  private capabilityAdvertised = false;
  private lastCapabilities: string | null = null;
  private lastCapabilityReportAt = 0;
  private capabilityWriteTail: Promise<unknown> = Promise.resolve();
  private withdrawAfterWork = false;
  private resendAssignmentsOnNextPoll = false;
  /** 崩溃恢复：running 阶段日志对应的指派 id（下一次 poll 定向重发）。 */
  private resendAssignmentIds: string[] = [];
  private recovered = false;
  readonly stats: AgentHostStats = {
    working: false,
    lastAssignmentId: null,
    lastOutcome: null,
    processed: 0,
    lastEffectiveProfile: null,
  };

  constructor(private readonly deps: AgentHostDeps) {}

  private journalDir(): string {
    return journalDirFor(this.deps.workDir);
  }

  /**
   * 轮询一轮并处理待办。非阻塞语义：无待办立即返回；有指派/回复则**同步
   * 跑完**（分钟级——调用方应在自己的定时器里等待本方法）。
   */
  async tick(): Promise<{ worked: boolean; detail?: string }> {
    if (this.ticking || this.working) return { worked: false, detail: 'single-flight: already working' };
    this.ticking = true;
    try {
      const cfg = this.deps.getConfig();
      if (!cfg.agentEnabled) {
        await this.withdrawCapabilities();
        return { worked: false, detail: 'agent disabled' };
      }
      this.withdrawAfterWork = false;
      this.recoverFromJournal();

      // 先声明 agent:sop 再 poll：SOP 预检和后续 LLM/回报端点都依赖这个能力。
      // 首次尚未收到中台权限上限时保守不报 gui；poll 下发策略后再更新。
      const preflight = await this.advertiseCapabilities(this.centerPolicy !== null);
      if (!preflight.ok) return { worked: false, detail: `capability failed: ${preflight.error ?? 'unknown'}` };

      // poll 恒 0 等待——长等待由外部定时器节奏控制，host 不占住调用线程。
      // 重发请求（全局 or 按 id）只在 poll 成功后清空，失败留待下轮重试。
      const resendAssignments: boolean | string[] | undefined =
        this.resendAssignmentsOnNextPoll
          ? true
          : this.resendAssignmentIds.length > 0
            ? [...this.resendAssignmentIds]
            : undefined;
      const poll = await this.deps.client.poll(this.deps.address, {
        waitMs: 0,
        ...(resendAssignments !== undefined ? { resendAssignments } : {}),
      });
      if (!poll.ok) return { worked: false, detail: `poll failed: ${poll.error ?? 'unknown'}` };
      this.resendAssignmentsOnNextPoll = false;
      this.resendAssignmentIds = [];

      // 中台策略随每轮 poll 下发——本地缓存最新值（离线沿用最近一次，09 §调整4）
      if (poll.sopPolicy && typeof poll.sopPolicy === 'object') {
        this.centerPolicy = poll.sopPolicy as CenterPolicyInput;
        // 策略拿到后，按最终权限档位更新 GUI 能力；普通 runtime 能力由中台
        // 的分区合并逻辑保留，Agent 上报不会覆盖 node/python 等能力。
        await this.advertiseCapabilities(true);
      }

      if (!this.deps.getConfig().agentEnabled) {
        // 服务端在构造 poll 响应时已把 assignment 标为 in_progress。
        // 关闭后不执行它，但要如实回报 failed；回报失败才在下次启用时请求重发。
        // 澄清回复不消费也不 ACK——留在中台游标后，重新启用后原样再投。
        for (const item of poll.items) {
          if (!item || typeof item !== 'object' || (item as PollAssignmentItem).kind !== 'assignment') continue;
          const assignment = item as PollAssignmentItem;
          const reported = await this.deps.client.reportComplete(this.deps.address, assignment.assignmentId, {
            status: 'failed', attempt: 1,
            result: { outcome: 'agent_disabled_during_poll', stopMessage: 'Agent 在领取指派期间被关闭，未执行' },
          });
          if (!reported.ok) this.resendAssignmentsOnNextPoll = true;
        }
        await this.withdrawCapabilities();
        return { worked: false, detail: 'agent disabled after poll' };
      }

      // ── 分拣：指派（≤1）+ 澄清回复（P7d）────────────────────────────
      let assignment: PollAssignmentItem | null = null;
      const replies: ReplyItem[] = [];
      for (const raw of poll.items) {
        if (!raw || typeof raw !== 'object') continue;
        const kind = (raw as { kind?: unknown }).kind;
        if (kind === 'assignment' && assignment === null) {
          assignment = raw as PollAssignmentItem;
        } else if (kind === 'clarification_reply') {
          replies.push(raw as ReplyItem);
        }
      }

      // 先消费澄清回复：回复触发续跑；同一指派的崩溃重发载荷若同批到达，
      // 续跑已代表最新状态，旧载荷跳过防双重运行。
      const continued = new Set<string>();
      let worked = false;
      for (const reply of replies) {
        if (await this.processReply(reply, continued)) worked = true;
      }
      if (assignment && !continued.has(assignment.assignmentId)) {
        await this.processAssignment(assignment);
        worked = true;
      }
      // 发送失败的澄清按幂等键重试（网络抖动的自愈——服务端按
      // clientClarificationId 去重，重试绝不产生第二条澄清）
      if (await this.retryPendingClarificationSends()) worked = true;
      return {
        worked,
        ...(worked ? { detail: assignment ? `assignment ${assignment.assignmentId} processed` : 'clarification replies consumed' } : {}),
      };
    } finally {
      this.ticking = false;
    }
  }

  /**
   * 崩溃恢复（P7d，每个 host 实例一次）：扫描本地日志。
   * running 阶段 = 循环中途崩溃（正常结束的运行要么清日志要么转
   * awaiting_reply，不会留 running）→ 请求中台按 id 重发重跑；
   * awaiting_reply 阶段无需动作——回复会随 poll 投递，续跑从日志恢复。
   * 陈旧日志（工单多半已被中台超时治理收走）直接清理。
   */
  private recoverFromJournal(): void {
    if (this.recovered) return;
    this.recovered = true;
    try {
      const dir = this.journalDir();
      pruneStaleJournals(dir);
      for (const j of listAssignmentJournals(dir)) {
        if (j.phase === 'running') this.resendAssignmentIds.push(j.assignmentId);
      }
    } catch {
      /* 日志读不了就当没有历史——中台侧超时治理兜底 */
    }
  }

  private async advertiseCapabilities(
    includeGui: boolean,
    report?: Record<string, unknown>,
  ): Promise<{ ok: boolean; error?: string }> {
    return this.withCapabilityWrite(async () => {
      if (!this.deps.getConfig().agentEnabled && !this.working) {
        return { ok: false, error: 'agent disabled' };
      }
      const effective = mergeWithCenterPolicy(
        resolveLocalPermissions(this.deps.getConfig().agent), this.centerPolicy,
      );
      const capabilities = ['agent:sop', 'filesystem', 'http'];
      if (probePlaywright().available) capabilities.push('browser');
      if (includeGui && effective.hostAccess === 'app-scoped' &&
          effective.allowedApps.length > 0 && await new WindowsGuiDriver().probe()) {
        capabilities.push('gui');
      }
      const fingerprint = capabilities.join(',');
      // 正常 tick 每 30s 续租一次；处理指派期间另有本地定时器续租。
      // 只跳过同一个 tick 内重复的第二次上报，不能把 DB 里的能力当永久授权。
      if (!report && this.capabilityAdvertised && fingerprint === this.lastCapabilities &&
          Date.now() - this.lastCapabilityReportAt < 25_000) return { ok: true };
      const result = await this.deps.client.reportCapability(this.deps.address, capabilities, report);
      if (result.ok) {
        this.capabilityAdvertised = true;
        this.lastCapabilities = fingerprint;
        this.lastCapabilityReportAt = Date.now();
      }
      return result;
    });
  }

  /** 续报与撤销按请求顺序落库，避免旧续报在撤销后重新授予能力。 */
  private withCapabilityWrite<T>(operation: () => Promise<T>): Promise<T> {
    const current = this.capabilityWriteTail.then(operation, operation);
    this.capabilityWriteTail = current.then(() => undefined, () => undefined);
    return current;
  }

  /** 关闭托管时撤销 Agent 能力；若正在处理指派，等回报完成后再撤销。 */
  async withdrawCapabilities(): Promise<void> {
    if (this.working) {
      this.withdrawAfterWork = true;
      return;
    }
    await this.withCapabilityWrite(async () => {
      if (!this.capabilityAdvertised) return;
      const result = await this.deps.client.reportCapability(this.deps.address, []);
      if (result.ok) {
        this.capabilityAdvertised = false;
        this.lastCapabilities = null;
        this.lastCapabilityReportAt = 0;
      }
    });
  }

  /** 处理一次指派。首跑入口：写/合并本地日志后进循环。 */
  private async processAssignment(item: PollAssignmentItem): Promise<void> {
    const dir = this.journalDir();
    const existing = loadAssignmentJournal(dir, item.assignmentId);
    const journal: AssignmentJournal = {
      assignmentId: item.assignmentId,
      sop: item.sop,
      phase: 'running',
      pendingQuestion: null,
      // 崩溃重跑保留既有问答历史与预算计数：历史是答案上下文（丢了就会
      // 带着同样的疑问再问一遍），计数防「崩溃清零重跑」变成预算规避通道。
      asked: existing?.asked ?? [],
      replies: existing?.replies ?? [],
      counters: existing?.counters ?? null,
      guiActionsUsed: existing?.guiActionsUsed ?? 0,
      lastSendError: existing?.lastSendError ?? null,
      updatedAt: new Date().toISOString(),
    };
    try {
      saveAssignmentJournal(dir, journal);
    } catch {
      /* 日志写不了不阻塞首跑——本轮没有恢复点，如实降级 */
    }
    await this.runWithJournal(journal);
  }

  /**
   * 消费一条澄清回复（P7d 双端 ACK 的执行器半边）。
   * 消费（落盘 + 续跑/终结）成功都 ACK；处理中途崩溃则不 ACK，重启后
   * 中台重发、本侧按 clarificationId 幂等去重。返回是否消费了本机状态。
   */
  private async processReply(reply: ReplyItem, continued: Set<string>): Promise<boolean> {
    if (typeof reply.assignmentId !== 'string' || typeof reply.clarificationId !== 'string') return false;
    const dir = this.journalDir();
    const journal = loadAssignmentJournal(dir, reply.assignmentId);
    if (!journal || journal.phase !== 'awaiting_reply') {
      // 没有在等的循环可喂（日志丢失 / 从未在本机跑过）——ACK 丢弃。
      // 不 ACK 才是毒消息：游标不前进，回复随每次 poll 永久重发。
      await this.ackReply(reply.assignmentId, reply.clarificationId);
      return false;
    }
    if (journal.replies.some((r) => r.clarificationId === reply.clarificationId)) {
      // 重放：上次已消费、ACK 未送达——补 ACK 即可，绝不二次续跑
      await this.ackReply(reply.assignmentId, reply.clarificationId);
      return false;
    }
    continued.add(reply.assignmentId);

    if (reply.resolution === 'escalated_to_human') {
      // 升级后中台不会再有自动答复（人工答复端点对已处置澄清幂等短路）。
      // 如实终结本单，绝不挂着装等——运维在 Admin Web 处理后重派。
      this.stats.lastOutcome = 'escalated_to_human';
      this.stats.processed += 1;
      const reported = await this.deps.client.reportComplete(this.deps.address, reply.assignmentId, {
        status: 'failed',
        attempt: 1,
        result: {
          outcome: 'escalated_to_human',
          stopMessage: '澄清已升级人工，无自动答复——请在 Admin Web 处理后重派',
        },
      });
      if (reported.ok) clearAssignmentJournal(dir, reply.assignmentId);
      await this.ackReply(reply.assignmentId, reply.clarificationId);
      return true;
    }

    // answered / sop_amended → 续跑：问答历史进下一轮规划/诊断上下文
    journal.replies.push({
      clarificationId: reply.clarificationId,
      clientClarificationId: typeof reply.clientClarificationId === 'string' ? reply.clientClarificationId : null,
      round: typeof reply.round === 'number' ? reply.round : 0,
      resolution: reply.resolution === 'sop_amended' ? 'sop_amended' : 'answered',
      answer: typeof reply.answer === 'string' ? reply.answer : '',
      newSopVersion: typeof reply.newSopVersion === 'string' ? reply.newSopVersion : null,
    });
    if (reply.resolution === 'sop_amended' && reply.newSop) {
      // 修订版载荷：续跑按修订版执行，交付对账锚（contentHash）随之前移。
      // 载荷缺失/畸形时沿用旧版续跑——答案文本仍在上下文里，如实降级。
      const sop = sanitizeAmendedSop(reply.newSop, journal.sop);
      if (sop) journal.sop = sop;
    }
    journal.phase = 'running';
    journal.pendingQuestion = null;
    journal.lastSendError = null; // 悬而未决的提问已被回复，发送错误随之作废
    try {
      saveAssignmentJournal(dir, journal);
    } catch {
      // 落盘失败就不消费（不 ACK）——中台会重发，磁盘恢复后重放重跑
      this.stats.lastOutcome = 'journal_write_failed';
      return true;
    }
    await this.runWithJournal(journal);
    await this.ackReply(reply.assignmentId, reply.clarificationId);
    return true;
  }

  private async ackReply(assignmentId: string, clarificationId: string): Promise<void> {
    // ACK 失败不致命：回复会随下轮 poll 重发，消费侧按 clarificationId 去重
    await this.deps.client.ackClarificationReply(this.deps.address, assignmentId, clarificationId)
      .catch(() => undefined);
  }

  /**
   * 跑一次循环（首跑与澄清续跑共用）。所有失败收敛为「回报 failed」，
   * 绝不把异常抛回轮询循环。
   */
  private async runWithJournal(journal: AssignmentJournal): Promise<void> {
    const dir = this.journalDir();
    const assignmentId = journal.assignmentId;
    this.working = true;
    this.stats.working = true;
    this.stats.lastAssignmentId = assignmentId;
    // 单次指派可持续数分钟/小时。外部轮询遇 working 会跳过，故在处理期间
    // 单独续报短效 Agent 能力租约；关闭开关时仍续到终态回报，再撤销能力。
    const capabilityLeaseTimer = setInterval(() => {
      void this.advertiseCapabilities(true).catch(() => undefined);
    }, 30_000);
    capabilityLeaseTimer.unref?.();
    // 长跑心跳：in_progress 超 10min 无进度心跳即被中台超时扫描判 stalled，
    // 而单轮 LLM 循环（规划+试跑+诊断）完全可能超过 10 分钟——必须持续报活。
    const progressTimer = setInterval(() => {
      void this.deps.client.reportProgress(this.deps.address, assignmentId, {
        progressJson: { phase: journal.phase, iterations: journal.counters?.iterations ?? 0 },
      }).catch(() => undefined);
    }, 60_000);
    progressTimer.unref?.();
    try {
      const cfg = this.deps.getConfig();

      // ── 策略合并（09 §4.2：中台只能往下压）─────────────────────────
      const local = resolveLocalPermissions(cfg.agent);
      const effective = mergeWithCenterPolicy(local, this.centerPolicy);
      this.stats.lastEffectiveProfile = `${effective.preset}(ce=${effective.codeExecution},sb=${effective.sandboxBackend},ha=${effective.hostAccess},te=${effective.taskExecution})`;

      // ── 能力上报：浏览器/GUI 只在真实可用且 GUI 已授权时声明 ───────────
      const capabilities = ['agent:sop', 'filesystem', 'http'];
      if (probePlaywright().available) capabilities.push('browser');
      const guiDriver = new WindowsGuiDriver();
      const guiAvailable = effective.hostAccess === 'app-scoped' &&
        effective.allowedApps.length > 0 && await guiDriver.probe();
      if (guiAvailable) capabilities.push('gui');
      const required = Array.isArray(journal.sop.frontMatter.capabilities)
        ? journal.sop.frontMatter.capabilities : [];
      const missing = required.filter((cap) => !capabilities.includes(cap));
      if (missing.length > 0) {
        // 上次轮询缓存的中台策略可能在本轮被收紧；服务端按旧能力刚领取
        // 的工单不能继续进入 LLM/GUI 循环，必须明确回报不可执行。
        this.stats.lastOutcome = 'permission_denied';
        this.stats.processed += 1;
        const reported = await this.deps.client.reportComplete(this.deps.address, assignmentId, {
          status: 'failed',
          attempt: 1,
          result: {
            outcome: 'permission_denied',
            stopMessage: `SOP 所需能力当前不可用：${missing.join(', ')}`,
            effectiveProfile: this.stats.lastEffectiveProfile,
          },
        });
        if (reported.ok) clearAssignmentJournal(dir, assignmentId);
        return;
      }
      const environment = await collectEnvironmentReport();
      environment.capabilities = capabilities.filter((cap) => cap !== 'agent:sop');
      await this.advertiseCapabilities(
        true, environment as unknown as Record<string, unknown>,
      ).catch(() => undefined); // 能力上报失败不阻塞指派处理

      // ── 沙箱工作区 + 循环 ────────────────────────────────────────────
      const workspaceRoot = ensureWorkspace(this.deps.workDir, assignmentId);
      const history = journal.replies.map((r) => ({
        round: r.round,
        question: journal.asked.find((q) => q.clientClarificationId === r.clientClarificationId)?.question
          ?? journal.asked.find((q) => q.round === r.round)?.question
          ?? '(历史问句缺失——崩溃前提出)',
        answer: r.answer ?? '',
        resolution: r.resolution,
        newSopVersion: r.newSopVersion,
      }));
      const handlers = buildLoopHandlers(
        {
          address: this.deps.address,
          assignmentId,
          client: this.deps.client,
          permissions: effective,
          sop: journal.sop,
          workspaceRoot,
          environment,
          guiAvailable,
          guiDriver,
          allowGuiAction: (app) => {
            const latest = this.deps.getConfig();
            if (!latest.agentEnabled) return false;
            const now = mergeWithCenterPolicy(resolveLocalPermissions(latest.agent), this.centerPolicy);
            return now.hostAccess === 'app-scoped' && now.allowedApps.includes(app);
          },
          ...(history.length > 0 ? { clarificationHistory: history } : {}),
          guiActionsUsed: journal.guiActionsUsed,
          // GUI 动作预算按指派累计：每批动作后取回累计值落盘，续跑不清零
          onGuiActions: (n) => {
            journal.guiActionsUsed = n;
            try {
              saveAssignmentJournal(dir, journal);
            } catch {
              /* 预算落盘失败不阻塞循环——上限在内存里仍然生效 */
            }
          },
        },
        {
          // relay 适配：空 content = 中台 LLM 不可用（fail-open 透传）——
          // 按错误上抛（loop 收敛为 outcome=error），不伪装成功
          chat: async ({ messages }) => {
            const r = await this.deps.client.llmRelay(this.deps.address, { messages });
            if (!r.ok) return { ok: false, error: r.error ?? 'relay failed', content: '' };
            if (!r.content) return { ok: false, error: '中台 LLM 未启用/不可用（relay 返回空）', content: '' };
            return { ok: true, content: r.content };
          },
        },
      );

      const result = await runAgentLoop({
        environment,
        permissions: effective,
        handlers,
        limits: this.deps.limits ?? null,
        // 预算跨续跑/崩溃恢复连续（墙钟自首次迭代起算，resume 不重置）
        ...(journal.counters ? { counters: journal.counters } : {}),
      });

      await this.reportLoopResult(journal, result, workspaceRoot, effective);
    } catch (err) {
      // 兜底：循环外的意外（poll 载荷畸形、磁盘故障……）也要如实回报
      this.stats.lastOutcome = 'host_error';
      const reported = await this.deps.client.reportComplete(this.deps.address, assignmentId, {
        status: 'failed',
        attempt: 1,
        result: {
          outcome: 'host_error',
          stopMessage: err instanceof Error ? err.message : String(err),
        },
      }).catch(() => undefined);
      if (reported?.ok) clearAssignmentJournal(dir, assignmentId);
    } finally {
      clearInterval(capabilityLeaseTimer);
      clearInterval(progressTimer);
      this.working = false;
      this.stats.working = false;
      if (this.withdrawAfterWork && !this.deps.getConfig().agentEnabled) {
        await this.withdrawCapabilities().catch(() => undefined);
      }
      this.withdrawAfterWork = false;
    }
  }

  /** 循环终态的上报与日志收尾（首跑与续跑共用）。 */
  private async reportLoopResult(
    journal: AssignmentJournal,
    result: AgentLoopResult,
    workspaceRoot: string,
    effective: EffectiveAgentPermissions,
  ): Promise<void> {
    const dir = this.journalDir();
    const assignmentId = journal.assignmentId;
    this.stats.lastOutcome = result.outcome;
    this.stats.processed += 1;
    journal.counters = result.counters;

    if (result.outcome === 'delivered') {
      // 交付（P7d 前半，07 §3.3）：候选打成标准应用包走既有 executor-package
      // 校验链；打包/上传失败 = 交付未完成，如实回报 failed——验收通过但
      // 交付失败是运维可动作的信息（重传即可），掩盖成 completed 会让人
      // 以为应用已进系统。对账锚用 journal.sop——澄清修订后续跑按修订版交付。
      let packageRef: Record<string, unknown> | null = null;
      let deliverError: string | null = null;
      let entrySpec: { interpreter: string; path: string } | null = null;
      try {
        const entry = result.candidate ?? '';
        const interpreter = entry.split(' ')[0] ?? '';
        const entryPath = entry.split(' ')[1] ?? '';
        entrySpec = { interpreter, path: entryPath };
        const pkg = buildCandidatePackage({
          workspaceRoot,
          entry: { interpreter, path: entryPath },
          sopSlug: journal.sop.slug,
          sopVersion: journal.sop.version,
          contentHash: journal.sop.contentHash,
        });
        const up = await this.deps.client.uploadCandidatePackage(this.deps.address, assignmentId, {
          filename: pkg.filename,
          buf: pkg.buf,
          runtime: interpreterToRuntime(interpreter),
          sopSlug: journal.sop.slug,
          sopVersion: journal.sop.version,
          contentHash: journal.sop.contentHash,
        });
        if (!up.ok) deliverError = up.error ?? 'candidate upload failed';
        else {
          packageRef = { packageId: up.packageId, name: up.packageName, version: up.packageVersion };
        }
      } catch (err) {
        deliverError = err instanceof Error ? err.message : String(err);
      }

      // 直接执行证据（P7e 前半，08 §2.4 方案 A）：isolated-runner 档下交付
      // 后在本机跑一次候选。发生在交付之后——执行失败不翻转交付判定，
      // 证据如实进回报（中台复核按不可信自述对待），本地不悄悄重试或掩盖。
      let isolatedRun: Record<string, unknown> | null = null;
      if (entrySpec !== null && allowsDirectTaskExecution(effective)) {
        const run = await runIsolatedTask({
          workspaceRoot,
          entry: entrySpec,
          runSeq: 1,
          source: `agent:sop:${this.deps.address}`,
          codeExecution: effective.codeExecution,
          taskExecution: effective.taskExecution,
        });
        isolatedRun = { ...run };
      }

      if (deliverError !== null) {
        this.stats.lastOutcome = 'deliver_failed';
        const reported = await this.deps.client.reportComplete(this.deps.address, assignmentId, {
          status: 'failed',
          attempt: 1,
          result: {
            outcome: 'deliver_failed',
            stopMessage: `交付打包/上传失败：${deliverError}`,
            iterations: result.iterations,
            gateSummary: result.gateSummary,
            effectiveProfile: this.stats.lastEffectiveProfile,
          },
        });
        if (reported.ok) clearAssignmentJournal(dir, assignmentId);
        return;
      }

      const reported = await this.deps.client.reportComplete(this.deps.address, assignmentId, {
        status: 'completed',
        attempt: 1,
        result: {
          outcome: result.outcome,
          iterations: result.iterations,
          trialRuns: result.trialRuns,
          gateSummary: result.gateSummary,
          effectiveProfile: this.stats.lastEffectiveProfile,
          packageRef,
          ...(isolatedRun !== null ? { isolatedRun } : {}),
        },
      });
      if (reported.ok) clearAssignmentJournal(dir, assignmentId);
      return;
    }

    if (result.outcome === 'clarification_requested') {
      // 澄清：指派在中台侧转 blocked，等回复经 poll 投递（11 §3.1）。
      // **先落盘后发送**：幂等键先持久化——崩溃窗口内重发同键，中台按
      // 幂等键去重，不产生第二条澄清（先发后存 = 可能问丢一轮）。
      const clientClarificationId = newClarificationId();
      const question = result.pendingQuestion ?? '需要中台补充 SOP 信息';
      journal.phase = 'awaiting_reply';
      journal.pendingQuestion = question;
      const asked: JournalAsked = {
        clientClarificationId,
        round: result.clarifications,
        question,
      };
      journal.asked = [...journal.asked, asked];
      try {
        saveAssignmentJournal(dir, journal);
      } catch {
        /* 落盘失败仍发送：本轮窗口内崩溃会丢恢复点，但澄清链路不断 */
      }
      await this.sendClarificationForJournal(journal);
      return;
    }

    // gate_stopped / permission_denied / escalated / error → failed（带原因）
    const reported = await this.deps.client.reportComplete(this.deps.address, assignmentId, {
      status: 'failed',
      attempt: 1,
      result: {
        outcome: result.outcome,
        stopReason: result.stopReason ?? null,
        stopMessage: result.stopMessage ?? null,
        iterations: result.iterations,
        trialRuns: result.trialRuns,
        gateSummary: result.gateSummary,
        effectiveProfile: this.stats.lastEffectiveProfile,
      },
    });
    if (reported.ok) clearAssignmentJournal(dir, assignmentId);
  }

  /**
   * 发送（或按幂等键重试）日志里未送达的澄清。
   * 成功：清除 lastSendError；若中台侧已触顶升级（escalated=true），如实
   * 终结本单。失败：记录原因，下个 tick 重试——幂等键不变，中台去重。
   */
  private async sendClarificationForJournal(journal: AssignmentJournal): Promise<void> {
    const dir = this.journalDir();
    const assignmentId = journal.assignmentId;
    const outstanding = this.outstandingAsk(journal);
    if (!outstanding) return;
    const sent = await this.deps.client.sendClarification(this.deps.address, {
      assignmentId,
      clientClarificationId: outstanding.clientClarificationId,
      question: outstanding.question,
      targetAgentSessionId: assignmentId,
    });
    if (sent.ok) {
      if (journal.lastSendError !== null) {
        journal.lastSendError = null;
        try {
          saveAssignmentJournal(dir, journal);
        } catch {
          /* 清除失败无害——下次发送成功再清 */
        }
      }
      if (sent.escalated) {
        // 中台 maxRounds 触顶已强制升级——不会再有回复，如实终结本单
        this.stats.lastOutcome = 'escalated_to_human';
        const reported = await this.deps.client.reportComplete(this.deps.address, assignmentId, {
          status: 'failed',
          attempt: 1,
          result: {
            outcome: 'escalated_to_human',
            stopMessage: `澄清轮次触顶（第 ${sent.round ?? outstanding.round} 轮），已升级人工`,
          },
        });
        if (reported.ok) clearAssignmentJournal(dir, assignmentId);
      }
      return;
    }
    journal.lastSendError = (sent.error ?? 'clarification send failed').slice(0, 200);
    try {
      saveAssignmentJournal(dir, journal);
    } catch {
      /* 落盘失败则退化为「无重试」——与旧行为一致 */
    }
  }

  /** 未获得回复的最近一次提问（重试只针对它；无则返回 null）。 */
  private outstandingAsk(journal: AssignmentJournal): JournalAsked | null {
    for (let i = journal.asked.length - 1; i >= 0; i--) {
      const a = journal.asked[i];
      if (!journal.replies.some((r) => r.clientClarificationId === a.clientClarificationId)) {
        return a;
      }
    }
    return null;
  }

  /** 重试所有发送失败的澄清。返回是否发生了重试动作。 */
  private async retryPendingClarificationSends(): Promise<boolean> {
    let retried = false;
    try {
      for (const journal of listAssignmentJournals(this.journalDir())) {
        if (journal.phase !== 'awaiting_reply' || journal.lastSendError === null) continue;
        if (!this.outstandingAsk(journal)) continue;
        this.stats.lastOutcome = 'clarification_send_retry';
        await this.sendClarificationForJournal(journal);
        retried = true;
      }
    } catch {
      /* 日志扫描失败就跳过——下个 tick 再试 */
    }
    return retried;
  }
}

/** 中台下发的修订版载荷最小校验——不通过就沿用旧版（答案文本仍在上下文里）。 */
function sanitizeAmendedSop(raw: unknown, fallback: SopPayload): SopPayload | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (
    typeof r.version !== 'string' ||
    typeof r.contentHash !== 'string' ||
    typeof r.bodyMarkdown !== 'string' ||
    !r.frontMatter || typeof r.frontMatter !== 'object'
  ) {
    return null;
  }
  return {
    slug: fallback.slug,
    title: fallback.title,
    version: r.version,
    contentHash: r.contentHash,
    frontMatter: r.frontMatter as SopPayload['frontMatter'],
    bodyMarkdown: r.bodyMarkdown,
  };
}
