import {
  deriveExecutorToken,
  isTokenEpochModeOn,
  startupEpochOf,
} from "../token-epoch-derivation.util";

/**
 * R14（ADR-030 §4 ②′）：确定性派生是**跨实例幂等的全部机制** ——
 * 「同一组输入 ⇒ 逐字节相同的令牌」一旦不成立，后到方就再也无法用
 * `bcrypt.compare(自算, 库里新 hash)` 命中，跨实例幂等退化成 409/重试。
 * 故这条性质必须被钉死，而不是依赖"HMAC 应该是确定的"。
 */
describe("R14 — deriveExecutorToken（确定性派生）", () => {
  const base = {
    secret: "unit-test-secret",
    identityKey: "10.14.0.1:8004|legacy:10.14.0.1:8004",
    startupEpoch: "life-A",
    rotationEpoch: 3,
  };

  it("同输入 ⇒ 同输出（跨实例幂等的前提）", () => {
    expect(deriveExecutorToken(base)).toBe(deriveExecutorToken({ ...base }));
  });

  it("epoch 变 ⇒ 令牌变（轮换真的换令牌）", () => {
    expect(deriveExecutorToken(base)).not.toBe(
      deriveExecutorToken({ ...base, rotationEpoch: 4 }),
    );
  });

  it("startupEpoch 变 ⇒ 令牌变（重启换代）", () => {
    expect(deriveExecutorToken(base)).not.toBe(
      deriveExecutorToken({ ...base, startupEpoch: "life-B" }),
    );
  });

  it("identityKey 变 ⇒ 令牌变（同址两台互不串）", () => {
    expect(deriveExecutorToken(base)).not.toBe(
      deriveExecutorToken({ ...base, identityKey: "10.14.0.2:8004|legacy:x" }),
    );
  });

  it("分段拼接无歧义：`a|b`+`c` 与 `a`+`b|c` 不得相撞（分隔符用 \\0）", () => {
    const left = deriveExecutorToken({
      ...base,
      identityKey: "a|b",
      startupEpoch: "c",
    });
    const right = deriveExecutorToken({
      ...base,
      identityKey: "a",
      startupEpoch: "b|c",
    });
    expect(left).not.toBe(right);
  });

  it("空密钥 ⇒ 显式抛错（绝不静默退化成空密钥 HMAC）", () => {
    expect(() => deriveExecutorToken({ ...base, secret: "" })).toThrow(
      /派生密钥为空/,
    );
  });

  it("输出是 64 位十六进制（与既有 bearer 形态一致，便于日志/传输）", () => {
    expect(deriveExecutorToken(base)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("R14 — isTokenEpochModeOn / startupEpochOf（默认 off！）", () => {
  it("未设置 / 空串 / 任意非 on 值 ⇒ off（默认关，行为与今天一致）", () => {
    for (const v of [undefined, null, "", "off", "false", "0", "yes", "ON!", " on1 "]) {
      expect(isTokenEpochModeOn(v as never)).toBe(false);
    }
  });

  it("on/true/1（大小写与空白无关）⇒ 开", () => {
    for (const v of ["on", "ON", " On ", "true", "TRUE", "1"]) {
      expect(isTokenEpochModeOn(v)).toBe(true);
    }
  });

  it("startupEpochOf：缺失/空白归一为空串（两侧一致才可能派生相同）", () => {
    expect(startupEpochOf(null)).toBe("");
    expect(startupEpochOf(undefined)).toBe("");
    expect(startupEpochOf("   ")).toBe("");
    expect(startupEpochOf(" life-A ")).toBe("life-A");
  });
});
