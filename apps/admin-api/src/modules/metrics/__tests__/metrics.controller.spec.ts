import { NotFoundException } from "@nestjs/common";
import { Test, TestingModule } from "@nestjs/testing";
import { MetricsController } from "../metrics.controller";
import { MetricsService } from "../metrics.service";
import { PrometheusMetricsService } from "../prometheus-metrics.service";

describe("MetricsController (R4-§5.5 /metrics/scheduler)", () => {
  let controller: MetricsController;
  let svc: { getSchedulerMetrics: jest.Mock };

  beforeEach(async () => {
    svc = {
      getSchedulerMetrics: jest.fn().mockResolvedValue({
        counters: { ticks: 2, triggersClaimed: 1, triggersFailed: 0 },
        derived: { avgTickDurationMs: 5, tickRatePerSec: 0.01 },
        queue: { waiting: 1, active: 0, delayed: 2, failed: 0, completed: 7 },
        scheduler: { isLeader: true },
        instance: { pid: process.pid, hostname: "" },
      }),
    };
    const module: TestingModule = await Test.createTestingModule({
      controllers: [MetricsController],
      providers: [
        { provide: MetricsService, useValue: svc },
        {
          provide: PrometheusMetricsService,
          useValue: {
            enabled: true,
            contentType: "text/plain; version=0.0.4; charset=utf-8",
            render: jest.fn(),
          },
        },
      ],
    }).compile();

    controller = module.get<MetricsController>(MetricsController);
  });

  it("GET /metrics/scheduler returns the composed observability payload", async () => {
    const result = await controller.getSchedulerMetrics();
    expect(svc.getSchedulerMetrics).toHaveBeenCalledTimes(1);
    expect(result.counters.ticks).toBe(2);
    expect(result.counters.triggersClaimed).toBe(1);
    expect(result.queue).toEqual({
      waiting: 1,
      active: 0,
      delayed: 2,
      failed: 0,
      completed: 7,
    });
    expect(result.scheduler.isLeader).toBe(true);
  });
});

describe("MetricsController GET /metrics (R7 Prometheus exposition)", () => {
  let prometheus: {
    enabled: boolean;
    contentType: string;
    render: jest.Mock;
  };
  let controller: MetricsController;

  const makeRes = () => ({
    setHeader: jest.fn(),
    end: jest.fn(),
  });

  beforeEach(async () => {
    prometheus = {
      enabled: true,
      contentType: "text/plain; version=0.0.4; charset=utf-8",
      render: jest
        .fn()
        .mockResolvedValue("# HELP autoflow_scheduler_ticks_total h\n"),
    };
    const module: TestingModule = await Test.createTestingModule({
      controllers: [MetricsController],
      providers: [
        {
          provide: MetricsService,
          useValue: { getSchedulerMetrics: jest.fn() },
        },
        { provide: PrometheusMetricsService, useValue: prometheus },
      ],
    }).compile();

    controller = module.get<MetricsController>(MetricsController);
  });

  it("writes the exposition body with the registry contentType via @Res (bypasses ResponseInterceptor)", async () => {
    const res = makeRes();
    await controller.getPrometheusMetrics(res as never);

    expect(prometheus.render).toHaveBeenCalledTimes(1);
    expect(res.setHeader).toHaveBeenCalledWith(
      "Content-Type",
      "text/plain; version=0.0.4; charset=utf-8",
    );
    expect(res.end).toHaveBeenCalledWith(
      "# HELP autoflow_scheduler_ticks_total h\n",
    );
  });

  it("returns 404 when METRICS_PROMETHEUS_ENABLED=false (endpoint disabled)", async () => {
    prometheus.enabled = false;
    const res = makeRes();

    await expect(controller.getPrometheusMetrics(res as never)).rejects.toThrow(
      NotFoundException,
    );
    expect(prometheus.render).not.toHaveBeenCalled();
    expect(res.end).not.toHaveBeenCalled();
  });
});
