import { createHash } from "node:crypto";
import { ConfigService } from "@nestjs/config";

import {
  ToolExecutorService,
  TOOL_RESULT_MAX_CHARS,
  TOOL_TIMEOUT_MS,
  shapeToolResultForModel,
  repairToolArguments,
} from "../tool-executor.service";
import { AgentBoundaryService } from "../../boundary/agent-boundary.service";
import type { AgentSession } from "../../entities/agent-session.entity";

function harness(opts?: {
  invoke?: (
    spec: { name: string },
    args: Record<string, unknown>,
  ) => Promise<unknown>;
  toolCalls?: Array<{ toolName: string; status: string }>;
  /** 已存在的审批单（granted/denied/consumed/pending）；默认无。 */
  existingApproval?: {
    approvalKey: string;
    status: string;
    decidedBy?: string | null;
  } | null;
  /** consume 条件写是否成功（默认 true）。 */
  consumeOk?: boolean;
  sops?: Partial<{
    getBySlug: (slug: string) => Promise<unknown>;
    getClarificationScopeInfo: (
      id: string,
    ) => Promise<Record<string, unknown> | null>;
  }>;
}) {
  const boundary = new AgentBoundaryService({
    get: () => undefined,
  } as unknown as ConfigService);
  const sessions = {
    // 第 6 轮：在途台账/幂等闸的读面（默认无历史行）
    findToolCall: jest.fn(async () => null),
    recordToolCall: jest.fn(async (v: unknown) => v),
    // TOOLS-02 确定性重放：就地更新原台账行（避开 GAP-5 唯一索引）
    updateToolCallByToolCallId: jest.fn(async () => true),
    listToolCalls: jest.fn(async () => opts?.toolCalls ?? []),
    markWaiting: jest.fn(async () => undefined),
  };
  const api = {
    invoke: jest.fn(
      opts?.invoke ?? (async () => ({ data: { ok: true }, isError: false })),
    ),
  };
  const notify = { approvalRequested: jest.fn(async () => undefined) };
  // B-2/B-3：执行体入口的两道校验依赖 SopService（slug→id、澄清归属投影）
  const sops = {
    getBySlug: jest.fn(
      opts?.sops?.getBySlug ?? (async () => ({ id: "sop-1" })),
    ),
    getClarificationScopeInfo: jest.fn(
      opts?.sops?.getClarificationScopeInfo ??
        (async () => ({
          assignmentId: "a1",
          sopId: "sop-1",
          reviewSessionId: null,
        })),
    ),
  };
  const checkSpy = jest.spyOn(boundary, "check");
  // 缺陷 A：熔断记账是「超时算不算失败」的判据，用例要能断言它的参数
  const outcomeSpy = jest.spyOn(boundary, "recordOutcome");
  // A1 审批闭环（实施轮 #12）：requestApproval 现在要经 approvals 落库并
  // markWaiting 挂起——替身默认放行（不落真行），闭环行为由
  // agent-approvals.spec.ts 与本文件的新用例钉。
  const approvals = {
    request: jest.fn(async (v: unknown) => v),
    // 实施轮 #14（执行侧闭环）：闸门消费审批结论需要这三个口子。
    //   buildKey 用真实实现（纯函数，键的确定性本身要被测）
    //   findByKey 默认「没有审批单」；consume 默认领取成功。
    buildKey: (
      sessionId: string,
      toolName: string,
      args: Record<string, unknown> | null,
    ) => `apr-${sessionId}-${toolName}-${JSON.stringify(args ?? null)}`,
    findByKey: jest.fn(async () => opts?.existingApproval ?? null),
    consume: jest.fn(async () => opts?.consumeOk ?? true),
  };
  const svc = new ToolExecutorService(
    boundary,
    sessions as never,
    api as never,
    notify as never,
    approvals as never,
    sops as never,
  );
  return {
    svc,
    boundary,
    sessions,
    api,
    notify,
    approvals,
    sops,
    checkSpy,
    outcomeSpy,
  };
}

function session(patch: Partial<AgentSession> = {}): AgentSession {
  return {
    id: "s-1",
    kind: "chat",
    scopeJson: { unrestricted: true },
    ...patch,
  } as unknown as AgentSession;
}

const call = (name: string, args: unknown) => ({
  id: "call-1",
  function: {
    name,
    arguments: typeof args === "string" ? args : JSON.stringify(args),
  },
});

describe("ToolExecutorService · availableTools（喂给 LLM 的白名单）", () => {
  it("硬禁用工具不暴露给模型；chat 会话见全集（除硬禁用）", async () => {
    const { svc } = harness();
    const tools = await svc.availableTools(session());
    const names = tools.map((t) => t.name);
    expect(names).not.toContain("approve_deployment");
    expect(names).not.toContain("reject_deployment");
    expect(names).toContain("get_task");
    // TOOLS-01：内部 SOP 工具与收编工具一起下发（此前用 AGENT_TOOL_SPECS
    // 过滤，6 个 sop_* 从不出现在请求的 tools 里，SOP 链路静默不可用）。
    expect(names).toContain("sop_publish");
    expect(names).toContain("sop_draft");
    for (const t of tools) {
      expect(t).toHaveProperty("parameters");
      expect(t).toHaveProperty("tier");
    }
  });

  it("ops_watch 会话只见只读工具", async () => {
    const { svc } = harness();
    const tools = await svc.availableTools(
      session({ kind: "ops_watch" } as never),
    );
    const names = tools.map((t) => t.name);
    expect(names).toContain("get_task");
    expect(names).not.toContain("trigger_task");
  });
});

describe("ToolExecutorService · execute（唯一入口，强制过闸）", () => {
  it("畸形 JSON 参数：落 error 并把可读原因回给模型", async () => {
    const { svc, sessions, api } = harness();
    const out = await svc.execute(
      session(),
      call("get_task", "{bad json"),
      "step-1",
    );
    expect(out).toEqual({
      content: expect.stringContaining("不是合法 JSON"),
      truncated: false,
    });
    expect(sessions.recordToolCall).toHaveBeenCalledWith(
      expect.objectContaining({ status: "error", tier: "read" }),
    );
    expect(api.invoke).not.toHaveBeenCalled();
  });

  it("闸门 DENY：denied 落库 + 不消耗速率预算（denied 不计入 priorCalls）", async () => {
    const h = harness({
      toolCalls: [
        { toolName: "get_task", status: "denied" },
        { toolName: "get_task", status: "denied" },
        { toolName: "get_task", status: "ok" },
      ],
    });
    // out_of_scope：会话 scope 不含 tasks
    const restricted = session({ scopeJson: {} } as never);
    const out = await h.svc.execute(
      restricted,
      call("get_task", { taskId: "t-1" }),
      null,
    );
    expect(out.content).toContain("【调用被拒绝】");
    expect(h.sessions.recordToolCall).toHaveBeenCalledWith(
      expect.objectContaining({ status: "denied" }),
    );
    // 3 条历史里 2 条 denied → priorCalls=1（denied 不消耗预算）
    expect(h.checkSpy.mock.calls[0][3]).toBe(1);
  });

  // APPROVAL-GAP（2026-10-27 审计轮 #11，A1）：本用例原先断言文案含
  // 【等待人工审批】——而"等待"在实现上等于"永远等不到"（审批单不落库、
  // 无 grant 端点、markWaiting 无生产调用方）。断言把**声明与实现不符**
  // 固化成了预期行为。现改为断言"如实告知不可执行"，并把三条事实一起钉住。
  it("NEED_APPROVAL：审批单落库 + 会话挂起 + 通知推送 + 告知已提交（A1 闭环）", async () => {
    const h = harness();
    const out = await h.svc.execute(
      session(),
      call("sop_publish", { sopId: "sop-1" }),
      null,
    );
    // 闭环后文案不再说"不可执行"——审批单真的在等人处置，grant 后自动恢复
    expect(out.content).toContain("【需人工审批，已提交审批单】");
    expect(out.content).toContain("请勿重复提交");
    // 落库三件套：agent_approvals 申请（含幂等键）、调用行 awaiting_approval、
    // 会话 markWaiting 挂起（"生产零调用"是 A1 的原始形态之一，必须钉住）
    expect(h.approvals.request).toHaveBeenCalledWith(
      expect.objectContaining({
        approvalKey: expect.stringContaining("apr-s-1-"),
        sessionId: "s-1",
        toolName: "sop_publish",
      }),
    );
    expect(h.sessions.recordToolCall).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "awaiting_approval",
        approvalId: expect.stringContaining("apr-s-1-"),
      }),
    );
    expect(h.sessions.markWaiting).toHaveBeenCalledWith(
      "s-1",
      expect.stringContaining("等待审批"),
    );
    expect(h.notify.approvalRequested).toHaveBeenCalled();
    // needsApproval 是运行时的「停轮」信号：没有它，会话会在已 waiting_input
    // 的状态下继续下一轮推理（实施轮 #14 的并发缺陷形态）。
    expect(out.needsApproval).toBe(true);
  });

  // ── 执行侧闭环（实施轮 #14）：审批结论必须被执行路径消费 ──────────────
  //
  // 原实现只有申请侧：闸门恒返回 NEED_APPROVAL，grant 只翻数据库行。批准后
  // resume，模型重提同一调用会得到第二张单——「人工点头后可用」不成立。
  it("granted 审批单 → 闸门放行（其余闸照旧）+ 执行前领取 + 真的调用 API", async () => {
    const h = harness({
      existingApproval: {
        approvalKey: "apr-s-1-sop_publish-x",
        status: "granted",
      },
    });
    const out = await h.svc.execute(
      session(),
      call("sop_publish", { sopId: "sop-1" }),
      null,
    );
    // 闸门收到第五参（本次调用的通行证），而不是再次 NEED_APPROVAL
    expect(h.checkSpy.mock.calls[0][4]).toEqual(expect.any(String));
    expect(h.api.invoke).toHaveBeenCalled();
    expect(out.content).not.toContain("需人工审批");
    // 领取在副作用之前：consume 被调用且 key 与闸门收到的一致
    expect(h.approvals.consume).toHaveBeenCalledWith(
      h.checkSpy.mock.calls[0][4],
    );
  });

  it("denied 审批单 → 直接拒绝：不重新申请、不挂起、不调用 API", async () => {
    const h = harness({
      existingApproval: {
        approvalKey: "apr-s-1-sop_publish-x",
        status: "denied",
        decidedBy: "alice",
      },
    });
    const out = await h.svc.execute(
      session(),
      call("sop_publish", { sopId: "sop-1" }),
      null,
    );
    expect(out.content).toContain("已被人工拒绝");
    expect(out.content).toContain("alice");
    expect(out.needsApproval).toBeUndefined();
    expect(h.approvals.request).not.toHaveBeenCalled();
    expect(h.sessions.markWaiting).not.toHaveBeenCalled();
    expect(h.api.invoke).not.toHaveBeenCalled();
    expect(h.sessions.recordToolCall).toHaveBeenCalledWith(
      expect.objectContaining({ status: "denied" }),
    );
  });

  it("consumed 审批单 → 拒绝（一张批准单只放行一次）", async () => {
    const h = harness({
      existingApproval: {
        approvalKey: "apr-s-1-sop_publish-x",
        status: "consumed",
      },
    });
    const out = await h.svc.execute(
      session(),
      call("sop_publish", { sopId: "sop-1" }),
      null,
    );
    expect(out.content).toContain("只放行一次");
    expect(h.api.invoke).not.toHaveBeenCalled();
  });

  it("领取失败（并发抢单 / 已被用掉）→ 拒绝且不产生副作用", async () => {
    const h = harness({
      existingApproval: {
        approvalKey: "apr-s-1-sop_publish-x",
        status: "granted",
      },
      consumeOk: false,
    });
    const out = await h.svc.execute(
      session(),
      call("sop_publish", { sopId: "sop-1" }),
      null,
    );
    expect(out.content).toContain("已被另一次调用使用");
    expect(h.approvals.consume).toHaveBeenCalled();
    expect(h.api.invoke).not.toHaveBeenCalled();
  });

  // C4（审计轮 #11）：awaiting_approval 不得消耗速率配额——审批通道没闭环时，
  // 一个会话碰几次"需审批"的工具就会把配额烧光，而它一次都没真正执行过。
  it("C4：awaiting_approval 不计入速率配额（只有真正执行过才算）", async () => {
    const h = harness();
    h.sessions.listToolCalls.mockResolvedValue([
      { toolName: "sop_publish", status: "awaiting_approval" },
      { toolName: "sop_publish", status: "awaiting_approval" },
      { toolName: "sop_publish", status: "success" },
    ]);
    await h.svc.execute(
      session(),
      call("sop_publish", { sopId: "sop-1" }),
      null,
    );
    // 3 条历史里 2 条 awaiting_approval 被排除 ⇒ priorCalls=1
    expect(h.checkSpy.mock.calls[0][3]).toBe(1);
  });

  it("执行成功：小结果原样回传；recordOutcome(true)", async () => {
    const h = harness();
    const out = await h.svc.execute(
      session(),
      call("get_task", { taskId: "t-1" }),
      null,
    );
    expect(out.truncated).toBe(false);
    expect(JSON.parse(out.content)).toEqual({ ok: true });
    expect(h.sessions.recordToolCall).toHaveBeenCalledWith(
      expect.objectContaining({ status: "ok", resultTruncated: false }),
    );
  });

  it("大结果截断：模型拿前 2000 字符 + 截断标记；完整落库为 preview+sha256", async () => {
    const big = { items: "x".repeat(TOOL_RESULT_MAX_CHARS + 500) };
    const h = harness({ invoke: async () => ({ data: big, isError: false }) });
    const out = await h.svc.execute(
      session(),
      call("get_task", { taskId: "t-1" }),
      null,
    );
    expect(out.truncated).toBe(true);
    // 首尾保留 + 中段省略：错误/结论通常在尾部，不能只留头部
    expect(out.content).toContain("中间省略");
    expect(out.content.length).toBeLessThanOrEqual(TOOL_RESULT_MAX_CHARS);
    expect(out.content.startsWith("{")).toBe(true);
    expect(out.content).toContain('"items"');
    expect(out.content.trimEnd().endsWith("}")).toBe(true);
    const recorded = h.sessions.recordToolCall.mock.calls[
      h.sessions.recordToolCall.mock.calls.length - 1
    ][0] as Record<string, unknown>;
    expect(recorded.resultTruncated).toBe(true);
    expect((recorded.result as Record<string, unknown>).preview).toHaveLength(
      500,
    );
    // P4：原文 ≤32KB 时一并存下（get_tool_call_result 的数据源）
    expect(typeof (recorded.result as Record<string, unknown>).full).toBe(
      "string",
    );
    expect(
      ((recorded.result as Record<string, unknown>).full as string).length,
    ).toBeGreaterThan(TOOL_RESULT_MAX_CHARS);
    expect((recorded.result as Record<string, unknown>).sha256).toMatch(
      /^[0-9a-f]{64}$/,
    );
  });

  it("invoke 抛异常：error 落库 + 熔断记账失败", async () => {
    const h = harness({
      invoke: async () => {
        throw new Error("connection refused");
      },
    });
    const out = await h.svc.execute(
      session(),
      call("get_task", { taskId: "t-1" }),
      null,
    );
    expect(out.content).toContain("【调用失败】connection refused");
    expect(h.sessions.recordToolCall).toHaveBeenCalledWith(
      expect.objectContaining({ status: "error" }),
    );
  });

  it("超时：status=timeout（不与普通 error 混淆）", async () => {
    jest.useFakeTimers();
    try {
      const h = harness({
        invoke: () => new Promise<never>(() => undefined), // 永不 resolve
      });
      const p = h.svc.execute(
        session(),
        call("get_task", { taskId: "t-1" }),
        null,
      );
      const race = jest.advanceTimersByTimeAsync(60_000);
      const out = await p;
      await race;
      expect(out.content).toContain("timed out");
      expect(h.sessions.recordToolCall).toHaveBeenCalledWith(
        expect.objectContaining({ status: "timeout" }),
      );
    } finally {
      jest.useRealTimers();
    }
  });

  it("invoke 返回 isError（如「尚未实现」）：调用失败回传 + 失败记账", async () => {
    const h = harness({
      invoke: async () => ({
        data: null,
        isError: true,
        errorMessage: "尚未实现",
      }),
    });
    const out = await h.svc.execute(
      session(),
      call("get_task", { taskId: "t-1" }),
      null,
    );
    expect(out.content).toBe("【调用失败】尚未实现");
    expect(h.sessions.recordToolCall).toHaveBeenCalledWith(
      expect.objectContaining({ status: "error", errorMessage: "尚未实现" }),
    );
  });
});

describe("ToolExecutorService · 脱敏（凭据不落库）", () => {
  it("键名剥离（token/password/apiKey/credential）+ 值形态剥离（Bearer/hex/VAR=）", async () => {
    const h = harness();
    await h.svc.execute(
      session(),
      call("get_task", {
        taskId: "t-1",
        apiKey: "sk-abcdef",
        password: "hunter2",
        note: "Authorization=Bearer abc.def TIMEOUT=30 0123abcd0123abcd0123abcd0123abcd",
      }),
      null,
    );
    const recorded = h.sessions.recordToolCall.mock.calls[
      h.sessions.recordToolCall.mock.calls.length - 1
    ][0] as {
      args: Record<string, unknown>;
    };
    expect(recorded.args.apiKey).toBe("[REDACTED]");
    expect(recorded.args.password).toBe("[REDACTED]");
    expect(recorded.args.note as string).toContain("[REDACTED]");
    expect(recorded.args.note as string).not.toContain("hunter2");
    expect(recorded.args.note as string).toContain("[REDACTED_HEX]");
    expect(recorded.args.note as string).not.toContain("0123abcd0123abcd");
  });

  it("嵌套层的凭据同样剥离（对象/数组递归——落库前无死角）", async () => {
    const h = harness();
    await h.svc.execute(
      session(),
      call("trigger_task", {
        taskId: "t-1",
        params: {
          nested: { apiToken: "sk-nested-secret", password: "hunter2" },
          tokens: ["tok-a", "tok-b"],
          list: ["tok-a", "tok-b"],
          note: "Bearer nested.should.not.leak",
        },
      }),
      null,
    );
    const recorded = h.sessions.recordToolCall.mock.calls[
      h.sessions.recordToolCall.mock.calls.length - 1
    ][0] as {
      args: Record<string, unknown>;
    };
    const params = recorded.args.params as Record<string, unknown>;
    const nested = params.nested as Record<string, unknown>;
    expect(nested.apiToken).toBe("[REDACTED]");
    expect(nested.password).toBe("[REDACTED]");
    // 键名含 token → 整体剥除（键名剥除优先于递归）
    expect(params.tokens).toBe("[REDACTED]");
    // 中性键名的数组：元素逐个过值形态脱敏
    expect(params.list).toEqual(["tok-a", "tok-b"]);
    const note = params.note as string;
    expect(note).toContain("[REDACTED]");
    expect(note).not.toContain("nested.should.not.leak");
    // 非 凭据键/字符串 字段原样保留（回归锚：脱敏不误伤数据）
    expect(recorded.args.taskId).toBe("t-1");
  });
});

// ── 缺陷 A（P2）：超时只 reject 不取消，结论被写成「调用失败」──────────
// 修法两级：① 取消通道（execute 建 AbortController，超时 abort 并经 invoke
// 透传给接受第二参的 handler）；② 语义分级——写/危险 tier 的超时是「结果
// 未知」（副作用可能已发生），只读工具的超时才是「失败」。
describe("ToolExecutorService · 超时语义分级（写工具=结果未知 / 只读=失败）", () => {
  /** 永不 resolve 的执行体：只会被超时闸门终结。 */
  const never = () => new Promise<never>(() => undefined);

  it("写工具超时：回给模型「结果未知」（不是调用失败）+ 台账 timeout + 不计熔断失败", async () => {
    jest.useFakeTimers();
    try {
      const h = harness({ invoke: never });
      const p = h.svc.execute(
        session(),
        call("trigger_task", { taskId: "t-1" }),
        null,
      );
      const timers = jest.advanceTimersByTimeAsync(TOOL_TIMEOUT_MS);
      const out = await p;
      await timers;

      // 语义：结果未知，且明确禁止盲目重试
      expect(out.content).toContain("结果未知");
      expect(out.content).not.toContain("调用失败");
      expect(out.content).toContain("list_executions");
      expect(out.content).toContain("不要直接重试");

      // 台账仍记 timeout（审计要能按「超时」筛，不与 error 混）
      expect(h.sessions.recordToolCall).toHaveBeenCalledWith(
        expect.objectContaining({ status: "timeout" }),
      );

      // 「未知」不计为失败：熔断记账一次都不该发生（尤其不能是 false）
      expect(h.outcomeSpy).not.toHaveBeenCalled();

      // 取消通道确实发出了：本次调用的 AbortSignal 已 abort
      // （harness 的 mock 声明只有两参，第三参用 unknown[] 读）
      const invokeArgs = h.api.invoke.mock.calls[0] as unknown as unknown[];
      const ctx = invokeArgs[2] as { signal: AbortSignal };
      expect(ctx.signal).toBeInstanceOf(AbortSignal);
      expect(ctx.signal.aborted).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });

  it("只读工具超时：维持「调用失败」语义并计入熔断失败（重试无副作用）", async () => {
    jest.useFakeTimers();
    try {
      const h = harness({ invoke: never });
      const p = h.svc.execute(
        session(),
        call("get_task", { taskId: "t-1" }),
        null,
      );
      const timers = jest.advanceTimersByTimeAsync(TOOL_TIMEOUT_MS);
      const out = await p;
      await timers;

      expect(out.content).toContain("调用失败");
      expect(out.content).not.toContain("结果未知");
      expect(h.sessions.recordToolCall).toHaveBeenCalledWith(
        expect.objectContaining({ status: "timeout" }),
      );
      expect(h.outcomeSpy).toHaveBeenCalledWith("s-1", "get_task", false);
    } finally {
      jest.useRealTimers();
    }
  });
});

// ── 缺陷 B（P3）：结果未脱敏就落库 ──────────────────────────────────
// 脱敏只作用于**持久化副本**；回给模型的 content 保持原文（模型需要事实）。
// 结果侧额外启用「整体 digest 保留」——32+ hex 规则会误伤 sha256/commit id。
describe("ToolExecutorService · 结果脱敏（落库副本脱敏，模型侧保留原文）", () => {
  const sha = "a".repeat(64);

  it("结果落库前脱敏：键名/日志行剥凭据，64 位 digest 保留，content 仍是原文", async () => {
    const h = harness({
      invoke: async () => ({
        data: { token: "abc", logs: ["API_TOKEN=secret123"], sha },
        isError: false,
      }),
    });
    const out = await h.svc.execute(
      session(),
      call("get_execution_logs", { executionId: "e-1" }),
      null,
    );
    const recorded = h.sessions.recordToolCall.mock.calls[
      h.sessions.recordToolCall.mock.calls.length - 1
    ][0] as {
      result: Record<string, unknown>;
    };
    // 键名剥除
    expect(recorded.result.token).toBe("[REDACTED]");
    // 值形态剥除（日志行里的 VAR=）
    expect((recorded.result.logs as string[])[0]).toContain("[REDACTED]");
    expect((recorded.result.logs as string[])[0]).not.toContain("secret123");
    // digest 保留（对账需要，不能被 32+ hex 规则误伤）
    expect(recorded.result.sha).toBe(sha);
    // 模型侧：事实原样（含凭据原文与 digest）
    expect(out.content).toContain("secret123");
    expect(out.content).toContain(sha);
  });

  it("truncated 分支：preview 用脱敏后的串；sha256 仍按原文算", async () => {
    const data = {
      logs: [
        "AUTOFLOW_TOKEN=live-secret-123",
        "Authorization: Bearer leak.me.now",
        "x".repeat(TOOL_RESULT_MAX_CHARS + 500),
      ],
      sha,
    };
    const h = harness({ invoke: async () => ({ data, isError: false }) });
    const out = await h.svc.execute(
      session(),
      call("get_execution_logs", { executionId: "e-1" }),
      null,
    );
    expect(out.truncated).toBe(true);

    const recorded = h.sessions.recordToolCall.mock.calls[
      h.sessions.recordToolCall.mock.calls.length - 1
    ][0] as {
      result: Record<string, unknown>;
    };
    const preview = recorded.result.preview as string;
    expect(preview).toHaveLength(500);
    expect(preview).not.toContain("live-secret-123");
    expect(preview).not.toContain("leak.me.now");
    // sha256 与**原文**对账：算脱敏后的串就失去意义
    expect(recorded.result.sha256).toBe(
      createHash("sha256")
        .update(JSON.stringify(data, null, 2))
        .digest("hex"),
    );
    // 模型侧仍是原文
    expect(out.content).toContain("live-secret-123");
  });
});

// B-2：sop_get 的 slug 路径在执行体入口先解析成 id 再走闸——闸门语义单一
// （缺 id 不放行），slug 绕不过 scope 白名单。
describe("ToolExecutorService · sop_get slug 归一（B-2）", () => {
  const scopedSession = (sops: string[]) =>
    session({ kind: "sop_review", scopeJson: { sops } } as never);

  it("slug 解析出的 id 在白名单内 → 放行；闸门收到的是归一后的 id", async () => {
    const h = harness({
      sops: { getBySlug: async () => ({ id: "sop-2" }) },
    });
    const out = await h.svc.execute(
      scopedSession(["sop-2"]),
      call("sop_get", { slug: "my-sop" }),
      null,
    );
    expect(JSON.parse(out.content)).toEqual({ ok: true });
    expect(h.sops.getBySlug).toHaveBeenCalledWith("my-sop");
    // 闸门看到的 args 已含归一后的 sopId
    expect(h.checkSpy.mock.calls[0][2]).toMatchObject({ sopId: "sop-2" });
    expect(h.api.invoke).toHaveBeenCalled();
  });

  it("slug 解析出的 id 不在白名单内 → 拒绝（slug 绕过被闸死）", async () => {
    const h = harness({
      sops: { getBySlug: async () => ({ id: "sop-OTHER" }) },
    });
    const out = await h.svc.execute(
      scopedSession(["sop-2"]),
      call("sop_get", { slug: "other-sop" }),
      null,
    );
    expect(out.content).toContain("【调用被拒绝】");
    expect(out.content).toContain("不在本会话作用域内");
    expect(h.api.invoke).not.toHaveBeenCalled();
    expect(h.sessions.recordToolCall).toHaveBeenCalledWith(
      expect.objectContaining({ status: "denied" }),
    );
  });

  it("slug 不存在 → 按调用失败回给模型，不冒泡异常", async () => {
    const h = harness({
      sops: {
        getBySlug: async () => {
          throw new Error("SOP no-such 不存在");
        },
      },
    });
    const out = await h.svc.execute(
      session({ kind: "chat" } as never),
      call("sop_get", { slug: "no-such" }),
      null,
    );
    expect(out.content).toContain("【调用失败】SOP no-such 不存在");
    expect(h.sessions.recordToolCall).toHaveBeenCalledWith(
      expect.objectContaining({ status: "error" }),
    );
    expect(h.api.invoke).not.toHaveBeenCalled();
  });

  it("sopId 路径回归：带 sopId 时不查 slug，直接过闸", async () => {
    const h = harness();
    await h.svc.execute(
      scopedSession(["sop-9"]),
      call("sop_get", { sopId: "sop-9" }),
      null,
    );
    expect(h.sops.getBySlug).not.toHaveBeenCalled();
    expect(h.api.invoke).toHaveBeenCalled();
  });
});

// B-3：sop_reply_clarification 的归属校验——回复权 = 修订权（可自主发版），
// 只有「本会话复核的澄清」或「scope.sops 白名单内 SOP 的澄清」可回复。
describe("ToolExecutorService · sop_reply_clarification 归属校验（B-3）", () => {
  const reviewSession = (sops: string[]) =>
    session({ kind: "sop_review", scopeJson: { sops } } as never);

  it("他机复核会话对他人工单澄清回复 → denied，不执行", async () => {
    const h = harness({
      sops: {
        getClarificationScopeInfo: async () => ({
          assignmentId: "a-other",
          sopId: "sop-OTHER",
          reviewSessionId: "sess-elsewhere",
        }),
      },
    });
    const out = await h.svc.execute(
      reviewSession(["sop-mine"]),
      call("sop_reply_clarification", {
        clarificationId: "clr-1",
        resolution: "sop_amended",
        answer: "我改一下别人的 SOP",
      }),
      null,
    );
    expect(out.content).toContain("【调用被拒绝】");
    expect(out.content).toContain("不在本会话作用域内");
    expect(h.api.invoke).not.toHaveBeenCalled();
    expect(h.sessions.recordToolCall).toHaveBeenCalledWith(
      expect.objectContaining({ status: "denied", tier: "write" }),
    );
  });

  it("本会话复核的澄清（reviewSessionId === session.id）→ 放行", async () => {
    const h = harness({
      sops: {
        getClarificationScopeInfo: async () => ({
          assignmentId: "a1",
          sopId: "sop-1",
          reviewSessionId: "s-1",
        }),
      },
    });
    await h.svc.execute(
      reviewSession([]), // scope 里没有 SOP——靠 reviewSessionId 本人身份放行
      call("sop_reply_clarification", {
        clarificationId: "clr-1",
        resolution: "answered",
        answer: "重启浏览器",
      }),
      null,
    );
    expect(h.api.invoke).toHaveBeenCalled();
  });

  it("澄清所属 SOP 在 scope.sops 白名单内 → 放行（交付复核会话形态）", async () => {
    const h = harness({
      sops: {
        getClarificationScopeInfo: async () => ({
          assignmentId: "a1",
          sopId: "sop-1",
          reviewSessionId: "sess-elsewhere",
        }),
      },
    });
    await h.svc.execute(
      reviewSession(["sop-1"]),
      call("sop_reply_clarification", {
        clarificationId: "clr-1",
        resolution: "answered",
        answer: "按验收项核对",
      }),
      null,
    );
    expect(h.api.invoke).toHaveBeenCalled();
  });

  it("澄清不存在/不可追溯 → denied", async () => {
    const h = harness({
      sops: { getClarificationScopeInfo: async () => null },
    });
    const out = await h.svc.execute(
      reviewSession(["sop-1"]),
      call("sop_reply_clarification", {
        clarificationId: "clr-404",
        resolution: "answered",
        answer: "x",
      }),
      null,
    );
    expect(out.content).toContain("【调用被拒绝】");
    expect(h.api.invoke).not.toHaveBeenCalled();
  });
});

/**
 * TOOLS-02 确定性重放：台账里已有同 toolCallId 的 awaiting_approval 行。
 * GAP-5 的 (sessionId, toolCallId) 唯一索引禁止再插一行，且「一次调用一行
 * 台账」是审计语义——重放必须就地更新。
 */
describe("ToolExecutorService · 已批准调用的就地更新（TOOLS-02）", () => {
  it("replayApproved：更新原台账行而不是新增（避开唯一索引）", async () => {
    const h = harness({
      existingApproval: { approvalKey: "apr-any", status: "granted" },
    });
    const call = {
      id: "call-1",
      function: { name: "get_task", arguments: '{"taskId":"t-1"}' },
    };

    const out = await h.svc.execute(
      {
        id: "s-1",
        kind: "chat",
        scopeJson: { unrestricted: true },
      } as never,
      call,
      null,
      { replayApproved: true },
    );

    expect(out.content).toBeTruthy();
    expect(h.sessions.updateToolCallByToolCallId).toHaveBeenCalledWith(
      "s-1",
      "call-1",
      expect.objectContaining({ toolName: "get_task", status: "ok" }),
    );
    expect(h.sessions.recordToolCall).not.toHaveBeenCalled();
  });

  it("非重放路径仍走 insert（既有行为不变）", async () => {
    const h = harness();
    await h.svc.execute(
      {
        id: "s-1",
        kind: "chat",
        scopeJson: { unrestricted: true },
      } as never,
      {
        id: "call-2",
        function: { name: "get_task", arguments: '{"taskId":"t-1"}' },
      },
      null,
    );
    expect(h.sessions.updateToolCallByToolCallId).not.toHaveBeenCalled();
    expect(h.sessions.recordToolCall).toHaveBeenCalled();
  });
});

describe("shapeToolResultForModel（首尾保留裁剪）", () => {
  it("不超限原样返回", () => {
    const out = shapeToolResultForModel("short", 100);
    expect(out).toEqual({ content: "short", truncated: false });
  });

  it("超限时保留首尾，中段省略并报告省略字符数", () => {
    const src = "HEAD" + "x".repeat(500) + "TAIL";
    const out = shapeToolResultForModel(src, 120);
    expect(out.truncated).toBe(true);
    expect(out.content.length).toBeLessThanOrEqual(120);
    expect(out.content.startsWith("HEAD")).toBe(true);
    expect(out.content.endsWith("TAIL")).toBe(true);
    expect(out.content).toContain("中间省略");
    expect(out.content).toContain("字符");
  });

  it("max 小于标记长度时不产出超长内容（边界安全）", () => {
    const out = shapeToolResultForModel("y".repeat(100), 10);
    expect(out.truncated).toBe(true);
    expect(out.content.length).toBeLessThanOrEqual(10);
    expect(out.content).toBe("y".repeat(10));
  });
});

/**
 * 工具参数的保守修复：只修**无歧义**的语法噪音（围栏/散文/尾逗号），
 * 缺值/缺括号一律报错——"参数错了"要报错，"值猜错了"更难查。
 */
describe("repairToolArguments（保守修复）", () => {
  it("合法 JSON 原样解析", () => {
    expect(repairToolArguments('{"a":1}')).toEqual({
      ok: true,
      value: { a: 1 },
    });
  });

  it("空字符串 = 无参数", () => {
    expect(repairToolArguments("")).toEqual({ ok: true, value: {} });
  });

  it("Markdown 代码围栏（带 json 标注）", () => {
    const raw = '```json\n{"taskId":"t-1"}\n```';
    expect(repairToolArguments(raw)).toEqual({
      ok: true,
      value: { taskId: "t-1" },
    });
  });

  it("前后散文包裹（截取对象本体）", () => {
    const raw = '好的，参数如下：{"limit":10} 请执行';
    expect(repairToolArguments(raw)).toEqual({
      ok: true,
      value: { limit: 10 },
    });
  });

  it("尾逗号（对象与数组）", () => {
    expect(repairToolArguments('{"a":1,}')).toEqual({
      ok: true,
      value: { a: 1 },
    });
    expect(repairToolArguments('{"a":[1,2,]}')).toEqual({
      ok: true,
      value: { a: [1, 2] },
    });
  });

  it("围栏 + 尾逗号叠加也能修", () => {
    expect(repairToolArguments('```json\n{"a":1,}\n```')).toEqual({
      ok: true,
      value: { a: 1 },
    });
  });

  it("缺值/缺括号**不猜**——如实报错并说明尝试过哪些修复", () => {
    const missingValue = repairToolArguments('{"a":}');
    expect(missingValue.ok).toBe(false);
    expect(missingValue.reason).toContain("保守修复");

    const missingBrace = repairToolArguments('{"a":1');
    expect(missingBrace.ok).toBe(false);
  });
});

describe("execute 接线：畸形参数经保守修复后照常执行", () => {
  it("围栏包裹的 arguments 不会让工具调用失败", async () => {
    const h = harness({
      invoke: async (_spec, args) => ({
        data: { echoed: args },
        isError: false,
      }),
    });
    const out = await h.svc.execute(
      session(),
      call("get_task", '```json\n{"taskId":"t-1"}\n```'),
      null,
    );
    expect(out.truncated).toBe(false);
    expect(JSON.parse(out.content)).toEqual({ echoed: { taskId: "t-1" } });
  });

  it("P4: 超过 32KB 的截断结果不存全文（只 preview + sha256）", async () => {
    // 单字段会被脱敏截到 4000 字符，所以用「多字段」把整份文档推过 32KB。
    const big = { items: Array.from({ length: 12 }, () => "x".repeat(4000)) };
    const h = harness({ invoke: async () => ({ data: big, isError: false }) });
    await h.svc.execute(session(), call("get_task", { taskId: "t-1" }), null);
    const recorded = h.sessions.recordToolCall.mock.calls[
      h.sessions.recordToolCall.mock.calls.length - 1
    ][0] as Record<string, unknown>;
    const stored = recorded.result as Record<string, unknown>;
    expect(stored.truncated).toBe(true);
    expect(stored.full).toBeUndefined();
    expect(stored.preview).toBeTruthy();
  });
});

/**
 * 第 6 轮八域审计 P1：写工具「执行前在途台账 + 同 id 幂等闸」。
 *
 * 崩溃发生在「闸门放行 → 结果落库」之间时，旧实现没有任何持久痕迹，resume
 * 只能回「结果缺失」，模型会直接重提 → deploy/trigger 双份副作用。
 */
describe("ToolExecutorService · in_flight 在途台账（第 6 轮审计 P1）", () => {
  it("发现同 id 的 in_flight 行 → 不执行、回「结果未知，先核实」", async () => {
    const h = harness();
    (h.sessions.findToolCall as jest.Mock).mockResolvedValueOnce({
      status: "in_flight",
    });
    const out = await h.svc.execute(
      session(),
      call("get_task", { taskId: "t-1" }),
      null,
    );
    expect(out.content).toContain("结果未知");
    expect(out.content).toContain("不要直接重提");
    expect(h.api.invoke).not.toHaveBeenCalled();
  });

  it("正常路径：副作用之前先落 in_flight（顺序早于 invoke）", async () => {
    const h = harness();
    await h.svc.execute(session(), call("get_task", { taskId: "t-1" }), null);
    const inFlight = h.sessions.recordToolCall.mock.calls.find(
      (c: unknown[]) => (c[0] as { status?: string }).status === "in_flight",
    );
    expect(inFlight).toBeTruthy();
    const order = (fn: { mock: { invocationCallOrder: number[] } }) =>
      fn.mock.invocationCallOrder[0];
    expect(order(h.sessions.recordToolCall)).toBeLessThan(order(h.api.invoke));
  });
});
