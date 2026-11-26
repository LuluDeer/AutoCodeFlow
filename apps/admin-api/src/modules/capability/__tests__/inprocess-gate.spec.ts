import {
  checkInProcessBudget,
  classifyCapabilityPermission,
  degradeOnFailure,
  type InProcessBudgetState,
  type InProcessCapability,
} from "../inprocess-gate";

const cap = (
  overrides: Partial<InProcessCapability> = {},
): InProcessCapability => ({
  key: "browser",
  kind: "agent",
  scope: { mode: "supervised", guidance: "L2" },
  access: "read",
  ...overrides,
});

describe("classifyCapabilityPermission（权限三态，零 I/O）", () => {
  it("控制组：supervised/L2/read 非危险 ⇒ ask（默认需确认）", () => {
    expect(classifyCapabilityPermission(cap(), "read")).toBe("ask");
  });

  it("控制组：self_service/L3/read 非危险 ⇒ allow", () => {
    const result = classifyCapabilityPermission(
      cap({ scope: { mode: "self_service", guidance: "L3" } }),
      "read",
    );
    expect(result).toBe("allow");
  });

  it("反证①：managed 未授权被判 allow 即转红", () => {
    const result = classifyCapabilityPermission(
      cap({ scope: { mode: "managed", guidance: "L2" } }),
      "read",
    );
    expect(result).toBe("deny");
    expect(result).not.toBe("allow");
  });

  it("managed 已签署背书（signer 非空）⇒ allow", () => {
    expect(
      classifyCapabilityPermission(
        cap({
          scope: { mode: "managed", guidance: "L2" },
          attestation: { signer: "center-policy" },
        }),
        "read",
      ),
    ).toBe("allow");
  });

  it("managed 背书存在但 signer 为空 ⇒ 仍 deny", () => {
    expect(
      classifyCapabilityPermission(
        cap({
          scope: { mode: "managed", guidance: "L2" },
          attestation: { signer: "   " },
        }),
        "read",
      ),
    ).toBe("deny");
  });

  it("managed 未授权 + 危险能力 ⇒ deny（硬层优先于危险 ask）", () => {
    expect(
      classifyCapabilityPermission(
        cap({
          scope: { mode: "managed", guidance: "L1" },
          dangerous: true,
        }),
        "read",
      ),
    ).toBe("deny");
  });

  it("managed + L3 非法组合 ⇒ deny（治理锁定不得业务直配）", () => {
    expect(
      classifyCapabilityPermission(
        cap({
          scope: { mode: "managed", guidance: "L3" },
          attestation: { signer: "center-policy" },
        }),
        "read",
      ),
    ).toBe("deny");
  });

  it("反证②：危险能力被静默放行即转红（self_service/L3 + dangerous）", () => {
    const result = classifyCapabilityPermission(
      cap({
        scope: { mode: "self_service", guidance: "L3" },
        dangerous: true,
      }),
      "read",
    );
    expect(result).toBe("ask");
    expect(result).not.toBe("allow");
  });

  it("反证②：模型渠道（kind=provider）在最高自治档也只 ask", () => {
    expect(
      classifyCapabilityPermission(
        cap({
          kind: "provider",
          scope: { mode: "self_service", guidance: "L3" },
        }),
        "read",
      ),
    ).toBe("ask");
  });

  it("反证②：L1 强引导档在最高自治档也只 ask", () => {
    expect(
      classifyCapabilityPermission(
        cap({ scope: { mode: "self_service", guidance: "L1" } }),
        "read",
      ),
    ).toBe("ask");
  });

  it("managed 已授权 + 危险能力 ⇒ ask（不可静默放行）", () => {
    expect(
      classifyCapabilityPermission(
        cap({
          scope: { mode: "managed", guidance: "L2" },
          attestation: { signer: "center-policy" },
          dangerous: true,
        }),
        "read",
      ),
    ).toBe("ask");
  });

  it("supervised/write 有副作用调用 ⇒ ask", () => {
    expect(
      classifyCapabilityPermission(cap({ access: "write" }), "write"),
    ).toBe("ask");
  });

  it("self_service/L3/write 有副作用调用 ⇒ ask（mode 收紧）", () => {
    expect(
      classifyCapabilityPermission(
        cap({
          scope: { mode: "self_service", guidance: "L3" },
          access: "write",
        }),
        "write",
      ),
    ).toBe("ask");
  });

  it("只读能力承接 write 调用 ⇒ deny（越权）", () => {
    expect(classifyCapabilityPermission(cap(), "write")).toBe("deny");
  });

  it("未知 mode ⇒ deny（fail-closed）", () => {
    expect(classifyCapabilityPermission(cap(), "execute")).toBe("deny");
  });

  it("未知 guidance ⇒ deny（fail-closed）", () => {
    expect(
      classifyCapabilityPermission(
        cap({ scope: { mode: "supervised", guidance: "L4" } }),
        "read",
      ),
    ).toBe("deny");
  });

  it("未知 scope.mode ⇒ deny（fail-closed）", () => {
    expect(
      classifyCapabilityPermission(
        cap({ scope: { mode: "root", guidance: "L2" } }),
        "read",
      ),
    ).toBe("deny");
  });

  it("能力条目缺失/畸形 ⇒ deny", () => {
    expect(classifyCapabilityPermission(null, "read")).toBe("deny");
    expect(classifyCapabilityPermission(undefined, "read")).toBe("deny");
  });
});

describe("checkInProcessBudget（相对单位，零 token 虚构）", () => {
  const stateOf = (
    usage: InProcessBudgetState["usage"] = {},
    limitPerGeneration = 3,
  ): InProcessBudgetState => ({ usage, limitPerGeneration });

  it("首次调用未超预算 ⇒ allow，remaining 按相对单位算", () => {
    const verdict = checkInProcessBudget(stateOf(), {
      capabilityKey: "browser",
      generation: "g1",
    });
    expect(verdict).toEqual({
      decision: "allow",
      generation: "g1",
      used: 1,
      limit: 3,
      remaining: 2,
    });
  });

  it("累计超预算 ⇒ degraded", () => {
    const verdict = checkInProcessBudget(
      stateOf({ browser: [{ generation: "g1", units: 3 }] }),
      { capabilityKey: "browser", generation: "g1" },
    );
    expect(verdict.decision).toBe("degraded");
    expect(verdict.used).toBe(4);
    expect(verdict.remaining).toBe(0);
  });

  it("恰好用满预算（used === limit）⇒ allow", () => {
    const verdict = checkInProcessBudget(
      stateOf({ browser: [{ generation: "g1", units: 2 }] }),
      { capabilityKey: "browser", generation: "g1" },
    );
    expect(verdict.decision).toBe("allow");
    expect(verdict.used).toBe(3);
  });

  it("不同 generation 分代计数，互不污染", () => {
    const verdict = checkInProcessBudget(
      stateOf({ browser: [{ generation: "g1", units: 3 }] }),
      { capabilityKey: "browser", generation: "g2" },
    );
    expect(verdict.decision).toBe("allow");
    expect(verdict.generation).toBe("g2");
    expect(verdict.used).toBe(1);
  });

  it("generation 缺席回退 version 作为代令牌", () => {
    const verdict = checkInProcessBudget(stateOf(), {
      capabilityKey: "browser",
      version: "v1.2.3",
    });
    expect(verdict.generation).toBe("v1.2.3");
    expect(verdict.decision).toBe("allow");
  });

  it("同 key 不同能力不串桶", () => {
    const verdict = checkInProcessBudget(
      stateOf({ browser: [{ generation: "g1", units: 3 }] }),
      { capabilityKey: "filesystem", generation: "g1" },
    );
    expect(verdict.decision).toBe("allow");
  });

  it("纯函数：只读 state，判定后 state 引用与内容不变", () => {
    const frozen = Object.freeze({
      usage: Object.freeze({
        browser: Object.freeze([Object.freeze({ generation: "g1", units: 1 })]),
      }),
      limitPerGeneration: 3,
    });
    const verdict = checkInProcessBudget(frozen, {
      capabilityKey: "browser",
      generation: "g1",
    });
    expect(verdict.used).toBe(2);
    expect(frozen.usage.browser[0].units).toBe(1);
    expect(frozen.limitPerGeneration).toBe(3);
  });

  it("非法 limit（0 / 负数 / NaN）⇒ degraded", () => {
    for (const limit of [0, -1, Number.NaN]) {
      const verdict = checkInProcessBudget(stateOf({}, limit), {
        capabilityKey: "browser",
        generation: "g1",
      });
      expect(verdict.decision).toBe("degraded");
    }
  });

  it("空 capabilityKey ⇒ degraded", () => {
    expect(
      checkInProcessBudget(stateOf(), {
        capabilityKey: "   ",
        generation: "g1",
      }).decision,
    ).toBe("degraded");
  });

  it("不归代（generation 与 version 皆缺席）⇒ degraded", () => {
    expect(
      checkInProcessBudget(stateOf(), { capabilityKey: "browser" }).decision,
    ).toBe("degraded");
  });

  it("非法 units（0 / 负数 / NaN）⇒ degraded", () => {
    for (const units of [0, -1, Number.NaN]) {
      expect(
        checkInProcessBudget(stateOf(), {
          capabilityKey: "browser",
          generation: "g1",
          units,
        }).decision,
      ).toBe("degraded");
    }
  });

  it("畸形历史行 ⇒ degraded（不低估用量）", () => {
    const verdict = checkInProcessBudget(
      stateOf({ browser: [{} as { generation: string; units: number }] }),
      { capabilityKey: "browser", generation: "g1" },
    );
    expect(verdict.decision).toBe("degraded");
  });
});

describe("degradeOnFailure（标记，不产生副作用）", () => {
  const readOnly = cap({ access: "read" });
  const writable = cap({ access: "write" });

  it("read-only + timeout ⇒ use-cached，允许缓存顶上", () => {
    expect(degradeOnFailure(readOnly, "timeout")).toEqual({
      action: "use-cached",
      readOnly: true,
      errorKind: "timeout",
      cachedResultAllowed: true,
    });
  });

  it("read-only + not_found ⇒ empty-result，不允许缓存顶上", () => {
    expect(degradeOnFailure(readOnly, "not_found")).toEqual({
      action: "empty-result",
      readOnly: true,
      errorKind: "not_found",
      cachedResultAllowed: false,
    });
  });

  it("错误类别大小写/空白归一", () => {
    const verdict = degradeOnFailure(readOnly, "  TIMEOUT  ");
    expect(verdict.action).toBe("use-cached");
    expect(verdict.errorKind).toBe("timeout");
  });

  it("write 能力失败 ⇒ fail-closed（不返回缓存/空结果）", () => {
    const verdict = degradeOnFailure(writable, "timeout");
    expect(verdict.action).toBe("fail-closed");
    expect(verdict.readOnly).toBe(false);
    expect(verdict.cachedResultAllowed).toBe(false);
  });

  it("未知 errorKind ⇒ fail-closed（即使 read-only）", () => {
    expect(degradeOnFailure(readOnly, "brand_new_kind").action).toBe(
      "fail-closed",
    );
  });

  it("空 errorKind ⇒ fail-closed", () => {
    expect(degradeOnFailure(readOnly, "   ").action).toBe("fail-closed");
  });

  it("access 缺席按写处理 ⇒ fail-closed", () => {
    expect(degradeOnFailure(cap({ access: undefined }), "timeout").action).toBe(
      "fail-closed",
    );
  });

  it("畸形 capability ⇒ fail-closed", () => {
    expect(degradeOnFailure(null, "timeout").action).toBe("fail-closed");
    expect(degradeOnFailure(undefined, "timeout").action).toBe("fail-closed");
  });

  it("只返回纯数据标记（无函数/句柄字段），不执行真实副作用", () => {
    const verdict = degradeOnFailure(readOnly, "unavailable");
    expect(
      Object.values(verdict).some((value) => typeof value === "function"),
    ).toBe(false);
  });
});
