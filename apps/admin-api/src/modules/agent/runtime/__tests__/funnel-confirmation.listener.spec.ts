/**
 * R325：FunnelConfirmationListener 的内存替身单测。
 * 只钉 listener 分支逻辑、回查链、匿名 ID 派生、写入字段投影、生命周期与
 * fail-open；不证明真实 PG/Nest 装配（由真库 e2e 覆盖）。
 */
import { Logger } from "@nestjs/common";
import type { Repository } from "typeorm";

import {
  DOMAIN_EVENTS,
  type ExecutionConfirmedEventPayload,
} from "../../../../common/events/domain-events";
import type { DomainEventBus } from "../../../../common/services/domain-event-bus.service";
import type { SecretsCryptoService } from "../../../../common/utils/secret-crypto.util.service";
import type { Executor } from "../../../executor/entities/executor.entity";
import type { TaskExecution } from "../../../task/entities/task-execution.entity";
import { FunnelConfirmationListener } from "../funnel-confirmation.listener";
import type { FunnelEventsService } from "../funnel-events.service";

interface Harness {
  listener: FunnelConfirmationListener;
  bus: { on: jest.Mock; off: jest.Mock };
  executionRepo: { findOne: jest.Mock };
  executorRepo: { findOne: jest.Mock };
  crypto: { deriveAnonymousId: jest.Mock };
  funnel: { record: jest.Mock };
}

const confirmedEvent = (
  overrides: Partial<ExecutionConfirmedEventPayload> = {},
): ExecutionConfirmedEventPayload => ({
  executionId: "exec-1",
  taskId: "task-1",
  confirmedAt: "2026-11-21T12:34:56.000Z",
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
  const listener = new FunnelConfirmationListener(
    bus as unknown as DomainEventBus,
    funnel as unknown as FunnelEventsService,
    crypto as unknown as SecretsCryptoService,
    executionRepo as unknown as Repository<TaskExecution>,
    executorRepo as unknown as Repository<Executor>,
  );
  return { listener, bus, executionRepo, executorRepo, crypto, funnel };
};

describe("FunnelConfirmationListener (R325 business_confirmed)", () => {
  afterEach(() => jest.restoreAllMocks());

  it("① 全字段齐：回查链正确，record 一次且 data 精确（dedupeKey=confirmed:<hash>）", async () => {
    const h = makeHarness();
    const event = confirmedEvent();

    await h.listener.onConfirmed(event);

    expect(h.executionRepo.findOne).toHaveBeenCalledWith({
      where: { id: "exec-1" },
    });
    expect(h.executorRepo.findOne).toHaveBeenCalledWith({
      where: { id: "executor-1" },
    });
    expect(h.crypto.deriveAnonymousId.mock.calls).toEqual([
      ["fp-1", "ttfv-install"],
      ["exec-1", "ttfv-execution"],
      ["task-1", "ttfv-task"],
    ]);
    expect(h.funnel.record).toHaveBeenCalledTimes(1);
    expect(h.funnel.record).toHaveBeenCalledWith({
      installId: "ttfv-install:fp-1",
      eventName: "business_confirmed",
      executionIdHash: "ttfv-execution:exec-1",
      taskIdHash: "ttfv-task:task-1",
      dedupeKey: "confirmed:ttfv-execution:exec-1",
      ts: new Date("2026-11-21T12:34:56.000Z"),
    });
  });

  it("② taskId=null：record 仍调用、taskIdHash=null（北极星按 execution+install 聚合）", async () => {
    const h = makeHarness();

    await h.listener.onConfirmed(confirmedEvent({ taskId: null }));

    expect(h.crypto.deriveAnonymousId.mock.calls).toEqual([
      ["fp-1", "ttfv-install"],
      ["exec-1", "ttfv-execution"],
    ]);
    expect(h.funnel.record).toHaveBeenCalledTimes(1);
    expect(h.funnel.record).toHaveBeenCalledWith(
      expect.objectContaining({
        taskIdHash: null,
        dedupeKey: "confirmed:ttfv-execution:exec-1",
      }),
    );
  });

  it("③ confirmedAt 缺失：不 record（不以当前时间伪造 ts）", async () => {
    const h = makeHarness();

    await h.listener.onConfirmed(confirmedEvent({ confirmedAt: "" }));

    expect(h.executionRepo.findOne).not.toHaveBeenCalled();
    expect(h.crypto.deriveAnonymousId).not.toHaveBeenCalled();
    expect(h.funnel.record).not.toHaveBeenCalled();
  });

  it("④ execution 缺（findOne=null）：不 record", async () => {
    const h = makeHarness();
    h.executionRepo.findOne.mockResolvedValue(null);

    await h.listener.onConfirmed(confirmedEvent());

    expect(h.executorRepo.findOne).not.toHaveBeenCalled();
    expect(h.crypto.deriveAnonymousId).not.toHaveBeenCalled();
    expect(h.funnel.record).not.toHaveBeenCalled();
  });

  it("⑤ synthetic=true：回查后跳过，不查 executor / 不派生 / 不写入", async () => {
    const h = makeHarness();
    h.executionRepo.findOne.mockResolvedValue({
      id: "exec-1",
      executorId: "executor-1",
      synthetic: true,
    });

    await h.listener.onConfirmed(confirmedEvent());

    expect(h.executionRepo.findOne).toHaveBeenCalledWith({
      where: { id: "exec-1" },
    });
    expect(h.executorRepo.findOne).not.toHaveBeenCalled();
    expect(h.crypto.deriveAnonymousId).not.toHaveBeenCalled();
    expect(h.funnel.record).not.toHaveBeenCalled();
  });

  it("⑥a 指纹缺：不派生 / 不写入", async () => {
    const h = makeHarness();
    h.executorRepo.findOne.mockResolvedValue({
      id: "executor-1",
      deviceFingerprint: null,
    });

    await h.listener.onConfirmed(confirmedEvent());

    expect(h.crypto.deriveAnonymousId).not.toHaveBeenCalled();
    expect(h.funnel.record).not.toHaveBeenCalled();
  });

  it("⑥b deriveAnonymousId 返回 null（无密钥 degraded）：不写入", async () => {
    const h = makeHarness();
    h.crypto.deriveAnonymousId.mockReturnValue(null);

    await h.listener.onConfirmed(confirmedEvent());

    expect(h.crypto.deriveAnonymousId).toHaveBeenCalledTimes(1);
    expect(h.funnel.record).not.toHaveBeenCalled();
  });

  it("⑦ funnel.record 抛错：listener 不 throw（fail-open）+ warn", async () => {
    const h = makeHarness();
    const warn = jest.spyOn(Logger.prototype, "warn").mockImplementation();
    h.funnel.record.mockRejectedValue(new Error("db down"));

    await expect(
      h.listener.onConfirmed(confirmedEvent()),
    ).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalled();
    expect(h.funnel.record).toHaveBeenCalledTimes(1);
  });

  it("⑧ viaRelay=true：零回查零写入（多副本不双写，防御性检查）", async () => {
    const h = makeHarness();

    await h.listener.onConfirmed({
      ...confirmedEvent(),
      viaRelay: true,
    } as ExecutionConfirmedEventPayload & { viaRelay: true });

    expect(h.executionRepo.findOne).not.toHaveBeenCalled();
    expect(h.executorRepo.findOne).not.toHaveBeenCalled();
    expect(h.funnel.record).not.toHaveBeenCalled();
  });

  it("⑨ executionId 缺：跳过，零回查零写入", async () => {
    const h = makeHarness();

    await h.listener.onConfirmed(confirmedEvent({ executionId: "" }));

    expect(h.executionRepo.findOne).not.toHaveBeenCalled();
    expect(h.funnel.record).not.toHaveBeenCalled();
  });

  it("⑩ 生命周期：onModuleInit 订阅 confirmed，onModuleDestroy 同一引用退订", () => {
    const h = makeHarness();
    h.listener.onModuleInit();

    expect(h.bus.on).toHaveBeenCalledWith(
      DOMAIN_EVENTS.EXECUTION_CONFIRMED,
      h.listener.onConfirmed,
    );

    h.listener.onModuleDestroy();
    expect(h.bus.off).toHaveBeenCalledWith(
      DOMAIN_EVENTS.EXECUTION_CONFIRMED,
      h.listener.onConfirmed,
    );
  });
});
