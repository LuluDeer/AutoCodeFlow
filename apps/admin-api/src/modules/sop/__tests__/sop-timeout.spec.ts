import {
  CLAIM_TTL_DEFAULT_MS,
  evaluateAssignmentTimeouts,
  evaluateStuckClarifications,
  PROGRESS_TTL_DEFAULT_MS,
  REVIEW_TERMINAL_STATUSES,
  type StuckClarificationInput,
} from "../sop-timeout";
import type { SopAssignment } from "../entities/sop-assignment.entity";

const NOW = 1_800_000_000_000;

function assignment(patch: Partial<SopAssignment>): SopAssignment {
  return {
    id: "a-1",
    sopId: "sop-1",
    sopVersionId: "v-1",
    executorId: null,
    executorAddress: null,
    status: "assigned",
    outcome: null,
    pulledAt: null,
    startedAt: null,
    finishedAt: null,
    lastProgressAt: null,
    maxRounds: 5,
    sopPolicy: null,
    packageRef: null,
    resultJson: null,
    createdAt: new Date(NOW - 60 * 60 * 1000),
    updatedAt: new Date(NOW - 60 * 60 * 1000),
    ...patch,
  } as unknown as SopAssignment;
}

const TTLS = { claimTtlMs: 30 * 60 * 1000, progressTtlMs: 10 * 60 * 1000 };

describe("evaluateAssignmentTimeouts（11 §6 纯判定）", () => {
  it("assigned 且超 claimTtl → unclaimed", () => {
    const a = assignment({ status: "assigned", pulledAt: null });
    const out = evaluateAssignmentTimeouts([a], NOW, TTLS);
    expect(out.unclaimed).toEqual([a]);
    expect(out.stalled).toEqual([]);
  });

  it("assigned 但未到 claimTtl 不判", () => {
    const a = assignment({ status: "assigned" });
    const young = assignment({
      status: "assigned",
      createdAt: new Date(NOW - 1000),
    });
    const out = evaluateAssignmentTimeouts([a, young], NOW, TTLS);
    expect(out.unclaimed).toEqual([a]);
  });

  it("已领取（pulledAt 非 null）不进 unclaimed", () => {
    const a = assignment({ status: "in_progress", pulledAt: new Date(NOW - 1000) });
    const out = evaluateAssignmentTimeouts([a], NOW, TTLS);
    expect(out.unclaimed).toEqual([]);
  });

  it("in_progress 心跳停滞超 progressTtl → stalled（回落 updatedAt）", () => {
    const noProgress = assignment({
      status: "in_progress",
      pulledAt: new Date(NOW - 3600_000),
      lastProgressAt: null,
      updatedAt: new Date(NOW - 11 * 60 * 1000),
    });
    const withProgress = assignment({
      status: "in_progress",
      lastProgressAt: new Date(NOW - 11 * 60 * 1000),
    });
    const out = evaluateAssignmentTimeouts([noProgress, withProgress], NOW, TTLS);
    expect(out.stalled).toEqual([noProgress, withProgress]);
  });

  it("in_progress 心跳新鲜 / 心跳列缺失且 updatedAt 为空 → 不判", () => {
    const fresh = assignment({
      status: "in_progress",
      lastProgressAt: new Date(NOW - 1000),
    });
    const edge = assignment({
      status: "in_progress",
      lastProgressAt: null,
      updatedAt: null as unknown as Date,
    });
    const out = evaluateAssignmentTimeouts([fresh, edge], NOW, TTLS);
    expect(out.stalled).toEqual([]);
  });

  it("blocked（等中台澄清回复）与终态不参与超时判定", () => {
    const rows = [
      assignment({ status: "blocked" }),
      assignment({ status: "completed" }),
      assignment({ status: "failed" }),
      assignment({ status: "stalled" }),
      assignment({ status: "cancelled" }),
    ];
    const out = evaluateAssignmentTimeouts(rows, NOW, TTLS);
    expect(out.unclaimed).toEqual([]);
    expect(out.stalled).toEqual([]);
  });

  it("默认 TTL 常量与 11 §8 建议值一致", () => {
    expect(CLAIM_TTL_DEFAULT_MS).toBe(30 * 60 * 1000);
    expect(PROGRESS_TTL_DEFAULT_MS).toBe(10 * 60 * 1000);
  });
});

describe("evaluateStuckClarifications（复核兜底判定）", () => {
  const base = {
    clarificationId: "c-1",
    assignmentId: "a-1",
    createdAt: new Date(NOW - 31 * 60 * 1000),
  };

  function row(reviewSessionStatus: StuckClarificationInput["reviewSessionStatus"]) {
    return { ...base, reviewSessionStatus };
  }

  it("会话不存在（null）→ 立即兜底", () => {
    const out = evaluateStuckClarifications([row(null)], NOW, 30 * 60 * 1000);
    expect(out).toHaveLength(1);
  });

  it.each(REVIEW_TERMINAL_STATUSES)(
    "复核会话终态 %s（含 succeeded 但没调答复工具）→ 兜底",
    (status) => {
      const out = evaluateStuckClarifications([row(status)], NOW, 30 * 60 * 1000);
      expect(out).toHaveLength(1);
    },
  );

  it("会话还在跑：未超 TTL 不兜底，超 TTL 兜底", () => {
    const young: StuckClarificationInput = {
      ...base,
      reviewSessionStatus: "running",
      createdAt: new Date(NOW - 1000),
    };
    const stale: StuckClarificationInput = {
      ...young,
      createdAt: new Date(NOW - 31 * 60 * 1000),
    };
    const out = evaluateStuckClarifications([young, stale], NOW, 30 * 60 * 1000);
    expect(out).toEqual([stale]);
  });

  it("waiting_input / pending 属非终态，同样走 TTL 判定", () => {
    const rows = [row("waiting_input"), row("pending")];
    expect(evaluateStuckClarifications(rows, NOW, 30 * 60 * 1000)).toHaveLength(2);
    expect(
      evaluateStuckClarifications(
        rows.map((r) => ({ ...r, createdAt: new Date(NOW - 1000) })),
        NOW,
        30 * 60 * 1000,
      ),
    ).toHaveLength(0);
  });
});
