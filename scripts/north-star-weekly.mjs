#!/usr/bin/env node
/**
 * north-star-weekly.mjs — R324 北极星「被业务确认」严格值可复算指标脚本（只读报表）。
 *
 * 背景：PM 拍板严格判据 = 新漏斗事件 business_confirmed（每次执行被显式确认一次，
 * dedupe_key = confirmed:<execution_id_hash>），按周 date_trunc('week', ts) +
 * install_id 聚合。写点由后续切片实现；本切片只落地查询侧可验证口径。
 *
 * 口径分离（绝不混算）：
 *  - 严格值 business_confirmed：源 funnel_events；按周输出 active_installs =
 *    COUNT(DISTINCT install_id)，confirmed_events = COUNT(DISTINCT dedupe_key)
 *    （dedupe_key 是写入侧幂等身份，重投不重复计数）。漏斗表无 synthetic 列，
 *    故该口径与 synthetic 无关；写入端已收口双闸（opt-in + 显式确认），
 *    查询端只统计已落库事件，不推断、不回填。
 *  - 代理值 business_results_proxy：源 task_executions；SUCCESS 且 artifacts 非空
 *    的执行数，周桶取 endTime，按 §1.2 通用排除规则排除 synthetic=true。
 *    ⚠️ 有产物/有证据 ≠ 被业务确认，代理值勿当严格值。
 *
 * 权威 SQL 与哨针：BUSINESS_CONFIRMED_SQL 的事实源是文档
 * docs/plan/north-star-business-confirmed.md §5（文档切片 A 并行产出）。
 * checkDrift() 从 §5 标题后的第一个 ```sql 代码块取 SQL，strip -- 注释行 +
 * 归一化空白后与内置 SQL **全串逐字相等**（主判据；GROUP BY / 列别名 / as_of
 * 任一改动都会转红），4-token 检查只作快速定位的附加层；代理 SQL 因文档 §8
 * 无独立 SQL 块，改由脚本内置关键约束哨针（SUCCESS / synthetic=false /
 * artifacts / jsonb_array_length / endTime / CASE 包裹）自检；周桶时区口径为
 * 「strict 的 ts 是 timestamptz → 靠 SET LOCAL UTC 钉 session；proxy 的 endTime 是
 * timestamp WITHOUT time zone → SQL 主体用 AT TIME ZONE 'UTC' 把 naive 显式解释为
 * UTC 再截断」，两条 SQL 在不同类型上方向相反，详见 BUSINESS_RESULTS_PROXY_SQL 注。
 * 文档缺失 / §5 代码块缺失 / 全串不等 / 代理约束缺失 ⇒ exit 2（不静默降级）。
 * NORTH_STAR_DOC_PATH 可覆盖哨针文档副本路径（只用于反证，不改真实文档）。
 *
 * CLI：
 *   node scripts/north-star-weekly.mjs --selftest
 *   node scripts/north-star-weekly.mjs --report [--dsn DSN] [--as-of ISO] [--json]
 *
 * 退出码：0 跑完（含缺表/无连接参数 SKIP） / 1 selftest 夹具失败 /
 *         2 结构错误（漂移哨针红 / DSN 非法 / SQL 列不匹配） / 3 连不上库。
 * 连接参数优先级：--dsn > DATABASE_URL > DB_HOST/DB_PORT/DB_USERNAME/DB_PASSWORD/DB_DATABASE。
 * pg 经 createRequire(join(ROOT,"apps/admin-api/package.json")) 加载；任何输出不打印口令。
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DOC_PATH = process.env.NORTH_STAR_DOC_PATH
  ? resolve(process.env.NORTH_STAR_DOC_PATH)
  : join(ROOT, "docs/plan/north-star-business-confirmed.md");

const SKIP_MESSAGE =
  "SKIP: funnel_events/task_executions 表不存在（严格事件写点由后续切片实现）";
const NO_TARGET_MESSAGE =
  "SKIP: 未配置连接参数（--dsn / DATABASE_URL / DB_*），未尝试连库（exit 0）";

const STRICT_CALIBER_WARNING =
  "严格口径：business_confirmed = 每次执行被显式确认一次；写入端已收口双闸，查询端只统计已落库事件（漏斗表无 synthetic 列）";
const PROXY_CALIBER_WARNING =
  "⚠️ 有产物/有证据 ≠ 被业务确认，代理值勿当严格值";

class StructuralError extends Error {}

/* ── 权威 SQL（严格值；基础 token 绑定文档 §5）────────────────────────── */

export const BUSINESS_CONFIRMED_SQL = `-- 严格值：synthetic 与漏斗表无关（表无该列）；写入端双闸已收口，
-- 查询端只统计已落库 event_name='business_confirmed' 事件；dedupe_key 幂等去重。
SELECT
  date_trunc('week', ts) AS week_start,
  COUNT(DISTINCT install_id) AS active_installs,
  COUNT(DISTINCT dedupe_key) AS confirmed_events
FROM funnel_events
WHERE event_name = 'business_confirmed'
  AND dedupe_key LIKE 'confirmed:%'
  AND ts <= :as_of
GROUP BY 1
ORDER BY 1`;

/** 代理值 SQL：与严格值分字段、分查询，绝不混算。 */
export const BUSINESS_RESULTS_PROXY_SQL = `-- 过渡期代理口径（非北极星）：SUCCESS 且 artifacts 非空的执行数；
-- 排除 synthetic=true（§1.2 通用排除规则）；周桶取 endTime；CASE 消除 AND 求值顺序依赖。
-- 时区：endTime 是 timestamp WITHOUT time zone；date_trunc 对 naive 返回的仍是 naive，
-- 经 pg 在 Node 本地时区解析会漂移。故先 AT TIME ZONE 'UTC' 把 naive 显式解释为 UTC
-- timestamptz，再在 SET LOCAL UTC 的 session 里 date_trunc('week', ...) → 稳定 UTC 周一。
SELECT
  date_trunc('week', e."endTime" AT TIME ZONE 'UTC') AS week_start,
  COUNT(*) AS business_results_proxy
FROM task_executions e
WHERE e."status" = 'success'
  AND e."synthetic" = false
  AND CASE
        WHEN jsonb_typeof(e."artifacts") = 'array'
        THEN jsonb_array_length(e."artifacts") > 0
        ELSE false
      END
  AND e."endTime" IS NOT NULL
  AND e."endTime" <= :as_of
GROUP BY 1
ORDER BY 1`;

/** 时区钉死（只服务 strict 的 timestamptz 周桶）：在 READ ONLY 事务内、两条权威 SQL
 *  之前执行，使 date_trunc('week', ts) 按 UTC 周一截断；proxy 的 naive endTime 不靠
 *  它，而由 SQL 主体 AT TIME ZONE 'UTC' 显式解释（见 BUSINESS_RESULTS_PROXY_SQL）。 */
export const UTC_PIN_SQL = "SET LOCAL TIME ZONE 'UTC'";

/** 文档 §5 SQL 基础 token（与文档切片 A 约定，任务书点名四个；附加层，不替代全串比对）。 */
export const DRIFT_TOKENS = [
  "business_confirmed",
  "date_trunc('week'",
  "COUNT(DISTINCT install_id)",
  "confirmed:",
];

/** 代理 SQL 关键约束（文档 §8 只有表格、无独立 sql 块 ⇒ 脚本内置自检守口径）。 */
export const PROXY_INVARIANTS = [
  { name: "SUCCESS 终态", re: /e\."status"\s*=\s*'success'/ },
  { name: "synthetic=false 排除", re: /e\."synthetic"\s*=\s*false/ },
  { name: "artifacts 为 array", re: /jsonb_typeof\(e\."artifacts"\)\s*=\s*'array'/ },
  { name: "jsonb_array_length > 0", re: /jsonb_array_length\(e\."artifacts"\)\s*>\s*0/ },
  { name: "CASE 包裹消除求值顺序依赖", re: /CASE\s+WHEN\s+jsonb_typeof\(e\."artifacts"\)\s*=\s*'array'\s+THEN\s+jsonb_array_length\(e\."artifacts"\)\s*>\s*0\s+ELSE\s+false\s+END/ },
  { name: "endTime 周桶（naive 显式 AT TIME ZONE UTC 后截断）", re: /date_trunc\('week',\s*e\."endTime"\s+AT\s+TIME\s+ZONE\s+'UTC'\)/ },
  { name: "endTime as_of 上界", re: /e\."endTime"\s*<=\s*:as_of/ },
];

/* ── 漂移哨针 ─────────────────────────────────────────────────────────── */

function normalizeSql(s) {
  return s.replace(/\r\n?/g, "\n").replace(/\s+/g, " ").trim().replace(/;$/, "").trim();
}

/** 抽文档 §5 标题后的第一个 ```sql 代码块；抽不到即结构红。 */
function extractSection5Sql(src) {
  const lines = src.split(/\r?\n/);
  const start = lines.findIndex((l) => /^#{1,6}\s*(?:§\s*)?5(?:[.．、)\s]|$)/.test(l));
  if (start < 0) throw new StructuralError("文档找不到 §5 标题（## 5. / ### 5.）");
  const rest = lines.slice(start + 1).join("\n");
  const m = rest.match(/```sql\s*\n([\s\S]*?)```/);
  if (!m) throw new StructuralError("文档 §5 找不到 ```sql 代码块");
  return m[1].trim();
}

/** 去掉整行/行尾 `--` 注释；两侧注释文本本就不同，不参与口径比对。 */
function stripSqlComments(s) {
  return s.split(/\r?\n/).map((line) => line.replace(/--.*$/, "").trim())
    .filter(Boolean).join(" ");
}

function canonicalSql(s) {
  return normalizeSql(stripSqlComments(s));
}

/** 首个不同字符下标（前缀相同但长度不同时返回较短串长度），供 diff 点名。 */
function firstDiffAt(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i;
  return n;
}

function diffContext(s, i) {
  const from = Math.max(0, i - 45);
  const to = Math.min(s.length, i + 60);
  return `${from > 0 ? "…" : ""}${s.slice(from, to)}${to < s.length ? "…" : ""}`;
}

/**
 * 哨针（主判据 = 规范化全串逐字相等）：
 *  ① doc §5 首个 sql 块（strip 注释 + 归一空白）=== BUSINESS_CONFIRMED_SQL 同处理；
 *  ② 4 个基础 token 双向存在性（附加层，快速定位；不替代 ①）；
 *  ③ 代理 SQL 关键约束自检（文档 §8 只有表格、无独立 sql 块，故守脚本内置口径）；
 *  ④ UTC 时区钉死常量自检（查询前 READ ONLY 事务内 SET LOCAL）。
 * 任一红 ⇒ exit 2，绝不静默放过。
 */
export function checkDrift() {
  let docSrc;
  try {
    docSrc = readFileSync(DOC_PATH, "utf8");
  } catch (err) {
    throw new StructuralError(`读不到文档（${DOC_PATH}）：${err.message}`);
  }
  const docNorm = canonicalSql(extractSection5Sql(docSrc));
  const builtNorm = canonicalSql(BUSINESS_CONFIRMED_SQL);
  const proxyNorm = canonicalSql(BUSINESS_RESULTS_PROXY_SQL);
  const problems = [];

  const missingDoc = DRIFT_TOKENS.filter((t) => !docNorm.includes(normalizeSql(t)));
  const missingBuilt = DRIFT_TOKENS.filter((t) => !builtNorm.includes(normalizeSql(t)));
  if (missingDoc.length) problems.push(`文档 §5 SQL 缺基础 token：${missingDoc.join(" | ")}`);
  if (missingBuilt.length) problems.push(`内置 SQL 缺基础 token：${missingBuilt.join(" | ")}`);

  if (docNorm !== builtNorm) {
    const i = firstDiffAt(docNorm, builtNorm);
    problems.push(
      `文档 §5 SQL 与内置 BUSINESS_CONFIRMED_SQL 规范化后不一致（口径语义漂移）@字符 ${i}\n` +
      `    文档: ${diffContext(docNorm, i)}\n` +
      `    脚本: ${diffContext(builtNorm, i)}`,
    );
  }

  const missingProxy = PROXY_INVARIANTS.filter((v) => !v.re.test(proxyNorm)).map((v) => v.name);
  if (missingProxy.length) problems.push(`代理 SQL 缺关键约束：${missingProxy.join(" | ")}`);

  if (canonicalSql(UTC_PIN_SQL).toUpperCase() !== "SET LOCAL TIME ZONE 'UTC'") {
    problems.push(`UTC 时区钉死常量被篡改：${UTC_PIN_SQL}`);
  }

  if (problems.length) throw new StructuralError(problems.join("\n"));
  return {
    docTokens: DRIFT_TOKENS,
    docSql: docNorm,
    proxyInvariants: PROXY_INVARIANTS,
    utcPin: UTC_PIN_SQL,
  };
}

/* ── 纯函数：内存版复刻 SQL 语义（selftest 对账；不连库）───────────────── */

/** PG date_trunc('week', ts)：UTC 周一 00:00（与 SQL 侧 session TimeZone=UTC 约定一致）。 */
function weekStartUtc(value) {
  const t = typeof value === "number" ? value : Date.parse(value);
  if (!Number.isFinite(t)) return null;
  const d = new Date(t);
  const sinceMonday = (d.getUTCDay() + 6) % 7;
  return new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - sinceMonday),
  ).toISOString();
}

/** R448 PM 裁决的升主数值阈值（运营前置 opt-in 覆盖率不在此判——脚本只有 opt-in 数据）。 */
export const PROMOTION_THRESHOLDS = { minWeeks: 4, minActiveInstallWeeks: 20 };
/** 运营前置提示：脚本不验证覆盖率，避免运营误把 eligible=true 当成可直接升主。 */
const PROMOTION_OPS_PREREQ =
  "运营前置（脚本不验证）：telemetry/status 的 coverage 须为 full 且 count>0";

/**
 * R448 升主判据（纯计算）：样本期 ≥4 完整周（月度窗，对齐 W4 留存口径）且
 * 活跃 install 周合计 ≥20（统计下限，> 既有 SMALL_SAMPLE=5）。两数值阈值 AND。
 * opt-in 覆盖率无全量分母、脚本不判，仅作 reasons 里的运营前置提示。
 */
export function computePromotionEligibility(strictWeeks) {
  const weeks = strictWeeks.length;
  const activeInstallWeeks = strictWeeks.reduce((a, w) => a + w.active_installs, 0);
  const { minWeeks, minActiveInstallWeeks } = PROMOTION_THRESHOLDS;
  const reasons = [];
  if (weeks < minWeeks) reasons.push(`样本期 ${weeks} 周 < ${minWeeks} 周`);
  if (activeInstallWeeks < minActiveInstallWeeks) {
    reasons.push(`活跃 install 周合计 ${activeInstallWeeks} < ${minActiveInstallWeeks}`);
  }
  reasons.push(PROMOTION_OPS_PREREQ);
  return {
    eligible: weeks >= minWeeks && activeInstallWeeks >= minActiveInstallWeeks,
    reasons,
    weeks,
    activeInstallWeeks,
    thresholds: { ...PROMOTION_THRESHOLDS },
  };
}

function buildPayload(strictWeeks, proxyWeeks, asOf) {
  const byWeek = (a, b) => a.week_start.localeCompare(b.week_start);
  const sum = (rows, key) => rows.reduce((acc, r) => acc + r[key], 0);
  const sw = [...strictWeeks].sort(byWeek);
  const pw = [...proxyWeeks].sort(byWeek);
  return {
    as_of: new Date(Date.parse(asOf)).toISOString(),
    business_confirmed: {
      weeks: sw,
      totals: {
        active_install_weeks: sum(sw, "active_installs"),
        confirmed_events: sum(sw, "confirmed_events"),
      },
    },
    business_results_proxy: {
      weeks: pw,
      totals: { executions: sum(pw, "executions") },
    },
    promotionEligibility: computePromotionEligibility(sw),
    warnings: [STRICT_CALIBER_WARNING, PROXY_CALIBER_WARNING],
  };
}

/**
 * 内存版复刻两条 SQL 的周聚合语义。
 * events 混合两种行（按字段判别，与两条 SQL 的物理表对应）：
 *   漏斗事件行：{ event_name:'business_confirmed', install_id, ts, dedupe_key }
 *   执行行：    { status:'success', artifacts:[...], endTime, synthetic:false }
 * dedupe_key 前缀 confirmed: 且全局去重 ⇒ 幂等重投不重复计确认事件。
 */
export function computeWeekly(events = [], asOf = new Date().toISOString()) {
  const asOfMs = Date.parse(asOf);
  if (!Number.isFinite(asOfMs)) throw new StructuralError(`asOf 非法：${asOf}`);

  const strictBuckets = new Map();
  const proxyBuckets = new Map();
  const seenDedupe = new Set();
  const bucket = (map, wk) => {
    let b = map.get(wk);
    if (!b) {
      b = { installs: new Set(), confirmed: 0, executions: 0 };
      map.set(wk, b);
    }
    return b;
  };

  for (const row of events) {
    if (row?.event_name === "business_confirmed") {
      const key = row.dedupe_key;
      if (typeof key !== "string" || !key.startsWith("confirmed:")) continue;
      const t = Date.parse(row.ts);
      if (!Number.isFinite(t) || t > asOfMs) continue;
      if (seenDedupe.has(key)) continue;
      seenDedupe.add(key);
      const wk = weekStartUtc(t);
      const b = bucket(strictBuckets, wk);
      if (row.install_id != null) b.installs.add(row.install_id);
      b.confirmed += 1;
      continue;
    }
    if (row?.status === "success" && row.synthetic !== true) {
      const arts = row.artifacts;
      if (!Array.isArray(arts) || arts.length === 0) continue;
      const t = Date.parse(row.endTime);
      if (!Number.isFinite(t) || t > asOfMs) continue;
      const b = bucket(proxyBuckets, weekStartUtc(t));
      b.executions += 1;
    }
  }

  const strictWeeks = [...strictBuckets.entries()].map(([week_start, b]) => ({
    week_start,
    active_installs: b.installs.size,
    confirmed_events: b.confirmed,
  }));
  const proxyWeeks = [...proxyBuckets.entries()].map(([week_start, b]) => ({
    week_start,
    executions: b.executions,
  }));
  return buildPayload(strictWeeks, proxyWeeks, asOf);
}

/* ── selftest：内存夹具（不连库）───────────────────────────────────────── */

const ISO_W1 = "2026-11-16T00:00:00.000Z"; // 周一
const ISO_W2 = "2026-11-23T00:00:00.000Z"; // 下周一
const AS_OF = "2026-11-24T12:00:00.000Z";
const confirmed = (id, ts, key) => ({
  event_name: "business_confirmed", install_id: id, ts, dedupe_key: `confirmed:${key}`,
});
const execution = (endTime, artifacts = [{ name: "out.txt" }], extra = {}) => ({
  status: "success", synthetic: false, artifacts, endTime, ...extra,
});

/** 至少 6 例：跨周分桶 / 多确认去重 install / dedupe 幂等 / 口径分离 / 空样本 / as_of 边界 + 代理过滤 + 警告。 */
export const FIXTURES = [
  {
    name: "跨周分桶：W1 两个 install 三次确认，W2 一个 install 一次确认",
    events: [
      confirmed("i1", "2026-11-16T10:00:00Z", "a"),
      confirmed("i2", "2026-11-19T10:00:00Z", "b"),
      confirmed("i1", "2026-11-20T10:00:00Z", "c"),
      confirmed("i3", "2026-11-23T10:00:00Z", "d"),
    ],
    asOf: AS_OF,
    expected: {
      strict: { [ISO_W1]: [2, 3], [ISO_W2]: [1, 1] },
      proxy: {},
    },
  },
  {
    name: "同 install 多次确认：distinct install 去重但确认计数累加",
    events: [
      confirmed("i1", "2026-11-17T01:00:00Z", "a"),
      confirmed("i1", "2026-11-17T02:00:00Z", "b"),
      confirmed("i1", "2026-11-18T03:00:00Z", "c"),
    ],
    asOf: AS_OF,
    expected: {
      strict: { [ISO_W1]: [1, 3] },
      proxy: {},
    },
  },
  {
    name: "dedupeKey 幂等：同一 confirmed: key 重投只计一次",
    events: [
      confirmed("i1", "2026-11-17T01:00:00Z", "same"),
      { ...confirmed("i1", "2026-11-17T01:00:00Z", "same") },
      confirmed("i2", "2026-11-18T01:00:00Z", "other"),
      { event_name: "business_confirmed", install_id: "i3", ts: "2026-11-18T01:00:00Z", dedupe_key: "wrong-prefix" },
    ],
    asOf: AS_OF,
    expected: {
      strict: { [ISO_W1]: [2, 2] },
      proxy: {},
    },
  },
  {
    name: "严格值与代理值分离：同周并列输出、分字段不混算",
    events: [
      confirmed("i1", "2026-11-17T01:00:00Z", "a"),
      execution("2026-11-17T02:00:00Z"),
      execution("2026-11-18T02:00:00Z"),
      execution("2026-11-24T02:00:00Z"),
    ],
    asOf: AS_OF,
    expected: {
      strict: { [ISO_W1]: [1, 1] },
      proxy: { [ISO_W1]: 2, [ISO_W2]: 1 },
    },
  },
  {
    name: "空样本：返回空周列表 + 零总计 + 两条口径警告常驻",
    events: [],
    asOf: AS_OF,
    expected: {
      strict: {}, proxy: {},
      warnings: [STRICT_CALIBER_WARNING, PROXY_CALIBER_WARNING],
    },
  },
  {
    name: "as_of 边界：恰在 as_of 计入，晚 1ms 排除（严格与代理同构）",
    events: [
      confirmed("i1", "2026-11-23T12:00:00.000Z", "edge-in"),
      confirmed("i2", "2026-11-23T12:00:00.001Z", "edge-out"),
      execution("2026-11-23T12:00:00.000Z"),
      execution("2026-11-23T12:00:00.001Z"),
    ],
    asOf: "2026-11-23T12:00:00.000Z",
    expected: {
      strict: { [ISO_W2]: [1, 1] },
      proxy: { [ISO_W2]: 1 },
    },
  },
  {
    name: "代理过滤：synthetic / 空 artifacts / 非 success 全部排除",
    events: [
      execution("2026-11-17T02:00:00Z", [{ name: "ok" }], { synthetic: true }),
      execution("2026-11-17T03:00:00Z", []),
      execution("2026-11-17T04:00:00Z", null),
      { ...execution("2026-11-17T05:00:00Z"), status: "failed" },
      execution("2026-11-18T06:00:00Z", [{ name: "good" }]),
    ],
    asOf: AS_OF,
    expected: {
      strict: {}, proxy: { [ISO_W1]: 1 },
    },
  },
  // ── R448 升主判据夹具：样本期 ≥4 周 AND 活跃 install 周合计 ≥20 ──
  {
    name: "升主达标：4 周 × 5 install = 20，两阈值均满足 ⇒ eligible",
    events: (() => {
      const out = [];
      ["2026-11-16", "2026-11-23", "2026-11-30", "2026-12-07"].forEach((d, wi) => {
        for (let i = 0; i < 5; i++) out.push(confirmed(`w${wi}-u${i}`, `${d}T10:00:00Z`, `p-${wi}-${i}`));
      });
      return out;
    })(),
    asOf: "2026-12-10T00:00:00Z",
    expected: {
      strict: {
        "2026-11-16T00:00:00.000Z": [5, 5], "2026-11-23T00:00:00.000Z": [5, 5],
        "2026-11-30T00:00:00.000Z": [5, 5], "2026-12-07T00:00:00.000Z": [5, 5],
      },
      promotion: { eligible: true },
    },
  },
  {
    name: "升主不达标（样本期）：3 周 × 5 install = 15，周数不足 4",
    events: (() => {
      const out = [];
      ["2026-11-16", "2026-11-23", "2026-11-30"].forEach((d, wi) => {
        for (let i = 0; i < 5; i++) out.push(confirmed(`w${wi}-u${i}`, `${d}T10:00:00Z`, `q-${wi}-${i}`));
      });
      return out;
    })(),
    asOf: "2026-12-03T00:00:00Z",
    expected: {
      strict: {
        "2026-11-16T00:00:00.000Z": [5, 5], "2026-11-23T00:00:00.000Z": [5, 5],
        "2026-11-30T00:00:00.000Z": [5, 5],
      },
      promotion: { eligible: false, reasonsIncludes: ["样本期 3 周 < 4 周"] },
    },
  },
  {
    name: "升主不达标（sample_size）：4 周 × 4 install = 16，活跃 install 不足 20",
    events: (() => {
      const out = [];
      ["2026-11-16", "2026-11-23", "2026-11-30", "2026-12-07"].forEach((d, wi) => {
        for (let i = 0; i < 4; i++) out.push(confirmed(`r${wi}-u${i}`, `${d}T10:00:00Z`, `r-${wi}-${i}`));
      });
      return out;
    })(),
    asOf: "2026-12-10T00:00:00Z",
    expected: {
      strict: {
        "2026-11-16T00:00:00.000Z": [4, 4], "2026-11-23T00:00:00.000Z": [4, 4],
        "2026-11-30T00:00:00.000Z": [4, 4], "2026-12-07T00:00:00.000Z": [4, 4],
      },
      promotion: { eligible: false, reasonsIncludes: ["活跃 install 周合计 16 < 20"] },
    },
  },
  {
    name: "警告常驻断言：代理警告不可被省略",
    assertionOnly: true,
    expected: { warnings: [STRICT_CALIBER_WARNING, PROXY_CALIBER_WARNING] },
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
      const payload = computeWeekly([], AS_OF);
      const ok = f.expected.warnings.every((w) => payload.warnings.includes(w));
      console.log(`  ${ok ? "✓" : "✘"} ${f.name}`);
      if (!ok) problems.push(`    ${f.name}：警告缺项 ${JSON.stringify(payload.warnings)}`);
      continue;
    }
    const got = computeWeekly(f.events, f.asOf);
    const bad = [];
    const expStrict = f.expected.strict ?? {};
    const expProxy = f.expected.proxy ?? {};
    const gotStrict = Object.fromEntries(
      got.business_confirmed.weeks.map((w) => [w.week_start, [w.active_installs, w.confirmed_events]]),
    );
    const gotProxy = Object.fromEntries(
      got.business_results_proxy.weeks.map((w) => [w.week_start, w.executions]),
    );
    for (const k of new Set([...Object.keys(expStrict), ...Object.keys(gotStrict)])) {
      if (!near(JSON.stringify(gotStrict[k] ?? null), JSON.stringify(expStrict[k] ?? null))) {
        bad.push(`严格 ${k}: 期望 ${JSON.stringify(expStrict[k] ?? null)} 实得 ${JSON.stringify(gotStrict[k] ?? null)}`);
      }
    }
    for (const k of new Set([...Object.keys(expProxy), ...Object.keys(gotProxy)])) {
      if (!near(gotProxy[k] ?? null, expProxy[k] ?? null)) {
        bad.push(`代理 ${k}: 期望 ${expProxy[k] ?? null} 实得 ${gotProxy[k] ?? null}`);
      }
    }
    if (f.expected.warnings && !f.expected.warnings.every((w) => got.warnings.includes(w))) {
      bad.push(`警告缺项：${JSON.stringify(got.warnings)}`);
    }
    if (got.warnings.includes(PROXY_CALIBER_WARNING) === false) {
      bad.push("代理警告缺失（强制标注）");
    }
    // R448：可选升主判据断言——既有夹具无此字段则跳过，零破坏。
    if (f.expected.promotion) {
      const pe = got.promotionEligibility;
      const exp = f.expected.promotion;
      if (pe.eligible !== exp.eligible) {
        bad.push(`升主 eligible: 期望 ${exp.eligible} 实得 ${pe.eligible}`);
      }
      if (exp.reasonsIncludes && !exp.reasonsIncludes.every((s) => pe.reasons.some((r) => r.includes(s)))) {
        bad.push(`升主 reasons 缺项：期望含 ${JSON.stringify(exp.reasonsIncludes)} 实得 ${JSON.stringify(pe.reasons)}`);
      }
    }
    const ok = bad.length === 0;
    console.log(`  ${ok ? "✓" : "✘"} ${f.name}`);
    if (!ok) problems.push(`    ${f.name}：${bad.join("；")}`);
  }
  const n = FIXTURES.length;
  const ok = problems.length === 0;
  console.log(`\nSELFTEST ${n - problems.length}/${n} 通过（夹具数 ${n}）` + (ok ? "（全部符合预期）" : "（有夹具不通过）"));
  if (!ok) for (const p of problems) console.log(p);
  return ok ? 0 : 1;
}

/* ── --report（真实 PG，只读）─────────────────────────────────────────── */

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
       AND table_name IN ('funnel_events', 'task_executions')`,
  );
  const found = new Set(res.rows.map((r) => r.table_name));
  return { funnelEvents: found.has("funnel_events"), taskExecutions: found.has("task_executions") };
}

function isoWeek(v) {
  const t = v instanceof Date ? v.getTime() : Date.parse(v);
  if (!Number.isFinite(t)) throw new StructuralError(`SQL 返回非法 week_start：${String(v)}`);
  return new Date(t).toISOString();
}

function emitSkip(opts, missing) {
  console.log(SKIP_MESSAGE);
  if (opts.json) {
    console.log(JSON.stringify({ status: "SKIP", message: SKIP_MESSAGE, missing_tables: missing }, null, 2));
  }
}

function emitResult(opts, payload, target) {
  if (opts.json) {
    console.log(JSON.stringify({ status: "OK", ...payload }, null, 2));
    return;
  }
  console.log("=== 北极星周指标（只读）===");
  console.log(`观测截止：${payload.as_of}${opts.asOf ? "（--as-of）" : "（now）"}`);
  console.log(`数据源：${maskTarget(target)}`);
  console.log("--- 严格值 business_confirmed（北极星）---");
  for (const w of payload.business_confirmed.weeks) {
    console.log(`${w.week_start}: active_installs=${w.active_installs}, confirmed_events=${w.confirmed_events}`);
  }
  console.log(`严格合计：active_install_weeks=${payload.business_confirmed.totals.active_install_weeks}, confirmed_events=${payload.business_confirmed.totals.confirmed_events}`);
  console.log("--- 代理值 business_results_proxy（过渡期并列，勿混算）---");
  for (const w of payload.business_results_proxy.weeks) {
    console.log(`${w.week_start}: executions=${w.executions}`);
  }
  console.log(`代理合计：executions=${payload.business_results_proxy.totals.executions}`);
  console.log(payload.warnings[0]);
  console.log(payload.warnings[1]);
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
    if (!present.funnelEvents || !present.taskExecutions) {
      const missing = [
        !present.funnelEvents ? "funnel_events" : null,
        !present.taskExecutions ? "task_executions" : null,
      ].filter(Boolean);
      emitSkip(opts, missing);
      return 0;
    }
    const strictSql = BUSINESS_CONFIRMED_SQL.replace(":as_of", "$1").trim().replace(/;$/, "");
    const proxySql = BUSINESS_RESULTS_PROXY_SQL.replace(":as_of", "$1").trim().replace(/;$/, "");
    // READ ONLY 事务内钉 UTC session 只服务 strict 的 timestamptz（ts）周桶：
    // 对 ts 禁止 AT TIME ZONE 'UTC'（会把 timestamptz 转 naive，反引入本地 TZ 依赖）。
    // proxy 的 endTime 是 timestamp WITHOUT time zone，方向相反——靠 SQL 主体
    // 的 AT TIME ZONE 'UTC' 把 naive 显式解释成 UTC 再 date_trunc，跨 TZ 才与 strict 对齐。
    await client.query("BEGIN READ ONLY");
    let committed = false;
    try {
      await client.query(UTC_PIN_SQL);
      const strictRows = (await client.query(strictSql, [asOf])).rows;
      const proxyRows = (await client.query(proxySql, [asOf])).rows;
      const strictWeeks = strictRows.map((r) => ({
        week_start: isoWeek(r.week_start),
        active_installs: Number(r.active_installs ?? 0),
        confirmed_events: Number(r.confirmed_events ?? 0),
      }));
      const proxyWeeks = proxyRows.map((r) => ({
        week_start: isoWeek(r.week_start),
        executions: Number(r.business_results_proxy ?? 0),
      }));
      await client.query("COMMIT");
      committed = true;
      emitResult(opts, buildPayload(strictWeeks, proxyWeeks, asOf), target);
      return 0;
    } finally {
      if (!committed) await client.query("ROLLBACK").catch(() => {});
    }
  } catch (err) {
    if (err instanceof StructuralError) throw err;
    console.error(`✘ 结构错误（SQL/表列不匹配）：${err.message}`);
    return 2;
  } finally {
    await client.end().catch(() => {});
  }
}

/* ── CLI ──────────────────────────────────────────────────────────────── */

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
  node scripts/north-star-weekly.mjs --selftest
  node scripts/north-star-weekly.mjs --report [--dsn DSN | --dsn=DSN] [--as-of ISO] [--json]
说明：
  严格值 business_confirmed = 每周 COUNT(DISTINCT install_id) + 确认事件数（dedupe_key 幂等）
  代理值 business_results_proxy = SUCCESS 且 artifacts 非空的执行数（周取 endTime）
  ⚠️ 有产物/有证据 ≠ 被业务确认，代理值勿当严格值；两条口径分字段输出、绝不混算
  --dsn            连接串；否则 DATABASE_URL > DB_HOST/DB_PORT/DB_USERNAME/DB_PASSWORD/DB_DATABASE
                     无连接参数 ⇒ 打印 SKIP 并 exit 0（不尝试连库）
  --as-of          观测截止 ISO（默认 now）；事件 ts/endTime <= as_of 才计入
  --json           机器可读输出（含 status / warnings）；SKIP 也会输出
  --help / -h      显示本帮助
  NORTH_STAR_DOC_PATH  漂移哨针用的文档副本路径（默认 docs/plan/north-star-business-confirmed.md）
退出码：0 跑完（含缺表 SKIP / 无连接参数 SKIP） / 1 selftest 夹具失败 /
        2 结构错误（漂移哨针红 / DSN 非法 / SQL 列不匹配） / 3 连不上库`;

export async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) { console.log(HELP); return 0; }
  if (opts.bad || (!opts.selftest && !opts.report)) {
    console.log(HELP);
    return opts.bad ? 2 : 0;
  }
  try {
    const { docTokens, proxyInvariants, utcPin } = checkDrift();
    if (opts.selftest) {
      console.log(`漂移哨针：§5 SQL 全串逐字相等 ✓；基础 token ${docTokens.length}/${docTokens.length} ✓；代理约束 ${proxyInvariants.length}/${proxyInvariants.length} ✓；时区钉死 ${utcPin} ✓`);
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
