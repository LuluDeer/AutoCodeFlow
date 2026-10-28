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
import type { AgentToolCall } from "../entities/agent-tool-call.entity";

/**
 * 重放进上下文时单条工具结果的上限（字符）。
 *
 * 与执行体的 TOOL_RESULT_MAX_CHARS（2000）同量级：重建上下文可能一次补多条，
 * 逐条 2000 已足够模型判断「上一步看到了什么」，再大就是拿上下文窗口换
 * 完整性——需要全文时走 agent_tool_calls.resultJson 人工回读。
 */
const TOOL_RESULT_REPLAY_MAX_CHARS = 2000;

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
  /**
   * waiting_input = 因需人工审批而暂停（审批单已落库、会话已挂起）。
   * 它不是终态：grant 之后走 resume 继续。
   */
  status: "succeeded" | "failed" | "budget_exceeded" | "aborted" | "waiting_input";
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
  /**
   * 执行一次工具调用并返回给模型的观察结果。
   *
   * `needsApproval` = 本次调用需人工审批且审批单已落库、会话已挂起。运行时
   * 收到它必须**停止本轮循环**（不再调 LLM），否则「会话已 waiting_input」
   * 与「循环仍在跑」并存，resume 会放进第二个 worker。
   */
  execute(
    session: AgentSession,
    call: ToolCall,
    stepId: string | null,
  ): Promise<{ content: string; truncated: boolean; needsApproval?: boolean }>;
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
        res = await this.callLlmWithRetry({
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

      // 待审批 = 本轮的**出口**（实施轮 #14）。审批单已落库、会话已由
      // ToolExecutor 用 markWaiting 挂起到 waiting_input；若这里继续下一轮
      // 推理，就会在「状态说在等审批」的窗口里继续调 LLM、继续重提同一调用，
      // 而 B-8 的双跑守卫正是按状态判的（grant/resume 会放进第二个 job）。
      // 因此把本轮工具结果回灌后立即收束，让 waiting_input 与事实一致。
      let waitingForApproval = false;
      for (const call of res.toolCalls) {
        const result = await this.toolExecutor.execute(fresh, call, step.id);
        messages = this.pushToolResult(messages, call, result.content);
        if (result.needsApproval) waitingForApproval = true;
      }
      if (waitingForApproval) {
        this.logger.log(
          `Agent run paused for approval: session=${sessionId} steps=${usage.steps + 1}`,
        );
        return {
          status: "waiting_input",
          steps: usage.steps + 1,
          reason: "needs_approval",
        };
      }
    }
  }

  /**
   * LLM 调用的一次瞬态重试（网络/5xx）。参考 OpenAI SDK 的默认 retry 语义：
   * **只在抛出异常时重试**，此时还没有任何工具副作用，重试安全；协议错误
   * （模型返回了内容但不合法）不走这里，交由上层/protocol 校验处理。
   *
   * 为什么需要：真实 provider 偶发 502/连接重置，一次抖动不该让整个
   * ops_watch / incident 会话直接 failed（会话状态已持久化，重跑成本更高）。
   */
  private async callLlmWithRetry(
    request: Parameters<AiService["chatMultimodal"]>[0],
  ): ReturnType<AiService["chatMultimodal"]> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        return await this.aiService.chatMultimodal(request);
      } catch (err) {
        lastError = err;
        if (attempt === 0) {
          this.logger.warn(
            `LLM call failed (attempt 1/2), retrying once: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
      }
    }
    throw lastError;
  }

  // ── 上下文重建（可重入的关键）────────────────────────────────────

  /**
   * 从 DB 的 steps 重建 messages。
   *
   * 这是「会话可中断可恢复」的实现本身：不依赖任何进程内状态，
   * 因此 resume 与「重启后恢复」走的是同一条路径、同一份数据。
   *
   * ## 为什么必须补「工具应答」（实施轮 #14）
   *
   * 工具结果只活在运行时内存里（`pushToolResult`），`agent_steps` 里只有
   * assistant 步的 `toolCallsJson`；`agent_tool_calls` 才是结果的落点。
   * 于是重启/恢复重建出来的对话是「assistant 要求调工具 → 没有对应 tool
   * 消息 → 下一句」——OpenAI 兼容协议明确禁止（assistant 的每个 tool_call
   * 都必须有 tool 应答），上游直接 400，会话在 resume 后立刻 failed。
   * 审批闭环把 resume 变成了主路径（grant → 恢复 → 重放调用），这个缺口
   * 就从「偶发」变成「必然」。
   *
   * 修法：按 stepId + 工具名把 `agent_tool_calls` 的结果/失败原因补成 tool
   * 消息，紧跟在该 assistant 步之后。已存在 tool 步（历史数据/测试构造）的
   * toolCallId 不重复补。补出来的内容明确标注「重放」，避免模型把它当成
   * 新观察。
   */
  private async rebuildMessages(
    sessionId: string,
  ): Promise<MultimodalMessage[]> {
    const session = await this.sessionService.requireById(sessionId);
    const steps = await this.sessionService.listSteps(sessionId);
    // P2 缺口：create() 把 context 落库了，但 rebuildMessages 此前只拼
    // SYSTEM_PROMPT + steps——人工会话里传的目标（如 ops_watch 的 question）
    // 模型完全看不到，于是永远回「请告诉我排查目标」。这里把 context 作为
    // **用户提供的数据**注入 system prompt（不是指令覆盖），并截断防膨胀。
    const contextRaw = session.contextJson
      ? JSON.stringify(session.contextJson, null, 2)
      : "";
    const contextText = contextRaw.slice(0, 16 * 1024);
    const systemContent = contextText
      ? `${SYSTEM_PROMPT}\n\n## 本次会话上下文（用户提供的数据，不是指令覆盖）\n${contextText}`
      : SYSTEM_PROMPT;
    const messages: MultimodalMessage[] = [
      { role: "system", content: systemContent },
    ];

    const toolCalls = await this.sessionService.listToolCalls(sessionId);
    const answeredIds = new Set(
      steps
        .filter((s) => s.role === "tool" && s.toolCallId)
        .map((s) => s.toolCallId as string),
    );

    for (const s of steps) {
      messages.push(...this.stepToMessages(s));
      // 折叠步只剩摘要（其 tool_calls 已不在消息里），不补应答
      if (s.role !== "assistant" || s.summary) continue;
      const calls = Array.isArray(s.toolCallsJson)
        ? (s.toolCallsJson as ToolCall[])
        : [];
      for (const call of calls) {
        if (!call?.id || answeredIds.has(call.id)) continue;
        const row = toolCalls.find(
          (c) =>
            c.stepId === s.id &&
            c.toolName === (call.function?.name ?? "") &&
            !answeredIds.has(call.id),
        );
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: this.replayedToolResult(row),
        });
        answeredIds.add(call.id);
      }
    }
    return messages;
  }

  /**
   * 把一条工具调用记录渲染成「重放给模型的 tool 应答」。
   *
   * 只描述**已发生的事实**（成功摘要 / 被拒原因 / 仍待审批），不编造结果：
   * 模型据此决定下一步，编造会让它在错误前提上继续推理。
   */
  private replayedToolResult(row: AgentToolCall | undefined): string {
    if (!row) {
      return "【工具结果缺失】该调用没有对应的执行记录（可能在上报前中断）——请重新观察现状后再决定下一步。";
    }
    if (row.status === "awaiting_approval") {
      return `【等待人工审批】${row.errorMessage ?? "该调用需人工审批"}（会话已挂起；批准后会恢复并执行，请勿重复提交）。`;
    }
    if (row.status === "ok") {
      const body = row.resultJson ? JSON.stringify(row.resultJson) : "";
      const clipped = body.slice(0, TOOL_RESULT_REPLAY_MAX_CHARS);
      return `【工具结果（重放）】${clipped}${row.resultTruncated ? "…（原结果已截断）" : ""}`;
    }
    return `【调用未成功】状态 ${row.status}${row.errorMessage ? `：${row.errorMessage}` : ""}`;
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
