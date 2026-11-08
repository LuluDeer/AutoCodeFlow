import { SELFTEST_SKIP_ENV_FILE_KEY, shouldSkipEnvFile } from "./selftest-env";

/**
 * R04（2026-11-05）：自检 hermeticity 开关的**三态**。
 *
 * 为什么这三条要单列：这个布尔是「本地门禁是否可信」的唯一开关，写反了不会有任何
 * 编译错/类型错——只会退化成今天这种「本机红、CI 绿、红点离改动很远」的状态。
 * 故把「只认 `1`」这条**刻意的严格性**也钉成断言（宽松真值解析会让"以为开了其实没开"
 * 变成新的调试成本）。
 */
describe("selftest-env — SELFTEST_SKIP_ENV_FILE 三态", () => {
  it("未设置 ⇒ false（生产 / CI / compose 的行为必须与今天逐字节一致）", () => {
    expect(shouldSkipEnvFile({})).toBe(false);
  });

  it('显式 "1" ⇒ true（自检唯一认可的取值）', () => {
    expect(shouldSkipEnvFile({ [SELFTEST_SKIP_ENV_FILE_KEY]: "1" })).toBe(true);
  });

  it('其它值（"0" / "true" / "yes" / 空串）⇒ false（只认 "1"，不做宽松真值解析）', () => {
    for (const value of ["0", "true", "yes", ""]) {
      expect(shouldSkipEnvFile({ [SELFTEST_SKIP_ENV_FILE_KEY]: value })).toBe(
        false,
      );
    }
  });

  it("键名与自检 helper 声明的是同一个字面量（防两边漂移）", () => {
    // 该字面量同时被 scripts/lib/selftest-hermetic.mjs 使用；漂移时
    // check:guard-harness 的接线判据会红（这里再钉一层，读代码即见）。
    expect(SELFTEST_SKIP_ENV_FILE_KEY).toBe("SELFTEST_SKIP_ENV_FILE");
  });
});
