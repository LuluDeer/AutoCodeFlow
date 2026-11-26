import { HOUR_MS, MINUTE_MS, SLA_LIMITS, evaluateSla } from "../sla-meter";
import { assessSlaDeadlines, type SlaReviewRecord } from "../sla-assessment";

const at = (iso: string): number => Date.parse(iso);
const MON_9 = at("2026-01-05T09:00:00Z");
const TUE_9 = at("2026-01-06T09:00:00Z");
const TUE_10 = at("2026-01-06T10:00:00Z");

describe("assessSlaDeadlines — 审核流水线 SLA 判定", () => {
  it("① 反证：超 1 工作日的 capability_review 判 breached，误判 met 即转红", () => {
    const records: SlaReviewRecord[] = [
      {
        id: "review-over-1d",
        kind: "capability_review",
        startedAt: MON_9,
        completedAt: TUE_10,
      },
    ];
    const result = assessSlaDeadlines(records, TUE_10);

    expect(result[0].status).toBe("breached");
    expect(result[0].status).not.toBe("met");
    expect(result[0].elapsedMs).toBe(SLA_LIMITS.capability_review + HOUR_MS);
    expect(result[0].remainingMs).toBe(-HOUR_MS);
    expect(result[0].breached).toBe(true);
    expect(result.summary.breachedIds).toEqual(["review-over-1d"]);
    expect(result.summary.breachedCount).toBe(1);
  });

  it("① 反证：未完成但已耗尽 1 工作日，pending 必须转 breached", () => {
    const result = assessSlaDeadlines(
      [{ id: "review-open", kind: "capability_review", startedAt: MON_9 }],
      TUE_10,
    );

    expect(result[0].status).toBe("breached");
    expect(result[0].status).not.toBe("pending");
    expect(result.summary.pendingCount).toBe(0);
    expect(result.summary.breachedCount).toBe(1);
  });

  it("② 反证：无 startedAt 判 no_data，绝不凑成 met", () => {
    const result = assessSlaDeadlines(
      [{ id: "no-start", kind: "audit_query", startedAt: null }],
      at("2026-01-05T12:00:00Z"),
    );

    expect(result[0].status).toBe("no_data");
    expect(result[0].status).not.toBe("met");
    expect(result[0].elapsedMs).toBe(0);
    expect(result.summary.metCount).toBe(0);
    expect(result.summary.noDataCount).toBe(1);
    expect(result.summary.breachedIds).toEqual([]);
  });

  it("③ 控制组：恰好 1 工作日达标 met，未超 2h 待办 pending", () => {
    const met = assessSlaDeadlines(
      [
        {
          id: "review-exact-1d",
          kind: "capability_review",
          startedAt: MON_9,
          completedAt: TUE_9,
        },
      ],
      TUE_9,
    );
    expect(met[0].status).toBe("met");
    expect(met[0].remainingMs).toBe(0);
    expect(met.summary.metCount).toBe(1);
    expect(met.summary.breachedCount).toBe(0);

    const nowMs = MON_9 + HOUR_MS;
    const pending = assessSlaDeadlines(
      [{ id: "quota-open", kind: "quota_alert", startedAt: MON_9 }],
      nowMs,
    );
    expect(pending[0].status).toBe("pending");
    expect(pending[0].remainingMs).toBe(HOUR_MS);
    expect(pending.summary.pendingCount).toBe(1);
    expect(pending.summary.breachedCount).toBe(0);
  });

  it("控制组：非审核类走墙钟，跨周末的 audit_query 仍判 breached", () => {
    const result = assessSlaDeadlines(
      [
        {
          id: "audit-over-weekend",
          kind: "audit_query",
          startedAt: at("2026-01-02T17:00:00Z"),
        },
      ],
      at("2026-01-05T10:00:00Z"),
    );

    expect(result[0].status).toBe("breached");
    expect(result[0].elapsedMs).toBe(65 * HOUR_MS);
  });

  it("汇总：四类状态同批统计，breachedIds 只含违约 id", () => {
    const records: SlaReviewRecord[] = [
      {
        id: "review-over-1d",
        kind: "capability_review",
        startedAt: MON_9,
        completedAt: TUE_10,
      },
      { id: "no-start", kind: "capability_review", startedAt: null },
      {
        id: "review-exact-1d",
        kind: "capability_review",
        startedAt: MON_9,
        completedAt: TUE_9,
      },
      { id: "quota-open", kind: "quota_alert", startedAt: TUE_9 },
      {
        id: "audit-fast",
        kind: "audit_query",
        startedAt: TUE_9,
        completedAt: TUE_9 + 4 * MINUTE_MS,
      },
    ];
    const result = assessSlaDeadlines(records, TUE_9 + HOUR_MS);

    expect(result).toHaveLength(5);
    expect(result.map((item) => item.status)).toEqual([
      "breached",
      "no_data",
      "met",
      "pending",
      "met",
    ]);
    expect(result.summary).toMatchObject({
      total: 5,
      breachedCount: 1,
      pendingCount: 1,
      metCount: 2,
      noDataCount: 1,
      breachedIds: ["review-over-1d"],
    });
  });

  it("复用不重写：逐条结果与直接调用 evaluateSla 一致", () => {
    const records: SlaReviewRecord[] = [
      {
        id: "review-over-1d",
        kind: "capability_review",
        startedAt: MON_9,
        completedAt: TUE_10,
      },
      { id: "quota-open", kind: "quota_alert", startedAt: MON_9 },
      {
        id: "audit-fast",
        kind: "audit_query",
        startedAt: TUE_9,
        completedAt: TUE_9 + MINUTE_MS,
      },
      {
        id: "invalidation-open",
        kind: "generation_invalidation",
        startedAt: TUE_9,
      },
    ];
    const nowMs = TUE_9 + HOUR_MS;
    const result = assessSlaDeadlines(records, nowMs);

    records.forEach((record, index) => {
      const expected = evaluateSla({
        startedAt: record.startedAt,
        completedAt: record.completedAt ?? null,
        limitMs: SLA_LIMITS[record.kind],
        nowMs,
        clock: record.kind === "capability_review" ? "business" : "wall",
      });
      expect(result[index]).toMatchObject({
        id: record.id,
        kind: record.kind,
        status: expected.status,
        elapsedMs: expected.elapsedMs,
        limitMs: expected.limitMs,
        remainingMs: expected.remainingMs,
      });
    });
  });

  it("不虚构时钟：nowMs 由调用方喂入，函数内不读 Date.now", () => {
    const spy = jest.spyOn(Date, "now");
    try {
      const result = assessSlaDeadlines(
        [{ id: "quota-open", kind: "quota_alert", startedAt: MON_9 }],
        MON_9 + MINUTE_MS,
      );
      expect(result[0].status).toBe("pending");
      expect(result[0].elapsedMs).toBe(MINUTE_MS);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it("纯函数：冻结入参重复调用结果一致且不改写入参", () => {
    const records: readonly SlaReviewRecord[] = Object.freeze([
      Object.freeze({
        id: "review-over-1d",
        kind: "capability_review" as const,
        startedAt: MON_9,
        completedAt: TUE_10,
      }),
      Object.freeze({
        id: "quota-open",
        kind: "quota_alert" as const,
        startedAt: MON_9,
      }),
    ]);
    const first = assessSlaDeadlines(records, TUE_10);
    const second = assessSlaDeadlines(records, TUE_10);

    expect([...second]).toEqual([...first]);
    expect(second.summary).toEqual(first.summary);
    expect(records[0].startedAt).toBe(MON_9);
    expect(records[1].completedAt).toBeUndefined();
  });

  it("判定与发送分离：返回体明确标记告警渠道由主控裁决", () => {
    const result = assessSlaDeadlines(
      [
        {
          id: "review-over-1d",
          kind: "capability_review",
          startedAt: MON_9,
          completedAt: TUE_10,
        },
      ],
      TUE_10,
    );

    expect(result.summary.alertChannelDecision).toBe(
      "requires_main_control_decision",
    );
    expect(
      result.every(
        (item) =>
          item.alertChannelDecision === "requires_main_control_decision",
      ),
    ).toBe(true);
    expect(result[0].breached).toBe(true);
  });
});
