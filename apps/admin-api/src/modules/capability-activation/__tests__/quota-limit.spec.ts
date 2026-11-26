/**
 * N20 硬阈纯判定单测（零 Nest / 零 DB，直接验三态边界与匹配语义）。
 */
import type { QuotaStatusRow } from "../dto/quota.dto";
import { classifyQuota, evaluateHardLimit } from "../quota-limit";

const cfg = { softLimit: 10, hardLimit: 20 };

function row(over: Partial<QuotaStatusRow> = {}): QuotaStatusRow {
  return {
    scope: "project",
    target: "proj-a",
    softLimit: 10,
    hardLimit: 20,
    usage: 0,
    status: "ok",
    windowDays: 30,
    ...over,
  };
}

describe("N20 · classifyQuota 三态边界", () => {
  it.each<[number, string]>([
    [9, "ok"],
    [10, "warn"],
    [19, "warn"],
    [20, "exceeded"],
    [25, "exceeded"],
  ])("usage=%i → %s", (usage, expected) => {
    expect(classifyQuota(cfg, usage)).toBe(expected);
  });
});

describe("N20 · evaluateHardLimit 硬阈边界", () => {
  it("usage=hardLimit-1 放行；=hardLimit 拦截并带匹配详情", () => {
    const dto = { capabilityKey: "cap-a", projectId: "proj-a" };
    const below = evaluateHardLimit([row({ usage: 19 })], dto);
    expect(below).toEqual({ blocked: false });

    const at = evaluateHardLimit([row({ usage: 20 })], dto);
    expect(at.blocked).toBe(true);
    expect(at.matched).toEqual({
      scope: "project",
      target: "proj-a",
      usage: 20,
      hardLimit: 20,
      windowDays: 30,
    });
  });

  it("scope=capability 按 capabilityKey 匹配，不误配 projectId", () => {
    const rows = [
      row({
        scope: "capability",
        target: "cap-a",
        usage: 20,
        windowDays: 7,
      }),
    ];
    expect(
      evaluateHardLimit(rows, {
        capabilityKey: "cap-a",
        projectId: "other-proj",
      }).blocked,
    ).toBe(true);
    expect(
      evaluateHardLimit(rows, {
        capabilityKey: "cap-b",
        projectId: "proj-a",
      }).blocked,
    ).toBe(false);
  });

  it("scope=project 缺席 projectId 不命中；target 不匹配不拦截", () => {
    expect(
      evaluateHardLimit([row({ usage: 99 })], { capabilityKey: "cap-a" })
        .blocked,
    ).toBe(false);
    expect(
      evaluateHardLimit([row({ usage: 99 })], {
        capabilityKey: "cap-a",
        projectId: "proj-b",
      }).blocked,
    ).toBe(false);
  });

  it("无配置放行；多配置任一命中即拦截", () => {
    expect(
      evaluateHardLimit([], { capabilityKey: "cap-a", projectId: "p" }),
    ).toEqual({ blocked: false });
    const rows = [
      row({ target: "proj-a", usage: 1 }),
      row({ target: "proj-b", usage: 20 }),
      row({ scope: "capability", target: "cap-a", usage: 2 }),
    ];
    expect(
      evaluateHardLimit(rows, { capabilityKey: "cap-a", projectId: "proj-a" })
        .blocked,
    ).toBe(false);
    expect(
      evaluateHardLimit(rows, { capabilityKey: "cap-a", projectId: "proj-b" })
        .matched?.target,
    ).toBe("proj-b");
    expect(
      evaluateHardLimit(rows, { capabilityKey: "cap-b", projectId: "proj-a" })
        .blocked,
    ).toBe(false);
  });
});

describe("N20 · 金额硬闸 unit='amount'（金额不可得显式 skip）", () => {
  const dto = { capabilityKey: "cap-a", projectId: "proj-a" };

  it("控制组：旧配置无 unit 仍按 usage 比较，matched 不带金额字段", () => {
    const legacy = row({ usage: 20 });
    const decision = evaluateHardLimit([legacy], dto);
    expect(decision).toEqual({
      blocked: true,
      matched: {
        scope: "project",
        target: "proj-a",
        usage: 20,
        hardLimit: 20,
        windowDays: 30,
      },
    });
    expect(decision.matched?.unit).toBeUndefined();
    expect(decision.matched?.amount).toBeUndefined();
  });

  it("amount >= amountHardLimit → blocked，matched 带 unit/amount/reason", () => {
    const hit = evaluateHardLimit(
      [
        row({
          unit: "amount",
          amount: 12.5,
          amountHardLimit: 10,
          priceReason: "priced",
          usage: 3,
        }),
      ],
      dto,
    );
    expect(hit.blocked).toBe(true);
    expect(hit.matched).toEqual({
      scope: "project",
      target: "proj-a",
      usage: 3,
      hardLimit: 20,
      windowDays: 30,
      unit: "amount",
      amount: 12.5,
      priceReason: "priced",
      reason: "priced",
      amountHardLimit: 10,
    });
  });

  it.each<Array<number | null | undefined>>([
    [null],
    [Number.NaN],
    [undefined],
  ])("amount=%p → skip 且不比较阈值（不是按 0 未超限）", (amount) => {
    const readLimit = jest.fn(() => 20);
    const skipped = row({
      unit: "amount",
      amount: amount as number | null,
      priceReason: "NO_TOKEN_SAMPLE",
      usage: 999,
    });
    // 阈值若被读取即证明走了比较分支；null→0 会读取它参与比较。
    Object.defineProperty(skipped, "hardLimit", {
      configurable: true,
      enumerable: true,
      get: readLimit,
    });
    Object.defineProperty(skipped, "amountHardLimit", {
      configurable: true,
      enumerable: true,
      get: readLimit,
    });

    const decision = evaluateHardLimit([skipped], dto);
    expect(decision.blocked).toBe(false);
    expect(decision.matched).toBeUndefined();
    expect(decision.reasons).toHaveLength(1);
    expect(decision.reasons?.[0]).toContain("NO_TOKEN_SAMPLE");
    expect(readLimit).not.toHaveBeenCalled();
  });

  it("amount < amountHardLimit → 放行且不带 skip reason", () => {
    const decision = evaluateHardLimit(
      [row({ unit: "amount", amount: 9.99, amountHardLimit: 10 })],
      dto,
    );
    expect(decision).toEqual({ blocked: false });
  });
});
