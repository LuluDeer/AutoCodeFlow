import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { AgentBudget } from "../entities/agent-session.entity";
import { recordRuntime } from "../../metrics/runtime-metrics-entry";

/**
 * P2：预算闸门（设计文档 02 §5.3）。
 *
 * ## 为什么需要它
 * Agent 是**自主**的——它会自己决定跑多少轮、调多少工具。没有硬闸门，
 * 一个陷入循环的会话可以：
 *   · 烧掉大量令牌（成本事故）；
 *   · 占满 worker（影响主链资源）；
 *   · 对目标系统产生大量重复操作（`trigger_task` 被连调 500 次）。
 *
 * 因此预算是**代码层强制**的，不是靠 prompt 叮嘱模型「请节约」。
 *
 * ## 为什么预算是快照而非实时读配置
 * 预算是**创建时快照**语义：管理员事后调小全局上限，不应该追溯性地让正在
 * 跑的会话突然超限失败；反之调大也不该让旧会话「复活」。快照同时让事后
 * 审计能看到「当时允许多少」。
 *
 * ## 默认值（可经 agent.budget.* 配置覆盖）
 * 保守起步——宁可 Agent 慢/少做，不可失控。真实使用后再按数据放宽。
 */

/** 默认预算（设计文档 02 §5.3 的表格）。 */
export const DEFAULT_BUDGET: AgentBudget = {
  /** 单会话最大轮次。 */
  maxSteps: 20,
  /** 单会话最大令牌（in + out 合计）。 */
  maxTokens: 200_000,
  /** 单会话墙钟上限（30 分钟）。 */
  wallClockMs: 30 * 60 * 1000,
  /** 单会话工具调用次数上限。 */
  maxToolCalls: 50,
};

/** 超限原因——用于 status=budget_exceeded 时的 errorMessage 与指标标签。 */
export type BudgetExceedKind =
  "max_steps" | "max_tokens" | "wall_clock" | "max_tool_calls";

export interface BudgetVerdict {
  ok: boolean;
  /** ok=false 时给出具体超限项。 */
  kind?: BudgetExceedKind;
  /** 人可读说明（落 errorMessage）。 */
  message?: string;
}

/** 会话用量快照（调用方从 DB 读，避免本服务持有状态）。 */
export interface BudgetUsage {
  steps: number;
  tokensIn: number;
  tokensOut: number;
  toolCalls: number;
  startedAt: Date | null;
}

@Injectable()
export class AgentBudgetService {
  private readonly logger = new Logger(AgentBudgetService.name);

  constructor(private readonly config: ConfigService) {}

  /**
   * 解析预算：DB/env 配置优先，缺省回落 DEFAULT_BUDGET。
   * 每次创建会话时调用一次，结果作为快照写入 session.budgetJson。
   */
  resolveBudget(): AgentBudget {
    return {
      maxSteps: this.readInt("agent.budget.maxSteps", DEFAULT_BUDGET.maxSteps),
      maxTokens: this.readInt(
        "agent.budget.maxTokens",
        DEFAULT_BUDGET.maxTokens,
      ),
      wallClockMs: this.readInt(
        "agent.budget.wallClockMs",
        DEFAULT_BUDGET.wallClockMs,
      ),
      maxToolCalls: this.readInt(
        "agent.budget.maxToolCalls",
        DEFAULT_BUDGET.maxToolCalls,
      ),
    };
  }

  private readInt(key: string, fallback: number): number {
    const raw = this.config.get<string | number>(key);
    if (raw === undefined || raw === null || raw === "") return fallback;
    const n = typeof raw === "number" ? raw : parseInt(String(raw), 10);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  }

  /**
   * 判定会话是否已触达预算。
   *
   * 调用点：推理循环的**每一轮开头**（不是循环末尾）——若在末尾判定，
   * 最后一轮已经产生了副作用（可能已经调了工具），闸门就形同虚设。
   *
   * 判定顺序刻意固定（steps → tokens → wallClock → toolCalls），使同一份
   * 用量总是得到同一个 kind——便于指标聚合与测试断言稳定。
   */
  check(budget: AgentBudget | null, usage: BudgetUsage): BudgetVerdict {
    const b = budget ?? DEFAULT_BUDGET;

    if (usage.steps >= b.maxSteps) {
      return this.exceeded(
        "max_steps",
        `已达最大轮次上限 ${b.maxSteps}（agents 不会无限尝试）`,
      );
    }

    const totalTokens = usage.tokensIn + usage.tokensOut;
    if (totalTokens >= b.maxTokens) {
      return this.exceeded(
        "max_tokens",
        `已达令牌上限 ${b.maxTokens}（已用 ${totalTokens}）`,
      );
    }

    if (usage.startedAt) {
      const elapsed = Date.now() - usage.startedAt.getTime();
      if (elapsed >= b.wallClockMs) {
        return this.exceeded(
          "wall_clock",
          `已达墙钟上限 ${Math.round(b.wallClockMs / 1000)}s（实际 ${Math.round(elapsed / 1000)}s）`,
        );
      }
    }

    if (usage.toolCalls >= b.maxToolCalls) {
      return this.exceeded(
        "max_tool_calls",
        `已达工具调用上限 ${b.maxToolCalls}`,
      );
    }

    return { ok: true };
  }

  private exceeded(kind: BudgetExceedKind, message: string): BudgetVerdict {
    // 指标埋点：autoflow_agent_budget_exceeded_total{reason}
    // 这是防成本事故的核心观测点——超限激增说明预算设得过紧或 Agent 在绕圈。
    recordRuntime("autoflow_agent_budget_exceeded_total", { reason: kind });
    this.logger.warn(`Agent budget exceeded: ${kind} — ${message}`);
    return { ok: false, kind, message };
  }
}
