import { Logger } from "@nestjs/common";
import {
  ExecutorRegisterReport,
  type ExecutorRegisterReportDeps,
} from "../executor-register-report.collaborator";
import type { Executor } from "../entities/executor.entity";

/**
 * T1-B3f 的独立单测：`applyReportedColumns`（列级采纳）。
 *
 * ## 钉住三件"错了会静默"的事
 *
 * 1. **缺省 ⇒ 不动实体、不进 `adopted`** —— `adopted` 是 Facade 算 patch 的唯一依据
 *    （白名单 ∩ 采纳集）；多登记一列 = 把没上报的旧值写回（ADR-026 规则 4 的缺陷形态）。
 * 2. **显式 `null` / 空数组与「缺省」区分开** —— `tags: null`、`interpreters: []`
 *    都是**合法上报**（要覆盖），不是"没报"。
 * 3. **`protocolVersion` 只在整数时采纳** —— 缺省/非法不动 DB（保持未上报/NULL 语义）。
 */

const makeDeps = (over: Partial<ExecutorRegisterReportDeps> = {}) => {
  const logger = {
    warn: jest.fn(),
    debug: jest.fn(),
    log: jest.fn(),
    error: jest.fn(),
  } as unknown as Logger;
  const deps: ExecutorRegisterReportDeps = {
    logger,
    isAdoptableMaxConcurrentTasks: (v) =>
      typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 10_000,
    ...over,
  };
  return { deps };
};

const mkExecutor = (): Executor =>
  ({
    id: "e1",
    address: "10.0.0.9:3002",
    appName: "old-name",
    executorVersion: "0.0.1",
    capabilities: ["old"],
    maxConcurrentTasks: 5,
    groupName: "old-group",
    tags: ["old"],
    description: "old",
    dispatchMode: "push",
    interpreters: [{ version: "3.7" }],
    installedPackages: [],
    protocolVersion: 2,
    deviceFingerprint: "fp-old",
    type: "node",
  }) as unknown as Executor;

const baseArgs = (over: Record<string, unknown> = {}) => ({
  executor: mkExecutor(),
  data: {},
  capabilities: undefined,
  maxConcurrentTasks: undefined,
  normalizedInterpreters: null,
  normalizedInstalledPackages: null,
  incomingFingerprint: null,
  adopted: new Set<string>(),
  ...over,
});

describe("ExecutorRegisterReport.applyReportedColumns（T1-B3f）", () => {
  it("全部缺省 ⇒ 实体一列不改、adopted 为空（旧执行器重注册零影响）", () => {
    const { deps } = makeDeps();
    const c = new ExecutorRegisterReport(deps);
    const args = baseArgs();

    c.applyReportedColumns(args as never);

    const e = args.executor as unknown as Record<string, unknown>;
    expect(e.appName).toBe("old-name");
    expect(e.maxConcurrentTasks).toBe(5);
    expect(e.dispatchMode).toBe("push");
    expect(args.adopted.size).toBe(0);
  });

  it("上报了就采纳并登记 adopted（值写进实体，供回执用）", () => {
    const { deps } = makeDeps();
    const c = new ExecutorRegisterReport(deps);
    const args = baseArgs({
      data: { appName: "new-name", type: "python", version: "1.2.3", groupName: "g" },
      capabilities: ["python"],
      maxConcurrentTasks: 9,
    });

    c.applyReportedColumns(args as never);

    const e = args.executor as unknown as Record<string, unknown>;
    expect(e.appName).toBe("new-name");
    expect(e.executorVersion).toBe("1.2.3");
    expect(e.capabilities).toEqual(["python"]);
    expect(e.maxConcurrentTasks).toBe(9);
    expect(e.groupName).toBe("g");
    expect(args.adopted.has("appName")).toBe(true);
    expect(args.adopted.has("maxConcurrentTasks")).toBe(true);
  });

  it("显式 null / 空数组是**合法上报**（要覆盖），不是「没报」", () => {
    const { deps } = makeDeps();
    const c = new ExecutorRegisterReport(deps);
    const args = baseArgs({
      data: { tags: null, description: null },
      normalizedInterpreters: [],
    });

    c.applyReportedColumns(args as never);

    const e = args.executor as unknown as Record<string, unknown>;
    expect(e.tags).toBeNull();
    expect(e.description).toBeNull();
    expect(e.interpreters).toEqual([]);
    expect(args.adopted.has("tags")).toBe(true);
    expect(args.adopted.has("interpreters")).toBe(true);
  });

  it("三态归一为 null（= 缺省或非法）⇒ 不采纳（保旧值）", () => {
    const { deps } = makeDeps();
    const c = new ExecutorRegisterReport(deps);
    const args = baseArgs({ normalizedInterpreters: null });

    c.applyReportedColumns(args as never);

    const e = args.executor as unknown as Record<string, unknown>;
    expect(e.interpreters).toEqual([{ version: "3.7" }]);
    expect(args.adopted.has("interpreters")).toBe(false);
  });

  it("protocolVersion 只在整数时采纳；非法/缺省不动 DB", () => {
    const { deps } = makeDeps();
    const c = new ExecutorRegisterReport(deps);

    const okArgs = baseArgs({ data: { protocolVersion: 3 } });
    c.applyReportedColumns(okArgs as never);
    expect((okArgs.executor as unknown as Record<string, unknown>).protocolVersion).toBe(3);
    expect(okArgs.adopted.has("protocolVersion")).toBe(true);

    const badArgs = baseArgs({ data: { protocolVersion: 3.5 } });
    c.applyReportedColumns(badArgs as never);
    expect((badArgs.executor as unknown as Record<string, unknown>).protocolVersion).toBe(2);
    expect(badArgs.adopted.has("protocolVersion")).toBe(false);
  });

  it("dispatchMode 只在字面量 push/pull 时采纳（拒绝任意字符串）", () => {
    const { deps } = makeDeps();
    const c = new ExecutorRegisterReport(deps);

    const pullArgs = baseArgs({ data: { dispatchMode: "pull" } });
    c.applyReportedColumns(pullArgs as never);
    expect((pullArgs.executor as unknown as Record<string, unknown>).dispatchMode).toBe("pull");
    expect(pullArgs.adopted.has("dispatchMode")).toBe(true);

    const junkArgs = baseArgs({ data: { dispatchMode: "weird" } });
    c.applyReportedColumns(junkArgs as never);
    expect((junkArgs.executor as unknown as Record<string, unknown>).dispatchMode).toBe("push");
    expect(junkArgs.adopted.has("dispatchMode")).toBe(false);
  });

  it("指纹仅经归一（非 null）时采纳 —— 缺省不得把已存值擦成 NULL", () => {
    const { deps } = makeDeps();
    const c = new ExecutorRegisterReport(deps);

    const keepArgs = baseArgs({ incomingFingerprint: null });
    c.applyReportedColumns(keepArgs as never);
    expect((keepArgs.executor as unknown as Record<string, unknown>).deviceFingerprint).toBe("fp-old");
    expect(keepArgs.adopted.has("deviceFingerprint")).toBe(false);

    const setArgs = baseArgs({ incomingFingerprint: "fp-new" });
    c.applyReportedColumns(setArgs as never);
    expect((setArgs.executor as unknown as Record<string, unknown>).deviceFingerprint).toBe("fp-new");
    expect(setArgs.adopted.has("deviceFingerprint")).toBe(true);
  });
});
