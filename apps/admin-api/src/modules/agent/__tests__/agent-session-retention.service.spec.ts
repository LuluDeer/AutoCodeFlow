import { ConfigService } from "@nestjs/config";

import {
  AgentSessionRetentionService,
  AGENT_RETENTION_SCAN_BATCH,
  AGENT_STEP_RETENTION_DEFAULT_DAYS,
  AGENT_TOOL_CALL_READ_RETENTION_DEFAULT_DAYS,
  AGENT_TOOL_CALL_WRITE_RETENTION_DEFAULT_DAYS,
  AGENT_APPROVAL_RETENTION_DEFAULT_DAYS,
} from "../agent-session-retention.service";

/** delete qb 链桩：捕获 where/andWhere 参数，execute 返回受控 affected。 */
function deleteQb(affected = 3) {
  const calls: Array<{ sql: string; params: Record<string, unknown> }> = [];
  const chain = {
    calls,
    delete: jest.fn().mockReturnThis(),
    where: jest.fn((sql: string, params: Record<string, unknown>) => {
      calls.push({ sql, params });
      return chain;
    }),
    andWhere: jest.fn((sql: string, params: Record<string, unknown>) => {
      calls.push({ sql, params });
      return chain;
    }),
    execute: jest.fn(async () => ({ affected })),
  };
  return chain;
}

/** select qb 桩：捕获 where/andWhere/orderBy/limit，getRawMany 返回受控行。 */
function selectQb(rows: string[]) {
  const calls: Array<{ sql: string; params: Record<string, unknown> }> = [];
  const chain: Record<string, unknown> = {
    calls,
    select: jest.fn().mockReturnThis(),
    where: jest.fn((sql: string, params: Record<string, unknown>) => {
      calls.push({ sql, params });
      return chain;
    }),
    andWhere: jest.fn((sql: string, params: Record<string, unknown>) => {
      calls.push({ sql, params });
      return chain;
    }),
    orderBy: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    getRawMany: jest.fn(async () => rows.map((id) => ({ id }))),
  };
  return chain;
}

function harness(opts?: {
  sessions?: Array<{ id: string; status: string }>;
  /** 分页页表：每页 id（keyset 游标依次消耗）；缺省 = 单页全部终态 id。 */
  terminalPages?: string[][];
  configValues?: Record<string, unknown>;
  stepAffected?: number;
  toolCallAffected?: number;
  approvalAffected?: number;
}) {
  const terminalStatuses = [
    "succeeded",
    "failed",
    "aborted",
    "budget_exceeded",
  ];
  const sessions = {
    createQueryBuilder: jest.fn(() => {
      const page =
        opts?.terminalPages ??
        [
          (opts?.sessions ?? [])
            .filter((r) => terminalStatuses.includes(r.status))
            .map((r) => r.id),
        ].filter((p) => p.length > 0);
      return selectQb(page.shift() ?? []);
    }),
  };
  const stepQb = deleteQb(opts?.stepAffected ?? 3);
  const toolCallQb = deleteQb(opts?.toolCallAffected ?? 5);
  const approvalQb = deleteQb(opts?.approvalAffected ?? 2);
  const steps = { createQueryBuilder: jest.fn(() => stepQb) };
  const toolCalls = { createQueryBuilder: jest.fn(() => toolCallQb) };
  const approvals = { createQueryBuilder: jest.fn(() => approvalQb) };
  const config = {
    get: jest.fn((key: string) => opts?.configValues?.[key]),
  };
  const svc = new AgentSessionRetentionService(
    null,
    sessions as never,
    steps as never,
    toolCalls as never,
    approvals as never,
    config as unknown as ConfigService,
  );
  return {
    svc,
    sessions,
    steps,
    toolCalls,
    approvals,
    stepQb,
    toolCallQb,
    approvalQb,
    config,
  };
}

const DAY = 86_400_000;
const NOW = new Date("2026-10-02T00:00:00.000Z");

describe("AgentSessionRetentionService · steps（B-10）", () => {
  it("只扫终态会话的 steps：非终态（pending/running/waiting_input）不入 IN 列表", async () => {
    const h = harness({
      sessions: [
        { id: "s-done", status: "succeeded" },
        { id: "s-fail", status: "failed" },
        { id: "s-abort", status: "aborted" },
        { id: "s-budget", status: "budget_exceeded" },
        { id: "s-run", status: "running" },
        { id: "s-wait", status: "waiting_input" },
        { id: "s-pending", status: "pending" },
      ],
    });
    await h.svc.cleanupExpiredRows(NOW);
    const where = h.stepQb.calls[0];
    expect(where.sql).toContain("sessionId IN (:...ids)");
    // 终态集合完整、非终态一个都不在
    for (const id of ["s-done", "s-fail", "s-abort", "s-budget"]) {
      expect(where.params.ids).toContain(id);
    }
    for (const id of ["s-run", "s-wait", "s-pending"]) {
      expect(where.params.ids).not.toContain(id);
    }
    // keyset 扫描：只查终态集合、按 id 升序分页
    const scan = h.sessions.createQueryBuilder.mock.results[0].value;
    expect(scan.calls[0].sql).toContain("s.status IN (:...statuses)");
    expect(scan.calls[0].params.statuses).not.toContain("running");
    expect(scan.calls[0].params.statuses).not.toContain("pending");
    expect(scan.calls[0].params.statuses).not.toContain("waiting_input");
    expect(scan.where).not.toHaveBeenCalledWith(
      expect.stringContaining("s.id >"),
      expect.anything(),
    ); // 首页无游标
  });

  it("keyset 分页：游标逐页推进、页间不重不漏、尾批不满即停", async () => {
    const B = AGENT_RETENTION_SCAN_BATCH;
    const page = (n: number, prefix: string): string[] =>
      Array.from({ length: n }, (_, i) => `${prefix}-${i}`);
    const h = harness({
      terminalPages: [
        page(B, "a"), // 满批 → 继续
        page(B, "b"), // 满批 → 继续
        page(3, "c"), // 尾批不满 → 终止
      ],
    });
    const result = await h.svc.cleanupExpiredRows(NOW);
    // 前两页各切 2 个 DELETE_CHUNK（B/500），尾页 1 次 → 5 次 IN 删除
    const stepCalls = h.stepQb.calls.filter((c) =>
      c.sql.includes("sessionId IN (:...ids)"),
    );
    expect(stepCalls).toHaveLength(5);
    // 第 2/3 页查询带游标：s.id > 上一页最大 id
    const secondScan = h.sessions.createQueryBuilder.mock.results[1].value;
    expect(
      secondScan.calls.find((c: { sql: string }) => c.sql.includes("s.id >"))
        .params.afterId,
    ).toBe(`a-${B - 1}`);
    const thirdScan = h.sessions.createQueryBuilder.mock.results[2].value;
    expect(
      thirdScan.calls.find((c: { sql: string }) => c.sql.includes("s.id >"))
        .params.afterId,
    ).toBe(`b-${B - 1}`);
    // 第 3 页后终止：只有 3 次 select 扫描
    expect(h.sessions.createQueryBuilder).toHaveBeenCalledTimes(3);
    // 删除计数跨页累计（steps 5 次 × 3；approvals 5 次 × 2——替身默认值不同）
    expect(result.steps).toBe(15);
    expect(result.approvals).toBe(10);
    // tool_calls 与会话无关，恒 2 次 tier 批次
    expect(
      h.toolCallQb.calls.filter((c) => c.sql.includes("tier IN")),
    ).toHaveLength(2);
  });

  it("默认保留 90 天：cutoff = now - 90d，超界删除、边界内保留", async () => {
    const h = harness({
      sessions: [{ id: "s-done", status: "succeeded" }],
    });
    await h.svc.cleanupExpiredRows(NOW);
    const where = h.stepQb.calls[1];
    expect(where.sql).toContain("createdAt < :cutoff");
    expect((where.params.cutoff as Date).getTime()).toBe(
      NOW.getTime() - AGENT_STEP_RETENTION_DEFAULT_DAYS * DAY,
    );
  });

  it("无终态会话时不发 steps 删除语句", async () => {
    const h = harness({
      sessions: [{ id: "s-run", status: "running" }],
    });
    await h.svc.cleanupExpiredRows(NOW);
    expect(h.stepQb.execute).not.toHaveBeenCalled();
    expect(h.approvalQb.execute).not.toHaveBeenCalled();
  });
});

describe("AgentSessionRetentionService · tool_calls 按 tier（B-10）", () => {
  it("read 30 天 / write+dangerous 180 天（与审计保留期对齐）", async () => {
    const h = harness();
    await h.svc.cleanupExpiredRows(NOW);

    const tierCalls = h.toolCallQb.calls.filter((c) => c.params.tiers);
    const read = tierCalls.find((c) =>
      (c.params.tiers as string[]).includes("read"),
    );
    const write = tierCalls.find((c) =>
      (c.params.tiers as string[]).includes("write"),
    );
    expect(read?.params.tiers).toEqual(["read"]);
    expect(write?.params.tiers).toEqual(["write", "dangerous"]);

    const cutoffs = h.toolCallQb.calls
      .map((c) => c.params.cutoff)
      .filter((c): c is Date => c instanceof Date);
    expect(cutoffs.map((c) => c.getTime())).toEqual(
      expect.arrayContaining([
        NOW.getTime() - AGENT_TOOL_CALL_READ_RETENTION_DEFAULT_DAYS * DAY,
        NOW.getTime() - AGENT_TOOL_CALL_WRITE_RETENTION_DEFAULT_DAYS * DAY,
      ]),
    );

    // 数据审计 #4：read 档必须只清**终态会话**的行（此前完全不看会话状态，
    // 活会话的 read 结果 30 天被删、重放退化成「工具结果缺失」）；
    // write/dangerous 是审计面，不做该限制。
    const guards = h.toolCallQb.calls.filter((c) =>
      c.sql.includes("status NOT IN"),
    );
    expect(guards).toHaveLength(1);
    expect(guards[0].sql).toContain('"agent_tool_calls"."sessionId"');
  });

  it("环境变量可覆盖（非法值回落默认）", async () => {
    const h = harness({
      sessions: [{ id: "s-done", status: "succeeded" }],
      configValues: {
        AGENT_STEP_RETENTION_DAYS: "30",
        AGENT_TOOL_CALL_READ_RETENTION_DAYS: "7",
        AGENT_TOOL_CALL_WRITE_RETENTION_DAYS: "abc", // 非法 → 默认 180
      },
    });
    await h.svc.cleanupExpiredRows(NOW);
    const stepCutoff = h.stepQb.calls
      .map((c) => c.params.cutoff)
      .find((c): c is Date => c instanceof Date) as Date;
    expect(stepCutoff.getTime()).toBe(NOW.getTime() - 30 * DAY);
    const toolCutoffs = h.toolCallQb.calls
      .map((c) => c.params.cutoff)
      .filter((c): c is Date => c instanceof Date)
      .map((c) => c.getTime());
    expect(toolCutoffs).toContain(NOW.getTime() - 7 * DAY);
    expect(toolCutoffs).toContain(
      NOW.getTime() - AGENT_TOOL_CALL_WRITE_RETENTION_DEFAULT_DAYS * DAY,
    );
  });
});

describe("AgentSessionRetentionService · cron 门禁与容错（B-10）", () => {
  it("删除行数如实返回（steps / toolCalls / approvals 分计；toolCalls 为两档 tier 批次之和）", async () => {
    const h = harness({
      sessions: [{ id: "s-done", status: "failed" }],
      stepAffected: 2,
      toolCallAffected: 9,
      approvalAffected: 4,
    });
    await expect(h.svc.cleanupExpiredRows(NOW)).resolves.toEqual({
      steps: 2,
      toolCalls: 18, // read 批次 9 + write/dangerous 批次 9
      approvals: 4,
    });
  });

  // ── 实施轮 #15：审批单也有保留期（此前只清 steps/tool_calls，agent_approvals
  // 只增不减；且台账行被清后审批单成孤儿——无 FK，没人会再删它） ──
  it("审批单：只删「已处置 + 会话终态 + 超 180 天」，pending 永不进删除条件", async () => {
    const h = harness({
      sessions: [
        { id: "s-done", status: "succeeded" },
        { id: "s-run", status: "running" },
      ],
    });
    await h.svc.cleanupExpiredRows(NOW);
    const q = h.approvalQb.calls;
    const where = q.find((c) => c.sql.includes("sessionId IN (:...ids)"))!;
    expect(where.params.ids).toEqual(["s-done"]); // 非终态会话的审批单不动
    const status = q.find((c) => c.sql.includes("status IN (:...statuses)"))!;
    expect(status.params.statuses).toEqual(["granted", "consumed", "denied"]);
    expect(status.params.statuses).not.toContain("pending");
    const cutoff = q.find((c) => c.sql.includes("createdAt < :cutoff"))!;
    expect((cutoff.params.cutoff as Date).getTime()).toBe(
      NOW.getTime() - AGENT_APPROVAL_RETENTION_DEFAULT_DAYS * DAY,
    );
  });

  it("审批单保留期可被 AGENT_APPROVAL_RETENTION_DAYS 覆盖（非法值回落默认）", async () => {
    const overridden = harness({
      sessions: [{ id: "s-done", status: "succeeded" }],
      configValues: { AGENT_APPROVAL_RETENTION_DAYS: "30" },
    });
    await overridden.svc.cleanupExpiredRows(NOW);
    expect(
      (
        overridden.approvalQb.calls.find((c) =>
          c.sql.includes("createdAt < :cutoff"),
        )!.params.cutoff as Date
      ).getTime(),
    ).toBe(NOW.getTime() - 30 * DAY);

    const junk = harness({
      sessions: [{ id: "s-done", status: "succeeded" }],
      configValues: { AGENT_APPROVAL_RETENTION_DAYS: "abc" },
    });
    await junk.svc.cleanupExpiredRows(NOW);
    expect(
      (
        junk.approvalQb.calls.find((c) =>
          c.sql.includes("createdAt < :cutoff"),
        )!.params.cutoff as Date
      ).getTime(),
    ).toBe(NOW.getTime() - AGENT_APPROVAL_RETENTION_DEFAULT_DAYS * DAY);
  });

  it("LeaderGate 非 leader 时整轮跳过（多实例不重复删）", async () => {
    const sessions = { createQueryBuilder: jest.fn(() => selectQb([])) };
    const stepQb = deleteQb();
    const toolCallQb = deleteQb();
    const approvalQb = deleteQb();
    const svc = new AgentSessionRetentionService(
      { isLeader: false } as never,
      sessions as never,
      { createQueryBuilder: () => stepQb } as never,
      { createQueryBuilder: () => toolCallQb } as never,
      { createQueryBuilder: () => approvalQb } as never,
      { get: () => undefined } as unknown as ConfigService,
    );
    await svc.handleDailyCleanup();
    expect(sessions.createQueryBuilder).not.toHaveBeenCalled();
    expect(stepQb.execute).not.toHaveBeenCalled();
  });

  it("leader 缺席（@Optional 单测装配）时门禁不生效，正常执行", async () => {
    const h = harness({
      sessions: [{ id: "s-done", status: "succeeded" }],
    });
    await h.svc.handleDailyCleanup();
    expect(h.stepQb.execute).toHaveBeenCalled();
  });
});
