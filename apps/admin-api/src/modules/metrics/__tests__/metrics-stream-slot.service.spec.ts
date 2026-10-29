import { MetricsStreamSlotService } from "../metrics-stream-slot.service";
import {
  getRuntimeCountersSnapshot,
  resetRuntimeMetrics,
} from "../runtime-metrics-entry";

/**
 * 第 6 轮审计 P2：`/metrics/stream`、`/executions/stream` 与日志流共用同一
 * 槽位服务，但拒绝此前只由日志流计数——另两条流被拒时
 * AUTOFLOW_SSE_STREAMS_REJECTED 告警完全静默。
 */
describe("MetricsStreamSlotService · 拒绝计数（第 6 轮审计 P2）", () => {
  const rejected = (): number =>
    getRuntimeCountersSnapshot()
      .get("autoflow_sse_streams_rejected_total")
      ?.get(JSON.stringify({})) ?? 0;

  const make = (max: number) =>
    new MetricsStreamSlotService({
      get: (key: string) =>
        key === "metricsStream.maxStreamsGlobal" ? max : undefined,
    } as never);

  it("超限拒绝时计一次 autoflow_sse_streams_rejected_total", () => {
    resetRuntimeMetrics();
    const svc = make(1);
    const release = svc.acquireSlot();
    expect(() => svc.acquireSlot()).toThrow();
    expect(rejected()).toBe(1);
    release();
    // 释放后可再次占用（计数不重复）
    svc.acquireSlot()();
    expect(rejected()).toBe(1);
  });
});
