#!/usr/bin/env node
/**
 * sop-success-rate.mjs — SOP 成功率 / 人工接管率（ROADMAP 先行指标 ≥90% / ≤10%）。
 *
 * 口径（PM 裁决 R452）：只统计**终态**指派（completed / failed / cancelled，与
 * sop-clarification-inbox.service.ts:982/2160 的终态三项判据一致）；assigned /
 * in_progress / blocked / stalled 是非终态、不计入分母。
 *   · SOP 成功率 = completed / 终态数。
 *   · 人工接管率 = 终态中「status=failed（按 inbox 注释：等人接管） OR 存在
 *     resolution='escalated_to_human' 的澄清（超出 Agent 能力→通知人）」的
 *     不同 assignment 数 / 终态数。两类信号用 DISTINCT 去重，避免双计。
 * 时间窗：assignment.createdAt ∈ [as_of − days, as_of]，days 默认 30（--days 覆盖）。
 *
 * 零 DDL、零新埋点——复用 sop_assignments / sop_clarifications 现有表。口令不落日志。
 *
 * CLI:
 *   node scripts/sop-success-rate.mjs --selftest
 *   node scripts/sop-success-rate.mjs --report [--dsn DSN] [--as-of ISO] [--days N] [--json]
 * 退出码：0 跑完（含 SKIP） / 1 夹具失败 / 2 结构错 / 3 连不上库。
 */
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const NO_TARGET =
  "SKIP: 未配置连接参数（--dsn / DATABASE_URL / DB_*），未尝试连库（exit 0）";
const TERMINAL = ["completed", "failed", "cancelled"];
const ESCALATED = "escalated_to_human";

class StructuralError extends Error {}

/**
 * 权威 SQL（只读）：终态分母 + 成功率 + 接管率（failed OR escalated 去重）。
 * $1::timestamptz = as_of；$2 = 窗口天数。
 */
export const SOP_RATE_SQL = `WITH terminal AS (
  SELECT id, status
  FROM sop_assignments
  WHERE status IN ('completed', 'failed', 'cancelled')
    AND "createdAt" >= $1::timestamptz - ($2 * INTERVAL '1 day')
    AND "createdAt" <= $1::timestamptz
), taken_over AS (
  SELECT DISTINCT t.id
  FROM terminal t
  WHERE t.status = 'failed'
     OR EXISTS (
       SELECT 1 FROM sop_clarifications c
       WHERE c."assignmentId" = t.id AND c.resolution = 'escalated_to_human'
     )
)
SELECT
  (SELECT COUNT(*) FROM terminal) AS terminal_count,
  (SELECT COUNT(*) FROM terminal WHERE status = 'completed') AS completed_count,
  (SELECT COUNT(*) FROM taken_over) AS takeover_count`;

/** 内存复刻：assignments=[{id,status,createdAt}]，clarifications=[{assignmentId,resolution}]。 */
export function computeSopRates(assignments, clarifications, asOfIso, days = 30) {
  const asOf = Date.parse(asOfIso);
  if (!Number.isFinite(asOf)) throw new StructuralError(`非法 as_of: ${asOfIso}`);
  if (!Number.isFinite(days) || days <= 0) throw new StructuralError(`非法 days: ${days}`);
  const lo = asOf - days * 86400_000;
  const terminal = assignments.filter(
    (a) => TERMINAL.includes(a.status) && Date.parse(a.createdAt) >= lo && Date.parse(a.createdAt) <= asOf,
  );
  const escalatedIds = new Set(
    clarifications.filter((c) => c.resolution === ESCALATED).map((c) => c.assignmentId),
  );
  const completed = terminal.filter((a) => a.status === "completed").length;
  const takeover = terminal.filter(
    (a) => a.status === "failed" || escalatedIds.has(a.id),
  ).length;
  const n = terminal.length;
  return {
    as_of: new Date(asOf).toISOString(),
    window_days: days,
    terminal_count: n,
    completed_count: completed,
    takeover_count: takeover,
    success_rate: n === 0 ? null : completed / n,
    takeover_rate: n === 0 ? null : takeover / n,
    thresholds: { minSuccessRate: 0.9, maxTakeoverRate: 0.1 },
    warnings: [
      "SOP 成功率/接管率只统计终态指派（completed/failed/cancelled）；非终态不计入",
      "failed 按等人接管计、escalated_to_human 澄清按升级人工计，DISTINCT 去重避免双计",
    ],
  };
}

const DAY = 86400_000;
const iso = (d) => new Date(d).toISOString();
const BASE = Date.parse("2026-01-01T00:00:00Z");
const asg = (id, status, day) => ({ id, status, createdAt: iso(BASE + day * DAY) });
const clar = (assignmentId, resolution) => ({ assignmentId, resolution });

export const FIXTURES = [
  {
    name: "达标：9 completed + 1 failed ⇒ 成功率 0.9 / 接管率 0.1",
    assignments: [
      ...Array.from({ length: 9 }, (_, i) => asg(`c${i}`, "completed", -2)),
      asg("f0", "failed", -2),
    ],
    clarifications: [],
    days: 30,
    expected: { terminal: 10, completed: 9, takeover: 1, success: 0.9, take: 0.1 },
  },
  {
    name: "escalated 澄清计入接管：completed 但有升级澄清 ⇒ 接管率上升",
    assignments: [asg("a", "completed", -2), asg("b", "completed", -2)],
    clarifications: [clar("a", "escalated_to_human"), clar("b", "answered")],
    days: 30,
    expected: { terminal: 2, completed: 2, takeover: 1, success: 1, take: 0.5 },
  },
  {
    name: "去重：failed + escalated 同一 assignment 只算一次接管",
    assignments: [asg("x", "failed", -2), asg("y", "completed", -2)],
    clarifications: [clar("x", "escalated_to_human")],
    days: 30,
    expected: { terminal: 2, completed: 1, takeover: 1, success: 0.5, take: 0.5 },
  },
  {
    name: "非终态不计入：assigned/in_progress/stalled 全排除",
    assignments: [asg("a", "assigned", -2), asg("b", "in_progress", -2), asg("c", "stalled", -2), asg("d", "completed", -2)],
    clarifications: [],
    days: 30,
    expected: { terminal: 1, completed: 1, takeover: 0, success: 1, take: 0 },
  },
  {
    name: "窗口外不计入：31 天前的终态排除（days=30）",
    assignments: [asg("old", "failed", -31), asg("new", "completed", -2)],
    clarifications: [],
    days: 30,
    expected: { terminal: 1, completed: 1, takeover: 0, success: 1, take: 0 },
  },
  {
    name: "空样本 ⇒ rate=null 不伪造",
    assignments: [],
    clarifications: [],
    days: 30,
    expected: { terminal: 0, completed: 0, takeover: 0, success: null, take: null },
  },
];

export function runFixtures() {
  const problems = [];
  for (const f of FIXTURES) {
    const got = computeSopRates(f.assignments, f.clarifications, iso(BASE), f.days);
    const bad = [];
    const pairs = [
      ["terminal", got.terminal_count, f.expected.terminal],
      ["completed", got.completed_count, f.expected.completed],
      ["takeover", got.takeover_count, f.expected.takeover],
      ["success", got.success_rate, f.expected.success],
      ["take", got.takeover_rate, f.expected.take],
    ];
    for (const [k, a, e] of pairs) if (a !== e) bad.push(`${k} 期望 ${e} 实得 ${a}`);
    if (got.warnings.length < 2) bad.push("警告缺失");
    console.log(`  ${bad.length ? "✘" : "✓"} ${f.name}${bad.length ? " — " + bad.join("；") : ""}`);
    if (bad.length) problems.push(f.name);
  }
  console.log(`\nSELFTEST ${FIXTURES.length - problems.length}/${FIXTURES.length} 通过` + (problems.length ? "（有夹具不通过）" : "（全部符合预期）"));
  return problems.length === 0;
}

function parseArgs(argv) {
  const o = { selftest: false, report: false, json: false, asOf: null, days: 30, dsn: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--selftest") o.selftest = true;
    else if (a === "--report") o.report = true;
    else if (a === "--json") o.json = true;
    else if (a === "--as-of") o.asOf = argv[++i];
    else if (a === "--days") o.days = Number(argv[++i]);
    else if (a === "--dsn") o.dsn = argv[++i];
    else if (a.startsWith("--dsn=")) o.dsn = a.slice(6);
  }
  return o;
}

function resolveTarget(dsn) {
  if (dsn) return dsn;
  const e = process.env;
  if (e.DATABASE_URL) return e.DATABASE_URL;
  if (e.DB_HOST && e.DB_USERNAME && e.DB_DATABASE) {
    const pw = e.DB_PASSWORD ? `:${encodeURIComponent(e.DB_PASSWORD)}@` : "@";
    return `postgresql://${e.DB_USERNAME}${pw}${e.DB_HOST}:${e.DB_PORT || 5432}/${e.DB_DATABASE}`;
  }
  return null;
}

async function runReport(opts) {
  const dsn = resolveTarget(opts.dsn);
  if (!dsn) {
    console.log(NO_TARGET);
    if (opts.json) console.log(JSON.stringify({ status: "SKIP", message: NO_TARGET }));
    return 0;
  }
  if (!Number.isFinite(opts.days) || opts.days <= 0) throw new StructuralError(`非法 --days: ${opts.days}`);
  const require = createRequire(join(ROOT, "apps/admin-api/package.json"));
  const { Client } = require("pg");
  const client = new Client({ connectionString: dsn });
  try {
    await client.connect();
    const tbl = await client.query("SELECT to_regclass('public.sop_assignments') AS t");
    if (!tbl.rows[0]?.t) {
      const msg = "SKIP: sop_assignments 表不存在";
      console.log(msg);
      if (opts.json) console.log(JSON.stringify({ status: "SKIP", message: msg }));
      return 0;
    }
    const asOf = opts.asOf ?? new Date().toISOString();
    if (!Number.isFinite(Date.parse(asOf))) throw new StructuralError(`非法 as_of: ${asOf}`);
    const res = await client.query(SOP_RATE_SQL, [asOf, opts.days]);
    const row = res.rows[0] ?? {};
    const n = Number(row.terminal_count ?? 0);
    const completed = Number(row.completed_count ?? 0);
    const takeover = Number(row.takeover_count ?? 0);
    const payload = {
      as_of: new Date(Date.parse(asOf)).toISOString(),
      window_days: opts.days,
      terminal_count: n,
      completed_count: completed,
      takeover_count: takeover,
      success_rate: n === 0 ? null : completed / n,
      takeover_rate: n === 0 ? null : takeover / n,
      thresholds: { minSuccessRate: 0.9, maxTakeoverRate: 0.1 },
      warnings: [
        "SOP 成功率/接管率只统计终态指派（completed/failed/cancelled）；非终态不计入",
        "failed 按等人接管计、escalated_to_human 澄清按升级人工计，DISTINCT 去重避免双计",
      ],
    };
    if (opts.json) console.log(JSON.stringify({ status: "OK", ...payload }, null, 2));
    else {
      console.log("=== SOP 成功率 / 人工接管率（只读）===");
      console.log(`观测截止：${payload.as_of}（窗口 ${opts.days} 天）`);
      console.log(`终态指派 ${n}：completed=${completed}, 接管=${takeover}`);
      console.log(`SOP 成功率：${payload.success_rate === null ? "N/A" : (payload.success_rate * 100).toFixed(1) + "%"}（目标 ≥90%）`);
      console.log(`人工接管率：${payload.takeover_rate === null ? "N/A" : (payload.takeover_rate * 100).toFixed(1) + "%"}（目标 ≤10%）`);
      console.log(payload.warnings.join("\n"));
    }
    return 0;
  } finally {
    await client.end().catch(() => undefined);
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.selftest) return runFixtures() ? 0 : 1;
  if (opts.report) return runReport(opts);
  console.log("用法：node scripts/sop-success-rate.mjs --selftest | --report [--dsn DSN] [--as-of ISO] [--days N] [--json]");
  return 0;
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main().then((c) => process.exit(c)).catch((err) => {
    console.error("sop-success-rate 失败:", err.message);
    process.exit(err instanceof StructuralError ? 2 : 1);
  });
}
