import {
  buildRunningTaskCountFloorExpr,
  resolveHeartbeatRunningTaskCount,
  RUNNING_TASK_COUNT_OPEN_STATUSES,
} from "../heartbeat-count.util";
import { OPEN_EXECUTION_STATUSES } from "../../task/execution-terminal";

/**
 * R16（2026-11-05）：心跳 `runningTaskCount` 采纳规则。
 *
 * 判据成对：**先复现"朴素覆盖写会丢占坑"**（对照），再断言本规则不会。
 * 没有对照那一条，"取大"可能只是自我实现的恒绿。
 */
describe("R16 — resolveHeartbeatRunningTaskCount（心跳计数下限 = 服务端在途占坑）", () => {
  it("【对照】朴素覆盖写会丢并发占坑：客户端快照 0 覆盖在途 2 ⇒ 计数被改小（超卖成因）", () => {
    const clientSnapshot = 0; // 心跳构造报文时执行器还空闲
    const serverInFlight = 2; // 窗口内派发占坑了 2 个
    // 旧实现的落库值就是客户端快照本身：
    expect(clientSnapshot).toBeLessThan(serverInFlight);
  });

  it("R16 规则：客户端值低于服务端在途 ⇒ 取在途值并标记 clamped", () => {
    expect(resolveHeartbeatRunningTaskCount({ reported: 0, serverInFlight: 2 })).toEqual({
      value: 2,
      clamped: true,
    });
  });

  it("客户端值高于在途（执行器自述更多占用）⇒ 采用客户端值（不缩小自述）", () => {
    expect(resolveHeartbeatRunningTaskCount({ reported: 5, serverInFlight: 2 })).toEqual({
      value: 5,
      clamped: false,
    });
  });

  it("I2 支撑：执行终态化后在途降为 0 ⇒ 计数可回落（不会只增不降）", () => {
    // 上一轮被抬到 2（防超卖），本轮执行已终态、执行器上报 0 ⇒ 允许降回 0
    expect(resolveHeartbeatRunningTaskCount({ reported: 0, serverInFlight: 0 })).toEqual({
      value: 0,
      clamped: false,
    });
  });

  it("非法/非有限输入按 0 处理（不把 NaN 写进闸门列）", () => {
    expect(resolveHeartbeatRunningTaskCount({ reported: Number.NaN, serverInFlight: 1 })).toEqual({
      value: 1,
      clamped: true,
    });
    expect(resolveHeartbeatRunningTaskCount({ reported: 3, serverInFlight: Number.NaN })).toEqual({
      value: 3,
      clamped: false,
    });
  });
});

/**
 * R109（ADR-037）：**计数下限表达式的共享产物**。
 *
 * 这是「产品」与「真机判据」之间唯一的物理连接点：判据 import 同一个
 * `buildRunningTaskCountFloorExpr` 生成它自己的写入 SQL（而不是照抄一份），
 * 因此产品改了口径、判据会立刻跟着变 —— 那才是真 oracle（R108 的教训：
 * 判据自写 SQL 时，产品修复后它仍 exit 1，因为它写的是自己那份）。
 */
describe("R109 · buildRunningTaskCountFloorExpr（下限表达式单一事实源）", () => {
  it("默认形态：实时子查询 + OPEN 状态内联（生产路径）", () => {
    expect(buildRunningTaskCountFloorExpr({ reported: 3 })).toBe(
      "GREATEST(3, (SELECT count(*) FROM task_executions t " +
        "WHERE t.\"executorId\" = executors.id AND t.status IN ('pending','running','waiting')))",
    );
  });

  it("包含**实时子查询**而不是自引用计数（不饥饿的关键）", () => {
    const expr = buildRunningTaskCountFloorExpr({ reported: 0 });
    // 自引用形态会是 GREATEST(0, "runningTaskCount") —— 那样心跳永远降不了计数。
    expect(expr).toContain("(SELECT count(*) FROM");
    expect(expr).not.toContain('GREATEST(0, "runningTaskCount"');
  });

  it("reported 允许传 SQL 片段（仓外判据的 :snap / 列名场景）", () => {
    expect(buildRunningTaskCountFloorExpr({ reported: ":snap" })).toContain(
      "GREATEST(:snap,",
    );
  });

  it("reported 为小数时取整（生产上报已过范围校验，防御性一致）", () => {
    expect(buildRunningTaskCountFloorExpr({ reported: 2.9 })).toContain(
      "GREATEST(2,",
    );
  });

  it("outerRef / executionsTable / statuses 可覆盖（判据按字面量 id 相关）", () => {
    const expr = buildRunningTaskCountFloorExpr({
      reported: 1,
      outerRef: "'r16-7'",
      executionsTable: "task_executions",
      statuses: ["running"],
    });
    expect(expr).toBe(
      "GREATEST(1, (SELECT count(*) FROM task_executions t " +
        "WHERE t.\"executorId\" = 'r16-7' AND t.status IN ('running')))",
    );
  });

  it("OPEN 状态集合与 execution-terminal 的权威集合逐字相同（防漂移）", () => {
    expect([...RUNNING_TASK_COUNT_OPEN_STATUSES].sort()).toEqual(
      [...OPEN_EXECUTION_STATUSES].sort(),
    );
  });
});
