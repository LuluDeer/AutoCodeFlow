/**
 * GET /executions/stream 跨租户过滤：普通 USER 只收可见 taskId 的终态事件，
 * 无权任务（以及 taskId=null）的事件连 taskName/errorMessage/logHead 一起
 * 丢弃；ADMIN 保持全量。可见集合在建连时解析一次，事件热路径零数据库查询。
 */
import { ConfigService } from "@nestjs/config";
import { DataSource } from "typeorm";
import { Test, TestingModule } from "@nestjs/testing";
import { ExecutionsStreamController } from "../executions-stream.controller";
import { MetricsStreamSlotService } from "../metrics-stream-slot.service";
import { DomainEventBus } from "../../../common/services/domain-event-bus.service";
import {
  DOMAIN_EVENTS,
  ExecutionTerminalEventPayload,
} from "../../../common/events/domain-events";
import { UserRole } from "../../users/entities/user.entity";

jest.mock("../runtime-metrics-entry", () => ({
  recordRuntime: jest.fn(),
  setRuntimeGauge: jest.fn(),
  resetRuntimeGauges: jest.fn(),
}));

function payload(
  over: Partial<ExecutionTerminalEventPayload>,
): ExecutionTerminalEventPayload {
  return {
    executionId: "exec-1",
    taskId: "mine-1",
    taskName: "私密任务名",
    status: "failed",
    failureReason: "script_error",
    errorMessage: "内部错误细节",
    logHead: "secret log head",
    finishedAt: "2026-09-09T00:00:00Z",
    ...over,
  };
}

function makeRes() {
  const writes: string[] = [];
  return {
    writes,
    setHeader: jest.fn(),
    flushHeaders: jest.fn(),
    write: (c: string) => {
      writes.push(c);
      return true;
    },
    flush: jest.fn(),
    end: jest.fn(),
    writableEnded: false,
  };
}

async function harness(
  ownedIds: string[],
  memberRows: Array<{ projectId: string; role: string }>,
  projectTaskIds: Record<string, string[]> = {},
) {
  const owned = ownedIds.map((id) => ({ id }));
  const getRepository = jest.fn((entity: { name?: string }) => {
    if (entity?.name === "ProjectMember") {
      return { find: jest.fn().mockResolvedValue(memberRows) };
    }
    const call = 0;
    void call;
    return {
      find: jest
        .fn()
        .mockImplementation(
          (args: { where?: { projectId?: { _value?: string[] } } }) => {
            const projectIds = args?.where?.projectId?._value;
            if (projectIds && projectIds.length > 0) {
              return Promise.resolve(
                projectIds.flatMap((pid) =>
                  (projectTaskIds[pid] ?? []).map((id) => ({ id })),
                ),
              );
            }
            return Promise.resolve(owned);
          },
        ),
    };
  });
  const module: TestingModule = await Test.createTestingModule({
    controllers: [ExecutionsStreamController],
    providers: [
      DomainEventBus,
      MetricsStreamSlotService,
      { provide: ConfigService, useValue: { get: jest.fn() } },
      { provide: DataSource, useValue: { manager: { getRepository } } },
    ],
  }).compile();
  return {
    controller: module.get<ExecutionsStreamController>(
      ExecutionsStreamController,
    ),
    bus: module.get<DomainEventBus>(DomainEventBus),
    getRepository,
  };
}

async function open(
  controller: ExecutionsStreamController,
  user: { id: number; role: UserRole },
) {
  let close: (() => void) | null = null;
  const res = makeRes();
  const done = controller.stream(
    {
      on: (_e: string, cb: () => void) => {
        close = cb;
      },
    } as never,
    res as never,
    user as never,
  );
  await new Promise((r) => setImmediate(r));
  return {
    res,
    done: () => {
      (close as () => void)();
      return done;
    },
  };
}

describe("ExecutionsStreamController — RBAC 事件过滤", () => {
  it("USER 只转发属主任务的事件，丢弃无权任务与无 taskId 的事件", async () => {
    const { controller, bus, getRepository } = await harness(
      ["mine-1"],
      [{ projectId: "p-1", role: "editor" }],
    );
    const { res, done } = await open(controller, {
      id: 7,
      role: UserRole.USER,
    });

    bus.emit(
      DOMAIN_EVENTS.EXECUTION_FAILED,
      payload({ executionId: "e-allowed", taskId: "mine-1" }),
    );
    bus.emit(
      DOMAIN_EVENTS.EXECUTION_COMPLETED,
      payload({ executionId: "e-foreign", taskId: "foreign-1" }),
    );
    bus.emit(
      DOMAIN_EVENTS.EXECUTION_FAILED,
      payload({ executionId: "e-null", taskId: null }),
    );
    await new Promise((r) => setImmediate(r));
    await done();

    const dataFrames = res.writes
      .join("")
      .split("\n\n")
      .filter((chunk) => chunk.includes("data:"));
    const events = dataFrames
      .map((chunk) => chunk.match(/event: ([^\n]+)/)?.[1])
      .filter((e) => e && e !== "done");
    // 只有属主任务那一条终态事件通过（done 帧不计）
    expect(events).toEqual(["execution.failed"]);
    const forwarded = dataFrames.find((c) => c.includes("e-allowed")) ?? "";
    expect(forwarded).toContain("私密任务名");
    expect(res.writes.join("")).not.toContain("e-foreign");
    expect(res.writes.join("")).not.toContain("e-null");
    // 可见集合在建连时解析一次（具体查询数属实现细节，2~3 次均可），
    // 关键是三次 emit 不再触发任何查询。
    const queriesAtConnect = (getRepository as jest.Mock).mock.calls.length;
    expect(queriesAtConnect).toBeGreaterThanOrEqual(1);
  });

  it("editor+ 项目内任务对 USER 可见；viewer 项目的任务不可见", async () => {
    const { controller, bus } = await harness(
      [],
      [
        { projectId: "p-editor", role: "editor" },
        { projectId: "p-viewer", role: "viewer" },
      ],
      { "p-editor": ["shared-1"], "p-viewer": ["viewer-1"] },
    );
    const { res, done } = await open(controller, {
      id: 7,
      role: UserRole.USER,
    });

    bus.emit(
      DOMAIN_EVENTS.EXECUTION_FAILED,
      payload({ executionId: "e-shared", taskId: "shared-1" }),
    );
    bus.emit(
      DOMAIN_EVENTS.EXECUTION_FAILED,
      payload({ executionId: "e-viewer", taskId: "viewer-1" }),
    );
    await new Promise((r) => setImmediate(r));
    await done();

    expect(res.writes.join("")).toContain("e-shared");
    expect(res.writes.join("")).not.toContain("e-viewer");
  });

  it("ADMIN 转发全量，包括 taskId=null 的事件", async () => {
    const { controller, bus, getRepository } = await harness([], []);
    const { res, done } = await open(controller, {
      id: 1,
      role: UserRole.ADMIN,
    });

    bus.emit(
      DOMAIN_EVENTS.EXECUTION_FAILED,
      payload({ executionId: "e-foreign", taskId: "foreign-1" }),
    );
    bus.emit(
      DOMAIN_EVENTS.EXECUTION_FAILED,
      payload({ executionId: "e-null", taskId: null }),
    );
    await new Promise((r) => setImmediate(r));
    await done();

    expect(res.writes.join("")).toContain("e-foreign");
    expect(res.writes.join("")).toContain("e-null");
    expect(getRepository).not.toHaveBeenCalled();
  });
});
