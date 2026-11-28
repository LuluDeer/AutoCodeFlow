import {
  buildExecutionTimeline,
  getExecutionTimelineDurations,
} from "../execution-timeline.util";

/**
 * 阶段时长增强：保留 created/started/finished 三段与既有 at/detail 值，
 * 新增 durationMs 与汇总（queueWaitMs/runDurationMs/totalDurationMs）。
 */
describe("buildExecutionTimeline · 阶段时长（加性兼容）", () => {
  const base = {
    status: "failed",
    triggerType: "cron",
    executorAddress: "http://executor-a",
    createdAt: "2026-09-07T01:00:00.000Z",
    startTime: "2026-09-07T01:00:05.000Z",
    endTime: "2026-09-07T01:05:00.000Z",
  };

  it("三段顺序与 at/detail 与改动前一致", () => {
    const tl = buildExecutionTimeline(base);
    expect(tl.map((t) => t.phase)).toEqual(["created", "started", "finished"]);
    expect(tl[0].at).toBe("2026-09-07T01:00:00.000Z");
    expect(tl[0].detail).toBe("trigger=cron");
    expect(tl[1].detail).toBe("executor=http://executor-a");
    expect(tl[2].detail).toBe("status=failed");
  });

  it("阶段时长：排队 5s、运行 295s、端到端 300s", () => {
    const tl = buildExecutionTimeline(base);
    expect(tl[1].durationMs).toBe(5_000);
    expect(tl[2].durationMs).toBe(295_000);
    expect(tl[2].queueWaitMs).toBe(5_000);
    expect(tl[2].runDurationMs).toBe(295_000);
    expect(tl[2].totalDurationMs).toBe(300_000);
    expect(getExecutionTimelineDurations(base)).toEqual({
      queueWaitMs: 5_000,
      runDurationMs: 295_000,
      totalDurationMs: 300_000,
    });
  });

  it("缺少 startTime 时排队与运行时长为 null（键不出现），逐字节兼容旧形状", () => {
    const tl = buildExecutionTimeline({
      status: "pending",
      triggerType: "manual",
      createdAt: "2026-09-07T08:00:00.000Z",
    });
    expect(tl[1]).toEqual({ phase: "started", at: null, detail: undefined });
    expect(tl[2]).toEqual({
      phase: "finished",
      at: null,
      detail: "status=pending",
    });
    expect(
      getExecutionTimelineDurations({ createdAt: base.createdAt }),
    ).toEqual({
      queueWaitMs: null,
      runDurationMs: null,
      totalDurationMs: null,
    });
  });

  it("非法日期 / 时序倒挂一律不抛错，时长为 null", () => {
    const tl = buildExecutionTimeline({
      createdAt: "not-a-date",
      startTime: undefined,
      endTime: "1970-01-01T99:99:99Z",
    });
    expect(tl.every((t) => t.at === null)).toBe(true);
    expect(tl[2].totalDurationMs).toBeUndefined();
    expect(
      getExecutionTimelineDurations({
        createdAt: "2026-01-02T00:00:00Z",
        endTime: "2026-01-01T00:00:00Z",
      }).totalDurationMs,
    ).toBeNull();
  });
});
