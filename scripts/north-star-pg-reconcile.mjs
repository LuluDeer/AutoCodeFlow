#!/usr/bin/env node
/**
 * north-star-pg-reconcile.mjs — R326 北极星严格/代理周指标「规格→脚本→真数据」对账。
 *
 * 这是验证脚本，不是产品代码。R324 落地了 `north-star-weekly.mjs --report` 的可复算口径，
 * R325 证明了确认事件写点真实落库，但该脚本此前只跑过 SKIP（无连接参数），从未连真库
 * 产出过数据。本脚本在**真 PG（test/e2e 库）** 里造可控种子，调用真脚本 --report，把
 * 返回 JSON 与种子期望逐字段对账，验证周桶 / 时区 / distinct install / dedupe / as_of /
 * 代理过滤语义与脚本口径一致。
 *
 * ## 隔离与清理
 * - 全部种子行带统一前缀 `r326_rec_v1_`（install_id / taskName / tasks.name）；
 * - 在真 `funnel_events` / `task_executions` 表插行（不建临时表、不 DROP 表）；
 * - task_executions.taskId 有 FK→tasks，故额外造 1 条同前缀 task 行（ON DELETE CASCADE）；
 * - finally 里**无条件**按前缀 DELETE 三张表，并复查前缀残留 = 0；只删自己造的行。
 *
 * ## 时区口径
 * 脚本内置 `SET LOCAL TIME ZONE 'UTC'` 只作用于 DB session 的 timestamptz；代理 SQL 的
 * `date_trunc('week', "endTime")` 落在 timestamp WITHOUT time zone 上，其 naive 结果经
 * pg/postgres-date 在 **Node 本地时区** 解析。为复现脚本文档声明的 UTC 口径，本脚本调用
 * 子进程时显式钉 `TZ=UTC`（与 SET LOCAL 同意图），并断言同历周的 strict/proxy week_start
 * 完全一致。`--tz-probe` 可额外观察宿主 ambient TZ 下的周桶漂移（诊断项，不影响退出码）。
 *
 * ## 用法
 *   node scripts/north-star-pg-reconcile.mjs --dsn=<url> | --dsn <url> | DATABASE_URL=<url>
 *   node scripts/north-star-pg-reconcile.mjs --selftest       # 纯函数种子生成器单测，不连库
 *   node scripts/north-star-pg-reconcile.mjs --dsn=<url> --tz-probe
 *   node scripts/north-star-pg-reconcile.mjs --from-env         # 从 .env DB_* 拼测试库 DSN
 * 无 --dsn / DATABASE_URL / --from-env ⇒ 打印 SKIP 并 exit 0（照 R310，不假绿）。
 * 口令只进 Client connectionString / 子进程 argv，redact 后输出，绝不打印口令。
 *
 * ## 退出码
 *   0 全对账通过（含清理残留=0） / 1 对账失败 / 2 结构错误（生产库名 / 前缀冲突 /
 *   脚本返回非 OK 或不可解析） / 3 连不上库。
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPORT_SCRIPT = "scripts/north-star-weekly.mjs";
const require = createRequire(join(ROOT, "apps/admin-api/package.json"));
const PREFIX = "r326_rec_v1_";
const AS_OF = "2026-11-21T12:00:00.000Z";
const AS_OF_SQL = "2026-11-21 12:00:00"; // endTime 是 timestamp without time zone，用裸壁钟串比较
const WEEK_A = "2026-11-16T00:00:00.000Z"; // 2026-11-16 周一所在周
const WEEK_B = "2026-11-09T00:00:00.000Z"; // 2026-11-09 周一所在周

// 与 north-star-weekly.mjs 的 buildPayload.warnings 逐字对齐（该常量未 export，故在此固化哨针）。
export const STRICT_WARNING =
  "严格口径：business_confirmed = 每次执行被显式确认一次；写入端已收口双闸，查询端只统计已落库事件（漏斗表无 synthetic 列）";
export const PROXY_WARNING =
  "⚠️ 有产物/有证据 ≠ 被业务确认，代理值勿当严格值";

/* ── 纯函数：确定性的 fixture 生成器（可被 selftest import）────────────── */

const h32 = (label) =>
  createHash("sha256").update(`${PREFIX}${label}`).digest("hex").slice(0, 32);
const installId = (n) => `${PREFIX}${h32(`install-${n}`)}`;
const dedupeKey = (n) => `confirmed:${h32(`dedupe-${n}`)}`;
const firstKey = (n) => `first-${h32(`first-${n}`)}`;
const uuidFor = (label) => {
  const h = h32(`uuid-${label}`);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
};

/**
 * 种子计划 = 行 + 期望分离：期望是独立字面常量 EXPECTED，不从行动态推导。
 * 这样把某 install 的确认数改动（反证）只会改变实际输出、不会连带改期望 ⇒ 对账转红。
 */
export function buildSeedPlan() {
  const events = [
    // ── 周 A：install-1 两次确认（同 install 不同 execution ⇒ 2 个 dedupe_key）──
    { install: installId(1), event_name: "business_confirmed", ts: "2026-11-17T01:00:00Z", dedupe_key: dedupeKey(1) },
    { install: installId(1), event_name: "business_confirmed", ts: "2026-11-18T02:00:00Z", dedupe_key: dedupeKey(2) },
    // ── 周 A：install-2 一次确认 ⇒ 周 A active_installs=2, confirmed_events=3 ──
    { install: installId(2), event_name: "business_confirmed", ts: "2026-11-19T03:00:00Z", dedupe_key: dedupeKey(3) },
    // ── 周 B：install-3 一次确认 ⇒ 周 B active=1, confirmed=1 ──
    { install: installId(3), event_name: "business_confirmed", ts: "2026-11-10T04:00:00Z", dedupe_key: dedupeKey(4) },
    // ── 干扰行①：event_name 非 business_confirmed + dedupe 前缀非 confirmed: ──
    { install: installId("noise-first"), event_name: "task_first_success", ts: "2026-11-17T05:00:00Z", dedupe_key: firstKey(1) },
    // ── 干扰行②：event_name 对但 dedupe 前缀错（验证 LIKE 'confirmed:%' 物理隔离）──
    { install: installId("noise-prefix"), event_name: "business_confirmed", ts: "2026-11-17T06:00:00Z", dedupe_key: firstKey(2) },
    // ── as_of 之后（仍落周 A）：若 as_of 上界失效，周 A 会变 active=3/confirmed=4 ──
    { install: installId(4), event_name: "business_confirmed", ts: "2026-11-21T18:00:00Z", dedupe_key: dedupeKey(5) },
  ];
  const executions = [
    // 周 A 两条有效：SUCCESS + artifacts 非空 + synthetic=false ⇒ proxy=2
    { name: `${PREFIX}proxy_ok_1`, status: "success", synthetic: false, artifacts: [{ n: "ok1" }], endTime: "2026-11-17 05:00:00" },
    { name: `${PREFIX}proxy_ok_2`, status: "success", synthetic: false, artifacts: [{ n: "ok2" }], endTime: "2026-11-19 06:00:00" },
    // 过滤项：artifacts 空 / synthetic=true / 非 success —— 均须排除
    { name: `${PREFIX}proxy_empty`, status: "success", synthetic: false, artifacts: [], endTime: "2026-11-17 07:00:00" },
    { name: `${PREFIX}proxy_synth`, status: "success", synthetic: true, artifacts: [{ n: "syn" }], endTime: "2026-11-18 08:00:00" },
    { name: `${PREFIX}proxy_failed`, status: "failed", synthetic: false, artifacts: [{ n: "fail" }], endTime: "2026-11-18 09:00:00" },
    // as_of 之后（仍落周 A）：若 as_of 上界失效，周 A proxy 会变 3
    { name: `${PREFIX}proxy_future`, status: "success", synthetic: false, artifacts: [{ n: "future" }], endTime: "2026-11-21 20:00:00" },
  ];
  return {
    events,
    executions,
    task: { id: uuidFor("seed-task"), name: `${PREFIX}seed_task`, triggerType: "manual" },
  };
}

/** 种子期望（独立字面常量；周按 SQL ORDER BY 1 升序：周 B 在前，周 A 在后）。 */
export const EXPECTED = {
  status: "OK",
  as_of: AS_OF,
  strict: [
    { week_start: WEEK_B, active_installs: 1, confirmed_events: 1 },
    { week_start: WEEK_A, active_installs: 2, confirmed_events: 3 },
  ],
  strictTotals: { active_install_weeks: 3, confirmed_events: 4 },
  proxy: [
    { week_start: WEEK_A, executions: 2 },
  ],
  proxyTotals: { executions: 2 },
  warnings: [STRICT_WARNING, PROXY_WARNING],
};

/* ── 参数 / DSN / 库名防误 / redact ───────────────────────────────────── */

function parseArgs(argv) {
  const o = { dsn: null, selftest: false, tzProbe: false, fromEnv: false, help: false, bad: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") o.help = true;
    else if (a === "--selftest") o.selftest = true;
    else if (a === "--tz-probe") o.tzProbe = true;
    else if (a === "--from-env") o.fromEnv = true;
    else if (a === "--dsn" || a.startsWith("--dsn=")) {
      o.dsn = a === "--dsn" ? argv[++i] : a.slice("--dsn=".length);
      if (!o.dsn) o.bad = true;
    } else o.bad = true;
  }
  return o;
}

/** 目标库名必须含 test|e2e（与 e2e spec 的约束同构），挡住 production 库。 */
export function isTestDatabase(name) {
  return /(^|_)(test|e2e)(_|$)/i.test(String(name ?? ""));
}

function readEnvFile() {
  try {
    const raw = readFileSync(join(ROOT, ".env"), "utf8");
    const out = {};
    for (const line of raw.split(/\r?\n/)) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (m) out[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
    }
    return out;
  } catch {
    return {};
  }
}

/** DSN 优先级：--dsn > DATABASE_URL > --from-env 时读 .env DB_*（库名默认 autoflow_ttfv_e2e）。 */
function resolveDsn(opts) {
  if (opts.dsn) return { dsn: opts.dsn, source: "--dsn" };
  if (process.env.DATABASE_URL) return { dsn: process.env.DATABASE_URL, source: "DATABASE_URL" };
  if (!opts.fromEnv) return { dsn: null, source: null };
  const env = readEnvFile();
  const user = process.env.DB_USERNAME || env.DB_USERNAME;
  const password = process.env.DB_PASSWORD || env.DB_PASSWORD;
  const host = process.env.DB_HOST || env.DB_HOST;
  const port = process.env.DB_PORT || env.DB_PORT || "5432";
  if (!user || !host) return { dsn: null, source: null };
  // .env 的 DB_DATABASE=autoflow（生产名）不作为目标；只有显式 test/e2e 覆盖才采纳。
  const candidate = process.env.DB_DATABASE;
  const database = candidate && isTestDatabase(candidate) ? candidate : "autoflow_ttfv_e2e";
  const enc = (s) => encodeURIComponent(String(s ?? ""));
  return {
    dsn: `postgresql://${enc(user)}:${enc(password)}@${host}:${port}/${database}`,
    source: ".env DB_* + autoflow_ttfv_e2e",
  };
}

function dsnDatabase(dsn) {
  try {
    const u = new URL(dsn);
    return decodeURIComponent(u.pathname.replace(/^\//, "") || "");
  } catch {
    return null;
  }
}

function maskDsn(dsn) {
  try {
    const u = new URL(dsn);
    return `${u.hostname}:${u.port || 5432}/${decodeURIComponent(u.pathname.replace(/^\//, ""))} as ${decodeURIComponent(u.username || "")}（口令${u.password ? "已提供" : "缺"}）`;
  } catch {
    return "[DSN 不可解析]";
  }
}

function redact(text, dsn) {
  let s = String(text ?? "");
  if (dsn) s = s.split(dsn).join("[REDACTED_DSN]");
  return s.replace(/\/\/[^:@\s/]+:[^@\s/]+@/g, "//[REDACTED]@");
}

/* ── 断言 / 报告（R310 范式）───────────────────────────────────────────── */

function report(name, ok, detail) {
  console.log(`${ok ? "✔" : "✘"} ${name}${detail ? ` — ${detail}` : ""}`);
  return ok;
}

function makeAsserts() {
  const items = [];
  const applyAssert = (name, ok, detail) => {
    items.push({ name, ok: Boolean(ok), detail });
    report(name, ok, detail);
    return Boolean(ok);
  };
  return { items, applyAssert };
}

/* ── 对账主体（纯比较逻辑，可被 selftest 用 mock applyAssert 驱动）────── */

export function reconcile(payload, applyAssert) {
  const s = payload?.business_confirmed ?? {};
  const p = payload?.business_results_proxy ?? {};
  const weeksOf = (rows) => (Array.isArray(rows) ? rows : []);
  const sw = weeksOf(s.weeks);
  const pw = weeksOf(p.weeks);
  const findStrict = (wk) => sw.find((w) => w.week_start === wk);
  const findProxy = (wk) => pw.find((w) => w.week_start === wk);

  applyAssert("脚本 --report status=OK", payload?.status === EXPECTED.status, `实得 ${payload?.status}`);
  applyAssert("as_of 回显一致", payload?.as_of === EXPECTED.as_of, `实得 ${payload?.as_of}`);

  for (const exp of EXPECTED.strict) {
    const got = findStrict(exp.week_start);
    applyAssert(`严格 ${exp.week_start} 周桶存在`, Boolean(got), got ? "已返回" : "缺失");
    applyAssert(
      `严格 ${exp.week_start} active_installs=${exp.active_installs}`,
      Number(got?.active_installs) === exp.active_installs,
      `期望 ${exp.active_installs}，实得 ${got?.active_installs}`,
    );
    applyAssert(
      `严格 ${exp.week_start} confirmed_events=${exp.confirmed_events}`,
      Number(got?.confirmed_events) === exp.confirmed_events,
      `期望 ${exp.confirmed_events}，实得 ${got?.confirmed_events}`,
    );
  }
  applyAssert("严格周数=2（无多余周/干扰行未泄漏）", sw.length === EXPECTED.strict.length, `实得 ${sw.length} 周`);

  for (const exp of EXPECTED.proxy) {
    const got = findProxy(exp.week_start);
    applyAssert(`代理 ${exp.week_start} 周桶存在`, Boolean(got), got ? "已返回" : "缺失");
    applyAssert(
      `代理 ${exp.week_start} executions=${exp.executions}`,
      Number(got?.executions) === exp.executions,
      `期望 ${exp.executions}，实得 ${got?.executions}`,
    );
  }
  applyAssert("代理周数=1（空 artifacts/synthetic/failed/as_of 之后均被过滤）", pw.length === EXPECTED.proxy.length, `实得 ${pw.length} 周`);

  applyAssert("严格合计 active_install_weeks", Number(s.totals?.active_install_weeks) === EXPECTED.strictTotals.active_install_weeks, `期望 ${EXPECTED.strictTotals.active_install_weeks}，实得 ${s.totals?.active_install_weeks}`);
  applyAssert("严格合计 confirmed_events", Number(s.totals?.confirmed_events) === EXPECTED.strictTotals.confirmed_events, `期望 ${EXPECTED.strictTotals.confirmed_events}，实得 ${s.totals?.confirmed_events}`);
  applyAssert("代理合计 executions", Number(p.totals?.executions) === EXPECTED.proxyTotals.executions, `期望 ${EXPECTED.proxyTotals.executions}，实得 ${p.totals?.executions}`);

  const warnings = Array.isArray(payload?.warnings) ? payload.warnings : [];
  for (const w of EXPECTED.warnings) {
    applyAssert("警告常驻（逐字）", warnings.includes(w), `期望含「${w.slice(0, 18)}…」，实得 ${warnings.length} 条`);
  }

  // 时区语义：受控 TZ=UTC 下，同历周 strict 与 proxy 的 week_start 必须完全一致。
  const strictA = findStrict(WEEK_A);
  const proxyA = findProxy(WEEK_A);
  applyAssert(
    "时区一致：周 A strict/proxy week_start 对齐（TZ=UTC）",
    Boolean(strictA && proxyA && strictA.week_start === proxyA.week_start),
    `strict=${strictA?.week_start} proxy=${proxyA?.week_start}`,
  );
}

/* ── 真库播种 / 子进程调用 / 清理 ─────────────────────────────────────── */

async function loadPg() {
  return require("pg");
}

async function seed(client, plan) {
  await client.query(
    `INSERT INTO tasks (id, name, "triggerType") VALUES ($1, $2, $3)`,
    [plan.task.id, plan.task.name, plan.task.triggerType],
  );
  const evSql = `
    INSERT INTO funnel_events (install_id, event_name, ts, dedupe_key)
    VALUES ($1, $2, $3, $4)`;
  for (const e of plan.events) {
    await client.query(evSql, [e.install, e.event_name, e.ts, e.dedupe_key]);
  }
  const exSql = `
    INSERT INTO task_executions ("taskId", "taskName", status, artifacts, "endTime", synthetic)
    VALUES ($1, $2, $3, $4::jsonb, $5, $6)`;
  for (const x of plan.executions) {
    await client.query(exSql, [
      plan.task.id, x.name, x.status, JSON.stringify(x.artifacts), x.endTime, x.synthetic,
    ]);
  }
}

async function prefixResidual(client) {
  const like = `${PREFIX}%`;
  // pg 单 Client 不支持并发 query（deprecated），这里严格串行。
  const ev = await client.query(`SELECT count(*)::int AS n FROM funnel_events WHERE install_id LIKE $1`, [like]);
  const ex = await client.query(`SELECT count(*)::int AS n FROM task_executions WHERE "taskName" LIKE $1`, [like]);
  const tk = await client.query(`SELECT count(*)::int AS n FROM tasks WHERE name LIKE $1`, [like]);
  return {
    funnel: Number(ev.rows[0]?.n ?? -1),
    exec: Number(ex.rows[0]?.n ?? -1),
    task: Number(tk.rows[0]?.n ?? -1),
  };
}

async function cleanup(client, applyAssert) {
  const like = `${PREFIX}%`;
  await client.query(`DELETE FROM task_executions WHERE "taskName" LIKE $1`, [like]);
  await client.query(`DELETE FROM funnel_events WHERE install_id LIKE $1`, [like]);
  await client.query(`DELETE FROM tasks WHERE name LIKE $1`, [like]);
  const left = await prefixResidual(client);
  applyAssert("清理复查 funnel_events 前缀残留=0", left.funnel === 0, `残留 ${left.funnel}`);
  applyAssert("清理复查 task_executions 前缀残留=0", left.exec === 0, `残留 ${left.exec}`);
  applyAssert("清理复查 tasks 前缀残留=0", left.task === 0, `残留 ${left.task}`);
  return left;
}

function runReport(dsn, { tz = "UTC" } = {}) {
  const stdout = execFileSync(
    process.execPath,
    [join(ROOT, REPORT_SCRIPT), "--report", "--json", `--dsn=${dsn}`, `--as-of=${AS_OF}`],
    { cwd: ROOT, env: { ...process.env, TZ: tz }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  return JSON.parse(stdout.trim());
}

/* ── selftest：纯函数种子生成器单测（不连库）─────────────────────────── */

export function runSelftest() {
  const { items, applyAssert } = makeAsserts();
  const plan = buildSeedPlan();
  const strictEvents = plan.events.filter((e) => e.event_name === "business_confirmed" && e.dedupe_key.startsWith("confirmed:"));
  const inWindow = strictEvents.filter((e) => e.ts <= AS_OF);
  const validProxy = plan.executions.filter(
    (x) => x.status === "success" && x.synthetic === false && Array.isArray(x.artifacts) && x.artifacts.length > 0 && x.endTime <= AS_OF_SQL,
  );

  applyAssert("install_id 形状：<前缀><32hex>", plan.events.every((e) => new RegExp(`^${PREFIX}[0-9a-f]{32}$`).test(e.install)), `n=${plan.events.length}`);
  applyAssert("confirmed dedupe_key 形状：confirmed:<32hex>", strictEvents.every((e) => /^confirmed:[0-9a-f]{32}$/.test(e.dedupe_key)), `n=${strictEvents.length}`);
  applyAssert("干扰行 dedupe 非 confirmed: 前缀", strictEvents.length < plan.events.length && plan.events.some((e) => /^first-[0-9a-f]{32}$/.test(e.dedupe_key)), `总行=${plan.events.length}`);
  applyAssert("in-window 严格行=4（周 A 三 + 周 B 一；as_of 后一不在内）", inWindow.length === 4, `实得 ${inWindow.length}`);
  applyAssert("周 A 同 install 多确认：install-1 有 2 个不同 dedupe", new Set(strictEvents.filter((e) => e.install === installId(1)).map((e) => e.dedupe_key)).size === 2, "ok");
  applyAssert("有效代理行=2", validProxy.length === 2, `实得 ${validProxy.length}`);
  applyAssert("期望常量独立：周 A active=2/confirmed=3", EXPECTED.strict[1].active_installs === 2 && EXPECTED.strict[1].confirmed_events === 3, "ok");

  // 对账器正例：用 EXPECTED 造 payload ⇒ 全绿
  const goodPayload = {
    status: "OK", as_of: AS_OF,
    business_confirmed: { weeks: EXPECTED.strict, totals: EXPECTED.strictTotals },
    business_results_proxy: { weeks: EXPECTED.proxy, totals: EXPECTED.proxyTotals },
    warnings: EXPECTED.warnings,
  };
  const r = makeAsserts();
  reconcile(goodPayload, r.applyAssert);
  applyAssert("对账器正例全绿", r.items.every((a) => a.ok), `${r.items.filter((a) => a.ok).length}/${r.items.length}`);

  const bad = items.filter((x) => !x.ok);
  console.log(`\nSELFTEST ${items.length - bad.length}/${items.length}` + (bad.length ? "（有失败）" : "（全部通过）"));
  return bad.length ? 1 : 0;
}

const HELP = `用法：
  node scripts/north-star-pg-reconcile.mjs --dsn=<url> | --dsn <url> | DATABASE_URL=<url>
  node scripts/north-star-pg-reconcile.mjs --selftest
  node scripts/north-star-pg-reconcile.mjs --from-env        # 从 .env DB_* 拼测试库 DSN
  node scripts/north-star-pg-reconcile.mjs --dsn=<url> --tz-probe
目标库名须含 test|e2e，否则 exit 2（防误生产）。无连接参数 ⇒ SKIP exit 0。
退出码：0 全对账通过 / 1 对账失败 / 2 结构错误 / 3 连不上库；无 DSN ⇒ SKIP exit 0。`;

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) { console.log(HELP); return 0; }
  if (opts.bad) { console.log(HELP); return 2; }
  if (opts.selftest) return runSelftest();

  const { dsn, source } = resolveDsn(opts);
  if (!dsn) {
    console.log("SKIP: 无 --dsn / DATABASE_URL / --from-env，未连库（exit 0，不假绿）");
    return 0;
  }
  console.log(`DSN 来源：${source}；数据源：${maskDsn(dsn)}（口令不落日志）`);

  const dbName = dsnDatabase(dsn);
  if (!dbName || !isTestDatabase(dbName)) {
    return report("库名防误：目标库须含 test|e2e", false, `目标库=${dbName ?? "不可解析"}`) ? 0 : 2;
  }
  report("库名防误：目标库含 test|e2e", true, `目标库=${dbName}`);

  const { items, applyAssert } = makeAsserts();
  let structural = 0;
  let connectFailed = false;
  const { Client } = await loadPg();
  const client = new Client({ connectionString: dsn, connectionTimeoutMillis: 8000 });
  let connected = false;
  let seeded = false; // 只有真正开始播种才清理，避免前缀冲突时误删他人行
  try {
    await client.connect();
    connected = true;

    // 前缀冲突预检：已有同前缀行 ⇒ 结构红，绝不覆盖/误删他人数据。
    const pre = await prefixResidual(client);
    if (pre.funnel || pre.exec || pre.task) {
      structural = 2;
      report("前缀冲突预检=0", false, `funnel=${pre.funnel} exec=${pre.exec} task=${pre.task}`);
    } else {
      report("前缀冲突预检=0", true, "三表均无 r326_ 残留");
    }

    if (!structural) {
      const plan = buildSeedPlan();
      seeded = true;
      await seed(client, plan);
      report("种子写入", true, `funnel=${plan.events.length} exec=${plan.executions.length} task=1（前缀 ${PREFIX}）`);

      let payload;
      try {
        const raw = runReport(dsn, { tz: "UTC" });
        payload = raw;
        console.log("--- north-star-weekly.mjs --report 返回（JSON）---");
        console.log(JSON.stringify(raw, null, 2));
        if (raw?.status !== "OK") {
          structural = 2;
          report("脚本返回 status=OK", false, `实得 ${raw?.status}`);
        }
      } catch (e) {
        structural = 2;
        report("调用 --report / 解析 JSON", false, redact(e?.message ?? e, dsn));
      }
      if (!structural) reconcile(payload, applyAssert);

      if (opts.tzProbe) {
        try {
          const ambient = runReport(dsn, { tz: process.env.TZ || "Asia/Shanghai" });
          const aStrict = ambient?.business_confirmed?.weeks?.find((w) => w.week_start === WEEK_A);
          const aProxy = ambient?.business_results_proxy?.weeks?.find((w) => w.week_start?.startsWith("2026-11-15") || w.week_start === WEEK_A);
          console.log(`ℹ 时区诊断（ambient TZ=${process.env.TZ || "Asia/Shanghai"}）：周 A strict=${aStrict?.week_start}，proxy=${aProxy?.week_start}（若不等，说明 naive endTime 经 pg 在本地时区解析漂移；非门控项）`);
        } catch (e) {
          console.log(`ℹ 时区诊断跳过：${redact(e?.message ?? e, dsn)}`);
        }
      }
    }
  } catch (e) {
    if (String(e?.message ?? "").includes("connect") || String(e?.code ?? "").startsWith("28")) {
      connectFailed = true;
      report("连接测试库", false, redact(e?.message ?? e, dsn));
    } else {
      structural = 2;
      report("真库执行异常", false, redact(e?.message ?? e, dsn));
    }
  } finally {
    if (connected) {
      if (seeded) {
        try {
          await cleanup(client, applyAssert);
        } catch (e) {
          structural = structural || 2;
          report("清理失败", false, redact(e?.message ?? e, dsn));
        }
      } else {
        console.log("— 清理确认：未播种（前缀冲突/连接前失败），不触碰任何行");
      }
      await client.end().catch(() => {});
    } else {
      console.log("— 清理确认：未建立连接，无种子可清理");
    }
  }

  const assertFailed = items.some((x) => !x.ok);
  const code = connectFailed ? 3 : structural ? 2 : assertFailed ? 1 : 0;
  console.log(
    `\n${code === 0 ? "✔" : "✘"} R326 真库对账：${code === 0 ? "逐字段全通过，清理复查 0" : `失败（exit ${code}）`}`,
  );
  return code;
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
