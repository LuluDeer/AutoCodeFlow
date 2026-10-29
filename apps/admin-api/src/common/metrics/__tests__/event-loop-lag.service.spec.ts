import {
  EventLoopLagService,
  EVENT_LOOP_LAG_WARN_MS,
} from "../event-loop-lag.service";
import { SchedulerMetricsService } from "../../../modules/scheduler/scheduler-metrics.service";

/**
 * INCIDENT-2026-10-28（P1-2）：事件循环阻塞监控的回归用例。
 *
 * 真机上的「事件循环被钉住 40 秒」无法在单测里稳定复现（要么真的阻塞测试
 * 进程、要么依赖 perf_hooks 的 C++ 采样时机），所以这里覆盖的是**本服务
 * 自己的契约**：阈值判定、计数与复位、快照只读、生命周期清理。
 */
describe("EventLoopLagService (INCIDENT-2026-10-28 P1-2)", () => {
  let service: EventLoopLagService;
  let loggerWarn: jest.SpyInstance;

  beforeEach(() => {
    service = new EventLoopLagService(new SchedulerMetricsService());
    loggerWarn = jest
      .spyOn((service as any).logger, "warn")
      .mockImplementation(() => undefined);
  });

  afterEach(() => {
    service.onModuleDestroy();
    jest.restoreAllMocks();
  });

  it("初始快照全为 0，且阈值取自常量", () => {
    const snap = service.getSnapshot();
    expect(snap.lastSampleMaxMs).toBe(0);
    expect(snap.lastSampleP99Ms).toBe(0);
    expect(snap.worstMaxMs).toBe(0);
    expect(snap.warnCount).toBe(0);
    expect(snap.lastSampleAt).toBeNull();
    expect(snap.thresholdMs).toBe(EVENT_LOOP_LAG_WARN_MS);
  });

  it("阈值是 1s——与 P0-3 的 missedExecutionTolerance 对齐", () => {
    // 超过 1s 的阻塞就可能已丢调度落点；用故障语义定阈值，不是拍脑袋的百分比
    expect(EVENT_LOOP_LAG_WARN_MS).toBe(1_000);
  });

  it("采样后产生时间戳，且 worstMaxMs 单调不降", () => {
    service.__sampleForTest();
    const first = service.getSnapshot();
    expect(first.lastSampleAt).not.toBeNull();
    expect(first.lastSampleMaxMs).toBeGreaterThanOrEqual(0);

    service.__sampleForTest();
    const second = service.getSnapshot();
    // 直方图每次采样后 reset，所以 lastSample 可能回落；但 worstMaxMs 不降
    expect(second.worstMaxMs).toBeGreaterThanOrEqual(first.worstMaxMs);
  });

  it("明确阻塞超过阈值时告警并计数（人为拉高直方图）", () => {
    // 直接注入一个已知的阻塞值：monitorEventLoopDelay 的 max 是纳秒
    const hist = (service as any).histogram;
    jest.spyOn(hist, "max", "get").mockReturnValue(2_500 * 1e6); // 2500ms
    jest.spyOn(hist, "percentile").mockReturnValue(1_200 * 1e6);
    jest.spyOn(hist, "reset").mockImplementation(() => undefined);

    service.__sampleForTest();

    const snap = service.getSnapshot();
    expect(snap.lastSampleMaxMs).toBe(2_500);
    expect(snap.lastSampleP99Ms).toBe(1_200);
    expect(snap.worstMaxMs).toBe(2_500);
    expect(snap.warnCount).toBe(1);
    expect(loggerWarn).toHaveBeenCalledWith(
      expect.stringContaining("Event loop blocked for 2500ms"),
    );
  });

  it("低于阈值时不告警（避免正常抖动刷屏）", () => {
    const hist = (service as any).histogram;
    jest.spyOn(hist, "max", "get").mockReturnValue(50 * 1e6); // 50ms
    jest.spyOn(hist, "percentile").mockReturnValue(40 * 1e6);
    jest.spyOn(hist, "reset").mockImplementation(() => undefined);

    service.__sampleForTest();

    expect(service.getSnapshot().warnCount).toBe(0);
    expect(loggerWarn).not.toHaveBeenCalled();
  });

  it("onModuleDestroy 停表并禁用直方图（不阻止进程退出）", () => {
    service.onModuleInit();
    expect((service as any).timer).not.toBeNull();
    service.onModuleDestroy();
    expect((service as any).timer).toBeNull();
  });

  it("getSnapshot 返回新对象，改动不回写内部状态", () => {
    const a = service.getSnapshot();
    a.worstMaxMs = 9_999;
    expect(service.getSnapshot().worstMaxMs).toBe(0);
  });
});
