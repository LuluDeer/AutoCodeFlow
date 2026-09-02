import {
  SchedulerMetricsService,
  SchedulerMetricsSnapshot,
} from "../scheduler-metrics.service";

describe("SchedulerMetricsService (R4-§5.5, zero-dependency in-process counters)", () => {
  let metrics: SchedulerMetricsService;

  beforeEach(() => {
    metrics = new SchedulerMetricsService();
  });

  it("starts with zeroed counters", () => {
    const snap = metrics.snapshot;
    expect(snap.ticks).toBe(0);
    expect(snap.tickDurationMsTotal).toBe(0);
    expect(snap.lastTickDurationMs).toBe(0);
    expect(snap.lastTickAt).toBeNull();
    expect(snap.triggersClaimed).toBe(0);
    expect(snap.triggersSkippedLockHeld).toBe(0);
    expect(snap.triggersSkippedDbClaim).toBe(0);
    expect(snap.triggersSkippedInactive).toBe(0);
    expect(snap.triggersSkippedBlockStrategy).toBe(0);
    expect(snap.triggersFailed).toBe(0);
    expect(snap.dependencyTriggersClaimed).toBe(0);
    expect(snap.dependencyTriggersSkipped).toBe(0);
    expect(new Date(snap.startedAt).getTime()).toBeLessThanOrEqual(Date.now());
  });

  it("accumulates tick count and durations, keeping the last tick duration", () => {
    metrics.recordTick(10);
    metrics.recordTick(30);
    metrics.recordTick(5);

    const snap = metrics.snapshot;
    expect(snap.ticks).toBe(3);
    expect(snap.tickDurationMsTotal).toBe(45);
    expect(snap.lastTickDurationMs).toBe(5);
    expect(snap.lastTickAt).not.toBeNull();
  });

  it("derives average tick duration from cumulative counters", () => {
    metrics.recordTick(10);
    metrics.recordTick(30);

    expect(metrics.derived.avgTickDurationMs).toBe(20);
    expect(metrics.derived.tickRatePerSec).toBeGreaterThanOrEqual(0);
    expect(metrics.derived.triggerClaimRatePerSec).toBeGreaterThanOrEqual(0);
  });

  it("counts trigger claimed/skipped/failed on independent counters", () => {
    metrics.recordTriggerClaimed();
    metrics.recordTriggerClaimed();
    metrics.recordTriggerSkippedLockHeld();
    metrics.recordTriggerSkippedDbClaim();
    metrics.recordTriggerSkippedInactive();
    metrics.recordTriggerSkippedBlockStrategy();
    metrics.recordTriggerFailed();

    const snap = metrics.snapshot;
    expect(snap.triggersClaimed).toBe(2);
    expect(snap.triggersSkippedLockHeld).toBe(1);
    expect(snap.triggersSkippedDbClaim).toBe(1);
    expect(snap.triggersSkippedInactive).toBe(1);
    expect(snap.triggersSkippedBlockStrategy).toBe(1);
    expect(snap.triggersFailed).toBe(1);
  });

  it("counts dependency fan-out claim/skip separately from scheduled triggers", () => {
    metrics.recordTriggerClaimed();
    metrics.recordDependencyTriggerClaimed();
    metrics.recordDependencyTriggerSkipped();

    const snap = metrics.snapshot;
    expect(snap.triggersClaimed).toBe(1);
    expect(snap.dependencyTriggersClaimed).toBe(1);
    expect(snap.dependencyTriggersSkipped).toBe(1);
  });

  it("snapshot is a defensive copy — mutating it does not affect internal state", () => {
    metrics.recordTick(7);
    const copy: SchedulerMetricsSnapshot = metrics.snapshot;
    copy.ticks = 999;
    copy.lastTickAt = null;

    expect(metrics.snapshot.ticks).toBe(1);
    expect(metrics.snapshot.lastTickAt).not.toBeNull();
  });
});
