import { ConfigService } from "@nestjs/config";

import {
  AgentSessionRetentionService,
  AGENT_STEP_RETENTION_DEFAULT_DAYS,
  AGENT_TOOL_CALL_READ_RETENTION_DEFAULT_DAYS,
  AGENT_TOOL_CALL_WRITE_RETENTION_DEFAULT_DAYS,
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

function harness(opts?: {
  sessions?: Array<{ id: string; status: string }>;
  configValues?: Record<string, unknown>;
  stepAffected?: number;
  toolCallAffected?: number;
}) {
  const sessions = {
    // find 尊重 where.status 的 In(...) 语义（FindOperator.value 是白名单）
    find: jest.fn(
      async (q?: { where?: { status?: { value?: readonly string[] } } }) => {
        const allowed = q?.where?.status?.value;
        const rows = opts?.sessions ?? [];
        return Array.isArray(allowed)
          ? rows.filter((r) => allowed.includes(r.status))
          : rows;
      },
    ),
  };
  const stepQb = deleteQb(opts?.stepAffected ?? 3);
  const toolCallQb = deleteQb(opts?.toolCallAffected ?? 5);
  const steps = { createQueryBuilder: jest.fn(() => stepQb) };
  const toolCalls = { createQueryBuilder: jest.fn(() => toolCallQb) };
  const config = {
    get: jest.fn((key: string) => opts?.configValues?.[key]),
  };
  const svc = new AgentSessionRetentionService(
    null,
    sessions as never,
    steps as never,
    toolCalls as never,
    config as unknown as ConfigService,
  );
  return { svc, sessions, steps, toolCalls, stepQb, toolCallQb, config };
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
    expect(h.sessions.find).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { status: expect.anything() },
      }),
    );
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
  });
});

describe("AgentSessionRetentionService · tool_calls 按 tier（B-10）", () => {
  it("read 30 天 / write+dangerous 180 天（与审计保留期对齐）", async () => {
    const h = harness();
    await h.svc.cleanupExpiredRows(NOW);

    const read = h.toolCallQb.calls[0];
    expect(read.sql).toContain("tier IN (:...tiers)");
    expect(read.params.tiers).toEqual(["read"]);
    const readCutoff = h.toolCallQb.calls[1];
    expect((readCutoff.params.cutoff as Date).getTime()).toBe(
      NOW.getTime() - AGENT_TOOL_CALL_READ_RETENTION_DEFAULT_DAYS * DAY,
    );

    const write = h.toolCallQb.calls[2];
    expect(write.params.tiers).toEqual(["write", "dangerous"]);
    const writeCutoff = h.toolCallQb.calls[3];
    expect((writeCutoff.params.cutoff as Date).getTime()).toBe(
      NOW.getTime() - AGENT_TOOL_CALL_WRITE_RETENTION_DEFAULT_DAYS * DAY,
    );
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
    const stepCutoff = h.stepQb.calls[1].params.cutoff as Date;
    expect(stepCutoff.getTime()).toBe(NOW.getTime() - 30 * DAY);
    const readCutoff = h.toolCallQb.calls[1].params.cutoff as Date;
    expect(readCutoff.getTime()).toBe(NOW.getTime() - 7 * DAY);
    const writeCutoff = h.toolCallQb.calls[3].params.cutoff as Date;
    expect(writeCutoff.getTime()).toBe(
      NOW.getTime() - AGENT_TOOL_CALL_WRITE_RETENTION_DEFAULT_DAYS * DAY,
    );
  });
});

describe("AgentSessionRetentionService · cron 门禁与容错（B-10）", () => {
  it("删除行数如实返回（steps + toolCalls 分计；toolCalls 为两档 tier 批次之和）", async () => {
    const h = harness({
      sessions: [{ id: "s-done", status: "failed" }],
      stepAffected: 2,
      toolCallAffected: 9,
    });
    await expect(h.svc.cleanupExpiredRows(NOW)).resolves.toEqual({
      steps: 2,
      toolCalls: 18, // read 批次 9 + write/dangerous 批次 9
    });
  });

  it("LeaderGate 非 leader 时整轮跳过（多实例不重复删）", async () => {
    const sessions = { find: jest.fn(async () => []) };
    const stepQb = deleteQb();
    const toolCallQb = deleteQb();
    const svc = new AgentSessionRetentionService(
      { isLeader: false } as never,
      sessions as never,
      { createQueryBuilder: () => stepQb } as never,
      { createQueryBuilder: () => toolCallQb } as never,
      { get: () => undefined } as unknown as ConfigService,
    );
    await svc.handleDailyCleanup();
    expect(sessions.find).not.toHaveBeenCalled();
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
