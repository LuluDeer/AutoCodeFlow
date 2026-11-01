/**
 * S7-G1（第三阶段）：`projectSession` 的**双跑对账** —— 同一份会话数据，一侧用
 * `rebuildMessages`（读路径，**本阶段不动**），一侧用事件投影，逐字节比对。
 *
 * ## 为什么这份 spec 是「证明」而不是「测试」
 *
 * 迁移 0089 只写不读的理由是「避免两套语义并存漂移，投影留到能用双跑对账证明
 * 等价再切换」。于是这里的断言不是「功能对不对」，而是三条可被推翻的命题：
 *   ① 投影是**纯函数**（同输入同输出、不改入参、源码里没有 DB/时钟/随机/异步）；
 *   ② 简单会话（1 步 + 1 工具调用）两侧**逐字节一致**，且没有任何一处靠兜底文案
 *      （`resolvedBy === "none"` 的缺口数 = 0）；
 *   ③ 不一致的地方必须**被分类记录**——本 spec 对折叠会话、事件流有洞、
 *      `approval_decided` 旁路丢失、deny 的台账 settle、存量无身份行这几种情形，
 *      断言的是「差异点 + 分类」而不是「一致」。
 *
 * S7-G1 第四阶段起，**审批路径**（granted / consumed）从③挪到了②：`decide` /
 * `consume` 的条件 UPDATE 命中后落一条 `approval_decided`，投影因此第一次能从
 * 事件流重建那三句文案；⑤那组用例把「一致」与「旁路丢失后仍不一致」成对钉住。
 *
 * ## 快照侧为什么要用**真的** `AgentRuntimeService`
 *
 * 如果这一侧也照抄一份 `rebuildMessages` 的文字模板，对账就退化成「我的复刻
 * 和我的复刻一致」——它能证明的只有我抄得对不对。因此快照侧走真实类
 * （`(service as any).rebuildMessages(...)` + 桩 sessionService/approvals），
 * 投影侧只吃「事件流 + 快照行」。这样 `replayedToolResult` 里改一个标点、
 * `stepToMessages` 改一处折叠口径，这份对账都会红。
 *
 * 唯一在这里**复制**的是 `SYSTEM_PROMPT`（runtime 里是模块私有常量，本阶段
 * 不许改那个文件）：它是代码常量而不是数据，投影按纪律不复制、由调用方注入。
 * 复制错一个字 ⇒ 逐字节断言必红 ⇒ 这份 spec 本身就是那条防漂移的闸。
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AgentRuntimeService } from "../agent-runtime.service";
import {
  diffMessages,
  projectSession,
  type ProjectedSession,
  type ProjectionEvent,
  type ProjectionSnapshot,
} from "../agent-event-projection";
import type { MultimodalMessage } from "../../../ai/ai.service";

type Any = Record<string, any>;

/**
 * `agent-runtime.service.ts` 里的 `SYSTEM_PROMPT`（逐字复制）。
 *
 * 见文件头注：复制是刻意的，且由逐字节对账当闸。
 */
const SYSTEM_PROMPT = [
  "你是 AutoCodeFlow 平台的中台运维 Agent。",
  "你的职责是排查环境异常、分析执行失败、协助维护自动化应用。",
  "",
  "工作纪律：",
  "1. 先观察再行动：优先用只读工具了解现状，不要凭猜测下结论。",
  "2. 每次只做必要的事：不要为了「保险」而重复调用同一个工具。",
  "3. 有结论就给结论：如果证据已足够，直接输出结论，不要继续调用工具。",
  "4. 说清不确定性：证据不足时明确说明「需要什么信息才能判断」，不要编造。",
  "5. 工具被拒是正常反馈：被拒绝时换一条路径，不要反复重试同一个调用。",
  "",
  "输出要求：结束时用简洁的中文给出结论与建议的操作。",
].join("\n");

/* ── 夹具：一份「世界」= 快照表里的行 + 按第一阶段写入点会产出的事件 ── */

/** `agent_steps` 行。 */
const step = (over: Any): Any => ({
  id: "s1",
  sessionId: "sess-1",
  seq: 1,
  role: "user",
  content: "hi",
  summary: null,
  toolCallId: null,
  toolCallsJson: null,
  ...over,
});

/** `agent_tool_calls` 行（`initialStatus` 用来描述「先 in_flight、后 ok」的迁移）。 */
interface ToolCallRow {
  toolCallId: string | null;
  toolName: string;
  status: string;
  initialStatus?: string;
  tier?: string;
  result?: Any | null;
  resultTruncated?: boolean;
  errorMessage?: string | null;
  approvalId?: string | null;
  stepId?: string | null;
}

interface World {
  session: Any;
  steps: Any[];
  toolCalls: Any[];
  approvals: Any[];
  events: ProjectionEvent[];
}

/**
 * 造世界：行 + **按第一阶段真实写入点**会产出的事件序列。
 *
 * payload 的形状逐条对齐 `AgentSessionService.appendStep` / `recordToolCall` /
 * `updateToolCallByToolCallId`（少一个字段就等于自己给投影放水）。
 *
 * `decisions` 是 S7-G1 第四阶段的新写入点：`AgentApprovalsService.decide` /
 * `consume` 的条件 UPDATE 命中后各落一条 `approval_decided`（payload 走
 * `buildApprovalDecidedPayload`，这里逐字照抄那四个字段）。
 *
 * `settles` 是第五阶段的写入点：deny 之后 `AgentController.decideApproval` 在
 * `settleToolCallByApprovalId` **命中（affected > 0）之后**落一条
 * `tool_call_status_changed`（payload 逐字对齐 `emitToolCallSettledEvents`）。
 * 它的时序在 `approval_decided` **之后**（controller 先 decide 再 settle），
 * 因此不能塞进上面的按步循环里。
 */
function worldOf(o: {
  steps: Any[];
  toolCalls?: ToolCallRow[];
  approvals?: Any[];
  context?: unknown;
  decisions?: Array<{
    approvalKey: string;
    status: string;
    decidedBy?: string | null;
    decidedAt?: string;
  }>;
  settles?: Array<{
    toolCallId: string;
    toolName: string;
    tier?: string;
    status: string;
    errorMessage?: string | null;
    resultTruncated?: boolean;
    hasResult?: boolean;
    durationMs?: number;
  }>;
}): World {
  // 有 `settles` 的行，状态迁移由那个写入点按**真实时序**落；这里不能再顺手
  // 自动补一条（否则「一次迁移」会有两条事件，比真实序列多一条——放水的方向
  // 恰好是让对账更容易绿）。
  const settledIds = new Set((o.settles ?? []).map((s) => s.toolCallId));
  const session = { id: "sess-1", contextJson: o.context ?? null };
  const toolCalls: Any[] = (o.toolCalls ?? []).map((r, i) => ({
    id: `tc-${i}`,
    sessionId: "sess-1",
    stepId: r.stepId ?? null,
    toolCallId: r.toolCallId,
    toolName: r.toolName,
    tier: r.tier ?? "read",
    status: r.status,
    resultJson: r.result ?? null,
    resultTruncated: r.resultTruncated ?? false,
    errorMessage: r.errorMessage ?? null,
    approvalId: r.approvalId ?? null,
  }));

  const events: ProjectionEvent[] = [];
  let seq = 0;
  const push = (kind: string, payload: Any) => {
    events.push({ seq: ++seq, kind, payload });
  };
  for (const st of o.steps) {
    // step_appended：appendStep 在**事务提交之后**写（payload 只记引用与元数据）
    push("step_appended", {
      stepId: st.id,
      stepSeq: st.seq,
      role: st.role,
      tokensIn: 10,
      tokensOut: 5,
      latencyMs: 7,
      provider: "qwen",
      model: "qwen-vl-max",
      folded: (st.summary ?? null) !== null,
      toolCallCount: Array.isArray(st.toolCallsJson)
        ? st.toolCallsJson.length
        : 0,
    });
    for (const row of toolCalls.filter((r) => r.stepId === st.id)) {
      const initial = (o.toolCalls ?? [])[toolCalls.indexOf(row)].initialStatus;
      push("tool_call_recorded", {
        toolCallId: row.toolCallId,
        toolName: row.toolName,
        tier: row.tier,
        status: initial ?? row.status,
        approvalId: row.approvalId,
        hasArgs: true,
        resultTruncated: row.resultTruncated,
      });
      const settledHere =
        row.toolCallId !== null && settledIds.has(row.toolCallId);
      if ((initial ?? row.status) !== row.status && !settledHere) {
        push("tool_call_status_changed", {
          toolCallId: row.toolCallId,
          toolName: row.toolName,
          tier: row.tier,
          status: row.status,
          durationMs: 12,
          resultTruncated: row.resultTruncated,
          hasResult: (row.resultJson ?? null) !== null,
          errorMessage: row.errorMessage ? "present" : null,
        });
      }
    }
  }
  // S7-G1 第四阶段写入点：审批决定的落点（grant / deny / consume 命中之后）。
  // 顺序即**真实时序**：决定发生在「这次调用被记录成 awaiting_approval」之后。
  for (const d of o.decisions ?? []) {
    push("approval_decided", {
      approvalKey: d.approvalKey,
      status: d.status,
      decidedBy: d.decidedBy ?? null,
      decidedAt: d.decidedAt ?? "2026-11-02T02:00:00.000Z",
    });
  }
  // S7-G1 第五阶段写入点：deny 的台账 settle（条件 UPDATE 命中之后）。
  // 时序在 `approval_decided` 之后，payload 逐字对齐
  // `AgentController.emitToolCallSettledEvents`（身份 + 状态 + 错误正文**存在性**）。
  for (const s of o.settles ?? []) {
    push("tool_call_status_changed", {
      toolCallId: s.toolCallId,
      toolName: s.toolName,
      tier: s.tier ?? "write",
      status: s.status,
      durationMs: s.durationMs ?? 0,
      resultTruncated: s.resultTruncated === true,
      hasResult: s.hasResult === true,
      errorMessage: s.errorMessage ? "present" : null,
    });
  }
  // 与 messages 无关的两种事件：必须在 byKind 里出现（证明「写了但没人读」是可见的）
  push("prompt_fingerprint", {
    stepId: o.steps[0]?.id ?? null,
    algo: "sha256",
    messageCount: 3,
  });
  push("session_finished", { status: "succeeded", totalSteps: o.steps.length });

  return {
    session,
    steps: o.steps,
    toolCalls,
    approvals: o.approvals ?? [],
    events,
  };
}

/** 投影唯一允许的第二个输入：被引用的快照行（**不含审批状态**，见模块头注）。 */
function resolveOf(
  world: World,
  over: Partial<ProjectionSnapshot> = {},
): ProjectionSnapshot {
  const steps: Record<string, Any> = {};
  for (const st of world.steps) {
    steps[st.id] = {
      content: st.content,
      toolCallId: st.toolCallId,
      toolCalls: st.toolCallsJson,
      summary: st.summary,
    };
  }
  const toolCalls: Record<string, Any> = {};
  for (const r of world.toolCalls) {
    if (!r.toolCallId) continue;
    toolCalls[r.toolCallId] = {
      result: r.resultJson,
      errorMessage: r.errorMessage,
      resultTruncated: r.resultTruncated,
      rowStatus: r.status,
    };
  }
  return {
    systemPrompt: SYSTEM_PROMPT,
    contextJson: world.session.contextJson,
    steps,
    toolCalls,
    unkeyedToolCallRows: world.toolCalls.filter((r) => !r.toolCallId).length,
    ...over,
  };
}

/** 双跑：左侧 = 真的 `rebuildMessages`（读路径），右侧 = 事件投影。 */
async function dualRun(
  world: World,
  over: Partial<ProjectionSnapshot> = {},
): Promise<{ snapshot: MultimodalMessage[]; projected: ProjectedSession }> {
  const service = new AgentRuntimeService(
    {
      requireById: async () => world.session,
      listSteps: async () => world.steps,
      listToolCalls: async () => world.toolCalls,
    } as never,
    {} as never,
    {} as never,
  );
  service.setApprovals({
    listForSession: async () => world.approvals,
  } as never);
  const snapshot = await (
    service as unknown as {
      rebuildMessages(id: string): Promise<MultimodalMessage[]>;
    }
  ).rebuildMessages(world.session.id);
  return {
    snapshot,
    projected: projectSession(world.events, resolveOf(world, over)),
  };
}

/** 逐字节（`JSON.stringify` 全串）相等的断言文案：失败时直接给两份原文。 */
const json = (v: unknown) => JSON.stringify(v);

/** 所有「两侧都没有」的缺口（`resolvedBy: "none"`）= 靠兜底文案撑场面处。 */
const unresolved = (p: ProjectedSession) =>
  p.gaps.filter((g) => g.resolvedBy === "none");

/* ── ① 纯函数 ───────────────────────────────────────────────────── */

describe("projectSession · ① 纯函数（同输入同输出 / 不改入参 / 不读 DB·时钟·随机）", () => {
  const world = worldOf({
    steps: [
      step({ id: "s1", seq: 1, role: "user", content: "查一下 task-1" }),
      step({
        id: "s2",
        seq: 2,
        role: "assistant",
        content: "",
        toolCallsJson: [
          {
            id: "c1",
            type: "function",
            function: { name: "get_task", arguments: "{}" },
          },
        ],
      }),
      step({ id: "s3", seq: 3, role: "assistant", content: "结论：正常" }),
    ],
    toolCalls: [
      {
        toolCallId: "c1",
        stepId: "s2",
        toolName: "get_task",
        status: "ok",
        initialStatus: "in_flight",
        result: { id: "t-1" },
      },
    ],
  });

  it("同输入两次 ⇒ 同输出；返回值不是入参的引用；入参**逐字节不变**", () => {
    const eventsBefore = json(world.events);
    const resolve = resolveOf(world);
    const resolveBefore = json(resolve);

    const a = projectSession(world.events, resolve);
    const b = projectSession(world.events, resolve);

    expect(json(a)).toBe(json(b));
    expect(a.messages).not.toBe(b.messages);
    expect(a.messages).not.toBe(world.events);

    // 调用方改写返回值不得反向污染入参（纯函数纪律③：入参被改 ⇒ 两次对账不可比）
    a.messages.push({ role: "user", content: "注入" });
    a.gaps.push({
      class: "seq_gap",
      seq: 99,
      field: "seq",
      resolvedBy: "none",
      detail: "注入",
    });
    expect(json(world.events)).toBe(eventsBefore);
    expect(json(resolve)).toBe(resolveBefore);
  });

  it("源码层（剥注释后）：没有 DB / 时钟 / 随机 / 异步 / 环境变量", () => {
    // 为什么用**顶层 import** 而不是 `require()`：本仓 `npm run lint` 带 `--fix`，
    // 它会重排格式 ⇒ **行号漂移** ⇒ `eslint-disable-next-line` 不再紧贴 `require(`
    // ⇒ 抑制静默失效（2026-11-01 CI 实测踩到，报 `no-require-imports` 而本地看不到）。
    // 顶层 import 不需要任何抑制，也就不存在漂移。
    const raw = readFileSync(
      join(__dirname, "..", "agent-event-projection.ts"),
      "utf8",
    );
    // **先剥注释再扫**：本模块的注释必须能写出那些被禁止的符号名（否则没法解释
    // 纪律本身）。剥注释后剩下的才是「实现」——那才是这条判据的对象。
    const code = raw
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|\s)\/\/[^\n]*/g, "$1");

    for (const forbidden of [
      "Repository",
      "manager.",
      "Date.now",
      "new Date",
      "Math.random",
      "process.env",
      "async ",
      "await ",
      "typeorm",
    ]) {
      expect(code).not.toContain(forbidden);
    }
    // 正向断言：纯函数必须真的存在且导出（避免「删掉实现，守卫照样绿」）
    expect(code).toContain("export function projectSession");
  });
});

/* ── ② 简单会话：逐字节一致 ─────────────────────────────────────── */

describe("projectSession · ② 简单会话（1 步 + 1 工具调用）两侧逐字节一致", () => {
  const world = worldOf({
    steps: [
      step({
        id: "s1",
        seq: 1,
        role: "user",
        content: "查一下 task-1 的最近一次执行",
      }),
      step({
        id: "s2",
        seq: 2,
        role: "assistant",
        content: "",
        toolCallsJson: [
          {
            id: "c1",
            type: "function",
            function: { name: "get_execution", arguments: '{"taskId":"t-1"}' },
          },
        ],
      }),
      step({
        id: "s3",
        seq: 3,
        role: "assistant",
        content: "结论：最近一次执行成功。",
      }),
    ],
    toolCalls: [
      {
        toolCallId: "c1",
        stepId: "s2",
        toolName: "get_execution",
        status: "ok",
        initialStatus: "in_flight",
        result: { id: "e-1", status: "SUCCESS" },
      },
    ],
  });

  it("messages 逐字节相同（system / user / assistant / tool / assistant）", async () => {
    const { snapshot, projected } = await dualRun(world);

    expect(json(projected.messages)).toBe(json(snapshot));
    expect(diffMessages(snapshot, projected.messages)).toEqual([]);
    expect(projected.messages.map((m) => m.role)).toEqual([
      "system",
      "user",
      "assistant",
      "tool",
      "assistant",
    ]);
    // 工具应答的正文必须是「重放」口径且带真实结果
    expect(String(projected.messages[3].content)).toContain(
      "【工具结果（重放）】",
    );
    expect(String(projected.messages[3].content)).toContain("SUCCESS");
    expect(projected.messages[3].tool_call_id).toBe("c1");
  });

  it("没有任何一处靠兜底文案（resolvedBy=none 的缺口数 = 0），seq 连续", async () => {
    const { projected } = await dualRun(world);

    // 这条是「够用」的判据：不一致可以是缺口造成的，但**一致**如果是靠
    // `【投影缺口】…` 恰好与快照文案相同凑出来的，那是自欺。故显式要求 0。
    expect(unresolved(projected)).toEqual([]);
    expect(projected.integrity.contiguous).toBe(true);
    expect(projected.integrity.missing).toEqual([]);
    expect(projected.stats.stepCount).toBe(3);
    expect(projected.stats.toolCallCount).toBe(1);
  });

  it("写入面「只记元数据」的事实都在缺口里留痕（可审计，而不是静默）", async () => {
    const { projected } = await dualRun(world);

    // 这三条是**第一阶段的设计**（事件不记正文），不是 bug：留痕后切换读路径时
    // 能一眼看出「哪几个字段必须回读既有表」。
    const fields = projected.gaps.map((g) => g.field);
    expect(fields).toContain("content");
    expect(fields).toContain("toolCallsJson");
    expect(projected.gaps.every((g) => g.resolvedBy !== "none")).toBe(true);
    // prompt_fingerprint / session_finished 不产出消息，但必须在计数里可见
    expect(projected.stats.byKind.prompt_fingerprint).toBe(1);
    expect(projected.stats.byKind.session_finished).toBe(1);
  });
});

describe("projectSession · ②b 「插入即终态」的行（denied + skipped: approval）也逐字节一致", () => {
  // 这条路径在真实数据里最常见：一批调用里第 2 个要审批，同批后续调用**不执行**、
  // 直接落成 `denied + skipped: <reason>`——`recordToolCall` 插入即终态，
  // 因此事件流里只有一条 `tool_call_recorded`（**payload 不带 errorMessage**），
  // 不会有第二条 `tool_call_status_changed`。投影要靠回读台账行才说得出
  // 「因同批前一个调用进入人工审批而跳过」，而不是「调用未成功」。
  const world = worldOf({
    steps: [
      step({ id: "s1", seq: 1, role: "user", content: "停掉 task-1" }),
      step({
        id: "s2",
        seq: 2,
        role: "assistant",
        content: "",
        toolCallsJson: [
          {
            id: "c1",
            type: "function",
            function: { name: "get_task", arguments: "{}" },
          },
          {
            id: "c2",
            type: "function",
            function: { name: "stop_task", arguments: "{}" },
          },
        ],
      }),
    ],
    toolCalls: [
      {
        toolCallId: "c1",
        stepId: "s2",
        toolName: "get_task",
        status: "ok",
        initialStatus: "in_flight",
        result: { id: "t-1" },
      },
      {
        toolCallId: "c2",
        stepId: "s2",
        toolName: "stop_task",
        status: "denied",
        errorMessage: "skipped: approval",
      },
    ],
  });

  it("两条 tool 应答都与快照逐字节相同，且缺口说明「recorded 的 payload 不带正文」", async () => {
    const { snapshot, projected } = await dualRun(world);

    expect(json(projected.messages)).toBe(json(snapshot));
    expect(String(projected.messages[4].content)).toContain("【未执行】");
    expect(String(projected.messages[4].content)).toContain("人工审批");
    // 不是「调用未成功」——那两个文案语义相反，混淆会让模型重试一个它不该重试的调用
    expect(String(projected.messages[4].content)).not.toContain(
      "【调用未成功】",
    );

    const gap = projected.gaps.find((g) => g.field === "errorMessage");
    expect(gap).toMatchObject({
      class: "event_only_metadata",
      resolvedBy: "snapshot",
    });
    expect(gap?.detail).toContain("tool_call_recorded");
  });
});

describe("projectSession · ②c 工具结果的三种落库形态都逐字节一致（截断/预览/超长裁剪）", () => {
  /**
   * 这三条是最容易被「看起来对」的复刻混过去的地方：文案里的括号、省略号、
   * sha256 与字符裁剪宽度必须逐字相同。任何一处漂移，模型看到的都是**另一段
   * 证据**——而它据此决定下一步动作。
   */
  const withRow = (row: Partial<ToolCallRow>): World =>
    worldOf({
      steps: [
        step({ id: "s1", seq: 1, role: "user", content: "看日志" }),
        step({
          id: "s2",
          seq: 2,
          role: "assistant",
          content: "",
          toolCallsJson: [
            {
              id: "c1",
              type: "function",
              function: { name: "get_logs", arguments: "{}" },
            },
          ],
        }),
      ],
      toolCalls: [
        {
          toolCallId: "c1",
          stepId: "s2",
          toolName: "get_logs",
          status: "ok",
          initialStatus: "in_flight",
          ...row,
        },
      ],
    });

  it("仅预览形态（超过 32KB 存储上限）：文案与 sha256 占位逐字一致", async () => {
    const world = withRow({
      result: {
        truncated: true,
        preview: "前 200 字符的预览",
        sha256: "deadbeef",
      },
    });
    const { snapshot, projected } = await dualRun(world);

    expect(json(projected.messages)).toBe(json(snapshot));
    expect(String(projected.messages[3].content)).toContain(
      "【工具结果（重放·仅预览）】",
    );
    expect(String(projected.messages[3].content)).toContain("sha256=deadbeef");
  });

  it("有全文形态（≤32KB 脱敏原文）：走与实时路径相同的首尾裁剪", async () => {
    const world = withRow({
      result: {
        truncated: true,
        full: "头".repeat(3_000) + "尾".repeat(3_000),
      },
    });
    const { snapshot, projected } = await dualRun(world);

    expect(json(projected.messages)).toBe(json(snapshot));
    expect(String(projected.messages[3].content)).toContain("…[中间省略 ");
    expect(String(projected.messages[3].content)).toContain(
      "已保留首尾以便定位错误与结论",
    );
  });

  it("普通超长结果 + resultTruncated：裁剪宽度与「原结果已截断」尾巴都一致", async () => {
    const big = {
      lines: Array.from(
        { length: 300 },
        (_, i) => `第 ${i} 行日志：ERROR something failed`,
      ),
    };
    const world = withRow({ result: big, resultTruncated: true });
    const { snapshot, projected } = await dualRun(world);

    expect(json(projected.messages)).toBe(json(snapshot));
    // 剪到 2000 字符：尾部的「已截断」标记必须还在（模型据此知道还有内容没看到）
    expect(String(projected.messages[3].content)).toContain(
      "…（原结果已截断）",
    );
  });

  it("在途（in_flight）行：两侧都是「结果未知」，不谎称成功也不谎称失败", async () => {
    const world = withRow({ status: "in_flight", result: null });
    const { snapshot, projected } = await dualRun(world);

    expect(json(projected.messages)).toBe(json(snapshot));
    expect(String(projected.messages[3].content)).toContain("【结果未知】");
    expect(unresolved(projected)).toEqual([]);
  });
});

/* ── ③ 折叠过的会话 ─────────────────────────────────────────────── */

describe("projectSession · ③ 折叠会话：先如实说「一致/不一致」，再把差异点分类", () => {
  const world = worldOf({
    steps: [
      step({
        id: "s1",
        seq: 1,
        role: "user",
        content: "早期原文（已被折叠）",
        summary: "早期 3 步：查了 task-1，两次执行均失败",
      }),
      step({
        id: "s2",
        seq: 2,
        role: "assistant",
        content: "结论：需要人工介入。",
      }),
    ],
  });

  it("回读到摘要正文 ⇒ 逐字节一致，但缺口里必须记「摘要正文只能回读」", async () => {
    const { snapshot, projected } = await dualRun(world);

    expect(json(projected.messages)).toBe(json(snapshot));
    expect(String(projected.messages[1].content)).toBe(
      "[阶段小结] 早期 3 步：查了 task-1，两次执行均失败",
    );
    const gap = projected.gaps.find((g) => g.field === "summary");
    expect(gap).toBeDefined();
    // 一致是**回读**换来的：事件里只有 folded=true
    expect(gap).toMatchObject({
      class: "event_only_metadata",
      resolvedBy: "snapshot",
    });
    expect(gap?.detail).toContain("folded=true");
  });

  it("回读不到摘要正文 ⇒ **不一致**，且差异点被分类记录（不弱化成「一致」）", async () => {
    // 只让 s1 的摘要「回读不到」（其余快照行照给）：这样差异点唯一，
    // 便于断言「差异被定位到具体一条」，而不是被一堆缺口搅浑。
    const steps = { ...(resolveOf(world).steps as Any) };
    delete steps.s1.summary;
    const { snapshot, projected } = await dualRun(world, { steps });

    const diff = diffMessages(snapshot, projected.messages);
    expect(diff).toHaveLength(1);
    expect(diff[0].index).toBe(1);
    expect(diff[0].kind).toBe("different");
    // 投影侧是**带标记**的兜底文案，不是空串、更不是编造的摘要
    expect(String(diff[0].right && (diff[0].right as Any).content)).toContain(
      "【投影缺口】",
    );
    expect(String(diff[0].right && (diff[0].right as Any).content)).toContain(
      "[阶段小结]",
    );

    const gap = projected.gaps.find((g) => g.field === "summary");
    expect(gap?.class).toBe("event_only_metadata");
    expect(gap?.resolvedBy).toBe("none");
    // 「差异点被分类记录」= 缺口表里能对上这一条，而不是只留下一份 diff
    expect(projected.stats.gapsByClass.event_only_metadata).toBeGreaterThan(0);
  });
});

/* ── ④ 事件流有洞 ───────────────────────────────────────────────── */

describe("projectSession · ④ 事件流有洞（人为删一条）⇒ 如实标记缺口，不静默跳过", () => {
  const world = worldOf({
    steps: [
      step({ id: "s1", seq: 1, role: "user", content: "查一下 task-1" }),
      step({
        id: "s2",
        seq: 2,
        role: "assistant",
        content: "",
        toolCallsJson: [
          {
            id: "c1",
            type: "function",
            function: { name: "get_task", arguments: "{}" },
          },
        ],
      }),
    ],
    toolCalls: [
      {
        toolCallId: "c1",
        stepId: "s2",
        toolName: "get_task",
        status: "ok",
        initialStatus: "in_flight",
        result: { id: "t-1" },
      },
    ],
  });

  /** 删掉「状态迁移」那条事件 = 模拟旁路写失败（行已 ok，事件还停在 in_flight）。 */
  const holed = (): { events: ProjectionEvent[]; removedSeq: number } => {
    const idx = world.events.findIndex(
      (e) => e.kind === "tool_call_status_changed",
    );
    expect(idx).toBeGreaterThan(0);
    const removedSeq = world.events[idx].seq;
    const events = world.events.filter((_, i) => i !== idx);
    return { events, removedSeq };
  };

  it("seq 洞在 integrity 里点名（首/尾/缺号），并记 seq_gap", () => {
    const { events, removedSeq } = holed();
    const out = projectSession(events, resolveOf(world));

    expect(out.integrity.contiguous).toBe(false);
    expect(out.integrity.missing).toEqual([removedSeq]);
    expect(out.integrity.firstSeq).toBe(1);
    expect(out.integrity.lastSeq).toBe(
      world.events[world.events.length - 1].seq,
    );
    expect(out.integrity.duplicates).toEqual([]);

    const gap = out.gaps.find((g) => g.class === "seq_gap");
    expect(gap).toMatchObject({ seq: removedSeq, resolvedBy: "none" });
    expect(gap?.detail).toContain("永久丢失");
    expect(out.stats.gapsByClass.seq_gap).toBe(1);
  });

  it("投影**不静默跳过**：该步的消息还在，但工具应答如实退成「结果未知」并与快照不一致", async () => {
    const { events } = holed();
    const out = projectSession(events, resolveOf(world));
    const { snapshot } = await dualRun(world);

    // 消息条数不变（删的是状态迁移，不是 step）——这正是「不能靠条数判完整性」的理由
    expect(out.messages).toHaveLength(snapshot.length);
    const toolMsg = out.messages.find((m) => m.role === "tool");
    expect(String(toolMsg?.content)).toContain("【结果未知】");
    expect(String(toolMsg?.content)).toContain("副作用可能已经发生");

    const diff = diffMessages(snapshot, out.messages);
    expect(diff).toHaveLength(1);
    expect(diff[0].index).toBe(3);
    expect(String(diff[0].left && (diff[0].left as Any).content)).toContain(
      "工具结果（重放）",
    );
    // 事件状态 vs 台账行状态：交叉校验必须把「事件落后」单独点出来
    expect(
      out.gaps.some(
        (g) => g.class === "event_lags_snapshot" && g.field === "status",
      ),
    ).toBe(true);
  });

  it("未登记的事件类型不会被忽略，而是记 unknown_event（写入点新增 kind ⇒ 对账红）", () => {
    const events = [
      ...world.events,
      {
        seq: world.events.length + 1,
        // 用**一个还没登记**的 kind 当样本：`approval_decided` 自第四阶段起已
        // 登记且有写入点，拿它当「未登记」的例子会让这条用例名不副实。
        kind: "budget_exceeded",
        payload: { reason: "wall_clock" },
      },
    ];
    const out = projectSession(events, resolveOf(world));

    const gap = out.gaps.find((g) => g.class === "unknown_event");
    expect(gap?.detail).toContain("budget_exceeded");
    expect(out.stats.byKind.budget_exceeded).toBe(1);
  });
});

/* ── ⑤ 审批路径：`approval_decided` 让「一致」成为**可证明**的结论 ───────── */

describe("projectSession · ⑤ 审批路径（approval_decided）", () => {
  /** 一条两步骤的会话：用户要求停任务 → 模型发起一次需审批的调用。 */
  const approvalSteps = () => [
    step({ id: "s1", seq: 1, role: "user", content: "把这个任务停掉" }),
    step({
      id: "s2",
      seq: 2,
      role: "assistant",
      content: "",
      toolCallsJson: [
        {
          id: "c1",
          type: "function",
          function: { name: "stop_task", arguments: '{"id":"t-1"}' },
        },
      ],
    }),
  ];

  const awaitingWorld = (o: {
    approval: Any;
    decisions?: Array<{
      approvalKey: string;
      status: string;
      decidedBy?: string | null;
      decidedAt?: string;
    }>;
    /** 台账行的**当前** status（deny 之后 controller 会把它 settle 成 denied）。 */
    rowStatus?: string;
    errorMessage?: string | null;
    initialStatus?: string;
    /** 第五阶段写入点：settle 命中之后那条 `tool_call_status_changed`。 */
    settles?: Array<{
      toolCallId: string;
      toolName: string;
      tier?: string;
      status: string;
      errorMessage?: string | null;
      resultTruncated?: boolean;
      hasResult?: boolean;
      durationMs?: number;
    }>;
  }): World =>
    worldOf({
      steps: approvalSteps(),
      toolCalls: [
        {
          toolCallId: "c1",
          stepId: "s2",
          toolName: "stop_task",
          status: o.rowStatus ?? "awaiting_approval",
          initialStatus: o.initialStatus,
          approvalId: "ap-1",
          errorMessage: o.errorMessage ?? "该调用需要人工审批",
        },
      ],
      approvals: [o.approval],
      decisions: o.decisions,
      settles: o.settles,
    });

  /**
   * 模拟「settle 那条事件旁路写失败」：台账行已 denied，事件流仍停在
   * awaiting_approval；重排 seq 以免 seq 洞干扰断言（洞是另一类缺口，有别的用例）。
   */
  const withoutStatusChanged = (w: World): World => ({
    ...w,
    events: w.events
      .filter((e) => e.kind !== "tool_call_status_changed")
      .map((e, i) => ({ ...e, seq: i + 1 })),
  });

  it("granted + 一条 approval_decided ⇒ 与快照**逐字节一致**（一致来自事件，不是回读快照）", async () => {
    const world = awaitingWorld({
      approval: { approvalKey: "ap-1", status: "granted", decidedBy: "alice" },
      decisions: [
        {
          approvalKey: "ap-1",
          status: "granted",
          decidedBy: "alice",
          decidedAt: "2026-11-02T02:00:00.000Z",
        },
      ],
    });
    const { snapshot, projected } = await dualRun(world);

    expect(json(projected.messages)).toBe(json(snapshot));
    expect(diffMessages(snapshot, projected.messages)).toEqual([]);

    const projTool = projected.messages.find((m) => m.role === "tool");
    expect(String(projTool?.content)).toContain("【已获批准】");
    expect(String(projTool?.content)).toContain("alice");
    expect(String(projTool?.content)).toContain("立即用完全相同的参数重新提交");

    // 一致必须是**事件**换来的：来源标注 resolvedBy=event（不是又读了一遍快照）
    const gap = projected.gaps.find((g) => g.field === "approvalStatus");
    expect(gap).toMatchObject({
      class: "resolved_by_event",
      resolvedBy: "event",
    });
    // 反向断言：「审批没有事件」这条缺口必须消失（否则说明还在走兜底分支）
    expect(projected.gaps.some((g) => g.field === "approvalDecided")).toBe(
      false,
    );
  });

  it("granted 但 approval_decided **旁路丢失** ⇒ 仍语义相反，缺口 not_eventized/approvalDecided", async () => {
    const world = awaitingWorld({
      approval: { approvalKey: "ap-1", status: "granted", decidedBy: "alice" },
    });
    const { snapshot, projected } = await dualRun(world);

    const snapTool = snapshot.find((m) => m.role === "tool");
    const projTool = projected.messages.find((m) => m.role === "tool");
    expect(String(snapTool?.content)).toContain("【已获批准】");
    expect(String(projTool?.content)).toContain("【等待人工审批】");

    expect(
      diffMessages(snapshot, projected.messages).map((d) => d.index),
    ).toEqual([3]);
    const gap = projected.gaps.find((g) => g.field === "approvalDecided");
    expect(gap).toMatchObject({ class: "not_eventized", resolvedBy: "none" });
    expect(gap?.detail).toContain("语义相反");
  });

  it("consumed（granted 之后被领取）⇒ 一致：投影说「已执行」而不是「等待审批」", async () => {
    const world = awaitingWorld({
      approval: { approvalKey: "ap-1", status: "consumed", decidedBy: "alice" },
      decisions: [
        { approvalKey: "ap-1", status: "granted", decidedBy: "alice" },
        { approvalKey: "ap-1", status: "consumed", decidedBy: null },
      ],
    });
    const { snapshot, projected } = await dualRun(world);

    expect(json(projected.messages)).toBe(json(snapshot));
    const projTool = projected.messages.find((m) => m.role === "tool");
    expect(String(projTool?.content)).toContain("【已执行】");
    expect(String(projTool?.content)).toContain("ap-1");
  });

  it("granted 且决定人为空 ⇒ 两侧同样回落「管理员」（逐字一致）", async () => {
    const world = awaitingWorld({
      approval: { approvalKey: "ap-1", status: "granted", decidedBy: null },
      decisions: [{ approvalKey: "ap-1", status: "granted", decidedBy: null }],
    });
    const { snapshot, projected } = await dualRun(world);

    expect(json(projected.messages)).toBe(json(snapshot));
    const projTool = projected.messages.find((m) => m.role === "tool");
    expect(String(projTool?.content)).toContain("管理员");
  });

  /** 拒绝文案：controller 的 settle 写进台账行 `errorMessage` 的那一句。 */
  const DENIED_TEXT = "已被 alice 人工拒绝（审批单 ap-1）——不得重试同一调用";

  /**
   * deny 的**真实**时序（第五阶段之后）：
   *   ① `decide(denied)` 的条件 UPDATE 命中 ⇒ `approval_decided`(denied)；
   *   ② controller 调 `settleToolCallByApprovalId`，条件 UPDATE 把台账行
   *      `awaiting_approval → denied` 命中 ⇒ `tool_call_status_changed`(denied)。
   * 旁路丢失那一半由 `withoutStatusChanged(deniedWorld())` 复现（见下一个用例）。
   */
  const deniedWorld = (): World =>
    awaitingWorld({
      approval: { approvalKey: "ap-1", status: "denied", decidedBy: "alice" },
      decisions: [
        {
          approvalKey: "ap-1",
          status: "denied",
          decidedBy: "alice",
          decidedAt: "2026-11-02T02:00:00.000Z",
        },
      ],
      rowStatus: "denied",
      initialStatus: "awaiting_approval",
      errorMessage: DENIED_TEXT,
      settles: [
        {
          toolCallId: "c1",
          toolName: "stop_task",
          tier: "write",
          status: "denied",
          errorMessage: DENIED_TEXT,
        },
      ],
    });

  it("deny：settle 落 tool_call_status_changed ⇒ 与快照**逐字节一致**（最后一处不等价补齐）", async () => {
    const world = deniedWorld();
    const { snapshot, projected } = await dualRun(world);

    // ① 真·逐字节：整串 JSON 相等，差异列表为空
    expect(json(projected.messages)).toBe(json(snapshot));
    expect(diffMessages(snapshot, projected.messages)).toEqual([]);

    // ② 文案来自**台账行口径**（status 事件把这次调用带到了 denied 分支），
    //    不再是先前那句按审批决定渲染的「【已被拒绝】审批单 ap-1…」
    const projTool = projected.messages.find((m) => m.role === "tool");
    expect(String(projTool?.content)).toContain("【调用未成功】状态 denied");
    expect(String(projTool?.content)).toContain(DENIED_TEXT);
    expect(String(projTool?.content)).not.toContain("【已被拒绝】审批单");

    // ③ 两条旧缺口必须消失：settle 未事件化、事件状态落后于台账行
    expect(projected.gaps.some((g) => g.field === "toolCallSettled")).toBe(
      false,
    );
    expect(projected.gaps.some((g) => g.class === "event_lags_snapshot")).toBe(
      false,
    );
    // ④ 一致是**事件**换来的：errorMessage 正文仍按约定回读台账行（存在性由事件给）
    expect(
      projected.gaps.some(
        (g) =>
          g.field === "errorMessage" &&
          g.class === "event_only_metadata" &&
          g.resolvedBy === "snapshot",
      ),
    ).toBe(true);
  });

  it("deny 但 settle 那条事件**旁路丢失** ⇒ 仍不一致，缺口 not_eventized/toolCallSettled", async () => {
    // 台账行已 denied，事件流仍停在 awaiting_approval（旁路写失败 / 存量会话）。
    const world = withoutStatusChanged(deniedWorld());
    const { snapshot, projected } = await dualRun(world);

    const snapTool = snapshot.find((m) => m.role === "tool");
    const projTool = projected.messages.find((m) => m.role === "tool");
    // 快照走台账行口径，投影走审批决定口径 —— 两句不同，**不能**为了绿而假装一致
    expect(String(snapTool?.content)).toContain("【调用未成功】状态 denied");
    expect(String(projTool?.content)).toContain("【已被拒绝】");
    expect(diffMessages(snapshot, projected.messages)).toHaveLength(1);

    const gap = projected.gaps.find((g) => g.field === "toolCallSettled");
    expect(gap).toMatchObject({ class: "not_eventized", resolvedBy: "none" });
    expect(gap?.detail).toContain("settleToolCallByApprovalId");
  });

  it("投影**不接受**审批状态作为入参（给了就是对账造假：绿了也证明不了什么）", () => {
    // 结构性判据：`ProjectionSnapshot` 上没有审批字段。第四阶段之后这条**更**
    // 重要：审批状态唯一合法的来源是 `approval_decided` 事件流；若有人「顺手加
    // 一个 approvals 入参」，对账会绿，而切换后线上投影仍然只有快照侧知道结果。
    const snapshotKeys = Object.keys(
      resolveOf(
        awaitingWorld({ approval: { approvalKey: "ap-1", status: "granted" } }),
      ),
    );
    expect(snapshotKeys).not.toContain("approvals");
    expect(snapshotKeys.sort()).toEqual([
      "contextJson",
      "steps",
      "systemPrompt",
      "toolCalls",
      "unkeyedToolCallRows",
    ]);
  });
});

/* ── ⑥ 存量行：没有 toolCallId（投影连缺口都得靠「清单」才看得见）──────── */

describe("projectSession · ⑥ 存量行（无 toolCallId）⇒ 快照能兜底、投影不能，差异必须留痕", () => {
  const world = worldOf({
    steps: [
      step({ id: "s1", seq: 1, role: "user", content: "查一下" }),
      step({
        id: "s2",
        seq: 2,
        role: "assistant",
        content: "",
        toolCallsJson: [
          {
            id: "c1",
            type: "function",
            function: { name: "get_task", arguments: "{}" },
          },
        ],
      }),
    ],
    toolCalls: [
      // 迁移 069 之前的存量行：toolCallId 为 NULL，且没有事件（阶段一之前写入）
      {
        toolCallId: null,
        stepId: "s2",
        toolName: "get_task",
        status: "ok",
        result: { id: "t-9" },
      },
    ],
  });

  it("快照按 (stepId, 工具名) 兜底渲染出结果；投影渲染「结果缺失」并记 row_without_event", async () => {
    const { snapshot, projected } = await dualRun(world);

    expect(String(snapshot[3].content)).toContain("t-9");
    expect(String(projected.messages[3].content)).toBe(
      "【工具结果缺失】该调用没有对应的执行记录（可能在上报前中断）——请重新观察现状后再决定下一步。",
    );
    const gap = projected.gaps.find(
      (g) => g.class === "row_without_event" && g.field === "toolCallId",
    );
    expect(gap).toBeDefined();
    expect(gap?.detail).toContain("兜底");
    // 差异是**真的**：逐字节比对必须红（不是为了对齐而把兜底文案改写成快照的样子）
    expect(diffMessages(snapshot, projected.messages)).toHaveLength(1);
  });
});

/* ── ⑦ 对账脚本的自检必须真的被执行 ──────────────────────────────── */

describe("scripts/agent-event-projection-audit.mjs · --selftest 可执行（零依赖、不连 DB）", () => {
  it("退出码 0 且打印夹具对账结论", () => {
    // 为什么在 spec 里跑它：本阶段不许改根 package.json，脚本无法接进 test:guards；
    // 让它由 runtime 的 spec 带着跑，是「它的自检不会烂在角落里」的最低成本。
    const script = join(
      __dirname,
      "..",
      "..",
      "..",
      "..",
      "..",
      "..",
      "..",
      "scripts",
      "agent-event-projection-audit.mjs",
    );
    const out = execFileSync(process.execPath, [script, "--selftest"], {
      encoding: "utf8",
      timeout: 30_000,
    });
    expect(out).toContain("SELFTEST");
    expect(out).toContain("一致");
  });
});
