import { Logger } from "@nestjs/common";
import {
  ExecutorHeartbeatReport,
  type ExecutorHeartbeatReportDeps,
  type HeartbeatMetricValues,
} from "../executor-heartbeat-report.collaborator";
import { Executor, ExecutorStatus } from "../entities/executor.entity";

/**
 * T1-B3c 的独立单测（**不走 DI 装配**，`new ExecutorHeartbeatReport({...})` 直构）。
 *
 * ## 钉住四件"错了会静默"的事
 *
 * 1. **非法上报值 ⇒ 从 metricValues 删除、DB 值不动**（不是"采纳成 0"、不是抛错）——
 *    采纳成 0 会让派发闸门误判「有空位」而超发；抛错会让一次脏上报打断整条保活链。
 * 2. **只有本轮真的采纳的列进 `adopted`** —— `adopted` 是 Facade 算 patch 的唯一依据
 *    （白名单 ∩ 采纳集）；多登记一列 = 把没上报的旧值写回（ADR-026 规则 4 的缺陷形态）。
 * 3. **三态字段（interpreters/installedPackages/deviceFingerprint/taskSandbox）的
 *    "缺省不动"** —— 旧执行器不上报时绝不能把已存值擦成 NULL。
 * 4. **`wasOnline` 反映心跳前状态** —— Facade 靠它判定在线跃迁并发事件；判错会
 *    每次心跳都发 `executor.online`（打爆 outbox）。
 */

const makeDeps = (over: Partial<ExecutorHeartbeatReportDeps> = {}) => {
  const warn = jest.fn();
  const debug = jest.fn();
  const logger = { warn, debug, log: jest.fn(), error: jest.fn() } as unknown as Logger;
  const deps: ExecutorHeartbeatReportDeps = {
    logger,
    isAdoptableMaxConcurrentTasks: (v) =>
      typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 10_000,
    sanitizeRunningExecutionIds: (v) =>
      Array.isArray(v) ? (v.filter((x) => typeof x === "string") as string[]) : null,
    maxRunningExecutionIds: 10_000,
    ...over,
  };
  return { deps, warn, debug };
};

const mkExecutor = (over: Partial<Executor> = {}): Executor =>
  ({
    id: "e1",
    address: "10.0.0.9:3002",
    status: ExecutorStatus.OFFLINE,
    cpuUsage: 1,
    memUsage: 2,
    runningTaskCount: 3,
    maxConcurrentTasks: 10,
    lastHeartbeat: null,
    consecutiveHeartbeatMisses: 5,
    offlineReason: "timeout",
    ...over,
  }) as unknown as Executor;

const baseArgs = (over: Record<string, unknown> = {}) => ({
  executor: mkExecutor(),
  address: "10.0.0.9:3002",
  metrics: {},
  metricValues: {} as HeartbeatMetricValues,
  adopted: new Set<string>(),
  incomingStartedAt: null,
  incomingStartupId: null,
  incomingFingerprint: null,
  runningExecutionIds: undefined,
  reservedSlots: undefined,
  interpreters: undefined,
  installedPackages: undefined,
  taskSandbox: undefined,
  ...over,
});

describe("ExecutorHeartbeatReport（T1-B3c 独立单测）", () => {
  it("合法指标：写入实体并登记 adopted；wasOnline 反映心跳前状态", () => {
    const { deps } = makeDeps();
    const c = new ExecutorHeartbeatReport(deps);
    const args = baseArgs({
      metricValues: { cpuUsage: 42, memUsage: 55 },
    });

    const out = c.applyReportedMetrics(args as never);

    expect(args.executor.cpuUsage).toBe(42);
    expect(args.executor.memUsage).toBe(55);
    expect(args.adopted.has("cpuUsage")).toBe(true);
    expect(args.adopted.has("memUsage")).toBe(true);
    expect(out.wasOnline).toBe(false); // 心跳前是 OFFLINE
    // 活性四列无条件写内存（落库由 Facade 的 patch 决定）
    expect(args.executor.status).toBe(ExecutorStatus.ONLINE);
    expect(args.executor.consecutiveHeartbeatMisses).toBe(0);
    expect(args.executor.offlineReason).toBeNull();
  });

  it("README：wasOnline=true 当心跳前已在线", () => {
    const { deps } = makeDeps();
    const c = new ExecutorHeartbeatReport(deps);
    const args = baseArgs({ executor: mkExecutor({ status: ExecutorStatus.ONLINE }) });
    expect(c.applyReportedMetrics(args as never).wasOnline).toBe(true);
  });

  it("maxConcurrentTasks 越界(99999) ⇒ 删除该键 + warn，DB 值不动（不采纳成 0）", () => {
    const { deps, warn } = makeDeps();
    const c = new ExecutorHeartbeatReport(deps);
    const args = baseArgs({ metricValues: { maxConcurrentTasks: 99999 } });

    c.applyReportedMetrics(args as never);

    expect(args.metricValues.maxConcurrentTasks).toBeUndefined();
    expect(args.adopted.has("maxConcurrentTasks")).toBe(false);
    expect(args.executor.maxConcurrentTasks).toBe(10); // 保持原值
    const text = warn.mock.calls.map((x) => String(x[0])).join("\n");
    expect(text).toContain("invalid maxConcurrentTasks=99999");
  });

  it("runningTaskCount 越界/非整数 ⇒ 删除该键 + warn", () => {
    const { deps, warn } = makeDeps();
    const c = new ExecutorHeartbeatReport(deps);
    const args = baseArgs({ metricValues: { runningTaskCount: -1 } });

    c.applyReportedMetrics(args as never);

    expect(args.metricValues.runningTaskCount).toBeUndefined();
    expect(args.adopted.has("runningTaskCount")).toBe(false);
    expect(warn.mock.calls.map((x) => String(x[0])).join("\n")).toContain(
      "invalid runningTaskCount=-1",
    );
  });

  it("百分比越界(250) ⇒ **视同未上报**（删除键 + warn），不是 clamp 到 100", () => {
    // ⚠️ 实测口径修正：`heartbeat` 的百分比段是「非法 ⇒ 当作没上报」，
    // **不是** clamp。写成 clamp 会让越界值被采纳成边界值（例如把 250 存成
    // 100），把一个明显脏的上报伪装成合法读数。
    const { deps, warn } = makeDeps();
    const c = new ExecutorHeartbeatReport(deps);
    const args = baseArgs({ metricValues: { cpuUsage: 250 } });

    c.applyReportedMetrics(args as never);

    expect(args.metricValues.cpuUsage).toBeUndefined();
    expect(args.adopted.has("cpuUsage")).toBe(false);
    expect(args.executor.cpuUsage).toBe(1); // DB 侧原值不动
    expect(warn.mock.calls.map((x) => String(x[0])).join("\n")).toContain(
      "invalid cpuUsage=250",
    );
  });

  it("三态字段缺省 ⇒ 不动 DB 值、不登记 adopted（旧执行器零影响）", () => {
    const { deps } = makeDeps();
    const c = new ExecutorHeartbeatReport(deps);
    const args = baseArgs({
      executor: mkExecutor({
        interpreters: [{ version: "3.12" }] as never,
        deviceFingerprint: "abc123",
      } as never),
    });

    c.applyReportedMetrics(args as never);

    expect(args.executor.interpreters).toEqual([{ version: "3.12" }]);
    expect(args.adopted.has("interpreters")).toBe(false);
    expect(args.adopted.has("deviceFingerprint")).toBe(false);
  });

  it("interpreters=[] 是合法上报（池空），与「缺省」区分开", () => {
    const { deps } = makeDeps();
    const c = new ExecutorHeartbeatReport(deps);
    const args = baseArgs({ interpreters: [] });

    c.applyReportedMetrics(args as never);

    expect(args.executor.interpreters).toEqual([]);
    expect(args.adopted.has("interpreters")).toBe(true);
  });

  it("taskSandbox 取值域只有 '' 与 'bwrap'；非法值 ⇒ 不采纳 + warn", () => {
    const { deps, warn } = makeDeps();
    const c = new ExecutorHeartbeatReport(deps);
    const args = baseArgs({ taskSandbox: "off" });

    c.applyReportedMetrics(args as never);

    expect(args.adopted.has("taskSandbox")).toBe(false);
    expect(warn.mock.calls.map((x) => String(x[0])).join("\n")).toContain(
      "taskSandbox",
    );
  });

  it("只读性/无副作用：本协作者不触碰任何 repo（deps 里根本没有 repo）", () => {
    const { deps } = makeDeps();
    expect(Object.keys(deps)).toEqual(
      expect.arrayContaining([
        "logger",
        "isAdoptableMaxConcurrentTasks",
        "sanitizeRunningExecutionIds",
        "maxRunningExecutionIds",
      ]),
    );
    const c = new ExecutorHeartbeatReport(deps);
    c.applyReportedMetrics(baseArgs({ metricValues: { cpuUsage: 5 } }) as never);
    // public 面只有 applyReportedMetrics（私有判定不进 public 面 ⇒ 无 self-call 风险）
    const proto = Object.getPrototypeOf(c) as Record<string, unknown>;
    const src = require("fs").readFileSync(
      require("path").join(
        __dirname,
        "..",
        "executor-heartbeat-report.collaborator.ts",
      ),
      "utf-8",
    ) as string;
    const pub = Object.getOwnPropertyNames(proto).filter(
      (n) =>
        n !== "constructor" &&
        typeof proto[n] === "function" &&
        !new RegExp(`^\\s*private\\s+${n}\\s*[(<]`, "m").test(src),
    );
    expect(pub).toEqual(["applyReportedMetrics"]);
  });
});
