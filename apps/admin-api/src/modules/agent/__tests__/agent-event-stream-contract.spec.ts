/**
 * 定向测试：Agent 实时事件流契约（synced 快照 / replay 截断 / 跨副本 delta 累积）。
 * 级别：单测 + 真内存状态机 + 假 DB/Redis/res。断言实际写出的 SSE 帧与 accumulator 内容。
 */
import type { Response } from "express";

type Any = Record<string, any>;

const SESSION_ID = "11111111-1111-4111-8111-111111111111";

function parseFrames(writes: string[]): Array<{ event?: string; data: Any }> {
  const frames: Array<{ event?: string; data: Any }> = [];
  let event: string | undefined;
  for (const chunk of writes) {
    if (chunk.startsWith("event: ")) {
      event = chunk.slice(7).trim();
      continue;
    }
    if (chunk.startsWith("data: ")) {
      frames.push({ event, data: JSON.parse(chunk.slice(6).trim()) });
      event = undefined;
    }
  }
  return frames;
}

function makeRes(): { res: Response; writes: string[] } {
  const writes: string[] = [];
  const res = {
    writableEnded: false,
    setHeader: jest.fn(),
    flushHeaders: jest.fn(),
    write: jest.fn((chunk: string) => {
      writes.push(chunk);
      return true;
    }),
    end: jest.fn(),
  } as unknown as Response;
  return { res, writes };
}

function makeService(rows: Any[] = []) {
  const session = {
    id: SESSION_ID,
    kind: "chat",
    status: "running",
    totalSteps: 1,
    contextJson: null,
  };
  const sessions = {
    requireById: jest.fn(async () => session),
    findById: jest.fn(async () => session),
  };
  const dataSource = { query: jest.fn(async () => rows) };
  const config = { get: jest.fn(() => undefined) };
  const { AgentEventStreamService } = require("../runtime/agent-event-stream.service");
  const svc = new AgentEventStreamService(config, sessions, dataSource);
  (svc as Any).ensureSubscriber = () => undefined;
  return { svc, dataSource, session };
}

describe("AgentEventStreamService stream contract", () => {
  const originalSetInterval = global.setInterval;
  const originalClearInterval = global.clearInterval;

  beforeEach(() => {
    // 心跳定时器在测试里立即触发一次 ping 即可，避免 15s 真实等待。
    (global as Any).setInterval = jest.fn((fn: () => void) => {
      fn();
      return { unref: jest.fn() } as Any;
    });
    (global as Any).clearInterval = jest.fn();
  });

  afterEach(() => {
    (global as Any).setInterval = originalSetInterval;
    (global as Any).clearInterval = originalClearInterval;
  });

  it("synced 帧携带 accumulator 快照并保留 activeStream/lastSeq", async () => {
    const { svc } = makeService([]);
    svc.accumulator.append(SESSION_ID, { type: "token_delta", text: "你" }, 3);
    svc.accumulator.append(SESSION_ID, { type: "token_delta", text: "好" }, 4);
    svc.accumulator.append(SESSION_ID, { type: "reasoning_delta", text: "思考" });
    svc.accumulator.append(SESSION_ID, { type: "phase_changed", phase: "tool" }, 5);
    const { res, writes } = makeRes();
    const ac = new AbortController();
    ac.abort(); // 让主循环在 synced 后立即退出
    await svc.streamSession(SESSION_ID, { res, signal: ac.signal, fromSeq: 2 });
    const synced = parseFrames(writes).find((f) => f.event === "synced");
    expect(synced?.data).toMatchObject({
      sessionId: SESSION_ID,
      lastSeq: 2,
      status: "running",
      activeStream: true,
      hasMore: false,
      truncated: false,
      snapshot: { content: "你好", reasoning: "思考", phase: "tool" },
    });
  });

  it("synced.status 取重放后的最新状态，不被重放前陈旧快照盖过", async () => {
    const { svc } = makeService([]);
    (svc as Any).sessions.requireById = jest.fn(async () => ({
      id: SESSION_ID,
      status: "running",
    }));
    (svc as Any).sessions.findById = jest.fn(async () => ({
      id: SESSION_ID,
      status: "succeeded",
    }));
    const { res, writes } = makeRes();
    const ac = new AbortController();
    ac.abort();
    await svc.streamSession(SESSION_ID, { res, signal: ac.signal, fromSeq: 0 });
    const synced = parseFrames(writes).find((f) => f.event === "synced");
    expect(synced?.data.status).toBe("succeeded");
  });

  it("DB 重放的历史终态不写 terminalKinds，不污染当前世代", async () => {
    const rows = [
      {
        seq: 1,
        kind: "session_finished",
        payload: { status: "failed" },
        createdAt: new Date(0).toISOString(),
      },
    ];
    const { svc } = makeService(rows);
    const { res, writes } = makeRes();
    const ac = new AbortController();
    ac.abort();
    await svc.streamSession(SESSION_ID, { res, signal: ac.signal, fromSeq: 0 });
    expect(svc.hasTerminalEvent(SESSION_ID)).toBe(false);
    expect(parseFrames(writes).some((f) => f.event === "event")).toBe(true);
  });

  it("replay 超过 5000 条时只发 5000 条，synced 标记 hasMore/truncated", async () => {
    const rows = Array.from({ length: 5001 }, (_, i) => ({
      seq: i + 1,
      kind: "step_appended",
      payload: { n: i },
      createdAt: new Date(0).toISOString(),
    }));
    const { svc, dataSource } = makeService(rows);
    const { res, writes } = makeRes();
    const ac = new AbortController();
    ac.abort();
    await svc.streamSession(SESSION_ID, { res, signal: ac.signal, fromSeq: 0 });
    expect(dataSource.query).toHaveBeenCalledWith(
      expect.stringContaining("LIMIT $3"),
      [SESSION_ID, 0, 5001],
    );
    const frames = parseFrames(writes);
    expect(frames.filter((f) => f.event === "event")).toHaveLength(5000);
    const synced = frames.find((f) => f.event === "synced");
    expect(synced?.data).toMatchObject({
      lastSeq: 5000,
      hasMore: true,
      truncated: true,
      activeStream: false,
    });
    expect(synced?.data.snapshot).toBeUndefined();
  });

  it("replay() 可选 meta 回调保持数字返回值兼容", async () => {
    const { svc } = makeService([]);
    const meta: Any = { hasMore: false, truncated: false, count: 0 };
    const result = await (svc as Any).replay(SESSION_ID, 0, jest.fn(), meta);
    expect(result).toBe(0);
    expect(meta).toEqual({ hasMore: false, truncated: false, count: 0 });
  });

  it("终态先到后，后到的 running/started durable 事件不再 dispatch/relay", () => {
    const { svc } = makeService([]);
    const dispatched: Any[] = [];
    const relayed: Any[] = [];
    (svc as Any).dispatch = (sid: string, event: string, payload: Any) => {
      dispatched.push({ sid, event, payload });
    };
    (svc as Any).relay = (payload: Any) => relayed.push(payload);

    svc.publishDurableEvent(SESSION_ID, {
      seq: 1,
      kind: "status_changed",
      payload: { status: "succeeded" },
    });
    expect(svc.hasTerminalEvent(SESSION_ID)).toBe(true);
    svc.publishDurableEvent(SESSION_ID, {
      seq: 2,
      kind: "status_changed",
      payload: { status: "running" },
    });
    svc.publishDurableEvent(SESSION_ID, {
      seq: 3,
      kind: "session_started",
      payload: {},
    });

    expect(dispatched).toHaveLength(1);
    expect(dispatched[0].payload.seq).toBe(1);
    expect(relayed).toHaveLength(1);
    expect(relayed[0].event.seq).toBe(1);
  });

  it("handleRemote 的 delta 分支 append 到本实例 accumulator 后再 dispatch", () => {
    const { svc } = makeService([]);
    const received: Any[] = [];
    (svc as Any).subscribers.add({
      sessionId: SESSION_ID,
      queue: [],
      overflowed: false,
      wake: jest.fn(),
    });
    (svc as Any).dispatch = (sid: string, event: string, payload: Any) => {
      received.push({ sid, event, payload });
    };
    const envelope = {
      instanceId: "remote-instance",
      sessionId: SESSION_ID,
      delta: { type: "token_delta", text: "远" },
    };
    (svc as Any).handleRemote(JSON.stringify(envelope));
    expect(received).toEqual([
      { sid: SESSION_ID, event: "delta", payload: envelope.delta },
    ]);
    expect(svc.accumulator.snapshot(SESSION_ID)).toMatchObject({
      content: "远",
      active: true,
    });
  });

  it("subscribeAbort 会建立 relay 订阅，远端 abort 帧触发同一个回调", () => {
    const { svc } = makeService([]);
    let ensureCalled = 0;
    (svc as Any).ensureSubscriber = () => {
      ensureCalled += 1;
    };
    const fired: string[] = [];
    svc.subscribeAbort(SESSION_ID, () => fired.push("abort"));
    expect(ensureCalled).toBe(1);
    (svc as Any).handleRemote(
      JSON.stringify({
        instanceId: "remote-instance",
        sessionId: SESSION_ID,
        abort: true,
      }),
    );
    expect(fired).toEqual(["abort"]);
  });
});

describe("sendMessageAndResume terminal rejection", () => {
  function makeSendService(status: string) {
    const session: Any = {
      id: SESSION_ID,
      kind: "chat",
      status,
      totalSteps: 1,
      contextJson: null,
    };
    const sessions = {
      requireById: jest.fn(async () => session),
      appendStep: jest.fn(async (_id: string, input: Any) => ({
        id: "step-1",
        seq: 9,
        eventSeq: 10,
        ...input,
      })),
      reopenForResume: jest.fn(async () => false),
    };
    const config = { get: jest.fn(() => undefined) };
    const { AgentEventStreamService } = require("../runtime/agent-event-stream.service");
    const svc = new AgentEventStreamService(config, sessions, {
      query: jest.fn(),
    });
    (svc as Any).ensureSubscriber = () => undefined;
    const publishDurableEvent = jest.fn();
    (svc as Any).publishDurableEvent = publishDurableEvent;
    const redis = {
      rpush: jest.fn(async () => 1),
      expire: jest.fn(async () => 1),
      lrange: jest.fn(async () => []),
      del: jest.fn(async () => 1),
    };
    (svc as Any).getPublisher = () => redis;
    const enqueued: Any[] = [];
    svc.enqueueResume = async (sid: string, stepSeq: number, mode: string) => {
      enqueued.push({ sid, stepSeq, mode });
    };
    return { svc, sessions, enqueued, publishDurableEvent, redis };
  }

  it.each(["succeeded", "aborted", "budget_exceeded"])(
    "%s 会话追加消息返回 rejected_terminal，零 step/零事件/零队列副作用",
    async (status) => {
      const { svc, sessions, enqueued, publishDurableEvent, redis } =
        makeSendService(status);
      const result = await svc.sendMessageAndResume(SESSION_ID, {
        content: "再问一句",
        actor: "tester",
      });
      expect(result).toMatchObject({
        sessionId: SESSION_ID,
        status,
        stepSeq: 0,
        action: "rejected_terminal",
      });
      expect(typeof result.reason).toBe("string");
      expect((result.reason ?? "").length).toBeGreaterThan(0);
      // 零副作用：不写 step、不写 step_appended 事件、不进 steer/队列/Redis。
      expect(sessions.appendStep).not.toHaveBeenCalled();
      expect(publishDurableEvent).not.toHaveBeenCalled();
      expect(sessions.reopenForResume).not.toHaveBeenCalled();
      expect(redis.rpush).not.toHaveBeenCalled();
      expect(redis.expire).not.toHaveBeenCalled();
      expect(enqueued).toEqual([]);
    },
  );

  it("非终态会话仍返回 enqueued，保持旧契约", async () => {
    const { svc, enqueued, sessions } = makeSendService("pending");
    const result = await svc.sendMessageAndResume(SESSION_ID, {
      content: "继续",
      actor: "tester",
    });
    expect(result.action).toBe("enqueued");
    expect(result.reason).toBeUndefined();
    expect(enqueued).toHaveLength(1);
    expect(sessions.reopenForResume).not.toHaveBeenCalled();
  });

  it("终态→reopenForResume 成功→running 放行；失败重开仍吞帧", async () => {
    const { svc, sessions } = makeSendService("failed");
    sessions.reopenForResume.mockResolvedValue(true);
    // 恢复真实 publishDurableEvent（helper 默认 stub 以断言零副作用）。
    const proto = Object.getPrototypeOf(svc);
    (svc as Any).publishDurableEvent = proto.publishDurableEvent.bind(svc);
    (svc as Any).relay = jest.fn();
    const dispatched: Any[] = [];
    (svc as Any).dispatch = (_sid: string, _event: string, payload: Any) => {
      dispatched.push(payload);
    };

    svc.publishDurableEvent(SESSION_ID, {
      seq: 5,
      kind: "status_changed",
      payload: { status: "failed" },
    });
    expect(svc.hasTerminalEvent(SESSION_ID)).toBe(true);
    await svc.sendMessageAndResume(SESSION_ID, {
      content: "恢复",
      actor: "tester",
    });
    expect(sessions.reopenForResume).toHaveBeenCalled();
    expect(svc.hasTerminalEvent(SESSION_ID)).toBe(false);
    svc.publishDurableEvent(SESSION_ID, {
      seq: 7,
      kind: "status_changed",
      payload: { status: "running" },
    });
    expect(dispatched.some((p) => p.seq === 7)).toBe(true);
  });

  it("reopenForResume 返回 false 时不清理终态屏障", async () => {
    const { svc } = makeSendService("failed");
    const proto = Object.getPrototypeOf(svc);
    (svc as Any).publishDurableEvent = proto.publishDurableEvent.bind(svc);
    (svc as Any).relay = jest.fn();
    svc.publishDurableEvent(SESSION_ID, {
      seq: 5,
      kind: "status_changed",
      payload: { status: "failed" },
    });
    await svc.sendMessageAndResume(SESSION_ID, {
      content: "恢复",
      actor: "tester",
    });
    expect(svc.hasTerminalEvent(SESSION_ID)).toBe(true);
  });

  it("显式 reopen 总是清理终态屏障；未调用则保持（不做跨命名空间 seq 比较）", () => {
    const proto = Object.getPrototypeOf(makeSendService("failed").svc);
    const withReopen = makeSendService("failed");
    (withReopen.svc as Any).publishDurableEvent = proto.publishDurableEvent.bind(
      withReopen.svc,
    );
    (withReopen.svc as Any).relay = jest.fn();
    withReopen.svc.publishDurableEvent(SESSION_ID, {
      seq: 5,
      kind: "status_changed",
      payload: { status: "failed" },
    });
    expect(withReopen.svc.hasTerminalEvent(SESSION_ID)).toBe(true);
    // stepSeq 与 event.seq 是不同计数器：传小值也清，避免合法恢复被吞
    withReopen.svc.clearTerminalForResume(SESSION_ID, 1);
    expect(withReopen.svc.hasTerminalEvent(SESSION_ID)).toBe(false);

    const withoutReopen = makeSendService("failed");
    (withoutReopen.svc as Any).publishDurableEvent = proto.publishDurableEvent.bind(
      withoutReopen.svc,
    );
    (withoutReopen.svc as Any).relay = jest.fn();
    withoutReopen.svc.publishDurableEvent(SESSION_ID, {
      seq: 5,
      kind: "status_changed",
      payload: { status: "failed" },
    });
    expect(withoutReopen.svc.hasTerminalEvent(SESSION_ID)).toBe(true);
  });
});

describe("requestAbort winner semantics", () => {
  function makeAbortService(initialStatus: string, freshStatus: string) {
    const sessions = {
      requireById: jest.fn(async () => ({
        id: SESSION_ID,
        status: initialStatus,
      })),
      finish: jest.fn(async () => undefined),
      findById: jest.fn(async () => ({
        id: SESSION_ID,
        status: freshStatus,
      })),
    };
    const { AgentEventStreamService } = require("../runtime/agent-event-stream.service");
    const svc = new AgentEventStreamService(
      { get: jest.fn(() => undefined) },
      sessions,
      { query: jest.fn() },
    );
    (svc as Any).ensureSubscriber = () => undefined;
    (svc as Any).getPublisher = () => ({
      set: jest.fn(async () => "OK"),
      publish: jest.fn(async () => 1),
    });
    (svc as Any).relay = jest.fn();
    return { svc, sessions };
  }

  it("并发输家：finish 未赢时 aborted=false，状态取实际终态", async () => {
    const { svc, sessions } = makeAbortService("running", "succeeded");
    const result = await svc.requestAbort(SESSION_ID, "admin");
    expect(sessions.finish).toHaveBeenCalled();
    expect(result).toMatchObject({
      sessionId: SESSION_ID,
      status: "succeeded",
      aborted: false,
    });
  });

  it("赢家：重读为 aborted 时 aborted=true", async () => {
    const { svc } = makeAbortService("running", "aborted");
    const result = await svc.requestAbort(SESSION_ID, "admin");
    expect(result.aborted).toBe(true);
    expect(result.status).toBe("aborted");
  });

  it("原本已终态：不调 finish，aborted=false", async () => {
    const { svc, sessions } = makeAbortService("aborted", "aborted");
    const result = await svc.requestAbort(SESSION_ID, "admin");
    expect(sessions.finish).not.toHaveBeenCalled();
    expect(result.aborted).toBe(false);
  });
});
