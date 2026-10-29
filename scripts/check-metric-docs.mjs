#!/usr/bin/env node
/**
 * DOC-GUARD：**文档指标名 ↔ 运行时指标注册表** 自动比对守卫。
 *
 * ## 为什么需要它
 *
 * 设计文档里承诺的指标名会与代码注册表漂移，而且**两向都会漂**，全都不报错、
 * 不影响构建，只能靠人读出来：
 *
 *   ① 文档写了**注册表里不存在**的指标名 → 抄着配告警/看板的人得到静默空图
 *      （`absent()` 与 `== 0` 语义相反，人在值班时才会发现指标是黑的）。
 *      本仓已发生过（`docs/AGENT_SWARM-PLAYBOOK.md` §7 的 `doc-guard` backlog 行）：
 *      设计文档曾列出三个从未实现的 agent 指标，以及一处「指标 help 写着令牌量、
 *      实际记步数」——后者正是本守卫的姊妹判据（help/标签与埋点值的一致性由
 *      `agent-metrics-labels.spec.ts` 钉住，本守卫只钉**名字的存在性**）。
 *   ② 注册表里加了指标、**文档一个字都没提** → 新指标等于对运维不存在：没人知道
 *      该看它、该配什么告警、标签是什么。这条不可能一次要求补全所有文档（存量欠账
 *      真实存在），故与 `check-user-facing-language.mjs` / `check-conditional-writes.mjs`
 *      同款**基线棘轮**：存量欠账显式登记，**只减不增**。
 *
 * ## 事实源（两个文件，缺一即红）
 *
 *   · `apps/admin-api/src/modules/metrics/runtime-metrics.ts`（**主源**）
 *       `RuntimeCounterName` 联合类型 + `RUNTIME_COUNTERS` 对象字面量的键
 *       `RuntimeGaugeName` 联合类型 + `RUNTIME_GAUGES` 对象字面量的键
 *     两条解析路径**互为校验**：联合里有、对象里没有（或反之）本身就是注册表内部
 *     漂移，直接红——比 `tsc` 更早暴露（`Record<Union, Spec>` 只保证对象不缺键，
 *     不保证对象没有联合之外的多余键）。
 *   · `apps/admin-api/src/modules/metrics/prometheus-metrics.service.ts`（同源面）
 *       手写 `name: "autoflow_..."` 字面量（scheduler / queue / db_pool / http /
 *       executors 等既有一大批指标，`/api/metrics` 的实际暴露面）。
 *     为什么必须一起算：这两个文件就是 `check-alerts-rules.mjs` 的同一个
 *     `METRIC_SOURCES` 口径；只算 runtime-metrics.ts 会把文档里**真实存在**的
 *     二十来个指标判成"臆造"，守卫立刻变成噪音机（噪音守卫 = 没人看的守卫）。
 *
 * 判据（四类，全部有齿）：
 *   A. 未知名字：文档里出现 `autoflow_[a-z0-9_]+` 形态的 token，既不在注册表、
 *      也不在 allowlist → **红**，逐条打印 `文件:行号 → 名字` + 修法。
 *   B. 新增未文档化：注册表里有、扫描面内**从未提及**、基线也没登记 → **红**
 *      （棘轮：新增欠账必须显式登记，不许静默长出来）。
 *   C. 基线陈旧：基线登记了、但如今**已不该在基线里**（文档已补 / 指标已删）
 *      → **红**（反向判据，与 `check-user-facing-language.mjs` 的陈旧检查同款：
 *      补了文档不删基线 = 基线成了永久免死金牌）。
 *   D. 自失效：注册表解析不到 / 解析结果低于规模下界 / 基线或 allowlist 读不了或
 *      条目缺理由 → **红**。守卫的自身失效必须是红的（否则"改了文件 → 解析空 →
 *      零发现 → 绿"是最坏的假绿）。
 *
 * ## 什么不算违规（刻意的豁免面）
 *
 *   · **前缀引用**：以 `_` 结尾、且是某个注册表指标的前缀（如
 *     `autoflow_scheduler_*`、`autoflow_db_pool_*`）——这是文档在指"这一族"，
 *     不是臆造。反向不成立：`autoflow_sse_ticket_rejected`（漏 `_total`）**不是**
 *     任何指标的前缀，属于 A 类真缺陷。
 *   · **allowlist**（`scripts/metric-docs-allowlist.json`，每条必须带 `reason`）：
 *       `external`   外部系统/基础设施暴露的指标（写进文档但本仓不注册）；
 *       `non-metric` 同形的非指标标识（SDK 包名 / 数据库名 / 卷名 / localStorage 键）；
 *       `anchor`     文档锚点（runbook 章节名按**告警名**命名，不是指标名）。
 *     allowlist **只收这三类**：把"注册表里该有却没有"的指标放进来是蒙混，
 *     那种情况要么补注册、要么改文档。条目一旦不再被任何文档引用也算陈旧 → 红。
 *   · **行内豁免**：`<!-- metric-docs:ignore-unknown 理由 -->`。作用域刻意收窄：
 *     与 token 同行 → 只豁免本行；独占一行 → 从下一行起豁免到下一个空行（段落块），
 *     避免"一个标记盖掉整节"。只为「明示该指标从未实现/尚未实现」的反例与提案保留
 *     ——直接把名字删掉会让"别再加这三个名字"这条经验消失。理由**必填**，
 *     且被豁免的每一处都会在 `--report` 里列出来（豁免必须可见，不能变成暗门）。
 *
 * ## 扫描面
 *
 *   `docs/**​/*.md`，**排除 `docs/archive/**`**——历史文档/事故报告是"当时的事实"，
 * 要求它们随注册表同步等于改写历史（本仓 archive 里确有 4 处旧锚点、3 处旧实现名）。
 *
 * ## 用法
 *   node scripts/check-metric-docs.mjs             # 守卫（CI 与 test:guards:repo）
 *   node scripts/check-metric-docs.mjs --report    # 打印当前未文档化清单（供后人补文档）
 *   node scripts/check-metric-docs.mjs --update    # 重写基线（补完文档后收紧棘轮）
 *   node scripts/check-metric-docs.mjs --selftest  # 验证判据本身（15 条，断言退出码+报错文本）
 *   node scripts/check-metric-docs.mjs --root <dir># 只给 selftest 用：在任意临时树上跑
 *
 * 纯静态读文件，零依赖、无 DB/网络，秒级。
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

const SELF = import.meta.filename;
const DEFAULT_ROOT = resolve(import.meta.dirname, "..");

// ── 事实源与文件约定 ────────────────────────────────────────────────────────
const COUNTERS_SOURCE = "apps/admin-api/src/modules/metrics/runtime-metrics.ts";
const SERVICE_SOURCE =
  "apps/admin-api/src/modules/metrics/prometheus-metrics.service.ts";
/**
 * 告警名的事实源（`- alert: NAME`）。
 *
 * 为什么必须把它们排除在「未知指标名」之外：告警与指标共用同一个
 * `autoflow_` 前缀，文档里的 runbook 索引天然会写告警名（`autoflow_queue_backlog`
 * 是告警，不是指标）。不排除的后果是「写 runbook 就必须给每条告警编一个假指标
 * 名」，或者往 allowlist 里堆 26 条噪声——前者逼人写错，后者让豁免面失效。
 * 判据因此变成：`autoflow_*` 要么是已注册指标、要么是**已存在的告警名**，否则才算未知。
 */
const ALERT_SOURCES = [
  "config/monitoring/alerts.yml",
  "docs/observability/alerting-rules.yml",
];
const DOCS_DIR = "docs";
/** archive 是历史事实，不参与同步要求（见头注「扫描面」）。 */
const EXCLUDED_DOC_PREFIXES = ["docs/archive/"];
const BASELINE_REL = "scripts/metric-docs-baseline.json";
const ALLOWLIST_REL = "scripts/metric-docs-allowlist.json";

const METRIC_TOKEN_RE = /autoflow_[a-z0-9_]+/g;
/** 行内豁免标记；理由必填，作用域为本段（见头注）。 */
const IGNORE_MARKER = "metric-docs:ignore-unknown";
const ALLOWLIST_KINDS = new Set(["external", "non-metric", "anchor"]);

/**
 * 规模下界：注册表被改名/拆分/清空时，「解析成功但集合空转」会让守卫零发现而
 * 全绿——这是本仓反复出现的假绿形态（`check-alerts-rules.mjs` 的探针、
 * `check-guards-wired.mjs` 的 `guards.length < 20` 都是同一个教训）。
 * 真实规模：counter 14 / gauge 4 / service 23（2026-10-29）。
 */
const FLOORS = { counters: 5, gauges: 2, service: 5, total: 15 };

// ── 注册表解析（纯正则，不做 TS 编译：CI 的守卫 job 刻意不装依赖）──────────
function unionMembers(text, typeName) {
  const match = text.match(
    new RegExp(`export\\s+type\\s+${typeName}\\s*=([\\s\\S]*?);`),
  );
  if (!match) return null;
  const names = new Set(
    [...match[1].matchAll(/"([^"]+)"/g)]
      .map((m) => m[1])
      .filter((n) => /^autoflow_[a-z0-9_]+$/.test(n)),
  );
  return names.size > 0 ? names : null;
}

function objectKeys(text, constName) {
  const start = text.search(new RegExp(`export\\s+const\\s+${constName}\\b`));
  if (start < 0) return null;
  const rest = text.slice(start);
  // 对象字面量以顶格缩进 + `};` 收尾（块内的语句一律以 `,` 结尾，不会误判）。
  const end = rest.match(/\n[ \t]*\};/);
  if (!end) return null;
  const body = rest.slice(0, end.index + end[0].length);
  // 只取顶层键：块内的 help/labelNames/labelValueSets 等键不以 autoflow_ 开头。
  const keys = new Set(
    [...body.matchAll(/^[ \t]+(autoflow_[a-z0-9_]+)[ \t]*:\s*\{/gm)].map(
      (m) => m[1],
    ),
  );
  return keys.size > 0 ? keys : null;
}

/**
 * 解析主源：must 拿到 counters（联合 + 对象两条路径且互相一致）与 gauges。
 * 任何一步拿不到 → errors（调用方负责判红），绝不返回"空集合但成功"。
 */
export function parseRuntimeRegistry(text) {
  const errors = [];
  const counterUnion = unionMembers(text, "RuntimeCounterName");
  const counterObject = objectKeys(text, "RUNTIME_COUNTERS");
  const gaugeUnion = unionMembers(text, "RuntimeGaugeName");
  const gaugeObject = objectKeys(text, "RUNTIME_GAUGES");

  if (!counterUnion)
    errors.push("找不到 `export type RuntimeCounterName = …` 联合类型（或其中没有 autoflow_ 字面量）");
  if (!counterObject)
    errors.push("找不到 `export const RUNTIME_COUNTERS = { … }` 对象字面量（或没有 autoflow_ 顶层键）");
  if (!gaugeUnion)
    errors.push("找不到 `export type RuntimeGaugeName = …` 联合类型（或其中没有 autoflow_ 字面量）");
  if (!gaugeObject)
    errors.push("找不到 `export const RUNTIME_GAUGES = { … }` 对象字面量（或没有 autoflow_ 顶层键）");

  // 联合 ↔ 对象互校：两种写法是同一份声明，任何一侧漏改都是注册表内部漂移。
  for (const [label, union, object] of [
    ["RuntimeCounterName ↔ RUNTIME_COUNTERS", counterUnion, counterObject],
    ["RuntimeGaugeName ↔ RUNTIME_GAUGES", gaugeUnion, gaugeObject],
  ]) {
    if (!union || !object) continue;
    const onlyUnion = [...union].filter((n) => !object.has(n));
    const onlyObject = [...object].filter((n) => !union.has(n));
    if (onlyUnion.length > 0)
      errors.push(`${label}：联合类型里有、对象字面量里没有 → ${onlyUnion.join(", ")}`);
    if (onlyObject.length > 0)
      errors.push(`${label}：对象字面量里有、联合类型里没有 → ${onlyObject.join(", ")}`);
  }

  const counters = new Set([...(counterUnion ?? []), ...(counterObject ?? [])]);
  const gauges = new Set([...(gaugeUnion ?? []), ...(gaugeObject ?? [])]);
  if (counters.size < FLOORS.counters)
    errors.push(`counter 只解析到 ${counters.size} 个（下界 ${FLOORS.counters}）——注册表被拆分/改名了？`);
  if (gauges.size < FLOORS.gauges)
    errors.push(`gauge 只解析到 ${gauges.size} 个（下界 ${FLOORS.gauges}）——注册表被拆分/改名了？`);
  return { counters, gauges, errors };
}

/** 解析同源面：prometheus-metrics.service.ts 的 `name: "autoflow_…"` 字面量。 */
export function parseServiceRegistry(text) {
  const names = new Set(
    [...text.matchAll(/\bname:\s*"([^"]+)"/g)]
      .map((m) => m[1])
      .filter((n) => /^autoflow_[a-z0-9_]+$/.test(n)),
  );
  const errors = [];
  if (names.size < FLOORS.service)
    errors.push(
      `prometheus-metrics.service.ts 只解析到 ${names.size} 个 \`name: "autoflow_…"\`（下界 ${FLOORS.service}）`,
    );
  return { names, errors };
}

/**
 * 解析告警名（`- alert: NAME` / `alert: NAME`）。
 *
 * 只认显式 `alert:` 键：正文里提到一个既非指标又非告警的 `autoflow_*` 仍要红，
 * 否则「名字随便写」就被这条豁免放行了。
 */
export function parseAlertNames(text) {
  const names = new Set();
  for (const m of text.matchAll(/^[ \t]*(?:-[ \t]*)?alert:[ \t]*["']?([A-Za-z_][A-Za-z0-9_]*)["']?[ \t]*$/gm)) {
    // 告警名惯例大写（AUTOFLOW_QUEUE_BACKLOG），而 runbook 锚点是它的
    // 小写 slug——两侧统一小写比较，否则文档写锚点就必然判红。
    names.add(m[1].toLowerCase());
  }
  return names;
}

// ── 文档扫描 ────────────────────────────────────────────────────────────────
function listDocFiles(root, dirRel = DOCS_DIR) {
  const abs = join(root, dirRel);
  const out = [];
  const walk = (rel) => {
    let entries;
    try {
      entries = readdirSync(join(root, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const childRel = `${rel}/${entry.name}`;
      if (entry.isDirectory()) {
        if (EXCLUDED_DOC_PREFIXES.some((p) => `${childRel}/`.startsWith(p))) continue;
        walk(childRel);
      } else if (/\.md$/i.test(entry.name)) {
        if (EXCLUDED_DOC_PREFIXES.some((p) => childRel.startsWith(p))) continue;
        out.push(childRel);
      }
    }
  };
  walk(dirRel);
  return out.sort();
}

/**
 * 逐文件扫 token。返回：
 *   hits        [{file,line,token}]               全部 autoflow_ token（去重前的原文位置）
 *   markers     [{file,line,reason}]              行内豁免标记（reason 为空串 = 缺理由）
 *   suppressed  [{file,line,token,reason}]        被行内豁免放过的未知名字
 *   unreadable  [rel]                             读不了的文件
 */
export function scanDocs(root) {
  const files = listDocFiles(root);
  const hits = [];
  const markers = [];
  const suppressed = [];
  const unreadable = [];
  if (files.length === 0) return { files, hits, markers, suppressed, unreadable };

  for (const rel of files) {
    let text;
    try {
      text = readFileSync(join(root, rel), "utf8");
    } catch {
      unreadable.push(rel);
      continue;
    }
    const lines = text.split(/\r?\n/);
    // 豁免作用域（刻意收窄，防"一个标记盖掉整节"）：
    //   · 标记与 token 同一行 → 只豁免本行；
    //   · 标记独占一行（该行没有 token）→ 从下一行起豁免到下一个空行（段落块）。
    let blockReason = null;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (/^\s*$/.test(line)) {
        blockReason = null;
        continue;
      }
      const tokens = [...line.matchAll(METRIC_TOKEN_RE)].map((m) => m[0]);
      const markerAt = line.indexOf(IGNORE_MARKER);
      let lineReason = null;
      if (markerAt >= 0) {
        lineReason = line
          .slice(markerAt + IGNORE_MARKER.length)
          .replace(/^\s*[:：]?\s*/, "")
          .replace(/-->.*$/, "")
          .trim();
        markers.push({ file: rel, line: i + 1, reason: lineReason });
      }
      for (const token of tokens) hits.push({ file: rel, line: i + 1, token });

      if (markerAt >= 0 && tokens.length > 0) {
        for (const token of tokens)
          suppressed.push({ file: rel, line: i + 1, token, reason: lineReason });
      } else if (markerAt >= 0) {
        blockReason = lineReason; // 标记独占一行：开启段落块
      } else if (blockReason !== null) {
        for (const token of tokens)
          suppressed.push({ file: rel, line: i + 1, token, reason: blockReason });
      }
    }
  }
  return { files, hits, markers, suppressed, unreadable };
}

// ── 基线 / allowlist 装载 ───────────────────────────────────────────────────
function readJson(root, rel) {
  const abs = join(root, rel);
  if (!existsSync(abs)) return { missing: true };
  try {
    return { value: JSON.parse(readFileSync(abs, "utf8")) };
  } catch (err) {
    return { error: `JSON 解析失败：${err.message}` };
  }
}

export function loadBaseline(root) {
  const errors = [];
  const { value, missing, error } = readJson(root, BASELINE_REL);
  if (missing) {
    errors.push(
      `${BASELINE_REL} 不存在——首次落地请用 \`--update\` 生成（守卫不接受"没有基线"这种静默放行）`,
    );
    return { names: new Set(), errors, missing: true };
  }
  if (error) {
    errors.push(`${BASELINE_REL} ${error}`);
    return { names: new Set(), errors };
  }
  const list = value?.undocumented;
  if (!Array.isArray(list)) {
    errors.push(`${BASELINE_REL} 缺少 \`undocumented\` 数组`);
    return { names: new Set(), errors };
  }
  for (const entry of list) {
    if (typeof entry !== "string" || !/^autoflow_[a-z0-9_]+$/.test(entry))
      errors.push(`${BASELINE_REL} 的 undocumented 里有非法条目：${JSON.stringify(entry)}`);
  }
  return { names: new Set(list.filter((n) => typeof n === "string")), errors };
}

export function loadAllowlist(root) {
  const errors = [];
  const entries = new Map();
  const { value, missing, error } = readJson(root, ALLOWLIST_REL);
  if (missing) {
    errors.push(
      `${ALLOWLIST_REL} 不存在——allowlist 是显式豁免面（每条必须带理由），缺少它守卫不工作`,
    );
    return { entries, errors };
  }
  if (error) {
    errors.push(`${ALLOWLIST_REL} ${error}`);
    return { entries, errors };
  }
  if (!Array.isArray(value?.entries)) {
    errors.push(`${ALLOWLIST_REL} 缺少 \`entries\` 数组`);
    return { entries, errors };
  }
  for (const entry of value.entries) {
    const name = entry?.name;
    if (typeof name !== "string" || !/^autoflow_[a-z0-9_]+$/.test(name)) {
      errors.push(`${ALLOWLIST_REL} 条目缺少合法 name：${JSON.stringify(entry)}`);
      continue;
    }
    if (entries.has(name)) {
      errors.push(`${ALLOWLIST_REL} 条目重复：${name}`);
      continue;
    }
    if (!ALLOWLIST_KINDS.has(entry.kind)) {
      errors.push(
        `${ALLOWLIST_REL} 条目 ${name} 的 kind=${JSON.stringify(entry.kind)} 非法（只能是 ${[...ALLOWLIST_KINDS].join(" / ")}）`,
      );
      continue;
    }
    const reason = typeof entry.reason === "string" ? entry.reason.trim() : "";
    if (reason.length < 6) {
      errors.push(`${ALLOWLIST_REL} 条目 ${name} **缺少 reason**（豁免必须写明为什么它不是本仓指标）`);
      continue;
    }
    entries.set(name, { kind: entry.kind, reason });
  }
  return { entries, errors };
}

// ── 核心判定 ────────────────────────────────────────────────────────────────
/**
 * 返回一份**纯数据**判定结果：main 负责打印与退出码，selftest 直接复用。
 * 关键：任何 configErrors 都会让 exitCode=1（自失效不许静默通过）。
 */
export function analyze(root, options = {}) {
  const configErrors = [];

  const readSource = (rel) => {
    try {
      return readFileSync(join(root, rel), "utf8");
    } catch (err) {
      configErrors.push(`${rel} 不可读（${err.code ?? err.message}）——事实源被挪动/改名了？`);
      return null;
    }
  };

  const countersText = readSource(COUNTERS_SOURCE);
  const serviceText = readSource(SERVICE_SOURCE);
  let counters = new Set();
  let gauges = new Set();
  let serviceNames = new Set();
  if (countersText !== null) {
    const parsed = parseRuntimeRegistry(countersText);
    counters = parsed.counters;
    gauges = parsed.gauges;
    configErrors.push(...parsed.errors.map((e) => `${COUNTERS_SOURCE}: ${e}`));
  }
  if (serviceText !== null) {
    const parsed = parseServiceRegistry(serviceText);
    serviceNames = parsed.names;
    configErrors.push(...parsed.errors.map((e) => `${SERVICE_SOURCE}: ${e}`));
  }

  const registry = new Set([...counters, ...gauges, ...serviceNames]);
  if (registry.size < FLOORS.total)
    configErrors.push(
      `注册表合计只解析到 ${registry.size} 个指标（下界 ${FLOORS.total}）——事实源改结构后本守卫会静默失效，故直接红`,
    );

  // 告警名：文件不存在不是错（fixture 可以没有告警面），存在但读不了才是错。
  const alertNames = new Set();
  for (const rel of ALERT_SOURCES) {
    let text;
    try {
      text = readFileSync(join(root, rel), "utf8");
    } catch (err) {
      if (err.code !== "ENOENT")
        configErrors.push(`${rel} 不可读（${err.code ?? err.message}）——告警名没装载，runbook 会被误判成未知指标`);
      continue;
    }
    for (const name of parseAlertNames(text)) alertNames.add(name);
  }

  const baseline = loadBaseline(root);
  // `--update` 正要**创建**基线：只有"基线缺失"这一项可以放过，其余配置错误照旧阻断。
  if (!(options.allowMissingBaseline && baseline.missing))
    configErrors.push(...baseline.errors);
  const allowlist = loadAllowlist(root);
  configErrors.push(...allowlist.errors);

  const docs = scanDocs(root);
  if (docs.files.length === 0)
    configErrors.push(`docs/**/*.md 一个文件都没扫到（${DOCS_DIR}/ 存在吗？扫描面失效同样是红）`);
  for (const rel of docs.unreadable) configErrors.push(`${rel} 不可读`);

  // ① 逐 token 分类
  const documented = new Set();
  const allowlisted = []; // {file,line,token,kind,reason}
  const prefixRefs = [];
  const alertRefs = []; // 文档里引用的告警名（非指标，放行但计数）
  const unknown = [];
  const suppressed = [];
  const allowlistHits = new Map(); // allowlist 名 → 命中次数

  for (const hit of docs.hits) {
    const { token } = hit;
    if (registry.has(token)) {
      documented.add(token);
      continue;
    }
    // 告警名与指标共用 `autoflow_` 前缀：runbook 索引写告警名不是「配了个空指标」。
    if (alertNames.has(token.toLowerCase())) {
      alertRefs.push({ ...hit });
      continue;
    }
    const allow = allowlist.entries.get(token);
    if (allow) {
      allowlisted.push({ ...hit, ...allow });
      allowlistHits.set(token, (allowlistHits.get(token) ?? 0) + 1);
      continue;
    }
    // 前缀引用：`autoflow_scheduler_` 这类"指一族"的写法（以 _ 结尾且是真实前缀）。
    if (token.endsWith("_") && [...registry].some((n) => n.startsWith(token))) {
      prefixRefs.push({ ...hit });
      continue;
    }
    const suppressedHit = docs.suppressed.find(
      (s) => s.file === hit.file && s.line === hit.line && s.token === token && s.reason,
    );
    if (suppressedHit) {
      suppressed.push({ ...hit, reason: suppressedHit.reason });
      continue;
    }
    unknown.push(hit);
  }

  // 行内豁免的理由是硬要求：空理由等于暗门。
  for (const marker of docs.markers) {
    if (!marker.reason)
      configErrors.push(
        `${marker.file}:${marker.line} 的 \`${IGNORE_MARKER}\` **缺少理由**——豁免必须写明"为什么这不是缺陷"`,
      );
  }

  // ② 基线棘轮（双向）
  const undocumented = [...registry].filter((n) => !documented.has(n)).sort();
  const baselineAdded = undocumented.filter((n) => !baseline.names.has(n));
  const baselineStale = [...baseline.names]
    .filter((n) => !undocumented.includes(n))
    .sort()
    .map((name) => ({
      name,
      why: registry.has(name)
        ? "文档已提及该指标 → 从基线删除这个条目（棘轮收紧）"
        : "注册表里已无此指标 → 从基线删除这个条目",
    }));

  // ③ allowlist 陈旧（豁免也只会过期，不会自动消失）
  const allowlistStale = [...allowlist.entries.entries()]
    .filter(([name]) => !allowlistHits.has(name))
    .map(([name, meta]) => ({ name, ...meta }));

  const exitCode =
    configErrors.length > 0 ||
    unknown.length > 0 ||
    baselineAdded.length > 0 ||
    baselineStale.length > 0 ||
    allowlistStale.length > 0
      ? 1
      : 0;

  return {
    root,
    exitCode,
    configErrors,
    counts: {
      counters: counters.size,
      gauges: gauges.size,
      service: serviceNames.size,
      registry: registry.size,
      docsFiles: docs.files.length,
      documented: documented.size,
    },
    unknown,
    documented,
    allowlisted,
    allowlistHits,
    allowlistStale,
    prefixRefs,
    alertRefs,
    suppressed,
    markers: docs.markers,
    undocumented,
    baselineAdded,
    baselineStale,
  };
}

// ── 打印 ────────────────────────────────────────────────────────────────────
function printConfigErrors(errors) {
  if (errors.length === 0) return;
  console.error(`✗ 守卫自身失效（${errors.length} 项）——这不等于「文档没问题」：`);
  for (const err of errors) console.error(`  - ${err}`);
}

function printGate(result) {
  let failed = false;

  if (result.configErrors.length > 0) {
    printConfigErrors(result.configErrors);
    console.error(
      "  修法：先确认事实源/基线/allowlist 三个文件都在位。解析不到时**直接失败**是本守卫的",
    );
    console.error(
      "  刻意设计——「注册表改结构 → 解析出空集 → 零发现 → 绿」是最坏的假绿。",
    );
    failed = true;
  }

  if (result.unknown.length > 0) {
    console.error("");
    console.error(
      `✗ 文档引用了注册表里**不存在**的指标名 ${result.unknown.length} 处（配上去只会得到静默空图）：`,
    );
    for (const hit of result.unknown)
      console.error(`  · ${hit.file}:${hit.line} → ${hit.token}`);
    console.error(
      "  修法：要么改文档（改成事实源里真实存在的名字：runtime-metrics.ts 的 RUNTIME_COUNTERS /",
    );
    console.error(
      "  RUNTIME_GAUGES，或 prometheus-metrics.service.ts 的 name 字面量），要么注册该指标",
    );
    console.error(
      `  （RuntimeCounterName + RUNTIME_COUNTERS 两处同改）；若这里是「明示从未实现/尚未实现」`,
    );
    console.error(
      `  的反例或提案，请在本行或本段加 \`<!-- ${IGNORE_MARKER} 理由 -->\`（理由必填，--report 里会列出）。`,
    );
    failed = true;
  }

  if (result.baselineAdded.length > 0) {
    console.error("");
    console.error(
      `✗ 注册表里**新增了未文档化**的指标 ${result.baselineAdded.length} 个（棘轮：只能减，不能增）：`,
    );
    for (const name of result.baselineAdded) console.error(`  · ${name}`);
    console.error(
      "  修法：在 docs/observability/README.md 或 docs/operations.md 里写上它的含义/标签/该配什么告警；",
    );
    console.error(
      "  确认无误后跑 `node scripts/check-metric-docs.mjs --update` 收紧基线——**不要手改基线把自己加进去**。",
    );
    failed = true;
  }

  if (result.baselineStale.length > 0) {
    console.error("");
    console.error(
      `✗ 基线**陈旧** ${result.baselineStale.length} 条（棘轮只能收紧，不能留免死金牌）：`,
    );
    for (const stale of result.baselineStale)
      console.error(`  · ${stale.name} —— ${stale.why}`);
    console.error(
      `  修法：删掉 ${BASELINE_REL} 里对应条目（或直接 \`--update\` 重写）；基线只允许比现在更小。`,
    );
    failed = true;
  }

  if (result.allowlistStale.length > 0) {
    console.error("");
    console.error(
      `✗ allowlist 条目已无任何文档引用 ${result.allowlistStale.length} 条（豁免也要及时回收）：`,
    );
    for (const stale of result.allowlistStale)
      console.error(`  · ${stale.name}（${stale.kind}）—— ${stale.reason}`);
    console.error(`  修法：从 ${ALLOWLIST_REL} 删掉这些条目。allowlist 只收"外部/非指标"面，`);
    console.error("  它不该长期躺在那里当历史清单。");
    failed = true;
  }

  if (failed) {
    console.error("");
    console.error(
      `✗ 指标文档守卫失败。扫描面：${result.counts.docsFiles} 篇 markdown（排除 docs/archive/**）；` +
        `注册表 ${result.counts.registry} 个（counter ${result.counts.counters} / gauge ${result.counts.gauges} / service ${result.counts.service}）；` +
        `行内豁免 ${result.suppressed.length} 处。`,
    );
    return 1;
  }

  const byKind = { external: 0, "non-metric": 0, anchor: 0 };
  for (const hit of result.allowlisted) byKind[hit.kind] += 1;
  console.log(
    `✓ 指标文档守卫全绿：注册表 ${result.counts.registry} 个（counter ${result.counts.counters} / gauge ${result.counts.gauges} / service ${result.counts.service}）；` +
      `文档提及 ${result.counts.documented} 个；基线欠账 ${result.undocumented.length} 个（未增未减）；` +
      `allowlisted ${result.allowlisted.length} 处（external ${byKind.external} / 非指标标识 ${byKind["non-metric"]} / 锚点 ${byKind.anchor}）；` +
      `前缀引用 ${result.prefixRefs.length} 处；告警名引用 ${result.alertRefs.length} 处；行内豁免 ${result.suppressed.length} 处。`,
  );
  return 0;
}

function printReport(result) {
  printConfigErrors(result.configErrors);
  console.log("");
  console.log(
    `注册表 ${result.counts.registry} 个指标（counter ${result.counts.counters} / gauge ${result.counts.gauges} / service ${result.counts.service}）；` +
      `扫描 ${result.counts.docsFiles} 篇文档（排除 docs/archive/**）`,
  );

  console.log("");
  console.log(
    `未文档化的指标：${result.undocumented.length} 个` +
      (result.baselineAdded.length > 0
        ? `（其中 **${result.baselineAdded.length} 个未登记基线 → 会判红**）`
        : "（全部已在基线里，属已登记欠账）"),
  );
  if (result.undocumented.length === 0) {
    console.log("  （无——注册表里每个指标都能在文档里找到）");
  } else {
    for (const name of result.undocumented) {
      const badge = result.baselineAdded.includes(name) ? "未登记基线" : "基线已登记";
      console.log(`  · ${name}  [${badge}]`);
    }
    console.log(
      "  补文档的位置：docs/observability/README.md（暴露面 + runbook）、docs/operations.md（运维口径）、",
    );
    console.log(
      "  docs/design/**（设计承诺）。补完跑 `--update` 收紧基线，别手改 JSON 把自己加进去。",
    );
  }

  if (result.unknown.length > 0) {
    console.log("");
    console.log(`未知指标名（会判红）：${result.unknown.length} 处`);
    for (const hit of result.unknown)
      console.log(`  · ${hit.file}:${hit.line} → ${hit.token}`);
  }

  if (result.allowlisted.length > 0) {
    console.log("");
    console.log(`allowlist 命中：${result.allowlisted.length} 处`);
    const seen = new Set();
    for (const hit of result.allowlisted) {
      if (seen.has(hit.token)) continue;
      seen.add(hit.token);
      console.log(
        `  · ${hit.token}（${hit.kind}，${result.allowlistHits.get(hit.token)} 处）—— ${hit.reason}`,
      );
    }
  }

  if (result.allowlistStale.length > 0) {
    console.log("");
    console.log(`allowlist 里已无引用的条目（会判红）：${result.allowlistStale.length} 条`);
    for (const stale of result.allowlistStale)
      console.log(`  · ${stale.name}（${stale.kind}）`);
  }

  if (result.prefixRefs.length > 0) {
    console.log("");
    console.log(`前缀引用（合法）：${result.prefixRefs.length} 处`);
    const seen = new Set();
    for (const hit of result.prefixRefs) {
      if (seen.has(hit.token)) continue;
      seen.add(hit.token);
      console.log(`  · ${hit.file}:${hit.line} → ${hit.token}*`);
    }
  }

  if (result.suppressed.length > 0) {
    console.log("");
    console.log(`行内豁免（每处都必须有理由，豁免必须可见）：${result.suppressed.length} 处`);
    for (const hit of result.suppressed)
      console.log(`  · ${hit.file}:${hit.line} → ${hit.token} —— ${hit.reason}`);
  }

  if (result.baselineStale.length > 0) {
    console.log("");
    console.log(`基线陈旧条目（会判红）：${result.baselineStale.length} 条`);
    for (const stale of result.baselineStale)
      console.log(`  · ${stale.name} —— ${stale.why}`);
  }
  return result.configErrors.length > 0 ? 1 : 0;
}

// ── 基线写入 ────────────────────────────────────────────────────────────────
function writeBaseline(result) {
  const payload = {
    $comment:
      "DOC-GUARD 基线棘轮：`undocumented` = 注册表里有、docs/**/*.md（排除 docs/archive/**）从未提及的指标名。**只减不增**——" +
      "补好文档后从这里删掉（或跑 --update 重写）；新增未文档化指标会让 check-metric-docs 直接红。禁止手改把新指标塞进来。",
    undocumented: result.undocumented,
  };
  writeFileSync(
    join(result.root, BASELINE_REL),
    `${JSON.stringify(payload, null, 2)}\n`,
  );
  console.log(
    `基线已写入 ${BASELINE_REL}：${result.undocumented.length} 个未文档化指标（棘轮只允许比这更小）`,
  );
}

// ── selftest：临时目录里造最小树 + 子进程断言退出码与报错文本 ──────────────
const DEFAULT_COUNTERS = [
  "autoflow_demo_alpha_total",
  "autoflow_demo_beta_total",
  "autoflow_demo_gamma_total",
  "autoflow_demo_delta_total",
  "autoflow_demo_epsilon_total",
  "autoflow_demo_zeta_total",
];
const DEFAULT_GAUGES = ["autoflow_demo_level", "autoflow_demo_limit"];
const DEFAULT_SERVICE = Array.from(
  { length: 12 },
  (_, i) => `autoflow_demo_svc_${i}_total`,
);

function registryFixture(counters, gauges) {
  const union = counters.map((n) => `  | "${n}"`).join("\n");
  const body = counters
    .map(
      (n) =>
        `  ${n}: {\n    help: "demo counter",\n    labelNames: [],\n    labelValueSets: [{}],\n  },`,
    )
    .join("\n");
  const gaugeUnion = gauges.map((n) => `  | "${n}"`).join("\n");
  const gaugeBody = gauges
    .map((n) => `  ${n}: {\n    help: "demo gauge",\n  },`)
    .join("\n");
  return `// fixture：最小注册表（结构与真实 runtime-metrics.ts 一致）

export type RuntimeCounterName =
${union};

export const RUNTIME_COUNTERS: Record<RuntimeCounterName, RuntimeCounterSpec> =
  {
${body}
  };

export type RuntimeGaugeName =
${gaugeUnion};

export const RUNTIME_GAUGES: Record<RuntimeGaugeName, RuntimeGaugeSpec> = {
${gaugeBody}
};
`;
}

function serviceFixture(names) {
  return `// fixture：最小 name 字面量集合
export const DEMO_METRICS = [
${names
  .map((n) => `  {\n    name: "${n}",\n    help: "demo",\n  },`)
  .join("\n")}
];
`;
}

function docsListingAll(names) {
  return `# 指标清单\n\n${names.map((n) => `- \`${n}\``).join("\n")}\n`;
}

function buildTree(dir, options = {}) {
  const counters = options.counters ?? DEFAULT_COUNTERS;
  const gauges = options.gauges ?? DEFAULT_GAUGES;
  const service = options.service ?? DEFAULT_SERVICE;
  const docs = options.docs ?? {
    "docs/observability/README.md": docsListingAll([
      ...counters,
      ...gauges,
      ...service,
    ]),
  };
  const baseline = options.baseline ?? { undocumented: [] };
  const allowlist = options.allowlist ?? { entries: [] };

  mkdirSync(join(dir, dirname(COUNTERS_SOURCE)), { recursive: true });
  mkdirSync(join(dir, "scripts"), { recursive: true });
  writeFileSync(
    join(dir, COUNTERS_SOURCE),
    options.registryText ?? registryFixture(counters, gauges),
  );
  writeFileSync(
    join(dir, SERVICE_SOURCE),
    options.serviceText ?? serviceFixture(service),
  );
  // 告警面可选：不传 = 树里没有 alerts.yml（守卫按「没有告警事实源」处理）
  if (options.alerts !== undefined) {
    mkdirSync(join(dir, "config/monitoring"), { recursive: true });
    writeFileSync(
      join(dir, "config/monitoring/alerts.yml"),
      options.alerts
        .map((name) => `      - alert: ${name}\n        expr: up == 0\n`)
        .join(""),
    );
  }
  for (const [rel, content] of Object.entries(docs)) {
    mkdirSync(join(dir, dirname(rel)), { recursive: true });
    writeFileSync(join(dir, rel), content);
  }
  if (baseline !== null)
    writeFileSync(
      join(dir, BASELINE_REL),
      `${JSON.stringify({ $comment: "fixture", ...baseline }, null, 2)}\n`,
    );
  writeFileSync(
    join(dir, ALLOWLIST_REL),
    `${JSON.stringify({ $comment: "fixture", ...allowlist }, null, 2)}\n`,
  );
  return dir;
}

function slugify(name) {
  return name.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
}

/**
 * 15 条有齿用例。每条都断言 **退出码** 与 **关键报错文本**（不只是"不抛异常"）
 * ——只断言不抛的 selftest 会在判据整体失效时照样全绿。
 */
const SELFTEST_CASES = [
  {
    name: "干净树（注册表与文档一致）应 exit 0",
    tree: {},
    args: [],
    expectCode: 0,
    expectText: ["全绿", "基线欠账 0 个"],
  },
  {
    name: "文档写了不存在的指标名应红（含 文件:行号 → 名字 与双向修法）",
    tree: {
      docs: {
        "docs/guide.md": "# 指南\n\n看 `autoflow_demo_ghost_total`。\n",
      },
    },
    args: [],
    expectCode: 1,
    expectText: [
      "不存在",
      "docs/guide.md:3 → autoflow_demo_ghost_total",
      "要么改文档",
      "要么注册该指标",
    ],
  },
  {
    name: "注册表新增未文档化指标（基线没有它）应红（棘轮只减不增）",
    tree: {
      docs: {
        "docs/observability/README.md": docsListingAll([
          ...DEFAULT_COUNTERS.filter((n) => n !== "autoflow_demo_zeta_total"),
          ...DEFAULT_GAUGES,
          ...DEFAULT_SERVICE,
        ]),
      },
    },
    args: [],
    expectCode: 1,
    expectText: ["新增了未文档化", "autoflow_demo_zeta_total", "--update"],
  },
  {
    name: "基线登记了已补文档的指标应红（陈旧 → 收紧棘轮）",
    tree: { baseline: { undocumented: ["autoflow_demo_alpha_total"] } },
    args: [],
    expectCode: 1,
    expectText: ["基线**陈旧**", "文档已提及该指标"],
  },
  {
    name: "基线登记了注册表已删除的指标应红（另一种陈旧）",
    tree: { baseline: { undocumented: ["autoflow_demo_removed_total"] } },
    args: [],
    expectCode: 1,
    expectText: ["注册表里已无此指标"],
  },
  {
    name: "注册表解析不到（联合/对象被清空）应红，不许静默通过",
    tree: {
      registryText: "export type RuntimeCounterName = never;\n",
    },
    args: [],
    expectCode: 1,
    expectText: ["守卫自身失效", "RuntimeCounterName", "直接失败"],
  },
  {
    name: "注册表规模低于下界（拆分/改名）应红",
    tree: {
      counters: ["autoflow_demo_alpha_total"],
      gauges: ["autoflow_demo_level"],
      service: ["autoflow_demo_svc_0_total"],
      docs: {
        "docs/observability/README.md": "# 指标\n\n`autoflow_demo_alpha_total`\n",
      },
    },
    args: [],
    expectCode: 1,
    expectText: ["下界"],
  },
  {
    name: "allowlist（external）命中应放行，且汇总里区分 allowlisted",
    tree: {
      docs: {
        "docs/observability/README.md": `${docsListingAll([...DEFAULT_COUNTERS, ...DEFAULT_GAUGES, ...DEFAULT_SERVICE])}\n外部指标：\`autoflow_vendor_exported_total\`。\n`,
      },
      allowlist: {
        entries: [
          {
            name: "autoflow_vendor_exported_total",
            kind: "external",
            reason: "外部托管 exporter 暴露的同前缀指标，本仓不注册",
          },
        ],
      },
    },
    args: [],
    expectCode: 0,
    expectText: ["全绿", "allowlisted 1 处", "external 1"],
  },
  {
    name: "allowlist 条目**缺 reason** 应红（豁免必须给理由）",
    tree: {
      allowlist: {
        entries: [{ name: "autoflow_vendor_exported_total", kind: "external" }],
      },
    },
    args: [],
    expectCode: 1,
    expectText: ["缺少 reason"],
  },
  {
    name: "allowlist 条目已无引用应红（豁免要回收）",
    tree: {
      allowlist: {
        entries: [
          {
            name: "autoflow_legacy_anchor",
            kind: "anchor",
            reason: "旧 runbook 锚点，已随文档改写消失",
          },
        ],
      },
    },
    args: [],
    expectCode: 1,
    expectText: ["allowlist 条目已无任何文档引用", "autoflow_legacy_anchor"],
  },
  {
    name: "行内豁免标记（带理由）放行，且汇总里计数",
    tree: {
      docs: {
        "docs/design/note.md": `${docsListingAll([...DEFAULT_COUNTERS, ...DEFAULT_GAUGES, ...DEFAULT_SERVICE])}\n> · 本节曾列出 \`autoflow_demo_never_impl_total\` 这条从未实现的指标。 <!-- ${IGNORE_MARKER} 明示从未实现的反例 -->\n`,
      },
    },
    args: [],
    expectCode: 0,
    expectText: ["全绿", "行内豁免 1 处"],
  },
  {
    name: "豁免标记独占一行时只覆盖到下一个空行（不越界整个文件）",
    tree: {
      docs: {
        "docs/design/note.md": `${docsListingAll([...DEFAULT_COUNTERS, ...DEFAULT_GAUGES, ...DEFAULT_SERVICE])}
<!-- ${IGNORE_MARKER} 同类反例集中在这里 -->
\`autoflow_demo_never_impl_total\`

\`autoflow_demo_outside_block_total\`
`,
      },
    },
    args: [],
    expectCode: 1,
    expectText: [
      "行内豁免 1 处",
      "→ autoflow_demo_outside_block_total",
    ],
    expectAbsent: ["autoflow_demo_never_impl_total"],
  },
  {
    name: "行内豁免标记**缺理由**应红",
    tree: {
      docs: {
        "docs/design/note.md": `${docsListingAll([...DEFAULT_COUNTERS, ...DEFAULT_GAUGES, ...DEFAULT_SERVICE])}\n<!-- ${IGNORE_MARKER} -->\n\n\`autoflow_demo_never_impl_total\`\n`,
      },
    },
    args: [],
    expectCode: 1,
    expectText: ["缺少理由"],
  },
  {
    name: "没有基线时 --update 能首次落地（普通扫描仍会因缺基线判红）",
    tree: {
      baseline: null,
      docs: {
        "docs/observability/README.md": docsListingAll([
          ...DEFAULT_COUNTERS.filter((n) => n !== "autoflow_demo_zeta_total"),
          ...DEFAULT_GAUGES,
          ...DEFAULT_SERVICE,
        ]),
      },
    },
    args: ["--update"],
    expectCode: 0,
    expectText: ["基线已写入", "1 个未文档化指标"],
  },
  {
    name: "前缀引用（autoflow_demo_svc_*）合法；--report 打印未文档化清单",
    tree: {
      docs: {
        "docs/observability/README.md": `${docsListingAll([...DEFAULT_COUNTERS, ...DEFAULT_GAUGES])}\n家族：\`autoflow_demo_svc_*\`。\n`,
        "docs/archive/old.md": "`autoflow_demo_archive_only_total`\n",
      },
    },
    args: ["--report"],
    expectCode: 0,
    expectText: [
      "未文档化的指标：12 个",
      "autoflow_demo_svc_0_total",
      "前缀引用（合法）：1 处",
    ],
  },
  {
    name: "文档引用已存在的告警名（与指标同名空间）应放行并计数",
    tree: {
      alerts: ["autoflow_demo_queue_backlog"],
      docs: {
        "docs/observability/README.md": `${docsListingAll([...DEFAULT_COUNTERS, ...DEFAULT_GAUGES, ...DEFAULT_SERVICE])}\n## runbook\n\n- \`autoflow_demo_queue_backlog\`\n`,
      },
    },
    args: [],
    expectCode: 0,
    expectText: ["全绿", "告警名引用 1 处"],
  },
  {
    name: "文档里的 autoflow_* 既不是指标也不是告警名 → 仍红（豁免不许外溢）",
    tree: {
      alerts: ["autoflow_demo_queue_backlog"],
      docs: {
        "docs/observability/README.md": `${docsListingAll([...DEFAULT_COUNTERS, ...DEFAULT_GAUGES, ...DEFAULT_SERVICE])}\n- \`autoflow_demo_not_an_alert\`\n`,
      },
    },
    args: [],
    expectCode: 1,
    expectText: ["不存在", "autoflow_demo_not_an_alert"],
  },
];

export function runSelftest() {
  const sandbox = mkdtempSync(join(tmpdir(), "metric-docs-selftest-"));
  let failed = 0;
  try {
    SELFTEST_CASES.forEach((testCase, index) => {
      const dir = join(sandbox, `${String(index + 1).padStart(2, "0")}-${slugify(testCase.name)}`);
      mkdirSync(dir, { recursive: true });
      buildTree(dir, testCase.tree);
      const result = spawnSync(
        process.execPath,
        [SELF, "--root", dir, ...testCase.args],
        { encoding: "utf8" },
      );
      const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
      const code = result.status;
      const problems = [];
      if (code !== testCase.expectCode)
        problems.push(`退出码 ${code}（期望 ${testCase.expectCode}）`);
      for (const text of testCase.expectText) {
        if (!output.includes(text)) problems.push(`输出缺少 ${JSON.stringify(text)}`);
      }
      for (const text of testCase.expectAbsent ?? []) {
        if (output.includes(text))
          problems.push(`输出不该含 ${JSON.stringify(text)}（说明豁免作用域越界了）`);
      }
      if (problems.length > 0) {
        failed += 1;
        console.error(`✗ selftest ${index + 1}「${testCase.name}」${problems.join("；")}`);
        console.error(`  ——— 实际输出 ———\n${output.trimEnd()}\n  ——————————`);
      } else {
        console.log(`✓ selftest ${index + 1}「${testCase.name}」exit=${code}`);
      }
    });
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }

  if (failed > 0) {
    console.error(`\n✗ 指标文档守卫 selftest 失败：${failed}/${SELFTEST_CASES.length} 条用例未按预期`);
    return 1;
  }
  console.log(
    `\n✓ 指标文档守卫 selftest 通过：${SELFTEST_CASES.length}/${SELFTEST_CASES.length} 条用例（每条断言退出码 + 关键报错文本）`,
  );
  return 0;
}

// ── 入口 ────────────────────────────────────────────────────────────────────
function argValue(argv, flag) {
  const eq = argv.find((a) => a.startsWith(`${flag}=`));
  if (eq) return eq.slice(flag.length + 1);
  const at = argv.indexOf(flag);
  if (at >= 0 && at + 1 < argv.length) return argv[at + 1];
  return null;
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--selftest")) return runSelftest();

  const root = resolve(argValue(argv, "--root") ?? DEFAULT_ROOT);
  const updating = argv.includes("--update");
  const result = analyze(root, { allowMissingBaseline: updating });

  if (updating) {
    if (result.configErrors.length > 0) {
      printConfigErrors(result.configErrors);
      console.error("✗ 拒绝写基线：解析/装载本身失败时写出来的基线毫无意义。");
      return 1;
    }
    writeBaseline(result);
    if (result.unknown.length > 0)
      console.error(
        `! 注意：当前仍有 ${result.unknown.length} 处未知指标名（A 类）——基线只管 B/C 类，不掩盖它们。`,
      );
    return 0;
  }
  if (argv.includes("--report")) return printReport(result);
  return printGate(result);
}

process.exit(main());
