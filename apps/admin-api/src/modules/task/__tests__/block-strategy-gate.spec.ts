import { jest } from "@jest/globals";
import type { Repository } from "typeorm";
import {
  canonicalizeParams,
  applyBlockStrategyGate,
  releaseExecutorSlotByAddress,
} from "../block-strategy-gate";
import {
  ExecutionStatus,
  TaskExecution,
} from "../entities/task-execution.entity";
import { BlockStrategy } from "../entities/task.entity";
import { transitionToTerminal } from "../execution-terminal";

// N-14：闸门对 transitionToTerminal 的调用通过 mock 观察（取消补丁/快照/
// kill 顺序断言打在 mock 上）；行仓储用手工 stub（只用到 find）。
jest.mock("../execution-terminal", () => ({
  ...(jest.requireActual("../execution-terminal") as Record<string, unknown>),
  transitionToTerminal: jest.fn(),
}));

const mockedTransition = transitionToTerminal as unknown as jest.Mock<
  (...args: any[]) => Promise<any>
>;

const baseTask = (blockStrategy: BlockStrategy) => ({
  id: "task-1",
  name: "gate-task",
  blockStrategy,
});

const activeRow = (overrides: Partial<Record<string, unknown>> = {}) =>
  ({
    id: "exec-1",
    status: ExecutionStatus.RUNNING,
    executorAddress: "http://executor:3001",
    params: { orderId: "A" },
    ...overrides,
  }) as unknown as any;

const makeRepo = (rows: unknown[]) =>
  ({
    find: jest.fn<() => Promise<unknown[]>>().mockResolvedValue(rows),
  }) as unknown as Repository<TaskExecution>;

const makeHooks = () => ({
  warn: jest.fn() as jest.Mock,
  releaseSlot: jest.fn<() => Promise<any>>().mockResolvedValue(undefined),
  notifyKill: jest.fn<() => Promise<any>>().mockResolvedValue(undefined),
  onDiscardSkip: jest.fn<any>(),
});

describe("canonicalizeParams", () => {
  it("对象键序不敏感", () => {
    expect(canonicalizeParams({ a: 1, b: 2 })).toBe(
      canonicalizeParams({ b: 2, a: 1 }),
    );
  });

  it("嵌套对象同样键序归一", () => {
    expect(canonicalizeParams({ o: { x: 1, y: { p: 2, q: 3 } } })).toBe(
      canonicalizeParams({ o: { y: { q: 3, p: 2 }, x: 1 } }),
    );
  });

  it("数组保序（有序列表是语义的一部分）", () => {
    expect(canonicalizeParams({ ids: [1, 2] })).not.toBe(
      canonicalizeParams({ ids: [2, 1] }),
    );
  });

  it("undefined 值键等价于不存在；null 与 undefined 顶层等价", () => {
    expect(canonicalizeParams({ a: 1, z: undefined })).toBe(
      canonicalizeParams({ a: 1 }),
    );
    expect(canonicalizeParams(null)).toBe(canonicalizeParams(undefined));
  });

  it("不同值不等价", () => {
    expect(canonicalizeParams({ a: 1 })).not.toBe(canonicalizeParams({ a: 2 }));
  });
});

describe("applyBlockStrategyGate", () => {
  beforeEach(() => {
    mockedTransition.mockReset();
    mockedTransition.mockResolvedValue({
      rows: [] as unknown[],
      affected: 0,
      transitioned: false,
    });
  });

  it("serial：触发层不拦（互斥组执行层承担串行），不读执行行", async () => {
    const repo = makeRepo([activeRow()]);
    const hooks = makeHooks();
    await expect(
      applyBlockStrategyGate(
        baseTask(BlockStrategy.SERIAL),
        { orderId: "A" },
        repo,
        hooks,
      ),
    ).resolves.toBe("proceed");
    expect(repo.find).not.toHaveBeenCalled();
  });

  it("无在跑/排队执行 → 放行", async () => {
    const repo = makeRepo([]);
    const hooks = makeHooks();
    await expect(
      applyBlockStrategyGate(
        baseTask(BlockStrategy.DISCARD),
        { orderId: "A" },
        repo,
        hooks,
      ),
    ).resolves.toBe("proceed");
    expect(hooks.onDiscardSkip).not.toHaveBeenCalled();
  });

  it("discard：同参在跑 → skip 并打 metrics 出口", async () => {
    const repo = makeRepo([activeRow()]);
    const hooks = makeHooks();
    await expect(
      applyBlockStrategyGate(
        baseTask(BlockStrategy.DISCARD),
        { orderId: "A" },
        repo,
        hooks,
      ),
    ).resolves.toBe("skip");
    expect(hooks.onDiscardSkip).toHaveBeenCalledTimes(1);
    expect(hooks.warn).toHaveBeenCalledWith(expect.stringContaining("DISCARD"));
  });

  it("discard：异参在跑 → 放行（参数化任务合法并发）", async () => {
    const repo = makeRepo([activeRow({ params: { orderId: "B" } })]);
    const hooks = makeHooks();
    await expect(
      applyBlockStrategyGate(
        baseTask(BlockStrategy.DISCARD),
        { orderId: "A" },
        repo,
        hooks,
      ),
    ).resolves.toBe("proceed");
    expect(hooks.onDiscardSkip).not.toHaveBeenCalled();
  });

  it("discard：同参但仅键序不同 → 视为同参，skip", async () => {
    const repo = makeRepo([activeRow({ params: { b: 2, a: 1 } })]);
    const hooks = makeHooks();
    await expect(
      applyBlockStrategyGate(
        baseTask(BlockStrategy.DISCARD),
        { a: 1, b: 2 },
        repo,
        hooks,
      ),
    ).resolves.toBe("skip");
  });

  it("cover_early：同参 RUNNING → 取消 + 槽位冲销 + kill 下发，放行", async () => {
    const row = activeRow();
    const repo = makeRepo([row]);
    const hooks = makeHooks();
    mockedTransition.mockResolvedValue({
      rows: [{ id: row.id, executorAddress: row.executorAddress }],
      affected: 1,
      transitioned: true,
    });
    await expect(
      applyBlockStrategyGate(
        baseTask(BlockStrategy.COVER_EARLY),
        { orderId: "A" },
        repo,
        hooks,
      ),
    ).resolves.toBe("proceed");
    expect(mockedTransition).toHaveBeenCalledWith(
      repo,
      expect.objectContaining({
        ids: [row.id],
        patch: expect.objectContaining({
          status: ExecutionStatus.CANCELLED,
          errorMessage: "Task was covered by new trigger",
        }),
        addressSnapshot: { [row.id]: row.executorAddress },
      }),
    );
    expect(hooks.releaseSlot).toHaveBeenCalledWith(row.executorAddress);
    expect(hooks.notifyKill).toHaveBeenCalledWith(row.id, row.executorAddress);
  });

  it("cover_early：同参 WAITING（无 executorAddress）→ 只取消不 kill", async () => {
    const row = activeRow({
      status: ExecutionStatus.WAITING,
      executorAddress: null,
    });
    const repo = makeRepo([row]);
    const hooks = makeHooks();
    mockedTransition.mockResolvedValue({
      rows: [{ id: row.id, executorAddress: null }],
      affected: 1,
      transitioned: true,
    });
    await expect(
      applyBlockStrategyGate(
        baseTask(BlockStrategy.COVER_EARLY),
        { orderId: "A" },
        repo,
        hooks,
      ),
    ).resolves.toBe("proceed");
    expect(mockedTransition).toHaveBeenCalled();
    expect(hooks.releaseSlot).not.toHaveBeenCalled();
    expect(hooks.notifyKill).not.toHaveBeenCalled();
  });

  it("cover_early：竞态下终态门命中 0 行 → warn 不 kill，仍放行", async () => {
    const repo = makeRepo([activeRow()]);
    const hooks = makeHooks();
    mockedTransition.mockResolvedValue({
      rows: [] as unknown[],
      affected: 0,
      transitioned: false,
    });
    await expect(
      applyBlockStrategyGate(
        baseTask(BlockStrategy.COVER_EARLY),
        { orderId: "A" },
        repo,
        hooks,
      ),
    ).resolves.toBe("proceed");
    expect(hooks.releaseSlot).not.toHaveBeenCalled();
    expect(hooks.notifyKill).not.toHaveBeenCalled();
    expect(hooks.warn).toHaveBeenCalledWith(
      expect.stringContaining("not covered"),
    );
  });

  it("cover_early：kill 下发抛错 → 仅 warn，取消与放行不受阻", async () => {
    const row = activeRow();
    const repo = makeRepo([row]);
    const hooks = makeHooks();
    hooks.notifyKill.mockRejectedValue(new Error("executor unreachable"));
    mockedTransition.mockResolvedValue({
      rows: [{ id: row.id, executorAddress: row.executorAddress }],
      affected: 1,
      transitioned: true,
    });
    await expect(
      applyBlockStrategyGate(
        baseTask(BlockStrategy.COVER_EARLY),
        { orderId: "A" },
        repo,
        hooks,
      ),
    ).resolves.toBe("proceed");
    expect(hooks.warn).toHaveBeenCalledWith(
      expect.stringContaining("kill notification failed"),
    );
  });

  it("cover_early：多条同参在跑 → 全部取消（异参的不动）", async () => {
    const a1 = activeRow({ id: "exec-1", params: { orderId: "A" } });
    const a2 = activeRow({
      id: "exec-2",
      status: ExecutionStatus.WAITING,
      executorAddress: null,
      params: { orderId: "A" },
    });
    const other = activeRow({ id: "exec-3", params: { orderId: "B" } });
    const repo = makeRepo([a1, a2, other]);
    const hooks = makeHooks();
    mockedTransition.mockResolvedValue({
      rows: [{ id: "x", executorAddress: null }],
      affected: 1,
      transitioned: true,
    });
    await expect(
      applyBlockStrategyGate(
        baseTask(BlockStrategy.COVER_EARLY),
        { orderId: "A" },
        repo,
        hooks,
      ),
    ).resolves.toBe("proceed");
    const coveredIds = (mockedTransition.mock.calls as unknown as any[][]).map(
      (c) => c[1].ids[0],
    );
    expect(coveredIds).toEqual(["exec-1", "exec-2"]);
  });

  it("异参执行存在且无同参 → cover 放行（不取消任何执行）", async () => {
    const repo = makeRepo([activeRow({ params: { orderId: "B" } })]);
    const hooks = makeHooks();
    await expect(
      applyBlockStrategyGate(
        baseTask(BlockStrategy.COVER_EARLY),
        { orderId: "A" },
        repo,
        hooks,
      ),
    ).resolves.toBe("proceed");
    expect(mockedTransition).not.toHaveBeenCalled();
  });
});

describe("releaseExecutorSlotByAddress", () => {
  it("空地址直接返回，不产生查询", async () => {
    const dataSource = {
      createQueryBuilder: jest.fn(),
    } as unknown as any;
    await expect(
      releaseExecutorSlotByAddress(dataSource, null),
    ).resolves.toBeUndefined();
    expect(dataSource.createQueryBuilder).not.toHaveBeenCalled();
  });

  it("有地址 → GREATEST 下限的计数冲销 UPDATE", async () => {
    const execute = jest
      .fn<() => Promise<any>>()
      .mockResolvedValue({ affected: 1 });
    const set = jest.fn<() => any>().mockReturnThis();
    const where = jest.fn<() => any>().mockReturnThis();
    const update = jest.fn<() => any>().mockReturnThis();
    const dataSource = {
      createQueryBuilder: jest.fn(() => ({ update, set, where, execute })),
    } as unknown as any;
    await releaseExecutorSlotByAddress(dataSource, "http://executor:3001");
    expect(update).toHaveBeenCalledWith("executors");
    expect(set).toHaveBeenCalledWith({
      runningTaskCount: expect.any(Function),
    });
    expect(where).toHaveBeenCalledWith("address = :addr", {
      addr: "http://executor:3001",
    });
    expect(execute).toHaveBeenCalled();
  });
});
