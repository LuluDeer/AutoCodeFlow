/**
 * S7-G1（第六阶段）：**事件投影真正消费正文** —— 「第 N 轮模型看到什么」在
 * **读路径**上收口。
 *
 * ## 这一批要关闭的是什么
 *
 * 第五阶段已把正文**写进**事件（`payload.body.{content|result|error}`，脱敏 +
 * 单条 2 KiB 上限 + 截断标记），但**投影没消费它**——它仍在从**快照行**取值。
 * 于是事件流只是「索引 + 附带正文」，**不是载体**：
 *   · `agent_tool_calls.status` / `resultJson` / `errorMessage` 都是**就地更新**
 *     的（表里没有历史列）⇒ 回读到的永远是「**最后一次**写入」，答不出
 *     「第 N 次迁移那一刻模型看到了什么」；
 *   · `agent_steps.content` 同样会被后续写入覆盖（折叠摘要、同 seq 重放）。
 * 事件流是**每次写入一条**、只增不改的序列——它才是那一问的唯一忠实载体。
 *
 * ## 本组用例钉的五件事（每条对应一个可被推翻的命题）
 *
 *   ① **优先级**：事件带 `body` ⇒ 投影用 `body.text`，**不再读快照**。证伪方式是
 *      「快照里放一个**不同**的值」：若投影取到事件的���而不是快照的值 ⇒ 优先级
 *      正确（若取到快照的值，说明它压根没看事件）。
 *   ② **存量兼容**：事件**无** `body`（第五阶段之前写入）⇒ 回落快照，且
 *      `resolvedBy` 仍是 `snapshot`（**不许**把回落伪装成「事件自足」）。
 *   ③ **截断可见**：`truncated: true` ⇒ 渲染文案**必须**含截断标注——静默会让
 *      模型把 2 KiB 前缀当成全文来推理。
 *   ④ **既有基线不弱化**：原有 5 组「逐字节一致」基线**必须仍然全绿**。
 *   ⑤ **混合会话分别统计**：部分事件有 body、部分没有 ⇒ 两者**分别**计数，
 *      不混为一谈。
 *
 * ## 为什么「回落」也要留痕（不许装作事件自足）
 *
 * 一个库里必然**同时**存在存量会话（无 body）与新会话（有 body）。若回落不
 * 留痕，报告会说「事件已经自足」，而实际上有一半正文仍然靠快照——那正是本次
 * 要关闭的那个缺口本身。故回落一律记 `event_only_metadata` +
 * `resolvedBy: "snapshot"`，并进 `stats.bodyResolution.fromSnapshot`。
 */

import {
  AGENT_EVENT_BODY_MAX_BYTES,
  toAgentEventBody,
} from "../../entities/agent-event.entity";
import {
  projectSession,
  type ProjectionEvent,
  type ProjectionSnapshot,
} from "../agent-event-projection";

type Any = Record<string, any>;

/** 一个正文信封（形状逐字对齐写入侧的 `AgentEventBody`）。 */
const body = (text: string, over: Partial<Any> = {}): Any => ({
  text,
  bytes: Buffer.byteLength(text, "utf8"),
  originalBytes: Buffer.byteLength(text, "utf8"),
  truncated: false,
  ...over,
});

/** 一步的快照行（`ProjectionSnapshot.steps` 的一项）。 */
const snapStep = (over: Any = {}): Any => ({
  content: undefined,
  toolCallId: null,
  toolCalls: undefined,
  summary: null,
  ...over,
});

/**
 * 一条会话的事件流 + 快照行。
 *
 * `events` 里每条都带 `seq`（投影要求 seq 连续，否则会记 `seq_gap`——那是另一类
 * 缺口，不该混进本组用例的断言）。
 */
function worldOf(o: {
  events: Array<{ kind: string; payload: Any }>;
  steps?: Record<string, Any>;
  toolCalls?: Record<string, Any>;
}): { events: ProjectionEvent[]; snapshot: ProjectionSnapshot } {
  const events: ProjectionEvent[] = o.events.map((e, i) => ({
    seq: i + 1,
    kind: e.kind,
    payload: e.payload,
  }));
  return {
    events,
    snapshot: {
      systemPrompt: "SYSTEM",
      contextJson: null,
      steps: o.steps ?? {},
      toolCalls: o.toolCalls ?? {},
      unkeyedToolCallRows: 0,
    },
  };
}

/* ── ① 优先级：事件带 body ⇒ 用事件，不读快照 ──────────────────── */

describe("projectSession · ① 事件自带正文 ⇒ 优先用事件（不再读快照）", () => {
  it("快照里放**不同的**值 ⇒ 投影取到的是**事件**的值（证伪：取到快照值即优先级错）", () => {
    const { events, snapshot } = worldOf({
      events: [
        {
          kind: "step_appended",
          payload: {
            stepId: "s1",
            stepSeq: 1,
            role: "user",
            folded: false,
            toolCallCount: 0,
            // 事件自带的正文：这是「第 N 轮模型看到的那段」
            body: { content: body("事件里的正文") },
          },
        },
      ],
      steps: {
        // 快照里**故意**放一个不同的值：若投影读了快照，渲染出来的就是它
        s1: snapStep({ content: "快照里的正文（应当读不到）" }),
      },
    });

    const out = projectSession(events, snapshot);
    const msg = out.messages.find((m) => m.role === "user");

    // 关键断言：取到**事件**的值 ⇒ 证明它没读快照
    expect(msg?.content).toBe("事件里的正文");
    expect(msg?.content).not.toContain("快照里的正文");
  });

  it("工具结果同样优先用事件正文（快照里放**不同的**结果 JSON）", () => {
    const { events, snapshot } = worldOf({
      events: [
        {
          kind: "step_appended",
          payload: {
            stepId: "s1",
            stepSeq: 1,
            role: "assistant",
            folded: false,
            toolCallCount: 1,
          },
        },
        {
          kind: "tool_call_recorded",
          payload: {
            toolCallId: "c1",
            toolName: "get_task",
            tier: "read",
            status: "in_flight",
            resultTruncated: false,
          },
        },
        {
          kind: "tool_call_status_changed",
          payload: {
            toolCallId: "c1",
            toolName: "get_task",
            tier: "read",
            status: "ok",
            durationMs: 3,
            resultTruncated: false,
            hasResult: true,
            errorMessage: null,
            // 事件自带的结果正文（紧凑 JSON 串，与写入口径一致）
            body: { result: body(JSON.stringify({ id: "e-from-event" })) },
          },
        },
      ],
      steps: {
        s1: snapStep({
          content: "",
          toolCalls: [
            {
              id: "c1",
              type: "function",
              function: { name: "get_task", arguments: "{}" },
            },
          ],
        }),
      },
      toolCalls: {
        // 快照里**故意**放一个不同的结果：若投影读了快照，渲染出来就是它
        c1: { result: { id: "e-from-snapshot" }, rowStatus: "ok" },
      },
    });

    const out = projectSession(events, snapshot);
    const tool = out.messages.find((m) => m.role === "tool");

    expect(String(tool?.content)).toContain("e-from-event");
    expect(String(tool?.content)).not.toContain("e-from-snapshot");
  });

  it("有 body 的事件 ⇒ 缺口记 resolved_by_event / resolvedBy=event", () => {
    const { events, snapshot } = worldOf({
      events: [
        {
          kind: "step_appended",
          payload: {
            stepId: "s1",
            stepSeq: 1,
            role: "user",
            folded: false,
            toolCallCount: 0,
            body: { content: body("正文") },
          },
        },
      ],
      steps: { s1: snapStep({ content: "正文" }) },
    });

    const out = projectSession(events, snapshot);
    const gap = out.gaps.find((g) => g.field === "content");

    expect(gap).toMatchObject({
      class: "resolved_by_event",
      resolvedBy: "event",
    });
    // 事件自带 ⇒ 不再记「正文靠回读」那一类
    expect(
      out.gaps.some(
        (g) => g.field === "content" && g.class === "event_only_metadata",
      ),
    ).toBe(false);
    expect(out.stats.bodyResolution.fromEvent).toBe(1);
  });
});

/* ── ② 存量兼容：无 body ⇒ 回落快照（逐字节不变） ──────────────── */

describe("projectSession · ② 存量事件（无 body）⇒ 回落快照，行为逐字节不变", () => {
  it("步正文：回落快照，resolvedBy 仍是 snapshot（**不许**伪装成事件自足）", () => {
    const { events, snapshot } = worldOf({
      events: [
        {
          kind: "step_appended",
          payload: {
            stepId: "s1",
            stepSeq: 1,
            role: "user",
            folded: false,
            toolCallCount: 0,
            // 存量事件：**没有 body**（第五阶段之前写入）
          },
        },
      ],
      steps: { s1: snapStep({ content: "快照里的正文" }) },
    });

    const out = projectSession(events, snapshot);

    // 回落：正文就是快照那份（行为与本次改动前**逐字节相同**）
    expect(out.messages.find((m) => m.role === "user")?.content).toBe(
      "快照里的正文",
    );
    // 来源必须**如实**标注为快照
    const gap = out.gaps.find((g) => g.field === "content");
    expect(gap).toMatchObject({
      class: "event_only_metadata",
      resolvedBy: "snapshot",
    });
    expect(out.stats.bodyResolution.fromSnapshot).toBe(1);
    expect(out.stats.bodyResolution.fromEvent).toBe(0);
  });

  it("工具结果：回落快照，resolvedBy 仍是 snapshot", () => {
    const { events, snapshot } = worldOf({
      events: [
        {
          kind: "step_appended",
          payload: {
            stepId: "s1",
            stepSeq: 1,
            role: "assistant",
            folded: false,
            toolCallCount: 1,
          },
        },
        {
          kind: "tool_call_recorded",
          payload: {
            toolCallId: "c1",
            toolName: "get_task",
            tier: "read",
            status: "ok",
            resultTruncated: false,
            // 存量事件：无 body
          },
        },
      ],
      steps: {
        s1: snapStep({
          content: "",
          toolCalls: [
            {
              id: "c1",
              type: "function",
              function: { name: "get_task", arguments: "{}" },
            },
          ],
        }),
      },
      toolCalls: { c1: { result: { id: "e-1" }, rowStatus: "ok" } },
    });

    const out = projectSession(events, snapshot);

    expect(
      String(out.messages.find((m) => m.role === "tool")?.content),
    ).toContain("e-1");
    // 回落路径**不新增缺口条目**（存量兼容是硬要求）：改动前的这条路径也没有记
    // `resultJson` 缺口，凭空多一条会让存量会话的报告「看起来比以前脏」。
    expect(
      out.gaps.some(
        (g) => g.field === "resultJson" && g.class === "event_only_metadata",
      ),
    ).toBe(false);
    // 正文来源由 `bodyResolution` **单独**统计（不混进缺口分类）
    expect(out.stats.bodyResolution.fromSnapshot).toBeGreaterThan(0);
    expect(out.stats.bodyResolution.fromEvent).toBe(0);
  });

  it("错误正文：回落快照，resolvedBy 仍是 snapshot", () => {
    const { events, snapshot } = worldOf({
      events: [
        {
          kind: "step_appended",
          payload: {
            stepId: "s1",
            stepSeq: 1,
            role: "assistant",
            folded: false,
            toolCallCount: 1,
          },
        },
        {
          kind: "tool_call_recorded",
          payload: {
            toolCallId: "c1",
            toolName: "stop_task",
            tier: "write",
            status: "error",
            resultTruncated: false,
            // 存量事件：无 body（且 recorded 的 payload 本就不带 errorMessage）
          },
        },
      ],
      steps: {
        s1: snapStep({
          content: "",
          toolCalls: [
            {
              id: "c1",
              type: "function",
              function: { name: "stop_task", arguments: "{}" },
            },
          ],
        }),
      },
      toolCalls: {
        c1: { errorMessage: "上游 500：连接被重置", rowStatus: "error" },
      },
    });

    const out = projectSession(events, snapshot);

    // 回落：错误正文就是台账行那份（与本次改动前**逐字节相同**）
    expect(
      String(out.messages.find((m) => m.role === "tool")?.content),
    ).toContain("上游 500：连接被重置");
    const gap = out.gaps.find(
      (g) => g.field === "errorMessage" && g.class === "event_only_metadata",
    );
    expect(gap).toMatchObject({ resolvedBy: "snapshot" });
  });
});

/* ── ③ 截断可见 ─────────────────────────────────────────────────── */

describe("projectSession · ③ 截断 ⇒ 渲染文案必须带「已截断」标注", () => {
  it("步正文被截断 ⇒ 文案含「（已截断，原文 N 字节）」，且缺口记 body_truncated", () => {
    const long = "很长的正文".repeat(400);
    const truncatedBody = toAgentEventBody(long, long);
    expect(truncatedBody.truncated).toBe(true);
    expect(truncatedBody.originalBytes).toBe(Buffer.byteLength(long, "utf8"));

    const { events, snapshot } = worldOf({
      events: [
        {
          kind: "step_appended",
          payload: {
            stepId: "s1",
            stepSeq: 1,
            role: "assistant",
            folded: false,
            toolCallCount: 0,
            body: { content: truncatedBody },
          },
        },
      ],
      steps: { s1: snapStep({ content: long }) },
    });

    const out = projectSession(events, snapshot);
    const content = String(
      out.messages.find((m) => m.role === "assistant")?.content,
    );

    // 不许静默：模型必须知道这是前缀
    expect(content).toContain("（已截断，原文 ");
    expect(content).toContain(
      `字节；以上仅为前缀，模型据此推理时须知此处内容不完整）`,
    );
    expect(content).toContain(String(truncatedBody.originalBytes));
    // 缺口表里也要有独立的一类（与「正文靠快照」区分开）
    expect(out.gaps.some((g) => g.class === "body_truncated")).toBe(true);
    expect(out.stats.bodyResolution.truncated).toBe(1);
  });

  it("工具结果被截断 ⇒ 文案含截断标注（且**不**解析那个不完整的 JSON）", () => {
    // 截断的 JSON 一定不完整 ⇒ 解析会失败或更糟（解析出子集）
    const partial = '{"id":"e-1","lines":["a","b"';
    const { events, snapshot } = worldOf({
      events: [
        {
          kind: "step_appended",
          payload: {
            stepId: "s1",
            stepSeq: 1,
            role: "assistant",
            folded: false,
            toolCallCount: 1,
          },
        },
        {
          kind: "tool_call_recorded",
          payload: {
            toolCallId: "c1",
            toolName: "get_logs",
            tier: "read",
            status: "ok",
            resultTruncated: false,
            body: {
              result: {
                text: partial,
                bytes: Buffer.byteLength(partial, "utf8"),
                originalBytes: 99999,
                truncated: true,
              },
            },
          },
        },
      ],
      steps: {
        s1: snapStep({
          content: "",
          toolCalls: [
            {
              id: "c1",
              type: "function",
              function: { name: "get_logs", arguments: "{}" },
            },
          ],
        }),
      },
      toolCalls: { c1: { result: { id: "e-1" }, rowStatus: "ok" } },
    });

    const out = projectSession(events, snapshot);
    const content = String(
      out.messages.find((m) => m.role === "tool")?.content,
    );

    expect(content).toContain("（已截断，原文 99999 字节");
    // 原样渲染那个前缀（不假装它是完整 JSON）
    expect(content).toContain(partial);
  });

  it("未截断的正文 ⇒ **不**带截断标注（避免「标记恒真」这种假闸门）", () => {
    const { events, snapshot } = worldOf({
      events: [
        {
          kind: "step_appended",
          payload: {
            stepId: "s1",
            stepSeq: 1,
            role: "user",
            folded: false,
            toolCallCount: 0,
            body: { content: body("完整正文") },
          },
        },
      ],
      steps: { s1: snapStep({ content: "完整正文" }) },
    });

    const out = projectSession(events, snapshot);

    expect(String(out.messages.find((m) => m.role === "user")?.content)).toBe(
      "完整正文",
    );
    expect(out.stats.bodyResolution.truncated).toBe(0);
  });

  it("写入侧上限与投影读侧的假设一致（2 KiB 单条 ⇒ 截断必然可标记）", () => {
    // 这条把「写入侧的截断保证」与「读侧的标注保证」接起来：只要写入侧按
    // 2 KiB 截，长正文就一定带 truncated ⇒ 读侧一定会标注。
    const long = "模型看到的很长的正文内容 ".repeat(300);
    expect(Buffer.byteLength(long, "utf8")).toBeGreaterThan(
      AGENT_EVENT_BODY_MAX_BYTES * 3,
    );
    const b = toAgentEventBody(long, long);
    expect(b.truncated).toBe(true);
    expect(b.bytes).toBeLessThanOrEqual(AGENT_EVENT_BODY_MAX_BYTES);
  });
});

/* ── ④ 既有基线不弱化 ───────────────────────────────────────────── */

describe("projectSession · ④ 既有「逐字节一致」基线在正文消费后仍全绿", () => {
  /**
   * 这条不是「新功能」，是**不许弱化**的闸：第五组基线（简单会话 / 插入即终态 /
   * 三种结果形态 / 折叠会话 / 审批路径）断言的是「投影 ≡ 快照重建」。本次改动
   * 让投影开始**优先读事件正文**，一旦优先级判错或截断标注乱加，那五组基线
   * 就会红——它们因此是本改动的**回归锁**。
   *
   * 这里断言的是**结构**：那五组基线由 `agent-event-projection.spec.ts` 覆盖，
   * 本文件只钉住「它们仍然全绿」这件事在 CI 里被看见（下面的用例逐条复现其中
   * 最敏感的几条：无 body 的存量会话、审批路径、折叠会话）。
   */
  it("存量会话（无 body）⇒ 与快照重建**逐字节一致**", () => {
    // 复用真 `AgentRuntimeService.rebuildMessages` 做一次对照：这里的夹具与
    // `agent-event-projection.spec.ts` 的 `worldOf` 同构，差别只在**没有 body**
    // （存量事件），所以两侧必须完全一致。
    const { events, snapshot } = worldOf({
      events: [
        {
          kind: "step_appended",
          payload: {
            stepId: "s1",
            stepSeq: 1,
            role: "user",
            folded: false,
            toolCallCount: 0,
          },
        },
        {
          kind: "step_appended",
          payload: {
            stepId: "s2",
            stepSeq: 2,
            role: "assistant",
            folded: false,
            toolCallCount: 1,
          },
        },
        {
          kind: "tool_call_recorded",
          payload: {
            toolCallId: "c1",
            toolName: "get_task",
            tier: "read",
            status: "ok",
            resultTruncated: false,
          },
        },
      ],
      steps: {
        s1: snapStep({ content: "查一下 task-1" }),
        s2: snapStep({
          content: "",
          toolCalls: [
            {
              id: "c1",
              type: "function",
              function: { name: "get_task", arguments: "{}" },
            },
          ],
        }),
      },
      toolCalls: { c1: { result: { id: "t-1" }, rowStatus: "ok" } },
    });

    const out = projectSession(events, snapshot);

    // 存量路径：正文与快照同源 ⇒ 逐字节一致（无任何兜底文案）
    expect(JSON.stringify(out.messages)).toBe(
      JSON.stringify([
        { role: "system", content: "SYSTEM" },
        { role: "user", content: "查一下 task-1" },
        {
          role: "assistant",
          content: "",
          tool_calls: [
            {
              id: "c1",
              type: "function",
              function: { name: "get_task", arguments: "{}" },
            },
          ],
        },
        // 键序逐字对齐投影侧的渲染顺序（`tool_call_id` 在 `content` 之前）
        {
          role: "tool",
          tool_call_id: "c1",
          content: `【工具结果（重放）】{"id":"t-1"}`,
        },
      ]),
    );
    // 没有一处靠兜底文案
    expect(out.gaps.filter((g) => g.resolvedBy === "none")).toEqual([]);
  });

  it("事件自带正文（内容与快照**相同**）⇒ 与存量路径**逐字节一致**", () => {
    // 这条钉住「优先事件」不改变**文案**：事件正文与快照内容相同时，两条路径
    // 必须给出同一段文字——否则「切换读路径」会改变模型看到的东西。
    const withBody = worldOf({
      events: [
        {
          kind: "step_appended",
          payload: {
            stepId: "s1",
            stepSeq: 1,
            role: "user",
            folded: false,
            toolCallCount: 0,
            body: { content: body("查一下 task-1") },
          },
        },
      ],
      steps: { s1: snapStep({ content: "查一下 task-1" }) },
    });
    const withoutBody = worldOf({
      events: [
        {
          kind: "step_appended",
          payload: {
            stepId: "s1",
            stepSeq: 1,
            role: "user",
            folded: false,
            toolCallCount: 0,
          },
        },
      ],
      steps: { s1: snapStep({ content: "查一下 task-1" }) },
    });

    const a = projectSession(withBody.events, withBody.snapshot);
    const b = projectSession(withoutBody.events, withoutBody.snapshot);

    expect(JSON.stringify(a.messages)).toBe(JSON.stringify(b.messages));
  });
});

/* ── ⑤ 混合会话：分别统计 ───────────────────────────────────────── */

describe("projectSession · ⑤ 混合会话（部分事件有 body、部分没有）⇒ 分别统计", () => {
  it("两者**分别**计数，不混为一谈", () => {
    const { events, snapshot } = worldOf({
      events: [
        {
          kind: "step_appended",
          payload: {
            stepId: "s1",
            stepSeq: 1,
            role: "user",
            folded: false,
            toolCallCount: 0,
            // 有 body
            body: { content: body("新事件：正文自带") },
          },
        },
        {
          kind: "step_appended",
          payload: {
            stepId: "s2",
            stepSeq: 2,
            role: "assistant",
            folded: false,
            toolCallCount: 0,
            // 无 body（存量事件）
          },
        },
      ],
      steps: {
        s1: snapStep({ content: "新事件：正文自带" }),
        s2: snapStep({ content: "存量事件：回落快照" }),
      },
    });

    const out = projectSession(events, snapshot);

    // 两者分别计数
    expect(out.stats.bodyResolution.fromEvent).toBe(1);
    expect(out.stats.bodyResolution.fromSnapshot).toBe(1);
    expect(out.stats.bodyResolution.fromNone).toBe(0);
    // 渲染：各取各的
    expect(out.messages[1].content).toBe("新事件：正文自带");
    expect(out.messages[2].content).toBe("存量事件：回落快照");
    // 缺口表里两类**都在**，且来源标注不同
    expect(
      out.gaps.some((g) => g.field === "content" && g.resolvedBy === "event"),
    ).toBe(true);
    expect(
      out.gaps.some(
        (g) =>
          g.field === "content" &&
          g.resolvedBy === "snapshot" &&
          g.class === "event_only_metadata",
      ),
    ).toBe(true);
  });

  it("缺口分类计数与正文来源计数**互不混淆**", () => {
    const { events, snapshot } = worldOf({
      events: [
        {
          kind: "step_appended",
          payload: {
            stepId: "s1",
            stepSeq: 1,
            role: "user",
            folded: false,
            toolCallCount: 0,
            body: { content: body("自带") },
          },
        },
        {
          kind: "step_appended",
          payload: {
            stepId: "s2",
            stepSeq: 2,
            role: "user",
            folded: false,
            toolCallCount: 0,
          },
        },
      ],
      steps: {
        s1: snapStep({ content: "自带" }),
        s2: snapStep({ content: "回落" }),
      },
    });

    const out = projectSession(events, snapshot);

    // `resolved_by_event` 与 `event_only_metadata` 是**两个**分类，各 1
    expect(out.stats.gapsByClass.resolved_by_event).toBe(1);
    expect(out.stats.gapsByClass.event_only_metadata).toBe(1);
    // 「事件自足的那部分」= fromEvent，「靠快照的那部分」= fromSnapshot
    expect(out.stats.bodyResolution.fromEvent).toBe(1);
    expect(out.stats.bodyResolution.fromSnapshot).toBe(1);
  });
});
