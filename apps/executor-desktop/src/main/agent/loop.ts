/**
 * P7a（agent-and-deployment）：执行器 Agent 的迭代循环骨架（07 §7）。
 *
 * ## 它是什么
 * 「感知 → 规划 → 试跑 → 诊断」的状态机外壳。**刻意不含** LLM 调用与
 * 真实试跑执行——它们由 `runtime.ts`（P7a 后续批次）以依赖注入方式接进来。
 *
 * 为什么先做纯状态机：循环的控制流（何时停、何时间中台、何时算失败）
 * 是 ADR-022 里**安全相关**的部分，而 LLM/试跑是能力部分。把控制流做成
 * 不依赖 Electron、不依赖网络、不依赖模型的纯函数，它就能在 `test:main`
 * 里被完整断言——这正是本项目既有 pure-module 惯例（path-domain /
 * config-sanitize / permission-profile）的理由。
 *
 * ## 三条纪律
 * 1. **每一步之前先过闸门**（gates.ts 头注纪律 1：末判 = 失效）。
 * 2. **试跑必须先看档位**（`allowsTrialRun`）：档位是 ADR-022 的载体，
 *    绕过它直接试跑等于让「codeExecution=off」形同虚设——而 off 档正是
 *    高合规企业唯一会选的档。
 * 3. **终止是合法终态，不是异常**：触顶/档位拒绝都返回完整 `AgentLoopResult`
 *    带上 `stopReason`，供上报中台。抛异常会让中台把「做不了」误读成「崩了」。
 *
 * ## 澄清语义（04 §3）
 * 循环遇到「SOP 不清楚」时**不自行猜测**，而是产出 `needs_clarification`
 * 让调用方去问中台；澄清轮次触顶则转人工（`escalate`），**不再起会话**
 * （两个 Agent 的礼貌循环是真实风险，P6 已在中台侧设硬闸）。
 */

import {
  allowsTrialRun,
  type EffectiveAgentPermissions,
} from './permission-profile';
import {
  checkGate,
  normalizeLimits,
  recordAction,
  summarizeGates,
  type GateCounters,
  type GateLimits,
  type GateSnapshot,
  type GateStopReason,
} from './gates';
import type { EnvironmentReport } from './perception';
/** 一步的处置（诊断结论 → 下一步动作）。 */
export type LoopNextAction =
  /** 继续下一轮（改代码 → 回试跑）。 */
  | 'retry'
  /** 需要问中台（SOP 不清 / 环境缺能力 / 验收自相矛盾）。 */
  | 'needs_clarification'
  /** 转人工（轮次触顶或能力超出）。 */
  | 'escalate'
  /** 达成验收，交付候选应用。 */
  | 'deliver';

/** 循环终态。 */
export type LoopOutcome =
  | 'delivered'
  | 'clarification_requested'
  | 'escalated'
  | 'gate_stopped'
  | 'permission_denied'
  | 'error';

/** 注入的执行体：循环只调这些，不知道它们是 LLM 还是本地函数。 */
export interface LoopHandlers {
  /** 规划：读 SOP + 环境报告 → 产出候选实现（源码文本或方案描述）。 */
  plan: (input: { iteration: number; environment: EnvironmentReport; feedback: TrialOutcome | null }) => Promise<string>;
  /** 试跑：在 workspace 沙箱内执行候选实现。返回观察结果。 */
  trialRun: (input: { iteration: number; candidate: string }) => Promise<TrialOutcome>;
  /** 诊断：失败 → 判定下一步动作。 */
  diagnose: (input: { iteration: number; candidate: string; trial: TrialOutcome }) => Promise<LoopNextAction>;
  /** 验收自检（SOP 的 acceptance）。 */
  verify: (input: { iteration: number; candidate: string }) => Promise<boolean>;
}

export interface TrialOutcome {
  ok: boolean;
  /** 失败/成功的观察文本（会进 LLM 上下文，调用方负责脱敏与截断）。 */
  output: string;
}

export interface AgentLoopResult {
  outcome: LoopOutcome;
  /** 终态原因（gate_stopped / permission_denied 时必填）。 */
  stopReason?: GateStopReason | 'trial_run_not_permitted';
  stopMessage?: string;
  iterations: number;
  trialRuns: number;
  clarifications: number;
  /**
   * 闸门原始计数（P7d）：调用方持久化后传回 `input.counters`，澄清续跑
   * 与崩溃恢复的预算因此跨运行连续——墙钟「自首次迭代起算，resume 不重置」
   * 的纪律靠它落地，否则每次续跑都是一次清零。
   */
  counters: GateCounters;
  /** 要发给中台的澄清问题（outcome=clarification_requested 时非空）。 */
  pendingQuestion?: string;
  /** 最终候选实现（outcome=delivered 时为通过验收的版本）。 */
  candidate?: string;
  /** 闸门摘要，随回报一并上报（中台据此判断换机器是否有意义）。 */
  gateSummary: ReturnType<typeof summarizeGates>;
}

export interface AgentLoopInput {
  environment: EnvironmentReport;
  permissions: EffectiveAgentPermissions;
  handlers: LoopHandlers;
  counters?: GateCounters;
  limits?: Partial<GateLimits> | null;
  now?: () => number;
}

function stopped(
  snapshot: GateSnapshot,
  counters: GateCounters,
  reason: GateStopReason,
  message: string,
  now: number,
): AgentLoopResult {
  return {
    outcome: 'gate_stopped',
    stopReason: reason,
    stopMessage: message,
    iterations: counters.iterations,
    trialRuns: counters.trialRuns,
    clarifications: counters.clarifications,
    counters,
    gateSummary: summarizeGates(snapshot, now),
  };
}

/**
 * 跑一次执行器 Agent 迭代循环（07 §7）。
 *
 * 结构化：每一轮 = 闸门判定（iterate）→ 规划 → 闸门判定（trial_run）
 * + 档位判定 → 试跑 → 验收 → 诊断。任一环节触顶/被拒都返回完整结果，
 * **不抛**（除 handler 自身抛错，那由本函数收敛为 outcome='error'）。
 */
export async function runAgentLoop(input: AgentLoopInput): Promise<AgentLoopResult> {
  const now = input.now ?? Date.now;
  const limits = normalizeLimits(input.limits);
  let counters: GateCounters =
    input.counters ?? { iterations: 0, clarifications: 0, trialRuns: 0, dependencyInstalls: 0, startedAt: 0 };
  const snapshot = (): GateSnapshot => ({ counters, limits });

  let feedback: TrialOutcome | null = null;

  try {
    for (;;) {
      const t = now();

      // ── ① 迭代闸门（动作之前判）─────────────────────────────────────
      const gate = checkGate(snapshot(), 'iterate', t);
      if (!gate.allowed) {
        return stopped(snapshot(), counters, gate.reason, gate.message, t);
      }
      counters = recordAction(counters, 'iterate', t);
      const iteration = counters.iterations;

      // ── ② 规划 ──────────────────────────────────────────────────────
      const candidate = await input.handlers.plan({ iteration, environment: input.environment, feedback });
      if (typeof candidate !== 'string' || candidate.trim() === '') {
        return {
          ...stopped(snapshot(), counters, 'iteration_limit', '', t),
          outcome: 'error',
          stopMessage: 'plan() 返回空候选（无法继续）',
        };
      }

      // ── ③ 试跑闸门 + 档位判定 ────────────────────────────────────────
      //    两道独立的闸：闸门管"次数"，档位管"允许不允许"。只查其中一道
      //    都会漏——档位 off 时次数再富余也不该跑，次数打满时档位再宽也不该跑。
      const trialGate = checkGate(snapshot(), 'trial_run', t);
      if (!trialGate.allowed) {
        return stopped(snapshot(), counters, trialGate.reason, trialGate.message, t);
      }
      if (!allowsTrialRun(input.permissions)) {
        return {
          outcome: 'permission_denied',
          stopReason: 'trial_run_not_permitted',
          stopMessage: `当前权限档位不允许试跑（codeExecution=${input.permissions.codeExecution}）`,
          iterations: counters.iterations,
          trialRuns: counters.trialRuns,
          clarifications: counters.clarifications,
          counters,
          candidate,
          gateSummary: summarizeGates(snapshot(), t),
        };
      }

      counters = recordAction(counters, 'trial_run', t);
      const trial = await input.handlers.trialRun({ iteration, candidate });
      feedback = trial;

      // ── ④ 验收自检 ──────────────────────────────────────────────────
      const passed = trial.ok && (await input.handlers.verify({ iteration, candidate }));
      if (passed) {
        return {
          outcome: 'delivered',
          iterations: counters.iterations,
          trialRuns: counters.trialRuns,
          clarifications: counters.clarifications,
          counters,
          candidate,
          gateSummary: summarizeGates(snapshot(), now()),
        };
      }

      // ── ⑤ 诊断 ──────────────────────────────────────────────────────
      const next = await input.handlers.diagnose({ iteration, candidate, trial });

      if (next === 'deliver') {
        return {
          outcome: 'delivered',
          iterations: counters.iterations,
          trialRuns: counters.trialRuns,
          clarifications: counters.clarifications,
          counters,
          candidate,
          gateSummary: summarizeGates(snapshot(), now()),
        };
      }

      if (next === 'needs_clarification' || next === 'escalate') {
        // 澄清闸门：触顶即转人工（**不再**占用一次澄清、也不再循环）
        const cg = checkGate(snapshot(), 'clarify', t);
        if (!cg.allowed) {
          return {
            outcome: 'escalated',
            stopReason: cg.reason,
            stopMessage: `${cg.message}——转人工上报`,
            iterations: counters.iterations,
            trialRuns: counters.trialRuns,
            clarifications: counters.clarifications,
            counters,
            candidate,
            gateSummary: summarizeGates(snapshot(), t),
          };
        }
        counters = recordAction(counters, 'clarify', t);
        if (next === 'escalate') {
          return {
            outcome: 'escalated',
            iterations: counters.iterations,
            trialRuns: counters.trialRuns,
            clarifications: counters.clarifications,
            counters,
            candidate,
            gateSummary: summarizeGates(snapshot(), now()),
          };
        }
        return {
          outcome: 'clarification_requested',
          iterations: counters.iterations,
          trialRuns: counters.trialRuns,
          clarifications: counters.clarifications,
          counters,
          candidate,
          pendingQuestion: `第 ${counters.clarifications} 轮澄清：候选实现未通过验收，需要中台补充 SOP 信息`,
          gateSummary: summarizeGates(snapshot(), now()),
        };
      }

      // next === 'retry' → 继续下一轮（feedback 已置位，plan 会拿到）
    }
  } catch (err) {
    const t = now();
    return {
      outcome: 'error',
      stopMessage: err instanceof Error ? err.message : String(err),
      iterations: counters.iterations,
      trialRuns: counters.trialRuns,
      clarifications: counters.clarifications,
      counters,
      gateSummary: summarizeGates(snapshot(), t),
    };
  }
}
