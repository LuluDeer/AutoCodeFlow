import { Test, TestingModule } from "@nestjs/testing";
import { MetricsController } from "../metrics.controller";
import { MetricsService } from "../metrics.service";

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
      providers: [{ provide: MetricsService, useValue: svc }],
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
