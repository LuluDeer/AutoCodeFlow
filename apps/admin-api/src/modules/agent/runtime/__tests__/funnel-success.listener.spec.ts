/**
 * R307：FunnelSuccessListener 的内存替身单测。
 * 只钉 listener 分支逻辑：事件过滤、回查链、匿名 ID 派生、写入字段投影、
 * 生命周期与 fail-open；不证明真实 PG/Nest 装配（由集成验收覆盖）。
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
import { FunnelSuccessListener } from "../funnel-success.listener";
import type { FunnelEventsService } from "../funnel-events.service";

interface Harness {
  listener: FunnelSuccessListener;
  bus: { on: jest.Mock; off: jest.Mock };
  executionRepo: { findOne: jest.Mock };
  executorRepo: { findOne: jest.Mock };
  crypto: { deriveAnonymousId: jest.Mock };
  funnel: { record: jest.Mock };
}

const successEvent = (
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
  const listener = new FunnelSuccessListener(
    bus as unknown as DomainEventBus,
    funnel as unknown as FunnelEventsService,
    crypto as unknown as SecretsCryptoService,
    executionRepo as unknown as Repository<TaskExecution>,
    executorRepo as unknown as Repository<Executor>,
  );
  return { listener, bus, executionRepo, executorRepo, crypto, funnel };
};

describe("FunnelSuccessListener (R307 task_first_success)", () => {
  afterEach(() => jest.restoreAllMocks());

  it("viaRelay=true：零回查零写入（多副本不双写）", async () => {
    const h = makeHarness();
    await h.listener.onCompleted(successEvent({ viaRelay: true }));

    expect(h.executionRepo.findOne).not.toHaveBeenCalled();
    expect(h.executorRepo.findOne).not.toHaveBeenCalled();
    expect(h.crypto.deriveAnonymousId).not.toHaveBeenCalled();
    expect(h.funnel.record).not.toHaveBeenCalled();
  });

  it("status != success：零回查零写入（防御性过滤）", async () => {
    const h = makeHarness();
    await h.listener.onCompleted(successEvent({ status: "failed" }));

    expect(h.executionRepo.findOne).not.toHaveBeenCalled();
    expect(h.funnel.record).not.toHaveBeenCalled();
  });

  it("正常链路：按 executionId→executorId→指纹回查，写入字段正确", async () => {
    const h = makeHarness();
    const event = successEvent();

    await h.listener.onCompleted(event);

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
      eventName: "task_first_success",
      taskIdHash: "ttfv-task:task-1",
      executionIdHash: "ttfv-execution:exec-1",
      dedupeKey: "first-success:ttfv-task:task-1",
      ts: new Date("2026-11-21T12:34:56.000Z"),
    });
  });

  it("taskId 为 null：跳过，零回查零 record（不用 executionId 冒充 taskId）", async () => {
    const h = makeHarness();
    await h.listener.onCompleted(successEvent({ taskId: null }));

    expect(h.executionRepo.findOne).not.toHaveBeenCalled();
    expect(h.crypto.deriveAnonymousId).not.toHaveBeenCalled();
    expect(h.funnel.record).not.toHaveBeenCalled();
  });

  it("finishedAt 缺失：跳过，零回查零 record（不用当前时间伪造 ts）", async () => {
    const h = makeHarness();
    await h.listener.onCompleted(successEvent({ finishedAt: "" }));

    expect(h.executionRepo.findOne).not.toHaveBeenCalled();
    expect(h.crypto.deriveAnonymousId).not.toHaveBeenCalled();
    expect(h.funnel.record).not.toHaveBeenCalled();
  });

  it("synthetic=true 执行行：回查后跳过，不查 executor / 不派生 / 不写入（合成行非真实成功）", async () => {
    const h = makeHarness();
    h.executionRepo.findOne.mockResolvedValue({
      id: "exec-1",
      executorId: "executor-1",
      synthetic: true,
    });
    await h.listener.onCompleted(successEvent());

    expect(h.executionRepo.findOne).toHaveBeenCalledWith({
      where: { id: "exec-1" },
    });
    expect(h.executorRepo.findOne).not.toHaveBeenCalled();
    expect(h.crypto.deriveAnonymousId).not.toHaveBeenCalled();
    expect(h.funnel.record).not.toHaveBeenCalled();
  });

  it("execution 无 executorId：跳过，不查 executor / 不写入", async () => {
    const h = makeHarness();
    h.executionRepo.findOne.mockResolvedValue({
      id: "exec-1",
      executorId: null,
    });

    await h.listener.onCompleted(successEvent());

    expect(h.executorRepo.findOne).not.toHaveBeenCalled();
    expect(h.crypto.deriveAnonymousId).not.toHaveBeenCalled();
    expect(h.funnel.record).not.toHaveBeenCalled();
  });

  it("executor 无指纹：跳过，不派生 / 不写入", async () => {
    const h = makeHarness();
    h.executorRepo.findOne.mockResolvedValue({
      id: "executor-1",
      deviceFingerprint: null,
    });

    await h.listener.onCompleted(successEvent());

    expect(h.crypto.deriveAnonymousId).not.toHaveBeenCalled();
    expect(h.funnel.record).not.toHaveBeenCalled();
  });

  it("deriveAnonymousId 返回 null（无密钥）：跳过写入", async () => {
    const h = makeHarness();
    h.crypto.deriveAnonymousId.mockReturnValue(null);

    await h.listener.onCompleted(successEvent());

    expect(h.crypto.deriveAnonymousId).toHaveBeenCalledTimes(1);
    expect(h.funnel.record).not.toHaveBeenCalled();
  });

  it("回查/写入异常：warn 吞异常，不向主链抛出", async () => {
    const h = makeHarness();
    const warn = jest.spyOn(Logger.prototype, "warn").mockImplementation();
    h.executionRepo.findOne.mockRejectedValue(new Error("db down"));

    await expect(
      h.listener.onCompleted(successEvent()),
    ).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalled();
    expect(h.funnel.record).not.toHaveBeenCalled();
  });

  it("生命周期：onModuleInit 订阅 completed，onModuleDestroy 同一引用退订", () => {
    const h = makeHarness();
    h.listener.onModuleInit();

    expect(h.bus.on).toHaveBeenCalledWith(
      DOMAIN_EVENTS.EXECUTION_COMPLETED,
      h.listener.onCompleted,
    );

    h.listener.onModuleDestroy();
    expect(h.bus.off).toHaveBeenCalledWith(
      DOMAIN_EVENTS.EXECUTION_COMPLETED,
      h.listener.onCompleted,
    );
  });
});
