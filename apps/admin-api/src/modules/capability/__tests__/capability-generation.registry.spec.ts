/**
 * N23 续：capability generation swap 接生产链单测（内存替身，不启 Nest/PG）。
 *
 * 断言副作用而非接口形状：
 * (1) emit capability.changed → resolve 返回新代值；
 * (2) swap 成功后 retired 快照 dispose 恰一次；
 * (3) validate=false / 同代 stage → active 引用不变且 dispose 零调用；
 * (4) rollback 恢复 swap 前 active 引用。
 *
 * 验收级别：单测 / 内存替身（svc 为 resolveFor 桩，bus 为真 DomainEventBus +
 * 真实 emit/on/off），不代表真实 PG 持久化与 Nest DI 全量集成。
 */
jest.mock("../capability.service", () => ({
  CapabilityService: class CapabilityServiceStub {},
  CapabilityActor: undefined,
  CapabilityResolution: undefined,
  CapabilityDump: undefined,
}));

import "reflect-metadata";
import { DomainEventBus } from "../../../common/services/domain-event-bus.service";
import {
  DOMAIN_EVENTS,
  CapabilityChangedEventPayload,
} from "../../../common/events/domain-events";
import { CapabilityController } from "../capability.controller";
import { CapabilityGenerationRegistry } from "../capability-generation.registry";
import type { CapabilityResolution } from "../capability.service";

const KEY = "browser";

function resolution(tag: string): CapabilityResolution {
  return {
    key: KEY,
    effective: { tag },
    decision: { effect: "allow", obligations: [] },
  } as unknown as CapabilityResolution;
}

function payload(occurredAt: string): CapabilityChangedEventPayload {
  return {
    key: KEY,
    operation: "update",
    occurredAt,
    schemaVersion: 1,
  };
}

/** resolveFor 桩：返回值可替换，用于模拟「事件后按 key 重解析出新代」。 */
function makeSvc() {
  let current = resolution("gen-1");
  const resolveFor = jest.fn(async () => current);
  return {
    resolveFor,
    setNext: (next: CapabilityResolution): void => {
      current = next;
    },
  };
}

/** bus 的 wrapped listener 在 Promise 分支挂 .catch；用 setImmediate 等到微任务落定。 */
function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** svc 桩先返回 gen-1，emit 后换成 gen-2，验证 resolve 读到新代。 */
function makeHarness() {
  const bus = new DomainEventBus();
  const svc = makeSvc();
  const disposer = jest.fn();
  const registry = new CapabilityGenerationRegistry(
    svc as never,
    bus,
  ).setDisposer(disposer);
  registry.subscribe();
  const controller = new CapabilityController(svc as never, registry);
  return { bus, svc, disposer, registry, controller };
}

describe("N23 capability generation swap 接生产链", () => {
  it("(1) emit capability.changed 后 resolve 返回新代值（且空态回退 service）", async () => {
    const { bus, svc, registry, controller } = makeHarness();
    const dto = { key: KEY, layers: [{ name: "managed", config: {} }] };

    // 空态：registry 未收到事件 → 回退 service，与既有 resolve 行为一致。
    const before = await controller.resolve(dto as never);
    expect(before.effective).toEqual({ tag: "gen-1" });
    expect(svc.resolveFor).toHaveBeenCalledTimes(1);
    expect(registry.current).toBeNull();

    const next = resolution("gen-2");
    svc.setNext(next);
    bus.emit(DOMAIN_EVENTS.CAPABILITY_CHANGED, payload("2026-01-01T00:00:01Z"));
    await flush();

    expect(registry.current?.active.generation).toBe(
      `${KEY}:2026-01-01T00:00:01Z`,
    );
    // 事件 handler 按 key 重解析一次（空态 resolve 1 + handler 1）。
    expect(svc.resolveFor).toHaveBeenCalledTimes(2);
    const callsBeforeRead = svc.resolveFor.mock.calls.length;

    const after = await controller.resolve(dto as never);
    expect(after).toBe(next); // 引用级：读到的就是新代快照 value
    expect(after.effective).toEqual({ tag: "gen-2" });
    // 当前代直接命中，第二次 resolve 不再落到 service。
    expect(svc.resolveFor).toHaveBeenCalledTimes(callsBeforeRead);
    registry.unsubscribe();
  });

  it("(2) swap 成功后 retired 快照 dispose 恰调用一次", async () => {
    const { bus, svc, disposer, registry } = makeHarness();

    // 首代：createSwapState，无 retired → dispose 零调用。
    bus.emit(DOMAIN_EVENTS.CAPABILITY_CHANGED, payload("2026-01-01T00:00:01Z"));
    await flush();
    expect(disposer).toHaveBeenCalledTimes(0);

    const firstActive = registry.current?.active;
    const second = resolution("gen-2");
    svc.setNext(second);
    bus.emit(DOMAIN_EVENTS.CAPABILITY_CHANGED, payload("2026-01-01T00:00:02Z"));
    await flush();

    expect(registry.current?.phase).toBe("swapped");
    expect(registry.current?.retired).toBe(firstActive);
    expect(disposer).toHaveBeenCalledTimes(1);
    expect(disposer).toHaveBeenCalledWith(firstActive);
    // 同一次 swap 不重复释放。
    await flush();
    expect(disposer).toHaveBeenCalledTimes(1);
    registry.unsubscribe();
  });

  it("(3a) validate=false：active 引用不变且 dispose 零调用", async () => {
    const { bus, svc, disposer, registry } = makeHarness();
    registry.setValidate(() => false);

    bus.emit(DOMAIN_EVENTS.CAPABILITY_CHANGED, payload("2026-01-01T00:00:01Z"));
    await flush();
    const activeBefore = registry.current?.active;
    const stateBefore = registry.current;

    svc.setNext(resolution("gen-2"));
    bus.emit(DOMAIN_EVENTS.CAPABILITY_CHANGED, payload("2026-01-01T00:00:02Z"));
    await flush();

    expect(registry.current).toBe(stateBefore); // 状态引用不变（无半切换）
    expect(registry.current?.active).toBe(activeBefore);
    expect(disposer).toHaveBeenCalledTimes(0);
    registry.unsubscribe();
  });

  it("(3b) 同代 stage（相同 occurredAt）：active 引用不变且 dispose 零调用", async () => {
    const { bus, svc, disposer, registry } = makeHarness();
    const sameAt = "2026-01-01T00:00:01Z";

    bus.emit(DOMAIN_EVENTS.CAPABILITY_CHANGED, payload(sameAt));
    await flush();
    const activeBefore = registry.current?.active;
    const stateBefore = registry.current;

    svc.setNext(resolution("gen-2-different-value"));
    bus.emit(DOMAIN_EVENTS.CAPABILITY_CHANGED, payload(sameAt));
    await flush();

    expect(registry.current).toBe(stateBefore);
    expect(registry.current?.active).toBe(activeBefore);
    expect(registry.current?.active.value).toBe(activeBefore?.value);
    expect(disposer).toHaveBeenCalledTimes(0);
    registry.unsubscribe();
  });

  it("(4) rollback 恢复 swap 前 active 引用，且不再触发 dispose", async () => {
    const { bus, svc, disposer, registry } = makeHarness();

    bus.emit(DOMAIN_EVENTS.CAPABILITY_CHANGED, payload("2026-01-01T00:00:01Z"));
    await flush();
    const activeBefore = registry.current?.active;

    svc.setNext(resolution("gen-2"));
    bus.emit(DOMAIN_EVENTS.CAPABILITY_CHANGED, payload("2026-01-01T00:00:02Z"));
    await flush();
    expect(registry.current?.active).not.toBe(activeBefore);
    expect(disposer).toHaveBeenCalledTimes(1);

    registry.rollback();

    expect(registry.current?.phase).toBe("serving");
    expect(registry.current?.active).toBe(activeBefore);
    expect(registry.current?.retired).toBeNull();
    expect(disposer).toHaveBeenCalledTimes(1); // rollback 不额外释放
    registry.unsubscribe();
  });

  it("onModuleDestroy 退订后：emit 不再触发重解析与状态切换", async () => {
    const { bus, svc, disposer, registry } = makeHarness();
    bus.emit(DOMAIN_EVENTS.CAPABILITY_CHANGED, payload("2026-01-01T00:00:01Z"));
    await flush();
    const stateBefore = registry.current;

    registry.unsubscribe();
    svc.setNext(resolution("gen-2"));
    bus.emit(DOMAIN_EVENTS.CAPABILITY_CHANGED, payload("2026-01-01T00:00:02Z"));
    await flush();

    expect(registry.current).toBe(stateBefore);
    expect(svc.resolveFor).toHaveBeenCalledTimes(1);
    expect(disposer).toHaveBeenCalledTimes(0);
  });

  it("resolveFor 抛错（如 key 已 remove）：不产生新代，主链不受影响", async () => {
    const { bus, svc, disposer, registry } = makeHarness();
    bus.emit(DOMAIN_EVENTS.CAPABILITY_CHANGED, payload("2026-01-01T00:00:01Z"));
    await flush();
    const stateBefore = registry.current;

    svc.resolveFor.mockRejectedValueOnce(new Error("key not registered"));
    bus.emit(DOMAIN_EVENTS.CAPABILITY_CHANGED, payload("2026-01-01T00:00:02Z"));
    await flush();

    expect(registry.current).toBe(stateBefore);
    expect(disposer).toHaveBeenCalledTimes(0);
    registry.unsubscribe();
  });
});
