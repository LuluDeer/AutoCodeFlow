/**
 * N8 · steer inbox 接线层规格（不重复 steer-inbox.spec 的 21 例纯状态机反证）。
 *
 * 断言的是**真实副作用**：POST 只写 inbox（不落 step、不调 LLM、不入 resume job）、
 * resume 后首个步边界把 content 恰好一次喂进下一轮 LLM 请求且 inbox 清空、
 * 终态入队被 shouldWake 拒绝且不产生 resume job、runtime 缺席 provider 时 fail-open。
 *
 * 级别：单测 + 进程内真 provider + 内存替身（本机无 PG/Redis 进程内集成条件），
 * 但断言对象是 SteerInboxService 真实例的 Map 状态与 AgentRuntimeService 真循环
 * 发出的请求体，不是接口 200。
 */
import { AgentController } from "../agent.controller";
import {
  AgentRuntimeService,
  type RunOptions,
} from "../runtime/agent-runtime.service";
import { SteerInboxService } from "../runtime/steer-inbox.service";

type Any = Record<string, any>;
const SESSION_ID = "sess-n8";
const STEER = "追加目标：先看 queue-stall";

/** 直接装配 controller 的最小面：既有 spec 用定位参数，这里只覆盖本端点用到的字段。 */
function makeController(
  session: Any,
  inbox: SteerInboxService | null,
  queue: Any,
): AgentController {
  const c = Object.create(AgentController.prototype) as Any;
  c.sessions = { requireById: jest.fn(async () => session) };
  c.steerInbox = inbox;
  c.queue = queue;
  return c as AgentController;
}

/** 精简 runtime harness：真 runtime 循环 + 内存 session service + 假 LLM。 */
function makeRuntime(
  opts: { status?: string; steps?: Any[]; llm?: Any[] } = {},
) {
  const steps = opts.steps ?? [
    {
      id: "s0",
      role: "user",
      content: "最初的目标",
      summary: null,
      toolCallId: null,
      toolCallsJson: null,
    },
  ];
  const appended: Any[] = [];
  const finished: Any[] = [];
  const session: Any = {
    id: SESSION_ID,
    status: opts.status ?? "waiting_input",
    totalSteps: steps.length,
    budgetJson: null,
    contextJson: null,
    waitingFor: null,
    startedAt: new Date(),
    contextFoldStreak: 0,
  };
  const markRunning = jest.fn(async (_id: string, _o: RunOptions) => {
    if (session.status === "waiting_input") session.status = "running";
    return true;
  });
  const sessionService = {
    requireById: jest.fn(async () => session),
    markRunning,
    listSteps: jest.fn(async () => steps),
    getUsage: jest.fn(async () => ({
      steps: session.totalSteps,
      tokensIn: 0,
      tokensOut: 0,
      toolCalls: 0,
      startedAt: session.startedAt,
    })),
    appendStep: jest.fn(async (_id: string, input: Any) => {
      appended.push(input);
      session.totalSteps += 1;
      return { id: `s${appended.length}`, eventSeq: null, ...input };
    }),
    finish: jest.fn(async (_id: string, status: string, patch: Any = {}) => {
      finished.push({ status, patch });
      session.status = status;
    }),
    recordToolCall: jest.fn(async () => ({})),
    listToolCalls: jest.fn(async () => []),
    tryAppendEvent: jest.fn(async () => 1),
    claimAutoResume: jest.fn(async () => true),
    markWaiting: jest.fn(async () => {
      session.status = "waiting_input";
    }),
    recordContextFold: jest.fn(async () => undefined),
  };
  const budgetService = {
    check: jest.fn(() => ({ ok: true })),
    resolveContextWindow: jest.fn(() => ({
      maxTokens: 24_000,
      minRecentMessages: 12,
      preemptUnrecoverable: false,
    })),
  };
  const llmQueue: Any[] = [...(opts.llm ?? [])];
  const chatMultimodal = jest.fn(async () => {
    const next = llmQueue.shift();
    if (next instanceof Error) throw next;
    return (
      next ?? {
        content: "结论",
        usage: { tokensIn: 1, tokensOut: 1 },
        model: "stub-model",
      }
    );
  });
  const aiService = {
    chatMultimodal,
    getActiveRoute: jest.fn(async () => ({
      provider: "stub",
      model: "stub-model",
    })),
  };
  const service = new AgentRuntimeService(
    sessionService as never,
    budgetService as never,
    aiService as never,
  );
  service.llmRetryOptions = { sleep: async () => undefined, random: () => 0.5 };
  service.setApprovals({ listForSession: jest.fn(async () => []) } as never);
  return {
    service,
    session,
    sessionService,
    chatMultimodal,
    appended,
    finished,
    llmCall: (n: number): Any =>
      (chatMultimodal.mock.calls as unknown as Any[][])[n]?.[0],
  };
}

const userSteerCount = (req: Any | undefined): number =>
  (req?.messages ?? []).filter(
    (m: Any) => m.role === "user" && m.content === STEER,
  ).length;

describe("N8 接线 · POST steer 只写 inbox，不唤醒、不入 resume job", () => {
  it("waiting_input：inbox 落一条，step/LLM/resume job 全不发生", async () => {
    const inbox = new SteerInboxService();
    const queue = { add: jest.fn(async () => ({})) };
    const session = { id: SESSION_ID, status: "waiting_input", totalSteps: 7 };
    const controller = makeController(session, inbox, queue);
    const stepsBefore = inbox.peek(SESSION_ID).intents.length;

    const res: Any = await controller.steer(SESSION_ID, { content: STEER });

    expect(res.ok).toBe(true);
    expect(res.parked).toBe(true);
    expect(res.wake).toBe(true);
    expect(inbox.peek(SESSION_ID).intents).toHaveLength(stepsBefore + 1);
    expect(inbox.peek(SESSION_ID).intents[0]).toMatchObject({
      content: STEER,
      parkedAtStep: 7,
    });
    // 实际副作用：没有任何 step/LLM 调用，也没有 resume job 入队。
    expect(queue.add).not.toHaveBeenCalled();
  });

  it.each(["succeeded", "aborted"])(
    "终态 %s：shouldWake=false，不写 inbox、不入 resume job",
    async (terminal) => {
      const inbox = new SteerInboxService();
      const queue = { add: jest.fn(async () => ({})) };
      const controller = makeController(
        { id: SESSION_ID, status: terminal, totalSteps: 3 },
        inbox,
        queue,
      );

      const res: Any = await controller.steer(SESSION_ID, { content: STEER });

      expect(res).toMatchObject({ ok: false, parked: false, wake: false });
      expect(inbox.peek(SESSION_ID).intents).toEqual([]);
      expect(queue.add).not.toHaveBeenCalled();
    },
  );

  it("provider 缺席 ⇒ 显式不可用（不回 200 空信封）", async () => {
    const controller = makeController(
      { id: SESSION_ID, status: "waiting_input", totalSteps: 1 },
      null,
      { add: jest.fn() },
    );
    await expect(
      controller.steer(SESSION_ID, { content: STEER }),
    ).rejects.toMatchObject({ status: 503 });
  });
});

describe("N8 接线 · runtime 步边界 drain 只注入一次", () => {
  it("resume 后首个 LLM 请求含 steer 一次，inbox 清空；下一轮不重复注入", async () => {
    const inbox = new SteerInboxService();
    inbox.park(SESSION_ID, STEER, 1, "waiting_input");
    expect(inbox.peek(SESSION_ID).intents).toHaveLength(1);

    // 第一轮要求工具，第二轮给结论——用两轮 LLM 证明「仅一次」注入。
    const h = makeRuntime({
      status: "waiting_input",
      llm: [
        {
          content: "",
          toolCalls: [
            {
              id: "c1",
              function: { name: "stub_tool", arguments: "{}" },
            },
          ],
          usage: { tokensIn: 1, tokensOut: 1 },
        },
        {
          content: "结论",
          usage: { tokensIn: 1, tokensOut: 1 },
        },
      ],
    });
    h.service.setSteerInbox(inbox);

    await h.service.run(SESSION_ID);

    expect(h.chatMultimodal).toHaveBeenCalledTimes(2);
    expect(userSteerCount(h.llmCall(0))).toBe(1);
    // 它已成为对话历史，第二轮仍只此一条（若二次 drain 会变成两条）。
    expect(userSteerCount(h.llmCall(1))).toBe(1);
    expect(inbox.peek(SESSION_ID).intents).toEqual([]);
    // 审批重放语义未被破坏：原有 user 步仍在请求里。
    expect(h.llmCall(0).messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: "user", content: "最初的目标" }),
      ]),
    );
  });

  it("runtime 未装配 inbox ⇒ fail-open：steer 留在 inbox，主链行为不变", async () => {
    const inbox = new SteerInboxService();
    inbox.park(SESSION_ID, STEER, 1, "waiting_input");
    const h = makeRuntime({ status: "waiting_input" });

    await h.service.run(SESSION_ID);

    expect(h.chatMultimodal).toHaveBeenCalledTimes(1);
    expect(userSteerCount(h.llmCall(0))).toBe(0);
    expect(inbox.peek(SESSION_ID).intents).toHaveLength(1);
    expect(h.finished.map((f: Any) => f.status)).toContain("succeeded");
  });
});
