/**
 * R325（北极星 §6 步骤 1-2）：AgentExecutionConfirmationService 的内存替身单测。
 *
 * 只钉 service 自身的分支逻辑（存在/不存在/taskId=null/emit fail-open/无遥测
 * 依赖）；不证明真 PG/Nest 装配（由主 agent 集成后的真库 e2e 覆盖）。
 */
import { Logger } from "@nestjs/common";
import type { Repository } from "typeorm";

import {
  DOMAIN_EVENTS,
  type ExecutionConfirmedEventPayload,
} from "../../../../common/events/domain-events";
import type { DomainEventBus } from "../../../../common/services/domain-event-bus.service";
import type { TaskExecution } from "../../../task/entities/task-execution.entity";
import { AgentExecutionConfirmationService } from "../agent-execution-confirmation.service";

const FIXED_NOW = "2026-11-21T12:34:56.000Z";

interface Harness {
  service: AgentExecutionConfirmationService;
  bus: { emit: jest.Mock };
  executions: { findOne: jest.Mock };
}

const makeHarness = (
  execution: Partial<TaskExecution> | null = { id: "exec-1", taskId: "task-1" },
  emitImpl: (...args: unknown[]) => unknown = () => true,
): Harness => {
  const bus = { emit: jest.fn(emitImpl) };
  const executions = {
    findOne: jest.fn(async () => (execution === null ? null : execution)),
  };
  const service = new AgentExecutionConfirmationService(
    bus as unknown as DomainEventBus,
    executions as unknown as Repository<TaskExecution>,
  );
  return { service, bus, executions };
};

describe("AgentExecutionConfirmationService (R325 execution.confirmed)", () => {
  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  it("① execution 存在：按 id 回查、emit 一次、载荷精确、返回 ok:true", async () => {
    jest.useFakeTimers().setSystemTime(new Date(FIXED_NOW));
    const h = makeHarness();

    const result = await h.service.confirm("exec-1");

    expect(h.executions.findOne).toHaveBeenCalledTimes(1);
    expect(h.executions.findOne).toHaveBeenCalledWith({
      where: { id: "exec-1" },
    });
    expect(h.bus.emit).toHaveBeenCalledTimes(1);
    const [event, payload] = h.bus.emit.mock.calls[0] as [
      string,
      ExecutionConfirmedEventPayload,
    ];
    expect(event).toBe(DOMAIN_EVENTS.EXECUTION_CONFIRMED);
    expect(event).toBe("execution.confirmed");
    expect(payload).toEqual({
      executionId: "exec-1",
      taskId: "task-1",
      confirmedAt: FIXED_NOW,
    });
    expect(result).toEqual({ ok: true, confirmedAt: FIXED_NOW });
  });

  it("② execution 不存在：不 emit、返回 ok:false reason=not_found（不抛，端点定 404）", async () => {
    const bus = { emit: jest.fn() };
    const executions = {
      findOne: jest.fn(async ({ where }: { where: { id: string } }) =>
        where.id === "exec-1" ? { id: "exec-1", taskId: "task-1" } : null,
      ),
    };
    const service = new AgentExecutionConfirmationService(
      bus as unknown as DomainEventBus,
      executions as unknown as Repository<TaskExecution>,
    );

    // 正对照：同一 harness 对存在的 execution 确实 emit ⇒ 下面的「不 emit」不是空断言。
    await service.confirm("exec-1");
    expect(bus.emit).toHaveBeenCalledTimes(1);
    bus.emit.mockClear();
    executions.findOne.mockClear();

    await expect(service.confirm("missing-exec")).resolves.toEqual({
      ok: false,
      reason: "not_found",
    });
    expect(executions.findOne).toHaveBeenCalledWith({
      where: { id: "missing-exec" },
    });
    expect(bus.emit).not.toHaveBeenCalled();
  });

  it("③ taskId=null 的 execution：载荷 taskId 原样为 null（不用 executionId 冒充）", async () => {
    jest.useFakeTimers().setSystemTime(new Date(FIXED_NOW));
    const h = makeHarness({ id: "exec-2", taskId: null });

    const result = await h.service.confirm("exec-2");

    expect(h.bus.emit).toHaveBeenCalledTimes(1);
    expect(h.bus.emit.mock.calls[0][1]).toEqual({
      executionId: "exec-2",
      taskId: null,
      confirmedAt: FIXED_NOW,
    });
    expect(result).toEqual({ ok: true, confirmedAt: FIXED_NOW });
  });

  it("④ emit 抛错：service 仍返回 ok:true（fail-open，遥测失败不回灌业务）", async () => {
    jest
      .spyOn(Logger.prototype, "warn")
      .mockImplementation(() => undefined as never);
    const h = makeHarness({ id: "exec-3", taskId: "task-3" }, () => {
      throw new Error("bus down");
    });

    await expect(h.service.confirm("exec-3")).resolves.toEqual({
      ok: true,
      confirmedAt: expect.any(String),
    });
    expect(h.bus.emit).toHaveBeenCalledTimes(1);
  });

  it("⑤ 确认路径不注入 telemetry/funnel（结构断言：构造器只有 bus + execution repo）", async () => {
    // 构造器恰好 2 个位置参数：DomainEventBus + Repository<TaskExecution>。
    // 没有 FunnelEventsService / TelemetryOptinService 可注入 ⇒ 结构上不可能
    // 因 telemetry 未授权而失败，也不会在本层写漏斗（§7 解耦）。
    expect(AgentExecutionConfirmationService.length).toBe(2);

    const h = makeHarness();
    await h.service.confirm("exec-1");
    expect(h.bus.emit).toHaveBeenCalledTimes(1);
    expect(h.executions.findOne).toHaveBeenCalledTimes(1);
  });

  it("⑥ 查库异常向上抛（端点 5xx），且不 emit", async () => {
    const executions = {
      findOne: jest.fn(async () => {
        throw new Error("db down");
      }),
    };
    const bus = { emit: jest.fn() };
    const service = new AgentExecutionConfirmationService(
      bus as unknown as DomainEventBus,
      executions as unknown as Repository<TaskExecution>,
    );

    await expect(service.confirm("exec-4")).rejects.toThrow("db down");
    expect(bus.emit).not.toHaveBeenCalled();
  });
});
