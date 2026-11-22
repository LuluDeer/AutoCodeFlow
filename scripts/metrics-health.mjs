#!/usr/bin/env node
/**
 * metrics-health.mjs — 先行指标健康度判定（R455）。
 *
 * 把 ROADMAP 的目标数字（文档文字 / 指标脚本 thresholds 元数据）变成机器可判的
 * 达标状态。输入 = 各指标脚本的实测值；输出 = 每条指标的 met/status + 总体 healthy。
 *
 * PM 裁决口径：
 *   · W4 留存率 ≥ 0.4；SOP 成功率 ≥ 0.9；人工接管率 ≤ 0.1；北极星升主 eligible=true。
 *   · 无样本（value=null）⇒ status='no_data' 且 **met=false**——绝不算达标，
 *     避免「零样本假装达标」（与三个指标脚本"空样本 rate=null 不伪造"一致）。
 *   · healthy=true 当且仅当所有 check 都 met=true。
 *   · TTFV 中位数 ≤10min / 24h 激活 ≥60% 暂不纳入：ttfv-real-metrics.mjs 口径
 *     较复杂（PERCENTILE_CONT + 多 CTE），其 warnings/样本判定需单独对齐，避免
 *     在健康度脚本里复刻一套可能漂移的口径——属独立的后续接入。
 *
 * 纯函数 evaluateHealth，零依赖、无副作用。CLI --selftest / --report --input。
 */
const TARGETS = {
  w4_retention: { comparator: ">=", target: 0.4, label: "W4 实例留存率" },
  sop_success: { comparator: ">=", target: 0.9, label: "SOP 成功率" },
  sop_takeover: { comparator: "<=", target: 0.1, label: "人工接管率" },
  north_star_promotion: { comparator: "is_true", target: true, label: "北极星升主判据" },
};

/** 单条判定：无样本 ⇒ no_data + met=false；有值按 comparator 比对。 */
function judge(name, value) {
  const { comparator, target, label } = TARGETS[name];
  if (value === null || value === undefined) {
    return { name, label, value: null, target, comparator, met: false, status: "no_data" };
  }
  let met;
  if (comparator === ">=") met = Number(value) >= target;
  else if (comparator === "<=") met = Number(value) <= target;
  else if (comparator === "is_true") met = value === true;
  else throw new Error(`未知 comparator: ${comparator}`);
  return { name, label, value, target, comparator, met, status: met ? "met" : "unmet" };
}

/**
 * 纯函数健康度判定。
 * inputs = {
 *   w4_retention_rate: number|null,
 *   sop_success_rate: number|null,
 *   sop_takeover_rate: number|null,
 *   north_star_promotion_eligible: boolean,
 * }
 */
export function evaluateHealth(inputs = {}) {
  const checks = [
    judge("w4_retention", inputs.w4_retention_rate ?? null),
    judge("sop_success", inputs.sop_success_rate ?? null),
    judge("sop_takeover", inputs.sop_takeover_rate ?? null),
    judge("north_star_promotion", inputs.north_star_promotion_eligible ?? null),
  ];
  const unmet = checks.filter((c) => c.status === "unmet").map((c) => c.name);
  const noData = checks.filter((c) => c.status === "no_data").map((c) => c.name);
  const healthy = checks.every((c) => c.met);
  return {
    healthy,
    unmet,
    noData,
    checks,
    note: noData.length > 0
      ? "有指标无样本（no_data 不算达标）；需先启用对应埋点并积累数据"
      : healthy
        ? "全部先行指标达标"
        : "有先行指标未达标，见 unmet",
  };
}

export const FIXTURES = [
  {
    name: "全达标",
    inputs: { w4_retention_rate: 0.45, sop_success_rate: 0.95, sop_takeover_rate: 0.05, north_star_promotion_eligible: true },
    expected: { healthy: true, unmet: [], noData: [] },
  },
  {
    name: "边界值正好达标：0.4/0.9/0.1",
    inputs: { w4_retention_rate: 0.4, sop_success_rate: 0.9, sop_takeover_rate: 0.1, north_star_promotion_eligible: true },
    expected: { healthy: true, unmet: [], noData: [] },
  },
  {
    name: "W4 未达标",
    inputs: { w4_retention_rate: 0.35, sop_success_rate: 0.95, sop_takeover_rate: 0.05, north_star_promotion_eligible: true },
    expected: { healthy: false, unmet: ["w4_retention"], noData: [] },
  },
  {
    name: "SOP 成功率未达标 + 接管率超标",
    inputs: { w4_retention_rate: 0.5, sop_success_rate: 0.85, sop_takeover_rate: 0.15, north_star_promotion_eligible: true },
    expected: { healthy: false, unmet: ["sop_success", "sop_takeover"], noData: [] },
  },
  {
    name: "无样本：no_data 且 met=false（不算达标）",
    inputs: { w4_retention_rate: null, sop_success_rate: null, sop_takeover_rate: null, north_star_promotion_eligible: false },
    expected: { healthy: false, unmet: ["north_star_promotion"], noData: ["w4_retention", "sop_success", "sop_takeover"] },
  },
  {
    name: "混合：部分达标 + 部分无数据",
    inputs: { w4_retention_rate: 0.5, sop_success_rate: null, sop_takeover_rate: 0.05, north_star_promotion_eligible: true },
    expected: { healthy: false, unmet: [], noData: ["sop_success"] },
  },
];

export function runFixtures() {
  const problems = [];
  for (const f of FIXTURES) {
    const got = evaluateHealth(f.inputs);
    const bad = [];
    if (got.healthy !== f.expected.healthy) bad.push(`healthy 期望 ${f.expected.healthy} 实得 ${got.healthy}`);
    if (JSON.stringify(got.unmet) !== JSON.stringify(f.expected.unmet)) bad.push(`unmet 期望 ${JSON.stringify(f.expected.unmet)} 实得 ${JSON.stringify(got.unmet)}`);
    if (JSON.stringify(got.noData) !== JSON.stringify(f.expected.noData)) bad.push(`noData 期望 ${JSON.stringify(f.expected.noData)} 实得 ${JSON.stringify(got.noData)}`);
    // 核心不变量：no_data 的 check 必须 met=false
    for (const c of got.checks) {
      if (c.status === "no_data" && c.met !== false) bad.push(`${c.name} no_data 却 met=true`);
    }
    console.log(`  ${bad.length ? "✘" : "✓"} ${f.name}${bad.length ? " — " + bad.join("；") : ""}`);
    if (bad.length) problems.push(f.name);
  }
  console.log(`\nSELFTEST ${FIXTURES.length - problems.length}/${FIXTURES.length} 通过` + (problems.length ? "（有夹具不通过）" : "（全部符合预期）"));
  return problems.length === 0;
}

function parseArgs(argv) {
  const o = { selftest: false, report: false, input: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--selftest") o.selftest = true;
    else if (a === "--report") o.report = true;
    else if (a === "--input") o.input = argv[++i];
    else if (a.startsWith("--input=")) o.input = a.slice(8);
  }
  return o;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.selftest) return runFixtures() ? 0 : 1;
  if (opts.report) {
    if (!opts.input) {
      console.log("SKIP: --report 需要 --input <file.json>（本脚本不连库，输入由各指标脚本产出）");
      return 0;
    }
    const { readFileSync } = await import("node:fs");
    const inputs = JSON.parse(readFileSync(opts.input, "utf8"));
    const result = evaluateHealth(inputs);
    console.log(JSON.stringify({ status: "OK", ...result }, null, 2));
    return 0;
  }
  console.log("用法：node scripts/metrics-health.mjs --selftest | --report --input <file.json>");
  return 0;
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main().then((c) => process.exit(c)).catch((err) => {
    console.error("metrics-health 失败:", err.message);
    process.exit(2);
  });
}
