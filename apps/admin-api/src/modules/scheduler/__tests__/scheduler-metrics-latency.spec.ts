/**
 * CORE-06：调度触发 fire→入队延迟直方图——桶分布、P99 插值、快照输出。
 */
import { SchedulerMetricsService, TRIGGER_LATENCY_BUCKETS_MS } from "../scheduler-metrics.service";

describe("SchedulerMetricsService trigger latency (CORE-06)", () => {
  it("accumulates cumulative buckets and sum/count", () => {
    const m = new SchedulerMetricsService();
    // 100 条 5ms → le10 桶
    for (let i = 0; i < 100; i++) m.recordTriggerLatency(5);
    // 50 条 200ms → le250 桶
    for (let i = 0; i < 50; i++) m.recordTriggerLatency(200);
    // 1 条 8000ms → 全部桶以上（+Inf）
    m.recordTriggerLatency(8000);

    const s = m.snapshot;
    expect(s.triggerLatencyCount).toBe(151);
    expect(s.triggerLatencySumMs).toBe(100 * 5 + 50 * 200 + 8000);
    // 累计桶语义：le10 只含 5ms 组；le250 含 5ms+200ms 组
    const idx10 = TRIGGER_LATENCY_BUCKETS_MS.indexOf(10);
    const idx250 = TRIGGER_LATENCY_BUCKETS_MS.indexOf(250);
    expect(s.triggerLatencyBuckets[idx10]).toBe(100);
    expect(s.triggerLatencyBuckets[idx250]).toBe(150);
    expect(s.lastTriggerLatencyMs).toBe(8000);
  });

  it("derives avg and p99 from the histogram", () => {
    const m = new SchedulerMetricsService();
    // 98 个 10ms + 2 个 4000ms：rank=ceil(0.99*100)=99 > le2500 桶累计 98
    // → p99 落在 2500..5000 桶内插值
    for (let i = 0; i < 98; i++) m.recordTriggerLatency(10);
    m.recordTriggerLatency(4000);
    m.recordTriggerLatency(4000);

    const d = m.derived;
    expect(d.avgTriggerLatencyMs).toBeGreaterThan(0);
    // p99 至少在 2500 桶以上（插值 >= 2500）
    expect(d.p99TriggerLatencyMs).toBeGreaterThanOrEqual(2500);
    expect(d.p99TriggerLatencyMs).toBeLessThanOrEqual(5000);
  });

  it("p99 is 0 with no samples and negative latencies clamp to 0", () => {
    const m = new SchedulerMetricsService();
    expect(m.derived.p99TriggerLatencyMs).toBe(0);
    m.recordTriggerLatency(-5);
    expect(m.snapshot.triggerLatencyCount).toBe(1);
    expect(m.snapshot.lastTriggerLatencyMs).toBe(0);
  });
});
