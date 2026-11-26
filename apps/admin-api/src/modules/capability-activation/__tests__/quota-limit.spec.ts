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
