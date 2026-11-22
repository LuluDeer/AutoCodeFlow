#!/usr/bin/env node
/**
 * ttfv-real-metrics.mjs — TTFV「真实口径」只读指标脚本（R313 / 切片 A）。
 *
 * 数据源：funnel_events + telemetry_optin（migration 0101/0102）。真实共享库
 * 尚未跑过这两个 migration 时，--report 走 information_schema 检测 ⇒ SKIP + exit 0，
 * 不把「缺表」伪装成「指标为 0」。
 *
 * 权威 SQL 说明（重要，避免哨针自相矛盾）：
 *  - AUTHORITATIVE_SQL 的**基础口径**来自 docs/plan/ttfv-funnel-instrumentation.md
 *    §4.3「阶段2——真实 TTFV 中位数」SQL（TTFV 中位数 + converted_installs）；
 *  - 任务书要求的增强（"增强"不是逐字摘自文档）：严格 opt-in 不追溯
 *    (i.ts >= o.opted_at AND s.ts >= o.opted_at)、满 24h 分母 (i.ts <= :as_of - 24h)、
 *    24h 激活率、sample_size。checkDrift() 只把文档 SQL 的 token 当基础口径哨针，
 *    另有一组 ENHANCEMENT_TOKENS 守增强口径，二者分开比对。
 *
 * 口径诚实性（R318 近似已消除）：方案 §1.2 的 24h 激活率分子是
 * 「task_created 或首次触发执行」。阶段2 未接 task_created（浏览器侧无
 * executor 指纹，方案 §7.2/§7.5）；执行类激活数据源自 R318 起改为
 * task_first_attempted（首次触发执行，覆盖 COMPLETED(success) + FAILED
 * (failed/timeout) + KILLED(管理员 kill 独立事件) 三终态、写入时排除 synthetic），不再用
 * task_first_success 代理，触发后失败者也计入激活。
 * TTFV 中位数仍以 task_first_success 为转化口径（文档 §4.3，未变）。
 *
 * CLI：
 *   node scripts/ttfv-real-metrics.mjs --selftest
 *   node scripts/ttfv-real-metrics.mjs --report [--dsn DSN] [--as-of ISO] [--json]
 *
 * 输出字段：ttfv_minutes / activation_24h / sample_size
 *   （附带 converted_installs / eligible_installs / activated_installs / warnings）
 *
 * 退出码：0 跑完（含缺表 SKIP、样本不足如实报告） / 1 selftest 夹具失败 /
 *         2 结构错误（漂移哨针红 / SQL 列不匹配 / DSN 非法） / 3 连不上库 /
 *         4 连上但无可算样本（sample_size = 0）
 * 连接参数优先级：--dsn > DATABASE_URL > DB_HOST/DB_PORT/DB_USERNAME/DB_PASSWORD/DB_DATABASE。
 * pg 经 createRequire(join(ROOT,"apps/admin-api/package.json")) 加载；任何输出不打印口令。
 * TTFV_DOC_PATH 可覆盖漂移哨针用的文档副本路径（只用于反证，不改真实文档）。
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DOC_PATH = process.env.TTFV_DOC_PATH
  ? resolve(process.env.TTFV_DOC_PATH)
  : join(ROOT, "docs/plan/ttfv-funnel-instrumentation.md");

const SKIP_MESSAGE =
  "SKIP: funnel_events/telemetry_optin 表不存在（需先跑 migration 0101/0102）";
const NO_TARGET_MESSAGE =
  "SKIP: 未配置连接参数（--dsn / DATABASE_URL / DB_*），未尝试连库（exit 0）";

const OPTIN_CALIBER_WARNING =
  "⚠️ 真实口径仅覆盖 opt-in install：授权前事件不追溯（i.ts/o.opted_at），样本稀疏不代表全量用户";
const SMALL_SAMPLE_WARNING = "样本量小，中位数无统计意义";

class StructuralError extends Error {}

/* ── 权威 SQL（基础口径来自文档 §4.3 阶段2；增强项见文件头说明）──────── */
export const AUTHORITATIVE_SQL = `WITH installs AS (
  SELECT i."install_id" AS "install_id", MIN(i."ts") AS "ts"
  FROM telemetry_optin o
  JOIN funnel_events i
    ON i."install_id" = o."install_id" AND i."event_name" = 'install_completed'
  WHERE o."opt_in" = true
    AND i."ts" >= o."opted_at"
  GROUP BY i."install_id"
),
first_success AS (
  SELECT s."install_id" AS "install_id", MIN(s."ts") AS "ts"
  FROM telemetry_optin o
  JOIN funnel_events s
    ON s."install_id" = o."install_id" AND s."event_name" = 'task_first_success'
  JOIN installs i ON i."install_id" = s."install_id"
  WHERE o."opt_in" = true
    AND s."ts" >= o."opted_at"
    AND s."ts" > i."ts"
    AND EXTRACT(EPOCH FROM (s."ts" - i."ts")) <= 86400
  GROUP BY s."install_id"
),
first_attempt AS (
  -- R318：首次触发执行（成功+失败+killed 三终态、排除 synthetic），供 24h 激活率分子。
  SELECT s."install_id" AS "install_id", MIN(s."ts") AS "ts"
  FROM telemetry_optin o
  JOIN funnel_events s
    ON s."install_id" = o."install_id" AND s."event_name" = 'task_first_attempted'
  JOIN installs i ON i."install_id" = s."install_id"
  WHERE o."opt_in" = true
    AND s."ts" >= o."opted_at"
    AND s."ts" > i."ts"
    AND EXTRACT(EPOCH FROM (s."ts" - i."ts")) <= 86400
  GROUP BY s."install_id"
),
ttfv AS (
  SELECT
    PERCENTILE_CONT(0.5) WITHIN GROUP (
      ORDER BY EXTRACT(EPOCH FROM (s."ts" - i."ts")) / 60.0
    ) AS "ttfv_minutes",
    COUNT(*) AS "converted_installs"
  FROM installs i
  JOIN first_success s ON s."install_id" = i."install_id"
),
eligible AS (
  SELECT i."install_id" AS "install_id", i."ts" AS "ts"
  FROM installs i
  WHERE i."ts" <= :as_of - INTERVAL '24 hours'
),
activated AS (
  -- 精确口径（R318）：task_first_attempted = 首次触发执行，覆盖成功与失败
  -- 终态、写入时排除 synthetic；触发即失败者计入激活，近似已消除。
  SELECT COUNT(DISTINCT e."install_id") AS "activated_installs"
  FROM eligible e
  JOIN first_attempt s ON s."install_id" = e."install_id"
  WHERE EXTRACT(EPOCH FROM (s."ts" - e."ts")) <= 86400
)
SELECT
  t."ttfv_minutes" AS "ttfv_minutes",
  t."converted_installs" AS "converted_installs",
  (SELECT COUNT(*) FROM eligible) AS "eligible_installs",
  a."activated_installs" AS "activated_installs",
  a."activated_installs"::numeric / NULLIF((SELECT COUNT(*) FROM eligible), 0) AS "activation_24h",
  (t."converted_installs" + (SELECT COUNT(*) FROM eligible)) AS "sample_size"
FROM ttfv t
CROSS JOIN activated a;`;

/** 任务书增强口径的 token（不属于文档 §4.3 原文，单独哨针）。 */
const ENHANCEMENT_TOKENS = [
  'o."opted_at"',
  'i."ts" >= o."opted_at"',
  's."ts" >= o."opted_at"',
  ":as_of - INTERVAL '24 hours'",
  'task_first_attempted',
  'activation_24h',
  'eligible_installs',
  'activated_installs',
  'sample_size',
];

/* ── 漂移哨针 ─────────────────────────────────────────────────────── */

function normalizeSql(s) {
  return s.replace(/\r\n?/g, "\n").replace(/\s+/g, " ").trim().replace(/;$/, "").trim();
}

/** 抽文档 §4.3 的「阶段2——真实 TTFV 中位数」SQL 代码块（第二个 ```sql）。 */
function extractDocSql(src) {
  const blocks = [...src.matchAll(/```sql\s*\n([\s\S]*?)```/g)].map((m) => m[1].trim());
  if (blocks.length < 2) {
    throw new StructuralError("文档里找不到 §4.3 阶段2（第二个 ```sql）代码块");
  }
  return blocks[1];
}

/** 从文档 SQL 抽关键 token；抽不到即结构红（不静默降级）。 */
function extractDocTokens(docSql) {
  const patterns = [
    /PERCENTILE_CONT\(0\.5\)/,
    /FROM\s+telemetry_optin\s+o/,
    /JOIN\s+funnel_events\s+i/,
    /JOIN\s+funnel_events\s+s/,
    /o\."opt_in"\s*=\s*true/,
    /s\."ts"\s*>\s*i\."ts"/,
    /EXTRACT\(EPOCH FROM \(s\."ts" - i\."ts"\)\)\s*\/\s*60\.0/,
    /86400/,
    /'install_completed'/,
    /'task_first_success'/,
  ];
  const tokens = [];
  for (const re of patterns) {
    const m = docSql.match(re);
    if (!m) throw new StructuralError(`文档 §4.3 阶段2 SQL 缺关键 token：${re}`);
    tokens.push(normalizeSql(m[0]));
  }
  return tokens;
}

/**
 * 哨针：文档 §4.3 阶段2 SQL 的基础 token 必须在内置 SQL 中逐字命中；
 * 任务书增强 token 另做一组检查。二者任一缺失 ⇒ exit 2，绝不静默放过。
 */
export function checkDrift() {
  let docSrc;
  try {
    docSrc = readFileSync(DOC_PATH, "utf8");
  } catch (err) {
    throw new StructuralError(`读不到文档（${DOC_PATH}）：${err.message}`);
  }
  const docSql = extractDocSql(docSrc);
  const docTokens = extractDocTokens(docSql);
  const builtNorm = normalizeSql(AUTHORITATIVE_SQL);
  const problems = [];
  const missingBuilt = docTokens.filter((t) => !builtNorm.includes(t));
  if (missingBuilt.length) {
    problems.push(`内置 SQL 缺文档 §4.3 基础 token：${missingBuilt.join(" | ")}`);
  }
  const missingEnhancement = ENHANCEMENT_TOKENS.filter((t) => !builtNorm.includes(normalizeSql(t)));
  if (missingEnhancement.length) {
    problems.push(`内置 SQL 缺增强口径 token：${missingEnhancement.join(" | ")}`);
  }
  if (problems.length) throw new StructuralError(problems.join("\n"));
  return { docTokens, enhancementTokens: ENHANCEMENT_TOKENS };
}

/* ── 纯函数（selftest 与真库结果对账；不 import R291，写域限制）──────── */

const ms = (iso) => Date.parse(iso);
const MIN = 60_000;
const DAY = 86_400_000;

/** PERCENTILE_CONT(0.5)：连续中位数，偶数样本线性插值（与 PG 一致）。 */
export function percentileCont50(values) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const n = s.length;
  if (n === 1) return s[0];
  const pos = (n - 1) * 0.5;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return lo === hi ? s[lo] : s[lo] + (s[hi] - s[lo]) * (pos - lo);
}

/**
 * 内存版复刻 AUTHORITATIVE_SQL 语义：
 *  installs: [{ install_id, opt_in, opted_at }]（telemetry_optin）
 *  events:   [{ install_id, event_name, ts }]（funnel_events）
 *  nowIso:   观测截止（对应 SQL 的 :as_of）
 *
 * 严格 opt-in：只取 opt_in === true；install_completed / task_first_success /
 * task_first_attempted 均须 >= opted_at（授权前行为不追溯）。每 install 取
 * 最早 install_completed、最早合规 task_first_success（TTFV 转化口径）与
 * 最早合规 task_first_attempted（24h 激活分子，等价 SQL 的 MIN(ts)）。
 * TTFV 只算首成功在安装后 (0, 86400] 秒内的 install；激活分母只算满 24h 的。
 *
 * R318：激活分子改读 task_first_attempted（成功+失败+killed 三终态、排除 synthetic），
 * 不再用 task_first_success 代理；触发后失败者计入激活，近似已消除。
 */
export function computeMetrics(installs, events, nowIso) {
  const asOf = ms(nowIso);
  if (!Number.isFinite(asOf)) throw new StructuralError(`nowIso 非法：${nowIso}`);

  const optedAt = new Map();
  for (const row of installs) {
    if (row?.opt_in !== true) continue;
    const t = ms(row.opted_at);
    if (!Number.isFinite(t)) continue;
    const prev = optedAt.get(row.install_id);
    if (prev == null || t < prev) optedAt.set(row.install_id, t);
  }

  const installAt = new Map();
  const successAt = new Map();
  const attemptAt = new Map();
  for (const e of events) {
    const granted = optedAt.get(e?.install_id);
    if (granted == null) continue;
    const t = ms(e?.ts);
    if (!Number.isFinite(t) || t < granted) continue; // 授权前事件不追溯
    if (e.event_name === "install_completed") {
      const prev = installAt.get(e.install_id);
      if (prev == null || t < prev) installAt.set(e.install_id, t);
    }
  }
  for (const e of events) {
    const granted = optedAt.get(e?.install_id);
    const installed = installAt.get(e?.install_id);
    if (granted == null || installed == null) continue;
    const isSuccess = e.event_name === "task_first_success";
    const isAttempt = e.event_name === "task_first_attempted";
    if (!isSuccess && !isAttempt) continue;
    const t = ms(e.ts);
    if (!Number.isFinite(t) || t < granted) continue;
    if (t <= installed || t - installed > DAY) continue;
    const target = isSuccess ? successAt : attemptAt;
    const prev = target.get(e.install_id);
    if (prev == null || t < prev) target.set(e.install_id, t);
  }

  const minutes = [];
  for (const [id, t] of successAt) minutes.push((t - installAt.get(id)) / MIN);
  const convertedInstalls = minutes.length;

  const cutoff = asOf - DAY;
  let eligibleInstalls = 0;
  let activatedInstalls = 0;
  for (const [id, installed] of installAt) {
    if (installed > cutoff) continue; // reaches24h
    eligibleInstalls += 1;
    const attempt = attemptAt.get(id);
    if (attempt != null && attempt - installed <= DAY) activatedInstalls += 1;
  }

  return {
    ttfv_minutes: percentileCont50(minutes),
    converted_installs: convertedInstalls,
    eligible_installs: eligibleInstalls,
    activated_installs: activatedInstalls,
    activation_24h: eligibleInstalls === 0 ? null : activatedInstalls / eligibleInstalls,
    sample_size: convertedInstalls + eligibleInstalls,
  };
}

/** 口径警告：R318 近似已消除；opt-in 样本须知常驻；小样本按 sample_size 追加。 */
export function buildWarnings(sampleSize) {
  const warnings = [OPTIN_CALIBER_WARNING];
  if (sampleSize < 5) warnings.push(SMALL_SAMPLE_WARNING);
  return warnings;
}

/* ── selftest：内存夹具（不连库）───────────────────────────────────── */

const T0 = Date.parse("2026-11-20T00:00:00Z");
const iso = (offsetMs) => new Date(offsetMs).toISOString();
const inst = (id, optIn = true, optedAtMs = T0 - 60_000) => ({
  install_id: id,
  opt_in: optIn,
  opted_at: iso(optedAtMs),
});
const ev = (id, eventName, offsetMs) => ({
  install_id: id,
  event_name: eventName,
  ts: iso(T0 + offsetMs),
});

/** 覆盖中位数、激活率（含失败终态也算激活）、opt-in、授权前事件、24h 分母、超窗、插值和口径警告。 */
export const FIXTURES = [
  {
    name: "TTFV 中位数 5/10/15 → 10 分钟",
    installs: [inst("a"), inst("b"), inst("c")],
    events: [
      ev("a", "install_completed", 0), ev("a", "task_first_attempted", 5 * MIN),
      ev("a", "task_first_success", 5 * MIN),
      ev("b", "install_completed", 0), ev("b", "task_first_attempted", 10 * MIN),
      ev("b", "task_first_success", 10 * MIN),
      ev("c", "install_completed", 0), ev("c", "task_first_attempted", 15 * MIN),
      ev("c", "task_first_success", 15 * MIN),
    ],
    now: iso(T0 + 60 * MIN),
    expected: { ttfv_minutes: 10, converted_installs: 3, eligible_installs: 0,
      activated_installs: 0, activation_24h: null, sample_size: 3 },
  },
  {
    name: "24h 激活率：3 install 中 2 个 24h 内首次触发执行 → 66.7%",
    installs: [inst("a"), inst("b"), inst("c")],
    events: [
      ev("a", "install_completed", 0), ev("a", "task_first_attempted", 10 * MIN),
      ev("a", "task_first_success", 10 * MIN),
      ev("b", "install_completed", 0), ev("b", "task_first_attempted", 30 * MIN),
      ev("b", "task_first_success", 30 * MIN),
      ev("c", "install_completed", 0), // 触发/成功均未发生
    ],
    now: iso(T0 + 48 * 60 * MIN),
    expected: { ttfv_minutes: 20, converted_installs: 2, eligible_installs: 3,
      activated_installs: 2, activation_24h: 2 / 3, sample_size: 5 },
  },
  {
    name: "R318 近似消除：触发后失败（只有 task_first_attempted）也算激活",
    installs: [inst("failed"), inst("never")],
    events: [
      ev("failed", "install_completed", 0),
      ev("failed", "task_first_attempted", 12 * MIN), // FAILED 终态写入，无 success
      ev("never", "install_completed", 0),
    ],
    now: iso(T0 + 48 * 60 * MIN),
    expected: { ttfv_minutes: null, converted_installs: 0, eligible_installs: 2,
      activated_installs: 1, activation_24h: 0.5, sample_size: 2 },
  },
  {
    name: "opt_in=false 的 install 全部排除",
    installs: [inst("off", false), inst("on")],
    events: [
      ev("off", "install_completed", 0), ev("off", "task_first_attempted", MIN),
      ev("off", "task_first_success", MIN),
      ev("on", "install_completed", 0), ev("on", "task_first_attempted", 20 * MIN),
      ev("on", "task_first_success", 20 * MIN),
    ],
    now: iso(T0 + 60 * MIN),
    expected: { ttfv_minutes: 20, converted_installs: 1, eligible_installs: 0,
      activated_installs: 0, activation_24h: null, sample_size: 1 },
  },
  {
    name: "授权前 install_completed / 两类执行事件均不计（不追溯）",
    installs: [inst("early", true, T0 + 30 * MIN), inst("late", true, T0)],
    events: [
      ev("early", "install_completed", 0), // 早于授权 ⇒ install 排除
      ev("early", "task_first_attempted", 10 * MIN),
      ev("early", "task_first_success", 10 * MIN),
      ev("late", "install_completed", 5 * MIN),
      ev("late", "task_first_attempted", 10 * MIN),
      ev("late", "task_first_success", 10 * MIN), // opted_at=T0 时不早 ⇒ 保留
    ],
    now: iso(T0 + 60 * MIN),
    expected: { ttfv_minutes: 5, converted_installs: 1, eligible_installs: 0,
      activated_installs: 0, activation_24h: null, sample_size: 1 },
  },
  {
    name: "满 24h 分母口径：未满 24h 的 install 不进激活分母",
    installs: [inst("old"), inst("fresh")],
    events: [
      ev("old", "install_completed", 20 * 60 * MIN),
      ev("old", "task_first_attempted", 20 * 60 * MIN + 10 * MIN),
      ev("old", "task_first_success", 20 * 60 * MIN + 10 * MIN),
      ev("fresh", "install_completed", 47 * 60 * MIN),
      ev("fresh", "task_first_attempted", 47 * 60 * MIN + 5 * MIN),
      ev("fresh", "task_first_success", 47 * 60 * MIN + 5 * MIN),
    ],
    now: iso(T0 + 48 * 60 * MIN),
    expected: { ttfv_minutes: 7.5, converted_installs: 2, eligible_installs: 1,
      activated_installs: 1, activation_24h: 1, sample_size: 3 },
  },
  {
    name: "首成功/首次触发超过安装后 24h：不进 TTFV，也不算 24h 激活",
    installs: [inst("slow")],
    events: [
      ev("slow", "install_completed", 0),
      ev("slow", "task_first_attempted", 25 * 60 * MIN),
      ev("slow", "task_first_success", 25 * 60 * MIN),
    ],
    now: iso(T0 + 72 * 60 * MIN),
    expected: { ttfv_minutes: null, converted_installs: 0, eligible_installs: 1,
      activated_installs: 0, activation_24h: 0, sample_size: 1 },
  },
  {
    name: "偶数样本 PERCENTILE_CONT 插值 + 重复事件取最早",
    installs: [inst("a"), inst("b"), inst("c"), inst("d")],
    events: [
      ev("a", "install_completed", 5 * MIN), ev("a", "install_completed", 0),
      ev("a", "task_first_attempted", 8 * MIN), ev("a", "task_first_attempted", 2 * MIN),
      ev("a", "task_first_success", 8 * MIN), ev("a", "task_first_success", 2 * MIN),
      ev("b", "install_completed", 0), ev("b", "task_first_attempted", 4 * MIN),
      ev("b", "task_first_success", 4 * MIN),
      ev("c", "install_completed", 0), ev("c", "task_first_attempted", 6 * MIN),
      ev("c", "task_first_success", 6 * MIN),
      ev("d", "install_completed", 0), ev("d", "task_first_attempted", 8 * MIN),
      ev("d", "task_first_success", 8 * MIN),
    ],
    now: iso(T0 + 60 * MIN),
    expected: { ttfv_minutes: 5, converted_installs: 4, eligible_installs: 0,
      activated_installs: 0, activation_24h: null, sample_size: 4 },
  },
  {
    name: "口径警告：无近似标注；opt-in 样本 + 小样本均如实输出",
    assertionOnly: true,
  },
];

function near(a, b) {
  if (a == null || b == null) return a === b;
  return typeof a === "number" && typeof b === "number"
    ? Math.abs(a - b) < 1e-9
    : a === b;
}

export function runFixtures() {
  const problems = [];
  for (const f of FIXTURES) {
    if (f.assertionOnly) {
      const warnings = buildWarnings(3);
      const noApprox = !warnings.some(
        (w) => w.includes("近似") || w.includes("低估"),
      );
      const ok = noApprox
        && warnings.includes(OPTIN_CALIBER_WARNING)
        && warnings.includes(SMALL_SAMPLE_WARNING);
      console.log(`  ${ok ? "✓" : "✘"} ${f.name}`);
      if (!ok) problems.push(`    ${f.name}：警告应仅含 opt-in/小样本且无近似标注`);
      continue;
    }
    const got = computeMetrics(f.installs, f.events, f.now);
    const keys = Object.keys(f.expected);
    const ok = keys.every((k) => near(got[k], f.expected[k]));
    console.log(`  ${ok ? "✓" : "✘"} ${f.name}`);
    if (!ok) {
      problems.push(`    ${f.name}：期望 ${JSON.stringify(f.expected)}，实得 ${JSON.stringify(got)}`);
    }
  }
  const n = FIXTURES.length;
  const ok = problems.length === 0;
  console.log(`\nSELFTEST ${n - problems.length}/${n} 通过（夹具数 ${n}）` + (ok ? "（全部符合预期）" : "（有夹具不通过）"));
  if (!ok) for (const p of problems) console.log(p);
  return ok ? 0 : 1;
}

/* ── --report（真实 PG，只读）────────────────────────────────────── */

function fromDsn(dsn) {
  let url;
  try {
    url = new URL(dsn);
  } catch {
    throw new StructuralError(
      `--dsn/DATABASE_URL 不是合法 URL：${String(dsn).replace(/:[^:@/]+@/, ":***@")}`,
    );
  }
  return {
    host: url.hostname,
    port: Number(url.port || 5432),
    user: decodeURIComponent(url.username || "postgres"),
    password: decodeURIComponent(url.password || ""),
    database: decodeURIComponent(url.pathname.replace(/^\//, "") || "postgres"),
    source: "--dsn/DATABASE_URL",
  };
}

function hasExplicitTarget(env, dsn) {
  return Boolean(dsn || env.DATABASE_URL || env.DB_HOST || env.DB_DATABASE
    || env.DB_USERNAME || env.DB_PASSWORD || env.DB_PORT);
}

function resolveDbTarget(env = process.env, dsn = null) {
  if (dsn) return fromDsn(dsn);
  if (env.DATABASE_URL) return fromDsn(env.DATABASE_URL);
  return {
    host: env.DB_HOST || "localhost",
    port: Number(env.DB_PORT || 5432),
    user: env.DB_USERNAME || "postgres",
    password: env.DB_PASSWORD || "",
    database: env.DB_DATABASE || "autocodeflow",
    source: "DB_*",
  };
}

const maskTarget = (t) =>
  `${t.host}:${t.port}/${t.database} as ${t.user}（口令${t.password ? "已提供" : "缺"}，来源 ${t.source}）`;

async function loadPg() {
  const require = createRequire(join(ROOT, "apps/admin-api/package.json"));
  return require("pg");
}

async function tablesPresent(client) {
  const res = await client.query(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = ANY(current_schemas(false))
       AND table_name IN ('funnel_events', 'telemetry_optin')`,
  );
  const found = new Set(res.rows.map((r) => r.table_name));
  return {
    funnelEvents: found.has("funnel_events"),
    telemetryOptin: found.has("telemetry_optin"),
  };
}

const toNumberOrNull = (v) => (v == null ? null : Number(v));

function emitSkip(opts, missing) {
  console.log(SKIP_MESSAGE);
  if (opts.json) {
    console.log(JSON.stringify({ status: "SKIP", message: SKIP_MESSAGE, missing_tables: missing }, null, 2));
  }
}

function emitResult(opts, row, asOf, target) {
  const sampleSize = row.sample_size;
  const warnings = buildWarnings(sampleSize);
  const payload = {
    status: "OK",
    ttfv_minutes: row.ttfv_minutes,
    activation_24h: row.activation_24h,
    sample_size: sampleSize,
    converted_installs: row.converted_installs,
    eligible_installs: row.eligible_installs,
    activated_installs: row.activated_installs,
    as_of: asOf,
    warnings,
  };
  if (opts.json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }
  console.log("=== TTFV 真实口径指标（只读）===");
  console.log(`观测截止：${asOf}${opts.asOf ? "（--as-of）" : "（now）"}`);
  console.log(`数据源：${maskTarget(target)}`);
  for (const w of warnings) console.log(w);
  console.log(`ttfv_minutes = ${row.ttfv_minutes}`);
  console.log(`activation_24h = ${row.activation_24h}`);
  console.log(`sample_size = ${sampleSize}`);
  console.log(`converted_installs = ${row.converted_installs}`);
  console.log(`eligible_installs = ${row.eligible_installs}`);
  console.log(`activated_installs = ${row.activated_installs}`);
}

async function runReport(opts) {
  if (!hasExplicitTarget(process.env, opts.dsn)) {
    console.log(NO_TARGET_MESSAGE);
    if (opts.json) {
      console.log(JSON.stringify({ status: "SKIP", message: NO_TARGET_MESSAGE }, null, 2));
    }
    return 0;
  }
  const target = resolveDbTarget(process.env, opts.dsn);
  const asOf = opts.asOf ?? new Date().toISOString();
  if (!Number.isFinite(Date.parse(asOf))) {
    throw new StructuralError(`--as-of 不是合法时间：${asOf}`);
  }

  let pg;
  try {
    pg = await loadPg();
  } catch (err) {
    console.error(`✘ 加载 pg 失败：${err.message}（应在 apps/admin-api/node_modules 里）`);
    return 3;
  }
  const client = new pg.Client({
    host: target.host,
    port: target.port,
    user: target.user,
    password: target.password,
    database: target.database,
    connectionTimeoutMillis: 8000,
  });
  try {
    await client.connect();
  } catch (err) {
    console.error(`✘ 连不上库：${maskTarget(target)} — ${err.message}`);
    return 3;
  }
  try {
    const present = await tablesPresent(client);
    if (!present.funnelEvents || !present.telemetryOptin) {
      const missing = [
        !present.funnelEvents ? "funnel_events" : null,
        !present.telemetryOptin ? "telemetry_optin" : null,
      ].filter(Boolean);
      emitSkip(opts, missing);
      return 0;
    }
    // 命名占位符换位置参数；SQL 主体（权威口径 + 增强口径）逐字不变。
    const runnable = AUTHORITATIVE_SQL.replace(":as_of", "$1").trim().replace(/;$/, "");
    const raw = (await client.query(runnable, [asOf])).rows[0] ?? {};
    const row = {
      ttfv_minutes: toNumberOrNull(raw.ttfv_minutes),
      converted_installs: Number(raw.converted_installs ?? 0),
      eligible_installs: Number(raw.eligible_installs ?? 0),
      activated_installs: Number(raw.activated_installs ?? 0),
      activation_24h: toNumberOrNull(raw.activation_24h),
      sample_size: Number(raw.sample_size ?? 0),
    };
    emitResult(opts, row, asOf, target);
    if (row.sample_size === 0) {
      console.error("结论：无可算样本 ⇒ 退出码 4（未伪造结论）。");
      return 4;
    }
    return 0;
  } catch (err) {
    console.error(`✘ 结构错误（SQL/表列不匹配）：${err.message}`);
    return 2;
  } finally {
    await client.end().catch(() => {});
  }
}

/* ── CLI ─────────────────────────────────────────────────────────── */

function parseArgs(argv) {
  const o = {
    selftest: false, report: false, json: false, help: false,
    dsn: null, asOf: null, bad: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") o.help = true;
    else if (a === "--selftest") o.selftest = true;
    else if (a === "--report") o.report = true;
    else if (a === "--json") o.json = true;
    else if (a === "--dsn" || a.startsWith("--dsn=")) {
      o.dsn = a === "--dsn" ? argv[++i] : a.slice("--dsn=".length);
      if (o.dsn == null || o.dsn === "") o.bad = true;
    } else if (a === "--as-of" || a.startsWith("--as-of=")) {
      o.asOf = a === "--as-of" ? argv[++i] : a.slice("--as-of=".length);
      if (!o.asOf || !Number.isFinite(Date.parse(o.asOf))) o.bad = true;
    } else o.bad = true;
  }
  return o;
}

const HELP = `用法：
  node scripts/ttfv-real-metrics.mjs --selftest
  node scripts/ttfv-real-metrics.mjs --report [--dsn DSN | --dsn=DSN] [--as-of ISO] [--json]
说明：
  --dsn            连接串；否则 DATABASE_URL > DB_HOST/DB_PORT/DB_USERNAME/DB_PASSWORD/DB_DATABASE
                    无连接参数 ⇒ 打印 SKIP 并 exit 0（不尝试连库）
  --as-of          观测截止 ISO（默认 now）；满 24h 分母按 as_of - 24h 判定
  --json           机器可读输出（含 status / warnings）；SKIP 也会输出
  --help / -h      显示本帮助
  TTFV_DOC_PATH    漂移哨针用的文档副本路径（默认 docs/plan/ttfv-funnel-instrumentation.md）
口径：TTFV 中位数 = install_completed → task_first_success（≤24h）的 PERCENTILE_CONT(0.5)；
      24h 激活率分子 = task_first_attempted（首次触发执行，成功+失败终态、
      排除 synthetic；R318 起不再用首成功代理，无近似低估）；
      sample_size = converted_installs + eligible_installs。
退出码：0 跑完（含缺表 SKIP / 无连接参数 SKIP） / 1 selftest 夹具失败 /
        2 结构错误（漂移哨针红等） / 3 连不上库 / 4 连上但无可算样本`;

export async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) { console.log(HELP); return 0; }
  if (opts.bad || (!opts.selftest && !opts.report)) {
    console.log(HELP);
    return opts.bad ? 2 : 0;
  }
  try {
    const { docTokens, enhancementTokens } = checkDrift();
    if (opts.selftest) {
      console.log(`漂移哨针：文档 §4.3 基础 token ${docTokens.length}/${docTokens.length} 命中；增强 token ${enhancementTokens.length}/${enhancementTokens.length} 命中 ✓`);
    }
  } catch (err) {
    console.error(`✘ 结构错误（漂移哨针）：${err.message}`);
    return 2;
  }
  if (opts.selftest) {
    const code = runFixtures();
    if (code !== 0 || !opts.report) return code;
  }
  if (opts.report) return runReport(opts);
  return 0;
}

const invokedDirectly =
  process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(`✘ 未预期异常：${err?.stack ?? err}`);
      process.exit(2);
    });
}
