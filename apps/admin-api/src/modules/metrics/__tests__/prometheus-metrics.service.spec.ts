import { ConfigService } from "@nestjs/config";
import { register as globalRegister } from "prom-client";
import { PrometheusMetricsService } from "../prometheus-metrics.service";
import { SchedulerMetricsService } from "../../scheduler/scheduler-metrics.service";
import { SchedulerService } from "../../scheduler/scheduler.service";

/**
 * R7: prom-client exposition 端点测试。
 * 每个用例构造独立的 PrometheusMetricsService（内部独立 Registry），
 * 既验证映射正确性，也验证不污染 prom-client 全局 registry。
 */
describe("PrometheusMetricsService (R7 prom-client exposition)", () => {
  let schedulerMetrics: SchedulerMetricsService;
  let schedulerService: { getQueueDepth: jest.Mock };

  const QUEUE_EMPTY = {
    waiting: 0,
    active: 0,
    delayed: 0,
    failed: 0,
    completed: 0,
  };
  const QUEUE_DOWN = {
    waiting: null,
    active: null,
    delayed: null,
    failed: null,
    completed: null,
  };

  const makeService = (
    opts: { enabled?: boolean; defaultMetrics?: boolean } = {},
  ) => {
    const config = {
      get: jest.fn((key: string) => {
        if (key === "metrics.prometheus.enabled") return opts.enabled ?? true;
        if (key === "metrics.prometheus.defaultMetricsEnabled")
          return opts.defaultMetrics ?? true;
        return undefined;
      }),
    };
    schedulerMetrics = new SchedulerMetricsService();
    schedulerService = {
      getQueueDepth: jest.fn().mockResolvedValue({ ...QUEUE_EMPTY }),
    };
    return new PrometheusMetricsService(
      config as unknown as ConfigService,
      schedulerMetrics,
      schedulerService as unknown as SchedulerService,
    );
  };

  /** 喂入一轮完整的计数事件（每个计数器至少一次） */
  const feedAllCounters = (m: SchedulerMetricsService) => {
    m.recordTick(10);
    m.recordTick(20);
    m.recordTriggerClaimed();
    m.recordTriggerClaimed();
    m.recordTriggerClaimed();
    m.recordTriggerSkippedLockHeld();
    m.recordTriggerSkippedDbClaim();
    m.recordTriggerSkippedInactive();
    m.recordTriggerSkippedBlockStrategy();
    m.recordTriggerFailed();
    m.recordTriggerFailed();
    m.recordDependencyTriggerClaimed();
    m.recordDependencyTriggerClaimed();
    m.recordDependencyTriggerSkipped();
  };

  it("maps every SchedulerMetricsService counter to its prometheus series", async () => {
    const svc = makeService();
    feedAllCounters(schedulerMetrics);

    const text = await svc.render();

    expect(text).toContain("# TYPE autoflow_scheduler_ticks_total counter");
    expect(text).toContain("autoflow_scheduler_ticks_total 2");
    expect(text).toContain("autoflow_scheduler_tick_duration_ms_total 30");
    expect(text).toContain("autoflow_scheduler_last_tick_duration_ms 20");
    expect(text).toContain(
      'autoflow_scheduler_triggers_total{result="claimed"} 3',
    );
    expect(text).toContain(
      'autoflow_scheduler_triggers_total{result="failed"} 2',
    );
    expect(text).toContain(
      'autoflow_scheduler_dependency_triggers_total{result="claimed"} 2',
    );
    expect(text).toContain(
      'autoflow_scheduler_dependency_triggers_total{result="skipped"} 1',
    );
  });

  it("splits the four trigger skip reasons into label series", async () => {
    const svc = makeService();
    feedAllCounters(schedulerMetrics);

    const text = await svc.render();

    expect(text).toContain(
      'autoflow_scheduler_triggers_skipped_total{reason="lock_held"} 1',
    );
    expect(text).toContain(
      'autoflow_scheduler_triggers_skipped_total{reason="db_claim"} 1',
    );
    expect(text).toContain(
      'autoflow_scheduler_triggers_skipped_total{reason="inactive"} 1',
    );
    expect(text).toContain(
      'autoflow_scheduler_triggers_skipped_total{reason="block_strategy"} 1',
    );
  });

  it("exposes queue depth gauges and autoflow_queue_up=1 when Redis is readable", async () => {
    const svc = makeService();
    schedulerService.getQueueDepth.mockResolvedValue({
      waiting: 4,
      active: 2,
      delayed: 1,
      failed: 0,
      completed: 9,
    });

    const text = await svc.render();

    expect(text).toContain('autoflow_queue_depth{state="waiting"} 4');
    expect(text).toContain('autoflow_queue_depth{state="active"} 2');
    expect(text).toContain('autoflow_queue_depth{state="delayed"} 1');
    expect(text).toContain('autoflow_queue_depth{state="failed"} 0');
    expect(text).toContain('autoflow_queue_depth{state="completed"} 9');
    expect(text).toContain("autoflow_queue_up 1");
  });

  it("zeros queue depth gauges and sets autoflow_queue_up=0 when Redis is down", async () => {
    const svc = makeService();
    schedulerService.getQueueDepth.mockResolvedValue({ ...QUEUE_DOWN });

    const text = await svc.render();

    expect(text).toContain("autoflow_queue_up 0");
    for (const state of [
      "waiting",
      "active",
      "delayed",
      "failed",
      "completed",
    ]) {
      expect(text).toContain(`autoflow_queue_depth{state="${state}"} 0`);
    }
  });

  it("keeps counter values monotonic across scrapes (snapshot is source of truth)", async () => {
    const svc = makeService();
    schedulerMetrics.recordTick(5);
    const first = await svc.render();
    expect(first).toContain("autoflow_scheduler_ticks_total 1");

    schedulerMetrics.recordTick(5);
    const second = await svc.render();
    expect(second).toContain("autoflow_scheduler_ticks_total 2");
    // 同一实例重复抓取不产生残留的双 series
    expect(second.match(/autoflow_scheduler_ticks_total \d+/g)).toHaveLength(1);
  });

  it("collects process default metrics unless disabled by config", async () => {
    const withDefaults = makeService();
    expect(await withDefaults.render()).toContain(
      "process_cpu_user_seconds_total",
    );

    const withoutDefaults = makeService({ defaultMetrics: false });
    expect(await withoutDefaults.render()).not.toContain(
      "process_cpu_user_seconds_total",
    );
  });

  it("exposes the registry contentType for the response header", () => {
    const svc = makeService();
    expect(svc.contentType).toContain("text/plain");
  });

  it("never writes into the prom-client global registry (test isolation)", async () => {
    const svc = makeService();
    feedAllCounters(schedulerMetrics);
    await svc.render();

    const globalText = await globalRegister.metrics();
    expect(globalText).not.toContain("autoflow_scheduler_ticks_total");
  });

  it("enabled reflects metrics.prometheus.enabled config (default true)", () => {
    expect(makeService().enabled).toBe(true);
    expect(makeService({ enabled: false }).enabled).toBe(false);
  });
});
