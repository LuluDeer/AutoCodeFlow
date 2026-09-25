import { Injectable, Logger } from "@nestjs/common";
import {
  AiService,
  type MultimodalMessage,
  type ToolCall,
} from "../../ai/ai.service";
import { AgentSessionService } from "./agent-session.service";
import { AgentBudgetService } from "./agent-budget.service";
import type { AgentSession } from "../entities/agent-session.entity";
import type { AgentStep } from "../entities/agent-step.entity";

/**
 * P2：Agent 推理循环（设计文档 02 §4）。
 *
 * 这是「Agent 是进程，不是函数」的落地处：多轮 tool-calling，直到模型不再
 * 要求调工具（给出结论）或触达闸门。
 *
 * ## 可重入是硬要求
 * `run()` 可能被中断在任何一步之后：
 *   · `waiting_input` 挂起（等审批 / 等澄清）后 resume；
 *   · admin-api 重启。
 * 因此**每次进入循环都从 DB 重建 messages**（listSteps），而不是依赖内存
 * 里的数组。这也是 steps 必须全量落库的原因。
 *
 * ## 为什么闸门在循环开头而不是末尾
 * 若在末尾判定，最后一轮已经产生了副作用（可能已经调了工具、改了生产配置），
 * 闸门就形同虚设。开头判定保证「超限即不再发起新的推理与工具调用」。
 *
 * ## P2 范围（刻意的）
 * 本阶段只做**循环骨架 + 预算 + 持久化**，工具集在 P3 接入。因此现在
 * `availableTools` 返回空数组，循环的终态即「模型给出文本结论」。
 * 这样 P2 可以先独立验证「LLM 能长驻、能多轮、能被闸门管住」，而不必
 * 同时承担工具边界（P3）的风险——风险拆开，是这两阶段分界的本意。
 */

/** 一次循环运行的结果。 */
export interface RunOutcome {
  status: "succeeded" | "failed" | "budget_exceeded" | "aborted";
  steps: number;
  reason?: string;
}

/** 提供给循环的工具（P3 接入真实实现）。 */
export interface AgentToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  /** 分级——P3 的边界闸门据此判定是否需审批。 */
  tier: "read" | "write" | "dangerous";
}

/**
 * 工具执行器接口（P3 实现）。
 *
 * 为什么现在就用接口而不是直接留 TODO：循环与工具是**两个独立变化的维度**
 * ——循环关心「怎么多轮、怎么记账、怎么收口」，工具关心「能做什么、边界在哪」。
 * 用接口切开后，P3 实现边界闸门时不需要改动循环逻辑，也就不会把 P2 已
 * 验证过的可重入/预算语义重新搅乱。
 */
export interface AgentToolExecutor {
  /** 本次会话可用的工具（受 kind 白名单 + scope 约束）。 */
  availableTools(session: AgentSession): Promise<AgentToolDefinition[]>;
  /** 执行一次工具调用并返回给模型的观察结果。 */
  execute(
    session: AgentSession,
    call: ToolCall,
    stepId: string | null,
  ): Promise<{ content: string; truncated: boolean }>;
}

/** 系统提示词——定义 Agent 的角色与**边界纪律**。 */
const SYSTEM_PROMPT = [
  "你是 AutoCodeFlow 平台的中台运维 Agent。",
  "你的职责是排查环境异常、分析执行失败、协助维护自动化应用。",
  "",
  "工作纪律：",
  "1. 先观察再行动：优先用只读工具了解现状，不要凭猜测下结论。",
  "2. 每次只做必要的事：不要为了「保险」而重复调用同一个工具。",
  "3. 有结论就给结论：如果证据已足够，直接输出结论，不要继续调用工具。",
  "4. 说清不确定性：证据不足时明确说明「需要什么信息才能判断」，不要编造。",
  "5. 工具被拒是正常反馈：被拒绝时换一条路径，不要反复重试同一个调用。",
  "",
  "输出要求：结束时用简洁的中文给出结论与建议的操作。",
].join("\n");

@Injectable()
export class AgentRuntimeService {
  private readonly logger = new Logger(AgentRuntimeService.name);

  /** P3 会注入真实实现；P2 保持 null（无工具，纯文本推理）。 */
  private toolExecutor: AgentToolExecutor | null = null;

  constructor(
    private readonly sessionService: AgentSessionService,
    private readonly budgetService: AgentBudgetService,
    private readonly aiService: AiService,
  ) {}

  /** P3 装配点：注入工具执行器。 */
  setToolExecutor(executor: AgentToolExecutor): void {
    this.toolExecutor = executor;
  }

  /**
   * 运行（或恢复）一个会话，直到终态。
   *
   * 幂等性：已是终态的会话直接返回——重复入队（resume 与定时扫描撞车）
   * 不会重复执行。
   */
  async run(sessionId: string): Promise<RunOutcome> {
    const session = await this.sessionService.requireById(sessionId);

    // 已是终态 → 不重复运行（幂等）
    if (
      session.status === "succeeded" ||
      session.status === "failed" ||
      session.status === "aborted" ||
      session.status === "budget_exceeded"
    ) {
      this.logger.debug(
        `run(${sessionId}) skipped — terminal (${session.status})`,
      );
      return { status: session.status, steps: session.totalSteps };
    }

    // 首次运行置 startedAt；resume 不重置（否则墙钟预算可被无限续命）
    await this.sessionService.markRunning(sessionId);

    let messages = await this.rebuildMessages(sessionId);

    // ── 循环 ────────────────────────────────────────────────────────
    for (;;) {
      // 闸门 1：预算（在循环**开头**——末尾判会让最后一轮副作用已发生）
      const fresh = await this.sessionService.requireById(sessionId);
      const usage = await this.sessionService.getUsage(fresh);
      const verdict = this.budgetService.check(fresh.budgetJson, usage);
      if (!verdict.ok) {
        await this.sessionService.finish(sessionId, "budget_exceeded", {
          errorMessage: verdict.message,
          summary: `预算触顶（${verdict.kind}）`,
        });
        return {
          status: "budget_exceeded",
          steps: usage.steps,
          reason: verdict.message,
        };
      }

      // ── 推理 ──
      const tools = this.toolExecutor
        ? await this.toolExecutor.availableTools(fresh)
        : [];

      let res: Awaited<ReturnType<AiService["chatMultimodal"]>>;
      const t0 = Date.now();
      try {
        res = await this.aiService.chatMultimodal({
          messages,
          tools:
            tools.length > 0
              ? tools.map((t) => ({
                  type: "function" as const,
                  function: {
                    name: t.name,
                    description: t.description,
                    parameters: t.parameters,
                  },
                }))
              : undefined,
        });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        // 模型调用失败 → 记 step 后收敛为 failed（不是 budget_exceeded：
        // 预算没超，是链路坏了，两者的运维含义不同）
        await this.sessionService.appendStep(sessionId, {
          role: "assistant",
          content: `[模型调用失败] ${msg}`,
          latencyMs: Date.now() - t0,
        });
        await this.sessionService.finish(sessionId, "failed", {
          errorMessage: `LLM call failed: ${msg}`,
        });
        return { status: "failed", steps: usage.steps + 1, reason: msg };
      }

      const latencyMs = Date.now() - t0;

      // provider/model 逐条记录：Agent 可能混合模型（日常推理用便宜的，
      // 看录屏切 qwen-vl），出问题时「这一步是谁答的」决定排查方向。
      // 解析交给 AiService（它是路由的权威）——调用方复刻一份必然漂移。
      const route = await this.aiService.getActiveRoute();

      const step = await this.sessionService.appendStep(sessionId, {
        role: "assistant",
        content: res.content || null,
        toolCallsJson: res.toolCalls ?? null,
        tokensIn: res.usage.tokensIn,
        tokensOut: res.usage.tokensOut,
        latencyMs,
        provider: route.provider,
        model: route.model,
      });

      // 把 assistant 消息放进上下文（下一轮要能看到自己说了什么）
      messages = this.pushAssistant(messages, res.content, res.toolCalls);

      // ── 终态判定：模型不再要求调工具 = 给出结论 ──
      if (!res.toolCalls || res.toolCalls.length === 0) {
        const summary = this.summarize(res.content);
        await this.sessionService.finish(sessionId, "succeeded", {
          result: { conclusion: res.content },
          summary,
        });
        return { status: "succeeded", steps: usage.steps + 1 };
      }

      // ── 工具执行（P3 接入；无 executor 时视为不可用）──
      if (!this.toolExecutor) {
        // P2 未装配工具集：模型要求调工具但我们做不了 → 如实告知并收敛，
        // 不静默忽略（静默会让模型以为调用成功了，然后在错误前提上继续推理）
        for (const call of res.toolCalls) {
          await this.sessionService.recordToolCall({
            sessionId,
            stepId: step.id,
            toolName: call.function?.name ?? "unknown",
            tier: "read",
            status: "denied",
            errorMessage: "tool execution not available (P2: no toolset wired)",
          });
          messages = this.pushToolResult(
            messages,
            call,
            "工具执行不可用：当前运行时未装配工具集。",
          );
        }
        continue;
      }

      for (const call of res.toolCalls) {
        const result = await this.toolExecutor.execute(fresh, call, step.id);
        messages = this.pushToolResult(messages, call, result.content);
      }
    }
  }

  // ── 上下文重建（可重入的关键）────────────────────────────────────

  /**
   * 从 DB 的 steps 重建 messages。
   *
   * 这是「会话可中断可恢复」的实现本身：不依赖任何进程内状态，
   * 因此 resume 与「重启后恢复」走的是同一条路径、同一份数据。
   */
  private async rebuildMessages(
    sessionId: string,
  ): Promise<MultimodalMessage[]> {
    const steps = await this.sessionService.listSteps(sessionId);
    const messages: MultimodalMessage[] = [
      { role: "system", content: SYSTEM_PROMPT },
    ];

    for (const s of steps) {
      messages.push(...this.stepToMessages(s));
    }
    return messages;
  }

  private stepToMessages(step: AgentStep): MultimodalMessage[] {
    // 已折叠的步改用摘要（上下文窗口管理，设计文档 02 §4.3）
    if (step.summary && step.role !== "system") {
      return [
        {
          role: step.role === "tool" ? "user" : (step.role as "assistant"),
          content: `[阶段小结] ${step.summary}`,
        },
      ];
    }

    if (step.role === "tool") {
      return [
        {
          role: "tool",
          content: step.content ?? "",
          tool_call_id: step.toolCallId ?? undefined,
        },
      ];
    }

    if (step.role === "assistant") {
      return [
        {
          role: "assistant",
          content: step.content ?? "",
          tool_calls: (step.toolCallsJson as ToolCall[] | null) ?? undefined,
        },
      ];
    }

    return [{ role: step.role as "user", content: step.content ?? "" }];
  }

  private pushAssistant(
    messages: MultimodalMessage[],
    content: string,
    toolCalls?: ToolCall[],
  ): MultimodalMessage[] {
    return [
      ...messages,
      { role: "assistant", content: content ?? "", tool_calls: toolCalls },
    ];
  }

  private pushToolResult(
    messages: MultimodalMessage[],
    call: ToolCall,
    content: string,
  ): MultimodalMessage[] {
    return [...messages, { role: "tool", content, tool_call_id: call.id }];
  }

  // ── 辅助 ────────────────────────────────────────────────────────

  /** 摘要：取结论首段，截断到 200 字符（通知渠道用）。 */
  private summarize(content: string | null | undefined): string | null {
    if (!content) return null;
    const firstLine = content
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0)[0];
    if (!firstLine) return null;
    return firstLine.length > 200 ? `${firstLine.slice(0, 200)}…` : firstLine;
  }
}
