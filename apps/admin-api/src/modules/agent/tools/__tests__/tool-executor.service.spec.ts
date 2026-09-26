import { ConfigService } from "@nestjs/config";

import {
  ToolExecutorService,
  TOOL_RESULT_MAX_CHARS,
} from "../tool-executor.service";
import { AgentBoundaryService } from "../../boundary/agent-boundary.service";
import type { AgentSession } from "../../entities/agent-session.entity";

function harness(opts?: {
  invoke?: (
    spec: { name: string },
    args: Record<string, unknown>,
  ) => Promise<unknown>;
  toolCalls?: Array<{ toolName: string; status: string }>;
}) {
  const boundary = new AgentBoundaryService({
    get: () => undefined,
  } as unknown as ConfigService);
  const sessions = {
    recordToolCall: jest.fn(async (v: unknown) => v),
    listToolCalls: jest.fn(async () => opts?.toolCalls ?? []),
  };
  const api = {
    invoke: jest.fn(
      opts?.invoke ?? (async () => ({ data: { ok: true }, isError: false })),
    ),
  };
  const notify = { approvalRequested: jest.fn(async () => undefined) };
  const checkSpy = jest.spyOn(boundary, "check");
  const svc = new ToolExecutorService(
    boundary,
    sessions as never,
    api as never,
    notify as never,
  );
  return { svc, boundary, sessions, api, notify, checkSpy };
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
    // availableTools 只喂 43 收编工具；内部 SOP 工具经运行时另行注入
    expect(names).not.toContain("sop_publish");
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

  it("NEED_APPROVAL：审批单落库（awaiting_approval）+ 通知推送 + 回给模型提示", async () => {
    const h = harness();
    const out = await h.svc.execute(
      session(),
      call("sop_publish", { sopId: "sop-1" }),
      null,
    );
    expect(out.content).toContain("【等待人工审批】");
    expect(h.sessions.recordToolCall).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "awaiting_approval",
        approvalId: expect.stringContaining("apr-s-1-"),
      }),
    );
    expect(h.notify.approvalRequested).toHaveBeenCalled();
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
    expect(out.content).toContain("[结果已截断");
    expect(out.content.length).toBeLessThan(TOOL_RESULT_MAX_CHARS + 100);
    const recorded = h.sessions.recordToolCall.mock.calls[0][0] as Record<
      string,
      unknown
    >;
    expect(recorded.resultTruncated).toBe(true);
    expect((recorded.result as Record<string, unknown>).preview).toHaveLength(
      500,
    );
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
    const recorded = h.sessions.recordToolCall.mock.calls[0][0] as {
      args: Record<string, unknown>;
    };
    expect(recorded.args.apiKey).toBe("[REDACTED]");
    expect(recorded.args.password).toBe("[REDACTED]");
    expect(recorded.args.note as string).toContain("[REDACTED]");
    expect(recorded.args.note as string).not.toContain("hunter2");
    expect(recorded.args.note as string).toContain("[REDACTED_HEX]");
    expect(recorded.args.note as string).not.toContain("0123abcd0123abcd");
  });
});
