/**
 * N20 双口径计量纯函数层（零 Nest / 零 DB / 零 token 计费）。
 *
 * capability_activation_log 只有调用事实，本仓没有 token 用量样本，因此这里只
 * 建模两个可复算口径：invocations（调用次数）与 successfulDeliveries
 * （result=success 的次数）。tokenSample / currencyValue / priceReason 是为下游
 * 金额折算预留的显式声明位：本层不采样、不折算，恒为 null / null /
 * NO_TOKEN_SAMPLE，不编造任何用量或金额。
 *
 * result 的合法集合与 entities/activation-log.entity.ts 的 ACTIVATION_RESULTS
 * 相同，但刻意不 import 那个模块，以保持本文件对 ORM 的零依赖。
 */

import type { PriceReason, TokenSample } from "./price.dto";

/** 计量口径标签：报告自描述，消费方可据此核对口径。 */
export type DualMeterBasis = "invocations+successfulDeliveries";

/** 口径声明：无 token 样本，不产出 token/货币值，只有两个可复算计数口径。 */
export type MeasurementNote =
  "无 token 样本，不产出 token/货币值；仅调用次数与成功交付次数两个可复算口径";

export const MEASUREMENT_NOTE: MeasurementNote =
  "无 token 样本，不产出 token/货币值；仅调用次数与成功交付次数两个可复算口径";

/** 输入日志的最小字段面：字段为 unknown，由本层校验后才计数（fail-closed）。 */
export interface RawActivationLog {
  capabilityKey?: unknown;
  projectId?: unknown;
  result?: unknown;
}

/** 两个口径的计数。 */
export interface DualMeterCounts {
  invocations: number;
  successfulDeliveries: number;
}

export interface CapabilityMeterRow extends DualMeterCounts {
  capabilityKey: string;
}

export interface ProjectMeterRow extends DualMeterCounts {
  projectId: string | null;
}

/**
 * 双口径计量报告。
 *
 * tokenSample / currencyValue / priceReason 是结构上的显式声明位，不参与计数：
 * 本层没有 token 样本，故恒为 null / null / 'NO_TOKEN_SAMPLE'；下游折算成功后
 * 才能写入非空样本与金额。零样本绝不写成 0 元。
 */
export interface DualMeterReport {
  readonly basis: DualMeterBasis;
  readonly note: MeasurementNote;
  readonly tokenSample: TokenSample | null;
  readonly currencyValue: number | null;
  readonly priceReason: PriceReason;
  readonly total: DualMeterCounts & { skipped: number };
  readonly byCapability: CapabilityMeterRow[];
  readonly byProject: ProjectMeterRow[];
}

/** 分摊维度。 */
export type CostScope = "capability" | "project";

/**
 * 一条分摊权重。weight 是**相对份额**（非负、有限），不是 token 数，也不是金额；
 * 全部权重之和必须为 1，否则 attributeCost 抛错。
 */
export interface CostWeight {
  scope: CostScope;
  /** capability 维度为 capabilityKey；project 维度为 projectId（null = 未归属）。 */
  target: string | null;
  weight: number;
}

/** 分摊结果行：fraction 是归一化后的相对份额，总和为 1，无 token/货币单位。 */
export interface CostAllocationRow {
  scope: CostScope;
  target: string | null;
  fraction: number;
}

export interface CostAllocation {
  readonly unit: "relative-share";
  readonly note: MeasurementNote;
  readonly tokenSample: TokenSample | null;
  readonly currencyValue: number | null;
  readonly priceReason: PriceReason;
  readonly byCapability: CostAllocationRow[];
  readonly byProject: CostAllocationRow[];
}

const VALID_RESULTS = ["success", "failure", "blocked"] as const;
const NORMALIZATION_EPSILON = 1e-9;

function emptyCounts(): DualMeterCounts {
  return { invocations: 0, successfulDeliveries: 0 };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 按 capability / project 聚合两个口径。
 *
 * fail-closed：日志条目不是对象、capabilityKey 不是非空字符串、result 不在
 * success/failure/blocked 内、projectId 不是字符串/null/undefined，均跳过并计入
 * total.skipped，不静默吞掉。空输入返回零报告且 skipped=0。
 *
 * 分组按 invocations 降序、key 升序排列，结果可复算。
 */
export function meterActivations(
  logs: readonly RawActivationLog[],
): DualMeterReport {
  const capability = new Map<string, DualMeterCounts>();
  const project = new Map<string | null, DualMeterCounts>();
  let skipped = 0;

  for (const entry of logs) {
    if (!isRecord(entry)) {
      skipped += 1;
      continue;
    }
    const { capabilityKey, projectId, result } = entry;
    if (typeof capabilityKey !== "string" || capabilityKey.trim() === "") {
      skipped += 1;
      continue;
    }
    if (
      typeof result !== "string" ||
      !VALID_RESULTS.some((valid) => valid === result)
    ) {
      skipped += 1;
      continue;
    }
    let owner: string | null;
    if (projectId === null || projectId === undefined) {
      owner = null;
    } else if (typeof projectId === "string") {
      owner = projectId;
    } else {
      skipped += 1;
      continue;
    }
    const delivered = result === "success";
    const capRow = capability.get(capabilityKey) ?? emptyCounts();
    capRow.invocations += 1;
    if (delivered) capRow.successfulDeliveries += 1;
    capability.set(capabilityKey, capRow);

    const projRow = project.get(owner) ?? emptyCounts();
    projRow.invocations += 1;
    if (delivered) projRow.successfulDeliveries += 1;
    project.set(owner, projRow);
  }

  const byCapability = [...capability.entries()]
    .sort(
      ([keyA, a], [keyB, b]) =>
        b.invocations - a.invocations || keyA.localeCompare(keyB),
    )
    .map(([capabilityKey, counts]) => ({ capabilityKey, ...counts }));
  const byProject = [...project.entries()]
    .sort(
      ([keyA, a], [keyB, b]) =>
        b.invocations - a.invocations || (keyA ?? "").localeCompare(keyB ?? ""),
    )
    .map(([projectId, counts]) => ({ projectId, ...counts }));

  return {
    basis: "invocations+successfulDeliveries",
    note: MEASUREMENT_NOTE,
    tokenSample: null,
    currencyValue: null,
    priceReason: "NO_TOKEN_SAMPLE",
    total: {
      invocations: byCapability.reduce((sum, r) => sum + r.invocations, 0),
      successfulDeliveries: byCapability.reduce(
        (sum, r) => sum + r.successfulDeliveries,
        0,
      ),
      skipped,
    },
    byCapability,
    byProject,
  };
}

function weightKey(scope: CostScope, target: string | null): string {
  return `${scope}\u0000${String(target)}`;
}

/**
 * 按相对份额把一份成本分摊到报告里的每个 capability / project。
 *
 * 输入 weight 总和必须为 1（容差 1e-9），每项非负且有限，且恰好覆盖报告中的
 * 每个维度实体；任一不满足即抛错（fail-closed）。不归一化就转红，避免静默产生
 * 合计不为 1 的份额。返回的是份额，不是 token 数或货币金额。
 */
export function attributeCost(
  report: DualMeterReport,
  weights: readonly CostWeight[],
): CostAllocation {
  const expected = new Set<string>();
  for (const row of report.byCapability) {
    expected.add(weightKey("capability", row.capabilityKey));
  }
  for (const row of report.byProject) {
    expected.add(weightKey("project", row.projectId));
  }

  // 空报告没有实体可供分摊：空权重返回空分摊，非空权重视为多余输入。
  if (expected.size === 0) {
    if (weights.length !== 0) {
      throw new Error(`空计量报告不接受分摊权重：${weights.length}`);
    }
    return {
      unit: "relative-share",
      note: MEASUREMENT_NOTE,
      tokenSample: null,
      currencyValue: null,
      priceReason: "NO_TOKEN_SAMPLE",
      byCapability: [],
      byProject: [],
    };
  }

  const given = new Map<string, number>();
  let sum = 0;
  for (const weight of weights) {
    if (weight.scope !== "capability" && weight.scope !== "project") {
      throw new Error(`分摊维度非法：${String(weight.scope)}`);
    }
    if (!Number.isFinite(weight.weight) || weight.weight < 0) {
      throw new Error(`分摊权重必须是非负有限数：${String(weight.weight)}`);
    }
    const key = weightKey(weight.scope, weight.target);
    if (given.has(key)) {
      throw new Error(`分摊权重重复：${key}`);
    }
    if (!expected.has(key)) {
      throw new Error(`分摊目标不在计量报告中：${key}`);
    }
    given.set(key, weight.weight);
    sum += weight.weight;
  }

  if (given.size !== expected.size) {
    throw new Error(`分摊权重未覆盖全部实体：${given.size}/${expected.size}`);
  }
  if (Math.abs(sum - 1) > NORMALIZATION_EPSILON) {
    throw new Error(`分摊权重未归一化：总和=${sum}`);
  }

  const fractionOf = (scope: CostScope, target: string | null): number => {
    const value = given.get(weightKey(scope, target));
    if (value === undefined) {
      throw new Error(`分摊权重缺失：${weightKey(scope, target)}`);
    }
    return value;
  };

  return {
    unit: "relative-share",
    note: MEASUREMENT_NOTE,
    tokenSample: null,
    currencyValue: null,
    priceReason: "NO_TOKEN_SAMPLE",
    byCapability: report.byCapability.map((row) => ({
      scope: "capability",
      target: row.capabilityKey,
      fraction: fractionOf("capability", row.capabilityKey),
    })),
    byProject: report.byProject.map((row) => ({
      scope: "project",
      target: row.projectId,
      fraction: fractionOf("project", row.projectId),
    })),
  };
}
