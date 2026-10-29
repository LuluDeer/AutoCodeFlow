/**
 * N-03 覆盖率棘轮：`AgentRuntimeService`（P2 推理循环）定向补测。
 *
 * 此前该文件 **0% 覆盖**（11 个函数全未执行），而它是「Agent 是进程，不是函数」
 * 的核心落地处。挑它补测的理由不是行数多，而是它承载三条**只能在运行时暴露**的
 * 不变量：
 *
 *  ① **可重入**：每次进入循环都从 DB 的 steps 重建 messages，而不是复用内存数组。
 *     后果差异很大——依赖内存则 admin-api 重启后 resume 会丢上下文，且
 *     "重启后恢复"与"挂起后 resume"走成两条不同路径（一条对一条错）。
 *  ② **闸门在循环开头**：预算触顶时**不得**再发起新的推理与工具调用。若判在末尾，
 *     最后一轮的副作用（工具已执行、生产配置已改）已经发生，闸门形同虚设。
 *  ③ **模型调用失败 ≠ 预算超限**：两者运维含义不同（链路坏 vs 花超了），
 *     必须收敛为不同终态；混为一谈会让"API key 过期"看起来像"预算用完"。
 *
 * 另测消息重建的**上下文窗口管理**语义（已折叠步用摘要替身、tool 步带
 * tool_call_id 配对）——配错会让模型看到悬空的 tool 响应，直接触发上游 400。
 */
import { AgentRuntimeService } from "./agent-runtime.service";
import type { AgentStep } from "../entities/agent-step.entity";

type Any = Record<string, any>;

const TERMINAL = ["succeeded", "failed", "aborted", "budget_exceeded"];

function harness(
  opts: {
    status?: string;
    steps?: Any[];
    verdict?: { ok: boolean; kind?: string; message?: string };
    llm?: Array<Any | Error>;
    budget?: Any;
    usage?: Partial<Any>;
    context?: Any;
    /** 工具调用台账（rebuildMessages 补 tool 应答的数据源，实施轮 #14）。 */
    toolCallRows?: Any[];
    /** 会话开始时刻（重试截止判定的输入；默认"刚刚开始"）。 */
    startedAt?: Date;
    /** 上下文窗口（推理质量轮）：显式调小以触发折叠。 */
    contextMaxTokens?: number;
    minRecentMessages?: number;
    /** GAP-3：是否赢得自动续跑额度（false = 本会话已用掉/被别的副本抢走）。 */
    claimAutoResume?: boolean;
    /** RT-3：会话当前挂起原因（唤醒凭据比对的输入）。 */
    waitingFor?: string | null;
  } = {},
) {
  const steps = opts.steps ?? [];
  const appended: Any[] = [];
  const finished: Array<{ status: string; patch: Any }> = [];
  const recordedToolCalls: Any[] = [];
  /** markWaiting 的 waitingFor 序列（GAP-3 断言「挂起而非落 failed」）。 */
  const waiting: string[] = [];
  // RT-3：替身必须实现「唤醒凭据」语义（期望 waitingFor 不匹配即 CAS 输）
  const markRunning = jest.fn(
    async (_id: string, expectWaitingFor?: string) =>
      expectWaitingFor === undefined ||
      (session.waitingFor ?? null) === expectWaitingFor,
  );

  const session: Any = {
    id: "sess-1",
    // run() 的真实入口状态：pending（首跑）/ waiting_input（resume）。
    // 旧默认 "running" 是 markRunning 静默 no-op 时代的产物——fence 之后
    // 「入口即 running」= 另一个 worker 在跑，run() 必须让位（GAP-1）。
    status: opts.status ?? "pending",
    totalSteps: steps.length,
    budgetJson: opts.budget ?? null,
    contextJson: opts.context ?? null,
    waitingFor: opts.waitingFor ?? null,
    startedAt: opts.startedAt ?? new Date(),
  };

  const sessionService = {
    requireById: jest.fn(async () => session),
    markRunning,
    listSteps: jest.fn(async () => steps),
    getUsage: jest.fn(async () => ({
      steps: opts.usage?.steps ?? steps.length,
      tokensIn: opts.usage?.tokensIn ?? 0,
      tokensOut: opts.usage?.tokensOut ?? 0,
      wallClockMs: opts.usage?.wallClockMs ?? 0,
      ...opts.usage,
    })),
    appendStep: jest.fn(async (_id: string, input: Any) => {
      appended.push(input);
      return { id: `step-${appended.length}`, ...input };
    }),
    finish: jest.fn(async (_id: string, status: string, patch: Any = {}) => {
      finished.push({ status, patch });
      session.status = status;
    }),
    recordToolCall: jest.fn(async (input: Any) => {
      recordedToolCalls.push(input);
      return input;
    }),
    listToolCalls: jest.fn(async () => opts.toolCallRows ?? []),
    // GAP-3：自动续跑的 DB 条件写额度（默认赢；需要「第二次耗尽」的用例显式置 false）
    claimAutoResume: jest.fn(async () => opts.claimAutoResume ?? true),
    markWaiting: jest.fn(async (_id: string, waitingFor: string) => {
      waiting.push(waitingFor);
      session.status = "waiting_input";
      session.waitingFor = waitingFor;
    }),
  };

  const budgetService = {
    check: jest.fn(() => opts.verdict ?? { ok: true }),
    // 推理质量轮：上下文窗口策略（默认宽松——不折叠；需要折叠的用例显式调小）
    resolveContextWindow: jest.fn(() => ({
      maxTokens: opts.contextMaxTokens ?? 24_000,
      minRecentMessages: opts.minRecentMessages ?? 12,
    })),
  };

  const queue = [...(opts.llm ?? [])];
  const chatMultimodal = jest.fn(async (_req: Any) => {
    const next = queue.shift();
    if (next instanceof Error) throw next;
    return (
      next ?? {
        content: "结论",
        usage: { tokensIn: 1, tokensOut: 1 },
        model: "qwen-vl-max",
      }
    );
  });
  const aiService = {
    chatMultimodal,
    getActiveRoute: jest.fn(async () => ({
      provider: "qwen",
      model: "qwen-vl-max",
    })),
  };

  const service = new AgentRuntimeService(
    sessionService as never,
    budgetService as never,
    aiService as never,
  );
  // 重试的等待一律走注入的 sleep：真实等待（1s→2s）会让每个重试用例白跑
  // 3 秒，而这里要断言的是**判据与间隔**，不是定时器本身。
  service.llmRetryOptions = {
    sleep: async () => undefined,
    random: () => 0.5,
  };

  /** 第 n 次 LLM 调用的请求体（mock.calls 的元组在推断下是空类型，故收口在此）。 */
  const llmCall = (n: number): Any => chatMultimodal.mock.calls[n]?.[0];

  return {
    service,
    session,
    sessionService,
    budgetService,
    aiService,
    appended,
    finished,
    recordedToolCalls,
    waiting,
    chatMultimodal,
    llmCall,
  };
}

const step = (over: Partial<AgentStep> & Any): Any => ({
  id: "st",
  role: "user",
  content: "hi",
  summary: null,
  toolCallId: null,
  toolCallsJson: null,
  ...over,
});

describe("AgentRuntimeService.run —— 幂等与终态", () => {
  it.each(TERMINAL)(
    "已是终态 %s 时直接返回，不重跑、不重复落终态",
    async (status) => {
      const h = harness({ status, steps: [step({}), step({})] });
      const out = await h.service.run("sess-1");

      expect(out).toEqual({ status, steps: 2 });
      expect(h.chatMultimodal).not.toHaveBeenCalled();
      expect(h.sessionService.markRunning).not.toHaveBeenCalled();
      expect(h.finished).toHaveLength(0);
    },
  );

  it("GAP-1 执行凭据：markRunning CAS 输家立即让位——不进循环、不调 LLM（B-8 双跑守卫落地）", async () => {
    // 两个 worker 近似同时通过终态检查的窗口：后到者 markRunning affected=0
    const h = harness({
      status: "waiting_input",
      llm: [
        {
          content: "不该被调用",
          toolCalls: [],
          usage: { tokensIn: 1, tokensOut: 1 },
        },
      ],
    });
    h.sessionService.markRunning.mockResolvedValue(false);
    h.sessionService.requireById.mockResolvedValue({
      ...h.sessionService.requireById(),
      status: "running",
      totalSteps: 3,
    });

    const out = await h.service.run("sess-1");

    // 输家返回「当前归属方状态」，绝不发起推理或工具副作用
    expect(out).toEqual({ status: "running", steps: 3 });
    expect(h.chatMultimodal).not.toHaveBeenCalled();
    expect(h.finished).toHaveLength(0);
  });

  it("GAP-1 执行凭据：running 状态直接让位（定时扫描撞上在跑会话）", async () => {
    const h = harness({ status: "running" });
    const out = await h.service.run("sess-1");
    expect(out).toEqual({ status: "running", steps: 0 });
    expect(h.sessionService.markRunning).not.toHaveBeenCalled();
    expect(h.chatMultimodal).not.toHaveBeenCalled();
  });

  it("模型给出文本结论（无 toolCalls）→ succeeded，并落结论与摘要", async () => {
    const h = harness({
      llm: [
        {
          content: "环境正常，无需处理",
          toolCalls: [],
          usage: { tokensIn: 7, tokensOut: 3 },
        },
      ],
    });
    const out = await h.service.run("sess-1");

    expect(out.status).toBe("succeeded");
    expect(h.finished).toHaveLength(1);
    expect(h.finished[0].status).toBe("succeeded");
    expect(h.finished[0].patch).toMatchObject({
      result: { conclusion: "环境正常，无需处理" },
      summary: "环境正常，无需处理",
    });
    // 逐条记录 provider/model（"这一步是谁答的"决定排查方向）
    expect(h.appended[0]).toMatchObject({
      role: "assistant",
      content: "环境正常，无需处理",
      tokensIn: 7,
      tokensOut: 3,
      provider: "qwen",
      model: "qwen-vl-max",
    });
  });
});

describe("AgentRuntimeService.run —— 闸门在循环开头", () => {
  it("预算触顶时**不发起任何推理与工具调用**（闸门必须先于副作用）", async () => {
    const toolExecute = jest.fn();
    const h = harness({
      verdict: { ok: false, kind: "steps", message: "步骤超限" },
    });
    h.service.setToolExecutor({
      availableTools: jest.fn(async () => [
        {
          name: "read_x",
          description: "d",
          parameters: {},
          tier: "read" as const,
        },
      ]),
      execute: toolExecute,
    });

    const out = await h.service.run("sess-1");

    expect(out).toMatchObject({
      status: "budget_exceeded",
      reason: "步骤超限",
    });
    expect(h.chatMultimodal).not.toHaveBeenCalled();
    expect(toolExecute).not.toHaveBeenCalled();
    expect(h.finished[0]).toMatchObject({
      status: "budget_exceeded",
      patch: { errorMessage: "步骤超限", summary: "预算触顶（steps）" },
    });
  });

  it("每轮都重新判预算（不是只在进入时判一次）", async () => {
    // 第 1 轮放行 → 模型要求调工具；第 2 轮前预算触顶 → 必须停
    let calls = 0;
    const h = harness({
      llm: [
        {
          content: "",
          toolCalls: [
            { id: "c1", function: { name: "read_x", arguments: "{}" } },
          ],
          usage: { tokensIn: 1, tokensOut: 1 },
        },
      ],
    });
    h.budgetService.check.mockImplementation(() => {
      calls += 1;
      return calls >= 2
        ? { ok: false, kind: "wall", message: "墙钟超限" }
        : { ok: true };
    });
    h.service.setToolExecutor({
      availableTools: jest.fn(async () => [
        {
          name: "read_x",
          description: "d",
          parameters: {},
          tier: "read" as const,
        },
      ]),
      execute: jest.fn(async () => ({ content: "ok", truncated: false })),
    });

    const out = await h.service.run("sess-1");
    expect(out.status).toBe("budget_exceeded");
    expect(h.budgetService.check).toHaveBeenCalledTimes(2);
  });
});

describe("AgentRuntimeService.run —— 失败归因不混淆", () => {
  it("模型调用抛错 → failed（不是 budget_exceeded），且把错误记进 step 与终态", async () => {
    const h = harness({
      llm: [new Error("401 invalid api key"), new Error("401 invalid api key")],
    });
    const out = await h.service.run("sess-1");

    expect(out.status).toBe("failed");
    expect(out.reason).toBe("401 invalid api key");
    // 失败也要留 step（可重入重建上下文时能看到"上次是链路坏"）
    expect(h.appended[0].content).toContain(
      "[模型调用失败] 401 invalid api key",
    );
    expect(h.finished[0]).toMatchObject({
      status: "failed",
      patch: { errorMessage: "LLM call failed: 401 invalid api key" },
    });
  });

  it("瞬态失败重试一次后继续（不把一次抖动变成 failed 会话）", async () => {
    const h = harness({
      llm: [
        new Error("ECONNRESET"),
        { content: "ok", toolCalls: [], usage: { tokensIn: 1, tokensOut: 1 } },
      ],
    });
    const out = await h.service.run("sess-1");
    expect(out.status).toBe("succeeded");
    expect(h.chatMultimodal).toHaveBeenCalledTimes(2);
    expect(h.appended[h.appended.length - 1]?.content).toBe("ok");
  });

  it("非 Error 抛出物（字符串/对象）也被如实收敛，不冒泡", async () => {
    const h = harness({
      llm: [new Error("string-ish failure"), new Error("string-ish failure")],
    });
    await expect(h.service.run("sess-1")).resolves.toMatchObject({
      status: "failed",
    });
  });
});

describe("AgentRuntimeService.run —— 工具集未装配时的诚实降级", () => {
  it("模型要求调工具但无 executor → recordToolCall(status=denied) 并如实回灌，不静默忽略", async () => {
    const h = harness({
      llm: [
        {
          content: "",
          toolCalls: [
            { id: "c1", function: { name: "read_x", arguments: "{}" } },
            { id: "c2", function: { name: "write_y", arguments: "{}" } },
          ],
          usage: { tokensIn: 1, tokensOut: 1 },
        },
        {
          content: "无法执行，给出结论",
          toolCalls: [],
          usage: { tokensIn: 1, tokensOut: 1 },
        },
      ],
    });

    const out = await h.service.run("sess-1");

    expect(out.status).toBe("succeeded");
    // 两个调用都必须被记录为 denied（不得静默跳过——静默会让模型以为成功了）
    expect(h.recordedToolCalls).toHaveLength(2);
    expect(h.recordedToolCalls[0]).toMatchObject({
      sessionId: "sess-1",
      stepId: "step-1",
      toolName: "read_x",
      status: "denied",
    });
    expect(h.recordedToolCalls[1].toolName).toBe("write_y");
    // 第二轮 messages 里必须带上"工具执行不可用"的 tool 响应
    const secondCallArgs = h.chatMultimodal.mock.calls[1][0] as Any;
    const toolMsgs = secondCallArgs.messages.filter(
      (m: Any) => m.role === "tool",
    );
    expect(toolMsgs).toHaveLength(2);
    expect(toolMsgs[0].content).toContain("工具执行不可用");
  });

  it("toolCalls 里缺 function.name 时记 unknown（不写 undefined 进库）", async () => {
    const h = harness({
      llm: [
        {
          content: "",
          toolCalls: [{ id: "c1" }],
          usage: { tokensIn: 0, tokensOut: 0 },
        },
        {
          content: "done",
          toolCalls: [],
          usage: { tokensIn: 0, tokensOut: 0 },
        },
      ],
    });
    await h.service.run("sess-1");
    expect(h.recordedToolCalls[0].toolName).toBe("unknown");
  });
});

describe("AgentRuntimeService.run —— 已装配 executor 的正常多轮", () => {
  it("工具结果按 tool_call_id 回灌，模型据此给结论", async () => {
    const execute = jest.fn(async () => ({
      content: "观察：磁盘 82%",
      truncated: false,
    }));
    const h = harness({
      llm: [
        {
          content: "",
          toolCalls: [
            { id: "call-42", function: { name: "read_disk", arguments: "{}" } },
          ],
          usage: { tokensIn: 5, tokensOut: 2 },
        },
        {
          content: "磁盘偏高，建议清理",
          toolCalls: [],
          usage: { tokensIn: 3, tokensOut: 4 },
        },
      ],
    });
    h.service.setToolExecutor({
      availableTools: jest.fn(async () => [
        {
          name: "read_disk",
          description: "读取磁盘",
          parameters: {},
          tier: "read" as const,
        },
      ]),
      execute,
    });

    const out = await h.service.run("sess-1");

    expect(out.status).toBe("succeeded");
    expect(execute).toHaveBeenCalledTimes(1);
    // 工具定义被转成 OpenAI 形态的 function 描述（上游协议要求）
    const firstArgs = h.chatMultimodal.mock.calls[0][0] as Any;
    expect(firstArgs.tools).toEqual([
      {
        type: "function",
        function: {
          name: "read_disk",
          description: "读取磁盘",
          parameters: {},
        },
      },
    ]);
    // 第二轮上下文含 tool 响应且 id 严格配对（错配会被上游拒）
    const secondArgs = h.chatMultimodal.mock.calls[1][0] as Any;
    const toolMsg = secondArgs.messages.find((m: Any) => m.role === "tool");
    expect(toolMsg).toMatchObject({
      content: "观察：磁盘 82%",
      tool_call_id: "call-42",
    });
  });

  it("把 contextJson 注入 system prompt（用户数据，不是指令覆盖）", async () => {
    const h = harness({
      context: { question: "列出所有任务并总结" },
      llm: [
        {
          content: "好的",
          toolCalls: [],
          usage: { tokensIn: 0, tokensOut: 0 },
        },
      ],
    });

    await h.service.run("sess-1");

    const req = h.llmCall(0) as Any;
    const system = req.messages.find((m: Any) => m.role === "system");
    expect(system.content).toContain("列出所有任务并总结");
    expect(system.content).toContain("用户提供的数据，不是指令覆盖");
  });

  it("availableTools 为空数组时不上送 tools 字段（而非上送空数组）", async () => {
    const h = harness({
      llm: [
        {
          content: "无可做",
          toolCalls: [],
          usage: { tokensIn: 0, tokensOut: 0 },
        },
      ],
    });
    h.service.setToolExecutor({
      availableTools: jest.fn(async () => []),
      execute: jest.fn(),
    });
    await h.service.run("sess-1");
    expect(h.llmCall(0).tools).toBeUndefined();
  });
});

describe("AgentRuntimeService —— 上下文重建（可重入的实现本身）", () => {
  it("每轮都从 DB 的 steps 重建；system 提示词恒为第一条", async () => {
    const h = harness({
      steps: [step({ id: "s1", role: "user", content: "看下磁盘" })],
      llm: [
        { content: "好", toolCalls: [], usage: { tokensIn: 0, tokensOut: 0 } },
      ],
    });
    await h.service.run("sess-1");

    const firstArgs = h.chatMultimodal.mock.calls[0][0] as Any;
    expect(firstArgs.messages[0].role).toBe("system");
    expect(firstArgs.messages[0].content).toContain(
      "AutoCodeFlow 平台的中台运维 Agent",
    );
    // 历史步被重建成 user 消息（而非丢失）
    expect(firstArgs.messages[1]).toMatchObject({
      role: "user",
      content: "看下磁盘",
    });
  });

  it("已折叠步（有 summary）用 [阶段小结] 替身，不重复灌原文", async () => {
    const h = harness({
      steps: [
        step({
          id: "s1",
          role: "assistant",
          summary: "已排查磁盘与内存",
          content: "很长的原始推理内容".repeat(50),
        }),
      ],
      llm: [
        {
          content: "结论",
          toolCalls: [],
          usage: { tokensIn: 0, tokensOut: 0 },
        },
      ],
    });
    await h.service.run("sess-1");
    const msgs = h.llmCall(0).messages;
    const folded = msgs.find((m: Any) =>
      String(m.content).includes("[阶段小结]"),
    );
    expect(folded.content).toBe("[阶段小结] 已排查磁盘与内存");
    expect(
      msgs.some((m: Any) => String(m.content).includes("很长的原始推理内容")),
    ).toBe(false);
  });

  it("tool 步折叠后降级为 user 角色（tool 角色缺 tool_call_id 会触发上游 400）", async () => {
    const h = harness({
      steps: [
        step({
          id: "s1",
          role: "tool",
          summary: "工具已返回",
          toolCallId: "c9",
        }),
      ],
      llm: [
        {
          content: "结论",
          toolCalls: [],
          usage: { tokensIn: 0, tokensOut: 0 },
        },
      ],
    });
    await h.service.run("sess-1");
    const msgs = h.llmCall(0).messages;
    const folded = msgs.find((m: Any) =>
      String(m.content).includes("[阶段小结]"),
    );
    expect(folded.role).toBe("user");
  });

  it("未折叠的 tool 步带 tool_call_id 配对；assistant 步带 tool_calls", async () => {
    const h = harness({
      steps: [
        step({ id: "s1", role: "tool", content: "观察结果", toolCallId: "c1" }),
        step({
          id: "s2",
          role: "assistant",
          content: "",
          toolCallsJson: [
            { id: "c1", function: { name: "t", arguments: "{}" } },
          ],
        }),
        step({ id: "s3", role: "system", content: "系统插话" }),
      ],
      llm: [
        {
          content: "结论",
          toolCalls: [],
          usage: { tokensIn: 0, tokensOut: 0 },
        },
      ],
    });
    await h.service.run("sess-1");
    const msgs = h.llmCall(0).messages;

    expect(msgs.find((m: Any) => m.role === "tool")).toMatchObject({
      content: "观察结果",
      tool_call_id: "c1",
    });
    expect(msgs.find((m: Any) => m.role === "assistant")).toMatchObject({
      tool_calls: [{ id: "c1", function: { name: "t", arguments: "{}" } }],
    });
    // role=system 的既有步不得被摘要分支吞掉（摘要分支显式排除 system）
    expect(msgs.filter((m: Any) => m.role === "system")).toHaveLength(2);
  });

  it("resume 与首次运行走同一路径：listSteps 结果决定上下文（无内存残留）", async () => {
    const h = harness({ status: "waiting_input" });
    h.sessionService.listSteps
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        step({ id: "x", role: "user", content: "继续" }),
      ]);
    // 第一次 run 会消费一次（工具未装配、模型直接给结论）
    await h.service.run("sess-1");
    expect(h.sessionService.listSteps).toHaveBeenCalledTimes(1);
  });
});

describe("AgentRuntimeService —— 摘要（通知渠道用）", () => {
  it("取结论首个非空行并截断到 200 字符（附省略号）", async () => {
    const h = harness({
      llm: [
        {
          content: `\n\n   ${"长".repeat(300)}\n第二行不该进摘要`,
          toolCalls: [],
          usage: { tokensIn: 0, tokensOut: 0 },
        },
      ],
    });
    await h.service.run("sess-1");
    const summary = h.finished[0].patch.summary as string;
    expect(summary).toHaveLength(201); // 200 + 省略号
    expect(summary.endsWith("…")).toBe(true);
    expect(summary).not.toContain("第二行");
  });

  it("内容为空/纯空白 → summary 为 null（而非空串：静默成功是刻意语义）", async () => {
    for (const content of ["", "   \n  \n"]) {
      const h = harness({
        llm: [{ content, toolCalls: [], usage: { tokensIn: 0, tokensOut: 0 } }],
      });
      await h.service.run("sess-1");
      expect(h.finished[0].patch.summary).toBeNull();
    }
  });
});

describe("AgentRuntimeService —— 审批闭环执行侧（实施轮 #14）", () => {
  it("工具返回 needsApproval → 本轮立即收束为 waiting_input，不再发起第二轮推理", async () => {
    const h = harness({
      llm: [
        {
          content: "",
          toolCalls: [
            { id: "c1", function: { name: "sop_publish", arguments: "{}" } },
          ],
          usage: { tokensIn: 1, tokensOut: 1 },
        },
        // 若循环没停，这里会被消费（第二轮 LLM 调用）
        {
          content: "第二轮不该发生",
          toolCalls: [],
          usage: { tokensIn: 1, tokensOut: 1 },
        },
      ],
    });
    h.service.setToolExecutor({
      availableTools: jest.fn(async () => []),
      execute: jest.fn(async () => ({
        content: "【需人工审批，已提交审批单】…",
        truncated: false,
        needsApproval: true,
      })),
    });

    const out = await h.service.run("sess-1");

    // waiting_input 不是终态：不写终态、不落 finish（grant 后 resume 继续）
    expect(out).toMatchObject({
      status: "waiting_input",
      reason: "needs_approval",
    });
    expect(h.finished).toHaveLength(0);
    expect(h.chatMultimodal).toHaveBeenCalledTimes(1);
  });

  it("rebuildMessages 为「已发出但没有应答的 tool_call」补 tool 消息（防上游 400）", async () => {
    const h = harness({
      steps: [
        step({
          id: "s1",
          role: "assistant",
          content: "",
          toolCallsJson: [
            { id: "c1", function: { name: "get_task", arguments: "{}" } },
          ],
        }),
      ],
      toolCallRows: [
        {
          stepId: "s1",
          toolName: "get_task",
          status: "ok",
          resultJson: { id: "t-1" },
          resultTruncated: false,
          errorMessage: null,
        },
      ],
      llm: [
        {
          content: "结论",
          toolCalls: [],
          usage: { tokensIn: 0, tokensOut: 0 },
        },
      ],
    });

    await h.service.run("sess-1");
    const msgs = h.llmCall(0).messages;
    const toolMsg = msgs.find((m: Any) => m.role === "tool");
    expect(toolMsg).toMatchObject({ role: "tool", tool_call_id: "c1" });
    expect(String(toolMsg.content)).toContain("工具结果（重放）");
    expect(String(toolMsg.content)).toContain("t-1");
  });

  it("被拒的调用重放时如实说明「已被拒绝」，不让模型以为还能重试", async () => {
    const h = harness({
      steps: [
        step({
          id: "s1",
          role: "assistant",
          content: "",
          toolCallsJson: [
            { id: "c1", function: { name: "update_task", arguments: "{}" } },
          ],
        }),
      ],
      toolCallRows: [
        {
          stepId: "s1",
          toolName: "update_task",
          status: "denied",
          resultJson: null,
          resultTruncated: false,
          errorMessage: "已被 alice 人工拒绝",
        },
      ],
      llm: [
        {
          content: "结论",
          toolCalls: [],
          usage: { tokensIn: 0, tokensOut: 0 },
        },
      ],
    });

    await h.service.run("sess-1");
    const toolMsg = h.llmCall(0).messages.find((m: Any) => m.role === "tool");
    expect(String(toolMsg.content)).toContain("调用未成功");
    expect(String(toolMsg.content)).toContain("已被 alice 人工拒绝");
  });

  it("已有 tool 步的 toolCallId 不重复补（历史数据/自测构造的形态）", async () => {
    const h = harness({
      steps: [
        step({
          id: "s2",
          role: "assistant",
          content: "",
          toolCallsJson: [
            { id: "c1", function: { name: "get_task", arguments: "{}" } },
          ],
        }),
        step({ id: "s3", role: "tool", content: "已有应答", toolCallId: "c1" }),
      ],
      toolCallRows: [
        {
          stepId: "s2",
          toolName: "get_task",
          status: "ok",
          resultJson: { id: "t-1" },
          resultTruncated: false,
          errorMessage: null,
        },
      ],
      llm: [
        {
          content: "结论",
          toolCalls: [],
          usage: { tokensIn: 0, tokensOut: 0 },
        },
      ],
    });

    await h.service.run("sess-1");
    const toolMsgs = h
      .llmCall(0)
      .messages.filter((m: Any) => m.role === "tool");
    expect(toolMsgs).toHaveLength(1);
    expect(toolMsgs[0].content).toBe("已有应答");
  });
});

describe("AgentRuntimeService —— LLM 分类重试（推理质量轮）", () => {
  it("401 是确定性失败：不重试、不白烧第二次调用（重发必然同样失败）", async () => {
    const h = harness({
      llm: [
        new Error("401 invalid api key"),
        {
          content: "不该被消费",
          toolCalls: [],
          usage: { tokensIn: 1, tokensOut: 1 },
        },
      ],
    });

    const out = await h.service.run("sess-1");

    expect(out.status).toBe("failed");
    expect(h.chatMultimodal).toHaveBeenCalledTimes(1);
    expect(h.finished[0].patch).toMatchObject({
      errorMessage: "LLM call failed: 401 invalid api key",
    });
  });

  it("502 是瞬态：退避后重试成功，会话不 failed、也不落失败 step", async () => {
    const badGateway = Object.assign(new Error("bad gateway"), {
      response: { status: 502 },
    });
    const h = harness({
      llm: [
        badGateway,
        {
          content: "结论",
          toolCalls: [],
          usage: { tokensIn: 2, tokensOut: 1 },
        },
      ],
    });

    const out = await h.service.run("sess-1");

    expect(out.status).toBe("succeeded");
    expect(h.chatMultimodal).toHaveBeenCalledTimes(2);
    expect(
      h.appended.filter((s) => String(s.content).includes("[模型调用失败]")),
    ).toHaveLength(0);
  });

  it("重试次数用尽 → failed，只落一条失败 step（可复盘，且不重复记账）", async () => {
    const badGateway = () =>
      Object.assign(new Error("bad gateway"), { response: { status: 502 } });
    const h = harness({
      llm: [badGateway(), badGateway(), badGateway()],
    });

    const out = await h.service.run("sess-1");

    expect(out.status).toBe("failed");
    // 默认策略 3 次尝试（首次 + 2 次重试）
    expect(h.chatMultimodal).toHaveBeenCalledTimes(3);
    expect(h.appended).toHaveLength(1);
  });

  it("墙钟将到期 → 放弃重试（睡完也是被预算闸门判死，白等还白烧一次调用）", async () => {
    const badGateway = Object.assign(new Error("bad gateway"), {
      response: { status: 502 },
    });
    const h = harness({
      // 会话已跑了 30 分钟的 29:59 → 只剩 1 秒，而首次退避要 1 秒 + 抖动
      startedAt: new Date(Date.now() - (30 * 60 * 1000 - 200)),
      budget: {
        maxSteps: 20,
        maxTokens: 1e9,
        wallClockMs: 30 * 60 * 1000,
        maxToolCalls: 50,
      },
      llm: [badGateway, { content: "不该被消费", toolCalls: [], usage: {} }],
    });

    const out = await h.service.run("sess-1");

    expect(out.status).toBe("failed");
    expect(h.chatMultimodal).toHaveBeenCalledTimes(1);
  });
});

describe("AgentRuntimeService —— 上下文窗口折叠（推理质量轮）", () => {
  /** 造 n 轮「用户长文本 + 助手应答」的历史步骤。 */
  const longHistory = (n: number): Any[] => {
    const out: Any[] = [];
    for (let i = 0; i < n; i += 1) {
      out.push(
        step({
          id: `u${i}`,
          role: "user",
          content: `${i} 排查`.padEnd(600, "查"),
        }),
      );
      out.push(step({ id: `a${i}`, role: "assistant", content: "已确认" }));
    }
    return out;
  };

  it("历史超预算 → 请求里是「system + 确定性摘要 + 最近消息」", async () => {
    const steps = longHistory(30);
    const h = harness({
      steps,
      contextMaxTokens: 800,
      minRecentMessages: 4,
      llm: [
        {
          content: "结论",
          toolCalls: [],
          usage: { tokensIn: 1, tokensOut: 1 },
        },
      ],
    });

    await h.service.run("sess-1");
    const msgs = h.llmCall(0).messages;

    expect(msgs[0].role).toBe("system");
    expect(String(msgs[1].content)).toContain("早期对话摘要");
    // 折叠必须真的省了窗口，否则这段代码没有意义
    expect(msgs.length).toBeLessThan(steps.length + 1);
  });

  it("未超预算 → 原样发送（零成本路径，不打扰模型）", async () => {
    const h = harness({
      steps: [step({ id: "u1", role: "user", content: "排查 executor-03" })],
      llm: [
        {
          content: "结论",
          toolCalls: [],
          usage: { tokensIn: 1, tokensOut: 1 },
        },
      ],
    });

    await h.service.run("sess-1");
    const msgs = h.llmCall(0).messages;

    // system + 1 条历史，没有摘要消息插进来
    expect(msgs).toHaveLength(2);
    expect(String(msgs[1].content)).toBe("排查 executor-03");
  });

  it("折叠只影响请求，不改写重建出来的完整历史（下一轮仍以全量为事实）", async () => {
    const steps = longHistory(20);
    const h = harness({
      steps,
      contextMaxTokens: 600,
      minRecentMessages: 2,
      llm: [
        {
          content: "结论",
          toolCalls: [],
          usage: { tokensIn: 1, tokensOut: 1 },
        },
      ],
    });

    await h.service.run("sess-1");

    // 最近一条历史（第 19 轮的助手应答）仍在请求末尾：折叠只吃早期段
    const msgs = h.llmCall(0).messages;
    expect(String(msgs[msgs.length - 1].content)).toBe("已确认");
    // 折叠是**纯读侧**计算：steps 一条都没被删、也没被写上 summary
    // （改写历史等于把审计事实删掉，还会让 resume 看到被篡改的过去）
    expect(steps).toHaveLength(40);
    expect(steps.every((s) => s.summary == null)).toBe(true);
  });
});

describe("AgentRuntimeService —— 同批调用的挂起语义", () => {
  it("某个调用需审批后，同批剩余调用**不再执行**，且各得一条说明性 tool 应答", async () => {
    const execute = jest.fn(async (_session: Any, call: Any) => {
      if (call.id === "c2") {
        return {
          content: "【需人工审批，已提交审批单】…",
          truncated: false,
          needsApproval: true,
        };
      }
      return { content: "ok", truncated: false };
    });

    const h = harness({
      llm: [
        {
          content: "",
          toolCalls: [
            { id: "c1", function: { name: "get_task", arguments: "{}" } },
            { id: "c2", function: { name: "sop_publish", arguments: "{}" } },
            { id: "c3", function: { name: "get_task", arguments: "{}" } },
          ],
          usage: { tokensIn: 1, tokensOut: 1 },
        },
      ],
    });
    h.service.setToolExecutor({
      availableTools: jest.fn(async () => [
        {
          name: "get_task",
          description: "d",
          parameters: {},
          tier: "read" as const,
        },
        {
          name: "sop_publish",
          description: "d",
          parameters: {},
          tier: "write" as const,
        },
      ]),
      execute,
    });

    const out = await h.service.run("sess-1");

    expect(out).toMatchObject({ status: "waiting_input" });
    // 只执行到「进入审批」的那一个为止：c3 绝不能在会话已挂起后还产生副作用
    expect(execute).toHaveBeenCalledTimes(2);
    // 未执行的那一个如实落台账（denied，带 tool_call id + 取自工具定义的分级）
    expect(h.recordedToolCalls).toContainEqual(
      expect.objectContaining({
        toolCallId: "c3",
        toolName: "get_task",
        tier: "read",
        status: "denied",
      }),
    );
  });
});

describe("AgentRuntimeService —— 工具执行意外异常的兜底收敛（防僵尸会话）", () => {
  it("executor.execute 抛出意外异常 → 记台账 + tool 应答 + 继续循环，不炸 run()", async () => {
    const h = harness({
      llm: [
        {
          content: "",
          toolCalls: [
            { id: "c1", function: { name: "get_task", arguments: "{}" } },
          ],
          usage: { tokensIn: 1, tokensOut: 1 },
        },
        // 第二轮：模型收到失败说明后给出结论收尾
        {
          content: "结论",
          toolCalls: [],
          usage: { tokensIn: 1, tokensOut: 1 },
        },
      ],
    });
    h.service.setToolExecutor({
      availableTools: jest.fn(async () => [
        {
          name: "get_task",
          description: "d",
          parameters: {},
          tier: "read" as const,
        },
      ]),
      // 前置链意外崩溃（如审批键的 canonicalJson 爆栈）——executor 自身
      // 承诺收敛，但那类异常发生在它的 try 之外
      execute: jest.fn(async () => {
        throw new RangeError("Maximum call stack size exceeded");
      }),
    });

    const out = await h.service.run("sess-1");

    // 会话得到**可判定的终态**而不是永久卡 running（AgentProcessor 刻意
    // 不重抛，逃出 run() 的异常没有任何清扫机制会收走它）
    expect(out).toMatchObject({ status: "succeeded" });
    // 意外异常落台账（error 状态，带截断的原因）
    expect(h.recordedToolCalls).toContainEqual(
      expect.objectContaining({
        toolCallId: "c1",
        toolName: "get_task",
        status: "error",
      }),
    );
    // 模型拿到的是说明性 tool 应答（指引它换路径而不是盲目重试）
    const secondReq = h.chatMultimodal.mock.calls[1][0] as Any;
    const toolMsg = secondReq.messages.find(
      (m: Any) => m.role === "tool" && m.tool_call_id === "c1",
    );
    expect(String(toolMsg?.content)).toContain("未预期异常");
  });
});

describe("AgentRuntimeService —— 工具结果重放按 tool_call id 对齐", () => {
  it("同一 step 里两个同名调用各自重放自己的结果（不再共用第一行）", async () => {
    const h = harness({
      steps: [
        step({
          id: "s1",
          role: "assistant",
          content: "",
          toolCallsJson: [
            {
              id: "c1",
              function: { name: "get_execution", arguments: '{"id":"e1"}' },
            },
            {
              id: "c2",
              function: { name: "get_execution", arguments: '{"id":"e2"}' },
            },
          ],
        }),
      ],
      toolCallRows: [
        {
          id: "row1",
          stepId: "s1",
          toolCallId: "c1",
          toolName: "get_execution",
          status: "ok",
          resultJson: { executionId: "e1" },
          resultTruncated: false,
          errorMessage: null,
        },
        {
          id: "row2",
          stepId: "s1",
          toolCallId: "c2",
          toolName: "get_execution",
          status: "ok",
          resultJson: { executionId: "e2" },
          resultTruncated: false,
          errorMessage: null,
        },
      ],
      llm: [
        {
          content: "结论",
          toolCalls: [],
          usage: { tokensIn: 1, tokensOut: 1 },
        },
      ],
    });

    await h.service.run("sess-1");
    const toolMsgs = h
      .llmCall(0)
      .messages.filter((m: Any) => m.role === "tool");

    expect(toolMsgs).toHaveLength(2);
    expect(String(toolMsgs[0].content)).toContain("e1");
    expect(String(toolMsgs[1].content)).toContain("e2");
  });

  it("存量行没有 toolCallId 时按 (stepId, 工具名) 兜底，且一行只消费一次", async () => {
    const h = harness({
      steps: [
        step({
          id: "s1",
          role: "assistant",
          content: "",
          toolCallsJson: [
            { id: "c1", function: { name: "get_task", arguments: "{}" } },
            { id: "c2", function: { name: "get_task", arguments: "{}" } },
          ],
        }),
      ],
      toolCallRows: [
        {
          id: "row1",
          stepId: "s1",
          toolCallId: null,
          toolName: "get_task",
          status: "ok",
          resultJson: { n: 1 },
          resultTruncated: false,
          errorMessage: null,
        },
        {
          id: "row2",
          stepId: "s1",
          toolCallId: null,
          toolName: "get_task",
          status: "ok",
          resultJson: { n: 2 },
          resultTruncated: false,
          errorMessage: null,
        },
      ],
      llm: [
        {
          content: "结论",
          toolCalls: [],
          usage: { tokensIn: 1, tokensOut: 1 },
        },
      ],
    });

    await h.service.run("sess-1");
    const toolMsgs = h
      .llmCall(0)
      .messages.filter((m: Any) => m.role === "tool");

    expect(toolMsgs).toHaveLength(2);
    // 两条应答内容不同 = 第二行真的被读了（此前两处都会命中 row1）
    expect(String(toolMsgs[0].content)).not.toBe(String(toolMsgs[1].content));
  });
});

describe("AgentRuntimeService —— 批次内墙钟闸（推理质量轮）", () => {
  it("墙钟已到期 → 一个工具都不执行，全部如实回「未执行（墙钟）」", async () => {
    const execute = jest.fn(async () => ({ content: "ok", truncated: false }));
    const h = harness({
      // 会话墙钟已过：预算闸门在循环开头判，但一批调用每个最多 60s——
      // 十个调用就能跑过上限，期间还在产生副作用。故批次内要重判。
      startedAt: new Date(Date.now() - 31 * 60 * 1000),
      budget: {
        maxSteps: 20,
        maxTokens: 1e9,
        wallClockMs: 30 * 60 * 1000,
        maxToolCalls: 50,
      },
      llm: [
        {
          content: "",
          toolCalls: [
            { id: "c1", function: { name: "get_task", arguments: "{}" } },
            { id: "c2", function: { name: "trigger_task", arguments: "{}" } },
          ],
          usage: { tokensIn: 1, tokensOut: 1 },
        },
        {
          content: "结论",
          toolCalls: [],
          usage: { tokensIn: 1, tokensOut: 1 },
        },
      ],
    });
    h.service.setToolExecutor({
      availableTools: jest.fn(async () => [
        {
          name: "get_task",
          description: "d",
          parameters: {},
          tier: "read" as const,
        },
        {
          name: "trigger_task",
          description: "d",
          parameters: {},
          tier: "write" as const,
        },
      ]),
      execute,
    });

    await h.service.run("sess-1");

    expect(execute).not.toHaveBeenCalled();
    expect(h.recordedToolCalls.map((r) => r.errorMessage)).toEqual([
      "skipped: wall_clock",
      "skipped: wall_clock",
    ]);
    // 两条说明性应答都在（缺一条就是上游 400），且模型被告知原因
    const secondCall = h.llmCall(1).messages;
    expect(
      secondCall.filter(
        (m: Any) => m.role === "tool" && String(m.content).includes("墙钟预算"),
      ),
    ).toHaveLength(2);
  });

  it("墙钟未到期时照常执行（闸门不能误杀正常批次）", async () => {
    const execute = jest.fn(async () => ({ content: "ok", truncated: false }));
    const h = harness({
      budget: {
        maxSteps: 20,
        maxTokens: 1e9,
        wallClockMs: 30 * 60 * 1000,
        maxToolCalls: 50,
      },
      llm: [
        {
          content: "",
          toolCalls: [
            { id: "c1", function: { name: "get_task", arguments: "{}" } },
          ],
          usage: { tokensIn: 1, tokensOut: 1 },
        },
        {
          content: "结论",
          toolCalls: [],
          usage: { tokensIn: 1, tokensOut: 1 },
        },
      ],
    });
    h.service.setToolExecutor({
      availableTools: jest.fn(async () => [
        {
          name: "get_task",
          description: "d",
          parameters: {},
          tier: "read" as const,
        },
      ]),
      execute,
    });

    await h.service.run("sess-1");
    expect(execute).toHaveBeenCalledTimes(1);
  });
});

/**
 * GAP-3 服务端半边：LLM 瞬态耗尽的自动续跑。
 *
 * 首版半成品把会话落 failed 再排 delayed job——而 failed 是终态，`run()`
 * 对它短路、`markRunning` 的 CAS 也排除它，job 回来时**静默什么都不做**。
 * 这一组用例把正确形态钉死：续跑期间必须是可恢复的 waiting_input。
 */
describe("AgentRuntimeService.run —— GAP-3 瞬态耗尽自动续跑", () => {
  const transient = () =>
    Object.assign(new Error("bad gateway"), { response: { status: 502 } });
  const fatal = () =>
    Object.assign(new Error("401 invalid api key"), {
      response: { status: 401 },
    });
  /** 重试耗尽需要 3 次同类错误（DEFAULT_RETRY_POLICY.maxAttempts = 3）。 */
  const transientExhaustion = () => [transient(), transient(), transient()];

  it("瞬态耗尽 + 墙钟充裕 → 挂起 auto_resume 并排一个 60s 延迟 job（不落 failed）", async () => {
    const h = harness({ llm: transientExhaustion() });
    const enqueue = jest.fn(async () => true);
    h.service.enqueueLlmResume = enqueue;

    const out = await h.service.run("sess-1");

    expect(out.status).toBe("waiting_input");
    expect(enqueue).toHaveBeenCalledWith("sess-1", 60_000);
    // 关键：先入队、后挂起（反序时入队失败会让会话永远等一个不存在的 job）
    expect(enqueue.mock.invocationCallOrder[0]).toBeLessThan(
      h.sessionService.markWaiting.mock.invocationCallOrder[0],
    );
    expect(h.waiting).toEqual(["auto_resume"]);
    expect(h.finished).toHaveLength(0);
    // 失败事实仍然留痕（下一轮重建上下文时模型能看到「上次链路坏」）
    expect(h.appended[0].content).toContain("[模型调用失败] bad gateway");
  });

  it("确定性失败（401）→ 不领额度、不排 job，直接 failed", async () => {
    const h = harness({ llm: [fatal(), fatal(), fatal()] });
    const enqueue = jest.fn(async () => true);
    h.service.enqueueLlmResume = enqueue;

    const out = await h.service.run("sess-1");

    expect(out.status).toBe("failed");
    expect(enqueue).not.toHaveBeenCalled();
    expect(h.sessionService.claimAutoResume).not.toHaveBeenCalled();
    expect(h.finished[0].patch.errorMessage).toBe(
      "LLM call failed: 401 invalid api key",
    );
  });

  it("额度已被用掉（第二次耗尽 / 别的副本抢先）→ 如实 failed，不排 job", async () => {
    const h = harness({ llm: transientExhaustion(), claimAutoResume: false });
    const enqueue = jest.fn(async () => true);
    h.service.enqueueLlmResume = enqueue;

    const out = await h.service.run("sess-1");

    expect(out.status).toBe("failed");
    expect(enqueue).not.toHaveBeenCalled();
    expect(h.waiting).toHaveLength(0);
    expect(h.finished[0].patch.errorMessage).toBe(
      "LLM call failed: bad gateway",
    );
  });

  it("墙钟剩余 < 5min（续跑注定被预算判死）→ 不排 job，直接 failed", async () => {
    const h = harness({
      llm: transientExhaustion(),
      budget: {
        maxSteps: 20,
        maxTokens: 1e9,
        wallClockMs: 30 * 60 * 1000,
        maxToolCalls: 50,
      },
      startedAt: new Date(Date.now() - (30 * 60 * 1000 - 60 * 1000)),
    });
    const enqueue = jest.fn(async () => true);
    h.service.enqueueLlmResume = enqueue;

    const out = await h.service.run("sess-1");

    expect(out.status).toBe("failed");
    expect(enqueue).not.toHaveBeenCalled();
    expect(h.sessionService.claimAutoResume).not.toHaveBeenCalled();
  });

  it("入队失败 → 额度已消耗并如实 failed，errorMessage 区分「排过但没排上」", async () => {
    const h = harness({ llm: transientExhaustion() });
    h.service.enqueueLlmResume = jest.fn(async () => false);

    const out = await h.service.run("sess-1");

    expect(out.status).toBe("failed");
    expect(h.waiting).toHaveLength(0);
    expect(h.finished[0].patch.errorMessage).toBe(
      "LLM call failed (transient; auto-resume enqueue failed): bad gateway",
    );
  });

  it("未装配出队口（单测/未接队列的部署）→ 保持旧语义，直接 failed", async () => {
    const h = harness({ llm: transientExhaustion() });

    const out = await h.service.run("sess-1");

    expect(out.status).toBe("failed");
    expect(h.sessionService.claimAutoResume).not.toHaveBeenCalled();
  });
});

/**
 * RT-3 / RT-6（审计轮发现）：唤醒凭据与循环内状态复查。
 *
 * 前者防「60s 的延迟 job 接管已经转去等审批的会话」，后者防「被外部收敛
 * 的会话在循环里继续烧钱、继续产生副作用」。
 */
describe("AgentRuntimeService.run —— 唤醒凭据与循环内状态复查", () => {
  it("RT-3：期望 auto_resume 但会话已转去等审批 → 不接管、不调 LLM", async () => {
    const h = harness({
      status: "waiting_input",
      waitingFor: "等待审批 apr-1",
      llm: [
        {
          content: "不该被调用",
          toolCalls: [],
          usage: { tokensIn: 1, tokensOut: 1 },
        },
      ],
    });

    const out = await h.service.run("sess-1", {
      expectWaitingFor: "auto_resume",
    });

    expect(h.chatMultimodal).not.toHaveBeenCalled();
    expect(h.sessionService.markRunning).toHaveBeenCalledWith(
      "sess-1",
      "auto_resume",
    );
    expect(out.status).toBe("waiting_input");
    expect(h.finished).toHaveLength(0);
  });

  it("RT-3：期望 auto_resume 且会话确实在 auto_resume → 正常续跑", async () => {
    const h = harness({
      status: "waiting_input",
      waitingFor: "auto_resume",
      llm: [
        {
          content: "续跑完成",
          toolCalls: [],
          usage: { tokensIn: 1, tokensOut: 1 },
        },
      ],
    });

    const out = await h.service.run("sess-1", {
      expectWaitingFor: "auto_resume",
    });

    expect(out.status).toBe("succeeded");
    expect(h.chatMultimodal).toHaveBeenCalledTimes(1);
  });

  it("RT-6：循环中会话被外部收敛为终态 → 立即停手，不再推理/调工具", async () => {
    const h = harness({
      status: "pending",
      llm: [
        {
          content: "不该被调用",
          toolCalls: [],
          usage: { tokensIn: 1, tokensOut: 1 },
        },
      ],
    });
    // 第一次 = run() 入口；之后（rebuildMessages 与循环开头）都读到已被
    // 外部收敛的终态快照
    h.sessionService.requireById
      .mockResolvedValueOnce({ ...h.session, status: "pending" })
      .mockResolvedValue({ ...h.session, status: "failed", totalSteps: 2 });

    const out = await h.service.run("sess-1");

    expect(out).toMatchObject({ status: "failed", steps: 2 });
    expect(h.chatMultimodal).not.toHaveBeenCalled();
    expect(h.finished).toHaveLength(0);
  });

  it("RT-5：工具前置链意外崩溃时台账按最长保留期记 write（不按 read 提前删除）", async () => {
    const h = harness({
      llm: [
        {
          content: "",
          toolCalls: [
            { id: "c1", function: { name: "update_task", arguments: "{}" } },
          ],
          usage: { tokensIn: 1, tokensOut: 1 },
        },
        {
          content: "结论",
          toolCalls: [],
          usage: { tokensIn: 1, tokensOut: 1 },
        },
      ],
    });
    h.service.setToolExecutor({
      availableTools: jest.fn(async () => [
        {
          name: "update_task",
          description: "d",
          parameters: {},
          tier: "write" as const,
        },
      ]),
      execute: jest.fn(async () => {
        throw new RangeError("Maximum call stack size exceeded");
      }),
    });

    await h.service.run("sess-1");

    expect(h.recordedToolCalls).toContainEqual(
      expect.objectContaining({
        toolName: "update_task",
        status: "error",
        tier: "write",
      }),
    );
  });
});
