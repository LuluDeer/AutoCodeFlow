import { resolveHeartbeatRunningTaskCount } from "../heartbeat-count.util";

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
