/**
 * 运行时控制面定向测试（跨副本 abort / steer / deny 原因 / doom-loop 解耦）。
 *
 * 全部用内存替身断言**实际副作用**（信号是否 abort、Redis list 是否被 drain、
 * 恢复原因是否透出、提醒是否进消息体），不连 PG/Redis，不跑整条构建链。
 */
import { AgentController } from "../agent.controller";
import { AgentRuntimeService } from "../runtime/agent-runtime.service";
import {
  bindSessionAbort,
  observeAndRemind,
} from "../runtime/agent-runtime-realtime.collaborator";
import { AgentDoomLoopGuard } from "../runtime/agent-doom-loop.guard";
import { maybeResumeAfterDeny } from "../runtime/agent-deny-resume.collaborator";
import {
  SteerInboxService,
  agentSteerInboxKey,
  type SteerRedisPort,
} from "../runtime/steer-inbox.service";

type Any = Record<string, any>;
const SID = "ctrl-s1";

// ── 1. 跨副本 abort 消费 ────────────────────────────────────────────────────

function makeFakeStream() {
  const listeners = new Map<string, Array<() => void>>();
  const disposed: string[] = [];
  const subscribeAbort = jest.fn((sessionId: string, cb: () => void) => {
    const channel = `abort:${sessionId}`;
    const arr = listeners.get(channel) ?? [];
    arr.push(cb);
    listeners.set(channel, arr);
    return () => {
      const i = arr.indexOf(cb);
      if (i >= 0) arr.splice(i, 1);
      disposed.push(channel);
    };
  });
  const svc = {
    subscribeAbort,
    drainSteers: jest.fn(async () => [] as string[]),
    publishDelta: jest.fn(),
  };
  return {
    svc,
    subscribeAbort,
    disposed,
    /** 模拟 relay 收到 {abort:true} 后 handleRemote 的本地 emit。 */
    relayAbort: (sessionId: string): void => {
      for (const cb of listeners.get(`abort:${sessionId}`) ?? []) cb();
    },
    listenerCount: (sessionId: string): number =>
      (listeners.get(`abort:${sessionId}`) ?? []).length,
  };
}

describe("跨副本 abort 的本地消费", () => {
  it("subscribeAbort 回调（relay emit）生成 AbortSignal，dispose 成对释放", () => {
    const stream = makeFakeStream();
    const binding = bindSessionAbort(stream.svc as never, SID);

    expect(binding.signal.aborted).toBe(false);
    expect(stream.subscribeAbort).toHaveBeenCalledWith(SID, expect.any(Function));
    expect(stream.listenerCount(SID)).toBe(1);

    stream.relayAbort(SID);
    expect(binding.signal.aborted).toBe(true);

    binding.dispose();
    expect(stream.disposed).toEqual([`abort:${SID}`]);
    expect(stream.listenerCount(SID)).toBe(0);
  });

  it("stream 缺席：signal 不 abort，也不抛（DB 状态复查仍是兜底）", () => {
    const binding = bindSessionAbort(null, SID);
    expect(binding.signal.aborted).toBe(false);
    expect(() => binding.dispose()).not.toThrow();
  });

  it("runtime 在 LLM 返回后立刻消费 abort：收敛 aborted，不再落 assistant step", async () => {
    const fake = makeFakeStream();
    const steps: Any[] = [
      { id: "s0", role: "user", content: "目标", summary: null, toolCallId: null, toolCallsJson: null },
    ];
    const appended: Any[] = [];
    const finished: Any[] = [];
    const session: Any = {
      id: SID,
      status: "waiting_input",
      totalSteps: 1,
      budgetJson: null,
      contextJson: null,
      waitingFor: null,
      startedAt: new Date(),
      contextFoldStreak: 0,
    };
    const sessions = {
      requireById: jest.fn(async () => session),
      markRunning: jest.fn(async () => {
        session.status = "running";
        return true;
      }),
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
      markWaiting: jest.fn(async () => undefined),
      recordContextFold: jest.fn(async () => undefined),
    };
    const budget = {
      check: jest.fn(() => ({ ok: true })),
      resolveContextWindow: jest.fn(() => ({
        maxTokens: 24_000,
        minRecentMessages: 12,
        preemptUnrecoverable: false,
      })),
    };
    const ai = {
      // LLM 在途期间，远端副本发来 abort（relay → subscribeAbort 回调）。
      chatMultimodal: jest.fn(async () => {
        fake.relayAbort(SID);
        return {
          content: "本不该落库的结论",
          usage: { tokensIn: 1, tokensOut: 1 },
          model: "stub",
        };
      }),
      getActiveRoute: jest.fn(async () => ({ provider: "stub", model: "stub" })),
    };
    const runtime = new AgentRuntimeService(
      sessions as never,
      budget as never,
      ai as never,
    );
    runtime.llmRetryOptions = { sleep: async () => undefined, random: () => 0.5 };
    runtime.setApprovals({ listForSession: jest.fn(async () => []) } as never);
    runtime.setEventStream(fake.svc as never);

    const outcome = await runtime.run(SID);

    expect(outcome.status).toBe("aborted");
    expect(ai.chatMultimodal).toHaveBeenCalledTimes(1);
    expect(appended).toHaveLength(0);
    expect(finished.map((f: Any) => f.status)).toContain("aborted");
    expect(fake.disposed).toEqual([`abort:${SID}`]);
  });
});

// ── 2. steer 跨副本 drain ───────────────────────────────────────────────────

function makeSharedRedis(): SteerRedisPort & { store: Map<string, string[]> } {
  const store = new Map<string, string[]>();
  return {
    store,
    rpush: jest.fn(async (key: string, value: string) => {
      const arr = store.get(key) ?? [];
      arr.push(value);
      store.set(key, arr);
      return arr.length;
    }),
    lrange: jest.fn(async (key: string) => [...(store.get(key) ?? [])]),
    del: jest.fn(async (key: string) => {
      const had = store.has(key);
      store.delete(key);
      return had ? 1 : 0;
    }),
    expire: jest.fn(async () => 1),
  };
}

describe("steer inbox 跨副本 drain", () => {
  it("A 副本 park，B 副本步边界 drain 到同一条正文且只交付一次", async () => {
    const redis = makeSharedRedis();
    const inboxA = new SteerInboxService();
    inboxA.setRedis(redis);
    const inboxB = new SteerInboxService();
    inboxB.setRedis(redis);

    const parked = await inboxA.park(SID, "跨副本补充目标", 3, "waiting_input");
    expect(parked.wake).toBe(true);
    expect(inboxB.peek(SID).intents).toHaveLength(0); // B 的内存里确实没有
    const stored = redis.store.get(agentSteerInboxKey(SID)) ?? [];
    expect(stored).toHaveLength(1);
    expect(JSON.parse(stored[0])).toMatchObject({
      id: parked.intent!.id,
      content: "跨副本补充目标",
      parkedAtStep: 3,
    });

    const drained = await inboxB.drain(SID, 4);
    expect(drained.intents.map((i) => i.content)).toEqual(["跨副本补充目标"]);
    expect(drained.intents[0].id).toBe(parked.intent!.id); // id 锚点跨副本保留
    expect(redis.store.get(agentSteerInboxKey(SID))).toBeUndefined();
    expect((await inboxA.drain(SID, 5)).intents).toHaveLength(0); // 不重复注入
  });

  it("连续两条相同正文保留两份意图与各自的 id（按 id 而非正文幂等）", async () => {
    const redis = makeSharedRedis();
    const inboxA = new SteerInboxService();
    inboxA.setRedis(redis);
    const first = await inboxA.park(SID, "继续", 1, "waiting_input");
    const second = await inboxA.park(SID, "继续", 2, "waiting_input");

    const inboxB = new SteerInboxService();
    inboxB.setRedis(redis);
    const drained = await inboxB.drain(SID, 3);

    expect(drained.intents.map((i) => i.content)).toEqual(["继续", "继续"]);
    expect(new Set(drained.intents.map((i) => i.id)).size).toBe(2);
    expect(drained.intents.map((i) => i.id)).toEqual([
      first.intent!.id,
      second.intent!.id,
    ]);
  });

  it("Redis 与内存各持同一 id 时只注入一次；旧裸正文元素可兼容", async () => {
    const redis = makeSharedRedis();
    const failingRedis = {
      ...redis,
      rpush: jest.fn(async () => {
        throw new Error("redis down");
      }),
    };
    const inbox = new SteerInboxService();
    inbox.setRedis(failingRedis);
    const parked = await inbox.park(SID, "重复意图", 1, "waiting_input");
    expect(inbox.peek(SID).intents).toHaveLength(1); // 写失败回落内存

    // 模拟另一副本把「同一条意图」写进 Redis（id 相同）。
    await redis.rpush(agentSteerInboxKey(SID), JSON.stringify(parked.intent));
    inbox.setRedis(redis);
    const drained = await inbox.drain(SID, 2);
    expect(drained.intents).toHaveLength(1);
    expect(drained.intents[0].id).toBe(parked.intent!.id);

    await redis.rpush(agentSteerInboxKey(SID), "旧版裸正文");
    const legacy = await inbox.drain(SID, 3);
    expect(legacy.intents[0].content).toBe("旧版裸正文");
    expect(typeof legacy.intents[0].id).toBe("string");
  });

  it("非步边界不提前消费 Redis；单实例无 Redis 时行为逐字兼容", async () => {
    const redis = makeSharedRedis();
    const inbox = new SteerInboxService();
    inbox.setRedis(redis);
    await inbox.park(SID, "等步边界", 1, "waiting_input");

    expect((await inbox.drain(SID, null)).intents).toEqual([]);
    expect(redis.store.get(agentSteerInboxKey(SID))).toHaveLength(1);

    const localOnly = new SteerInboxService();
    await localOnly.park("local", "内存兜底", 2, "waiting_input");
    expect(localOnly.peek("local").intents).toHaveLength(1);
    expect((await localOnly.drain("local", 3)).intents[0].content).toBe("内存兜底");
  });
});

// ── 3. deny 自动恢复失败原因 ────────────────────────────────────────────────

describe("deny 后自动恢复的结构化失败原因", () => {
  const session: Any = { id: SID, status: "waiting_input" };

  it("审批查询异常：返回 reason 而非吞成裸 false", async () => {
    const result = await maybeResumeAfterDeny(
      { findById: jest.fn(async () => session) } as never,
      {
        hasPendingForSession: jest.fn(async () => {
          throw new Error("approval read down");
        }),
      } as never,
      jest.fn(async () => ({})) as never,
      SID,
      session as never,
    );
    expect(result.resumed).toBe(false);
    expect(result.reason).toContain("approval read down");
  });

  it("入队异常：reason 带出队列错误，异常仍不抛出", async () => {
    const result = await maybeResumeAfterDeny(
      { findById: jest.fn(async () => session) } as never,
      { hasPendingForSession: jest.fn(async () => false) } as never,
      jest.fn(async () => {
        throw new Error("queue down");
      }) as never,
      SID,
      session as never,
    );
    expect(result.resumed).toBe(false);
    expect(result.reason).toContain("queue down");
  });

  it("controller 把 reason 透出为响应 resumeReason", async () => {
    const c = Object.create(AgentController.prototype) as Any;
    c.sessions = {
      requireById: jest.fn(async () => session),
      findById: jest.fn(async () => session),
      // 返回 0：不触发 tool_call_status_changed 的旁路写入。
      settleToolCallByApprovalId: jest.fn(async () => 0),
      listToolCalls: jest.fn(async () => []),
    };
    c.approvals = {
      findByKey: jest.fn(async () => ({
        sessionId: SID,
        toolName: "list_tasks",
      })),
      decide: jest.fn(async () => ({
        approvalKey: "k1",
        status: "denied",
        decidedBy: "admin",
        decidedAt: new Date().toISOString(),
        toolName: "list_tasks",
      })),
      hasPendingForSession: jest.fn(async () => {
        throw new Error("approval read down");
      }),
    };
    c.queue = { add: jest.fn(async () => ({})) };
    c.moduleRef = null;
    c.logger = { warn: jest.fn(), log: jest.fn(), error: jest.fn() };

    const res = await c.decideApproval(SID, "k1", "denied", {
      username: "admin",
    } as Any);

    expect(res.ok).toBe(true);
    expect(res.resumed).toBe(false);
    expect(res.resumeReason).toContain("approval read down");
  });
});

// ── 4. doom-loop 与 realtimePorts 解耦 ──────────────────────────────────────

describe("死循环守卫在没有 stream / realtimePorts 时仍生效", () => {
  const calls: Any[] = [
    { id: "c1", type: "function", function: { name: "get", arguments: "{}" } },
    { id: "c2", type: "function", function: { name: "get", arguments: "{}" } },
    { id: "c3", type: "function", function: { name: "get", arguments: "{}" } },
  ];
  const base: Any[] = [{ role: "user", content: "目标" }];

  it("只传 guard（无 stream、无整包 ports）也会在第 3 次插入提醒", () => {
    const guard = new AgentDoomLoopGuard();
    const messages = observeAndRemind(guard, "loop-1", base as never, calls as never);
    expect(guard.peek("loop-1")?.count).toBe(3);
    expect(messages.some((m: Any) => typeof m.content === "string" && m.content.includes("连续"))).toBe(true);
  });

  it("旧调用形态 {guard} 无 stream 同样生效；{stream} 无 guard 则不判定", () => {
    const guard = new AgentDoomLoopGuard();
    const viaPorts = observeAndRemind({ guard }, "loop-2", base as never, calls as never);
    expect(viaPorts.length).toBe(base.length + 1);

    const noGuard = observeAndRemind(
      { stream: makeFakeStream().svc } as never,
      "loop-3",
      base as never,
      calls as never,
    );
    expect(noGuard).toBe(base);
  });
});

// ── 5. resume 成功后清理终态屏障 ────────────────────────────────────────────

describe("resume 与终态屏障", () => {
  function makeResumeHarness(reopened: boolean) {
    const session: Any = { id: SID, status: "failed", totalSteps: 9 };
    const steps: Any[] = [{ id: "s0", role: "user", content: "目标" }];
    const sessions = {
      requireById: jest.fn(async () => session),
      listSteps: jest.fn(async () => steps),
      reopenForResume: jest.fn(async () => reopened),
    };
    const queue = { add: jest.fn(async () => ({})) };
    let terminalSeq: number | null = 5;
    const dispatched: Any[] = [];
    const stream = {
      hasTerminalEvent: jest.fn(() => terminalSeq !== null),
      clearTerminalForResume: jest.fn((_sid: string) => {
        // 裁决后无参调用即无条件清理，不再做跨命名空间 seq 比较。
        terminalSeq = null;
      }),
      // 模拟 publishDurableEvent 的 running 分支：屏障在则吞帧。
      publishRunningFrame: (seq: number): void => {
        if (terminalSeq !== null) return;
        dispatched.push({ seq, status: "running" });
      },
    };
    const ctl = Object.create(AgentController.prototype) as Any;
    ctl.sessions = sessions;
    ctl.approvals = { hasPendingForSession: jest.fn(async () => false) };
    ctl.queue = queue;
    ctl.eventStream = stream;
    return {
      ctl,
      sessions,
      queue,
      stream,
      dispatched,
      terminalSeq: (): number | null => terminalSeq,
    };
  }

  it("reopen 成功即无参清理屏障，running 帧放行", async () => {
    const h = makeResumeHarness(true);

    const res = await h.ctl.resume(SID);

    expect(res).toEqual({ ok: true });
    expect(h.sessions.reopenForResume).toHaveBeenCalled();
    expect(h.stream.clearTerminalForResume).toHaveBeenCalledWith(SID);
    expect(h.stream.clearTerminalForResume.mock.calls[0]).toHaveLength(1);
    expect(h.terminalSeq()).toBeNull();
    h.stream.publishRunningFrame(11);
    expect(h.dispatched).toEqual([{ seq: 11, status: "running" }]);
    expect(h.queue.add).toHaveBeenCalled();
  });

  it("reopen 失败：屏障不清，running 帧仍被吞且不入队", async () => {
    const h = makeResumeHarness(false);

    const res = await h.ctl.resume(SID);

    expect(res.ok).toBe(false);
    expect(h.stream.clearTerminalForResume).not.toHaveBeenCalled();
    expect(h.terminalSeq()).toBe(5);
    h.stream.publishRunningFrame(11);
    expect(h.dispatched).toEqual([]);
    expect(h.queue.add).not.toHaveBeenCalled();
  });
});
