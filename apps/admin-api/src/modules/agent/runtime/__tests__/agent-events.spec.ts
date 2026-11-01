import { ConfigService } from "@nestjs/config";

import {
  AGENT_EVENT_BATCH_MAX,
  AgentSessionService,
  EventBatchRejectedError,
  EventSeqContiguityError,
} from "../agent-session.service";
import { AgentSessionRetentionService } from "../../agent-session-retention.service";
import type { AgentEventInput } from "../../entities/agent-event.entity";

/**
 * S7-G1（第一阶段：只写不读）：取证型事件日志的写入面。
 *
 * 这一组用例钉住四件**只能靠实现证伪**的事：
 *  ① `seq` 的分配是**一条语句**（`MAX(seq)` 与 `INSERT` 同语句）且同批连续——
 *     换个实现（先 SELECT 再 INSERT）在单线程下同样绿，只有断言 SQL 形态能抓住；
 *  ② 并发两次 append **不会写出重复 seq**：输的一方拿 23505 → 重算重试；
 *  ③ 超批量上限**整批拒**（一行都不写），不许部分写入；
 *  ④ 事件写入失败**不打断主链**（旁路）：appendStep 照常返回。
 *
 * 以及保留期：`agent_events` 必须被 B-10 的 cron 覆盖（否则就是一张永不清理的
 * 新表），且只清**终态会话**的超期事件。
 */

type Any = Record<string, any>;

/** TypeORM 链式桩（select/where/... 全部返回自身，便于链式调用）。 */
function qbStub(result: Any = { affected: 1 }, raw: Any = { maxSeq: 0 }) {
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
  qb.getRawOne = jest.fn(async () => raw);
  qb.getRawMany = jest.fn(async () => []);
  qb.execute = jest.fn(async () => result);
  return qb;
}

/**
 * 装配 `AgentSessionService`（只提供本组用例触达的依赖）。
 *
 * `eventQuery` 是 `manager.query(...)` 的桩——它就是 `appendEvents` 的那条
 * 单语句（取基址 + 连续分配 + 插入），返回 `RETURNING "seq"` 的行。
 */
function makeHarness(
  options: {
    eventQuery?: jest.Mock;
    tx?: (cb: (em: Any) => Promise<unknown>) => Promise<unknown>;
  } = {},
) {
  const emQb = qbStub();
  const em: Any = {
    createQueryBuilder: jest.fn(() => emQb),
    create: jest.fn((_cls: unknown, v: Any) => ({ id: "step-1", ...v })),
    save: jest.fn(async (v: Any) => v),
    findOne: jest.fn(async () => null),
    query: options.eventQuery ?? jest.fn(async () => [{ seq: 1 }]),
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
      transaction: jest.fn(
        options.tx ?? (async (cb: (em: Any) => Promise<unknown>) => cb(em)),
      ),
    },
  };
  const toolCalls: Any = {
    create: jest.fn((v: Any) => ({ id: "tc-1", ...v })),
    save: jest.fn(async (v: Any) => v),
    update: jest.fn(async () => ({ affected: 1 })),
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
  );
  return { svc, sessions, em, emQb, toolCalls };
}

describe("S7-G1 · agent_events · seq 分配与不变量", () => {
  it("① 单条 append：一条语句完成「取基址 + 分配 + 插入」，落一行、seq 连续", async () => {
    const eventQuery = jest.fn(async () => [{ seq: 7 }]);
    const h = makeHarness({ eventQuery });

    const out = await h.svc.appendEvents("s-1", [
      { kind: "step_appended", payload: { stepSeq: 7 } },
    ]);

    expect(out).toEqual({ firstSeq: 7, seqs: [7] });
    expect(eventQuery).toHaveBeenCalledTimes(1);

    // 判据是**语句形态**（换实现即红）：基址与插入在同一条 SQL 里
    const [sql, params] = eventQuery.mock.calls[0] as unknown as [
      string,
      unknown[],
    ];
    expect(sql).toContain("WITH base AS");
    expect(sql).toContain('COALESCE(MAX("seq"), 0)');
    expect(sql).toContain('INSERT INTO "agent_events"');
    expect(sql).toContain("WITH ORDINALITY");
    // 一次往返里完成分配 ⇒ 没有「读 N、两个 writer 都写 N+1」的窗口
    expect(sql.match(/INSERT INTO/g)).toHaveLength(1);
    // 参数只带会话 id 与整批事件（没有外部传入的 seq）
    expect(params[0]).toBe("s-1");
    expect(JSON.parse(String(params[1]))).toEqual([
      { kind: "step_appended", payload: { stepSeq: 7 } },
    ]);
  });

  it("① 多事件同批：seq 由 ORDINALITY 连续分配，整批要么全成要么全不成", async () => {
    const eventQuery = jest.fn(async () => [
      { seq: 12 },
      { seq: 13 },
      { seq: 14 },
    ]);
    const h = makeHarness({ eventQuery });

    const out = await h.svc.appendEvents("s-1", [
      { kind: "tool_call_recorded", payload: { status: "in_flight" } },
      { kind: "tool_call_status_changed", payload: { status: "ok" } },
      { kind: "step_appended", payload: { stepSeq: 3 } },
    ]);

    expect(out.seqs).toEqual([12, 13, 14]);
    expect(eventQuery).toHaveBeenCalledTimes(1); // 一条语句 = 一个原子批次
  });

  it("② 并发撞 seq：输的一方拿到 23505 后重算重试，最终不撞唯一约束", async () => {
    // 第一次插入与另一个 writer 撞在同一个 seq（PG 23505），重试时基址已含对方
    const conflict = Object.assign(new Error("duplicate key"), {
      code: "23505",
    });
    const eventQuery = jest
      .fn()
      .mockRejectedValueOnce(conflict)
      .mockResolvedValueOnce([{ seq: 2 }]);
    const h = makeHarness({ eventQuery });

    const out = await h.svc.appendEvents("s-1", [
      { kind: "prompt_fingerprint", payload: { fingerprint: "sha256:x" } },
    ]);

    expect(out).toEqual({ firstSeq: 2, seqs: [2] });
    expect(eventQuery).toHaveBeenCalledTimes(2); // 重试过一次，不是静默丢弃
  });

  it("② 一直撞（模拟持续竞争）：重试上限后如实抛出，由旁路包装降级为 warn", async () => {
    const conflict = Object.assign(new Error("duplicate key"), {
      code: "23505",
    });
    const eventQuery = jest.fn().mockRejectedValue(conflict);
    const h = makeHarness({ eventQuery });

    await expect(
      h.svc.appendEvents("s-1", [{ kind: "step_appended" }]),
    ).rejects.toBe(conflict);
    expect(eventQuery).toHaveBeenCalledTimes(3); // APPEND_EVENT_MAX_RETRIES

    // 旁路入口：永不抛出，返回 null（fail-open + warn）
    const seq = await h.svc.tryAppendEvent("s-1", { kind: "step_appended" });
    expect(seq).toBeNull();
  });

  it("② 批量超上限：整批拒，一行都不写（不做部分写入）", async () => {
    const eventQuery = jest.fn(async () => [{ seq: 1 }]);
    const h = makeHarness({ eventQuery });
    const batch: AgentEventInput[] = Array.from(
      { length: AGENT_EVENT_BATCH_MAX + 1 },
      () => ({ kind: "step_appended" as const }),
    );

    await expect(h.svc.appendEvents("s-1", batch)).rejects.toBeInstanceOf(
      EventBatchRejectedError,
    );
    expect(eventQuery).not.toHaveBeenCalled();
  });

  it("② 插入后连续性断言：seq 不连续 ⇒ 抛错并回滚（整批不落）", async () => {
    // 真实实现不可能出现；这里强制伪造「跳号」，证明断言真的有牙（不是注释）
    const eventQuery = jest.fn(async () => [{ seq: 1 }, { seq: 3 }]);
    const h = makeHarness({ eventQuery });

    await expect(
      h.svc.appendEvents("s-1", [
        { kind: "step_appended" },
        { kind: "tool_call_recorded" },
      ]),
    ).rejects.toBeInstanceOf(EventSeqContiguityError);
  });

  it("④ 旁路纪律：事件写入失败时 appendStep 仍然成功（主链不受影响）", async () => {
    let tx = 0;
    const h = makeHarness({
      tx: async (cb) => {
        tx += 1;
        // 第 1 个事务 = step 写入（必须成功）；第 2 个 = 事件写入（模拟 DB 故障）
        if (tx === 1) return cb(h.em);
        throw new Error("agent_events unavailable");
      },
    });

    const step = await h.svc.appendStep("s-1", {
      role: "assistant",
      content: "结论",
      tokensIn: 3,
      tokensOut: 2,
    });

    expect(step).toMatchObject({ role: "assistant", seq: 1 });
    expect(tx).toBe(2); // 事件确实被尝试过（不是根本没接线）
  });

  it("④ 工具台账与状态迁移也走旁路：台账写成功时事件写失败不影响台账行", async () => {
    let tx = 0;
    const h = makeHarness({
      tx: async (cb) => {
        tx += 1;
        // 第 1 次 = step 事务（成功）；之后任何事务 = 事件写入（模拟 DB 故障）
        if (tx === 1) return cb(h.em);
        throw new Error("agent_events unavailable");
      },
    });

    const row = await h.svc.recordToolCall({
      sessionId: "s-1",
      toolCallId: "call-1",
      toolName: "get_task",
      tier: "read",
      status: "in_flight",
    });

    expect(row).toMatchObject({ toolCallId: "call-1", status: "in_flight" });
  });
});

describe("S7-G1 · agent_events · 保留期（B-10 同一 cron）", () => {
  const DAY = 86_400_000;
  const NOW = new Date("2026-11-01T00:00:00.000Z");

  /** 每次 createQueryBuilder("s") 依次返回一页终态会话 id。 */
  function sessionsWithPages(pages: string[][]) {
    const queue = [...pages];
    return {
      createQueryBuilder: jest.fn(() => {
        const qb = qbStub();
        qb.getRawMany = jest.fn(async () =>
          (queue.shift() ?? []).map((id) => ({ id })),
        );
        return qb;
      }),
    };
  }

  function deleteQb(affected = 4) {
    const calls: Array<{ sql: string; params: Any }> = [];
    const chain: Any = {
      calls,
      delete: jest.fn(() => chain),
      where: jest.fn((sql: string, params: Any) => {
        calls.push({ sql, params });
        return chain;
      }),
      andWhere: jest.fn((sql: string, params: Any) => {
        calls.push({ sql, params });
        return chain;
      }),
      execute: jest.fn(async () => ({ affected })),
    };
    return chain;
  }

  function makeRetention(eventsDelete = deleteQb()) {
    const sessions = sessionsWithPages([["s-done"]]);
    const svc = new AgentSessionRetentionService(
      null,
      sessions as never,
      { createQueryBuilder: jest.fn(() => deleteQb()) } as never,
      { createQueryBuilder: jest.fn(() => deleteQb()) } as never,
      { createQueryBuilder: jest.fn(() => deleteQb()) } as never,
      { get: jest.fn(() => undefined) } as unknown as ConfigService,
      { createQueryBuilder: jest.fn(() => eventsDelete) } as never,
    );
    return { svc, eventsDelete, sessions };
  }

  it("⑤ 只清「终态会话 + 超 180 天」的事件，且带终态复查（防 reopen 竞态）", async () => {
    const { svc, eventsDelete } = makeRetention();

    const deleted = await svc.cleanupExpiredEvents(NOW);

    expect(deleted).toBe(4);
    const whereClause = eventsDelete.calls[0];
    expect(whereClause.sql).toContain("sessionId IN (:...ids)");
    expect(whereClause.params.ids).toEqual(["s-done"]);
    const cutoff = eventsDelete.calls.find((c) =>
      c.sql.includes("createdAt < :cutoff"),
    )!;
    expect((cutoff.params.cutoff as Date).getTime()).toBe(
      NOW.getTime() - 180 * DAY,
    );
    // 取页与删除之间会话可能被 reopenForResume 重开：必须复查一次状态
    const guard = eventsDelete.calls.find((c) =>
      c.sql.includes('FROM "agent_sessions"'),
    )!;
    expect(guard.sql).toContain('"agent_events"."sessionId"');
    expect(guard.params.eventTerminal).toEqual([
      "succeeded",
      "failed",
      "aborted",
      "budget_exceeded",
    ]);
  });

  it("⑤ 清理真的接在 B-10 的 cron 上（否则就是一张永不清理的新表）", async () => {
    const { svc } = makeRetention();
    const spy = jest.spyOn(svc, "cleanupExpiredEvents");

    await svc.handleDailyCleanup();

    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("⑤ 未注入事件仓储（老装配点直接 new）时返回 0，不炸掉整轮清理", async () => {
    const svc = new AgentSessionRetentionService(
      null,
      sessionsWithPages([[]]) as never,
      { createQueryBuilder: jest.fn(() => deleteQb()) } as never,
      { createQueryBuilder: jest.fn(() => deleteQb()) } as never,
      { createQueryBuilder: jest.fn(() => deleteQb()) } as never,
      { get: jest.fn(() => undefined) } as unknown as ConfigService,
    );

    await expect(svc.cleanupExpiredEvents(NOW)).resolves.toBe(0);
  });
});
