import { tokenDerivationPostureWarning } from "../token-derivation-posture";

/**
 * R15：`EXECUTOR_TOKEN_EPOCH_MODE=on` 的**派生密钥姿态告警**。
 *
 * 判据两向：
 *  · 该报警时必须报（两种配置错误：密钥全空 / 回落成共享口令）；
 *  · 不该报警时**必须静默**（mode=off、密钥齐备）——否则告警会变成噪音被忽略。
 *
 * 接线面另有机读保护：`check:ops-runbook` 断言 `main.ts` 里真的调用了本函数
 * （删接线 ⇒ 守卫红），所以"写了没接上"也被钉住。
 */
describe("R15 — tokenDerivationPostureWarning（启动快照告警）", () => {
  it("mode 未开（默认/off/杂值）⇒ 一律静默", () => {
    for (const v of [undefined, "", "off", "false", "0", "yes"]) {
      expect(
        tokenDerivationPostureWarning({ EXECUTOR_TOKEN_EPOCH_MODE: v as never }),
      ).toBeNull();
    }
  });

  it("mode=on 且派生密钥与共享口令都空 ⇒ 报警（点名取令牌会失败）", () => {
    const msg = tokenDerivationPostureWarning({ EXECUTOR_TOKEN_EPOCH_MODE: "on" });
    expect(msg).toBeTruthy();
    expect(msg).toContain("派生密钥缺失");
    expect(msg).toContain("docs/operations.md");
  });

  it("mode=on 且派生密钥缺失但共享口令在 ⇒ 报警（回落态：违反凭据分层）", () => {
    const msg = tokenDerivationPostureWarning({
      EXECUTOR_TOKEN_EPOCH_MODE: "on",
      EXECUTOR_SECRET: "shared-secret-32chars-long-enough",
    });
    expect(msg).toBeTruthy();
    expect(msg).toContain("回落使用 EXECUTOR_SECRET");
    expect(msg).toContain("docs/operations.md");
  });

  it("mode=on 且派生密钥单独设置 ⇒ 静默（正确配置不制造噪音）", () => {
    expect(
      tokenDerivationPostureWarning({
        EXECUTOR_TOKEN_EPOCH_MODE: "on",
        EXECUTOR_TOKEN_DERIVATION_SECRET: "derivation-secret-32chars-long-ok",
        EXECUTOR_SECRET: "shared-secret-32chars-long-enough",
      }),
    ).toBeNull();
  });

  it("空密钥优先报「缺失」（更严重），不报「回落」", () => {
    const msg = tokenDerivationPostureWarning({
      EXECUTOR_TOKEN_EPOCH_MODE: "on",
      EXECUTOR_TOKEN_DERIVATION_SECRET: "   ",
    });
    expect(msg).toContain("派生密钥缺失");
    expect(msg).not.toContain("回落使用");
  });
});
