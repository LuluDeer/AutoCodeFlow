/**
 * R309（TTFV §7.6）FunnelInstallListener 单测：内存替身覆盖 viaRelay 跳过、
 * 字段正确、缺数据跳过、record 异常 fail-open、bus on/off 生命周期。
 * 只证明 listener 分支逻辑，不证明真实 PG/Nest 装配（由集成验收覆盖）。
 */
import { Logger } from "@nestjs/common";

import {
  DOMAIN_EVENTS,
  type ExecutorRegisteredEventPayload,
} from "../../../../common/events/domain-events";
import type { DomainEventBus } from "../../../../common/services/domain-event-bus.service";
import { FunnelInstallListener } from "../funnel-install.listener";
import type { FunnelEventsService } from "../funnel-events.service";

interface Harness {
  listener: FunnelInstallListener;
  bus: { on: jest.Mock; off: jest.Mock };
  funnel: { record: jest.Mock };
}

const registeredEvent = (
  overrides: Partial<
    ExecutorRegisteredEventPayload & { viaRelay?: boolean }
  > = {},
): ExecutorRegisteredEventPayload => ({
  installId: "anon-install-1",
  appName: "acf-node",
  executorType: "universal",
  observedAt: "2026-11-21T12:34:56.000Z",
  ...overrides,
});

const makeHarness = (): Harness => {
  const bus = { on: jest.fn(), off: jest.fn() };
  const funnel = { record: jest.fn(async () => ({ recorded: true })) };
  const listener = new FunnelInstallListener(
    bus as unknown as DomainEventBus,
    funnel as unknown as FunnelEventsService,
  );
  return { listener, bus, funnel };
};

describe("FunnelInstallListener (R309 install_completed)", () => {
  afterEach(() => jest.restoreAllMocks());

  it("viaRelay=true：零写入（防御性跳过跨实例副本）", async () => {
    const h = makeHarness();
    await h.listener.onRegistered(
      registeredEvent({ viaRelay: true }) as ExecutorRegisteredEventPayload,
    );

    expect(h.funnel.record).not.toHaveBeenCalled();
  });

  it("正常链路：写入 install_completed，dedupeKey/ts 字段正确", async () => {
    const h = makeHarness();
    await h.listener.onRegistered(registeredEvent());

    expect(h.funnel.record).toHaveBeenCalledTimes(1);
    expect(h.funnel.record).toHaveBeenCalledWith({
      installId: "anon-install-1",
      eventName: "install_completed",
      dedupeKey: "install-completed:anon-install-1",
      ts: new Date("2026-11-21T12:34:56.000Z"),
    });
  });

  it("installId 为空：跳过，不伪造匿名 ID、零写入", async () => {
    const h = makeHarness();
    await h.listener.onRegistered(registeredEvent({ installId: "" }));

    expect(h.funnel.record).not.toHaveBeenCalled();
  });

  it("observedAt 非法：跳过，不用当前时间伪造分母时刻", async () => {
    const h = makeHarness();
    await h.listener.onRegistered(
      registeredEvent({ observedAt: "not-a-date" }),
    );

    expect(h.funnel.record).not.toHaveBeenCalled();
  });

  it("record 抛异常：warn 吞异常，不向主链抛出", async () => {
    const h = makeHarness();
    const warn = jest.spyOn(Logger.prototype, "warn").mockImplementation();
    h.funnel.record.mockRejectedValue(new Error("db down"));

    await expect(
      h.listener.onRegistered(registeredEvent()),
    ).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalled();
  });

  it("生命周期：onModuleInit 订阅 registered，onModuleDestroy 同一引用退订", () => {
    const h = makeHarness();
    h.listener.onModuleInit();

    expect(h.bus.on).toHaveBeenCalledWith(
      DOMAIN_EVENTS.EXECUTOR_REGISTERED,
      h.listener.onRegistered,
    );

    h.listener.onModuleDestroy();
    expect(h.bus.off).toHaveBeenCalledWith(
      DOMAIN_EVENTS.EXECUTOR_REGISTERED,
      h.listener.onRegistered,
    );
  });
});
