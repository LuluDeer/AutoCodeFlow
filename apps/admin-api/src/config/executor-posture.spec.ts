import {
  EXECUTOR_PRIVATE_NETWORK_FLAG,
  executorPostureWarning,
} from "./executor-posture";

/**
 * R06（2026-11-05）：**升级期可操作告警**的三态 + 「文案必须可操作」约束。
 *
 * 为什么这些要单列：这条告警是**破坏性变更的唯一运行时公告面**。它对已存在的自托管
 * 部署是「派发全挂」与「一眼看懂怎么修」之间的差别。所以除了三态，还要钉住文案里
 * **必须出现的东西**——否则下一个人把它改短成「SSRF blocked」不会有任何东西变红。
 */
describe("executor-posture — 启动期可操作告警（R06）", () => {
  it("开关未设置 ⇒ 出告警（默认形态：存量部署升级后必现）", () => {
    const msg = executorPostureWarning({});
    expect(typeof msg).toBe("string");
    expect(msg).toContain("未开启");
  });

  it("开关为 true ⇒ 返回 null（已按契约配置的部署零噪音）", () => {
    expect(
      executorPostureWarning({ [EXECUTOR_PRIVATE_NETWORK_FLAG]: "true" }),
    ).toBeNull();
  });

  it('开关为 "false" ⇒ 仍然告警（不是"配了就不吵"：等于没开）', () => {
    const msg = executorPostureWarning({
      [EXECUTOR_PRIVATE_NETWORK_FLAG]: "false",
    });
    expect(typeof msg).toBe("string");
  });

  it("文案必须可操作：点名开关名 + 两条修法 + 指向升级文档", () => {
    const msg = executorPostureWarning({}) ?? "";
    // ① 点名变量（否则运维不知道要设什么）
    expect(msg).toContain("EXECUTOR_ALLOW_PRIVATE_NETWORK");
    // ② 内网修法：开开关
    expect(msg).toMatch(/修法①.*EXECUTOR_ALLOW_PRIVATE_NETWORK=true/);
    // ③ 同机回环修法：明确「开关救不了回环」（契约：回环恒拒）
    expect(msg).toMatch(/修法②/);
    expect(msg).toContain("127.0.0.1");
    expect(msg).toMatch(/不受该开关影响|恒拒/);
    // ④ 指向升级文档（报错/告警必须能把人带到文档）
    expect(msg).toContain("docs/UPGRADING.md");
  });
});
