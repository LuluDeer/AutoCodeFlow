import { Injectable, Logger } from "@nestjs/common";
import {
  AiService,
  type MultimodalMessage,
  type ToolCall,
} from "../../ai/ai.service";
import { AgentSessionService } from "./agent-session.service";
import { AgentBudgetService, DEFAULT_BUDGET } from "./agent-budget.service";
import { planContextWindow, type ContextWindowOptions } from "./agent-context";
import {
  isRetryableLlmError,
  withLlmRetry,
  type LlmRetryOptions,
} from "./agent-llm-retry";
import { recordRuntime } from "../../metrics/runtime-metrics-entry";
import {
  AGENT_TERMINAL_STATUSES,
  type AgentSession,
} from "../entities/agent-session.entity";
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

/** LLM 重试的观测点（scheduled / recovered / exhausted / fatal / deadline / resume_queued）。 */
const LLM_RETRY_METRIC = "autoflow_agent_llm_retry_total";

/**
 * LLM 瞬态耗尽的自动续跑参数（GAP-3 服务端半边）。
 *
 * · 延迟 60s：给 provider 恢复留窗口（比单次退避 8s 长、比墙钟小一个量级）。
 * · 墙钟剩余 < 5min 不续：续跑注定被预算闸门判死，白排一个 job。
 * · 每会话只自动补一次（`autoResumeCount` 条件写，见 claimAutoResume）：
 *   provider 长时间挂时反复排 delayed job = 重试风暴换皮；第二次耗尽如实
 *   failed 交人工/上层。
 */
const RESUME_LLM_DELAY_MS = 60_000;
const RESUME_LLM_MIN_WALL_CLOCK_LEFT_MS = 5 * 60_000;

/**
 * 自动续跑期间会话的挂起原因（`waiting_input.waitingFor`）。
 *
 * 为什么是 waiting_input 而不是先落 failed 再重开：failed 是终态，`run()`
 * 对终态短路、`markRunning` 的 CAS 也排除终态——「落 failed + 排 delayed
 * job」的写法会让 job 回来时**静默什么都不做**（这正是本半成品首版的缺陷）。
 * 挂起是真正可恢复的非终态，且让运维在列表里看到「在等 60s 重试」而不是
 * 「已失败」。
 */
export const AUTO_RESUME_WAITING_FOR = "auto_resume";

/**
 * 一批工具调用里「没有执行」的两种情况与回给模型的应答文本。
 *
 * 为什么必须回一条（而不是静默跳过）：OpenAI 兼容协议要求每个 tool_call
 * 都有 tool 应答，缺一条上游直接 400；而「这批里剩下的没执行」是模型在
 * 恢复后必须知道的事实——否则它会在 resume 时以为那几次也做过了。
 */
const NOT_EXECUTED_TEXT: Record<"approval" | "wall_clock", string> = {
  approval:
    "【未执行】本次调用未执行：同一批调用里前一个工具调用已进入人工审批，" +
    "会话已挂起等待处置（已提交的审批单批准后会自动恢复）。" +
    "如需执行本调用，请在恢复后重新提交。",
  wall_clock:
    "【未执行】本次调用未执行：会话墙钟预算（wallClockMs）已到期，" +
    "平台不再发起新的工具调用（避免在注定失败的会话里继续产生副作用）。" +
    "如需继续，请新建会话或调大预算后重新指派。",
};

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
 * ## 演进（P2 只做骨架时的口径，供对照）
 * P2 只做**循环骨架 + 预算 + 持久化**（`availableTools` 返回空数组，终态即
 * 「模型给出文本结论」），工具集在 P3 接。推理质量轮（2026-10）在此基础上
 * 补三件**只影响「怎么用好同一份预算」、不动闸门与状态机**的事：
 *   · 上下文窗口折叠（`agent-context.ts`，请求侧纯计算，2 §4.3）；
 *   · LLM 分类重试（`agent-llm-retry.ts`，含墙钟截止）；
 *   · 同批调用的挂起语义（一个调用等审批 ⇒ 同批剩余不执行）。
 * 三者的共同纪律：**闸门与终态语义一字不改**——闸门错了是安全事故，
 * 而这三件错了是"会话更容易失败/更贵"，风险量级不同，不能混在一次改动里。
 */

/** 一次循环运行的结果。 */
export interface RunOutcome {
  /**
   * waiting_input = 因需人工审批而暂停（审批单已落库、会话已挂起）。
   * 它不是终态：grant 之后走 resume 继续。
   * running = 本次 run 未执行——会话已被另一个 worker 领走（CAS 输家让位，
   * 或定时扫描撞上在跑会话）。调用方如实记录即可，绝不能当失败处理。
   */
  status:
    | "succeeded"
    | "failed"
    | "budget_exceeded"
    | "aborted"
    | "waiting_input"
    | "running";
  steps: number;
  reason?: string;
}

/**
 * 一次 run 的唤醒凭据。
 *
 * `expectWaitingFor` 只由自动续跑 job 携带（见 agent-job-options.ts）：
 * delayed job 是「对未来某个状态的承诺」，60s 里会话可能已被人工 resume
 * 并转去等审批——此时必须让位，而不是无条件接管。
 */
export interface RunOptions {
  expectWaitingFor?: string;
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

  /**
   * 重试钩子的注入点（生产留空 = 真实时钟 + 真实 sleep）。
   *
   * 为什么做成可写字段而不是构造参数：退避是「只在故障时才走到」的分支，
   * 单测必须能把 1s/2s 的等待钉成 0ms 并逐次断言判据（见 spec）；而它是
   * 运行时的**可观测细节**，不是依赖——走 DI 会给 5 处构造点都加参数，
   * 换不来任何装配收益。同 `setToolExecutor` 的既有做法。
   */
  llmRetryOptions: LlmRetryOptions = {};

  /**
   * 上下文窗口覆盖（不传则每次 run 从配置解析 `agent.context.*`）。
   *
   * 与预算是**两种不同语义**：预算是会话快照（审计要能回答"当时允许多少"），
   * 窗口是运行时调优（模型换代后现场调小即可，不该追溯性影响在跑的会话）。
   */
  contextWindow: Partial<ContextWindowOptions> | null = null;

  /**
   * LLM 瞬态耗尽的自动续跑出队口（GAP-3 服务端半边；可注入，生产由
   * AgentModule 装配为 agent-jobs 的 delayed add，单测注入 jest.fn）。
   *
   * 为什么是可写字段而不是构造注入：直接 @InjectQueue 会把 BullMQ 拖进
   * 全部既有单测的装配面；而 runtime 关心的只是「给我一个能延迟入队的
   * 通道」，与具体队列实现无关——同 setToolExecutor 的注入式装配。
   *
   * 返回入队结果（false = 队列不可用/入队失败），调用方据此决定是否
   * 降级为普通 failed。
   */
  enqueueLlmResume:
    ((sessionId: string, delayMs: number) => Promise<boolean>) | null = null;

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
  async run(sessionId: string, options: RunOptions = {}): Promise<RunOutcome> {
    const session = await this.sessionService.requireById(sessionId);

    // 已是终态 → 不重复运行（幂等）
    if (
      session.status === "succeeded" ||
      session.status === "failed" ||
      session.status === "aborted" ||
      session.status === "budget_exceeded" ||
      // running = 另一个 worker 正在跑（重复 resume 入队 / 定时扫描撞车）。
      // 直接让位：进入循环就是双 LLM 调用 + 工具副作用双份。
      session.status === "running"
    ) {
      this.logger.debug(`run(${sessionId}) skipped — status=${session.status}`);
      return { status: session.status, steps: session.totalSteps };
    }

    // 首次运行置 startedAt；resume 不重置（否则墙钟预算可被无限续命）。
    // CAS 赢家才获得执行凭据：输掉 = 两个 worker 近似同时通过上面的终态
    // 检查（B-8 窗口），对方已把会话置 running——本 job 必须立即让位，
    // 否则「状态说在跑、实际两个循环」的窗口就是真实的双跑（GAP-1）。
    // RT-3：自动续跑的唤醒必须带「我在等什么」，由 CAS 一并校验。裸
    // sessionId 唤醒会在 60s 窗口内接管已转到「等人工审批」的会话，把
    // waiting_input 翻成 running——审批门在模型眼里退化成一次拒绝。
    const claimed = await this.sessionService.markRunning(
      sessionId,
      options.expectWaitingFor,
    );
    if (!claimed) {
      this.logger.warn(
        `run(${sessionId}) lost the markRunning race — another worker owns it`,
      );
      const current = await this.sessionService.requireById(sessionId);
      // pending/终态以外的漂移形态如实回传；pending（刚创建尚未置态）按
      // 让位处理——置态是对方的事，本 job 不再碰状态机。
      return {
        status: current.status,
        steps: current.totalSteps,
      } as RunOutcome;
    }

    let messages = await this.rebuildMessages(sessionId);

    // ── 循环 ────────────────────────────────────────────────────────
    for (;;) {
      // 闸门 1：预算（在循环**开头**——末尾判会让最后一轮副作用已发生）
      const fresh = await this.sessionService.requireById(sessionId);
      // RT-6：循环内复查状态。陈旧 running 清扫（或未来的人工 abort）可能
      // 在上一轮与这一轮之间把会话收敛为终态；此时继续推理会在一个
      // 「已 failed」的会话下继续产生副作用与 steps，而最后的 finish 因
      // 非终态谓词未命中只打一条 debug——状态与事实互相矛盾。
      if (
        (AGENT_TERMINAL_STATUSES as readonly string[]).includes(fresh.status)
      ) {
        this.logger.warn(
          `run(${sessionId}) converged externally mid-loop (${fresh.status}) — ` +
            `stopping before the next turn`,
        );
        return { status: fresh.status, steps: fresh.totalSteps } as RunOutcome;
      }
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

      // 上下文窗口（设计文档 02 §4.3 的滑动窗口）：每轮都基于**完整**历史
      // 重新算一次折叠计划，而不是改写 messages 变量本身——这样崩溃重启/
      // 审批恢复/重复入队的每一次 run 都从同一份事实出发（可重入纪律）。
      const window = this.resolveContextWindow();
      const plan = planContextWindow(messages, window);
      if (plan.foldedMessages > 0) {
        this.logger.debug(
          `Agent context folded: session=${sessionId} folded=${plan.foldedMessages} ` +
            `tokens≈${plan.tokensBefore}→${plan.tokensAfter}`,
        );
      }

      const deadlineAt = this.retryDeadline(fresh);

      let res: Awaited<ReturnType<AiService["chatMultimodal"]>>;
      const t0 = Date.now();
      try {
        res = await this.callLlmWithRetry(
          {
            messages: plan.messages,
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
          },
          deadlineAt,
        );
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        // 模型调用失败 → 记 step 后收敛（不是 budget_exceeded：预算没超，
        // 是链路坏了，两者的运维含义不同）。
        await this.sessionService.appendStep(sessionId, {
          role: "assistant",
          content: `[模型调用失败] ${msg}`,
          latencyMs: Date.now() - t0,
        });
        // ── GAP-3 服务端半边：瞬态耗尽 ≠ 必失败 ──────────────────────
        // 重试耗尽的 502 抖动（预算还剩 20 分钟）与 401 密钥失效收敛为同一
        // 终态，运维含义完全不同——前者等一等就能好。参考 langgraph
        // errors.py：错误「类型」本身携带可续跑语义（GraphBubbleUp 不终局）。
        //
        // 判据三层（缺一不可）：
        //   ① 错误可重试（isRetryableLlmError：5xx/连接类，不含 401/400）；
        //   ② 墙钟还剩 > 5min（否则续跑注定被预算闸门判死，白排一个 job）；
        //   ③ 本会话尚未用掉自动续跑额度（DB 条件写，多副本下只有一个赢家）。
        //
        // 关键：续跑期间会话是 **waiting_input**（auto_resume），不是 failed。
        // failed 是终态——run() 会对它短路、markRunning 的 CAS 也排除它，
        // 于是 delayed job 回来时什么都不做（首版半成品正是踩在这里）。
        const freshAfterFail = await this.sessionService.requireById(sessionId);
        const deadline = this.retryDeadline(freshAfterFail);
        const wallClockLeft = deadline === null ? null : deadline - Date.now();
        if (
          isRetryableLlmError(err) &&
          wallClockLeft !== null &&
          wallClockLeft > RESUME_LLM_MIN_WALL_CLOCK_LEFT_MS &&
          this.enqueueLlmResume !== null
        ) {
          const claimed = await this.sessionService
            .claimAutoResume(sessionId)
            .catch(() => false);
          if (claimed) {
            const enqueued = await this.enqueueLlmResume(
              sessionId,
              RESUME_LLM_DELAY_MS,
            ).catch(() => false);
            // 顺序：先入队、后挂起。反序时若入队失败，会话会永远停在
            // waiting_input 等一个不存在的 job；而这个 60s 的延迟远大于
            // 两条 DB 写的间隔，job 不可能抢在挂起之前开始跑。
            if (enqueued) {
              await this.sessionService.markWaiting(
                sessionId,
                AUTO_RESUME_WAITING_FOR,
              );
              recordRuntime(LLM_RETRY_METRIC, { result: "resume_queued" });
              this.logger.warn(
                `Agent LLM transient failure, auto-resume in ` +
                  `${Math.round(RESUME_LLM_DELAY_MS / 1000)}s: session=${sessionId} err=${msg}`,
              );
              return {
                status: "waiting_input",
                steps: usage.steps + 1,
                reason: `transient, auto-resume queued: ${msg}`,
              };
            }
            // 入队失败：额度已消耗（不再重试入队），如实收敛为 failed。
            // 观测面要能区分「排过但没排上」与「根本没排」。
            await this.sessionService.finish(sessionId, "failed", {
              errorMessage: `LLM call failed (transient; auto-resume enqueue failed): ${msg}`,
            });
            recordRuntime(LLM_RETRY_METRIC, {
              result: "resume_enqueue_failed",
            });
            return {
              status: "failed",
              steps: usage.steps + 1,
              reason: `transient, auto-resume enqueue failed: ${msg}`,
            };
          }
        }
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

      // 工具分级按**本次暴露给模型的定义**取，而不是猜：台账的 tier 决定
      // 保留期（write/dangerous ≥180 天、read 30 天），猜错等于把一次写操作
      // 的审计记录提前 150 天删掉。
      const tierByName = new Map(tools.map((t) => [t.name, t.tier]));

      // ── 工具执行（P3 接入；无 executor 时视为不可用）──
      if (!this.toolExecutor) {
        // P2 未装配工具集：模型要求调工具但我们做不了 → 如实告知并收敛，
        // 不静默忽略（静默会让模型以为调用成功了，然后在错误前提上继续推理）
        for (const call of res.toolCalls) {
          const toolName = call.function?.name ?? "unknown";
          await this.sessionService.recordToolCall({
            sessionId,
            stepId: step.id,
            toolCallId: call.id,
            toolName,
            tier: tierByName.get(toolName) ?? "read",
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
      //
      // 推理质量轮补的第二半：**同一批里后面的调用一律不执行**。
      // 模型可以一次给出多个 tool_calls（并行调用），此前是逐个照跑——
      // 于是「第 2 个调用需审批 → 会话挂起」之后，第 3 个写操作照样执行，
      // 而会话状态已经宣称"在等人工处置"。这是**挂起语义与副作用不一致**：
      // 管理员看到的是一次待审批，实际发生的是"审批之外的另一次写"。
      // 参考 langchain ToolCallLimitMiddleware 的 'end' 语义：限流/中断时
      // 未执行的调用必须各得一条说明性 tool 应答，而不是消失。
      //
      // 同一处还有第二道**批次内**的墙钟闸：预算闸门只在循环开头判，而一批
      // 调用每个最多 60s——十个调用就能跑过墙钟上限，把「35 分钟才死的会话」
      // 变成常态，期间还在持续产生副作用。因此每次执行前重判一次截止时间。
      let waitingForApproval = false;
      for (const call of res.toolCalls) {
        const wallClockExpired =
          deadlineAt !== null && Date.now() >= deadlineAt;
        if (waitingForApproval || wallClockExpired) {
          const toolName = call.function?.name ?? "unknown";
          const reason = waitingForApproval ? "approval" : "wall_clock";
          // 记 denied：它确实没执行，且 denied 不计入速率预算（不会被
          // "等审批"这件与它无关的事拖累配额）。
          await this.sessionService.recordToolCall({
            sessionId,
            stepId: step.id,
            toolCallId: call.id,
            toolName,
            tier: tierByName.get(toolName) ?? "read",
            status: "denied",
            errorMessage: `skipped: ${reason}`,
          });
          messages = this.pushToolResult(
            messages,
            call,
            NOT_EXECUTED_TEXT[reason],
          );
          continue;
        }

        const result = await this.executeToolCallGuarded(fresh, call, step.id);
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
   * 工具执行的兜底收敛（防僵尸会话）。
   *
   * ToolExecutorService 承诺「自身失败收敛为 result」，但它的**前置链**里有
   * 不受它控制的纯计算（审批键的 canonicalJson 递归等）——那类意外异常若
   * 逃到这里，run() 的调用方 AgentProcessor 刻意不重抛（防副作用双份），
   * 会话将永久停在 running：没有任何定时扫描会收走它，运营看板永久红一行。
   *
   * 因此在这里把意外异常收敛为**可判定的失败终态**（记 denied 台账 + tool
   * 应答 + finish(failed)）——与模块纪律「一切失败收敛为可判定终态」一致；
   * 这不是吞错，是把「崩溃」如实变成「该调用失败了、会话结束了」。
   */
  private async executeToolCallGuarded(
    session: AgentSession,
    call: ToolCall,
    stepId: string | null,
  ): Promise<{ content: string; truncated: boolean; needsApproval?: boolean }> {
    const toolName = call.function?.name ?? "unknown";
    try {
      return await this.toolExecutor!.execute(session, call, stepId);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `Agent tool call threw unexpectedly: session=${session.id} tool=${toolName} — ${msg}`,
        err instanceof Error ? err.stack : undefined,
      );
      await this.sessionService
        .recordToolCall({
          sessionId: session.id,
          stepId,
          toolCallId: call.id,
          toolName,
          // RT-5：未知层级按**最长保留期**记（write ≥180 天），不按 read。
          // 猜 read 等于把一次写操作的最后痕迹提前 150 天删掉；猜 write 的
          // 代价只是多留几行。args 仍不落库：这里拿不到脱敏器，宁可少记
          // 也不把可能含凭据的原始参数写进审计表。
          tier: "write",
          args: null,
          status: "error",
          errorMessage: `unexpected: ${msg}`.slice(0, 500),
        })
        .catch(() => undefined);
      return {
        content: `【调用失败】工具执行发生未预期异常：${msg}。请改用其他手段或说明需要人工介入。`,
        truncated: false,
      };
    }
  }

  /**
   * 一次推理调用：**分类重试 + 指数退避 + 墙钟截止**（见 agent-llm-retry.ts）。
   *
   * 重试只在抛出时发生——此时还没有任何工具副作用，重发是安全的；协议错误
   * （模型返回了内容但不合法）不走这里，交由上层/protocol 校验处理。
   *
   * 为什么值得重试：真实 provider 偶发 502/连接重置，一次抖动不该让整个
   * ops_watch / incident 会话直接 failed（会话状态已持久化，重跑成本更高）。
   * 为什么只对一部分错误重试：401/400/422 是确定性失败，重发必然同样失败，
   * 只会把「配置错了」伪装成「偶发抖动」并白烧一次令牌。
   */
  private async callLlmWithRetry(
    request: Parameters<AiService["chatMultimodal"]>[0],
    deadlineAt: number | null,
  ): ReturnType<AiService["chatMultimodal"]> {
    const injected = this.llmRetryOptions;
    let retried = false;

    const res = await withLlmRetry(
      () => this.aiService.chatMultimodal(request),
      {
        ...injected,
        deadlineAt,
        onRetry: (evt) => {
          retried = true;
          recordRuntime(LLM_RETRY_METRIC, { result: "scheduled" });
          this.logger.warn(
            `LLM call failed (attempt ${evt.attempt}/${evt.maxAttempts}), ` +
              `retrying in ${evt.delayMs}ms: ${
                evt.error instanceof Error
                  ? evt.error.message
                  : String(evt.error)
              }`,
          );
          injected.onRetry?.(evt);
        },
        onGiveUp: (info) => {
          recordRuntime(LLM_RETRY_METRIC, { result: info.reason });
          if (info.reason !== "fatal") {
            // fatal 的成因（密钥失效/参数错）由上层收敛为 failed 并落库，
            // 这里不重复记 —— 重试相关的「试过几次才放弃」才是本指标的语义。
            this.logger.warn(
              `LLM call gave up after ${info.attempts} attempt(s): ${info.reason}`,
            );
          }
          injected.onGiveUp?.(info);
        },
      },
    );
    if (retried) recordRuntime(LLM_RETRY_METRIC, { result: "recovered" });
    return res;
  }

  /**
   * 重试的墙钟截止（epoch ms；null = 不设）。
   *
   * 会话预算是硬闸门（`startedAt + wallClockMs`），而重试发生在两道闸门之间：
   * 若「睡完这一觉」预算已到期，重试注定被下一轮闸门判死——白等几秒还白烧
   * 一次调用。故把截止时间交给重试层，让它提前收手。
   */
  private retryDeadline(session: AgentSession): number | null {
    if (!session.startedAt) return null;
    const wallClockMs = Number(
      (session.budgetJson as { wallClockMs?: unknown } | null)?.wallClockMs ??
        DEFAULT_BUDGET.wallClockMs,
    );
    if (!Number.isFinite(wallClockMs) || wallClockMs <= 0) return null;
    return new Date(session.startedAt).getTime() + wallClockMs;
  }

  /** 上下文窗口策略：显式覆盖优先，否则读配置（每轮实时解析）。 */
  private resolveContextWindow(): Partial<ContextWindowOptions> {
    if (this.contextWindow) return this.contextWindow;
    return this.budgetService.resolveContextWindow();
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
    // 按 tool_call id 建索引：一个 assistant 步可以带**多个同名**调用
    // （模型并行查两次 get_execution 是常见形态），只按 (stepId, toolName)
    // 匹配会让两次重放拿到**同一行**结果——模型因此认为"两次查询答案一样"，
    // 而实际上第二行记录从未被读。call id 是唯一能区分它们的键。
    const rowByCallId = new Map<string, AgentToolCall>();
    for (const row of toolCalls) {
      if (row.toolCallId) rowByCallId.set(row.toolCallId, row);
    }
    // 存量行（迁移前没有 toolCallId）按名字兜底时，一行只能用一次。
    const consumedRowIds = new Set<string>();

    for (const s of steps) {
      messages.push(...this.stepToMessages(s));
      // 折叠步只剩摘要（其 tool_calls 已不在消息里），不补应答
      if (s.role !== "assistant" || s.summary) continue;
      const calls = Array.isArray(s.toolCallsJson)
        ? (s.toolCallsJson as ToolCall[])
        : [];
      for (const call of calls) {
        if (!call?.id || answeredIds.has(call.id)) continue;
        const row = this.pickReplayRow(
          s,
          call,
          toolCalls,
          rowByCallId,
          consumedRowIds,
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
   * 为一条待重放的 tool_call 找它的执行记录。
   *
   * 优先按 `toolCallId`（写入侧唯一的可靠关联）；找不到才退回
   * (stepId, 工具名)——那是 `toolCallId` 列存在之前的唯一依据，存量会话
   * 仍在库里，不能因为迁移就把它们判成「结果缺失」。
   */
  private pickReplayRow(
    step: AgentStep,
    call: ToolCall,
    rows: AgentToolCall[],
    rowByCallId: Map<string, AgentToolCall>,
    consumedRowIds: Set<string>,
  ): AgentToolCall | undefined {
    const direct = rowByCallId.get(call.id);
    if (direct) {
      consumedRowIds.add(direct.id);
      return direct;
    }
    const toolName = call.function?.name ?? "";
    const fallback = rows.find(
      (r) =>
        r.stepId === step.id &&
        r.toolName === toolName &&
        !consumedRowIds.has(r.id),
    );
    if (fallback) consumedRowIds.add(fallback.id);
    return fallback;
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
