/**
 * P7b（agent-and-deployment）：Agent 托管——指派生命周期的属主。
 *
 * ## 它管什么
 * 「一次指派从 poll 领取到回报/澄清」的完整编排：
 *   poll（拿工单 + sopPolicy）→ 能力上报（含 browser 探测结果）→
 *   建沙箱工作区 → 环境探测 → **策略合并**（min(本地, 中台)）→
 *   runAgentLoop（LLM relay + 试跑 + 验收）→ 回报（completed/failed）
 *   或发澄清（clarification_requested）。
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
  type CenterPolicyInput,
  type LocalAgentConfigInput,
} from './permission-profile';
import { runAgentLoop } from './loop';
import { buildLoopHandlers, newClarificationId, type SopPayload } from './runtime';
import type { CollabClient } from './collab-client';
import type { GateLimits } from './gates';

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
  readonly stats: AgentHostStats = {
    working: false,
    lastAssignmentId: null,
    lastOutcome: null,
    processed: 0,
    lastEffectiveProfile: null,
  };

  constructor(private readonly deps: AgentHostDeps) {}

  /**
   * 轮询一轮并处理待办。非阻塞语义：无待办立即返回；有指派则**同步跑完
   * 整个循环**（分钟级——调用方应在自己的定时器里等待本方法）。
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

      // 先声明 agent:sop 再 poll：SOP 预检和后续 LLM/回报端点都依赖这个能力。
      // 首次尚未收到中台权限上限时保守不报 gui；poll 下发策略后再更新。
      const preflight = await this.advertiseCapabilities(this.centerPolicy !== null);
      if (!preflight.ok) return { worked: false, detail: `capability failed: ${preflight.error ?? 'unknown'}` };

      // poll 恒 0 等待——长等待由外部定时器节奏控制，host 不占住调用线程
      const poll = await this.deps.client.poll(this.deps.address, {
        waitMs: 0,
        resendAssignments: this.resendAssignmentsOnNextPoll,
      });
      if (!poll.ok) return { worked: false, detail: `poll failed: ${poll.error ?? 'unknown'}` };
      this.resendAssignmentsOnNextPoll = false;

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

      const assignment = poll.items.find(
        (i): i is PollAssignmentItem => !!i && typeof i === 'object' && (i as PollAssignmentItem).kind === 'assignment',
      );
      if (!assignment) return { worked: false };

      await this.processAssignment(assignment);
      return { worked: true, detail: `assignment ${assignment.assignmentId} processed` };
    } finally {
      this.ticking = false;
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

  /** 处理一次指派。所有失败收敛为「回报 failed」，绝不把异常抛回轮询循环。 */
  private async processAssignment(item: PollAssignmentItem): Promise<void> {
    this.working = true;
    this.stats.working = true;
    // 单次指派可持续数分钟/小时。外部轮询遇 working 会跳过，故在处理期间
    // 单独续报短效 Agent 能力租约；关闭开关时仍续到终态回报，再撤销能力。
    const capabilityLeaseTimer = setInterval(() => {
      void this.advertiseCapabilities(true).catch(() => undefined);
    }, 30_000);
    capabilityLeaseTimer.unref?.();
    this.stats.lastAssignmentId = item.assignmentId;
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
      const required = Array.isArray(item.sop.frontMatter.capabilities)
        ? item.sop.frontMatter.capabilities : [];
      const missing = required.filter((cap) => !capabilities.includes(cap));
      if (missing.length > 0) {
        // 上次轮询缓存的中台策略可能在本轮被收紧；服务端按旧能力刚领取
        // 的工单不能继续进入 LLM/GUI 循环，必须明确回报不可执行。
        this.stats.lastOutcome = 'permission_denied';
        this.stats.processed += 1;
        await this.deps.client.reportComplete(this.deps.address, item.assignmentId, {
          status: 'failed',
          attempt: 1,
          result: {
            outcome: 'permission_denied',
            stopMessage: `SOP 所需能力当前不可用：${missing.join(', ')}`,
            effectiveProfile: this.stats.lastEffectiveProfile,
          },
        });
        return;
      }
      const environment = await collectEnvironmentReport();
      environment.capabilities = capabilities.filter((cap) => cap !== 'agent:sop');
      await this.advertiseCapabilities(
        true, environment as unknown as Record<string, unknown>,
      ).catch(() => undefined); // 能力上报失败不阻塞指派处理

      // ── 沙箱工作区 + 循环 ────────────────────────────────────────────
      const workspaceRoot = ensureWorkspace(this.deps.workDir, item.assignmentId);
      const handlers = buildLoopHandlers(
        {
          address: this.deps.address,
          assignmentId: item.assignmentId,
          client: this.deps.client,
          permissions: effective,
          sop: item.sop,
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
      });

      this.stats.lastOutcome = result.outcome;
      this.stats.processed += 1;

      // ── 回报（幂等键 attempt 由 complete 端点管理）───────────────────
      if (result.outcome === 'delivered') {
        // 交付（P7d 前半，07 §3.3）：候选打成标准应用包走既有 executor-package
        // 校验链；打包/上传失败 = 交付未完成，如实回报 failed——验收通过但
        // 交付失败是运维可动作的信息（重传即可），掩盖成 completed 会让人
        // 以为应用已进系统。
        let packageRef: Record<string, unknown> | null = null;
        let deliverError: string | null = null;
        try {
          const entry = result.candidate ?? '';
          const interpreter = entry.split(' ')[0] ?? '';
          const entryPath = entry.split(' ')[1] ?? '';
          const pkg = buildCandidatePackage({
            workspaceRoot,
            entry: { interpreter, path: entryPath },
            sopSlug: item.sop.slug,
            sopVersion: item.sop.version,
            contentHash: item.sop.contentHash,
          });
          const up = await this.deps.client.uploadCandidatePackage(this.deps.address, item.assignmentId, {
            filename: pkg.filename,
            buf: pkg.buf,
            runtime: interpreterToRuntime(interpreter),
            sopSlug: item.sop.slug,
            sopVersion: item.sop.version,
            contentHash: item.sop.contentHash,
          });
          if (!up.ok) deliverError = up.error ?? 'candidate upload failed';
          else {
            packageRef = { packageId: up.packageId, name: up.packageName, version: up.packageVersion };
          }
        } catch (err) {
          deliverError = err instanceof Error ? err.message : String(err);
        }

        if (deliverError !== null) {
          this.stats.lastOutcome = 'deliver_failed';
          await this.deps.client.reportComplete(this.deps.address, item.assignmentId, {
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
          return;
        }

        await this.deps.client.reportComplete(this.deps.address, item.assignmentId, {
          status: 'completed',
          attempt: 1,
          result: {
            outcome: result.outcome,
            iterations: result.iterations,
            trialRuns: result.trialRuns,
            gateSummary: result.gateSummary,
            effectiveProfile: this.stats.lastEffectiveProfile,
            packageRef,
          },
        });
        return;
      }

      if (result.outcome === 'clarification_requested') {
        // 澄清：指派在中台侧转 blocked，等回复经 poll 投递（11 §3.1）
        await this.deps.client.sendClarification(this.deps.address, {
          assignmentId: item.assignmentId,
          clientClarificationId: newClarificationId(),
          question: result.pendingQuestion ?? '需要中台补充 SOP 信息',
          targetAgentSessionId: item.assignmentId,
        });
        return;
      }

      // gate_stopped / permission_denied / escalated / error → failed（带原因）
      await this.deps.client.reportComplete(this.deps.address, item.assignmentId, {
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
    } catch (err) {
      // 兜底：循环外的意外（poll 载荷畸形、磁盘故障……）也要如实回报
      this.stats.lastOutcome = 'host_error';
      await this.deps.client.reportComplete(this.deps.address, item.assignmentId, {
        status: 'failed',
        attempt: 1,
        result: {
          outcome: 'host_error',
          stopMessage: err instanceof Error ? err.message : String(err),
        },
      }).catch(() => undefined);
    } finally {
      clearInterval(capabilityLeaseTimer);
      this.working = false;
      this.stats.working = false;
      if (this.withdrawAfterWork && !this.deps.getConfig().agentEnabled) {
        await this.withdrawCapabilities().catch(() => undefined);
      }
      this.withdrawAfterWork = false;
    }
  }
}
