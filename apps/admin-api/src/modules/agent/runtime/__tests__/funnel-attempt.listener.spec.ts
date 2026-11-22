/**
 * R318：FunnelAttemptListener 的内存替身单测。
 * 只钉 listener 分支逻辑：双终态订阅/退订、事件过滤、synthetic 排除、
 * 回查链、匿名 ID 派生、写入字段投影与 fail-open；不证明真实 PG/Nest 装配
 * （由更高一级集成验收覆盖）。
 */
import { Logger } from "@nestjs/common";
import type { Repository } from "typeorm";

import {
  DOMAIN_EVENTS,
  type ExecutionTerminalEventPayload,
} from "../../../../common/events/domain-events";
import type { DomainEventBus } from "../../../../common/services/domain-event-bus.service";
import type { SecretsCryptoService } from "../../../../common/utils/secret-crypto.util.service";
import type { Executor } from "../../../executor/entities/executor.entity";
import type { TaskExecution } from "../../../task/entities/task-execution.entity";
import { FunnelAttemptListener } from "../funnel-attempt.listener";
import type { FunnelEventsService } from "../funnel-events.service";

interface Harness {
  listener: FunnelAttemptListener;
  bus: { on: jest.Mock; off: jest.Mock };
  executionRepo: { findOne: jest.Mock };
  executorRepo: { findOne: jest.Mock };
  crypto: { deriveAnonymousId: jest.Mock };
  funnel: { record: jest.Mock };
}

const terminalEvent = (
  overrides: Partial<ExecutionTerminalEventPayload> = {},
): ExecutionTerminalEventPayload => ({
  executionId: "exec-1",
  taskId: "task-1",
  taskName: "nightly-etl",
  status: "success",
  failureReason: null,
  finishedAt: "2026-11-21T12:34:56.000Z",
  ...overrides,
});

const makeHarness = (): Harness => {
  const bus = { on: jest.fn(), off: jest.fn() };
  const executionRepo = {
    findOne: jest.fn(async () => ({ id: "exec-1", executorId: "executor-1" })),
  };
  const executorRepo = {
    findOne: jest.fn(async () => ({
      id: "executor-1",
      deviceFingerprint: "fp-1",
    })),
  };
  const crypto = {
    deriveAnonymousId: jest.fn(
      (input: string, purpose: string) => `${purpose}:${input}`,
    ),
  };
  const funnel = { record: jest.fn(async () => ({ recorded: true })) };
  const listener = new FunnelAttemptListener(
    bus as unknown as DomainEventBus,
    funnel as unknown as FunnelEventsService,
    crypto as unknown as SecretsCryptoService,
    executionRepo as unknown as Repository<TaskExecution>,
    executorRepo as unknown as Repository<Executor>,
  );
  return { listener, bus, executionRepo, executorRepo, crypto, funnel };
};

describe("FunnelAttemptListener (R318 task_first_attempted)", () => {
  afterEach(() => jest.restoreAllMocks());

  it("viaRelay=true：零回查零写入（多副本不双写）", async () => {
    const h = makeHarness();
    await h.listener.onFirstAttempted(terminalEvent({ viaRelay: true }));

    expect(h.executionRepo.findOne).not.toHaveBeenCalled();
    expect(h.executorRepo.findOne).not.toHaveBeenCalled();
    expect(h.crypto.deriveAnonymousId).not.toHaveBeenCalled();
    expect(h.funnel.record).not.toHaveBeenCalled();
  });

  it("COMPLETED(success) 正常链路：写入 task_first_attempted 且字段正确", async () => {
    const h = makeHarness();
    await h.listener.onFirstAttempted(terminalEvent({ status: "success" }));

    expect(h.executionRepo.findOne).toHaveBeenCalledWith({
      where: { id: "exec-1" },
    });
    expect(h.executorRepo.findOne).toHaveBeenCalledWith({
      where: { id: "executor-1" },
    });
    expect(h.crypto.deriveAnonymousId.mock.calls).toEqual([
      ["fp-1", "ttfv-install"],
      ["task-1", "ttfv-task"],
      ["exec-1", "ttfv-execution"],
    ]);
    expect(h.funnel.record).toHaveBeenCalledTimes(1);
    expect(h.funnel.record).toHaveBeenCalledWith({
      installId: "ttfv-install:fp-1",
      eventName: "task_first_attempted",
      taskIdHash: "ttfv-task:task-1",
      executionIdHash: "ttfv-execution:exec-1",
      dedupeKey: "first-attempted:ttfv-task:task-1",
      ts: new Date("2026-11-21T12:34:56.000Z"),
    });
  });

  it("FAILED(failed) 也写：失败终态算首次尝试（近似消除的关键分支）", async () => {
    const h = makeHarness();
    await h.listener.onFirstAttempted(
      terminalEvent({ status: "failed", failureReason: "RUNTIME_ERROR" }),
    );

    expect(h.funnel.record).toHaveBeenCalledTimes(1);
    expect(h.funnel.record).toHaveBeenCalledWith(
      expect.objectContaining({
        eventName: "task_first_attempted",
        dedupeKey: "first-attempted:ttfv-task:task-1",
      }),
    );
  });

  it("timeout 失败类 status 同样写入（FAILED 事件载荷）", async () => {
    // 注：killed 不经 FAILED 事件——它走独立 EXECUTION_KILLED（见生命周期用例的三事件订阅断言）。
    const h = makeHarness();
    await h.listener.onFirstAttempted(terminalEvent({ status: "timeout" }));
    expect(h.funnel.record).toHaveBeenCalledTimes(1);
  });

  it("synthetic=true 执行行：回查后跳过，不查 executor / 不派生 / 不写入", async () => {
    const h = makeHarness();
    h.executionRepo.findOne.mockResolvedValue({
      id: "exec-1",
      executorId: "executor-1",
      synthetic: true,
    });

    await h.listener.onFirstAttempted(terminalEvent());

    expect(h.executionRepo.findOne).toHaveBeenCalledWith({
      where: { id: "exec-1" },
    });
    expect(h.executorRepo.findOne).not.toHaveBeenCalled();
    expect(h.crypto.deriveAnonymousId).not.toHaveBeenCalled();
    expect(h.funnel.record).not.toHaveBeenCalled();
  });

  it("taskId 为 null：跳过，零回查零 record（不用 executionId 冒充 taskId）", async () => {
    const h = makeHarness();
    await h.listener.onFirstAttempted(terminalEvent({ taskId: null }));

    expect(h.executionRepo.findOne).not.toHaveBeenCalled();
    expect(h.crypto.deriveAnonymousId).not.toHaveBeenCalled();
    expect(h.funnel.record).not.toHaveBeenCalled();
  });

  it("finishedAt 缺失：跳过，零回查零 record（不用当前时间伪造 ts）", async () => {
    const h = makeHarness();
    await h.listener.onFirstAttempted(terminalEvent({ finishedAt: "" }));

    expect(h.executionRepo.findOne).not.toHaveBeenCalled();
    expect(h.crypto.deriveAnonymousId).not.toHaveBeenCalled();
    expect(h.funnel.record).not.toHaveBeenCalled();
  });

  it("execution 无 executorId：跳过，不查 executor / 不写入", async () => {
    const h = makeHarness();
    h.executionRepo.findOne.mockResolvedValue({
      id: "exec-1",
      executorId: null,
    });

    await h.listener.onFirstAttempted(terminalEvent());

    expect(h.executorRepo.findOne).not.toHaveBeenCalled();
    expect(h.funnel.record).not.toHaveBeenCalled();
  });

  it("executor 无指纹 / deriveAnonymousId 返回 null：跳过写入", async () => {
    const noFingerprint = makeHarness();
    noFingerprint.executorRepo.findOne.mockResolvedValue({
      id: "executor-1",
      deviceFingerprint: null,
    });
    await noFingerprint.listener.onFirstAttempted(terminalEvent());
    expect(noFingerprint.crypto.deriveAnonymousId).not.toHaveBeenCalled();
    expect(noFingerprint.funnel.record).not.toHaveBeenCalled();

    const noKey = makeHarness();
    noKey.crypto.deriveAnonymousId.mockReturnValue(null);
    await noKey.listener.onFirstAttempted(terminalEvent());
    expect(noKey.crypto.deriveAnonymousId).toHaveBeenCalledTimes(1);
    expect(noKey.funnel.record).not.toHaveBeenCalled();
  });

  it("生命周期：onModuleInit 订阅 completed+failed+killed 三个终态事件，destroy 同引用退订", () => {
    const h = makeHarness();
    h.listener.onModuleInit();

    // 三个终态事件都必须订阅：killed 走独立 EXECUTION_KILLED，不经 FAILED（R318 C 复核补齐）。
    expect(h.bus.on.mock.calls).toEqual([
      [DOMAIN_EVENTS.EXECUTION_COMPLETED, h.listener.onFirstAttempted],
      [DOMAIN_EVENTS.EXECUTION_FAILED, h.listener.onFirstAttempted],
      [DOMAIN_EVENTS.EXECUTION_KILLED, h.listener.onFirstAttempted],
    ]);

    h.listener.onModuleDestroy();
    expect(h.bus.off.mock.calls).toEqual([
      [DOMAIN_EVENTS.EXECUTION_COMPLETED, h.listener.onFirstAttempted],
      [DOMAIN_EVENTS.EXECUTION_FAILED, h.listener.onFirstAttempted],
      [DOMAIN_EVENTS.EXECUTION_KILLED, h.listener.onFirstAttempted],
    ]);
  });

  it("回查/写入异常：warn 吞异常，不向主链抛出", async () => {
    const h = makeHarness();
    const warn = jest.spyOn(Logger.prototype, "warn").mockImplementation();
    h.executionRepo.findOne.mockRejectedValue(new Error("db down"));

    await expect(
      h.listener.onFirstAttempted(terminalEvent()),
    ).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalled();
    expect(h.funnel.record).not.toHaveBeenCalled();
  });
});
