#!/usr/bin/env node
/**
 * w4-retention.mjs — W4 实例留存（ROADMAP 先行指标 ≥40%）可复算脚本。
 *
 * 口径（PM 裁决 R451）：W4 留存 = 「安装满 28 天且在**第 4 周（day 21–28）**
 * 至少有一次真实使用事件」的 install 数 / 「安装满 28 天」的 install 数。
 *   · 分母锚点 = funnel_events 的 install_completed（服务端 HMAC install_id）。
 *   · 分子"真实使用" = task_first_attempted / task_first_success / business_confirmed
 *     三类事件；install_completed 只是注册、不算使用。
 *   · 安装/使用事件的 install_id 同源（均 deriveAnonymousId(fp,"ttfv-install")）。
 *   · funnel_events 保留 90 天 > 28 天，观测窗内数据完整。
 *
 * 零 DDL、零新埋点——完全复用现有漏斗表。SQL 只读，口令不落日志。
 *
 * CLI:
 *   node scripts/w4-retention.mjs --selftest
 *   node scripts/w4-retention.mjs --report [--dsn DSN] [--as-of ISO] [--json]
 * 退出码：0 跑完（含缺表/无连接 SKIP） / 1 夹具失败 / 2 结构错 / 3 连不上库。
 */
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const NO_TARGET =
  "SKIP: 未配置连接参数（--dsn / DATABASE_URL / DB_*），未尝试连库（exit 0）";
const NO_TABLE = "SKIP: funnel_events 表不存在（需先跑 migration 0101）";
const W4_DAYS = 28;
const W4_WINDOW_START_DAYS = 21; // 第 4 周 = 安装后 day 21–28
const USAGE_EVENTS = [
  "task_first_attempted",
  "task_first_success",
  "business_confirmed",
];
const RETENTION_WARNING =
  "W4 留存只覆盖 opt-in 安装（漏斗表双闸写入）；未授权安装的行为不进分母/分子";

class StructuralError extends Error {}

/**
 * 权威 SQL（只读）：分母 = 安装满 28 天的 install；分子 = 其中在第4周有使用事件的 install。
 * 用 CTE 按 install_id 关联；时间窗相对每个 install 的安装时刻。
 */
export const W4_RETENTION_SQL = `WITH installed AS (
  SELECT install_id, MIN(ts) AS installed_at
  FROM funnel_events
  WHERE event_name = 'install_completed'
    AND ts <= $1::timestamptz - INTERVAL '28 days'
  GROUP BY install_id
), used_w4 AS (
  SELECT DISTINCT i.install_id
  FROM installed i
  JOIN funnel_events e
    ON e.install_id = i.install_id
   AND e.event_name IN ('task_first_attempted', 'task_first_success', 'business_confirmed')
   AND e.ts >= i.installed_at + INTERVAL '21 days'
   AND e.ts <= i.installed_at + INTERVAL '28 days'
)
SELECT
  (SELECT COUNT(*) FROM installed) AS eligible_installs,
  (SELECT COUNT(*) FROM used_w4) AS retained_installs`;

/** 内存版复刻 SQL 语义（selftest 用）：events = [{installId,eventName,ts}]。 */
export function computeW4Retention(events, asOfIso) {
  const asOf = Date.parse(asOfIso);
  if (!Number.isFinite(asOf)) throw new StructuralError(`非法 as_of: ${asOfIso}`);
  const installedAt = new Map();
  for (const e of events) {
    if (e.eventName !== "install_completed") continue;
    const ts = Date.parse(e.ts);
    if (!Number.isFinite(ts) || ts > asOf - W4_DAYS * 86400_000) continue;
    const prev = installedAt.get(e.installId);
    if (prev === undefined || ts < prev) installedAt.set(e.installId, ts);
  }
  const retained = new Set();
  for (const e of events) {
    if (!USAGE_EVENTS.includes(e.eventName)) continue;
    const base = installedAt.get(e.installId);
    if (base === undefined) continue;
    const ts = Date.parse(e.ts);
    if (
      Number.isFinite(ts) &&
      ts >= base + W4_WINDOW_START_DAYS * 86400_000 &&
      ts <= base + W4_DAYS * 86400_000
    ) {
      retained.add(e.installId);
    }
  }
  const eligible = installedAt.size;
  return {
    as_of: new Date(asOf).toISOString(),
    eligible_installs: eligible,
    retained_installs: retained.size,
    retention_rate: eligible === 0 ? null : retained.size / eligible,
    thresholds: { minRetentionRate: 0.4, windowDays: W4_DAYS, usageWindowStartDays: W4_WINDOW_START_DAYS },
    usage_events: USAGE_EVENTS.slice(),
    warnings: [RETENTION_WARNING],
  };
}

const DAY = 86400_000;
const iso = (d) => new Date(d).toISOString();
const BASE = Date.parse("2026-01-01T00:00:00Z");
const inst = (id, dayOffset) => ({ installId: id, eventName: "install_completed", ts: iso(BASE + dayOffset * DAY) });
const use = (id, dayOffset, kind = "task_first_attempted") => ({ installId: id, eventName: kind, ts: iso(BASE + dayOffset * DAY) });

export const FIXTURES = [
  {
    name: "达标：100 install 全满 28 天，40 在第4周活跃 ⇒ 0.40",
    events: (() => {
      const out = [];
      for (let i = 0; i < 100; i++) {
        out.push(inst(`u${i}`, -30));
        if (i < 40) out.push(use(`u${i}`, -5)); // 安装后 day 25（第4周）
      }
      return out;
    })(),
    asOf: iso(BASE),
    expected: { eligible: 100, retained: 40, rate: 0.4 },
  },
  {
    name: "不达标：第4周无使用 ⇒ 0",
    events: [inst("u1", -30), use("u1", -10)], // day 20，不在第4周
    asOf: iso(BASE),
    expected: { eligible: 1, retained: 0, rate: 0 },
  },
  {
    name: "边界：day 21 计入、day 28 计入、day 20/29 排除",
    events: [inst("a", -40), use("a", -19), inst("b", -40), use("b", -12), inst("c", -40), use("c", -20), inst("d", -40), use("d", -11)],
    asOf: iso(BASE),
    expected: { eligible: 4, retained: 2, rate: 0.5 }, // a(day21)+b(day28) 计入
  },
  {
    name: "未满 28 天的 install 不进分母",
    events: [inst("young", -10), use("young", -2), inst("old", -30), use("old", -5)],
    asOf: iso(BASE),
    expected: { eligible: 1, retained: 1, rate: 1 },
  },
  {
    name: "空样本 ⇒ rate=null 不伪造",
    events: [],
    asOf: iso(BASE),
    expected: { eligible: 0, retained: 0, rate: null },
  },
];

export function runFixtures() {
  const problems = [];
  for (const f of FIXTURES) {
    const got = computeW4Retention(f.events, f.asOf);
    const bad = [];
    if (got.eligible_installs !== f.expected.eligible) bad.push(`eligible 期望 ${f.expected.eligible} 实得 ${got.eligible_installs}`);
    if (got.retained_installs !== f.expected.retained) bad.push(`retained 期望 ${f.expected.retained} 实得 ${got.retained_installs}`);
    if (got.retention_rate !== f.expected.rate) bad.push(`rate 期望 ${f.expected.rate} 实得 ${got.retention_rate}`);
    if (got.warnings.length === 0) bad.push("警告缺失");
    console.log(`  ${bad.length ? "✘" : "✓"} ${f.name}${bad.length ? " — " + bad.join("；") : ""}`);
    if (bad.length) problems.push(f.name);
  }
  console.log(`\nSELFTEST ${FIXTURES.length - problems.length}/${FIXTURES.length} 通过` + (problems.length ? "（有夹具不通过）" : "（全部符合预期）"));
  return problems.length === 0;
}

function parseArgs(argv) {
  const o = { selftest: false, report: false, json: false, asOf: null, dsn: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--selftest") o.selftest = true;
    else if (a === "--report") o.report = true;
    else if (a === "--json") o.json = true;
    else if (a === "--as-of") o.asOf = argv[++i];
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
  const require = createRequire(join(ROOT, "apps/admin-api/package.json"));
  const { Client } = require("pg");
  const client = new Client({ connectionString: dsn });
  try {
    await client.connect();
    const tbl = await client.query("SELECT to_regclass('public.funnel_events') AS t");
    if (!tbl.rows[0]?.t) {
      console.log(NO_TABLE);
      if (opts.json) console.log(JSON.stringify({ status: "SKIP", message: NO_TABLE }));
      return 0;
    }
    const asOf = opts.asOf ?? new Date().toISOString();
    if (!Number.isFinite(Date.parse(asOf))) throw new StructuralError(`非法 as_of: ${asOf}`);
    const res = await client.query(W4_RETENTION_SQL, [asOf]);
    const row = res.rows[0] ?? {};
    const eligible = Number(row.eligible_installs ?? 0);
    const retained = Number(row.retained_installs ?? 0);
    const payload = {
      as_of: new Date(Date.parse(asOf)).toISOString(),
      eligible_installs: eligible,
      retained_installs: retained,
      retention_rate: eligible === 0 ? null : retained / eligible,
      thresholds: { minRetentionRate: 0.4, windowDays: W4_DAYS, usageWindowStartDays: W4_WINDOW_START_DAYS },
      usage_events: USAGE_EVENTS.slice(),
      warnings: [RETENTION_WARNING],
    };
    if (opts.json) console.log(JSON.stringify({ status: "OK", ...payload }, null, 2));
    else {
      console.log(`=== W4 实例留存（只读）===`);
      console.log(`观测截止：${payload.as_of}`);
      console.log(`满 28 天 install：${eligible}；第4周活跃：${retained}`);
      console.log(`W4 留存率：${payload.retention_rate === null ? "N/A（无样本）" : (payload.retention_rate * 100).toFixed(1) + "%"}（目标 ≥40%）`);
      console.log(RETENTION_WARNING);
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
  console.log("用法：node scripts/w4-retention.mjs --selftest | --report [--dsn DSN] [--as-of ISO] [--json]");
  return 0;
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main().then((c) => process.exit(c)).catch((err) => {
    console.error("w4-retention 失败:", err.message);
    process.exit(err instanceof StructuralError ? 2 : 1);
  });
}
