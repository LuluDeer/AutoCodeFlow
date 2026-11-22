import {
  FUNNEL_EVENT_RETENTION_DAYS,
  FunnelEventsRetentionService,
} from "../funnel-events-retention.service";

type Call = { sql: string; params: Record<string, unknown> };
type Row = { id: string; createdAt: Date };

const DAY = 86_400_000;
const NOW = new Date("2026-10-02T00:00:00.000Z");
const CUTOFF = new Date(NOW.getTime() - FUNNEL_EVENT_RETENTION_DAYS * DAY);

function cutoffOf(calls: Call[]): Date {
  const found = calls.find((c) => c.params.cutoff instanceof Date);
  if (!found || !(found.params.cutoff instanceof Date)) {
    throw new Error("cutoff parameter missing");
  }
  return found.params.cutoff;
}

function idsOf(calls: Call[]): string[] {
  const found = calls.find((c) => Array.isArray(c.params.ids));
  return (found?.params.ids as string[] | undefined) ?? [];
}

function afterIdOf(calls: Call[]): string | null {
  const found = calls.find((c) => typeof c.params.afterId === "string");
  return (found?.params.afterId as string | undefined) ?? null;
}

/** 内存替身：真按 createdAt < cutoff 过滤/删除，用少量行钉死边界严格性。 */
function memoryRepo(initial: Row[]) {
  const state = { rows: [...initial] };
  const calls: Array<Call & { mode: "select" | "delete" }> = [];
  const createQueryBuilder = jest.fn(() => {
    const local: Call[] = [];
    let limit: number | undefined;
    const chain: Record<string, unknown> = {
      select: jest.fn().mockReturnThis(),
      delete: jest.fn().mockReturnThis(),
      where: jest.fn((sql: string, params: Record<string, unknown>) => {
        local.push({ sql, params });
        return chain;
      }),
      andWhere: jest.fn((sql: string, params: Record<string, unknown>) => {
        local.push({ sql, params });
        return chain;
      }),
      orderBy: jest.fn().mockReturnThis(),
      limit: jest.fn((n: number) => {
        limit = n;
        return chain;
      }),
      getRawMany: jest.fn(async () => {
        const cutoff = cutoffOf(local);
        const afterId = afterIdOf(local);
        const selected = state.rows
          .filter((r) => r.createdAt < cutoff)
          .filter((r) => afterId === null || r.id > afterId)
          .sort((a, b) => a.id.localeCompare(b.id))
          .slice(0, limit ?? state.rows.length)
          .map((r) => ({ id: r.id }));
        calls.push(...local.map((c) => ({ ...c, mode: "select" as const })));
        return selected;
      }),
      execute: jest.fn(async () => {
        const cutoff = cutoffOf(local);
        const ids = new Set(idsOf(local));
        const before = state.rows.length;
        state.rows = state.rows.filter(
          (r) => !(ids.has(r.id) && r.createdAt < cutoff),
        );
        calls.push(...local.map((c) => ({ ...c, mode: "delete" as const })));
        return { affected: before - state.rows.length };
      }),
    };
    return chain;
  });
  return { repo: { createQueryBuilder }, state, calls };
}

/** 分页替身：不造 1001 行，直接按页返回 id 列表，验证 keyset + 分块。 */
function pagedRepo(pages: string[][]) {
  let pageIndex = 0;
  const limits: number[] = [];
  const selects: Call[][] = [];
  const deletes: Call[][] = [];
  const createQueryBuilder = jest.fn(() => {
    const local: Call[] = [];
    const chain: Record<string, unknown> = {
      select: jest.fn().mockReturnThis(),
      delete: jest.fn().mockReturnThis(),
      where: jest.fn((sql: string, params: Record<string, unknown>) => {
        local.push({ sql, params });
        return chain;
      }),
      andWhere: jest.fn((sql: string, params: Record<string, unknown>) => {
        local.push({ sql, params });
        return chain;
      }),
      orderBy: jest.fn().mockReturnThis(),
      limit: jest.fn((n: number) => {
        limits.push(n);
        return chain;
      }),
      getRawMany: jest.fn(async () => {
        const page = pages[pageIndex] ?? [];
        pageIndex += 1;
        selects.push([...local]);
        return page.map((id) => ({ id }));
      }),
      execute: jest.fn(async () => {
        deletes.push([...local]);
        return { affected: idsOf(local).length };
      }),
    };
    return chain;
  });
  return { repo: { createQueryBuilder }, limits, selects, deletes };
}

function makeService(repo: unknown, isLeader?: boolean) {
  const gate = isLeader === undefined ? null : ({ isLeader } as never);
  return new FunnelEventsRetentionService(gate, repo as never);
}

describe("FunnelEventsRetentionService · 90 天边界", () => {
  it("cutoff = now - 90d，严格小于才删：正好 90 天保留、90 天+1 秒删除", async () => {
    const h = memoryRepo([
      { id: "edge", createdAt: CUTOFF },
      { id: "old", createdAt: new Date(CUTOFF.getTime() - 1000) },
      { id: "fresh", createdAt: NOW },
    ]);
    const deleted = await makeService(h.repo).cleanupExpired(NOW);

    expect(FUNNEL_EVENT_RETENTION_DAYS).toBe(90);
    expect(deleted).toBe(1);
    expect(h.state.rows.map((r) => r.id)).toEqual(["edge", "fresh"]);
    const deleteCalls = h.calls.filter((c) => c.mode === "delete");
    const idsCall = deleteCalls.find((c) => c.sql.includes("id IN (:...ids)"));
    const cutoffCall = deleteCalls.find((c) =>
      c.sql.includes("createdAt < :cutoff"),
    );
    expect(idsCall?.params.ids).toEqual(["old"]);
    expect(cutoffCall?.params.cutoff).toEqual(CUTOFF);
  });
});

describe("FunnelEventsRetentionService · 分块与空表", () => {
  it("超过 DELETE_CHUNK 时按 500 分批，游标逐页推进", async () => {
    const page = (n: number, offset: number): string[] =>
      Array.from(
        { length: n },
        (_, i) => `id-${String(offset + i).padStart(4, "0")}`,
      );
    const h = pagedRepo([page(500, 0), page(500, 500), page(1, 1000)]);
    const deleted = await makeService(h.repo).cleanupExpired(NOW);

    expect(deleted).toBe(1001);
    expect(h.limits).toEqual([500, 500, 500]);
    expect(h.deletes.map((c) => idsOf(c).length)).toEqual([500, 500, 1]);
    expect(afterIdOf(h.selects[1])).toBe("id-0499");
    expect(afterIdOf(h.selects[2])).toBe("id-0999");
    for (const call of h.deletes.flat()) {
      if (call.sql.includes("createdAt < :cutoff")) {
        expect(call.params.cutoff).toEqual(CUTOFF);
      }
    }
  });

  it("空表返回 0 且不发 DELETE", async () => {
    const h = memoryRepo([]);
    const deleted = await makeService(h.repo).cleanupExpired(NOW);
    expect(deleted).toBe(0);
    expect(h.calls.filter((c) => c.mode === "delete")).toHaveLength(0);
  });
});

describe("FunnelEventsRetentionService · LeaderGate（ARCH-31 §5）", () => {
  it("非 leader 整轮跳过（多实例不重复删）", async () => {
    const h = memoryRepo([
      { id: "old", createdAt: new Date(CUTOFF.getTime() - DAY) },
    ]);
    await makeService(h.repo, false).handleDailyCleanup();
    expect(h.repo.createQueryBuilder).not.toHaveBeenCalled();
    expect(h.state.rows).toHaveLength(1);
  });

  it("leader 缺席（@Optional 单测装配）时门禁不生效，正常执行", async () => {
    const h = memoryRepo([
      { id: "old", createdAt: new Date(CUTOFF.getTime() - DAY) },
    ]);
    await makeService(h.repo).handleDailyCleanup();
    expect(h.state.rows).toHaveLength(0);
  });
});
