/**
 * S7-G1（第七阶段）：**最后两类正文进事件** —— 折叠摘要 与 会话上下文。
 *
 * ## 为什么这两类必须进事件（不是「顺手补两个字段」）
 *
 * 「把投影切为线上读路径」的唯一前提是：**事件流能自足地重建 `rebuildMessages`
 * 的全部输入**。此前有两段正文没有事件来源，只能回读快照行：
 *   ① 折叠步的 `[阶段小结] ` 替身正文（`agent_steps.summary`）；
 *   ② 首条 system 消息里的上下文段（`session.contextJson`，`JSON.stringify(…,2)`
 *      截 16 KiB）。
 * 它们与 `content` / `result` / `errorMessage` 是**同一类**事实（模型当时看到的
 * 文字），却唯独没有序列：只能回读「当前值」，答不出「那一刻是什么」。
 *
 * ## 本组钉的五件事（每条都可被推翻）
 *
 *   ① **优先级**：事件带 `body` ⇒ 投影用事件；证伪方式是「快照放**不同的**值」；
 *   ② 优先级同样适用于会话上下文（`session_context_recorded`）；
 *   ③ **存量兼容**：没有 body / 没有事件 ⇒ 回落快照，且**逐字节**与改动前一致
 *      （sha256 基线来自 `git show HEAD:` 的副本，见 ③ 组注释）；
 *   ④ **脱敏**：`contextJson` 含凭据 ⇒ 会话行与事件正文里都**没有明文**；
 *   ⑤ **新 kind 的因果规则**：`session_context_recorded` 恒 NULL（没有单一前驱），
 *      且一条非法边会被投影记成 `causation_invalid` 并丢弃——规则没有「生效」
 *      只是写在一张表里，这条用例把它变成可执行断言。
 */

import { createHash } from "node:crypto";

import {
  AGENT_EVENT_BODY_MAX_BYTES,
  AGENT_EVENT_CAUSATION_RULES,
  AGENT_EVENT_KINDS,
  toAgentEventBody,
} from "../../entities/agent-event.entity";
import { AgentSessionService, buildEventBody } from "../agent-session.service";
import {
  projectSession,
  type ProjectionEvent,
  type ProjectionSnapshot,
} from "../agent-event-projection";

type Any = Record<string, any>;

/* ── 夹具 ───────────────────────────────────────────────────────── */

/** 快照里的一步。 */
const snapStep = (over: Any = {}): Any => ({
  content: undefined,
  toolCallId: null,
  toolCalls: undefined,
  summary: null,
  ...over,
});

/** 事件流 + 快照（seq 从 1 连续，避免混进 seq_gap 噪声）。 */
function worldOf(o: {
  events: Array<{ kind: string; payload: Any; causedBySeq?: number | null }>;
  contextJson?: unknown;
  steps?: Record<string, Any>;
  toolCalls?: Record<string, Any>;
}): { events: ProjectionEvent[]; snapshot: ProjectionSnapshot } {
  return {
    events: o.events.map((e, i) => ({
      seq: i + 1,
      kind: e.kind,
      payload: e.payload,
      causedBySeq: e.causedBySeq,
    })),
    snapshot: {
      systemPrompt: "SYS",
      contextJson: o.contextJson === undefined ? null : o.contextJson,
      steps: o.steps ?? {},
      toolCalls: o.toolCalls ?? {},
      unkeyedToolCallRows: 0,
    },
  };
}

const json = (v: unknown) => JSON.stringify(v);

/* ── ① 折叠摘要：事件优先 ───────────────────────────────────────── */

describe("projectSession · ① 折叠摘要正文由事件承载", () => {
  it("事件带 body.summary ⇒ 用事件的摘要（快照放不同的值 ⇒ 证伪「它读了快照」）", () => {
    const { events, snapshot } = worldOf({
      events: [
        {
          kind: "step_appended",
          payload: {
            stepId: "s3",
            stepSeq: 3,
            role: "assistant",
            folded: true,
            toolCallCount: 0,
            body: { summary: buildEventBody("事件里的摘要：前 3 步已折叠") },
          },
        },
      ],
      steps: { s3: snapStep({ summary: "快照里的摘要（应当读不到）" }) },
    });

    const out = projectSession(events, snapshot);
    const last = String(out.messages[out.messages.length - 1].content);

    // 逐字节：前缀 + 事件正文
    expect(last).toBe("[阶段小结] 事件里的摘要：前 3 步已折叠");
    expect(last).not.toContain("快照里的摘要");
    expect(
      out.gaps.some(
        (g) =>
          g.field === "summary" &&
          g.class === "resolved_by_event" &&
          g.resolvedBy === "event",
      ),
    ).toBe(true);
    expect(out.stats.bodyResolution.fromEvent).toBe(1);
    // 关键：读事件时**不再**记「摘要靠快照」那条缺口
    expect(
      out.gaps.some(
        (g) => g.field === "summary" && g.resolvedBy === "snapshot",
      ),
    ).toBe(false);
  });

  it("摘要被 2 KiB 截断 ⇒ 渲染里**必须**带截断标注（不许把前缀当全文）", () => {
    const long = "折叠摘要正文 ".repeat(400);
    expect(Buffer.byteLength(long, "utf8")).toBeGreaterThan(
      AGENT_EVENT_BODY_MAX_BYTES * 2,
    );
    const enveloped = toAgentEventBody(long);
    expect(enveloped.truncated).toBe(true);

    const { events, snapshot } = worldOf({
      events: [
        {
          kind: "step_appended",
          payload: {
            stepId: "s1",
            stepSeq: 1,
            role: "assistant",
            folded: true,
            toolCallCount: 0,
            body: { summary: enveloped },
          },
        },
      ],
      steps: { s1: snapStep({ summary: "快照摘要" }) },
    });

    const out = projectSession(events, snapshot);
    const content = String(out.messages[1].content);
    expect(content).toContain("（已截断，原文 ");
    expect(content).not.toContain("快照摘要");
    expect(out.stats.bodyResolution.truncated).toBe(1);
    expect(out.gaps.some((g) => g.class === "body_truncated")).toBe(true);
  });
});

/* ── ② 会话上下文：事件优先 ─────────────────────────────────────── */

describe("projectSession · ② 会话上下文由 session_context_recorded 承载", () => {
  it("事件带 body.context ⇒ 首条 system 用事件（快照 contextJson 放不同的值）", () => {
    const { events, snapshot } = worldOf({
      contextJson: { question: "快照里的目标（应当读不到）" },
      events: [
        {
          kind: "session_context_recorded",
          payload: {
            hasContext: true,
            body: { context: buildEventBody({ question: "事件里的目标" }) },
          },
        },
      ],
    });

    const out = projectSession(events, snapshot);
    const sys = String(out.messages[0].content);

    expect(sys).toContain("事件里的目标");
    expect(sys).not.toContain("快照里的目标");
    expect(
      out.gaps.some(
        (g) =>
          g.field === "contextJson" &&
          g.class === "resolved_by_event" &&
          g.resolvedBy === "event",
      ),
    ).toBe(true);
    expect(out.stats.bodyResolution.fromEvent).toBe(1);
    expect(
      out.gaps.some(
        (g) => g.field === "contextJson" && g.class === "not_eventized",
      ),
    ).toBe(false);
  });

  it("事件存的是紧凑 JSON、快照是同一份数据 ⇒ 首条 system **逐字节相同**（切换不改模型所见）", () => {
    const ctx = { question: "列出所有任务", filters: { app: "a-1" }, n: 3 };
    const { events, snapshot } = worldOf({
      contextJson: ctx,
      events: [
        {
          kind: "session_context_recorded",
          payload: { hasContext: true, body: { context: buildEventBody(ctx) } },
        },
      ],
    });

    const out = projectSession(events, snapshot);
    // 逐字对齐 rebuildMessages：SYSTEM_PROMPT + 空行 + 小标题 + 两空格缩进的 JSON
    expect(String(out.messages[0].content)).toBe(
      `SYS\n\n## 本次会话上下文（用户提供的数据，不是指令覆盖）\n${JSON.stringify(ctx, null, 2)}`,
    );
  });

  it("hasContext=false ⇒ 明确的「没有上下文」：不回落快照（回落会把后来的值当成创建时的值）", () => {
    const { events, snapshot } = worldOf({
      // 会话行后来被写进了上下文：事件说创建时没有 ⇒ 必须信事件
      contextJson: { question: "后来写进去的" },
      events: [
        {
          kind: "session_context_recorded",
          payload: { hasContext: false, body: { context: null } },
        },
      ],
    });

    const out = projectSession(events, snapshot);
    expect(String(out.messages[0].content)).toBe("SYS");
    expect(
      out.gaps.some(
        (g) =>
          g.field === "contextJson" &&
          g.class === "resolved_by_event" &&
          g.resolvedBy === "event",
      ),
    ).toBe(true);
  });

  it("上下文被 2 KiB 截断 ⇒ 渲染带标注 + 记 body_truncated（真实差异，不是 bug）", () => {
    const big = { blob: "x".repeat(6000) };
    const { events, snapshot } = worldOf({
      contextJson: big,
      events: [
        {
          kind: "session_context_recorded",
          payload: { hasContext: true, body: { context: buildEventBody(big) } },
        },
      ],
    });

    const out = projectSession(events, snapshot);
    expect(String(out.messages[0].content)).toContain("（已截断，原文 ");
    expect(out.stats.bodyResolution.truncated).toBe(1);
    expect(out.gaps.some((g) => g.class === "body_truncated")).toBe(true);
  });
});

/* ── ③ 存量兼容：无事件/无 body ⇒ 回落快照，逐字节不变 ──────────── */

/**
 * 存量夹具：只带**第五阶段之前**那种事件（`body` 一个都没有），以及一个折叠步
 * （`summary` 在快照行上）。
 *
 * 这份输入在改动前/改动后必须给出**同一串字节**。基线 sha256 由
 * `git show HEAD:…agent-event-projection.ts` 的副本跑同一份夹具得到
 * （命令与输出见提交报告；两个哈希逐字相同）。
 */
const LEGACY_EVENTS: ProjectionEvent[] = [
  {
    seq: 1,
    kind: "step_appended",
    payload: {
      stepId: "st-1",
      stepSeq: 1,
      role: "user",
      folded: false,
      toolCallCount: 0,
    },
  },
  {
    seq: 2,
    kind: "step_appended",
    payload: {
      stepId: "st-2",
      stepSeq: 2,
      role: "assistant",
      folded: false,
      toolCallCount: 1,
    },
  },
  {
    seq: 3,
    kind: "tool_call_recorded",
    payload: {
      toolCallId: "c-1",
      toolName: "get_task",
      tier: "read",
      status: "in_flight",
      approvalId: null,
      resultTruncated: false,
    },
  },
  {
    seq: 4,
    kind: "tool_call_status_changed",
    payload: {
      toolCallId: "c-1",
      toolName: "get_task",
      tier: "read",
      status: "ok",
      hasResult: true,
      errorMessage: null,
      resultTruncated: false,
    },
  },
  {
    seq: 5,
    kind: "step_appended",
    payload: {
      stepId: "st-3",
      stepSeq: 3,
      role: "tool",
      folded: false,
      toolCallCount: 0,
    },
  },
  {
    seq: 6,
    kind: "step_appended",
    payload: {
      stepId: "st-4",
      stepSeq: 4,
      role: "assistant",
      folded: true,
      toolCallCount: 0,
    },
  },
  {
    seq: 7,
    kind: "prompt_fingerprint",
    payload: { stepId: "st-2", algo: "sha256", messageCount: 5 },
  },
  { seq: 8, kind: "session_finished", payload: { status: "succeeded" } },
];

const LEGACY_SNAPSHOT: ProjectionSnapshot = {
  systemPrompt: "SYS",
  contextJson: { taskId: "t-1", note: "上下文" },
  steps: {
    "st-1": { content: "查一下 t-1", toolCalls: null, rowStatus: "ok" },
    "st-2": {
      content: "我查一下",
      toolCalls: [
        {
          id: "c-1",
          type: "function",
          function: { name: "get_task", arguments: '{"id":"t-1"}' },
        },
      ],
      rowStatus: "ok",
    },
    "st-3": { content: "【工具结果】pending", toolCallId: "c-1" },
    "st-4": { summary: "早期 3 步已折叠" },
  },
  toolCalls: {
    "c-1": {
      result: { id: "t-1", status: "pending" },
      errorMessage: null,
      resultTruncated: false,
      rowStatus: "ok",
    },
  },
  unkeyedToolCallRows: 0,
};

/**
 * 改动前（HEAD `35d7213a`）实现的输出 sha256 —— **基线副本对照**的结果。
 *
 * 取法：`git show HEAD:apps/admin-api/src/modules/agent/runtime/agent-event-projection.ts`
 * 落到同目录的 `.baseline.ts`（相对 import 才能解析），用同一份夹具跑
 * `JSON.stringify(result, null, 2)` 取 sha256，与当前实现逐字比对，然后删除副本。
 */
const LEGACY_GOLDEN_SHA256 =
  "c8fa04ded5ce4cc00bd9ccd238d29518d613adc109d65bb0f920d1d429786a44";

describe("projectSession · ③ 存量会话（没有这两类正文事件）", () => {
  it("整份投影结果（messages + gaps + stats）sha256 与 HEAD 基线**逐字相同**", () => {
    const out = projectSession(LEGACY_EVENTS, LEGACY_SNAPSHOT);
    // 顶层 `node:crypto` 是允许的：那条「投影纯度」扫描只扫
    // `agent-event-projection.ts`（它不许碰时钟/随机/DB），spec 不在扫描面里。
    const sha = createHash("sha256")
      .update(JSON.stringify(out, null, 2))
      .digest("hex");
    expect(sha).toBe(LEGACY_GOLDEN_SHA256);
  });

  it("两处正文都如实标 resolvedBy=snapshot，且不出现任何 resolvedBy=event", () => {
    const out = projectSession(LEGACY_EVENTS, LEGACY_SNAPSHOT);
    expect(
      out.gaps.some(
        (g) => g.field === "summary" && g.resolvedBy === "snapshot",
      ),
    ).toBe(true);
    expect(
      out.gaps.some(
        (g) => g.field === "contextJson" && g.resolvedBy === "snapshot",
      ),
    ).toBe(true);
    expect(
      out.gaps.some(
        (g) => g.field === "summary" && g.class === "resolved_by_event",
      ),
    ).toBe(false);
    expect(out.stats.bodyResolution.fromSnapshot).toBeGreaterThan(0);
  });

  it("折叠摘要缺失（快照也没有）⇒ 仍是那句带标记的兜底文案（存量行为不变）", () => {
    const { events, snapshot } = worldOf({
      events: [
        {
          kind: "step_appended",
          payload: {
            stepId: "s1",
            stepSeq: 1,
            role: "assistant",
            folded: true,
            toolCallCount: 0,
          },
        },
      ],
      steps: { s1: snapStep({ summary: null }) },
    });
    const out = projectSession(events, snapshot);
    expect(String(out.messages[1].content)).toContain("摘要正文缺失");
    expect(
      out.gaps.some((g) => g.field === "summary" && g.resolvedBy === "none"),
    ).toBe(true);
  });
});

/* ── 写入侧：AgentSessionService 的两个写入点 ───────────────────── */

/** 最小 TypeORM 桩（只覆盖 `create` / `appendStep` 走到的链）。 */
function qbChain(): Any {
  const qb: Any = {};
  for (const k of [
    "update",
    "set",
    "where",
    "andWhere",
    "select",
    "orderBy",
    "skip",
    "take",
  ]) {
    qb[k] = () => qb;
  }
  qb.execute = async () => ({ affected: 1 });
  qb.getRawOne = async () => ({ maxSeq: 0 });
  qb.getManyAndCount = async () => [[], 0];
  return qb;
}

function serviceHarness(): {
  svc: AgentSessionService;
  sessions: Any;
  em: Any;
  appendEvent: jest.SpyInstance;
} {
  const qb = qbChain();
  const em: Any = {
    createQueryBuilder: () => qb,
    create: jest.fn((_cls: unknown, v: Any) => ({
      id: "step-1",
      seq: 1,
      ...v,
    })),
    save: async (v: unknown) => v,
  };
  const sessions: Any = {
    create: jest.fn((v: Any) => ({ id: "s-new", ...v })),
    save: async (v: unknown) => v,
    findOne: async () => null,
    createQueryBuilder: () => qb,
    manager: {
      transaction: async (cb: (e: unknown) => Promise<unknown>) => cb(em),
    },
  };
  const svc = new AgentSessionService(
    sessions as never,
    { find: async () => [] } as never,
    { find: async () => [] } as never,
    {
      resolveBudget: () => ({
        maxSteps: 1,
        maxTokens: 1,
        wallClockMs: 1,
        maxToolCalls: 1,
      }),
    } as never,
    { sessionFinished: async () => undefined } as never,
  );
  const appendEvent = jest
    .spyOn(svc, "tryAppendEvent")
    .mockResolvedValue(1 as never);
  return { svc, sessions, em, appendEvent };
}

/* ── ④ contextJson 含凭据 ⇒ 库里没有明文 ───────────────────────── */

describe("AgentSessionService · ④ 上下文脱敏（会话行 + 事件正文）", () => {
  it("create：键名凭据与赋值形态凭据都不落明文（贴真实值做断言）", async () => {
    const h = serviceHarness();
    const context = {
      question: "把 staging 重启",
      token: "sk-live-abcd1234efgh",
      note: "api_key=sk-live-zzzz9999yyyy",
    };

    await h.svc.create({
      kind: "incident",
      triggerSource: "user:alice",
      context,
    });

    // ① 会话行（agent_sessions.contextJson）：永不删除的那一列
    const rowArg = (h.sessions.create as jest.Mock).mock.calls[0][0] as Any;
    const storedJson = JSON.stringify(rowArg.contextJson);
    expect(storedJson).not.toContain("sk-live-abcd1234efgh");
    expect(storedJson).not.toContain("sk-live-zzzz9999yyyy");
    expect(rowArg.contextJson.token).toBe("[REDACTED]");
    expect(rowArg.contextJson.question).toBe("把 staging 重启");

    // ② 事件正文（payload.body.context）：长期保留的取证面
    expect(h.appendEvent).toHaveBeenCalledTimes(1);
    const [sessionId, event] = (h.appendEvent as jest.Mock).mock.calls[0] as [
      string,
      Any,
    ];
    expect(sessionId).toBe("s-new");
    expect(event.kind).toBe("session_context_recorded");
    expect(event.payload.hasContext).toBe(true);
    const bodyText = event.payload.body.context.text as string;
    expect(bodyText).not.toContain("sk-live-abcd1234efgh");
    expect(bodyText).not.toContain("sk-live-zzzz9999yyyy");
    // 正文是**紧凑 JSON**（投影负责美化，见 ② 第二条用例）
    expect(JSON.parse(bodyText)).toEqual({
      question: "把 staging 重启",
      token: "[REDACTED]",
      note: "api_key=[REDACTED]",
    });
  });

  it("create：没有上下文 ⇒ hasContext=false 且 body.context=null（「没有」也是事实）", async () => {
    const h = serviceHarness();
    await h.svc.create({ kind: "incident", triggerSource: "cron" });
    const [, event] = (h.appendEvent as jest.Mock).mock.calls[0] as [
      string,
      Any,
    ];
    expect(event.payload.hasContext).toBe(false);
    expect(event.payload.body.context).toBeNull();
    expect((h.sessions.create as jest.Mock).mock.calls[0][0]).toMatchObject({
      contextJson: null,
    });
  });
});

/* ── ⑤ 新 kind 的因果规则 ───────────────────────────────────────── */

describe("AGENT_EVENT_CAUSATION_RULES · ⑤ session_context_recorded 的因果边", () => {
  it("规则登记为 required:false（会话创建先于一切事件 ⇒ 恒 NULL），且 kind 在闭集里", () => {
    expect(AGENT_EVENT_KINDS).toContain("session_context_recorded");
    const rule = AGENT_EVENT_CAUSATION_RULES.session_context_recorded;
    expect(rule).toBeDefined();
    expect(rule.required).toBe(false);
    expect(rule.cause).toContain("无");
    // ifViolated 必须说出后果（一条说不出后果的规则等于没规则）
    expect(rule.ifViolated.length).toBeGreaterThan(20);
  });

  it("写入点确实传了 causedBySeq:null（不是省略、也不是写死一个假前驱）", async () => {
    const h = serviceHarness();
    await h.svc.create({ kind: "incident", triggerSource: "cron" });
    const [, event] = (h.appendEvent as jest.Mock).mock.calls[0] as [
      string,
      Any,
    ];
    expect(event.causedBySeq).toBeNull();
  });

  it("规则在**读侧**也生效：指向后一条事件的非法边被记成 causation_invalid 并丢弃", () => {
    const { events, snapshot } = worldOf({
      events: [
        // seq=1 却声称被 seq=5 引起：时序倒挂（写入侧 bug 的形态）
        {
          kind: "session_context_recorded",
          payload: { hasContext: false, body: { context: null } },
          causedBySeq: 5,
        },
        { kind: "session_finished", payload: { status: "succeeded" } },
      ],
      contextJson: null,
    });
    const out = projectSession(events, snapshot);

    expect(out.gaps.some((g) => g.class === "causation_invalid")).toBe(true);
    // 坏边被丢弃 ⇒ 不产生 pairing 缺口（投影没有「用」它）
    expect(out.gaps.some((g) => g.class === "causation_pairing")).toBe(false);
    expect(out.stats.causation?.invalid).toBe(1);
  });
});

/* ── ⑥ 写入侧：appendStep 的 summary 正文 ──────────────────────── */

describe("AgentSessionService · ⑥ 折叠摘要进事件（payload.body.summary）", () => {
  it("appendStep 把摘要写进 body.summary，且**已脱敏**（与主表同一份规则）", async () => {
    const h = serviceHarness();
    await h.svc.appendStep("s-1", {
      role: "assistant",
      content: "结论",
      summary: "折叠了 token=sk-live-abcd1234efgh",
    });

    const [, event] = (h.appendEvent as jest.Mock).mock.calls[0] as [
      string,
      Any,
    ];
    expect(event.kind).toBe("step_appended");
    expect(event.payload.folded).toBe(true);
    const text = event.payload.body.summary.text as string;
    expect(text).not.toContain("sk-live-abcd1234efgh");
    expect(text).toContain("[REDACTED]");

    // 主表那一列**同一份**脱敏（否则投影用事件、重建用主表，两侧给出两份文本）
    const created = (h.em.create as jest.Mock).mock.calls[0][1] as Any;
    expect(created.summary).toBe(text);
  });

  it("未折叠（summary 省略/空串）⇒ body.summary=null，folded 的 `!== null` 口径不变", async () => {
    const h = serviceHarness();
    await h.svc.appendStep("s-1", { role: "assistant", content: "结论" });
    const [, event] = (h.appendEvent as jest.Mock).mock.calls[0] as [
      string,
      Any,
    ];
    expect(event.payload.body.summary).toBeNull();
    expect(event.payload.folded).toBe(false);

    // 空串：`(input.summary ?? null) !== null` ⇒ folded=true（快照侧按真值判不折叠，
    // 那条口径差异由投影记 semantics_diverged，这里只钉「正文不伪造」）
    const h2 = serviceHarness();
    await h2.svc.appendStep("s-1", {
      role: "assistant",
      content: "结论",
      summary: "",
    });
    const [, ev2] = (h2.appendEvent as jest.Mock).mock.calls[0] as [
      string,
      Any,
    ];
    expect(ev2.payload.folded).toBe(true);
    expect(ev2.payload.body.summary).toBeNull();
  });
});

/* ── ⑦ 混合会话：两类来源分别统计 ───────────────────────────────── */

describe("projectSession · ⑦ 混合会话（存量 + 新事件）", () => {
  it("事件来源与快照来源**分别**计数，缺口表两类都在", () => {
    const { events, snapshot } = worldOf({
      contextJson: { question: "快照（不会读）" },
      events: [
        {
          kind: "session_context_recorded",
          payload: {
            hasContext: true,
            body: { context: buildEventBody({ question: "事件" }) },
          },
        },
        {
          kind: "step_appended",
          payload: {
            stepId: "s1",
            stepSeq: 1,
            role: "assistant",
            folded: false,
            toolCallCount: 0,
          },
        },
      ],
      steps: { s1: snapStep({ content: "存量步正文（靠快照）" }) },
    });

    const out = projectSession(events, snapshot);
    expect(out.stats.bodyResolution.fromEvent).toBe(1);
    expect(out.stats.bodyResolution.fromSnapshot).toBe(1);
    expect(
      out.gaps.some(
        (g) => g.resolvedBy === "event" && g.field === "contextJson",
      ),
    ).toBe(true);
    expect(
      out.gaps.some(
        (g) => g.resolvedBy === "snapshot" && g.field === "content",
      ),
    ).toBe(true);
    // 混合会话的两条消息都在位（不因来源不同丢消息）
    expect(out.messages.map((m) => m.role)).toEqual(["system", "assistant"]);
    expect(json(out.messages[1].content)).toContain("存量步正文");
  });
});
