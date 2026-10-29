import { NotFoundException } from "@nestjs/common";

import { AgentSessionService, safeTokenCount } from "../agent-session.service";
import { AGENT_TERMINAL_STATUSES } from "../../entities/agent-session.entity";
import {
  getRuntimeCountersSnapshot,
  resetRuntimeMetrics,
} from "../../../metrics/runtime-metrics-entry";

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
    // ADR-027（替身保真）：update 必须返回 `{ affected }`——否则「条件写命中/未命中」
    // 这条分支在测试里无法表达（返回 undefined ⇒ 被当成未命中），守卫等于没测。
    update: jest.fn(async () => ({ affected: 1 })),
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
    update: jest.fn(async () => ({ affected: 1 })),
  };
  const budgetService = {
    resolveBudget: jest.fn(() => ({
      maxSteps: 40,
      maxTokens: 1000,
      wallClockMs: 60000,
      maxToolCalls: 20,
    })),
  };
  const notify = {
    sessionFinished: jest.fn(async () => undefined),
    staleSweepConverged: jest.fn(async () => undefined),
  };
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

  it("list：NaN/Infinity page/pageSize 安全回落默认 1/20（穿透钳制会炸 500）", async () => {
    // HTTP 层 parseInt("abc")=NaN 会穿透 Math.max/Math.min（Math.max(1,NaN)=NaN），
    // NaN 直达 skip/take——必须视同未传回落默认，而不是让 Prisma/TypeORM 500，
    // 也不是 400（对齐前端「深链非法值回落默认」契约）。
    for (const evil of [
      NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
    ]) {
      const h = harness();
      await h.svc.list({ page: evil, pageSize: evil });
      expect(h.listQb.skip).toHaveBeenCalledWith(0);
      expect(h.listQb.take).toHaveBeenCalledWith(20);
    }
  });

  it("list：合法 page/pageSize 不受 NaN 守卫影响（原值照用）", async () => {
    const h = harness();
    await h.svc.list({ page: 2, pageSize: 50 });
    expect(h.listQb.skip).toHaveBeenCalledWith(50);
    expect(h.listQb.take).toHaveBeenCalledWith(50);
  });

  it("list：page 超上限 10000 钳到 10000（F-54，对齐 NETOPT-3④ 口径，不 400）", async () => {
    // ?page=99999999 此前生成 OFFSET ~2e9 的深 OFFSET + 全量 COUNT。超限值
    // 钳到上限（安全回落语义，与 NaN 回落同一契约：不 400），skip =
    // (10000-1)*pageSize。
    const h = harness();
    await h.svc.list({ page: 99999999, pageSize: 20 });
    expect(h.listQb.skip).toHaveBeenCalledWith(9999 * 20);
    expect(h.listQb.take).toHaveBeenCalledWith(20);
    // 边界内不钳：10000 本身原样。
    const h2 = harness();
    await h2.svc.list({ page: 10000, pageSize: 20 });
    expect(h2.listQb.skip).toHaveBeenCalledWith(9999 * 20);
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

  it("markRunning：CAS where 排除 running 与全部终态（B-8 双保险）", async () => {
    const h = harness({ id: "s-1", startedAt: null });
    await h.svc.markRunning("s-1");
    expect(h.sessionQb.where).toHaveBeenCalledWith(
      "id = :id AND status <> 'running' AND status NOT IN (:...terminal)",
      { id: "s-1", terminal: AGENT_TERMINAL_STATUSES },
    );
  });

  it("markWaiting：不设 finishedAt（非终态）", async () => {
    const h = harness();
    await h.svc.markWaiting("s-1", "clarification_reply");
    // R36：WHERE 带「非终态」——防止把已收敛的会话翻回 waiting_input
    expect(h.sessions.update).toHaveBeenCalledWith(
      expect.objectContaining({ id: "s-1", status: expect.anything() }),
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
    // R36：WHERE 必须带「非终态」前置条件——这才是幂等的实现方式（ADR-026）
    expect(h.sessions.update).toHaveBeenCalledWith(
      expect.objectContaining({ id: "s-1", status: expect.anything() }),
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
      expect.objectContaining({ id: "s-1", status: expect.anything() }),
      expect.objectContaining({ resultJson: { keep: 1 }, summary: "keep" }),
    );
  });
});

describe("AgentSessionService · 步骤与用量（同事务收敛）", () => {
  it("appendStep：seq = MAX+1，缺省字段归 0/null；用量与 step 同事务累加", async () => {
    resetRuntimeMetrics();
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

    // 观测审计 P1：令牌指标的增量必须是**令牌数**（12/34），不是步数（1/1）。
    // 此前它只是「有令牌的 LLM 步数」，成本对账会低 2~3 个数量级。
    const tokens = getRuntimeCountersSnapshot().get(
      "autoflow_agent_tokens_total",
    );
    expect(
      tokens?.get(
        JSON.stringify({
          provider: "qwen",
          model: "qwen-vl-max",
          direction: "in",
        }),
      ),
    ).toBe(12);
    expect(
      tokens?.get(
        JSON.stringify({
          provider: "qwen",
          model: "qwen-vl-max",
          direction: "out",
        }),
      ),
    ).toBe(34);
  });

  it("appendStep：tokens 缺省为 0（不记令牌指标分支）", async () => {
    const h = harness();
    const step = await h.svc.appendStep("s-1", { role: "user" });
    expect(step).toMatchObject({ tokensIn: 0, tokensOut: 0, latencyMs: 0 });
  });

  it("appendStep：字符串数字正常入库（Number 收敛），恶意串不破坏 SQL（B-4）", async () => {
    const h = harness();
    // 上游 usage 返回字符串数字——收敛后按数值拼接
    await h.svc.appendStep("s-1", {
      role: "assistant",
      tokensIn: "12" as unknown as number,
      tokensOut: "34" as unknown as number,
    });
    let setArg = h.emQb.set.mock.calls[0][0] as Record<string, () => string>;
    expect(setArg.totalTokensIn()).toBe('"totalTokensIn" + 12');
    expect(setArg.totalTokensOut()).toBe('"totalTokensOut" + 34');

    // 恶意串 / NaN / 负数 → 0，SQL 表达式不被注入
    for (const evil of ["1; DROP TABLE agent_sessions--", NaN, -5]) {
      const hi = harness();
      await hi.svc.appendStep("s-1", {
        role: "assistant",
        tokensIn: evil as unknown as number,
        tokensOut: evil as unknown as number,
      });
      setArg = hi.emQb.set.mock.calls[0][0] as Record<string, () => string>;
      expect(setArg.totalTokensIn()).toBe('"totalTokensIn" + 0');
      expect(setArg.totalTokensOut()).toBe('"totalTokensOut" + 0');
    }
  });

  it("safeTokenCount：收敛语义单测（有限正数保留，其余归 0）", () => {
    expect(safeTokenCount(7)).toBe(7);
    expect(safeTokenCount("42")).toBe(42);
    expect(safeTokenCount(0)).toBe(0);
    expect(safeTokenCount(undefined)).toBe(0);
    expect(safeTokenCount(null)).toBe(0);
    expect(safeTokenCount(-1)).toBe(0);
    expect(safeTokenCount(Number.POSITIVE_INFINITY)).toBe(0);
    expect(safeTokenCount("1; DROP TABLE agent_sessions--")).toBe(0);
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

// ── R36（ADR-026）：终态收敛的条件写 ──────────────────────────────────────
// 这一类缺陷在单线程测试里永远绿：先 findOne 看快照再 update({id}) 与「条件写」
// 在没有并发时行为完全相同。故这里直接驱动「条件未命中」的那条分支。
describe("AgentSessionService · finish/markWaiting 的并发收敛", () => {
  it("finish：条件写未命中（别人已收敛）→ 不再通知、不重复计数", async () => {
    const h = harness({ id: "s-1", status: "running", kind: "sop" });
    // 快照仍是非终态（所以能走到 update），但落库时条件未命中 = 并发方先赢
    (h.sessions.update as jest.Mock).mockResolvedValueOnce({ affected: 0 });

    await h.svc.finish("s-1", "succeeded", { summary: "late" });

    // 关键断言：输了竞争就**不能**发终态通知（否则用户收到两条「任务已完成」）
    expect(h.notify.sessionFinished).not.toHaveBeenCalled();
  });

  it("markWaiting：会话已终态时条件未命中 → 不把终态翻回 waiting_input", async () => {
    const h = harness({ id: "s-1", status: "running", kind: "sop" });
    (h.sessions.update as jest.Mock).mockResolvedValueOnce({ affected: 0 });
    await h.svc.markWaiting("s-1", "clarification_reply");
    // WHERE 里必须带非终态前置条件（否则终态可被翻回）
    const where = (h.sessions.update as jest.Mock).mock.calls[0][0] as Record<
      string,
      unknown
    >;
    expect(where.status).toBeDefined();
  });
});

describe("AgentSessionService · 陈旧 running 清扫（GAP-2）", () => {
  it("超阈 running → 条件写收敛 failed（errorMessage 指明可 resume）", async () => {
    const h = harness();
    (h.sessions.find as jest.Mock).mockResolvedValueOnce([
      { id: "stale-1" },
      { id: "stale-2" },
    ]);
    const swept = await h.svc.sweepStaleRunning(
      new Date("2026-10-29T00:00:00Z"),
    );
    expect(swept).toEqual(["stale-1", "stale-2"]);
    // find 只找 running 且 updatedAt 早于阈值（心跳语义：30 分钟无步进）
    const findArg = (h.sessions.find as jest.Mock).mock.calls[0][0] as {
      where: { status: string; updatedAt: { type: string; value: Date } };
      take: number;
    };
    expect(findArg.where.status).toBe("running");
    expect(findArg.where.updatedAt.type).toBe("lessThan");
    expect(findArg.take).toBeLessThanOrEqual(1000);
    // 收敛是**条件写**：WHERE 钉 status=running（与运行中 finish 竞态让位）
    const [where, patch] = (h.sessions.update as jest.Mock).mock.calls[0] as [
      Record<string, unknown>,
      Record<string, unknown>,
    ];
    expect(where).toMatchObject({ id: "stale-1", status: "running" });
    expect(patch.status).toBe("failed");
    expect(String(patch.errorMessage)).toContain("resume");
    expect(patch.finishedAt).toBeDefined();
    // RT-4：清理路径也要进告警体系（一条聚合，不是每会话一条）
    expect(h.notify.staleSweepConverged).toHaveBeenCalledTimes(1);
    expect(h.notify.staleSweepConverged).toHaveBeenCalledWith(
      ["stale-1", "stale-2"],
      30,
    );
  });

  it("RT-4：无陈旧 running 时不发通知", async () => {
    const h = harness();
    (h.sessions.find as jest.Mock).mockResolvedValueOnce([]);
    await h.svc.sweepStaleRunning();
    expect(h.notify.staleSweepConverged).not.toHaveBeenCalled();
  });

  it("无陈旧 running → 零更新调用", async () => {
    const h = harness();
    (h.sessions.find as jest.Mock).mockResolvedValueOnce([]);
    await h.svc.sweepStaleRunning();
    expect(h.sessions.update).not.toHaveBeenCalled();
  });

  it("cron 入口：非 Leader 跳过；Leader 正常执行；异常吞掉不炸", async () => {
    // 非 Leader：直接跳过（sweep 未被调用）
    const h1 = harness();
    (h1.sessions.find as jest.Mock).mockResolvedValue([]);
    const gated = new AgentSessionService(
      h1.sessions as never,
      h1.svc["steps"] as never,
      h1.svc["toolCalls"] as never,
      h1.svc["budgetService"] as never,
      h1.svc["notify"] as never,
      { isLeader: false } as never,
    );
    await gated.handleStaleRunningSweep();
    expect(h1.sessions.find).not.toHaveBeenCalled();

    // Leader：正常执行
    const h2 = harness();
    (h2.sessions.find as jest.Mock).mockResolvedValue([]);
    const leader = new AgentSessionService(
      h2.sessions as never,
      h2.svc["steps"] as never,
      h2.svc["toolCalls"] as never,
      h2.svc["budgetService"] as never,
      h2.svc["notify"] as never,
      { isLeader: true } as never,
    );
    await leader.handleStaleRunningSweep();
    expect(h2.sessions.find).toHaveBeenCalled();

    // gate 缺席（@Optional 单测装配）→ 门禁不生效；sweep 抛错被吞不炸
    const h3 = harness();
    (h3.sessions.find as jest.Mock).mockRejectedValueOnce(new Error("db down"));
    await expect(h3.svc.handleStaleRunningSweep()).resolves.toBeUndefined();
  });
});

/**
 * GAP-3 / GAP-6 的状态迁移原语。
 *
 * 两个方法都是「条件写」而非「读后写」：多副本同时判定时必须只有一个赢家，
 * 否则自动续跑会变成 N 次补跑、恢复会变成状态机倒退。
 */
describe("AgentSessionService · 自动续跑额度与重开（GAP-3/GAP-6）", () => {
  it("claimAutoResume：条件写 autoResumeCount < 1 且非终态，命中即赢", async () => {
    const h = harness();
    await expect(h.svc.claimAutoResume("s-1")).resolves.toBe(true);

    // 递增必须是 SQL 表达式（读后写会丢并发更新）
    const set = h.sessionQb.set.mock.calls[0][0] as Record<string, unknown>;
    expect(typeof set.autoResumeCount).toBe("function");
    expect(h.sessionQb.where).toHaveBeenCalledWith(
      'id = :id AND "autoResumeCount" < :limit AND status NOT IN (:...terminal)',
      { id: "s-1", limit: 1, terminal: [...AGENT_TERMINAL_STATUSES] },
    );
  });

  it("claimAutoResume：额度耗尽（affected=0）→ false，调用方按普通 failed 收敛", async () => {
    const h = harness();
    h.sessionQb.execute.mockResolvedValueOnce({ affected: 0 });
    await expect(h.svc.claimAutoResume("s-1")).resolves.toBe(false);
  });

  it("claimAutoResume：非法 max 回落 1（脏配置不能变成无限补跑）", async () => {
    const h = harness();
    await h.svc.claimAutoResume("s-1", 0);
    expect(h.sessionQb.where).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ limit: 1 }),
    );
  });

  it("reopenForResume：条件写重开 failed/budget_exceeded → pending，且上下文已被清理时拒绝（数据审计 #2）", async () => {
    const h = harness();
    await expect(h.svc.reopenForResume("s-1")).resolves.toBe(true);

    // RT-2：人工恢复给新的墙钟窗口（成本闸门仍累计）
    expect(h.sessionQb.set).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "pending",
        waitingFor: null,
        startedAt: expect.any(Date),
        finishedAt: null,
      }),
    );
    // 数据审计 #2：steps 已被保留期清理的会话不得重开（EXISTS 条件写
    // 同时消掉「检查→删除→重开」的竞态）
    expect(h.sessionQb.where).toHaveBeenCalledWith(
      "id = :id AND status IN (:...resumable)",
      { id: "s-1", resumable: ["failed", "budget_exceeded"] },
    );
    expect(h.sessionQb.andWhere).toHaveBeenCalledWith(
      expect.stringContaining("EXISTS"),
    );

    h.sessionQb.execute.mockResolvedValueOnce({ affected: 0 });
    await expect(h.svc.reopenForResume("s-1")).resolves.toBe(false);
  });
});

describe("AgentSessionService · 唤醒凭据（RT-3）", () => {
  it("带 expectWaitingFor 时 CAS 追加 waitingFor 谓词；不带时不追加", async () => {
    const h = harness();
    await h.svc.markRunning("s-1", "auto_resume");
    expect(h.sessionQb.andWhere).toHaveBeenCalledWith(
      '"waitingFor" IS NOT DISTINCT FROM :expect',
      { expect: "auto_resume" },
    );

    const plain = harness();
    await plain.svc.markRunning("s-1");
    expect(plain.sessionQb.andWhere).not.toHaveBeenCalled();
  });
});

/**
 * 数据审计 #1 / TOOLS-02：恢复语义与就地更新台账。
 */
describe("AgentSessionService · 恢复墙钟与台账就地更新", () => {
  it("从 waiting_input 恢复 → 写新 startedAt（等待时间不计入工作预算）", async () => {
    const h = harness({
      id: "s-1",
      status: "waiting_input",
      startedAt: new Date("2026-01-01T00:00:00Z"),
    });
    await h.svc.markRunning("s-1");
    expect(h.sessionQb.set).toHaveBeenCalledWith(
      expect.objectContaining({ startedAt: expect.any(Date) }),
    );

    // 非挂起态（pending / failed 重开后 pending）不重开窗口
    const plain = harness({
      id: "s-1",
      status: "pending",
      startedAt: new Date("2026-01-01T00:00:00Z"),
    });
    await plain.svc.markRunning("s-1");
    expect(plain.sessionQb.set).toHaveBeenCalledWith({
      status: "running",
      waitingFor: null,
    });
  });

  it("updateToolCallByToolCallId：按 (sessionId, toolCallId) 就地更新，不重复累加工具计数", async () => {
    const h = harness();
    await expect(
      h.svc.updateToolCallByToolCallId("s-1", "c1", {
        toolName: "get_task",
        tier: "read",
        status: "ok",
        result: { ok: true },
      }),
    ).resolves.toBe(true);

    expect(h.toolCalls.update).toHaveBeenCalledWith(
      { sessionId: "s-1", toolCallId: "c1" },
      expect.objectContaining({ status: "ok", resultJson: { ok: true } }),
    );
    // 挂起时那一行已经计过一次；就地更新不能再自增 totalToolCalls
    expect(h.sessionQb.set).not.toHaveBeenCalled();

    (h.toolCalls.update as jest.Mock).mockResolvedValueOnce({ affected: 0 });
    await expect(
      h.svc.updateToolCallByToolCallId("s-1", "c1", {
        toolName: "get_task",
        tier: "read",
        status: "ok",
      }),
    ).resolves.toBe(false);
  });
});

/**
 * 数据审计 #3：appendStep 的 seq 冲突重试。
 *
 * 注释承诺「唯一约束会让后者失败并重试」，实现此前没有重试——23505 逃出
 * run() 后被 processor 吞掉，会话停在 running 直到 30 分钟清扫，且被误报
 * 成「进程崩溃」。并发来源真实存在（清扫判死 → 人工 resume → 旧 worker
 * 的慢工具批刚好结束继续写 step）。
 */
describe("AgentSessionService · appendStep 序列冲突重试（数据审计 #3）", () => {
  it("23505 → 重算 MAX(seq) 重试并成功（不会冒出异常）", async () => {
    const h = harness();
    const tx = (h.sessions.manager as { transaction: jest.Mock }).transaction;
    tx.mockRejectedValueOnce(
      Object.assign(new Error("dup"), { code: "23505" }),
    );

    const step = await h.svc.appendStep("s-1", { role: "assistant" });

    expect(step).toMatchObject({ role: "assistant" });
    expect(tx).toHaveBeenCalledTimes(2);
  });

  it("重试耗尽 → 抛错（由 run() 的兜底收敛为 failed，而不是永久 running）", async () => {
    const h = harness();
    const tx = (h.sessions.manager as { transaction: jest.Mock }).transaction;
    tx.mockRejectedValue(Object.assign(new Error("dup"), { code: "23505" }));

    await expect(
      h.svc.appendStep("s-1", { role: "assistant" }),
    ).rejects.toThrow("dup");
    expect(tx).toHaveBeenCalledTimes(3);
  });

  it("非唯一冲突错误不重试（避免把死锁/连接错误变成挂起）", async () => {
    const h = harness();
    const tx = (h.sessions.manager as { transaction: jest.Mock }).transaction;
    tx.mockRejectedValueOnce(new Error("connection reset"));

    await expect(
      h.svc.appendStep("s-1", { role: "assistant" }),
    ).rejects.toThrow("connection reset");
    expect(tx).toHaveBeenCalledTimes(1);
  });
});
