/**
 * R38（2026-11-05）：**消费失败提示必须可操作**。
 *
 * Lead 已裁定 I3 维持 fail-closed（`consumed` 不回退 `granted`，正确路径是**重新申请审批**）。
 * 那么失败路径就必须把这个动作说出来 —— 否则用户只看到 `denied`，不知道下一步做什么。
 * 本 spec 逐句断言两种失败文案都含「本次未执行」+ 可操作指引。
 */
import { buildConsumeDenialMessage } from "../tool-executor.service";

describe("R38 · 消费失败提示（fail-closed 的配套）", () => {
  it("被别处用掉（not_granted）⇒ 说明「已消耗」+ 指引「重新申请审批」", () => {
    const msg = buildConsumeDenialMessage("not_granted", "apr-s-1-x");
    expect(msg).toContain("本次调用未执行");
    // Lead 裁决的配套要求：必须给出可操作下一步
    expect(msg).toContain("已消耗");
    expect(msg).toContain("重新申请审批");
  });

  it("单不存在（missing）⇒ 同样给「重新申请审批」指引", () => {
    const msg = buildConsumeDenialMessage("missing", "apr-s-1-y");
    expect(msg).toContain("本次调用未执行");
    expect(msg).toContain("重新申请审批");
  });

  /**
   * R39：**执行失败（已 consumed）** 的提示必须与消费失败同口径。
   *
   * 现状语义（本轮核实）：工具执行失败时**审批行保持 `consumed`**（consume 之后不再改审批行），
   * 用户拿到的只是 `【调用失败】<msg>`（`tool-executor.service.ts:866-877`）⇒ **不可重试**，
   * 必须重新申请审批。故文案要显式说出这件事。
   */
  it("执行失败（已 consumed）⇒ 说明「授权已消耗」+「如需重试请重新申请审批」", () => {
    const msg = buildConsumeDenialMessage(
      "execution_failed_after_consume",
      "apr-s-1-f",
    );
    expect(msg).toContain("已消耗");
    expect(msg).toContain("重新申请审批");
  });

  it("策略已变（policy_changed）⇒ 指引「按当前策略重新发起审批」", () => {
    const msg = buildConsumeDenialMessage("policy_changed", "apr-s-1-z");
    expect(msg).toContain("本次调用未执行");
    expect(msg).toContain("重新发起审批");
  });
});
