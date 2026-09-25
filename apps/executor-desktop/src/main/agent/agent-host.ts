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
  private working = false;
  private centerPolicy: CenterPolicyInput | null = null;
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
    const cfg = this.deps.getConfig();
    if (!cfg.agentEnabled) return { worked: false, detail: 'agent disabled' };
    if (this.working) return { worked: false, detail: 'single-flight: already working' };

    // poll 恒 0 等待——长等待由外部定时器节奏控制，host 不占住调用线程
    const poll = await this.deps.client.poll(this.deps.address, { waitMs: 0 });
    if (!poll.ok) return { worked: false, detail: `poll failed: ${poll.error ?? 'unknown'}` };

    // 中台策略随每轮 poll 下发——本地缓存最新值（离线沿用最近一次，09 §调整4）
    if (poll.sopPolicy && typeof poll.sopPolicy === 'object') {
      this.centerPolicy = poll.sopPolicy as CenterPolicyInput;
    }

    const assignment = poll.items.find(
      (i): i is PollAssignmentItem => !!i && typeof i === 'object' && (i as PollAssignmentItem).kind === 'assignment',
    );
    if (!assignment) return { worked: false };

    await this.processAssignment(assignment);
    return { worked: true, detail: `assignment ${assignment.assignmentId} processed` };
  }

  /** 处理一次指派。所有失败收敛为「回报 failed」，绝不把异常抛回轮询循环。 */
  private async processAssignment(item: PollAssignmentItem): Promise<void> {
    this.working = true;
    this.stats.lastAssignmentId = item.assignmentId;
    try {
      const cfg = this.deps.getConfig();

      // ── 策略合并（09 §4.2：中台只能往下压）─────────────────────────
      const local = resolveLocalPermissions(cfg.agent);
      const effective = mergeWithCenterPolicy(local, this.centerPolicy);
      this.stats.lastEffectiveProfile = `${effective.preset}(ce=${effective.codeExecution},sb=${effective.sandboxBackend},ha=${effective.hostAccess},te=${effective.taskExecution})`;

      // ── 能力上报：browser 只在真实可用时声明（不超前）────────────────
      const capabilities = ['agent:sop', 'filesystem', 'http'];
      if (probePlaywright().available) capabilities.push('browser');
      const environment = await collectEnvironmentReport();
      await this.deps.client
        .reportCapability(this.deps.address, capabilities, environment as unknown as Record<string, unknown>)
        .catch(() => undefined); // 能力上报失败不阻塞指派处理

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
        await this.deps.client.reportComplete(this.deps.address, item.assignmentId, {
          status: 'completed',
          attempt: 1,
          result: {
            outcome: result.outcome,
            iterations: result.iterations,
            trialRuns: result.trialRuns,
            gateSummary: result.gateSummary,
            effectiveProfile: this.stats.lastEffectiveProfile,
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
      this.working = false;
      this.stats.working = false;
    }
  }
}
