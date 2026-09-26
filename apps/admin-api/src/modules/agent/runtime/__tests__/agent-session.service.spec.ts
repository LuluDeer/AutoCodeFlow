import { NotFoundException } from "@nestjs/common";

import { AgentSessionService } from "../agent-session.service";
import { AGENT_TERMINAL_STATUSES } from "../../entities/agent-session.entity";

/** TypeORM 惯用 fake：createQueryBuilder 链式桩。 */
function qbChain(result: unknown = { affected: 1 }) {
  const qb: Record<string, jest.Mock> = {};
  qb.update = jest.fn().mockReturnThis();
  qb.set = jest.fn().mockReturnThis();
  qb.where = jest.fn().mockReturnThis();
  qb.andWhere = jest.fn().mockReturnThis();
  qb.orderBy = jest.fn().mockReturnThis();
  qb.skip = jest.fn().mockReturnThis();
  qb.take = jest.fn().mockReturnThis();
  qb.select = jest.fn().mockReturnThis();
  qb.execute = jest.fn(async () => result);
  qb.getRawOne = jest.fn(async () => ({ maxSeq: 2 }));
  qb.getManyAndCount = jest.fn(async () => [[{ id: "row-1" }], 1]);
  return qb;
}

function harness(sessionRow: Record<string, unknown> | null = { id: "s-1" }) {
  const sessionQb = qbChain();
  const listQb = qbChain();
  const sessions: Record<string, unknown> = {
    create: jest.fn((v: unknown) => ({ id: "s-new", ...(v as object) })),
    save: jest.fn(async (v: unknown) => ({ ...(v as object), id: "s-new" })),
    findOne: jest.fn(async (): Promise<unknown> => sessionRow),
    update: jest.fn(async () => undefined),
    find: jest.fn(async () => [{ id: "child-1" }]),
    createQueryBuilder: jest.fn((alias?: string) =>
      alias === "s" ? listQb : sessionQb,
    ),
    manager: {
      transaction: jest.fn(async (cb: (em: unknown) => Promise<unknown>) =>
        cb(em()),
      ),
    },
  };
  const emQb = qbChain();
  const em = () => ({
    createQueryBuilder: jest.fn(() => emQb),
    create: jest.fn((_cls: unknown, v: unknown) => ({
      id: "step-3",
      ...(v as object),
    })),
    save: jest.fn(async (v: unknown) => v),
  });
  const toolCalls = {
    create: jest.fn((v: unknown) => ({ id: "tc-1", ...(v as object) })),
    save: jest.fn(async (v: unknown) => v),
    find: jest.fn(async () => [{ id: "tc-1" }]),
  };
  const budgetService = {
    resolveBudget: jest.fn(() => ({
      maxSteps: 40,
      maxTokens: 1000,
      wallClockMs: 60000,
      maxToolCalls: 20,
    })),
  };
  const notify = { sessionFinished: jest.fn(async () => undefined) };
  const svc = new AgentSessionService(
    sessions as never,
    { find: jest.fn(async () => [{ id: "step-1" }]) } as never,
    toolCalls as never,
    budgetService as never,
    notify as never,
  );
  return {
    svc,
    sessions,
    sessionQb,
    listQb,
    emQb,
    toolCalls,
    budgetService,
    notify,
  };
}

describe("AgentSessionService · 创建与查询", () => {
  it("create：缺省字段归 null/safe default，budget 缺省走 resolveBudget", async () => {
    const h = harness();
    const out = await h.svc.create({
      kind: "incident",
      triggerSource: "manual",
    });
    expect(out).toMatchObject({
      kind: "incident",
      status: "pending",
      title: null,
      parentSessionId: null,
      scopeJson: {},
      budgetJson: {
        maxSteps: 40,
        maxTokens: 1000,
        wallClockMs: 60000,
        maxToolCalls: 20,
      },
      totalSteps: 0,
      totalToolCalls: 0,
    });
    expect(h.budgetService.resolveBudget).toHaveBeenCalled();
  });

  it("create：显式 title/parent/context/scope/budget 逐项落位", async () => {
    const h = harness();
    await h.svc.create({
      kind: "sop_review",
      triggerSource: "clarification",
      title: "T",
      parentSessionId: "p-1",
      context: { a: 1 },
      scope: { sops: ["sop-1"] },
      budget: { maxSteps: 1, maxTokens: 2, wallClockMs: 3, maxToolCalls: 4 },
    });
    expect(h.sessions.create).toHaveBeenCalledWith(
      expect.objectContaining({
        parentSessionId: "p-1",
        contextJson: { a: 1 },
        scopeJson: { sops: ["sop-1"] },
        budgetJson: {
          maxSteps: 1,
          maxTokens: 2,
          wallClockMs: 3,
          maxToolCalls: 4,
        },
      }),
    );
  });

  it("requireById：找不到抛 NotFound", async () => {
    const h = harness(null);
    await expect(h.svc.requireById("nope")).rejects.toThrow(NotFoundException);
    const ok = harness({ id: "s-1" });
    await expect(ok.svc.requireById("s-1")).resolves.toEqual({ id: "s-1" });
  });

  it("list：kind/status 过滤接线，page/pageSize 钳位", async () => {
    const h = harness();
    await h.svc.list({
      kind: "incident",
      status: "running",
      page: 3,
      pageSize: 999,
    });
    expect(h.listQb.andWhere).toHaveBeenCalledWith("s.kind = :kind", {
      kind: "incident",
    });
    expect(h.listQb.andWhere).toHaveBeenCalledWith("s.status = :status", {
      status: "running",
    });
    expect(h.listQb.skip).toHaveBeenCalledWith(2 * 100);
    expect(h.listQb.take).toHaveBeenCalledWith(100);
    h.listQb.andWhere.mockClear();
    const out = await h.svc.list({});
    expect(out).toEqual({ items: [{ id: "row-1" }], total: 1 });
    expect(h.listQb.andWhere).not.toHaveBeenCalled();
  });

  it("findChildren / listSteps / listToolCalls 透传排序读取", async () => {
    const h = harness();
    await expect(h.svc.findChildren("p-1")).resolves.toEqual([
      { id: "child-1" },
    ]);
    await expect(h.svc.listSteps("s-1")).resolves.toEqual([{ id: "step-1" }]);
    await expect(h.svc.listToolCalls("s-1")).resolves.toEqual([{ id: "tc-1" }]);
  });
});

describe("AgentSessionService · 状态迁移（幂等语义）", () => {
  it("markRunning：首次置 startedAt；已有 startedAt 不重置（墙钟不可续命）", async () => {
    const fresh = harness({ id: "s-1", startedAt: null });
    await fresh.svc.markRunning("s-1");
    expect(fresh.sessionQb.set).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "running",
        startedAt: expect.any(Date),
      }),
    );

    const resumed = harness({ id: "s-1", startedAt: new Date("2026-01-01") });
    await resumed.svc.markRunning("s-1");
    expect(resumed.sessionQb.set).toHaveBeenCalledWith({
      status: "running",
      waitingFor: null,
    });
  });

  it("markWaiting：不设 finishedAt（非终态）", async () => {
    const h = harness();
    await h.svc.markWaiting("s-1", "clarification_reply");
    expect(h.sessions.update).toHaveBeenCalledWith(
      { id: "s-1" },
      { status: "waiting_input", waitingFor: "clarification_reply" },
    );
  });

  it("finish：会话不存在静默返回；已终态幂等短路", async () => {
    const missing = harness(null);
    await missing.svc.finish("s-1", "succeeded");
    expect(missing.sessions.update).not.toHaveBeenCalled();
    expect(missing.notify.sessionFinished).not.toHaveBeenCalled();

    for (const terminal of AGENT_TERMINAL_STATUSES) {
      const done = harness({ id: "s-1", kind: "incident", status: terminal });
      await done.svc.finish("s-1", "failed", { errorMessage: "x" });
      expect(done.sessions.update).not.toHaveBeenCalled();
      expect(done.notify.sessionFinished).not.toHaveBeenCalled();
    }
  });

  it("finish：正常路径更新 + 通知传更新后的快照（静默语义读新 summary）", async () => {
    const h = harness({
      id: "s-1",
      kind: "incident",
      status: "running",
      totalSteps: 3,
      totalTokensIn: 10,
      totalTokensOut: 20,
      resultJson: { old: true },
      summary: "old",
    });
    await h.svc.finish("s-1", "succeeded", {
      result: { verdict: "ok" },
      summary: "done",
    });
    expect(h.sessions.update).toHaveBeenCalledWith(
      { id: "s-1" },
      expect.objectContaining({
        status: "succeeded",
        finishedAt: expect.any(Date),
        waitingFor: null,
        resultJson: { verdict: "ok" },
        summary: "done",
      }),
    );
    expect(h.notify.sessionFinished).toHaveBeenCalledWith(
      expect.objectContaining({ status: "succeeded", summary: "done" }),
    );
  });

  it("finish：result/summary 缺省回落既有值", async () => {
    const h = harness({
      id: "s-1",
      kind: "incident",
      status: "running",
      resultJson: { keep: 1 },
      summary: "keep",
    });
    await h.svc.finish("s-1", "aborted");
    expect(h.sessions.update).toHaveBeenCalledWith(
      { id: "s-1" },
      expect.objectContaining({ resultJson: { keep: 1 }, summary: "keep" }),
    );
  });
});

describe("AgentSessionService · 步骤与用量（同事务收敛）", () => {
  it("appendStep：seq = MAX+1，缺省字段归 0/null；用量与 step 同事务累加", async () => {
    const h = harness();
    const step = await h.svc.appendStep("s-1", {
      role: "assistant",
      content: "hi",
      provider: "qwen",
      model: "qwen-vl-max",
      tokensIn: 12,
      tokensOut: 34,
    });
    expect(step).toMatchObject({ seq: 3, role: "assistant", tokensIn: 12 });
    const setArg = h.emQb.set.mock.calls[0][0] as Record<string, () => string>;
    expect(setArg.totalTokensIn()).toContain("12");
    expect(setArg.totalTokensOut()).toContain("34");
    expect(setArg.totalSteps()).toContain("totalSteps");
  });

  it("appendStep：tokens 缺省为 0（不记令牌指标分支）", async () => {
    const h = harness();
    const step = await h.svc.appendStep("s-1", { role: "user" });
    expect(step).toMatchObject({ tokensIn: 0, tokensOut: 0, latencyMs: 0 });
  });

  it("recordToolCall：被拒/待审批的尝试同样落库 + 计数", async () => {
    const h = harness();
    await h.svc.recordToolCall({
      sessionId: "s-1",
      toolName: "trigger_task",
      tier: "write",
      status: "denied",
      args: { taskId: "t-1" },
      errorMessage: "out_of_scope",
    });
    expect(h.toolCalls.create).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "denied",
        resultTruncated: false,
        durationMs: 0,
      }),
    );
    expect(h.sessionQb.set).toHaveBeenCalledWith(
      expect.objectContaining({ totalToolCalls: expect.anything() }),
    );
  });

  it("getUsage：从 DB 重读真实用量（不信内存副本）；行缺失回 0/null", async () => {
    const h = harness({
      id: "s-1",
      totalSteps: 4,
      totalTokensIn: 100,
      totalTokensOut: 200,
      totalToolCalls: 5,
      startedAt: new Date("2026-01-01"),
    });
    await expect(h.svc.getUsage({ id: "s-1" } as never)).resolves.toEqual({
      steps: 4,
      tokensIn: 100,
      tokensOut: 200,
      toolCalls: 5,
      startedAt: new Date("2026-01-01"),
    });
    const missing = harness(null);
    await expect(missing.svc.getUsage({ id: "s-1" } as never)).resolves.toEqual(
      {
        steps: 0,
        tokensIn: 0,
        tokensOut: 0,
        toolCalls: 0,
        startedAt: null,
      },
    );
  });
});
