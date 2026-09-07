/**
 * CORE-06: 调度延迟直方图 P99 插值边界矩阵——已存在的直方图/P99/prom
 * series 不重做（侦察结论），本轮补齐插值边界与 bucket 边界复核用例。
 */
import {
  SchedulerMetricsService,
  TRIGGER_LATENCY_BUCKETS_MS,
} from "../scheduler-metrics.service";

const LE = TRIGGER_LATENCY_BUCKETS_MS;

describe("CORE-06 P99 插值边界（scheduler-metrics）", () => {
  it("单样本落在最小桶：P99 = 桶内插值（0..10 区间）", () => {
    const m = new SchedulerMetricsService();
    m.recordTriggerLatency(5);
    // rank = ceil(0.99 * 1) = 1，le10 桶累计 1；插值 0 + (1-0)/1 * 10 = 10
    expect(m.derived.p99TriggerLatencyMs).toBe(10);
  });

  it("恰好等于桶上界的样本计入该桶（<= le 语义，bucket 边界复核）", () => {
    const m = new SchedulerMetricsService();
    m.recordTriggerLatency(10); // 恰好 10ms → le10 桶
    const s = m.snapshot;
    expect(s.triggerLatencyBuckets[LE.indexOf(10)]).toBe(1);
    expect(s.triggerLatencyBuckets[LE.indexOf(10)]).toBe(1);
    expect(s.triggerLatencyCount).toBe(1);
  });

  it("超过最大桶（5000ms）的样本：所有有限桶都不计，仅 +Inf 计数兜底 → P99 回退 lastTriggerLatencyMs", () => {
    const m = new SchedulerMetricsService();
    m.recordTriggerLatency(6000);
    const s = m.snapshot;
    expect(s.triggerLatencyBuckets.every((c) => c === 0)).toBe(true);
    expect(s.triggerLatencyCount).toBe(1);
    // 有限桶累计全部 < rank → 循环走完回退 lastTriggerLatencyMs
    expect(m.derived.p99TriggerLatencyMs).toBe(6000);
  });

  it("rank 恰好命中空桶（跳桶样本）：取桶上界而非除零", () => {
    const m = new SchedulerMetricsService();
    // 1 条 5ms（le10=1），1 条 8000ms（全桶以上）：le50..le5000 累计恒 1
    m.recordTriggerLatency(5);
    m.recordTriggerLatency(8000);
    // rank = ceil(0.99*2) = 2；有限桶累计最大 1 < 2 → 回退 lastTriggerLatencyMs=8000
    expect(m.derived.p99TriggerLatencyMs).toBe(8000);
  });

  it("空桶但在桶内有样本：插值取桶上界（inBucket<=0 分支）", () => {
    const m = new SchedulerMetricsService();
    // 99 条 5ms（le10 累计 99）+ 1 条 6000ms：rank=99 恰好命中 le10 累计
    // 但若 rank 落在下一桶（le50 累计 99 同值）时 inBucket=0 → 返回桶上界。
    for (let i = 0; i < 99; i++) m.recordTriggerLatency(5);
    m.recordTriggerLatency(4000);
    // rank = ceil(0.99*100) = 99；le10 累计 99 >= rank → 命中，插值区间 0..10
    expect(m.derived.p99TriggerLatencyMs).toBe(10);
  });

  it("派生 avg 与 count 一致性：sum/count 单调可复算", () => {
    const m = new SchedulerMetricsService();
    m.recordTriggerLatency(100);
    m.recordTriggerLatency(300);
    const d = m.derived;
    const s = m.snapshot;
    expect(d.avgTriggerLatencyMs).toBeCloseTo(s.triggerLatencySumMs / s.triggerLatencyCount, 9);
    expect(s.triggerLatencyCount).toBe(2);
  });

  it("snapshot.triggerLatencyBuckets 是副本（外部修改不影响内部累计）", () => {
    const m = new SchedulerMetricsService();
    m.recordTriggerLatency(5);
    const s1 = m.snapshot;
    s1.triggerLatencyBuckets[0] = 999;
    expect(m.snapshot.triggerLatencyBuckets[0]).toBe(1);
  });
});
