#!/usr/bin/env node
/**
 * north-star-health.mjs — R432 北极星体系「一条命令自检」（R329 人工审计的可复跑固化）。
 *
 * 6 项检查，逐项 [PASS|FAIL|SKIP]，汇总 `NORTH_STAR_HEALTH: N/M PASS`（SKIP 不计入分母 M）：
 *   ① 表结构（真库，可选）：给 DSN 才跑；funnel_events / telemetry_optin 存在(to_regclass) + 关键列。
 *   ② listener 事件名齐全（静态）：4 个 eventName + 6 个领域事件订阅（R432 校正：4 个，不是 3 个）。
 *   ③ 判据口径哨针（静态）：优先复用 north-star-weekly.mjs 的 checkDrift()（§5 SQL 全串逐字相等 +
 *      4 基础 token + 7 条代理约束 + UTC 钉死）；import 受阻则退化成对两文件的 token 级检查并说明。
 *   ④ 数据 API 接线（静态）：GET /agent/north-star/metrics + DTO 四字段 + module 注册 Service。
 *   ⑤ 看板接线（静态）：DashboardPage import+渲染 NorthStarCard；双区 strict/proxy + warnings 原文渲染
 *      + 反证锚点（getNorthStar 第一参 undefined 的测试在）。
 *   ⑥ opt-in 双闸 fail-closed（静态）：record 先 isOptedIn 再写；isOptedIn 系统闸+实例闸双判；
 *      status coverage 四态在（R329）。
 *
 * ## 诚实边界（必须随输出展示）
 * - ②–⑥ 是**静态检查**：只能证明「代码在、字面一致」，**不能证明运行时正确**。静态 PASS ≠ 运行时健康。
 * - ① 是唯一的**真库项**：仅在提供 DSN（--dsn / --from-env）时验证表/列真实存在；无 DSN 报 SKIP，不判 FAIL。
 * - 口令只进 pg Client / redact 后的日志，任何输出（含 --json / 错误信息）都不含明文口令。
 *
 * ## 用法
 *   node scripts/north-star-health.mjs                       # 纯静态：① SKIP，②–⑥ 静态
 *   node scripts/north-star-health.mjs --from-env             # 真测试库：6/6
 *   node scripts/north-star-health.mjs --dsn=<url>            # 显式 DSN（库名须含 test|e2e）
 *   node scripts/north-star-health.mjs --json --from-env      # 机器可读
 *   node scripts/north-star-health.mjs --selftest              # 内存夹具测 checker 判定逻辑，不连库
 *   node scripts/north-star-health.mjs --root=/tmp/mirror     # 注入 root（反证/镜像用）
 *
 * ## 退出码
 *   0 全绿（所有非 SKIP 项 PASS，含 SKIP） / 1 有 FAIL / 2 结构错（参数非法 / 生产库名 / 结构异常）。
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE_DIR = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(HERE_DIR, "..");
const require = createRequire(join(ROOT, "apps/admin-api/package.json"));

/** 被检查文件的相对路径（单一事实源，改动即红）。 */
export const PATHS = {
  listenerInstall: "apps/admin-api/src/modules/agent/runtime/funnel-install.listener.ts",
  listenerSuccess: "apps/admin-api/src/modules/agent/runtime/funnel-success.listener.ts",
  listenerAttempt: "apps/admin-api/src/modules/agent/runtime/funnel-attempt.listener.ts",
  listenerConfirm: "apps/admin-api/src/modules/agent/runtime/funnel-confirmation.listener.ts",
  controller: "apps/admin-api/src/modules/agent/agent.controller.ts",
  northStarDto: "apps/admin-api/src/modules/agent/dto/agent-north-star.dto.ts",
  agentModule: "apps/admin-api/src/modules/agent/agent.module.ts",
  dashboard: "apps/admin-web/src/pages/DashboardPage.tsx",
  card: "apps/admin-web/src/components/dashboard/NorthStarCard.tsx",
  cardTest: "apps/admin-web/src/__tests__/north-star-card.test.tsx",
  funnelEvents: "apps/admin-api/src/modules/agent/runtime/funnel-events.service.ts",
  telemetryOptin: "apps/admin-api/src/modules/agent/runtime/telemetry-optin.service.ts",
  telemetryDto: "apps/admin-api/src/modules/agent/dto/agent-telemetry.dto.ts",
  weekly: "scripts/north-star-weekly.mjs",
  doc: "docs/plan/north-star-business-confirmed.md",
};

export const BOUNDARY_TEXT =
  "边界：②–⑥ 为静态项（只证明代码存在/字面一致，不能证明运行时正确）；① 为唯一真库项，仅给 DSN 时执行。";

/* ── DSN / 防误生产 / redact（复用 north-star-pg-reconcile.mjs 范式）────── */

/** 目标库名必须含 test|e2e，挡住 production 库。 */
export function isTestDatabase(name) {
  return /(^|_)(test|e2e)(_|$)/i.test(String(name ?? ""));
}

export function dsnDatabase(dsn) {
  try {
    return decodeURIComponent(new URL(dsn).pathname.replace(/^\//, "")) || "";
  } catch {
    return null;
  }
}

export function maskDsn(dsn) {
  try {
    const u = new URL(dsn);
    return `${u.hostname}:${u.port || 5432}/${decodeURIComponent(u.pathname.replace(/^\//, ""))} as ${decodeURIComponent(u.username || "")}（口令${u.password ? "已提供" : "缺"}）`;
  } catch {
    return "[DSN 不可解析]";
  }
}

export function redact(text, dsn) {
  let s = String(text ?? "");
  if (dsn) s = s.split(dsn).join("[REDACTED_DSN]");
  return s.replace(/\/\/[^:@\s/]+:[^@\s/]+@/g, "//[REDACTED]@");
}

function readEnvFile(root) {
  try {
    const raw = readFileSync(join(root, ".env"), "utf8");
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

/** DSN 优先级：--dsn > DATABASE_URL > --from-env(.env DB_* + 默认 autoflow_ttfv_e2e)。 */
export function resolveDsn(opts, env = process.env, root = ROOT) {
  if (opts.dsn) return { dsn: opts.dsn, source: "--dsn" };
  if (env.DATABASE_URL) return { dsn: env.DATABASE_URL, source: "DATABASE_URL" };
  if (!opts.fromEnv) return { dsn: null, source: null };
  const file = readEnvFile(root);
  const user = env.DB_USERNAME || file.DB_USERNAME;
  const password = env.DB_PASSWORD || file.DB_PASSWORD;
  const host = env.DB_HOST || file.DB_HOST;
  const port = env.DB_PORT || file.DB_PORT || "5432";
  if (!user || !host) return { dsn: null, source: null };
  // .env 的 DB_DATABASE=autoflow（生产名）不作为目标；只有显式 test/e2e 覆盖才采纳。
  const candidate = env.DB_DATABASE;
  const database = candidate && isTestDatabase(candidate) ? candidate : "autoflow_ttfv_e2e";
  const enc = (s) => encodeURIComponent(String(s ?? ""));
  return {
    dsn: `postgresql://${enc(user)}:${enc(password)}@${host}:${port}/${database}`,
    source: ".env DB_* + autoflow_ttfv_e2e",
  };
}

/* ── 通用工具 ─────────────────────────────────────────────────────────── */

export function makeReader(root) {
  return (rel) => {
    try {
      return readFileSync(join(root, rel), "utf8");
    } catch {
      return "";
    }
  };
}

function makeMapReader(map) {
  return (rel) => map[rel] ?? "";
}

const PASS = "PASS", FAIL = "FAIL", SKIP = "SKIP";
const result = (status, detail, extra = {}) => ({ status, detail, ...extra });

function missingFiles(read, rels) {
  return rels.filter((r) => !read(r).trim());
}

/* ── ① 表结构（真库，可选）─────────────────────────────────────────────── */

const TABLE_COLUMNS = {
  funnel_events: ["event_name", "dedupe_key", "ts", "install_id"],
  telemetry_optin: ["opt_in", "install_id"],
};

/** 无 DSN ⇒ SKIP（纯静态模式）；给 DSN ⇒ 真库 to_regclass + information_schema 列核对。 */
export async function checkTables(dsn) {
  if (!dsn) {
    return result(SKIP, "未提供 DSN（--dsn/--from-env）→ 表结构未验；纯静态模式，此项不判 FAIL");
  }
  const db = dsnDatabase(dsn);
  if (!isTestDatabase(db)) {
    return result(FAIL, `防误生产守卫：目标库名「${db ?? "不可解析"}」不含 test|e2e，拒绝连库`, { structural: true });
  }
  let pg;
  try {
    pg = require("pg");
  } catch (err) {
    return result(FAIL, `加载 pg 失败：${redact(err.message, dsn)}`, { structural: true });
  }
  const client = new pg.Client({ connectionString: dsn, connectionTimeoutMillis: 8000 });
  let connected = false;
  try {
    await client.connect();
    connected = true;
    const reg = await client.query(
      `SELECT to_regclass('public.funnel_events') AS fe, to_regclass('public.telemetry_optin') AS topt`,
    );
    const row = reg.rows[0] ?? {};
    const problems = [];
    if (!row.fe) problems.push("funnel_events 表不存在（to_regclass=null）");
    if (!row.topt) problems.push("telemetry_optin 表不存在（to_regclass=null）");
    const cols = await client.query(
      `SELECT table_name, column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name IN ('funnel_events','telemetry_optin')`,
    );
    const byTable = {};
    for (const c of cols.rows) (byTable[c.table_name] ??= new Set()).add(c.column_name);
    for (const [table, need] of Object.entries(TABLE_COLUMNS)) {
      const have = byTable[table] ?? new Set();
      const lack = need.filter((k) => !have.has(k));
      if (lack.length) problems.push(`${table} 缺关键列：${lack.join(", ")}`);
    }
    if (problems.length) return result(FAIL, problems.join("；"), { scope: "live" });
    return result(PASS, `to_regclass 两表在；关键列 funnel_events[${TABLE_COLUMNS.funnel_events.join(",")}] / telemetry_optin[${TABLE_COLUMNS.telemetry_optin.join(",")}] 全在（真库 ${db}）`, { scope: "live" });
  } catch (err) {
    const msg = redact(err?.message ?? err, dsn);
    const connectish = /connect|ECONN|timeout|ENOTFOUND|password authentication|28P01/i.test(msg);
    return result(FAIL, `${connectish ? "连库失败" : "真库查询异常"}：${msg}`, { structural: connectish });
  } finally {
    if (connected) await client.end().catch(() => {});
  }
}

/* ── ② listener 事件名 / 订阅（静态）──────────────────────────────────── */

/** R432 校正：4 个 eventName（不是 3 个）+ 6 个订阅。 */
export const LISTENER_SPECS = [
  { file: PATHS.listenerInstall, event: "install_completed", subs: ["EXECUTOR_REGISTERED"] },
  { file: PATHS.listenerSuccess, event: "task_first_success", subs: ["EXECUTION_COMPLETED"] },
  { file: PATHS.listenerAttempt, event: "task_first_attempted", subs: ["EXECUTION_COMPLETED", "EXECUTION_FAILED", "EXECUTION_KILLED"] },
  { file: PATHS.listenerConfirm, event: "business_confirmed", subs: ["EXECUTION_CONFIRMED"] },
];

export function checkListeners(read) {
  const absent = missingFiles(read, LISTENER_SPECS.map((s) => s.file));
  if (absent.length) return result(FAIL, `listener 文件缺失/为空：${absent.join(", ")}`, { scope: "static" });
  const problems = [];
  let evCount = 0, subCount = 0, subTotal = 0;
  for (const spec of LISTENER_SPECS) {
    const text = read(spec.file);
    const evRe = new RegExp(`eventName:\\s*["']${spec.event}["']`);
    if (evRe.test(text)) evCount += 1;
    else problems.push(`${spec.file.split("/").pop()} 缺 eventName='${spec.event}'`);
    for (const s of spec.subs) {
      subTotal += 1;
      const subRe = new RegExp(`this\\.bus\\.on\\(DOMAIN_EVENTS\\.${s}\\b`);
      if (subRe.test(text)) subCount += 1;
      else problems.push(`${spec.file.split("/").pop()} 缺订阅 DOMAIN_EVENTS.${s}`);
    }
  }
  const detail = `4/4 eventName（install_completed/task_first_success/task_first_attempted/business_confirmed）+ ${subCount}/${subTotal} 订阅（EXECUTOR_REGISTERED / COMPLETED / FAILED / KILLED / CONFIRMED）`;
  return problems.length
    ? result(FAIL, `${detail}；缺口：${problems.join("；")}`, { scope: "static" })
    : result(PASS, detail, { scope: "static" });
}

/* ── ③ 判据口径哨针（静态）─────────────────────────────────────────────── */

/** 与 north-star-weekly.mjs 的 DRIFT_TOKENS / PROXY_INVARIANTS 镜像（token 级退化路径用）。 */
export const DRIFT_TOKENS = ["business_confirmed", "date_trunc('week'", "COUNT(DISTINCT install_id)", "confirmed:"];
export const PROXY_INVARIANTS = [
  { name: "SUCCESS 终态", re: /e\."status"\s*=\s*'success'/ },
  { name: "synthetic=false 排除", re: /e\."synthetic"\s*=\s*false/ },
  { name: "artifacts 为 array", re: /jsonb_typeof\(e\."artifacts"\)\s*=\s*'array'/ },
  { name: "jsonb_array_length > 0", re: /jsonb_array_length\(e\."artifacts"\)\s*>\s*0/ },
  { name: "CASE 包裹消除求值顺序依赖", re: /CASE\s+WHEN\s+jsonb_typeof\(e\."artifacts"\)\s*=\s*'array'\s+THEN\s+jsonb_array_length\(e\."artifacts"\)\s*>\s*0\s+ELSE\s+false\s+END/ },
  { name: "endTime 周桶（AT TIME ZONE UTC）", re: /date_trunc\('week',\s*e\."endTime"\s+AT\s+TIME\s+ZONE\s+'UTC'\)/ },
  { name: "endTime as_of 上界", re: /e\."endTime"\s*<=\s*:as_of/ },
];

const normalizeSql = (s) => String(s).replace(/\r\n?/g, "\n").replace(/\s+/g, " ").trim().replace(/;$/, "").trim();
const stripSqlComments = (s) => String(s).split(/\r?\n/).map((l) => l.replace(/--.*$/, "").trim()).filter(Boolean).join(" ");
const canonicalSql = (s) => normalizeSql(stripSqlComments(s));

function extractSection5Sql(src) {
  const lines = String(src).split(/\r?\n/);
  const start = lines.findIndex((l) => /^#{1,6}\s*(?:§\s*)?5(?:[.．、)\s]|$)/.test(l));
  if (start < 0) throw new Error("文档找不到 §5 标题");
  const m = lines.slice(start + 1).join("\n").match(/```sql\s*\n([\s\S]*?)```/);
  if (!m) throw new Error("文档 §5 找不到 ```sql 代码块");
  return m[1].trim();
}

function extractSqlConst(src, name) {
  const m = String(src).match(new RegExp(`export\\s+const\\s+${name}\\s*=\\s*\`([\\s\\S]*?)\``));
  if (!m) throw new Error(`脚本找不到 ${name} 常量`);
  return m[1].trim();
}

function firstDiffAt(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i += 1) if (a[i] !== b[i]) return i;
  return n;
}

/** token 级等价检查（import ESM 受阻 / 注入 root 时的退化路径）。 */
export function caliberTokenCheck(docSrc, weeklySrc) {
  const problems = [];
  let docNorm = "", builtNorm = "", proxyNorm = "";
  try {
    docNorm = canonicalSql(extractSection5Sql(docSrc));
    builtNorm = canonicalSql(extractSqlConst(weeklySrc, "BUSINESS_CONFIRMED_SQL"));
    proxyNorm = canonicalSql(extractSqlConst(weeklySrc, "BUSINESS_RESULTS_PROXY_SQL"));
  } catch (err) {
    return result(FAIL, `SQL 抽取失败：${err.message}`, { scope: "static", method: "token" });
  }
  if (docNorm !== builtNorm) {
    problems.push(`文档 §5 SQL 与脚本 BUSINESS_CONFIRMED_SQL 规范化全串不一致 @字符 ${firstDiffAt(docNorm, builtNorm)}`);
  }
  for (const t of DRIFT_TOKENS) {
    if (!docNorm.includes(normalizeSql(t))) problems.push(`文档 §5 SQL 缺 token：${t}`);
    if (!builtNorm.includes(normalizeSql(t))) problems.push(`脚本 SQL 缺 token：${t}`);
  }
  if (PROXY_INVARIANTS.length !== 7) problems.push(`代理约束表自身数量=${PROXY_INVARIANTS.length}（应为 7）`);
  const missing = PROXY_INVARIANTS.filter((v) => !v.re.test(proxyNorm)).map((v) => v.name);
  if (missing.length) problems.push(`代理 SQL 缺约束 ${missing.length}/7：${missing.join(" | ")}`);
  return problems.length
    ? result(FAIL, `token 级：${problems.join("；")}`, { scope: "static", method: "token" })
    : result(PASS, "token 级：§5 SQL 全串逐字相等 + 4 token + 7 条代理约束在", { scope: "static", method: "token" });
}

/**
 * 优先 import 真 checkDrift()；受阻退化到 token 级并说明。
 * injected=true（selftest / --root 镜像）时直接用两文件内容做 token 检查，不读真实仓库模块。
 */
export async function checkCaliber(read, injected = false) {
  if (injected) {
    const r = caliberTokenCheck(read(PATHS.doc), read(PATHS.weekly));
    r.detail = `注入 root（非真实仓库模块）：${r.detail}`;
    return r;
  }
  try {
    const mod = await import("./north-star-weekly.mjs");
    if (typeof mod.checkDrift !== "function") throw new Error("checkDrift 未导出");
    const out = mod.checkDrift();
    const inv = out.proxyInvariants;
    if (!Array.isArray(inv) || inv.length !== 7) throw new Error(`代理约束数=${Array.isArray(inv) ? inv.length : "非数组"}（应为 7）`);
    return result(
      PASS,
      `复用 north-star-weekly.mjs checkDrift()：§5 SQL 全串逐字相等 + 基础 token ${out.docTokens.length}/4 + 代理约束 ${inv.length}/7 + UTC 钉死 ${out.utcPin}`,
      { scope: "static", method: "checkDrift" },
    );
  } catch (err) {
    const fb = caliberTokenCheck(read(PATHS.doc), read(PATHS.weekly));
    fb.detail = `checkDrift() import/执行受阻（${redact(err?.message ?? err, null)}）→ 退化为 token 级：${fb.detail}`;
    return fb;
  }
}

/* ── ④ 数据 API 接线（静态）───────────────────────────────────────────── */

export function checkApi(read) {
  const absent = missingFiles(read, [PATHS.controller, PATHS.northStarDto, PATHS.agentModule]);
  if (absent.length) return result(FAIL, `API 文件缺失/为空：${absent.join(", ")}`, { scope: "static" });
  const ctrl = read(PATHS.controller);
  const dto = read(PATHS.northStarDto);
  const mod = read(PATHS.agentModule);
  const problems = [];
  const routeRe = /@Get\(["']north-star\/metrics["']\)/;
  if (!routeRe.test(ctrl)) problems.push('agent.controller.ts 缺 @Get("north-star/metrics")（GET，非 POST）');
  if (!/north-star\/metrics[\s\S]{0,700}AgentNorthStarResponseDto/.test(ctrl)) {
    problems.push("路由方法未声明 AgentNorthStarResponseDto 响应");
  }
  for (const f of ["as_of", "business_confirmed", "business_results_proxy", "warnings"]) {
    if (!new RegExp(`^\\s*${f}\\s*:\\s*`, "m").test(dto)) problems.push(`AgentNorthStarResponseDto 缺字段 ${f}`);
  }
  if (!/providers\s*:\s*\[[\s\S]*?NorthStarMetricsService/.test(mod)) {
    problems.push("agent.module.ts providers 未注册 NorthStarMetricsService");
  }
  return problems.length
    ? result(FAIL, `API 接线缺口：${problems.join("；")}`, { scope: "static" })
    : result(PASS, '@Get("north-star/metrics") GET 路由 + DTO 四字段(as_of/business_confirmed/business_results_proxy/warnings) + module 注册 NorthStarMetricsService', { scope: "static" });
}

/* ── ⑤ 看板接线（静态）────────────────────────────────────────────────── */

export function checkDashboard(read) {
  const absent = missingFiles(read, [PATHS.dashboard, PATHS.card, PATHS.cardTest]);
  if (absent.length) return result(FAIL, `看板文件缺失/为空：${absent.join(", ")}`, { scope: "static" });
  const page = read(PATHS.dashboard);
  const card = read(PATHS.card);
  const test = read(PATHS.cardTest);
  const problems = [];
  if (!/import\s+NorthStarCard\s+from\s+["'][^"']*NorthStarCard["']/.test(page)) problems.push("DashboardPage.tsx 未 import NorthStarCard");
  if (!/<NorthStarCard\s*\/>/.test(page)) problems.push("DashboardPage.tsx 未渲染 <NorthStarCard />");
  if (!/data-testid=["']north-star-strict["']/.test(card)) problems.push("NorthStarCard.tsx 缺严格区 north-star-strict");
  if (!/data-testid=["']north-star-proxy["']/.test(card)) problems.push("NorthStarCard.tsx 缺代理区 north-star-proxy");
  if (!/warnings\.map\(/.test(card) || !/north-star-warning/.test(card)) problems.push("NorthStarCard.tsx 缺 warnings 原文渲染（WarningRail）");
  const anchor = /getNorthStar[\s\S]{0,700}firstCall\?\.\[0\][\s\S]{0,200}toBeUndefined\(\)/.test(test);
  if (!anchor) problems.push("反证锚点缺失：north-star-card.test.tsx 未断言 getNorthStar 第一参 undefined（不带 projectId）");
  return problems.length
    ? result(FAIL, `看板接线缺口：${problems.join("；")}`, { scope: "static" })
    : result(PASS, "DashboardPage import+渲染 NorthStarCard；NorthStarCard 严格/代理双区 + warnings 原文渲染 + 反证锚点(getNorthStar 不带 projectId)", { scope: "static" });
}

/* ── ⑥ opt-in 双闸 fail-closed（静态）─────────────────────────────────── */

export function checkOptin(read) {
  const absent = missingFiles(read, [PATHS.funnelEvents, PATHS.telemetryOptin, PATHS.telemetryDto]);
  if (absent.length) return result(FAIL, `opt-in 文件缺失/为空：${absent.join(", ")}`, { scope: "static" });
  const fe = read(PATHS.funnelEvents);
  const to = read(PATHS.telemetryOptin);
  const td = read(PATHS.telemetryDto);
  const problems = [];
  const iOpt = fe.indexOf("isOptedIn(");
  const iInsert = fe.indexOf("createQueryBuilder()");
  if (!(iOpt >= 0 && iInsert >= 0 && iOpt < iInsert)) problems.push("FunnelEventsService.record 未先 isOptedIn 再写（闸门顺序错/缺）");
  if (!/reason:\s*["']not_opted_in["']/.test(fe)) problems.push("record 未返回 {recorded:false, reason:'not_opted_in'}");
  if (!/TTFV_SYSTEM_GATE_KEY/.test(to)) problems.push("TelemetryOptinService.isOptedIn 缺系统总闸 TTFV_SYSTEM_GATE_KEY");
  if (!/findOneBy\(\{[^}]*installId[^}]*\}\)[\s\S]{0,160}optIn\s*===\s*true/.test(to)) problems.push("isOptedIn 缺实例级授权闸 findOneBy→optIn===true");
  if (!(to.indexOf("TTFV_SYSTEM_GATE_KEY") >= 0 && to.indexOf("TTFV_SYSTEM_GATE_KEY") < to.indexOf("findOneBy"))) {
    problems.push("isOptedIn 系统闸未在实例闸之前判定");
  }
  if ((to.match(/return\s+false/g) ?? []).length < 2) problems.push("isOptedIn 双闸 fail-closed 的 return false 分支不足 2 处");
  if (!/enum:\s*\[[^\]]*no_executors[^\]]*partial[^\]]*full[^\]]*gate_off[^\]]*\]/.test(td)) {
    problems.push("status coverage 四态(no_executors/partial/full/gate_off)不齐");
  }
  return problems.length
    ? result(FAIL, `opt-in 双闸缺口：${problems.join("；")}`, { scope: "static" })
    : result(PASS, "record 先 isOptedIn 再写+not_opted_in；isOptedIn 系统闸→实例闸双判且双 fail-closed；coverage 四态在", { scope: "static" });
}

/* ── 编排 ─────────────────────────────────────────────────────────────── */

const CHECK_META = [
  { id: "tables", name: "表结构（真库，可选）" },
  { id: "listeners", name: "listener 事件名齐全（静态）" },
  { id: "caliber", name: "判据口径哨针（静态）" },
  { id: "api", name: "数据 API 接线（静态）" },
  { id: "dashboard", name: "看板接线（静态）" },
  { id: "optin", name: "opt-in 双闸 fail-closed（静态）" },
];

export async function runHealth(opts, dsn) {
  const root = opts.root ? resolve(opts.root) : ROOT;
  const read = makeReader(root);
  const injected = Boolean(opts.root);
  const raw = [
    await checkTables(dsn),
    checkListeners(read),
    await checkCaliber(read, injected),
    checkApi(read),
    checkDashboard(read),
    checkOptin(read),
  ];
  const checks = CHECK_META.map((m, i) => ({ id: m.id, name: m.name, ...raw[i] }));
  const pass = checks.filter((c) => c.status === PASS).length;
  const fail = checks.filter((c) => c.status === FAIL).length;
  const skip = checks.filter((c) => c.status === SKIP).length;
  const denominator = checks.length - skip; // SKIP 不计入分母
  const structural = checks.some((c) => c.structural);
  const exit = structural ? 2 : fail > 0 ? 1 : 0;
  return {
    checks,
    summary: { total: checks.length, pass, fail, skip, denominator, structural, exit },
    meta: {
      root,
      injected,
      mode: dsn ? "with-live-db" : "static-only",
      dsnSource: dsn ? (opts.dsnSource ?? "dsn") : null,
      maskedTarget: dsn ? maskDsn(dsn) : null,
      boundary: BOUNDARY_TEXT,
    },
  };
}

function printText(out) {
  console.log("=== 北极星全链路自检（R432）===");
  console.log(out.meta.boundary);
  console.log(`模式：${out.meta.mode}${out.meta.maskedTarget ? `（${out.meta.maskedTarget}）` : ""}`);
  for (const c of out.checks) {
    console.log(`[${c.status}] ${c.name} — ${c.detail}`);
  }
  const s = out.summary;
  console.log(
    `NORTH_STAR_HEALTH: ${s.pass}/${s.denominator} PASS` +
      `（共 ${s.total} 项：${s.pass} PASS / ${s.fail} FAIL / ${s.skip} SKIP${s.skip ? "，SKIP 不计入分母" : ""}）`,
  );
}

/* ── selftest：内存夹具测判定逻辑（不连库、不依赖真实仓库状态）────────── */

/** 最小可用夹具：内容串覆盖全部被检查文件的必要字面。 */
export function makeFixtureSources() {
  const strictSql = [
    "-- strict fixture",
    "SELECT date_trunc('week', ts) AS week_start, COUNT(DISTINCT install_id) AS active_installs,",
    "COUNT(DISTINCT dedupe_key) AS confirmed_events FROM funnel_events",
    "WHERE event_name = 'business_confirmed' AND dedupe_key LIKE 'confirmed:%' AND ts <= :as_of",
    "GROUP BY 1 ORDER BY 1",
  ].join("\n");
  const proxySql = [
    "SELECT date_trunc('week', e.\"endTime\" AT TIME ZONE 'UTC') AS week_start, COUNT(*) AS business_results_proxy",
    "FROM task_executions e WHERE e.\"status\" = 'success' AND e.\"synthetic\" = false",
    "AND CASE WHEN jsonb_typeof(e.\"artifacts\") = 'array' THEN jsonb_array_length(e.\"artifacts\") > 0 ELSE false END",
    "AND e.\"endTime\" IS NOT NULL AND e.\"endTime\" <= :as_of GROUP BY 1 ORDER BY 1",
  ].join("\n");
  const m = {};
  m[PATHS.listenerInstall] = `this.bus.on(DOMAIN_EVENTS.EXECUTOR_REGISTERED, this.onRegistered); eventName: "install_completed",`;
  m[PATHS.listenerSuccess] = `this.bus.on(DOMAIN_EVENTS.EXECUTION_COMPLETED, this.onCompleted); eventName: "task_first_success",`;
  m[PATHS.listenerAttempt] = `this.bus.on(DOMAIN_EVENTS.EXECUTION_COMPLETED, x); this.bus.on(DOMAIN_EVENTS.EXECUTION_FAILED, x); this.bus.on(DOMAIN_EVENTS.EXECUTION_KILLED, x); eventName: "task_first_attempted",`;
  m[PATHS.listenerConfirm] = `this.bus.on(DOMAIN_EVENTS.EXECUTION_CONFIRMED, this.onConfirmed); eventName: "business_confirmed",`;
  m[PATHS.controller] = `@Get("north-star/metrics") async northStarReport(...): Promise<AgentNorthStarResponseDto> {}`;
  m[PATHS.northStarDto] = `export class AgentNorthStarResponseDto {\n  as_of: string;\n  business_confirmed: AgentNorthStarConfirmedDto;\n  business_results_proxy: AgentNorthStarProxyDto;\n  warnings: string[];\n}`;
  m[PATHS.agentModule] = `@Module({ providers: [ NorthStarMetricsService, ] })`;
  m[PATHS.dashboard] = `import NorthStarCard from '../components/dashboard/NorthStarCard';\n<NorthStarCard />`;
  m[PATHS.card] = `WarningRail warnings.map(...) data-testid="north-star-strict" data-testid="north-star-proxy" data-testid="north-star-warning"`;
  m[PATHS.cardTest] = `getNorthStar mock; expect(mockedMetrics.getNorthStar).toHaveBeenCalled(); const firstCall = mockedMetrics.getNorthStar.mock.calls[0]; expect(firstCall?.[0]).toBeUndefined();`;
  m[PATHS.funnelEvents] = `const optedIn = await this.optin.isOptedIn(input.installId); if (!optedIn) return { recorded: false, reason: "not_opted_in" }; const result = await this.repo.createQueryBuilder().insert();`;
  m[PATHS.telemetryOptin] = `const row = await this.systemConfig?.findOne(TTFV_SYSTEM_GATE_KEY); if (!systemEnabled) return false; const inst = await this.repo.findOneBy({ installId }); return inst?.optIn === true; catch { return false; }`;
  m[PATHS.telemetryDto] = `enum: ["no_executors", "partial", "full", "gate_off"]`;
  m[PATHS.doc] = `## 5. 判据\n\n\`\`\`sql\n${strictSql}\n\`\`\``;
  m[PATHS.weekly] = `export const BUSINESS_CONFIRMED_SQL = \`${strictSql}\`;\nexport const BUSINESS_RESULTS_PROXY_SQL = \`${proxySql}\`;`;
  return m;
}

/** 跑 6 项（注入 root，不 import 真模块、不连库）。 */
async function evalAll(read) {
  return {
    tables: await checkTables(null),
    listeners: checkListeners(read),
    caliber: await checkCaliber(read, true),
    api: checkApi(read),
    dashboard: checkDashboard(read),
    optin: checkOptin(read),
  };
}

export async function runSelftest() {
  const cases = [];
  const push = (name, ok, detail) => {
    cases.push({ name, ok, detail });
    console.log(`  ${ok ? "✓" : "✘"} ${name}${detail ? ` — ${detail}` : ""}`);
  };

  // ① 正例全绿：无 FAIL（表项 SKIP，其余静态 PASS）
  const base = makeFixtureSources();
  const all = await evalAll(makeMapReader(base));
  const noFail = Object.values(all).every((r) => r.status !== FAIL);
  push("正例：6 项无 FAIL（5 PASS + 表项 SKIP）", noFail && all.tables.status === SKIP && all.listeners.status === PASS && all.api.status === PASS,
    Object.entries(all).map(([k, v]) => `${k}=${v.status}`).join(" "));

  // ② 篡改一个 listener eventName → 对应项（②）转红，其它静态项仍绿
  const tampered = { ...base, [PATHS.listenerConfirm]: base[PATHS.listenerConfirm].replace("business_confirmed", "business_confirmed_TAMPER") };
  const badListener = await evalAll(makeMapReader(tampered));
  push("篡改 listener eventName → ② listener 项 FAIL", badListener.listeners.status === FAIL && badListener.api.status === PASS,
    `listeners=${badListener.listeners.status}, api=${badListener.api.status}`);

  // ③ 缺路由 → API 项（④）转红
  const noRoute = { ...base, [PATHS.controller]: base[PATHS.controller].replace('@Get("north-star/metrics")', "") };
  const badApi = await evalAll(makeMapReader(noRoute));
  push("缺 GET 路由 → ④ 数据 API 项 FAIL", badApi.api.status === FAIL && badApi.listeners.status === PASS,
    `api=${badApi.api.status}, listeners=${badApi.listeners.status}`);

  // ④ 无 DSN → 表项（①）SKIP（不判 FAIL）
  push("无 DSN → ① 表结构项 SKIP", all.tables.status === SKIP && !all.tables.structural, `tables=${all.tables.status}`);

  // ⑤ 判据漂移：篡改文档 §5 SQL → ③ 哨针 FAIL（token 级）
  const drifted = { ...base, [PATHS.doc]: base[PATHS.doc].replace("COUNT(DISTINCT install_id)", "COUNT(install_id)") };
  const badCaliber = await evalAll(makeMapReader(drifted));
  push("篡改 §5 SQL → ③ 判据哨针 FAIL", badCaliber.caliber.status === FAIL, `caliber=${badCaliber.caliber.status}`);

  // ⑥ 防误生产 DSN → 表项 FAIL(structural)
  const prod = await checkTables("postgresql://u:p@h:5432/autoflow");
  push("生产库名 DSN → ① 防误生产 FAIL(structural)", prod.status === FAIL && prod.structural === true, `tables=${prod.status}, structural=${prod.structural}`);

  const okCount = cases.filter((c) => c.ok).length;
  console.log(`\nSELFTEST ${okCount}/${cases.length} 通过（夹具数 ${cases.length}；不连库、不依赖真实仓库）`);
  return okCount === cases.length ? 0 : 1;
}

/* ── CLI ──────────────────────────────────────────────────────────────── */

function parseArgs(argv) {
  const o = { selftest: false, json: false, fromEnv: false, help: false, dsn: null, root: null, bad: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--help" || a === "-h") o.help = true;
    else if (a === "--selftest") o.selftest = true;
    else if (a === "--json") o.json = true;
    else if (a === "--from-env") o.fromEnv = true;
    else if (a === "--dsn" || a.startsWith("--dsn=")) {
      o.dsn = a === "--dsn" ? argv[++i] : a.slice("--dsn=".length);
      if (!o.dsn) o.bad = true;
    } else if (a.startsWith("--root=")) {
      o.root = a.slice("--root=".length);
      if (!o.root) o.bad = true;
    } else o.bad = true;
  }
  return o;
}

const HELP = `用法：
  node scripts/north-star-health.mjs                     # 纯静态（① SKIP，②–⑥ 静态）
  node scripts/north-star-health.mjs --from-env           # 真测试库（库名须含 test|e2e）
  node scripts/north-star-health.mjs --dsn=<url>          # 显式 DSN
  node scripts/north-star-health.mjs --json               # 机器可读
  node scripts/north-star-health.mjs --selftest           # 内存夹具测 checker 逻辑（不连库）
  node scripts/north-star-health.mjs --root=/tmp/mirror   # 注入 root（反证/镜像）
说明：
  ${BOUNDARY_TEXT}
  静态项 PASS 只表示「代码在/字面一致」，不代表运行时健康；只有①是真库项。
退出码：0 全绿（含 SKIP） / 1 有 FAIL / 2 结构错（参数非法 / 生产库名 / 连库异常）`;

export async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) { console.log(HELP); return 0; }
  if (opts.bad) { console.error(HELP); return 2; }
  if (opts.selftest) return runSelftest();
  const { dsn, source } = resolveDsn(opts, process.env, opts.root ? resolve(opts.root) : ROOT);
  const out = await runHealth(opts, dsn);
  out.meta.dsnSource = source;
  if (opts.json) {
    console.log(JSON.stringify({ tool: "north-star-health", revision: "R432", ...out, exit: out.summary.exit }, null, 2));
  } else {
    printText(out);
  }
  return out.summary.exit;
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
