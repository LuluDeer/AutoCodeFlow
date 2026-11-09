import {
  AGENT_CAPABILITIES_LEASE_MS,
  EXECUTOR_ADDRESS_TAKEOVER_SILENCE_MS,
  EXECUTOR_LIST_LIMIT,
  EXECUTOR_PICKER_LIMIT,
  TERMINAL_STATES_DEFAULT_LIMIT,
  TERMINAL_STATES_DEFAULT_LOOKBACK_MS,
  TERMINAL_STATES_MAX_LIMIT,
  TERMINAL_STATES_MAX_LOOKBACK_MS,
} from "../executor-constants";

/**
 * B0 拆分的独立单测（不走 DI 装配，直接 import 常量）。
 *
 * ## 为什么常量也要有 spec
 *
 * 这些是**跨文件契约**：`executor.controller.ts` 用它们做对账窗口与 picker
 * 上限，spec 用它们断言口径，前端经 runtime-config 间接消费其中两个。
 * 搬文件时最危险的失误是「顺手改了个值」或「导出可见性变了」——
 * 两者都会**静默**改变行为（没有编译错误）。
 *
 * 本文件把**值**钉住，让任何搬移后的数值漂移立刻红。
 */
describe("executor-constants — 跨文件契约常量的值", () => {
  it("对账窗口上界 = 30 天", () => {
    expect(TERMINAL_STATES_MAX_LOOKBACK_MS).toBe(30 * 24 * 60 * 60 * 1000);
  });

  it("对账窗口缺省 = 24 小时", () => {
    expect(TERMINAL_STATES_DEFAULT_LOOKBACK_MS).toBe(24 * 60 * 60 * 1000);
  });

  it("对账单页默认 500 / 最大 2000", () => {
    expect(TERMINAL_STATES_DEFAULT_LIMIT).toBe(500);
    expect(TERMINAL_STATES_MAX_LIMIT).toBe(2000);
  });

  it("findAll 硬上限 = 500（管理台列表的载荷护栏）", () => {
    expect(EXECUTOR_LIST_LIMIT).toBe(500);
  });

  it("picker 上限 = 2000（比 findAll 宽：单行更轻）", () => {
    expect(EXECUTOR_PICKER_LIMIT).toBe(2000);
    expect(EXECUTOR_PICKER_LIMIT).toBeGreaterThan(EXECUTOR_LIST_LIMIT);
  });

  it("接管静默窗缺省 = 5 分钟（E-8：建议 ≥60s，不许配 0）", () => {
    expect(EXECUTOR_ADDRESS_TAKEOVER_SILENCE_MS).toBe(5 * 60_000);
  });

  it("Agent 协作能力租约 = 2 分钟", () => {
    expect(AGENT_CAPABILITIES_LEASE_MS).toBe(2 * 60 * 1000);
  });
});
