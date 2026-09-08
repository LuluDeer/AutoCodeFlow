/**
 * ARCH-21: DomainEventBus 单测——emit/on/off、fail-open、异步 reject 兜底、
 * 多监听器全派发、off 后不再收事件、listenerCount。
 */
import { Logger } from "@nestjs/common";
import {
  DomainEventBus,
  DomainEventListener,
} from "../domain-event-bus.service";
import {
  DOMAIN_EVENTS,
  ExecutionTerminalEventPayload,
} from "../../events/domain-events";

function failedPayload(
  overrides: Partial<ExecutionTerminalEventPayload> = {},
): ExecutionTerminalEventPayload {
  return {
    executionId: "e1",
    taskId: "t1",
    taskName: "job",
    status: "failed",
    failureReason: "script_error",
    finishedAt: new Date("2026-09-07T00:00:00Z").toISOString(),
    ...overrides,
  };
}

describe("DomainEventBus (ARCH-21)", () => {
  let bus: DomainEventBus;
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    bus = new DomainEventBus();
    // fail-open 路径会记 error 日志——静音断言噪声，测试本身断言其被调用。
    errorSpy = jest
      .spyOn(Logger.prototype, "error")
      .mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("emits payload to a registered listener", () => {
    const seen: ExecutionTerminalEventPayload[] = [];
    bus.on(DOMAIN_EVENTS.EXECUTION_FAILED, (p: ExecutionTerminalEventPayload) =>
      seen.push(p),
    );
    const payload = failedPayload();
    expect(bus.emit(DOMAIN_EVENTS.EXECUTION_FAILED, payload)).toBe(true);
    expect(seen).toEqual([payload]);
  });

  it("returns false and does not throw when nobody listens", () => {
    expect(bus.emit(DOMAIN_EVENTS.EXECUTION_COMPLETED, failedPayload())).toBe(
      false,
    );
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("delivers to ALL listeners of the same event in registration order", () => {
    const order: string[] = [];
    bus.on(DOMAIN_EVENTS.EXECUTION_FAILED, () => order.push("a"));
    bus.on(DOMAIN_EVENTS.EXECUTION_FAILED, () => order.push("b"));
    bus.emit(DOMAIN_EVENTS.EXECUTION_FAILED, failedPayload());
    expect(order).toEqual(["a", "b"]);
  });

  it("does not cross-deliver between different events", () => {
    const failed = jest.fn();
    const completed = jest.fn();
    bus.on(DOMAIN_EVENTS.EXECUTION_FAILED, failed);
    bus.on(DOMAIN_EVENTS.EXECUTION_COMPLETED, completed);
    bus.emit(
      DOMAIN_EVENTS.EXECUTION_COMPLETED,
      failedPayload({ status: "success", failureReason: null }),
    );
    expect(completed).toHaveBeenCalledTimes(1);
    expect(failed).not.toHaveBeenCalled();
  });

  it("fail-open: a synchronously throwing listener does not propagate to emit()", () => {
    bus.on(DOMAIN_EVENTS.EXECUTION_FAILED, () => {
      throw new Error("listener exploded");
    });
    const after = jest.fn();
    bus.on(DOMAIN_EVENTS.EXECUTION_FAILED, after);
    expect(() =>
      bus.emit(DOMAIN_EVENTS.EXECUTION_FAILED, failedPayload()),
    ).not.toThrow();
    // 抛错监听器不影响同事件其余监听器收到派发。
    expect(after).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy.mock.calls[0][0]).toMatch(/listener exploded/);
  });

  it("fail-open: an async listener rejection is swallowed and logged (no unhandledRejection)", () => {
    bus.on(DOMAIN_EVENTS.EXECUTION_FAILED, async () => {
      throw new Error("async boom");
    });
    expect(() =>
      bus.emit(DOMAIN_EVENTS.EXECUTION_FAILED, failedPayload()),
    ).not.toThrow();
    // 异步 rejection 的捕获走 microtask——等待一轮后再断言日志。
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        expect(errorSpy).toHaveBeenCalledTimes(1);
        expect(errorSpy.mock.calls[0][0]).toMatch(/async boom/);
        resolve();
      }, 0);
    });
  });

  it("off() removes the listener; re-on() works after off()", () => {
    const spy = jest.fn();
    bus.on(DOMAIN_EVENTS.EXECUTION_FAILED, spy as DomainEventListener);
    bus.emit(DOMAIN_EVENTS.EXECUTION_FAILED, failedPayload());
    expect(spy).toHaveBeenCalledTimes(1);

    bus.off(DOMAIN_EVENTS.EXECUTION_FAILED, spy as DomainEventListener);
    bus.emit(DOMAIN_EVENTS.EXECUTION_FAILED, failedPayload());
    expect(spy).toHaveBeenCalledTimes(1);

    bus.on(DOMAIN_EVENTS.EXECUTION_FAILED, spy as DomainEventListener);
    bus.emit(DOMAIN_EVENTS.EXECUTION_FAILED, failedPayload());
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("off() on an unregistered listener is a no-op", () => {
    const spy = jest.fn();
    expect(() =>
      bus.off(DOMAIN_EVENTS.EXECUTION_FAILED, spy as DomainEventListener),
    ).not.toThrow();
    expect(bus.listenerCount(DOMAIN_EVENTS.EXECUTION_FAILED)).toBe(0);
  });

  it("listenerCount tracks on/off bookkeeping", () => {
    const a = jest.fn();
    const b = jest.fn();
    expect(bus.listenerCount(DOMAIN_EVENTS.EXECUTION_FAILED)).toBe(0);
    bus.on(DOMAIN_EVENTS.EXECUTION_FAILED, a as DomainEventListener);
    bus.on(DOMAIN_EVENTS.EXECUTION_FAILED, b as DomainEventListener);
    expect(bus.listenerCount(DOMAIN_EVENTS.EXECUTION_FAILED)).toBe(2);
    bus.off(DOMAIN_EVENTS.EXECUTION_FAILED, a as DomainEventListener);
    expect(bus.listenerCount(DOMAIN_EVENTS.EXECUTION_FAILED)).toBe(1);
  });

  it("event name constants are stable contracts", () => {
    expect(DOMAIN_EVENTS.EXECUTION_COMPLETED).toBe("execution.completed");
    expect(DOMAIN_EVENTS.EXECUTION_FAILED).toBe("execution.failed");
  });
});
