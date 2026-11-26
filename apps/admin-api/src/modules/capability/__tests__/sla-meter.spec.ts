import {
  BUSINESS_DAY_MS,
  HOUR_MS,
  MINUTE_MS,
  SLA_LIMITS,
  businessElapsedMs,
  evaluateSla,
} from "../sla-meter";

const at = (iso: string): number => Date.parse(iso);
const DAY_MS = 24 * HOUR_MS;

describe("SLA_LIMITS（runbook §2 四条契约）", () => {
  it("四类目标取值精确，全部为毫秒常量", () => {
    expect(SLA_LIMITS).toEqual({
      capability_review: 32_400_000,
      quota_alert: 7_200_000,
      generation_invalidation: 3_600_000,
      audit_query: 300_000,
    });
    expect(BUSINESS_DAY_MS).toBe(9 * HOUR_MS);
    expect(MINUTE_MS).toBe(60_000);
  });

  it("1 工作日按 9 小时工作窗，不按 24 小时连续时间", () => {
    expect(SLA_LIMITS.capability_review).toBeLessThan(DAY_MS);
    expect(SLA_LIMITS.capability_review).toBe(9 * HOUR_MS);
  });
});

describe("businessElapsedMs — Mon–Fri 09:00–18:00 UTC 简单窗口", () => {
  it("完全落在工作窗内：09:00→12:00 = 3h", () => {
    expect(
      businessElapsedMs(at("2026-01-02T09:00:00Z"), at("2026-01-02T12:00:00Z")),
    ).toBe(3 * HOUR_MS);
  });

  it("起点在非工作时段：08:00→10:00 只计 1h", () => {
    expect(
      businessElapsedMs(at("2026-01-02T08:00:00Z"), at("2026-01-02T10:00:00Z")),
    ).toBe(HOUR_MS);
  });

  it("终点在非工作时段：17:00→19:00 只计 1h", () => {
    expect(
      businessElapsedMs(at("2026-01-02T17:00:00Z"), at("2026-01-02T19:00:00Z")),
    ).toBe(HOUR_MS);
  });

  it("整段非工作时段：周五 18:00→周一 09:00 = 0", () => {
    expect(
      businessElapsedMs(at("2026-01-02T18:00:00Z"), at("2026-01-05T09:00:00Z")),
    ).toBe(0);
  });

  it("反证：跨周末若按连续时间计则本例转红（2h，不是 65h）", () => {
    const start = at("2026-01-02T17:00:00Z");
    const end = at("2026-01-05T10:00:00Z");
    expect(end - start).toBe(65 * HOUR_MS); // 控制：墙钟确为 65h
    expect(businessElapsedMs(start, end)).toBe(2 * HOUR_MS); // 周五 1h + 周一 1h
  });

  it("跨周末整段：周五 09:00→周一 09:00 只计周五的 9h", () => {
    expect(
      businessElapsedMs(at("2026-01-02T09:00:00Z"), at("2026-01-05T09:00:00Z")),
    ).toBe(9 * HOUR_MS);
  });

  it("不虚构节假日：周四 2026-01-01（元旦）仍按普通工作日计 9h", () => {
    expect(
      businessElapsedMs(at("2026-01-01T09:00:00Z"), at("2026-01-01T18:00:00Z")),
    ).toBe(9 * HOUR_MS);
  });

  it("允许注入日历：仅周末 10:00–12:00 为工作窗", () => {
    const calendar = {
      workStartMinute: 600,
      workEndMinute: 720,
      workDays: [0, 6],
    };
    expect(
      businessElapsedMs(
        at("2026-01-03T09:00:00Z"), // 周六
        at("2026-01-03T11:00:00Z"),
        calendar,
      ),
    ).toBe(HOUR_MS);
    expect(
      businessElapsedMs(
        at("2026-01-02T09:00:00Z"),
        at("2026-01-02T11:00:00Z"),
        calendar,
      ),
    ).toBe(0); // 周五在注入日历里不是工作日
  });

  it("倒序/非法时刻不产生负耗时", () => {
    const t = at("2026-01-02T12:00:00Z");
    expect(businessElapsedMs(t, at("2026-01-02T09:00:00Z"))).toBe(0);
    expect(businessElapsedMs(Number.NaN, t)).toBe(0);
    expect(businessElapsedMs(t, t)).toBe(0);
  });
});

describe("evaluateSla — 墙钟 SLA（quota_alert / generation_invalidation / audit_query）", () => {
  it("反证：no_data 若被判成 met 则本例转红（无 startedAt ⇒ no_data）", () => {
    const verdict = evaluateSla({
      startedAt: null,
      completedAt: null,
      limitMs: SLA_LIMITS.audit_query,
      nowMs: at("2026-01-05T12:00:00Z"),
    });
    expect(verdict.status).toBe("no_data");
    expect(verdict.status).not.toBe("met");
    expect(verdict.elapsedMs).toBe(0);
    expect(verdict.remainingMs).toBe(0);
  });

  it("startedAt 为 NaN 同样 no_data，不猜起点", () => {
    expect(
      evaluateSla({
        startedAt: Number.NaN,
        completedAt: null,
        limitMs: SLA_LIMITS.audit_query,
        nowMs: at("2026-01-05T12:00:00Z"),
      }).status,
    ).toBe("no_data");
  });

  it("未完成且未超 ⇒ pending，remainingMs 为正", () => {
    const startedAt = at("2026-01-05T09:00:00Z");
    const verdict = evaluateSla({
      startedAt,
      completedAt: null,
      limitMs: SLA_LIMITS.generation_invalidation,
      nowMs: startedAt + SLA_LIMITS.generation_invalidation - MINUTE_MS,
    });
    expect(verdict).toEqual({
      status: "pending",
      elapsedMs: SLA_LIMITS.generation_invalidation - MINUTE_MS,
      limitMs: SLA_LIMITS.generation_invalidation,
      remainingMs: MINUTE_MS,
    });
  });

  it("未完成但恰好等于 limit 仍 pending（未超）", () => {
    const startedAt = at("2026-01-05T09:00:00Z");
    expect(
      evaluateSla({
        startedAt,
        completedAt: null,
        limitMs: SLA_LIMITS.audit_query,
        nowMs: startedAt + SLA_LIMITS.audit_query,
      }).status,
    ).toBe("pending");
  });

  it("未完成且超 limit ⇒ breached，remainingMs 为负给出超时量", () => {
    const startedAt = at("2026-01-05T09:00:00Z");
    const verdict = evaluateSla({
      startedAt,
      completedAt: null,
      limitMs: SLA_LIMITS.audit_query,
      nowMs: startedAt + SLA_LIMITS.audit_query + 1,
    });
    expect(verdict.status).toBe("breached");
    expect(verdict.remainingMs).toBe(-1);
  });

  it("已完成且未超 ⇒ met，判定取完成时刻而非观察时刻", () => {
    const startedAt = at("2026-01-05T09:00:00Z");
    const verdict = evaluateSla({
      startedAt,
      completedAt: startedAt + SLA_LIMITS.quota_alert,
      limitMs: SLA_LIMITS.quota_alert,
      nowMs: startedAt + 10 * HOUR_MS,
    });
    expect(verdict.status).toBe("met");
    expect(verdict.elapsedMs).toBe(SLA_LIMITS.quota_alert);
  });

  it("已完成但超时 ⇒ breached（即使现在再看也不会翻绿）", () => {
    const startedAt = at("2026-01-05T09:00:00Z");
    expect(
      evaluateSla({
        startedAt,
        completedAt: startedAt + SLA_LIMITS.audit_query + 1,
        limitMs: SLA_LIMITS.audit_query,
        nowMs: startedAt + 10 * HOUR_MS,
      }).status,
    ).toBe("breached");
  });

  it("控制组：墙钟 SLA 跨周末仍按连续时间计（quota_alert 2h ⇒ breached）", () => {
    const verdict = evaluateSla({
      startedAt: at("2026-01-02T17:00:00Z"),
      completedAt: null,
      limitMs: SLA_LIMITS.quota_alert,
      nowMs: at("2026-01-05T10:00:00Z"),
    });
    expect(verdict.status).toBe("breached");
    expect(verdict.elapsedMs).toBe(65 * HOUR_MS);
  });
});

describe("evaluateSla — capability_review 业务钟", () => {
  it("同一跨周末输入：business ⇒ met；墙钟 ⇒ breached（两组互为反证）", () => {
    const input = {
      startedAt: at("2026-01-02T17:00:00Z"),
      completedAt: at("2026-01-05T10:00:00Z"),
      limitMs: SLA_LIMITS.capability_review,
      nowMs: at("2026-01-05T10:00:00Z"),
    };
    const business = evaluateSla({ ...input, clock: "business" });
    const wall = evaluateSla(input);
    expect(business.status).toBe("met");
    expect(business.elapsedMs).toBe(2 * HOUR_MS);
    expect(wall.status).toBe("breached");
    expect(wall.elapsedMs).toBe(65 * HOUR_MS);
  });

  it("完整一个工作日（Mon 09:00→Tue 09:00）恰好达标", () => {
    const verdict = evaluateSla({
      startedAt: at("2026-01-05T09:00:00Z"),
      completedAt: at("2026-01-06T09:00:00Z"),
      limitMs: SLA_LIMITS.capability_review,
      nowMs: at("2026-01-06T09:00:00Z"),
      clock: "business",
    });
    expect(verdict.status).toBe("met");
    expect(verdict.elapsedMs).toBe(BUSINESS_DAY_MS);
    expect(verdict.remainingMs).toBe(0);
  });

  it("超过一个工作日 1h ⇒ breached，remainingMs = -1h", () => {
    const verdict = evaluateSla({
      startedAt: at("2026-01-05T09:00:00Z"),
      completedAt: at("2026-01-06T10:00:00Z"),
      limitMs: SLA_LIMITS.capability_review,
      nowMs: at("2026-01-06T10:00:00Z"),
      clock: "business",
    });
    expect(verdict.status).toBe("breached");
    expect(verdict.remainingMs).toBe(-HOUR_MS);
  });

  it("业务钟未完成但工作窗耗尽前 ⇒ pending", () => {
    const startedAt = at("2026-01-05T09:00:00Z");
    expect(
      evaluateSla({
        startedAt,
        completedAt: null,
        limitMs: SLA_LIMITS.capability_review,
        nowMs: startedAt + 8 * HOUR_MS,
        clock: "business",
      }).status,
    ).toBe("pending");
  });

  it("纯函数：冻结入参重复调用结果一致且不改写入参", () => {
    const input = Object.freeze({
      startedAt: at("2026-01-05T09:00:00Z"),
      completedAt: null,
      limitMs: SLA_LIMITS.capability_review,
      nowMs: at("2026-01-05T12:00:00Z"),
      clock: "business" as const,
    });
    const first = evaluateSla(input);
    const second = evaluateSla(input);
    expect(second).toEqual(first);
    expect(input.completedAt).toBeNull();
    expect(input.nowMs).toBe(at("2026-01-05T12:00:00Z"));
  });
});
