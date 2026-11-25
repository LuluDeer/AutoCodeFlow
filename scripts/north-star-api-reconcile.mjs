#!/usr/bin/env node
/**
 * north-star-api-reconcile.mjs — R327 北极星后端 GET 端点「API 输出 vs CLI 权威脚本」真库对账。
 *
 * 核心命题：同一份真 PG 数据、同一个 as_of 下，新增 NorthStarMetricsService 的
 * report() 输出必须与 scripts/north-star-weekly.mjs --report --json 的权威 payload
 * 逐字段一致（as_of / business_confirmed.weeks+totals /
 * business_results_proxy.weeks+totals / promotionEligibility 共有子集
 * (eligible,reasons,weeks,activeInstallWeeks,thresholds) / warnings），否则对账红。
 * API 额外产 promotionEligibility.reasonDetails（CLI 不产，text 与 reasons 同值），
 * 因此不把整个 promotionEligibility 对象逐字比对，避免假红。
 *
 * 取数路径：
 *  ① 权威 CLI：execFileSync(node scripts/north-star-weekly.mjs --report --json
 *     --dsn=<e2e> --as-of=<fixed>)，TZ=UTC，禁止假绿（status != OK ⇒ 结构红）。
 *  ② 被测 API：load compiled NorthStarMetricsService from apps/admin-api/dist,
 *     inject real TypeORM DataSource to the e2e DB, call report(asOf)。
 *     这是真库 + 真 service 进程内调用，不走内存替身；HTTP/Nest 传输层不在本脚本覆盖内，
 *     报告里注明为「真库 service 直调」级别。
 *
 * 隔离与清理：完全仿 R326 north-star-pg-reconcile.mjs：
 *  - 前缀 r327_api_rec_v1_；真 funnel_events / task_executions 插行；
 *  - task_executions.taskId FK→tasks，另造 1 条同前缀 task；
 *  - 前缀冲突预检 ⇒ 结构红，绝不覆盖/误删他人行；
 *  - finally 无条件按前缀 DELETE 三表并复查残留 = 0。
 *  - DSN 走 --dsn > DATABASE_URL > --from-env(.env DB_* + autoflow_ttfv_e2e)；
 *    库名必须含 test|e2e；口令只进连接配置/子进程 argv，所有日志 redact。
 *
 * 反假绿：payload 除了与 CLI 逐字段比较，还与独立字面常量 EXPECTED 对账；
 * 真库 --counterproof 在 API payload 副本上同时注入周 A confirmed_events+1 与
 * promotionEligibility.eligible 取反；selftest 另做 eligible / thresholds.minWeeks /
 * reasons[0] 三条 promotion 子字段反证；全部必须被 compareFields 抓红，
 * 且原 payload sha256 前后不变。
 *
 * 用法：
 *   node scripts/north-star-api-reconcile.mjs --from-env
 *   node scripts/north-star-api-reconcile.mjs --dsn=<url>
 *   node scripts/north-star-api-reconcile.mjs --selftest
 *   node scripts/north-star-api-reconcile.mjs --counterproof  # 真库双注入（+1 与 eligible 取反），对账必须 exit 1
 *   node scripts/north-star-api-reconcile.mjs --service=<dist 相对路径>（覆盖编译产物探测）
 * 无连接参数 ⇒ SKIP exit 0（不假绿）。
 * 退出码：0 全一致（含清理 0 残留） / 1 对账失败 / 2 结构错 / 3 连不上。
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPORT_SCRIPT = "scripts/north-star-weekly.mjs";
const require = createRequire(join(ROOT, "apps/admin-api/package.json"));
const PREFIX = "r327_api_rec_v1_";
const AS_OF = "2026-11-21T12:00:00.000Z";
const AS_OF_SQL = "2026-11-21 12:00:00";
const WEEK_A = "2026-11-16T00:00:00.000Z";
const WEEK_B = "2026-11-09T00:00:00.000Z";

const SERVICE_CANDIDATES = [
  "apps/admin-api/dist/modules/agent/runtime/north-star-metrics.service.js",
  "apps/admin-api/dist/src/modules/agent/runtime/north-star-metrics.service.js",
];

const STRICT_WARNING =
  "严格口径：business_confirmed = 每次执行被显式确认一次；写入端已收口双闸，查询端只统计已落库事件（漏斗表无 synthetic 列）";
const PROXY_WARNING =
  "⚠️ 有产物/有证据 ≠ 被业务确认，代理值勿当严格值";

class StructuralError extends Error {}
class ConnectError extends Error {}

/* ── 确定性种子计划：期望独立字面常量，不从种子动态推导 ───────────────── */

const h32 = (label) =>
  createHash("sha256").update(`${PREFIX}${label}`).digest("hex").slice(0, 32);
const installId = (n) => `${PREFIX}${h32(`install-${n}`)}`;
const dedupeKey = (n) => `confirmed:${h32(`dedupe-${n}`)}`;
const firstKey = (n) => `first-${h32(`first-${n}`)}`;
const uuidFor = (label) => {
  const h = h32(`uuid-${label}`);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
};

export function buildSeedPlan() {
  const events = [
    // 周 A：install-1 两条不同 dedupe 的确认 ⇒ 同 install 仍算 1 活跃、2 事件
    { install: installId(1), event_name: "business_confirmed", ts: "2026-11-17T01:00:00Z", dedupe_key: dedupeKey(1) },
    { install: installId(1), event_name: "business_confirmed", ts: "2026-11-18T02:00:00Z", dedupe_key: dedupeKey(2) },
    // 周 A：install-2 一条确认 ⇒ 周 A active=2 / confirmed=3
    { install: installId(2), event_name: "business_confirmed", ts: "2026-11-19T03:00:00Z", dedupe_key: dedupeKey(3) },
    // 周 B：install-3 一条确认 ⇒ 周 B active=1 / confirmed=1
    { install: installId(3), event_name: "business_confirmed", ts: "2026-11-10T04:00:00Z", dedupe_key: dedupeKey(4) },
    // 干扰：event_name 非 business_confirmed 且 dedupe 前缀非 confirmed:
    { install: installId("noise-first"), event_name: "task_first_success", ts: "2026-11-17T05:00:00Z", dedupe_key: firstKey(1) },
    // 干扰：event_name 对但 dedupe 前缀错（验证 LIKE 'confirmed:%' 隔离）
    { install: installId("noise-prefix"), event_name: "business_confirmed", ts: "2026-11-17T06:00:00Z", dedupe_key: firstKey(2) },
    // as_of 之后（仍落周 A）：as_of 上界失效会让周 A 变 active=3 / confirmed=4
    { install: installId(4), event_name: "business_confirmed", ts: "2026-11-21T18:00:00Z", dedupe_key: dedupeKey(5) },
  ];
  const executions = [
    // 周 A 两条有效：success + artifacts 非空 + synthetic=false
    { name: `${PREFIX}proxy_ok_1`, status: "success", synthetic: false, artifacts: [{ n: "ok1" }], endTime: "2026-11-17 05:00:00" },
    { name: `${PREFIX}proxy_ok_2`, status: "success", synthetic: false, artifacts: [{ n: "ok2" }], endTime: "2026-11-19 06:00:00" },
    // 过滤三件套：空 artifacts / synthetic=true / 非 success
    { name: `${PREFIX}proxy_empty`, status: "success", synthetic: false, artifacts: [], endTime: "2026-11-17 07:00:00" },
    { name: `${PREFIX}proxy_synth`, status: "success", synthetic: true, artifacts: [{ n: "syn" }], endTime: "2026-11-18 08:00:00" },
    { name: `${PREFIX}proxy_failed`, status: "failed", synthetic: false, artifacts: [{ n: "fail" }], endTime: "2026-11-18 09:00:00" },
    // as_of 之后：上界失效会让周 A proxy 变 3
    { name: `${PREFIX}proxy_future`, status: "success", synthetic: false, artifacts: [{ n: "future" }], endTime: "2026-11-21 20:00:00" },
  ];
  return {
    events,
    executions,
    task: { id: uuidFor("seed-task"), name: `${PREFIX}seed_task`, triggerType: "manual" },
  };
}

export const EXPECTED = {
  as_of: AS_OF,
  strict: [
    { week_start: WEEK_B, active_installs: 1, confirmed_events: 1 },
    { week_start: WEEK_A, active_installs: 2, confirmed_events: 3 },
  ],
  strictTotals: { active_install_weeks: 3, confirmed_events: 4 },
  proxy: [{ week_start: WEEK_A, executions: 2 }],
  proxyTotals: { executions: 2 },
  // 独立字面量：本脚本 seed 只有周 A(active=2) + 周 B(active=1) ⇒ weeks=2 / activeInstallWeeks=3；
  // 两个数值阈值 both unmet，故 eligible=false 且有两条阈值 reasons + 一条运营前置。
  // 不从 CLI/API 输入拷贝，也不采其它样例的 3 周/21 数值。
  promotionEligibility: {
    eligible: false,
    reasons: [
      "样本期 2 周 < 4 周",
      "活跃 install 周合计 3 < 20",
      "运营前置（脚本不验证）：telemetry/status 的 coverage 须为 full 且 count>0",
    ],
    weeks: 2,
    activeInstallWeeks: 3,
    thresholds: { minWeeks: 4, minActiveInstallWeeks: 20 },
  },
  warnings: [STRICT_WARNING, PROXY_WARNING],
};

/* ── 参数 / DSN / 防误 / redact ───────────────────────────────────────── */

function parseArgs(argv) {
  const o = { dsn: null, fromEnv: false, selftest: false, counterproof: false, help: false, bad: false, service: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") o.help = true;
    else if (a === "--from-env") o.fromEnv = true;
    else if (a === "--selftest") o.selftest = true;
    else if (a === "--counterproof") o.counterproof = true;
    else if (a === "--dsn" || a.startsWith("--dsn=")) {
      o.dsn = a === "--dsn" ? argv[++i] : a.slice("--dsn=".length);
      if (!o.dsn) o.bad = true;
    } else if (a.startsWith("--service=")) {
      o.service = a.slice("--service=".length);
      if (!o.service) o.bad = true;
    } else o.bad = true;
  }
  return o;
}

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
    return decodeURIComponent(new URL(dsn).pathname.replace(/^\//, "")) || "";
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

/* ── 断言 / 报告 ──────────────────────────────────────────────────────── */

function makeAsserts(verbose = true) {
  const items = [];
  const applyAssert = (name, ok, detail) => {
    const entry = { name, ok: Boolean(ok), detail };
    items.push(entry);
    if (verbose) console.log(`${entry.ok ? "✔" : "✘"} ${name}${detail ? ` — ${detail}` : ""}`);
    return entry.ok;
  };
  return { items, applyAssert };
}

/* ── 逐字段比较（A/B + 独立 EXPECTED 双重门控） ───────────────────────── */

const FIELD_PATHS = [
  "as_of",
  "business_confirmed.weeks",
  "business_confirmed.totals",
  "business_results_proxy.weeks",
  "business_results_proxy.totals",
  // promotionEligibility 只比 CLI/API 共有的 5 个子字段；
  // API 额外产 reasonDetails（reasonDetails[].text === reasons），CLI 不产，
  // 整对象逐字比对必然假红，故不加入 promotionEligibility.reasonDetails。
  "promotionEligibility.eligible",
  "promotionEligibility.reasons",
  "promotionEligibility.weeks",
  "promotionEligibility.activeInstallWeeks",
  "promotionEligibility.thresholds",
  "warnings",
];

function getPath(obj, path) {
  return path.split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

const show = (v) => (v === undefined ? "<undefined>" : JSON.stringify(v));

export function compareFields(cliPayload, apiPayload, applyAssert) {
  for (const path of FIELD_PATHS) {
    const a = getPath(cliPayload, path);
    const b = getPath(apiPayload, path);
    applyAssert(
      `[A/B] ${path} 逐字段一致`,
      show(a) === show(b),
      `CLI=${show(a)} API=${show(b)}`,
    );
  }
}

export function compareWithExpected(payload, applyAssert, label) {
  applyAssert(`[${label}] as_of=EXPECTED`, getPath(payload, "as_of") === EXPECTED.as_of, `实得 ${show(getPath(payload, "as_of"))}`);
  for (const field of ["business_confirmed.weeks", "business_results_proxy.weeks"]) {
    const want = field.includes("business_confirmed") ? EXPECTED.strict : EXPECTED.proxy;
    applyAssert(`[${label}] ${field}=EXPECTED`, show(getPath(payload, field)) === show(want), `实得 ${show(getPath(payload, field))}`);
  }
  applyAssert(`[${label}] business_confirmed.totals=EXPECTED`, show(getPath(payload, "business_confirmed.totals")) === show(EXPECTED.strictTotals), `实得 ${show(getPath(payload, "business_confirmed.totals"))}`);
  applyAssert(`[${label}] business_results_proxy.totals=EXPECTED`, show(getPath(payload, "business_results_proxy.totals")) === show(EXPECTED.proxyTotals), `实得 ${show(getPath(payload, "business_results_proxy.totals"))}`);
  for (const sub of ["eligible", "reasons", "weeks", "activeInstallWeeks", "thresholds"]) {
    const path = `promotionEligibility.${sub}`;
    const got = getPath(payload, path);
    applyAssert(`[${label}] ${path}=EXPECTED`, show(got) === show(getPath(EXPECTED.promotionEligibility, sub)), `实得 ${show(got)}`);
  }
  applyAssert(`[${label}] warnings 常驻逐字=EXPECTED`, show(getPath(payload, "warnings")) === show(EXPECTED.warnings), `实得 ${show(getPath(payload, "warnings"))}`);
}

/** 反证：克隆 API payload 篡改周 A confirmed_events+1，比较器必须转红；原对象 sha 不变。 */
export function runCounterproof(cliPayload, apiPayload, applyAssert) {
  const before = createHash("sha256").update(show(apiPayload)).digest("hex");
  const bad = JSON.parse(JSON.stringify(apiPayload));
  const week = bad?.business_confirmed?.weeks?.find((w) => w.week_start === WEEK_A)
    ?? bad?.business_confirmed?.weeks?.[0];
  if (!week || typeof week.confirmed_events !== "number") {
    applyAssert("反证可构造（API weeks[].confirmed_events 为 number）", false, show(bad?.business_confirmed?.weeks));
    return;
  }
  week.confirmed_events += 1;
  const probe = makeAsserts(false);
  compareFields(cliPayload, bad, probe.applyAssert);
  const red = probe.items.some((x) => !x.ok);
  const after = createHash("sha256").update(show(apiPayload)).digest("hex");
  applyAssert("反证：confirmed_events+1 ⇒ 对账转红", red, `红项 ${probe.items.filter((x) => !x.ok).length}/${probe.items.length}`);
  applyAssert("反证：原 API payload sha256 前后不变", before === after, `${before.slice(0, 12)}… → ${after.slice(0, 12)}…`);
}

/* ── 真库播种 / 两条取数路径 / 清理 ───────────────────────────────────── */

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

function runCliReport(dsn) {
  let stdout;
  try {
    stdout = execFileSync(
      process.execPath,
      [join(ROOT, REPORT_SCRIPT), "--report", "--json", `--dsn=${dsn}`, `--as-of=${AS_OF}`],
      { cwd: ROOT, env: { ...process.env, TZ: "UTC" }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
  } catch (e) {
    if (e?.status === 3) throw new ConnectError("权威 CLI --report 连库失败（exit 3）");
    throw new StructuralError(`调用权威 CLI --report 失败：${redact(e?.message ?? e, dsn)}`);
  }
  let raw;
  try {
    raw = JSON.parse(stdout.trim());
  } catch (e) {
    throw new StructuralError(`权威 CLI --report JSON 不可解析：${redact(e?.message ?? e, dsn)}`);
  }
  if (raw?.status !== "OK") {
    throw new StructuralError(`权威 CLI --report status=${raw?.status ?? "<undefined>"}（非 OK 不参与对账）`);
  }
  return raw;
}

function findServiceModule(override) {
  const candidates = override ? [override] : SERVICE_CANDIDATES;
  const found = candidates.find((rel) => existsSync(join(ROOT, rel)));
  if (!found) {
    throw new StructuralError(
      `找不到 NorthStarMetricsService 编译产物（候选：${candidates.join(" / ")}）；先执行 cd apps/admin-api && npm run build`,
    );
  }
  return found;
}

async function loadServiceClass(relPath) {
  require("reflect-metadata");
  const abs = join(ROOT, relPath);
  try {
    const mod = require(abs);
    const Ctor = mod.NorthStarMetricsService;
    if (typeof Ctor !== "function") throw new Error("模块未导出 NorthStarMetricsService 构造函数");
    return Ctor;
  } catch (e) {
    if (/Cannot use import statement|require\(\) of ES Module|must be loaded using .*import/i.test(String(e?.message ?? e))) {
      const mod = await import(pathToFileURL(abs).href);
      const Ctor = mod.NorthStarMetricsService;
      if (typeof Ctor !== "function") throw new StructuralError("ESM 模块未导出 NorthStarMetricsService");
      return Ctor;
    }
    throw new StructuralError(`加载 NorthStarMetricsService 失败：${redact(e?.message ?? e)}`);
  }
}

function classifyServiceError(e, dsn) {
  const code = String(e?.code ?? "");
  const msg = redact(e?.message ?? e, dsn);
  if (code === "ECONNREFUSED" || code === "ENOTFOUND" || code === "EHOSTUNREACH" || code.startsWith("28") ||
      /ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|connect|timeout|password authentication/i.test(msg)) {
    return new ConnectError(msg);
  }
  return new StructuralError(`API service report 执行失败：${msg}`);
}

async function runApiService(dsn, asOf, serviceRel) {
  const rel = findServiceModule(serviceRel);
  const Ctor = await loadServiceClass(rel);
  let DataSource;
  try {
    ({ DataSource } = require("typeorm"));
  } catch (e) {
    throw new StructuralError(`加载 typeorm DataSource 失败：${redact(e?.message ?? e)}`);
  }
  if (typeof DataSource !== "function") throw new StructuralError("typeorm 未导出 DataSource 构造函数");

  const ds = new DataSource({
    type: "postgres",
    url: dsn,
    synchronize: false,
    logging: false,
    extra: { connectionTimeoutMillis: 8000 },
  });
  try {
    await ds.initialize();
  } catch (e) {
    throw classifyServiceError(e, dsn);
  }
  try {
    const svc = new Ctor(ds);
    if (typeof svc?.report !== "function") {
      throw new StructuralError("NorthStarMetricsService 未实现 report(asOf?)");
    }
    const payload = await svc.report(asOf);
    if (!payload || typeof payload !== "object") {
      throw new StructuralError("NorthStarMetricsService.report 返回非对象");
    }
    return payload;
  } catch (e) {
    if (e instanceof StructuralError || e instanceof ConnectError) throw e;
    throw classifyServiceError(e, dsn);
  } finally {
    await ds.destroy().catch(() => {});
  }
}

/* ── selftest：纯函数门控，不连库 ─────────────────────────────────────── */

export function runSelftest() {
  const { items, applyAssert } = makeAsserts();
  const plan = buildSeedPlan();
  const strict = plan.events.filter((e) => e.event_name === "business_confirmed" && e.dedupe_key.startsWith("confirmed:"));
  const inWindow = strict.filter((e) => e.ts <= AS_OF);
  const validProxy = plan.executions.filter(
    (x) => x.status === "success" && x.synthetic === false && x.artifacts.length > 0 && x.endTime <= AS_OF_SQL,
  );

  applyAssert("install_id 形状：<前缀><32hex>", plan.events.every((e) => new RegExp(`^${PREFIX}[0-9a-f]{32}$`).test(e.install)), `n=${plan.events.length}`);
  applyAssert("confirmed dedupe_key 形状：confirmed:<32hex>", strict.every((e) => /^confirmed:[0-9a-f]{32}$/.test(e.dedupe_key)), `n=${strict.length}`);
  applyAssert("干扰行存在且前缀错", strict.length < plan.events.length && plan.events.some((e) => /^first-[0-9a-f]{32}$/.test(e.dedupe_key)), `总行=${plan.events.length}`);
  applyAssert("as_of 内严格行=4（周 A 三 + 周 B 一）", inWindow.length === 4, `实得 ${inWindow.length}`);
  applyAssert("周 A 同 install 2 个不同 dedupe", new Set(strict.filter((e) => e.install === installId(1)).map((e) => e.dedupe_key)).size === 2, "ok");
  applyAssert("有效代理行=2（三过滤+as_of 上界生效）", validProxy.length === 2, `实得 ${validProxy.length}`);
  applyAssert("EXPECTED 独立：周 A active=2/confirmed=3", EXPECTED.strict[1].active_installs === 2 && EXPECTED.strict[1].confirmed_events === 3, "ok");

  const good = {
    as_of: EXPECTED.as_of,
    business_confirmed: { weeks: EXPECTED.strict, totals: EXPECTED.strictTotals },
    business_results_proxy: { weeks: EXPECTED.proxy, totals: EXPECTED.proxyTotals },
    promotionEligibility: EXPECTED.promotionEligibility,
    warnings: EXPECTED.warnings,
  };
  const pos = makeAsserts(false);
  compareFields(good, JSON.parse(JSON.stringify(good)), pos.applyAssert);
  compareWithExpected(good, pos.applyAssert, "selftest");
  applyAssert("对账器正例全绿", pos.items.every((x) => x.ok), `${pos.items.filter((x) => x.ok).length}/${pos.items.length}`);

  // API 比 CLI 多 reasonDetails：它不应让逐字段对账/EXPECTED 门控假红。
  const apiGood = JSON.parse(JSON.stringify(good));
  apiGood.promotionEligibility.reasonDetails = apiGood.promotionEligibility.reasons.map((text, i) => ({ code: `SELFTEST_${i}`, text }));
  const apiPos = makeAsserts(false);
  compareFields(good, apiGood, apiPos.applyAssert);
  compareWithExpected(apiGood, apiPos.applyAssert, "selftest-api-extra");
  applyAssert("API 多 reasonDetails 不假红", apiPos.items.every((x) => x.ok), `${apiPos.items.filter((x) => x.ok).length}/${apiPos.items.length}`);

  // 三条 promotion 子字段真反证：每条只改 API payload 副本一处，compareFields 必须点亮对应路径。
  const assertPromoCounterproof = (name, mutate, redPath) => {
    const before = createHash("sha256").update(show(apiGood)).digest("hex");
    const bad = JSON.parse(JSON.stringify(apiGood));
    mutate(bad.promotionEligibility);
    const probe = makeAsserts(false);
    compareFields(good, bad, probe.applyAssert);
    const redPaths = probe.items.filter((x) => !x.ok).map((x) => x.name);
    applyAssert(
      `反证：${name} ⇒ 对账转红`,
      redPaths.some((path) => path.includes(redPath)),
      `红项 ${redPaths.join(" | ") || "无"}`,
    );
    const after = createHash("sha256").update(show(apiGood)).digest("hex");
    applyAssert(`反证：原 API payload sha256 前后不变（${name}）`, before === after, `${before.slice(0, 12)}… → ${after.slice(0, 12)}…`);
  };
  assertPromoCounterproof("promotionEligibility.eligible 取反", (p) => { p.eligible = !p.eligible; }, "promotionEligibility.eligible");
  assertPromoCounterproof("promotionEligibility.thresholds.minWeeks+1", (p) => { p.thresholds.minWeeks += 1; }, "promotionEligibility.thresholds");
  assertPromoCounterproof("promotionEligibility.reasons[0] 文案改字", (p) => { p.reasons[0] = p.reasons[0].replace("样本", "样版"); }, "promotionEligibility.reasons");

  const negPayload = JSON.parse(JSON.stringify(good));
  negPayload.business_confirmed.weeks[1].confirmed_events += 1;
  const neg = makeAsserts(false);
  compareFields(good, negPayload, neg.applyAssert);
  applyAssert("对账器反例转红", neg.items.some((x) => !x.ok), `红项 ${neg.items.filter((x) => !x.ok).length}/${neg.items.length}`);

  const cp = makeAsserts(false);
  runCounterproof(good, good, cp.applyAssert);
  applyAssert("反证自身全绿（能抓红且 sha 不变）", cp.items.every((x) => x.ok), `${cp.items.filter((x) => x.ok).length}/${cp.items.length}`);

  const bad = items.filter((x) => !x.ok);
  console.log(`\nSELFTEST ${items.length - bad.length}/${items.length}` + (bad.length ? "（有失败）" : "（全部通过）"));
  return bad.length ? 1 : 0;
}

/* ── main ─────────────────────────────────────────────────────────────── */

const HELP = `用法：
  node scripts/north-star-api-reconcile.mjs --from-env
  node scripts/north-star-api-reconcile.mjs --dsn=<url>
  node scripts/north-star-api-reconcile.mjs --selftest
  node scripts/north-star-api-reconcile.mjs --from-env --counterproof
  node scripts/north-star-api-reconcile.mjs --service=<apps/admin-api/dist/.../north-star-metrics.service.js>
覆盖字段：as_of / business_confirmed.weeks+totals / business_results_proxy.weeks+totals /
promotionEligibility 共有子集(eligible,reasons,weeks,activeInstallWeeks,thresholds) / warnings；
API 额外 reasonDetails 不逐字比对（CLI 不产）。
目标库名须含 test|e2e，否则 exit 2。无连接参数 ⇒ SKIP exit 0（不假绿）。
退出码：0 全一致 / 1 对账失败（--counterproof 下应稳定为 1） / 2 结构错 / 3 连不上；口令不落日志。`;

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
    return makeAsserts().applyAssert("库名防误：目标库须含 test|e2e", false, `目标库=${dbName ?? "不可解析"}`) ? 0 : 2;
  }
  const { items, applyAssert } = makeAsserts();
  applyAssert("库名防误：目标库含 test|e2e", true, `目标库=${dbName}`);

  let structural = 0;
  let connectFailed = false;
  const { Client } = await loadPg();
  const client = new Client({ connectionString: dsn, connectionTimeoutMillis: 8000 });
  let connected = false;
  let seeded = false;

  try {
    await client.connect();
    connected = true;

    const pre = await prefixResidual(client);
    if (pre.funnel || pre.exec || pre.task) {
      structural = 2;
      applyAssert("前缀冲突预检=0", false, `funnel=${pre.funnel} exec=${pre.exec} task=${pre.task}`);
    } else {
      applyAssert("前缀冲突预检=0", true, `三表均无 ${PREFIX} 残留`);
    }

    if (!structural) {
      const plan = buildSeedPlan();
      seeded = true;
      await seed(client, plan);
      applyAssert("种子写入", true, `funnel=${plan.events.length} exec=${plan.executions.length} task=1（前缀 ${PREFIX}）`);

      let cliPayload;
      try {
        cliPayload = runCliReport(dsn);
        applyAssert("权威 CLI --report status=OK", true, `as_of=${cliPayload.as_of}`);
      } catch (e) {
        if (e instanceof ConnectError) { connectFailed = true; applyAssert("权威 CLI 连库", false, redact(e?.message ?? e, dsn)); }
        else { structural = 2; applyAssert("权威 CLI --report 可用", false, redact(e?.message ?? e, dsn)); }
      }

      let apiPayload;
      try {
        apiPayload = await runApiService(dsn, AS_OF, opts.service);
        applyAssert("API service report 调用", true, `编译产物=${findServiceModule(opts.service)}`);
      } catch (e) {
        if (e instanceof ConnectError) { connectFailed = true; applyAssert("API service 连库", false, redact(e?.message ?? e, dsn)); }
        else { structural = 2; applyAssert("API service report 可用", false, redact(e?.message ?? e, dsn)); }
      }

      let originalApiPayload = null;
      let preCounterSha = null;
      if (!structural && !connectFailed && opts.counterproof) {
        originalApiPayload = apiPayload;
        preCounterSha = createHash("sha256").update(show(apiPayload)).digest("hex");
        apiPayload = JSON.parse(JSON.stringify(apiPayload));
        const injected = apiPayload?.business_confirmed?.weeks?.find((w) => w.week_start === WEEK_A)
          ?? apiPayload?.business_confirmed?.weeks?.[0];
        if (injected && typeof injected.confirmed_events === "number") {
          const beforeEvents = injected.confirmed_events;
          injected.confirmed_events += 1;
          applyAssert("反证注入：路径② confirmed_events+1", true, `${injected.week_start}: ${beforeEvents} → ${injected.confirmed_events}`);
        } else {
          structural = 2;
          applyAssert("反证注入：路径② confirmed_events 可篡改", false, show(apiPayload?.business_confirmed?.weeks));
        }
        const promo = apiPayload?.promotionEligibility;
        if (promo && typeof promo.eligible === "boolean") {
          const beforeEligible = promo.eligible;
          promo.eligible = !beforeEligible;
          applyAssert("反证注入：路径② promotionEligibility.eligible 取反", true, `${beforeEligible} → ${promo.eligible}`);
        } else {
          structural = 2;
          applyAssert("反证注入：路径② promotionEligibility.eligible 可篡改", false, show(promo));
        }
        if (!structural) {
          const counterProbe = makeAsserts(false);
          compareFields(cliPayload, apiPayload, counterProbe.applyAssert);
          const redPaths = counterProbe.items.filter((x) => !x.ok).map((x) => x.name);
          applyAssert(
            "反证注入：confirmed_events+1 与 eligible 取反均可被 compareFields 抓红",
            redPaths.some((name) => name.includes("business_confirmed.weeks")) && redPaths.some((name) => name.includes("promotionEligibility.eligible")),
            `红项 ${redPaths.join(" | ") || "无"}`,
          );
        }
      }

      if (!structural && !connectFailed) {
        console.log("--- 权威 CLI payload（关键字段）---");
        console.log(JSON.stringify(cliPayload, null, 2));
        console.log("--- 被测 API service payload（关键字段）---");
        console.log(JSON.stringify(apiPayload, null, 2));
        compareWithExpected(cliPayload, applyAssert, "CLI");
        compareWithExpected(apiPayload, applyAssert, "API");
        compareFields(cliPayload, apiPayload, applyAssert);
        if (opts.counterproof) {
          const postCounterSha = createHash("sha256").update(show(originalApiPayload)).digest("hex");
          applyAssert("反证：原路径② payload sha256 前后不变（双注入）", preCounterSha === postCounterSha, `${preCounterSha.slice(0, 12)}… → ${postCounterSha.slice(0, 12)}…`);
        } else {
          runCounterproof(cliPayload, apiPayload, applyAssert);
        }
      }
    }
  } catch (e) {
    const msg = redact(e?.message ?? e, dsn);
    if (/ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|connect|timeout|password authentication/i.test(msg) || String(e?.code ?? "").startsWith("28")) {
      connectFailed = true;
      applyAssert("连接测试库", false, msg);
    } else {
      structural = 2;
      applyAssert("真库执行异常", false, msg);
    }
  } finally {
    if (connected) {
      if (seeded) {
        try {
          await cleanup(client, applyAssert);
        } catch (e) {
          structural = structural || 2;
          applyAssert("清理失败", false, redact(e?.message ?? e, dsn));
        }
      } else {
        console.log(`— 清理确认：未播种（前缀冲突/连接前失败），不触碰任何行`);
      }
      await client.end().catch(() => {});
    } else {
      console.log("— 清理确认：未建立连接，无种子可清理");
    }
  }

  const assertFailed = items.some((x) => !x.ok);
  const code = connectFailed ? 3 : structural ? 2 : assertFailed ? 1 : 0;
  console.log(
    `\n${code === 0 ? "✔" : "✘"} R327 API/CLI 真库对账：${code === 0 ? "逐字段全通过，反证红有效，清理复查 0" : `失败（exit ${code}）`}`,
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
