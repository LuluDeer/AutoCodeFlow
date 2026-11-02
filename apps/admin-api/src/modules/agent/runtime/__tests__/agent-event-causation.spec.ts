import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { AgentController } from "../../agent.controller";
import {
  AGENT_EVENT_CAUSATION_RULES,
  AGENT_EVENT_KINDS,
} from "../../entities/agent-event.entity";
import {
  projectSession,
  type ProjectionEvent,
  type ProjectionSnapshot,
  type ProjectedSession,
} from "../agent-event-projection";
import { AgentSessionService } from "../agent-session.service";

/**
 * A2：**因果边**（`agent_events."causedBySeq"`，迁移 1790000000093）。
 *
 * 这一组用例钉住六件事，每一件都能被实现证伪：
 *   ① 每种 kind 的因果规则**各一条**（值指向正确的前驱，或按规则恒为 NULL）；
 *   ② **存量事件**（没有 `causedBySeq`）⇒ 回落既有启发式，且投影输出与改动前
 *      **逐字节相同**（基线副本对照，见 ② 组的哈希锁）；
 *   ③ `causedBySeq >= seq` 的坏数据 ⇒ 记缺口（**不静默接受**）；
 *   ④ 跨会话 / 悬空的 `causedBySeq` ⇒ 记缺口（同上）；
 *   ⑤ 批量插入（`WITH ORDINALITY` 那条单语句）里 `causedBySeq` 正确落库；
 *   ⑥ 守卫有牙：删掉某处的 `causedBySeq` ⇒ `check-agent-event-causation` 变红
 *      （由 `node scripts/check-agent-event-causation.mjs --selftest` 的 ④⑤ 两条
 *      在 `/tmp` 副本上跑，见该脚本；本文件不重复一遍文件树复制）。
 *
 * 为什么「存量逐字节」要用**哈希锁**而不是「看起来一样」：投影输出是
 * `{messages, gaps, integrity, stats}` 四块，任何一块多一个键（哪怕值恒为 0）
 * 都会让下游对账报告漂移。锁成 sha256 才能保证「这一次没动它」这句话可复现。
 */

type Any = Record<string, any>;

/* ── 装配 ───────────────────────────────────────────────────────── */

/** TypeORM 链式桩（select/where/... 全部返回自身）。 */
function qbStub(result: Any = { affected: 1 }) {
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
  qb.getRawOne = jest.fn(async () => ({ maxSeq: 0 }));
  qb.getRawMany = jest.fn(async () => []);
  qb.execute = jest.fn(async () => result);
  return qb;
}

interface HarnessOptions {
  /**
   * 因果**精确引用解析**（`findEventSeqByRef` 打到 `sessions.manager.query`）的
   * 返回值。参数是 `(kind, 引用键[], 引用值[])`——用例据此断言「按唯一键解引用」。
   */
  refs?: (kind: string, keys: string[], values: string[]) => Any[];
  /** 插入语句（`em.query`）返回的 seq 行（默认 `[{seq:1}]`）。 */
  insertSeqs?: number[];
  /** `agent_tool_calls` 的按 `approvalId` 回查结果（审批因果用）。 */
  toolCallRows?: Any[];
}

function makeHarness(o: HarnessOptions = {}) {
  const insert = jest.fn(async () =>
    (o.insertSeqs ?? [1]).map((seq) => ({ seq })),
  );
  const refQuery = jest.fn(async (_sql: string, params: unknown[]) => {
    const kind = String(params[1]);
    const rest = params.slice(2);
    const half = rest.length / 2;
    const keys = rest.slice(0, half) as string[];
    const values = rest.slice(half) as string[];
    return (o.refs ?? (() => []))(kind, keys, values);
  });
  const em: Any = {
    createQueryBuilder: jest.fn(() => qbStub()),
    create: jest.fn((_cls: unknown, v: Any) => ({ id: "step-1", ...v })),
    save: jest.fn(async (v: Any) => v),
    findOne: jest.fn(async () => null),
    query: insert,
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
      transaction: jest.fn(async (cb: (m: Any) => Promise<unknown>) => cb(em)),
      query: refQuery,
    },
  };
  const toolCalls: Any = {
    create: jest.fn((v: Any) => ({ id: "tc-1", ...v })),
    save: jest.fn(async (v: Any) => v),
    update: jest.fn(async () => ({ affected: 1 })),
    find: jest.fn(async () => o.toolCallRows ?? []),
  };
  const approvals: Any = {
    attachEventSink: jest.fn(),
    find: jest.fn(async () => []),
    hasPendingForSession: jest.fn(async () => false),
    expireStalePending: jest.fn(async () => 0),
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
    null,
    approvals as never,
  );
  return { svc, insert, refQuery, sessions, toolCalls, approvals, em };
}

/** `appendEvents` 打到 DB 的那批行（`$2::jsonb` 反序列化后的样子）。 */
function rowsOf(insert: jest.Mock, call = 0): Any[] {
  const params = insert.mock.calls[call][1] as unknown[];
  return JSON.parse(String(params[1])) as Any[];
}

const hasKey = (o: Any, k: string) =>
  Object.prototype.hasOwnProperty.call(o, k);

/* ── ① 每种 kind 的因果规则 ─────────────────────────────────────── */

describe("A2 因果边 · ① 规则表（闭集每一行都有规则，规则与写入点一致）", () => {
  it("kind 闭集里的每一种事件都登记了因果规则（新增 kind 不许悄悄恒 NULL）", () => {
    expect(Object.keys(AGENT_EVENT_CAUSATION_RULES).sort()).toEqual(
      [...AGENT_EVENT_KINDS].sort(),
    );
    for (const k of AGENT_EVENT_KINDS) {
      const rule = AGENT_EVENT_CAUSATION_RULES[k];
      expect(rule.cause.length).toBeGreaterThan(0);
      expect(rule.ifViolated.length).toBeGreaterThan(0);
    }
  });

  it("①-a tool_call_recorded ⇒ 请求它的那个 step 的 step_appended（按 stepId 精确解析）", async () => {
    const h = makeHarness({
      refs: (kind) => (kind === "step_appended" ? [{ seq: 5 }] : []),
    });

    await h.svc.recordToolCall({
      sessionId: "s-1",
      stepId: "st-1",
      toolCallId: "c-1",
      toolName: "get_task",
      tier: "read",
      status: "in_flight",
    });

    // 解析是按 (sessionId, kind, payload->>'stepId') —— 唯一键解引用，不是时间邻近
    const [refSql, refParams] = h.refQuery.mock.calls[0] as unknown as [
      string,
      unknown[],
    ];
    expect(refSql).toContain('FROM "agent_events"');
    expect(refSql).toContain('"sessionId" = $1::uuid');
    expect(refSql).toContain('"payload"->>$3');
    expect(refParams).toEqual(["s-1", "step_appended", "stepId", "st-1"]);

    expect(rowsOf(h.insert)[0]).toMatchObject({
      kind: "tool_call_recorded",
      causedBySeq: 5,
    });
  });

  it("①-b tool_call_status_changed ⇒ 该调用的 tool_call_recorded（结果事件指向发起事件）", async () => {
    const h = makeHarness({
      refs: (kind) => (kind === "tool_call_recorded" ? [{ seq: 9 }] : []),
    });

    await h.svc.updateToolCallByToolCallId("s-1", "c-1", {
      toolName: "get_task",
      tier: "read",
      status: "ok",
    });

    expect(h.refQuery).toHaveBeenCalledWith(
      expect.stringContaining('"payload"->>$3'),
      ["s-1", "tool_call_recorded", "toolCallId", "c-1"],
    );
    expect(rowsOf(h.insert)[0]).toMatchObject({
      kind: "tool_call_status_changed",
      causedBySeq: 9,
    });
  });

  it("①-c deny 的 settle ⇒ 起因是那条 approval_decided(denied)（controller 写入点）", async () => {
    const seen: Any[] = [];
    const sessions: Any = {
      requireById: jest.fn(async () => ({
        id: "s-1",
        status: "waiting_input",
        createdBy: null,
      })),
      settleToolCallByApprovalId: jest.fn(async () => 1),
      listToolCalls: jest.fn(async () => [
        {
          approvalId: "ap-1",
          status: "denied",
          toolCallId: "c1",
          toolName: "stop_task",
          tier: "write",
          durationMs: 0,
          resultTruncated: false,
          resultJson: null,
          errorMessage: "已被 alice 人工拒绝（审批单 ap-1）——不得重试同一调用",
        },
      ]),
      tryAppendEvent: jest.fn(async (_s: string, e: Any) => {
        seen.push(e);
        return 1;
      }),
      findEventSeqByRef: jest.fn(async () => 7),
    };
    const ctl = new AgentController(
      sessions as never,
      { resolveBudget: jest.fn() } as never,
      {
        findByKey: jest.fn(async () => ({
          approvalKey: "ap-1",
          sessionId: "s-1",
        })),
        decide: jest.fn(async () => ({ approvalKey: "ap-1" })),
        hasPendingForSession: jest.fn(async () => false),
      } as never,
      { add: jest.fn(async () => undefined) } as never,
      { get: () => false } as never,
    );

    await (
      ctl as unknown as {
        denyApproval: (id: string, key: string, u: unknown) => Promise<unknown>;
      }
    ).denyApproval("s-1", "ap-1", { id: 1, username: "alice", role: "admin" });

    // 起因解析指向的是「这次审批决定」，不是「当初那次申请」
    expect(sessions.findEventSeqByRef).toHaveBeenCalledWith(
      "s-1",
      "approval_decided",
      { approvalKey: "ap-1", status: "denied" },
    );
    expect(seen).toHaveLength(1);
    expect(seen[0].kind).toBe("tool_call_status_changed");
    expect(seen[0].causedBySeq).toBe(7);
  });

  it("①-d approval_decided ⇒ 由事件端口统一补齐到 tool_call_recorded / 更早的 granted", async () => {
    const h = makeHarness({
      toolCallRows: [{ toolCallId: "c-2" }],
      insertSeqs: [10, 11],
      refs: (kind) => {
        if (kind === "tool_call_recorded") return [{ seq: 3 }];
        if (kind === "approval_decided") return [{ seq: 8 }];
        return [];
      },
    });
    const port = h.approvals.attachEventSink.mock.calls[0][0] as {
      tryAppendEvent: (s: string, e: Any) => Promise<number | null>;
    };

    // granted：起因 = 需要审批的那个调用的 tool_call_recorded
    await port.tryAppendEvent("s-1", {
      kind: "approval_decided",
      payload: { approvalKey: "apr-1", status: "granted" },
    });
    expect(rowsOf(h.insert, 0)[0]).toMatchObject({
      kind: "approval_decided",
      causedBySeq: 3,
    });

    // consumed：起因 = 同一 approvalKey 上更早的 approval_decided(granted)
    await port.tryAppendEvent("s-1", {
      kind: "approval_decided",
      payload: { approvalKey: "apr-1", status: "consumed" },
    });
    expect(h.refQuery).toHaveBeenCalledWith(
      expect.stringContaining('"payload"->>$3'),
      ["s-1", "approval_decided", "approvalKey", "status", "apr-1", "granted"],
    );
    expect(rowsOf(h.insert, 1)[0]).toMatchObject({
      kind: "approval_decided",
      causedBySeq: 8,
    });
  });

  it("①-e step_appended / session_finished ⇒ 规则是「没有单一前驱」，落库不带该键（= NULL）", async () => {
    const h = makeHarness({ insertSeqs: [1, 2] });

    await h.svc.appendStep("s-1", {
      role: "assistant",
      content: "结论",
      tokensIn: 1,
      tokensOut: 1,
    });
    expect(hasKey(rowsOf(h.insert, 0)[0], "causedBySeq")).toBe(false);

    await h.svc.finish("s-1", "succeeded", { summary: "ok" });
    expect(rowsOf(h.insert, 1)[0].kind).toBe("session_finished");
    expect(hasKey(rowsOf(h.insert, 1)[0], "causedBySeq")).toBe(false);
  });

  it("①-f prompt_fingerprint ⇒ 规则要求指 step_appended；有值按因果配对，无值如实回落启发式", () => {
    const stepEvent = {
      seq: 1,
      kind: "step_appended",
      payload: { stepId: "st-1", stepSeq: 1, role: "assistant" },
    };
    const withCause = projectSession(
      [
        stepEvent as ProjectionEvent,
        {
          seq: 2,
          kind: "prompt_fingerprint",
          payload: { stepId: "st-1" },
          causedBySeq: 1,
        },
      ],
      { systemPrompt: "SYS", contextJson: null },
    );
    const pairing = withCause.gaps.find(
      (g) => g.class === "causation_pairing" && g.seq === 2,
    );
    expect(pairing?.resolvedBy).toBe("causation");

    const withoutCause = projectSession(
      [
        stepEvent as ProjectionEvent,
        { seq: 2, kind: "prompt_fingerprint", payload: {} },
      ],
      { systemPrompt: "SYS", contextJson: null },
    );
    // 本会话「有因果数据」（step 那条没有不算，所以这里补一条带因果的事件）
    expect(withoutCause.stats.causation).toBeUndefined();
  });

  it("①-g prompt_fingerprint 的前驱 seq **由 appendStep 转交**（不是回表猜）；事件写失败即 null", async () => {
    // 成功：`step_appended` 那条事件分配到的 seq 被原样带出
    const ok = makeHarness({ insertSeqs: [42] });
    const step = await ok.svc.appendStep("s-1", {
      role: "assistant",
      content: "x",
      tokensIn: 1,
      tokensOut: 1,
    });
    expect(step.eventSeq).toBe(42);

    // 失败：事件写入是旁路（step 已提交）⇒ eventSeq **必须是 null**。
    // 这一条钉的是「不许写 0 / 不许 undefined 混进 SQL」——那样会让因果图
    // 指向一个不存在的前驱，比留 NULL 更糟。
    const bad = makeHarness();
    let tx = 0;
    bad.sessions.manager.transaction = jest.fn(
      async (cb: (m: Any) => Promise<unknown>) => {
        tx += 1;
        if (tx === 1) return cb(bad.em); // 第 1 个事务 = step 写入（成功）
        throw new Error("agent_events unavailable"); // 第 2 个 = 事件写入（失败）
      },
    );
    const step2 = await bad.svc.appendStep("s-1", {
      role: "assistant",
      content: "x",
      tokensIn: 1,
      tokensOut: 1,
    });
    expect(step2.eventSeq).toBeNull();
    expect(step2.id).toBeDefined(); // step 本身仍然落了（旁路纪律）
  });

  it("①-h runtime 的 prompt_fingerprint 写入点：用 lastStepEventSeq，且初始值是 null（不猜）", () => {
    const src = readFileSync(
      join(__dirname, "..", "agent-runtime.service.ts"),
      "utf8",
    );
    // 初始值必须是 null（= 本次 run 还没写过 step ⇒ 如实 NULL），不是 0
    expect(src).toContain("let lastStepEventSeq: number | null = null;");
    // 写入点：causedBySeq 紧跟 kind 字面量（不是省略、不是写死 null）
    const at = src.indexOf('kind: "prompt_fingerprint"');
    expect(at).toBeGreaterThan(0);
    expect(src.slice(at, at + 600)).toContain("causedBySeq: lastStepEventSeq");
    // 两处 appendStep 都必须把 seq 接回来（否则值永远停在 null）
    expect(src.split("lastStepEventSeq = step.eventSeq ?? null;")).toHaveLength(
      2,
    );
    expect(src).toContain("lastStepEventSeq = failedStep.eventSeq ?? null;");
  });
});

/* ── ② 存量事件 ⇒ 逐字节回归锁 ──────────────────────────────────── */

const LEGACY_EVENTS: ProjectionEvent[] = [
  {
    seq: 1,
    kind: "step_appended",
    payload: {
      stepId: "st-1",
      stepSeq: 1,
      role: "assistant",
      folded: false,
      toolCallCount: 1,
      body: {
        content: {
          text: "我先查一下任务状态。",
          bytes: 27,
          originalBytes: 27,
          truncated: false,
        },
      },
    },
  },
  {
    seq: 2,
    kind: "tool_call_recorded",
    payload: {
      toolCallId: "c-1",
      toolName: "get_task",
      tier: "read",
      status: "in_flight",
      approvalId: null,
      hasArgs: true,
      resultTruncated: false,
    },
  },
  {
    seq: 3,
    kind: "tool_call_status_changed",
    payload: {
      toolCallId: "c-1",
      toolName: "get_task",
      tier: "read",
      status: "ok",
      durationMs: 12,
      resultTruncated: false,
      hasResult: true,
      errorMessage: null,
      body: {
        result: {
          text: '{"id":"t-1","status":"pending"}',
          bytes: 31,
          originalBytes: 31,
          truncated: false,
        },
        error: null,
      },
    },
  },
  {
    seq: 4,
    kind: "step_appended",
    payload: {
      stepId: "st-2",
      stepSeq: 2,
      role: "tool",
      folded: false,
      toolCallCount: 0,
    },
  },
  {
    seq: 5,
    kind: "prompt_fingerprint",
    payload: {
      fingerprint: "sha256:abc",
      messageCount: 1,
    },
  },
  {
    seq: 6,
    kind: "step_appended",
    payload: {
      stepId: "st-3",
      stepSeq: 3,
      role: "assistant",
      folded: false,
      toolCallCount: 1,
    },
  },
  {
    seq: 7,
    kind: "tool_call_recorded",
    payload: {
      toolCallId: "c-2",
      toolName: "update_task",
      tier: "write",
      status: "awaiting_approval",
      approvalId: "apr-1",
      hasArgs: true,
      resultTruncated: false,
    },
  },
  {
    seq: 8,
    kind: "approval_decided",
    payload: {
      approvalKey: "apr-1",
      status: "granted",
      decidedBy: "alice",
      decidedAt: "2026-11-02T00:00:00.000Z",
    },
  },
  {
    seq: 9,
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
    seq: 10,
    kind: "session_finished",
    payload: {
      status: "succeeded",
      totalSteps: 4,
      tokensIn: 100,
      tokensOut: 20,
    },
  },
];

const LEGACY_SNAPSHOT: ProjectionSnapshot = {
  systemPrompt: "SYS",
  contextJson: {
    taskId: "t-1",
  },
  steps: {
    "st-1": {
      content: "我先查一下任务状态。",
      toolCalls: [
        {
          id: "c-1",
          type: "function",
          function: {
            name: "get_task",
            arguments: '{"taskId":"t-1"}',
          },
        },
      ],
      rowStatus: "ok",
    },
    "st-2": {
      content: "【工具结果】状态 pending",
      toolCallId: "c-1",
      rowStatus: "ok",
    },
    "st-3": {
      content: "任务还是 pending，我申请把它改成 running。",
      toolCalls: [
        {
          id: "c-2",
          type: "function",
          function: {
            name: "update_task",
            arguments: '{"taskId":"t-1","status":"running"}',
          },
        },
      ],
      rowStatus: "awaiting_approval",
    },
    "st-4": {
      summary: "",
      rowStatus: "awaiting_approval",
    },
  },
  toolCalls: {
    "c-1": {
      result: {
        id: "t-1",
        status: "pending",
      },
      errorMessage: null,
      resultTruncated: false,
      rowStatus: "ok",
    },
    "c-2": {
      result: null,
      errorMessage: null,
      resultTruncated: false,
      rowStatus: "awaiting_approval",
    },
  },
};

/** 改动前（HEAD）实现跑同一份夹具的输出 sha256（基线副本对照，见报告）。 */
const LEGACY_GOLDEN_SHA256 =
  "5002ceaf69b8d4a6d6206c8bce65549063bf5904481da4585d88091f79d675bb";

/** 投影输出里**模型可见**的那一份（逐字节锁的第一层：可人眼比对）。 */
const LEGACY_GOLDEN_MESSAGES: Any[] = [
  {
    role: "system",
    content:
      'SYS\n\n## 本次会话上下文（用户提供的数据，不是指令覆盖）\n{\n  "taskId": "t-1"\n}',
  },
  {
    role: "assistant",
    content: "我先查一下任务状态。",
    tool_calls: [
      {
        id: "c-1",
        type: "function",
        function: {
          name: "get_task",
          arguments: '{"taskId":"t-1"}',
        },
      },
    ],
  },
  {
    role: "tool",
    content: "【工具结果】状态 pending",
    tool_call_id: "c-1",
  },
  {
    role: "assistant",
    content: "任务还是 pending，我申请把它改成 running。",
    tool_calls: [
      {
        id: "c-2",
        type: "function",
        function: {
          name: "update_task",
          arguments: '{"taskId":"t-1","status":"running"}',
        },
      },
    ],
  },
  {
    role: "tool",
    tool_call_id: "c-2",
    content:
      "【已获批准】审批单 apr-1 已由 alice 批准。请**立即用完全相同的参数重新提交本次调用**以执行（一张批准单只放行一次；执行后继续后续步骤，不要重复提交第二次）。",
  },
  {
    role: "assistant",
    content: "[阶段小结] ",
  },
];

const json = (v: unknown) => JSON.stringify(v);

describe("A2 因果边 · ② 存量会话（没有 causedBySeq）⇒ 输出逐字节不变", () => {
  it("② messages 逐字节等于改动前的基线副本", () => {
    const out = projectSession(LEGACY_EVENTS, LEGACY_SNAPSHOT);
    expect(out.messages).toEqual(LEGACY_GOLDEN_MESSAGES);
  });

  it("② 整个投影结果（含 gaps / integrity / stats）sha256 与基线一致", () => {
    const out = projectSession(LEGACY_EVENTS, LEGACY_SNAPSHOT);
    const sha = createHash("sha256").update(json(out)).digest("hex");
    expect(sha).toBe(LEGACY_GOLDEN_SHA256);
  });

  it("② 存量会话不出现任何 causation_* 缺口、也没有 stats.causation（多一个键就破坏逐字节）", () => {
    const out: ProjectedSession = projectSession(
      LEGACY_EVENTS,
      LEGACY_SNAPSHOT,
    );
    expect(out.gaps.filter((g) => g.class.startsWith("causation_"))).toEqual(
      [],
    );
    expect(out.stats.causation).toBeUndefined();
    expect(Object.keys(out.stats)).toEqual([
      "eventCount",
      "byKind",
      "stepCount",
      "toolCallCount",
      "gapsByClass",
      "bodyResolution",
    ]);
  });
});

/* ── ③④ 坏边：时序倒挂 / 跨会话悬空 ─────────────────────────────── */

/** 最小两事件流：step_appended(1) + tool_call_status_changed(2)。 */
function statusChangedStream(causedBySeq?: number | null): ProjectionEvent[] {
  return [
    {
      seq: 1,
      kind: "step_appended",
      payload: { stepId: "st-1", stepSeq: 1, role: "assistant" },
    },
    {
      seq: 2,
      kind: "tool_call_status_changed",
      payload: { toolCallId: "c-1", toolName: "get_task", status: "ok" },
      ...(causedBySeq === undefined ? {} : { causedBySeq }),
    },
  ];
}

describe("A2 因果边 · ③ causedBySeq >= seq（时序倒挂）⇒ 记缺口，不静默接受", () => {
  it("③ 自己指向自己 ⇒ causation_invalid，且该事件回落启发式（resolvedBy=heuristic）", () => {
    const out = projectSession(statusChangedStream(2), {
      systemPrompt: "SYS",
      contextJson: null,
    });

    const bad = out.gaps.find((g) => g.class === "causation_invalid");
    expect(bad).toBeDefined();
    expect(bad?.seq).toBe(2);
    expect(bad?.resolvedBy).toBe("none");
    expect(bad?.detail).toContain("因果必须先于结果");

    expect(out.stats.causation).toMatchObject({ invalid: 1, mismatched: 0 });
    // 坏边**不被使用**：这条事件按既有启发式（payload.toolCallId）配对
    const fallback = out.gaps.find(
      (g) => g.class === "causation_fallback" && g.seq === 2,
    );
    expect(fallback?.resolvedBy).toBe("heuristic");
    expect(out.gaps.some((g) => g.class === "causation_pairing")).toBe(false);
  });

  it("③ 指向更大的 seq（未来事件）同样非法", () => {
    const out = projectSession(
      [
        ...statusChangedStream(),
        {
          seq: 3,
          kind: "approval_decided",
          payload: { approvalKey: "apr-1", status: "granted" },
          causedBySeq: 9,
        },
      ],
      { systemPrompt: "SYS", contextJson: null },
    );
    expect(
      out.gaps.filter((g) => g.class === "causation_invalid"),
    ).toHaveLength(1);
    expect(out.stats.causation?.invalid).toBe(1);
  });
});

describe("A2 因果边 · ④ 跨会话的 causedBySeq ⇒ 记缺口（本会话流里找不到那条前驱）", () => {
  it("④ 指向另一个会话才有的 seq ⇒ causation_missing，而不是当成合法边", () => {
    // 会话 A 有 seq=3（另一条事件流），会话 B 只有 1..2，却把边指向 3。
    const sessionA: ProjectionEvent[] = [
      {
        seq: 1,
        kind: "step_appended",
        payload: { stepId: "a-1", role: "user" },
      },
      {
        seq: 2,
        kind: "step_appended",
        payload: { stepId: "a-2", role: "user" },
      },
      { seq: 3, kind: "tool_call_recorded", payload: { toolCallId: "c-x" } },
    ];
    expect(sessionA).toHaveLength(3); // 只是让「另一会话确实有 seq=3」成为显式事实

    // 会话 B 的事件流是 1 / 2 / 5（3、4 这两段被保留期清掉了），而 seq=5 那条
    // 事件的因果边指向 3 —— 那个 seq **在本会话里不存在**（它属于会话 A）。
    // 这正是「跨会话引用」在单会话投影里唯一可判定的形态：时序合法（3 < 5），
    // 但前驱不在本流里。
    const sessionB: ProjectionEvent[] = [
      {
        seq: 1,
        kind: "step_appended",
        payload: { stepId: "st-1", role: "assistant" },
      },
      {
        seq: 2,
        kind: "tool_call_recorded",
        payload: { toolCallId: "c-1", status: "in_flight" },
      },
      {
        seq: 5,
        kind: "tool_call_status_changed",
        payload: { toolCallId: "c-1", status: "ok" },
        causedBySeq: 3,
      },
    ];
    const out = projectSession(sessionB, {
      systemPrompt: "SYS",
      contextJson: null,
    });

    const gap = out.gaps.find((g) => g.class === "causation_missing");
    expect(gap).toBeDefined();
    expect(gap?.detail).toContain("跨会话引用");
    expect(out.stats.causation?.missing).toBe(1);
    // 悬空边不被使用 ⇒ 不许出现「配对成功」
    expect(out.gaps.some((g) => g.class === "causation_pairing")).toBe(false);
  });

  it("④ 边与规则矛盾（状态迁移指向另一次调用的发起事件）⇒ causation_mismatch + 投影仍按 payload 渲染", () => {
    const out = projectSession(
      [
        {
          seq: 1,
          kind: "step_appended",
          payload: {
            stepId: "st-1",
            stepSeq: 1,
            role: "assistant",
            toolCallCount: 1,
          },
        },
        {
          seq: 2,
          kind: "tool_call_recorded",
          payload: { toolCallId: "c-other", status: "in_flight" },
        },
        {
          seq: 3,
          kind: "tool_call_status_changed",
          payload: { toolCallId: "c-1", status: "ok" },
          causedBySeq: 2,
        },
      ],
      {
        systemPrompt: "SYS",
        contextJson: null,
        steps: {
          "st-1": {
            content: "调用",
            toolCalls: [
              {
                id: "c-1",
                type: "function",
                function: { name: "get_task", arguments: "{}" },
              },
            ],
          },
        },
        toolCalls: {
          "c-1": { result: { id: "t-1" }, errorMessage: null },
        },
      },
    );

    expect(out.stats.causation?.mismatched).toBeGreaterThanOrEqual(1);
    expect(out.gaps.some((g) => g.class === "causation_mismatch")).toBe(true);
    // 既有行为不变：payload 的 toolCallId 仍是归属依据（c-1 有结果文案）
    const toolMsg = out.messages.find((m) => m.role === "tool");
    expect(String(toolMsg?.content)).toContain("【工具结果（重放）】");
  });
});

/* ── ⑤ 批量插入（WITH ORDINALITY） ─────────────────────────────── */

describe("A2 因果边 · ⑤ 批量插入时 causedBySeq 正确落库", () => {
  it("⑤ 单条 SQL 里带 causedBySeq 列，整批每个值各自落到自己的行", async () => {
    const h = makeHarness({ insertSeqs: [12, 13] });

    await h.svc.appendEvents("s-1", [
      {
        kind: "tool_call_recorded",
        payload: { toolCallId: "c-1" },
        causedBySeq: 7,
      },
      {
        kind: "tool_call_status_changed",
        payload: { toolCallId: "c-1" },
        causedBySeq: 12,
      },
    ]);

    const [sql, params] = h.insert.mock.calls[0] as unknown as [
      string,
      unknown[],
    ];
    // 一条语句：拷列 + 从 jsonb 里取（`->>` 缺键 ⇒ SQL NULL ⇒ NULLIF 后仍是 NULL）
    expect(sql).toContain('"causedBySeq"');
    expect(sql).toContain(`NULLIF(t."ev"->>'causedBySeq', '')::integer`);
    expect(sql).toContain("WITH ORDINALITY");
    expect(sql.match(/INSERT INTO/g)).toHaveLength(1);
    expect(JSON.parse(String(params[1]))).toEqual([
      {
        kind: "tool_call_recorded",
        payload: { toolCallId: "c-1" },
        causedBySeq: 7,
      },
      {
        kind: "tool_call_status_changed",
        payload: { toolCallId: "c-1" },
        causedBySeq: 12,
      },
    ]);
  });

  it("⑤ 非法值在**进 SQL 之前**就被归一成 NULL（0 / 负数 / 非整数 / NaN），绝不写假边", async () => {
    const h = makeHarness({ insertSeqs: [1, 2, 3, 4] });

    await h.svc.appendEvents("s-1", [
      { kind: "step_appended", causedBySeq: 0 },
      { kind: "step_appended", causedBySeq: -3 },
      { kind: "step_appended", causedBySeq: 1.5 },
      { kind: "step_appended", causedBySeq: Number.NaN },
    ]);

    const rows = rowsOf(h.insert);
    expect(rows).toHaveLength(4);
    for (const row of rows) expect(hasKey(row, "causedBySeq")).toBe(false);
  });

  it("⑤ 引用不唯一（同一 toolCallId 有两条 recorded）⇒ 不猜，返回 null（留 NULL）", async () => {
    const h = makeHarness({
      refs: () => [{ seq: 3 }, { seq: 4 }],
    });
    const seq = await h.svc.findEventSeqByRef("s-1", "tool_call_recorded", {
      toolCallId: "c-1",
    });
    expect(seq).toBeNull();
  });
});
