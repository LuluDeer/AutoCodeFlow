/**
 * W1-S2 · Agent 实时交互面规格（guard / prompt registry / inbox 隔离 /
 * accumulator / abort / message resume）。
 *
 * 级别：单测 + 真内存状态机 + 假 DB/队列/Redis 端口。断言的是真实副作用
 * （写入的 step、入队的 job、abort 后状态、accumulator 快照），不是接口 200。
 */
import {
  AgentDoomLoopGuard,
  canonicalCallKey,
} from "../runtime/agent-doom-loop.guard";
import {
  buildInitialUserMessage,
  systemPromptForKind,
} from "../runtime/agent-prompt-registry";
import { ActiveStreamAccumulator } from "../runtime/agent-event-stream.service";

type Any = Record<string, any>;

// ── 死循环守卫 ──────────────────────────────────────────────────────────────

describe("AgentDoomLoopGuard", () => {
  it("深度规范化参数：对象键顺序无关，数组顺序保留", () => {
    expect(canonicalCallKey("get", { a: 1, b: [1, 2] })).toBe(
      canonicalCallKey("get", { b: [1, 2], a: 1 }),
    );
    expect(canonicalCallKey("get", { a: [1, 2] })).not.toBe(
      canonicalCallKey("get", { a: [2, 1] }),
    );
  });

  it("连续相同调用在 [3,5,8] 升级，用户消息重置，不同工具打断", () => {
    const guard = new AgentDoomLoopGuard();
    const call = { toolName: "get_execution", args: { id: "x" } };
    expect(guard.observe("s", call).level).toBe(0);
    expect(guard.observe("s", call).level).toBe(0);
    expect(guard.observe("s", call).level).toBe(3); // 第 3 次命中
    expect(guard.observe("s", call).level).toBe(3); // 第 4 次仍在上一个提醒档
    expect(guard.observe("s", call).level).toBe(5); // 第 5 次升级
    expect(guard.observe("s", call).level).toBe(5); // 第 6 次
    expect(guard.observe("s", call).level).toBe(5); // 第 7 次
    const converge = guard.observe("s", call); // 第 8 次收敛
    expect(converge.level).toBe(8);
    expect(converge.converge).toBe(true); // 恰好第 8 次触发收敛
    guard.onUserMessage("s");
    expect(guard.observe("s", call).count).toBe(1);
    guard.observe("s", call);
    guard.observe("s", call);
    expect(guard.observe("s", { toolName: "other", args: {} }).count).toBe(1);
  });

  it("denied 也计数（被拒后原样重提正是死循环）", () => {
    const guard = new AgentDoomLoopGuard();
    const call = { toolName: "deploy", args: {}, denied: true };
    for (let i = 0; i < 3; i += 1) guard.observe("s", call);
    expect(guard.peek("s")?.level).toBe(3);
  });
});

// ── 提示词注册表 ────────────────────────────────────────────────────────────

describe("Agent prompt registry", () => {
  it("每个 kind 都有不同身份，未知 kind 回落通用", () => {
    const kinds = [
      "ops_watch",
      "incident",
      "sop_authoring",
      "sop_review",
      "app_scaffold",
      "plan",
      "chat",
    ];
    const prompts = kinds.map((k) => systemPromptForKind(k));
    expect(new Set(prompts).size).toBe(kinds.length);
    expect(systemPromptForKind("unknown_future_kind")).toBe(
      systemPromptForKind("chat"),
    );
    expect(systemPromptForKind("plan")).toContain("只读");
  });

  it("首条 user turn 取显式 question，否则序列化 context", () => {
    const session = {
      kind: "ops_watch",
      title: "巡检",
      contextJson: { question: "为什么队列停摆？", extra: "x" },
    } as Any;
    expect(buildInitialUserMessage(session as never)).toBe("为什么队列停摆？");
    expect(buildInitialUserMessage({ ...session, contextJson: { a: 1 } } as never)).toContain("\"a\": 1");
    expect(buildInitialUserMessage({ ...session, contextJson: null } as never)).toBe("巡检");
  });
});

// ── 活跃流快照 ──────────────────────────────────────────────────────────────

describe("ActiveStreamAccumulator", () => {
  it("token/reasoning 片段拼接，phase 与 lastSeq 保留，刷新不闪断", () => {
    const acc = new ActiveStreamAccumulator();
    acc.append("s", { type: "token_delta", text: "你" }, 3);
    acc.append("s", { type: "token_delta", text: "好" }, 4);
    acc.append("s", { type: "reasoning_delta", text: "思考中" });
    acc.append("s", { type: "phase_changed", phase: "tool" }, 5);
    expect(acc.snapshot("s")).toEqual({
      content: "你好",
      reasoning: "思考中",
      phase: "tool",
      lastSeq: 5,
      active: true,
    });
    acc.clear("s");
    expect(acc.snapshot("s")).toBeNull();
  });
});

// ── abort / message resume ─────────────────────────────────────────────────

/** 假 DB + 假 Redis + 假队列：断言真实副作用，不连 PG/Redis。 */
function makeStream(over: Any = {}) {
  const session: Any = {
    id: "s1",
    kind: "chat",
    status: over.status ?? "pending",
    totalSteps: 1,
    contextJson: null,
  };
  const appended: Any[] = [];
  const finished: Any[] = [];
  const enqueued: Any[] = [];
  const sessions = {
    requireById: jest.fn(async () => session),
    findById: jest.fn(async () => session),
    appendStep: jest.fn(async (_id: string, input: Any) => {
      const step = { id: "step-1", seq: 2, eventSeq: 9, ...input };
      appended.push(step);
      session.totalSteps += 1;
      return step;
    }),
    finish: jest.fn(async (_id: string, status: string, patch: Any) => {
      finished.push({ status, patch });
      session.status = status;
    }),
    reopenForResume: jest.fn(async () => {
      session.status = "pending";
      return true;
    }),
    tryAppendEvent: jest.fn(async () => 9),
  };
  const redis = {
    set: jest.fn(async () => "OK"),
    rpush: jest.fn(async () => 1),
    expire: jest.fn(async () => 1),
    lrange: jest.fn(async () => []),
    del: jest.fn(async () => 1),
  };
  const config = { get: jest.fn(() => undefined) };
  // 直接构造，避开 Nest DI（构造器只有 config/sessions/dataSource）。
  const { AgentEventStreamService } = require("../runtime/agent-event-stream.service");
  const svc = new AgentEventStreamService(config, sessions, {} as Any);
  (svc as Any).getPublisher = () => redis;
  (svc as Any).ensureSubscriber = () => undefined;
  svc.enqueueResume = async (sid: string, stepSeq: number, mode: string) => {
    enqueued.push({ sid, stepSeq, mode });
  };
  return { svc, sessions, redis, session, appended, finished, enqueued };
}

describe("AgentEventStreamService abort / resume", () => {
  it("abort 把非终态会话置 aborted、写 Redis key、发本地信号", async () => {
    const { svc, sessions, redis } = makeStream({ status: "running" });
    const signaled: string[] = [];
    svc.subscribeAbort("s1", () => signaled.push("yes"));
    const result = await svc.requestAbort("s1", "admin");
    expect(result).toMatchObject({ sessionId: "s1", status: "aborted", aborted: true });
    expect(sessions.finish).toHaveBeenCalledWith(
      "s1",
      "aborted",
      expect.objectContaining({ errorMessage: expect.stringContaining("admin") }),
    );
    expect(redis.set).toHaveBeenCalledWith(
      "acf:agent-abort:s1",
      "1",
      "EX",
      600,
    );
    expect(signaled).toEqual(["yes"]);
  });

  it("abort 幂等：终态会话不被覆盖", async () => {
    const { svc, sessions } = makeStream({ status: "succeeded" });
    const result = await svc.requestAbort("s1");
    expect(result.aborted).toBe(false);
    expect(sessions.finish).not.toHaveBeenCalled();
  });

  it("running 会话发消息写 user step 并 steer（不入第二个 job）", async () => {
    const { svc, appended, enqueued, redis } = makeStream({ status: "running" });
    const result = await svc.sendMessageAndResume("s1", {
      content: "换个方向查",
      mode: "steer",
      actor: "alice",
    });
    expect(result).toMatchObject({ stepSeq: 2, action: "steered", status: "running" });
    expect(appended[0]).toMatchObject({ role: "user", content: "[alice] 换个方向查" });
    expect(enqueued).toHaveLength(0);
    expect(redis.rpush).toHaveBeenCalledWith(
      "acf:agent-steer:s1",
      expect.stringContaining("换个方向查"),
    );
    // Redis lrange 假端口返回空，内存兜底仍能被 drain 一次；再次 drain 为空。
    expect(await svc.drainSteers("s1")).toEqual(
      expect.arrayContaining([expect.stringContaining("换个方向查")]),
    );
    expect(await svc.drainSteers("s1")).toEqual([]);
  });

  it("pending 会话发消息写 user step 并重入 agent-jobs", async () => {
    const { svc, enqueued } = makeStream({ status: "pending" });
    const result = await svc.sendMessageAndResume("s1", {
      content: "开始吧",
      actor: "bob",
    });
    expect(result).toMatchObject({ stepSeq: 2, action: "enqueued", status: "pending" });
    expect(enqueued).toEqual([{ sid: "s1", stepSeq: 2, mode: "followup" }]);
  });

  it("内容在写入前脱敏（API key 不落 step 正文）", async () => {
    const { svc, appended } = makeStream({ status: "pending" });
    await svc.sendMessageAndResume("s1", {
      content: "key sk-abcdefghijklmnop 请检查",
      actor: "bob",
    });
    expect(appended[0].content).not.toContain("sk-abcdefghijklmnop");
  });
});
