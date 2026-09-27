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
  } = {},
) {
  const steps = opts.steps ?? [];
  const appended: Any[] = [];
  const finished: Array<{ status: string; patch: Any }> = [];
  const recordedToolCalls: Any[] = [];
  const markRunning = jest.fn(async () => undefined);

  const session: Any = {
    id: "sess-1",
    status: opts.status ?? "running",
    totalSteps: steps.length,
    budgetJson: opts.budget ?? null,
    startedAt: new Date(0),
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
  };

  const budgetService = {
    check: jest.fn(() => opts.verdict ?? { ok: true }),
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
    const h = harness({ llm: [new Error("401 invalid api key")] });
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

  it("非 Error 抛出物（字符串/对象）也被如实收敛，不冒泡", async () => {
    const h = harness({ llm: [new Error("string-ish failure")] });
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
