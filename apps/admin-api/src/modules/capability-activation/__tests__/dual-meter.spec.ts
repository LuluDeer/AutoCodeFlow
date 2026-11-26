/**
 * N20 双口径计量纯函数单测（零 Nest / 零 DB）。
 *
 * 包含两组反证：成功交付误计 failure、权重未归一化；任一实现回退都会转红。
 */
import {
  attributeCost,
  MEASUREMENT_NOTE,
  meterActivations,
  type CostWeight,
  type RawActivationLog,
} from "../dual-meter";

function log(
  capabilityKey: string,
  result: string,
  projectId: string | null = null,
): RawActivationLog {
  return { capabilityKey, projectId, result };
}

function reportForAllocation() {
  return meterActivations([
    log("cap-a", "success", "proj-1"),
    log("cap-a", "failure", "proj-2"),
    log("cap-b", "success", "proj-1"),
  ]);
}

describe("N20 · meterActivations 双口径计量", () => {
  it("空输入 → 零报告且 skipped=0；不产出 token/货币值", () => {
    expect(meterActivations([])).toEqual({
      basis: "invocations+successfulDeliveries",
      note: MEASUREMENT_NOTE,
      tokenSample: null,
      currencyValue: null,
      total: { invocations: 0, successfulDeliveries: 0, skipped: 0 },
      byCapability: [],
      byProject: [],
    });
  });

  it("按 capability 与 project 聚合两个口径；failure/blocked 只进调用次数", () => {
    const report = meterActivations([
      log("cap-a", "success", "proj-1"),
      log("cap-a", "failure", "proj-1"),
      log("cap-a", "blocked", "proj-2"),
      log("cap-b", "success", "proj-1"),
      log("cap-b", "success"),
    ]);

    expect(report.byCapability).toEqual([
      { capabilityKey: "cap-a", invocations: 3, successfulDeliveries: 1 },
      { capabilityKey: "cap-b", invocations: 2, successfulDeliveries: 2 },
    ]);
    expect(report.byProject).toEqual([
      { projectId: "proj-1", invocations: 3, successfulDeliveries: 2 },
      { projectId: null, invocations: 1, successfulDeliveries: 1 },
      { projectId: "proj-2", invocations: 1, successfulDeliveries: 0 },
    ]);
    expect(report.total).toEqual({
      invocations: 5,
      successfulDeliveries: 3,
      skipped: 0,
    });
  });

  it("反证：只有 failure 与 blocked 时 successfulDeliveries 必须为 0（误计即红）", () => {
    const report = meterActivations([
      log("cap-a", "failure", "proj-1"),
      log("cap-a", "blocked", "proj-1"),
    ]);
    expect(report.total.invocations).toBe(2);
    expect(report.total.successfulDeliveries).toBe(0);
    expect(report.byCapability).toEqual([
      { capabilityKey: "cap-a", invocations: 2, successfulDeliveries: 0 },
    ]);
    expect(report.byProject).toEqual([
      { projectId: "proj-1", invocations: 2, successfulDeliveries: 0 },
    ]);
  });

  it("控制组：全部 success 时两个口径相等", () => {
    const report = meterActivations([
      log("cap-a", "success", "proj-1"),
      log("cap-b", "success", "proj-1"),
    ]);
    expect(report.total.successfulDeliveries).toBe(report.total.invocations);
    expect(report.total).toEqual({
      invocations: 2,
      successfulDeliveries: 2,
      skipped: 0,
    });
  });

  it("fail-closed：缺 capabilityKey / result 非法 / projectId 类型错 / 非对象均跳过并计数", () => {
    const broken = [
      { result: "success", projectId: "proj-1" },
      { capabilityKey: "", result: "success" },
      { capabilityKey: "  ", result: "success" },
      { capabilityKey: "cap-a", result: "unknown" },
      { capabilityKey: "cap-a" },
      { capabilityKey: "cap-a", result: "success", projectId: 42 },
      null,
      ["cap-a", "success"],
      log("cap-a", "failure"),
    ] as unknown as RawActivationLog[];

    const report = meterActivations(broken);
    expect(report.total).toEqual({
      invocations: 1,
      successfulDeliveries: 0,
      skipped: 8,
    });
    expect(report.byCapability).toEqual([
      { capabilityKey: "cap-a", invocations: 1, successfulDeliveries: 0 },
    ]);
    expect(report.byProject).toEqual([
      { projectId: null, invocations: 1, successfulDeliveries: 0 },
    ]);
  });

  it("接受实体形状的多字段日志对象（只读最小字段面）", () => {
    const entityLike = [
      {
        id: "11111111-1111-1111-1111-111111111111",
        capabilityKey: "cap-a",
        projectId: "proj-1",
        result: "success",
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
      },
    ] as unknown as RawActivationLog[];
    const report = meterActivations(entityLike);
    expect(report.total.successfulDeliveries).toBe(1);
    expect(report.byProject[0].projectId).toBe("proj-1");
  });

  it("不修改输入数组与条目", () => {
    const logs = [log("cap-a", "success", "proj-1"), log("cap-b", "failure")];
    const snapshot = JSON.stringify(logs);
    meterActivations(logs);
    expect(JSON.stringify(logs)).toBe(snapshot);
  });
});

describe("N20 · attributeCost 相对份额分摊", () => {
  it("控制组：归一化权重 → 每实体份额合计 1，且无 token/货币值", () => {
    const report = reportForAllocation();
    const weights: CostWeight[] = [
      { scope: "capability", target: "cap-a", weight: 0.25 },
      { scope: "capability", target: "cap-b", weight: 0.5 },
      { scope: "project", target: "proj-1", weight: 0.15 },
      { scope: "project", target: "proj-2", weight: 0.1 },
    ];

    const allocation = attributeCost(report, weights);
    expect(allocation).toEqual({
      unit: "relative-share",
      note: MEASUREMENT_NOTE,
      tokenSample: null,
      currencyValue: null,
      byCapability: [
        { scope: "capability", target: "cap-a", fraction: 0.25 },
        { scope: "capability", target: "cap-b", fraction: 0.5 },
      ],
      byProject: [
        { scope: "project", target: "proj-1", fraction: 0.15 },
        { scope: "project", target: "proj-2", fraction: 0.1 },
      ],
    });
    expect(
      [...allocation.byCapability, ...allocation.byProject].reduce(
        (sum, row) => sum + row.fraction,
        0,
      ),
    ).toBeCloseTo(1, 10);
  });

  it("反证：权重总和 0.9（未归一化）→ 抛错", () => {
    const report = reportForAllocation();
    const weights: CostWeight[] = [
      { scope: "capability", target: "cap-a", weight: 0.25 },
      { scope: "capability", target: "cap-b", weight: 0.5 },
      { scope: "project", target: "proj-1", weight: 0.15 },
      { scope: "project", target: "proj-2", weight: 0 },
    ];
    expect(() => attributeCost(report, weights)).toThrow(/未归一化/);
  });

  it("反证：负权重、NaN、Infinity → 抛错", () => {
    const report = reportForAllocation();
    const base: CostWeight[] = [
      { scope: "capability", target: "cap-a", weight: 1 },
      { scope: "capability", target: "cap-b", weight: 0 },
      { scope: "project", target: "proj-1", weight: 0 },
      { scope: "project", target: "proj-2", weight: 0 },
    ];
    for (const bad of [-0.1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const weights = base.map((w, i) => (i === 0 ? { ...w, weight: bad } : w));
      expect(() => attributeCost(report, weights)).toThrow(/非负有限数/);
    }
  });

  it("权重必须恰好覆盖报告实体：缺失、重复、多余、维度非法均抛错", () => {
    const report = reportForAllocation();
    const full: CostWeight[] = [
      { scope: "capability", target: "cap-a", weight: 0.25 },
      { scope: "capability", target: "cap-b", weight: 0.5 },
      { scope: "project", target: "proj-1", weight: 0.15 },
      { scope: "project", target: "proj-2", weight: 0.1 },
    ];

    expect(() => attributeCost(report, full.slice(1))).toThrow(/未覆盖/);
    expect(() =>
      attributeCost(report, [full[0], full[0], full[2], full[3]]),
    ).toThrow(/重复/);
    expect(() =>
      attributeCost(report, [
        full[0],
        full[1],
        full[2],
        { scope: "project", target: "proj-x", weight: 0.1 },
      ]),
    ).toThrow(/不在计量报告中/);
    expect(() =>
      attributeCost(report, [
        {
          scope: "unknown",
          target: "cap-a",
          weight: 1,
        } as unknown as CostWeight,
        ...full.slice(1),
      ]),
    ).toThrow(/维度非法/);
  });

  it("空报告只接受空权重；空权重分摊后两维均为空", () => {
    const report = meterActivations([]);
    expect(() => attributeCost(report, [])).not.toThrow();
    expect(attributeCost(report, [])).toEqual({
      unit: "relative-share",
      note: MEASUREMENT_NOTE,
      tokenSample: null,
      currencyValue: null,
      byCapability: [],
      byProject: [],
    });
  });

  it("不修改 report 与 weights", () => {
    const report = reportForAllocation();
    const weights: CostWeight[] = [
      { scope: "capability", target: "cap-a", weight: 0.25 },
      { scope: "capability", target: "cap-b", weight: 0.5 },
      { scope: "project", target: "proj-1", weight: 0.15 },
      { scope: "project", target: "proj-2", weight: 0.1 },
    ];
    const before = JSON.stringify({ report, weights });
    attributeCost(report, weights);
    expect(JSON.stringify({ report, weights })).toBe(before);
  });
});
