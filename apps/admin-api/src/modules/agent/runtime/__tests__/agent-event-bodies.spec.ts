import {
  AGENT_EVENT_BATCH_MAX_BYTES,
  AgentSessionService,
  EventBatchRejectedError,
} from "../agent-session.service";
import {
  AGENT_EVENT_BODY_MAX_BYTES,
  toAgentEventBody,
} from "../../entities/agent-event.entity";
import type { AgentEventInput } from "../../entities/agent-event.entity";

/**
 * S7-G1（第五阶段）：**事件正文**与**尺寸上限**。
 *
 * 本组用例钉的是「事件流到底是索引还是载体」这件事的**分界线**：
 *  ① 步 `content` 真的进 `payload.body`（脱敏后），并且能从写入侧读回；
 *  ② 含凭据的正文落库后**没有明文**（脱敏是硬要求：正文进审计表 = 新的泄密面）；
 *  ③ 超长正文**截断 + 标记**（`truncated` + `originalBytes`），不是静默丢；
 *  ④ 超**字节**上限的批**整批拒**（一行都不写，连 SQL 都没发）；
 *  ⑤ 事件写入失败**不改变主链**（旁路契约的回归锁）。
 *
 * ## 为什么断言的是「喂给 INSERT 的那串 JSON」而不是「库里的行」
 * `appendEvents` 把整批事件作为**一个参数**（`$2::jsonb`）交给
 * `jsonb_array_elements`（见 `agent-events.spec.ts` ①）。所以
 * `JSON.parse(params[1])` 就是**将要落进 `agent_events.payload` 的字节**——
 * 断言它，等于断言落库结果，而不需要真库。这一点很重要：本组用例的 ②（无明文）
 * 与 ③（截断标记）都是**内容**断言，只有贴着这串 JSON 才有意义。
 *
 * 存量说明（如实）：本改动**之前**写入的事件没有 `payload.body`——那时确实没记
 * 正文，不回填、不伪造。读侧判据是「有没有 `body`」，不是「该不该有正文」。
 */

type Any = Record<string, any>;

/** TypeORM 链式桩（select/where/... 全部返回自身，便于链式调用）。 */
function qbStub(result: Any = { affected: 1 }, raw: Any = { maxSeq: 0 }) {
  const qb: Any = {};
  for (const m of [
    "select",
    "where",
    "andWhere",
    "orWhere",
    "orderBy",
    "limit",
    "skip",
    "take",
    "set",
    "update",
    "delete",
    "from",
  ]) {
    qb[m] = jest.fn(() => qb);
  }
  qb.getRawOne = jest.fn(async () => raw);
  qb.getRawMany = jest.fn(async () => []);
  qb.execute = jest.fn(async () => result);
  return qb;
}

/**
 * 装配 `AgentSessionService`（只提供本组用例触达的依赖）。
 *
 * `eventQuery` 是 `manager.query(...)` 的桩——它就是 `appendEvents` 的那条
 * 单语句；`params[1]` 即整批事件的 JSON（= 将要落进 jsonb 的东西）。
 */
function makeHarness(
  options: {
    eventQuery?: jest.Mock;
    tx?: (cb: (em: Any) => Promise<unknown>) => Promise<unknown>;
  } = {},
) {
  const emQb = qbStub();
  const em: Any = {
    createQueryBuilder: jest.fn(() => emQb),
    create: jest.fn((_cls: unknown, v: Any) => ({ id: "step-1", ...v })),
    save: jest.fn(async (v: Any) => v),
    findOne: jest.fn(async () => null),
    query: options.eventQuery ?? jest.fn(async () => [{ seq: 1 }]),
  };
  const sessions: Any = {
    createQueryBuilder: jest.fn(() => qbStub()),
    findOne: jest.fn(async () => ({
      id: "s-1",
      kind: "incident",
      status: "running",
      totalSteps: 1,
      totalTokensIn: 10,
      totalTokensOut: 5,
      resultJson: null,
      summary: null,
    })),
    update: jest.fn(async () => ({ affected: 1 })),
    manager: {
      transaction: jest.fn(
        options.tx ?? (async (cb: (em: Any) => Promise<unknown>) => cb(em)),
      ),
    },
  };
  const toolCalls: Any = {
    create: jest.fn((v: Any) => ({ id: "tc-1", ...v })),
    save: jest.fn(async (v: Any) => v),
    update: jest.fn(async () => ({ affected: 1 })),
  };
  const svc = new AgentSessionService(
    sessions as never,
    { find: jest.fn(async () => []) } as never,
    toolCalls as never,
    {
      resolveBudget: jest.fn(() => ({
        maxSteps: 40,
        maxTokens: 1000,
        wallClockMs: 60000,
        maxToolCalls: 20,
      })),
    } as never,
    {
      sessionFinished: jest.fn(async () => undefined),
      staleSweepConverged: jest.fn(async () => undefined),
    } as never,
  );
  return { svc, sessions, em, emQb, toolCalls };
}

/** 取出第 `n` 次事件写入真正交给 INSERT 的整批事件。 */
function writtenEvents(eventQuery: jest.Mock, n = 0): Any[] {
  return JSON.parse(eventBatchJson(eventQuery, n)) as Any[];
}

/** 第 `n` 次事件写入的「整批事件」JSON 文本（= 将要落进 jsonb 的字节）。 */
function eventBatchJson(eventQuery: jest.Mock, n = 0): string {
  const calls = eventQuery.mock.calls as unknown as Array<[string, unknown[]]>;
  const call = calls[n];
  if (!call) {
    throw new Error(`eventQuery 只被调用 ${calls.length} 次`);
  }
  return String(call[1][1]);
}

describe("S7-G1 第五阶段 · 事件正文进 payload", () => {
  it("① 步 content 进 payload.body（脱敏后），且可从写入侧原样回读", async () => {
    const eventQuery = jest.fn(async () => [{ seq: 1 }]);
    const h = makeHarness({ eventQuery });
    const content = "查 task-1 的执行记录：最近一次是失败，exitCode=2";

    await h.svc.appendStep("s-1", {
      role: "assistant",
      content,
      tokensIn: 3,
      tokensOut: 2,
    });

    const events = writtenEvents(eventQuery);
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe("step_appended");
    // 元数据仍在（不是被正文挤掉）：投影与守卫脚本按这些字段对齐
    expect(events[0].payload.stepId).toBe("step-1");
    expect(events[0].payload.stepSeq).toBe(1);

    const body = events[0].payload.body.content;
    expect(body).not.toBeNull();
    expect(body.text).toBe(content); // 无凭据 ⇒ 逐字保留（脱敏不该改普通文本）
    expect(body.truncated).toBe(false);
    expect(body.bytes).toBe(Buffer.byteLength(content, "utf8"));
    expect(body.originalBytes).toBe(body.bytes);
  });

  it("① 工具台账的结果/错误正文也进 payload（两个写入点各一条）", async () => {
    const eventQuery = jest.fn(async () => [{ seq: 1 }]);
    const h = makeHarness({ eventQuery });

    await h.svc.recordToolCall({
      sessionId: "s-1",
      toolCallId: "call-1",
      toolName: "get_task",
      tier: "read",
      status: "ok",
      result: { status: "success", exitCode: 0 },
      errorMessage: "重试 3 次后放弃：连接超时",
    });
    const recorded = writtenEvents(eventQuery)[0];
    expect(recorded.payload.body.result.text).toContain('"exitCode":0');
    expect(recorded.payload.body.error.text).toBe("重试 3 次后放弃：连接超时");

    await h.svc.updateToolCallByToolCallId("s-1", "call-1", {
      toolName: "get_task",
      tier: "read",
      status: "error",
      result: { status: "failed" },
      errorMessage: "上游 500",
    });
    const changed = writtenEvents(eventQuery, 1)[0];
    expect(changed.kind).toBe("tool_call_status_changed");
    expect(changed.payload.body.result.text).toContain('"status":"failed"');
    expect(changed.payload.body.error.text).toBe("上游 500");
    // 存在性哨兵保持原样（投影按它判「事件说有错误文案」）
    expect(changed.payload.errorMessage).toBe("present");
  });
});

describe("S7-G1 第五阶段 · 脱敏（正文进审计表的硬要求）", () => {
  it("② 含 token= / apiKey / Bearer 的正文落库后无明文", async () => {
    const eventQuery = jest.fn(async () => [{ seq: 1 }]);
    const h = makeHarness({ eventQuery });
    const secret = "sk-live-9f3c2a71b4";
    const content =
      `调用 http://api.local/x?token=${secret} ` +
      `并附带 apiKey=${secret} 以及 Authorization: Bearer ${secret}`;

    await h.svc.appendStep("s-1", { role: "assistant", content });

    // 断言对象是**真正要进 jsonb 的那串 JSON**（含转义），不是脱敏函数的返回值
    const raw = eventBatchJson(eventQuery);
    expect(raw).not.toContain(secret);
    expect(raw).not.toContain("sk-live");

    const body = writtenEvents(eventQuery)[0].payload.body.content;
    expect(body.text).toContain("token=[REDACTED]");
    expect(body.text).toContain("apiKey=[REDACTED]");
    // `Authorization: Bearer <secret>` 会被 Bearer 规则与凭据赋值规则**各打一次码**
    // （既有 sanitizeString 的行为，两处都指向同一个秘密），关键是 key 不剩明文。
    expect(body.text).toContain("Authorization: [REDACTED] [REDACTED]");
  });

  it("② 工具结果的键名凭据被剥除（复用同一套规则，不是第二套）", async () => {
    const eventQuery = jest.fn(async () => [{ seq: 1 }]);
    const h = makeHarness({ eventQuery });

    await h.svc.recordToolCall({
      sessionId: "s-1",
      toolCallId: "call-1",
      toolName: "get_executor",
      tier: "read",
      status: "ok",
      result: {
        env: "AUTOFLOW_TOKEN=abc123",
        password: "hunter2",
        // 普通字段不该被打码，否则正文失去取证价值
        taskId: "task-42",
      },
    });

    const raw = eventBatchJson(eventQuery);
    expect(raw).not.toContain("abc123");
    expect(raw).not.toContain("hunter2");
    expect(raw).toContain("[REDACTED]");
    // 键名规则（SECRET_KEYS_RE）生效：整个 password 值被替换，而不是只打码一部分
    const body = writtenEvents(eventQuery)[0].payload.body.result;
    expect(JSON.parse(body.text)).toEqual({
      env: "AUTOFLOW_TOKEN=[REDACTED]",
      password: "[REDACTED]",
      taskId: "task-42",
    });
  });
});

describe("S7-G1 第五阶段 · 尺寸上限", () => {
  it("③ 超长正文 ⇒ 截断 + 标记（长度与标记都可断言）", async () => {
    const eventQuery = jest.fn(async () => [{ seq: 1 }]);
    const h = makeHarness({ eventQuery });
    // 中文（3 字节/字）⇒ 同时验证「按字节截断」而不是「按字符截断」，
    // 且刻意避开 32+hex / 40+b64 两条规则（否则正文会先被打码，测不到截断）
    const long = "模型看到的很长的正文内容 ".repeat(300);
    expect(Buffer.byteLength(long, "utf8")).toBeGreaterThan(
      AGENT_EVENT_BODY_MAX_BYTES * 3,
    );

    await h.svc.appendStep("s-1", { role: "assistant", content: long });

    const body = writtenEvents(eventQuery)[0].payload.body.content;
    expect(body.truncated).toBe(true);
    // 原始长度 = 原文（不是被截断后的长度）
    expect(body.originalBytes).toBe(Buffer.byteLength(long, "utf8"));
    expect(body.bytes).toBe(Buffer.byteLength(body.text, "utf8"));
    expect(body.bytes).toBeLessThanOrEqual(AGENT_EVENT_BODY_MAX_BYTES);
    // 截断点必须落在字符边界（不能切出半个汉字 / U+FFFD 替换符）
    expect(body.text).not.toContain("\uFFFD");
    expect(long.startsWith(body.text)).toBe(true);
    // 不是静默丢弃：拿到的仍是正文的前缀，而不是空串
    expect(body.text.length).toBeGreaterThan(0);
  });

  it("③ 未超限的正文不标记（避免「标记恒真」这种假闸门）", () => {
    const exact = "z".repeat(0) + "正".repeat(600); // 1800 字节 < 2048
    const body = toAgentEventBody(exact, exact);
    expect(body.truncated).toBe(false);
    expect(body.bytes).toBe(1800);
    expect(body.originalBytes).toBe(1800);
  });

  it("④ 超字节上限的批 ⇒ 整批拒（一行都不写，SQL 都没发）", async () => {
    const eventQuery = jest.fn(async () => [{ seq: 1 }]);
    const h = makeHarness({ eventQuery });
    // 2 条 × 200KB = 400KB > 256KB，但**条数**只有 2（远小于 32）：
    // 这样就排除了「其实是条数上限拦下的」这种误读。
    const payload = { pad: "x".repeat(200 * 1024) };
    const batch: AgentEventInput[] = [
      { kind: "step_appended", payload },
      { kind: "step_appended", payload },
    ];
    expect(JSON.stringify(batch).length).toBeGreaterThan(
      AGENT_EVENT_BATCH_MAX_BYTES,
    );

    const err = await h.svc.appendEvents("s-1", batch).catch((e) => e);
    expect(err).toBeInstanceOf(EventBatchRejectedError);
    expect(err.count).toBe(2);
    expect(err.bytes).toBeGreaterThan(AGENT_EVENT_BATCH_MAX_BYTES);
    expect(err.message).toContain(String(AGENT_EVENT_BATCH_MAX_BYTES));
    // 整批拒的关键证据：**没有任何 SQL 被发出**（不存在「写了一半」）
    expect(eventQuery).not.toHaveBeenCalled();
  });

  it("⑤ 旁路纪律：事件写入失败时 appendStep 仍然成功（主链不受影响）", async () => {
    let tx = 0;
    const h = makeHarness({
      tx: async (cb) => {
        tx += 1;
        // 第 1 个事务 = step 写入（必须成功）；第 2 个 = 事件写入（模拟 DB 故障）
        if (tx === 1) return cb(h.em);
        throw new Error("agent_events unavailable");
      },
    });

    const step = await h.svc.appendStep("s-1", {
      role: "assistant",
      content: "结论：无需处理",
      tokensIn: 1,
      tokensOut: 1,
    });

    expect(step).toMatchObject({ role: "assistant", seq: 1 });
    expect(tx).toBe(2); // 事件确实被尝试过（不是根本没接线）
  });

  it("⑤ 旁路纪律：正文无法序列化时台账照写，正文留可断言占位（不写 null）", async () => {
    const eventQuery = jest.fn(async () => [{ seq: 1 }]);
    const h = makeHarness({ eventQuery });

    await expect(
      h.svc.recordToolCall({
        sessionId: "s-1",
        toolCallId: "call-1",
        toolName: "get_task",
        tier: "read",
        status: "ok",
        // BigInt 是 JSON.stringify 会抛的类型（环引用则会被 sanitizeValue 的
        // 32 层钳位消化成 "[TRUNCATED_NESTED]"，不会抛）
        result: { id: 1n } as unknown as Record<string, unknown>,
      }),
    ).resolves.toMatchObject({ toolCallId: "call-1" });

    // 无法序列化的正文不写 null（否则「没有正文」与「写不进去」分不开）
    const body = writtenEvents(eventQuery)[0].payload.body.result;
    expect(body.text).toBe("[UNSERIALIZABLE]");
    expect(body.truncated).toBe(false);
  });
});
