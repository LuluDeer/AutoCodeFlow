#!/usr/bin/env node
/**
 * ttfv-proxy-report.mjs — TTFV 方案「阶段1代理口径」的只读指标脚本（R291）。
 *
 * 单一事实源：AUTHORITATIVE_SQL 逐字摘自 docs/plan/ttfv-funnel-instrumentation.md
 * §4.3 第一条 SQL（权威口径）。--selftest 的漂移哨针会把它与文档 SQL 比对，
 * 关键 token 缺失或归一化后不一致 ⇒ exit 2（结构红，绝不静默跳过）。
 *
 * CLI：
 *   node scripts/ttfv-proxy-report.mjs --report [--dsn DSN] [--window-days N | --since ISO] [--json]
 *   node scripts/ttfv-proxy-report.mjs --selftest
 *
 * 输出字段：ttfv_proxy_minutes（中位数分钟）、sample_size（样本量）。
 * 口径警告（必带）：⚠️ 非产品口径：TTFV_proxy，无 install_id / opt-in 维度，仅验证计算链路
 * sample_size < 5 追加：样本量小，中位数无统计意义
 *
 * 退出码：
 *   0 = 跑完（含样本不足时如实报告，不伪造结论）
 *   1 = --selftest 夹具失败
 *   2 = 结构错误（抽不到文档 SQL / 列事实，或漂移哨针红）
 *   3 = 连不上库
 *   4 = 连上但无可算样本（sample_size = 0）
 *
 * 连接参数优先级：--dsn > DATABASE_URL > DB_HOST/DB_PORT/DB_USERNAME/DB_PASSWORD/DB_DATABASE。
 * pg 从 apps/admin-api 经 createRequire 加载（仓库根未直接依赖 pg）。
 * 漂移反证可用 TTFV_DOC_PATH 指向文档副本，不改真实文档。
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DOC_PATH = process.env.TTFV_DOC_PATH
  ? resolve(process.env.TTFV_DOC_PATH)
  : join(ROOT, "docs/plan/ttfv-funnel-instrumentation.md");

/* ── 权威 SQL（逐字来自文档 §4.3，行 159-177）────────────────────── */
export const AUTHORITATIVE_SQL = `WITH first_success AS (
  SELECT e."taskId", MIN(e."endTime") AS first_success_at
  FROM task_executions e
  WHERE e."status" = 'success'
    AND e."synthetic" = false
    AND e."endTime" IS NOT NULL
    AND e."endTime" >= e."createdAt"
  GROUP BY e."taskId"
)
SELECT
  PERCENTILE_CONT(0.5) WITHIN GROUP (
    ORDER BY EXTRACT(EPOCH FROM (fs.first_success_at - t."createdAt")) / 60.0
  ) AS ttfv_proxy_minutes,
  COUNT(*) AS sample_size
FROM first_success fs
JOIN tasks t ON t."id" = fs."taskId"
WHERE t."createdAt" >= :window_start;`;

const CALIBER_WARNING =
  "⚠️ 非产品口径：TTFV_proxy，无 install_id / opt-in 维度，仅验证计算链路";
const SMALL_SAMPLE_WARNING = "样本量小，中位数无统计意义";

class StructuralError extends Error {}

/* ── 漂移哨针 ───────────────────────────────────────────────────── */

function normalizeSql(s) {
  return s.replace(/\r\n?/g, "\n").replace(/\s+/g, " ").trim().replace(/;$/, "").trim();
}

/** 抽文档里第一个 ```sql 代码块（§4.3 权威 SQL）。 */
function extractDocSql(src) {
  const m = src.match(/```sql\s*\n([\s\S]*?)```/);
  if (!m) throw new StructuralError("文档里找不到第一个 ```sql 代码块");
  return m[1].trim();
}

/**
 * 漂移哨针：从文档抽 SQL 关键 token，与脚本内置 SQL 比对；缺一即红。
 * 同时要求两者归一化后逐字一致——文档口径与脚本内置 SQL 不得各自漂移。
 */
export function checkDrift() {
  let docSrc;
  try {
    docSrc = readFileSync(DOC_PATH, "utf8");
  } catch (err) {
    throw new StructuralError(`读不到文档（${DOC_PATH}）：${err.message}`);
  }
  const docNorm = normalizeSql(extractDocSql(docSrc));
  const builtNorm = normalizeSql(AUTHORITATIVE_SQL);

  // 与文档口径绑定的关键 token（含任务书点名的四个：PERCENTILE_CONT / synthetic=false /
  // task_executions / JOIN tasks）。任一缺失都是结构红，不是跳过。
  const tokens = [
    "PERCENTILE_CONT(0.5)",
    "task_executions",
    'synthetic" = false',
    'MIN(e."endTime")',
    'endTime" >= e."createdAt"',
    "JOIN tasks t ON",
    "EXTRACT(EPOCH FROM",
    "/ 60.0",
    ":window_start",
  ];
  const missingDoc = tokens.filter((t) => !docNorm.includes(t));
  const missingBuilt = tokens.filter((t) => !builtNorm.includes(t));
  const problems = [];
  if (missingDoc.length) problems.push(`文档 SQL 缺关键 token：${missingDoc.join(" | ")}`);
  if (missingBuilt.length) problems.push(`脚本内置 SQL 缺关键 token：${missingBuilt.join(" | ")}`);
  if (docNorm !== builtNorm) problems.push("文档 §4.3 SQL 与脚本内置 SQL 归一化后不一致（口径漂移）");
  if (problems.length) throw new StructuralError(problems.join("\n"));
  return { tokens };
}

/* ── selftest：纯 JS 复刻 SQL 聚合语义（不连库）───────────────────── */

const ms = (iso) => Date.parse(iso);
const MIN = 60_000;

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
 * 复刻权威 SQL 的聚合语义：
 *  first_success = 每个 taskId 取满足 status='success' AND synthetic=false
 *    AND endTime IS NOT NULL AND endTime>=createdAt 的最小 endTime；
 *  JOIN tasks（仅保留有匹配 task 行者）且 task.createdAt >= windowStart；
 *  中位数 = PERCENTILE_CONT(0.5) of (first_success_at - task.createdAt)/60s。
 */
export function computeProxy(executions, tasks, windowStartIso) {
  const ws = ms(windowStartIso);
  const first = new Map();
  for (const e of executions) {
    if (e.status !== "success") continue;
    if (e.synthetic !== false) continue;
    if (e.endTime == null) continue;
    if (ms(e.endTime) < ms(e.createdAt)) continue;
    const prev = first.get(e.taskId);
    const cur = ms(e.endTime);
    if (prev == null || cur < prev) first.set(e.taskId, cur);
  }
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const minutes = [];
  for (const [taskId, firstAt] of first) {
    const t = byId.get(taskId);
    if (!t) continue; // JOIN tasks
    if (ms(t.createdAt) < ws) continue; // window 过滤
    minutes.push((firstAt - ms(t.createdAt)) / MIN);
  }
  return { ttfv_proxy_minutes: percentileCont50(minutes), sample_size: minutes.length };
}

const T0 = "2026-11-01T00:00:00Z";
const WIN_ALL = "2026-10-01T00:00:00Z";
const at = (iso, min) => new Date(ms(iso) + min * MIN).toISOString();
const exec = (taskId, endTimeMin, opt = {}) => ({
  taskId,
  status: opt.status ?? "success",
  synthetic: opt.synthetic ?? false,
  createdAt: T0,
  endTime: endTimeMin == null ? null : at(T0, endTimeMin),
});
const task = (id, createdAt = T0) => ({ id, createdAt });

/** fixtures：覆盖 synth 排除、endTime<createdAt 排除、重复取首个、window 外排除、空样本等。 */
export const FIXTURES = [
  {
    name: "排除 synthetic=true 与非 success（仅留真实首成功）",
    executions: [
      exec("t1", 2, { synthetic: true }), // 排除
      exec("t1", 5), // 保留 → 5min
      exec("t1", 1, { status: "failed" }), // 排除
    ],
    tasks: [task("t1")],
    windowStart: WIN_ALL,
    expected: { ttfv_proxy_minutes: 5, sample_size: 1 },
  },
  {
    name: "endTime < createdAt 被排除",
    executions: [exec("t2", -3), exec("t2", 10)],
    tasks: [task("t2")],
    windowStart: WIN_ALL,
    expected: { ttfv_proxy_minutes: 10, sample_size: 1 },
  },
  {
    name: "重复执行取首个成功（MIN endTime）",
    executions: [exec("t3", 8), exec("t3", 3)],
    tasks: [task("t3")],
    windowStart: WIN_ALL,
    expected: { ttfv_proxy_minutes: 3, sample_size: 1 },
  },
  {
    name: "window 外的 task 被排除",
    executions: [
      exec("t4a", 4),
      // t4b 的执行属于 window 内的 task（task 建于 11-15，晚于窗口起点 11-10）
      {
        taskId: "t4b", status: "success", synthetic: false,
        createdAt: "2026-11-15T00:00:00Z",
        endTime: "2026-11-15T00:06:00Z", // 6min → 保留
      },
    ],
    tasks: [task("t4a", T0), task("t4b", "2026-11-15T00:00:00Z")],
    windowStart: "2026-11-10T00:00:00Z",
    expected: { ttfv_proxy_minutes: 6, sample_size: 1 },
  },
  {
    name: "无成功执行 ⇒ 空样本",
    executions: [exec("t5", 5, { status: "failed" })],
    tasks: [task("t5")],
    windowStart: WIN_ALL,
    expected: { ttfv_proxy_minutes: null, sample_size: 0 },
  },
  {
    name: "偶数样本 PERCENTILE_CONT 线性插值 + JOIN 排除无主执行",
    executions: [
      exec("t6a", 2), exec("t6b", 4), exec("t6c", 6), exec("t6d", 8),
      exec("ghost", 1), // tasks 里没有 → JOIN 排除
    ],
    tasks: [task("t6a"), task("t6b"), task("t6c"), task("t6d")],
    windowStart: WIN_ALL,
    expected: { ttfv_proxy_minutes: 5, sample_size: 4 }, // (4+6)/2 = 5
  },
  {
    name: "endTime IS NULL 被排除",
    executions: [exec("t7", null)],
    tasks: [task("t7")],
    windowStart: WIN_ALL,
    expected: { ttfv_proxy_minutes: null, sample_size: 0 },
  },
];

export function runFixtures() {
  const problems = [];
  for (const f of FIXTURES) {
    const got = computeProxy(f.executions, f.tasks, f.windowStart);
    const ok =
      got.sample_size === f.expected.sample_size &&
      got.ttfv_proxy_minutes === f.expected.ttfv_proxy_minutes;
    console.log(`  ${ok ? "✓" : "✘"} ${f.name}`);
    if (!ok) {
      problems.push(
        `    ${f.name}：期望 ${JSON.stringify(f.expected)}，实得 ${JSON.stringify(got)}`,
      );
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

function emitResult(opts, { ttfv, sampleSize, windowStart, target }) {
  const warnings = [CALIBER_WARNING];
  if (sampleSize < 5) warnings.push(SMALL_SAMPLE_WARNING);
  if (opts.json) {
    console.log(
      JSON.stringify(
        {
          ttfv_proxy_minutes: ttfv,
          sample_size: sampleSize,
          window_start: windowStart.toISOString(),
          warnings,
        },
        null,
        2,
      ),
    );
    return;
  }
  console.log("=== TTFV_proxy 代理指标（只读）===");
  console.log(`窗口起点：${windowStart.toISOString()}（${opts.since ? "--since" : `--window-days ${opts.windowDays}`}）`);
  console.log(`数据源：${maskTarget(target)}`);
  console.log(CALIBER_WARNING);
  console.log(`ttfv_proxy_minutes = ${ttfv}`);
  console.log(`sample_size = ${sampleSize}`);
  if (sampleSize < 5) console.log(SMALL_SAMPLE_WARNING);
}

async function runReport(opts) {
  const target = resolveDbTarget(process.env, opts.dsn);
  const windowStart = opts.since
    ? new Date(opts.since)
    : new Date(Date.now() - opts.windowDays * 24 * 60 * 60 * 1000);

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
    // 把命名占位符换成 pg 的位置参数；SQL 主体保持权威口径逐字不变。
    const runnable = AUTHORITATIVE_SQL.replace(":window_start", "$1").trim().replace(/;$/, "");
    const row = (await client.query(runnable, [windowStart.toISOString()])).rows[0] ?? {};
    const sampleSize = Number(row.sample_size ?? 0);
    const ttfv = row.ttfv_proxy_minutes == null ? null : Number(row.ttfv_proxy_minutes);
    emitResult(opts, { ttfv, sampleSize, windowStart, target });
    if (sampleSize === 0) {
      console.error("结论：窗口内无可算样本 ⇒ 退出码 4（未伪造结论）。");
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
    dsn: null, windowDays: 30, since: null, bad: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") o.help = true;
    else if (a === "--selftest") o.selftest = true;
    else if (a === "--report") o.report = true;
    else if (a === "--json") o.json = true;
    else if (a === "--dsn") { o.dsn = argv[++i]; if (o.dsn == null) o.bad = true; }
    else if (a === "--window-days") {
      const n = Number(argv[++i]);
      if (!Number.isFinite(n) || n < 0) o.bad = true;
      else o.windowDays = n;
    } else if (a === "--since") {
      o.since = argv[++i];
      if (!o.since || Number.isNaN(Date.parse(o.since))) o.bad = true;
    } else o.bad = true;
  }
  return o;
}

const HELP = `用法：
  node scripts/ttfv-proxy-report.mjs --selftest
  node scripts/ttfv-proxy-report.mjs --report [--dsn DSN] [--window-days N | --since ISO] [--json]
说明：
  --window-days N  默认 30；:window_start = now() - N days
  --since ISO      直接给窗口起点（与 --window-days 同时给时以 --since 为准）
  --dsn            连接串；否则 DATABASE_URL > DB_HOST/DB_PORT/DB_USERNAME/DB_PASSWORD/DB_DATABASE
  --json           机器可读输出（含 warnings 字段）
  --help / -h      显示本帮助
  TTFV_DOC_PATH    漂移哨针用的文档副本路径（默认 docs/plan/ttfv-funnel-instrumentation.md）
退出码：0 跑完（含样本不足如实报告） / 1 selftest 夹具失败 /
        2 结构错误（抽不到 SQL 或漂移哨针红） / 3 连不上库 / 4 连上但无可算样本`;

export async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) { console.log(HELP); return 0; }
  if (opts.bad || (!opts.selftest && !opts.report)) {
    console.log(HELP);
    return opts.bad ? 2 : 0;
  }
  if (opts.selftest || opts.report) {
    try {
      const { tokens } = checkDrift();
      if (opts.selftest) console.log(`漂移哨针：文档 SQL 关键 token ${tokens.length}/${tokens.length} 命中，内置 SQL 与文档一致 ✓`);
    } catch (err) {
      console.error(`✘ 结构错误（漂移哨针）：${err.message}`);
      return 2;
    }
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
