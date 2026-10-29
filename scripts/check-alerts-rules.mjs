#!/usr/bin/env node
// 告警/看板同源守卫（可观测性纵深轮）：config/monitoring/alerts.yml +
// docs/observability/grafana-dashboard.json + docs/observability/alerting-rules.yml
//
// alerts.yml 是 compose monitoring profile 的接线告警面（prometheus.yml
// rule_files 挂载），但本机没有 promtool——一条 expr 拼错、一个指标名臆造、
// 一条规则漏掉 for/severity，都要等部署到真机才暴露。本守卫把「结构合法 +
// 指标名真实存在」钉成静态断言：
//
//   · YAML 可解析：内置零依赖的受限 YAML 子集解析器（映射/序列/引号标量，
//     与 check-release-config.mjs「守卫一律零依赖」的既有纪律一致；块标量
//     `|`/`>` 与锚点等高级语法不支持，遇到即报错——要写复杂 expr 请用引号
//     单行标量）；
//   · 每条规则必有：alert 名（合法标识符、全文件唯一）、expr、for 时长、
//     labels.severity ∈ {critical, warning}、annotations.summary/description
//     非空（中文排障口径的最低门槛）；
//   · annotations.runbook_url（OBS3-06）：必须是 **http(s) 绝对 URL**，且
//     `#锚点` 必须在 docs/observability/README.md（§3.6 Runbook 索引）或
//     docs/operations.md 的标题里真的存在——「通道建好、数据没填」（31 条
//     规则 0 条 runbook_url）与「链接指向不存在的锚点」两种形态都变红。
//     规范锚点 = 告警名小写（http-red 两条共用一个锚点），细节见 README §3.6。
//   · expr 引用的指标名必须存在于「代码指标清单」——清单来自
//     apps/admin-api/src/modules/metrics/ 两个声明源文件的全部
//     autoflow_* 字面量 + INFRA_METRICS 白名单（exporter/内置指标，逐项
//     注明出处），杜绝臆造指标名；
//   · 探针自检：清单里必须仍能找到两个已知核心指标，两个源文件若被改名/
//     拆分导致清单空转，守卫立即失败而不是静默放行。
//
// 审计批次 A 扩展：dashboard 与阅读版告警同入守卫面。
//   · docs/observability/grafana-dashboard.json：全部面板 target expr +
//     Prometheus 类型模板变量的取数定义走同一份 extractMetricNames/指标清单
//     ——metrics 模块改名时 alerts 会红、dashboard 会静默坏图，这里补齐
//     后者（报错带面板标题，坏图可直查）；
//   · docs/observability/alerting-rules.yml 是「阅读版」告警（README §3 的
//     教学载体，块标量/`>-` 写法不在受限解析器射程内），做三层对账：存在性 +
//     指标名对账（runbook 注释里的 `#锚点` 同名串不算指标）+ 语义级对账
//     （2026-10-07 升级：每条告警的 for/severity/expr 空白归一后必须与接线
//     版同名规则一致——教学载体教的必须是真实生效的语义；规则集允许子集，
//     不要求全等；接线版自身未过守卫时语义层自动跳过，不叠加噪声）。
//
// 退出码：0 = 全绿；1 = 解析失败 / 结构违规 / 指标名不在清单 / expr 体检红。
//
// ── expr 静态体检（第 4 轮测试质量审计 T1 补强）─────────────────────────────
// 审计在临时副本上实证：把 5 条规则的 expr 改成**永远不可能触发**的形态
// （`up ==` / `up{job="a"` / `rate(up[5m])` / `0 == 0` / `vector(1) > 2`），
// `npm run test:alerts` 仍然 5/5 全绿——因为原判据只问「名字拼对了没有」，
// 从不问「这条规则会不会响」。而「值班人以为有告警、其实永远不会响」正是这
// 份文件唯一的存在理由。因此新增一层**零依赖、保守**（只抓确定的坏形态，
// 不引 promql 解析器）的体检，判据见 inspectAlertExpr / 各 find* 函数：
//   ① 括号/引号/花括号配平（含嵌套与 \ 转义）+ 不得以运算符结尾（截断形态）；
//   ② 常量对常量比较（0 == 0、1 == 1、vector(N) > M）与纯 true/false；
//   ③ 对 gauge 用 rate/irate/increase；histogram_quantile 输入里没有 *_bucket；
//   ④ 全式没有比较运算符且不是 absent/absent_over_time（没有阈值面）；
//   ⑤ for < 2×scrape_interval → **warn**（不改变退出码：短 for 合法，但不足
//      两个抓取周期通常是抖动告警/笔误）。
// ① ~ ④ 为红；⑤ 只打印 ⚠。任务清单第 4 条（指标名必须真实存在）是**既有**判据，
// 保持原样（selftest 与实扫断言各有一条盯着它不退化成空转）。阅读版
// alerting-rules.yml 不重复跑这层体检：它的 expr 已被「语义级对账」强制与接线
// 版逐字一致（空白归一），接线版过检即等价覆盖，重复一遍只是噪声。
//
// 用法：node scripts/check-alerts-rules.mjs [--selftest] [--root <dir>]
//   （根 package.json 的 test:alerts = --selftest + 实扫）
//   --selftest：用内置 fixture 验证解析器与判据本身（不扫真实代码库）；其中
//     一组用例 spawn 本脚本 + 临时树，断言**退出码**与关键报错文本（照
//     check-metric-docs 的模板：只断言「不抛」的自检在判据整体失效时照样全绿）。
//   --root：换一个根目录跑实扫（selftest 的临时树用；CI 用默认值）。

import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SELF_PATH = fileURLToPath(import.meta.url);
const SCRIPT_ROOT = join(import.meta.dirname, "..");
const ALERTS_FILE = "config/monitoring/alerts.yml";
const DASHBOARD_FILE = "docs/observability/grafana-dashboard.json";
const READING_RULES_FILE = "docs/observability/alerting-rules.yml";
// runbook_url 的锚点落点（OBS3-06）：告警名小写 → 这两个文档里的标题 slug。
const RUNBOOK_DOC_FILES = [
  "docs/observability/README.md",
  "docs/operations.md",
];
// Prometheus 抓取间隔的事实源（判据 ⑤ 的定量基准）。读不到时退回 15s 并提示，
// 不让「配置文件被挪走」把整条判据变成静默放行。
const SCRAPE_CONFIG_FILE = "config/monitoring/prometheus.yml";
const DEFAULT_SCRAPE_INTERVAL_SECONDS = 15;

// ── 指标清单源（声明处单文件；metrics 模块重构时同步登记）──────────────────
// prometheus-metrics.service.ts：scheduler/queue/池水位/磁盘/回调认证等
// new Counter/Gauge 的 name 字面量；runtime-metrics.ts：RUNTIME_COUNTERS /
// RUNTIME_GAUGES 的全部 runtime 计数器与 gauge 名（埋点方经 recordRuntime
// 引用同一批名字）。两处合集 = /api/metrics 暴露面的全部 autoflow_*。
const METRIC_SOURCES = [
  "apps/admin-api/src/modules/metrics/prometheus-metrics.service.ts",
  "apps/admin-api/src/modules/metrics/runtime-metrics.ts",
];

// 非 autoflow_ 系指标白名单（exporter/内置）——expr 用到新指标先在此登记
// 并核对暴露面，宁可守卫拦一道也不要臆造名字。
const INFRA_METRICS = new Map([
  ["up", "Prometheus 内置：抓取成功 gauge（per-target）"],
  [
    "redis_up",
    "oliver006/redis_exporter：Redis 连通性 gauge（compose monitoring profile 的 redis-exporter 服务暴露）",
  ],
  ["redis_memory_used_bytes", "oliver006/redis_exporter：used_memory 字节数"],
  [
    "redis_memory_max_bytes",
    "oliver006/redis_exporter：maxmemory 配置字节数（0 = 未设上限）",
  ],
  // prom-client ^15.1.3 collectDefaultMetrics 默认指标（dashboard 进程资源
  // 面板引用；名称已逐字核对 apps/admin-api/node_modules/prom-client/lib/
  // metrics/ 的 processCpuTotal.js / osMemoryHeap(Linux).js /
  // heapSizeAndUsed.js / eventLoopLag.js metricNames。只登记实扫用到的 6 个，
  // 需要其余默认指标（nodejs_gc_duration_seconds 等）再按此口径补）。
  [
    "process_cpu_seconds_total",
    "prom-client collectDefaultMetrics：process+system CPU 累计秒（processCpuTotal.js）",
  ],
  [
    "process_resident_memory_bytes",
    "prom-client collectDefaultMetrics：RSS 字节（osMemoryHeapLinux.js）",
  ],
  [
    "nodejs_heap_size_total_bytes",
    "prom-client collectDefaultMetrics：V8 堆容量（heapSizeAndUsed.js）",
  ],
  [
    "nodejs_heap_size_used_bytes",
    "prom-client collectDefaultMetrics：V8 堆已用（heapSizeAndUsed.js）",
  ],
  [
    "nodejs_eventloop_lag_seconds",
    "prom-client collectDefaultMetrics：事件循环延迟最近采样（eventLoopLag.js）",
  ],
  [
    "nodejs_eventloop_lag_p99_seconds",
    "prom-client collectDefaultMetrics：事件循环延迟 p99（eventLoopLag.js）",
  ],
]);

// 非 autoflow_ 系里**类型是 gauge** 的那几个（判据 ③ 的事实源之一）。
// 只登记能确认类型的：`up`（每次抓取 0/1）、redis_exporter 的两个 gauge、
// prom-client collectDefaultMetrics 的进程/堆/事件循环 gauge。
// `process_cpu_seconds_total` 是 counter，**不在此列**（对它的 rate 是对的）。
const INFRA_GAUGES = new Map([
  ["up", "Prometheus 内置：每次抓取的成功标志（0/1）"],
  ["redis_up", "oliver006/redis_exporter：Redis 连通性（0/1）"],
  ["redis_memory_used_bytes", "oliver006/redis_exporter：used_memory 当前值"],
  ["redis_memory_max_bytes", "oliver006/redis_exporter：maxmemory 配置值"],
  [
    "process_resident_memory_bytes",
    "prom-client collectDefaultMetrics：RSS 当前值（osMemoryHeapLinux.js）",
  ],
  [
    "nodejs_heap_size_total_bytes",
    "prom-client collectDefaultMetrics：V8 堆容量当前值（heapSizeAndUsed.js）",
  ],
  [
    "nodejs_heap_size_used_bytes",
    "prom-client collectDefaultMetrics：V8 堆已用当前值（heapSizeAndUsed.js）",
  ],
  [
    "nodejs_eventloop_lag_seconds",
    "prom-client collectDefaultMetrics：事件循环延迟最近采样（eventLoopLag.js）",
  ],
  [
    "nodejs_eventloop_lag_p99_seconds",
    "prom-client collectDefaultMetrics：事件循环延迟 p99（eventLoopLag.js）",
  ],
]);

// ── 受限 YAML 子集解析器 ────────────────────────────────────────────────────
// 支持：嵌套映射、序列（- 开头的映射项/纯标量项）、单/双引号标量、plain
// 标量、整行与行内注释。不支持（遇到即抛错）：块标量 |/>、锚点 &、多文档、
// flow 集合 [a, b]/{a: b}——alerts.yml 的受限子集足够，守卫不需要完整 YAML。
export function parseYamlSubset(text) {
  const lines = [];
  for (const raw of text.split(/\r?\n/)) {
    const noComment = stripComment(raw).replace(/\s+$/, "");
    if (noComment.trim() === "") continue;
    lines.push({
      indent: noComment.match(/^ */)[0].length,
      content: noComment.trim(),
    });
  }
  if (lines.length === 0) return null;
  const [value, pos] = parseBlock(lines, 0, lines[0].indent);
  if (pos !== lines.length) {
    throw new Error(`第 ${pos + 1} 个非空行附近缩进/语法无法解析："${lines[pos].content}"`);
  }
  return value;
}

/** 去掉行内注释（引号外的 ` #...`；引号内的 # 不动） */
function stripComment(line) {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === '"' && !inSingle) inDouble = !inDouble;
    else if (ch === "#" && !inSingle && !inDouble && (i === 0 || /\s/.test(line[i - 1]))) {
      return line.slice(0, i);
    }
  }
  return line;
}

function parseBlock(lines, pos, indent) {
  const line = lines[pos];
  if (line.content === "-" || line.content.startsWith("- ")) {
    return parseSequence(lines, pos, indent);
  }
  return parseMapping(lines, pos, indent);
}

function parseSequence(lines, pos, indent) {
  const seq = [];
  while (
    pos < lines.length &&
    lines[pos].indent === indent &&
    (lines[pos].content === "-" || lines[pos].content.startsWith("- "))
  ) {
    const rest =
      lines[pos].content === "-" ? "" : lines[pos].content.slice(2).trim();
    if (rest === "") {
      // 独占一行的 "-"：成员体在其后的更深缩进行
      pos++;
      if (pos < lines.length && lines[pos].indent > indent) {
        const [value, next] = parseBlock(lines, pos, lines[pos].indent);
        seq.push(value);
        pos = next;
      } else {
        seq.push(null);
      }
    } else {
      // 行内首成员（- key: value）：把它当作缩进 +2 的块首行复用解析器
      const original = lines[pos];
      lines[pos] = { indent: indent + 2, content: rest };
      const [value, next] = parseBlock(lines, pos, indent + 2);
      seq.push(value);
      pos = next;
      lines[pos - 1] = original;
    }
  }
  return [seq, pos];
}

function parseMapping(lines, pos, indent) {
  const map = {};
  while (pos < lines.length) {
    const line = lines[pos];
    if (line.indent > indent) {
      throw new Error(`缩进过深（缺少所属 key）："${line.content}"`);
    }
    if (line.indent < indent || line.content.startsWith("- ")) break;
    // key 匹配首个 ASCII 冒号；值可以是引号标量（内部可再含冒号）或 plain
    const match = line.content.match(/^([^:]+):(?:\s+(.*))?$/);
    if (!match) {
      throw new Error(`无法解析的行："${line.content}"`);
    }
    const key = match[1].trim();
    const rest = (match[2] ?? "").trim();
    if (rest === "") {
      pos++;
      // 嵌套块：映射要求更深缩进；序列允许与 key 同缩进（YAML 惯例）
      const nested =
        pos < lines.length &&
        (lines[pos].indent > indent ||
          (lines[pos].indent === indent &&
            (lines[pos].content === "-" ||
              lines[pos].content.startsWith("- "))));
      if (nested) {
        const [value, next] = parseBlock(lines, pos, lines[pos].indent);
        map[key] = value;
        pos = next;
      } else {
        map[key] = null;
      }
    } else {
      map[key] = parseScalar(rest);
      pos++;
    }
  }
  return [map, pos];
}

function parseScalar(text) {
  if (text.startsWith("|") || text.startsWith(">")) {
    throw new Error(
      `不支持块标量（"${text.slice(0, 20)}…"）：expr/annotations 请用引号单行标量`,
    );
  }
  if (text.startsWith("'")) {
    if (text.length < 2 || !text.endsWith("'")) {
      throw new Error(`单引号标量未闭合：${text.slice(0, 40)}…`);
    }
    return text.slice(1, -1).replace(/''/g, "'");
  }
  if (text.startsWith('"')) {
    if (text.length < 2 || !text.endsWith('"')) {
      throw new Error(`双引号标量未闭合：${text.slice(0, 40)}…`);
    }
    return text.slice(1, -1).replace(/\\([\s\S])/g, "$1");
  }
  if (text.startsWith("[") || text.startsWith("{") || text.startsWith("&")) {
    throw new Error(`不支持 flow 集合/锚点（"${text.slice(0, 20)}…"）`);
  }
  return text;
}

// ── expr 指标名提取 ─────────────────────────────────────────────────────────
// 先剥引号字符串/label selector {...}/时间窗口 [...]，再取标识符并滤掉
// PromQL 关键字、函数与 by/without 子句里的 label 名——剩下的都应是指标名。
const PROMQL_STOPWORDS = new Set([
  // 逻辑/集合运算与修饰
  "and",
  "or",
  "unless",
  "by",
  "without",
  "on",
  "ignoring",
  "group_left",
  "group_right",
  "offset",
  "bool",
  // 聚合
  "sum",
  "avg",
  "min",
  "max",
  "count",
  "count_values",
  "stddev",
  "stdvar",
  "topk",
  "bottomk",
  "quantile",
  // 函数（本仓告警可能用到的 + 常见邻集，避免放宽后漏拦）
  "rate",
  "irate",
  "increase",
  "delta",
  "idelta",
  "absent",
  "absent_over_time",
  "avg_over_time",
  "sum_over_time",
  "min_over_time",
  "max_over_time",
  "count_over_time",
  "quantile_over_time",
  "last_over_time",
  "present_over_time",
  "changes",
  "resets",
  "histogram_quantile",
  "label_replace",
  "label_join",
  "clamp",
  "clamp_min",
  "clamp_max",
  "vector",
  "scalar",
  "sort",
  "sort_desc",
  "time",
  "timestamp",
  "pi",
  "exp",
  "ln",
  "log2",
  "log10",
  "sqrt",
  "round",
  "abs",
  "sgn",
  "ceil",
  "floor",
  "predict_linear",
  "holt_winters",
  "deriv",
  "hour",
  "minute",
  "month",
  "year",
  "day_of_week",
  "day_of_month",
  "days_in_month",
  // by/without 子句与常见 label 名（label selector 主体已被剥掉，此处兜底）
  "job",
  "instance",
  "alertname",
  "severity",
  "service",
  "state",
  "status",
  "result",
  "reason",
  "channel",
  "executor",
  "le",
  "name",
  // Grafana 模板函数（dashboard 变量定义 label_values(metric, label)）：
  // 只在 dashboard 校验面出现，挂进同一停用词表避免两套口径。
  "label_values",
]);

export function extractMetricNames(expr) {
  const stripped = expr
    .replace(/'[^']*'/g, " ")
    .replace(/"[^"]*"/g, " ")
    .replace(/\{[^}]*\}/g, " ")
    .replace(/\[[^\]]*\]/g, " ")
    // 数字字面量（含科学计数 1e-9）：先剥掉，否则 e 被当成标识符提出
    // （dashboard avg 面板 clamp_min(..., 1e-9) 实测踩中）。边界条件保证不
    // 误伤标识符内的数字段（nodejs_eventloop_lag_p99_seconds 的 "99"——
    // 前后任一侧贴着指标字符集即不剥离）；指标名不可能以数字开头。
    .replace(
      /(^|[^A-Za-z0-9_:])\d*\.?\d+(?:[eE][+-]?\d+)?(?![A-Za-z0-9_:])/g,
      "$1 ",
    );
  const identifiers = stripped.match(/[A-Za-z_:][A-Za-z0-9_:]*/g) ?? [];
  return [
    ...new Set(identifiers.filter((id) => !PROMQL_STOPWORDS.has(id))),
  ];
}

// ── 指标清单 ────────────────────────────────────────────────────────────────
export function buildMetricInventory(sourceTexts) {
  const names = new Set(INFRA_METRICS.keys());
  const literal = /["'`](autoflow_[a-z0-9_]+)["'`]/g;
  for (const text of sourceTexts) {
    for (const match of text.matchAll(literal)) names.add(match[1]);
  }
  return names;
}

// ── gauge 清单（判据 ③ 的事实源）─────────────────────────────────────────────
// 「gauge 的 rate 无意义」这条判据只有在 gauge 名单真实时才有意义，所以名单
// 从**声明处**抽取而不是手抄：
//   · runtime-metrics.ts 的 RUNTIME_GAUGES 对象键（runtime 埋点的 gauge）；
//   · prometheus-metrics.service.ts 里每个 `new Gauge({ name: "autoflow_*" })`
//     （注意 `this.runtimeGauges = Object.fromEntries(… new Gauge({ name }) …)`
//     用的是变量名，抽不到也没有关系——那批名字已经由 RUNTIME_GAUGES 覆盖）；
//   · INFRA_GAUGES（exporter/内置，逐项注明类型）。
/** 取 `text[openIndex]` 处开括号的配对内容（引号内的括号不参与配对）。 */
function sliceBalanced(text, openIndex, open = "(", close = ")") {
  let quote = null;
  let depth = 0;
  for (let i = openIndex; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      if (ch === "\\" && quote !== "`") {
        i += 1;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      continue;
    }
    if (ch === open) depth += 1;
    else if (ch === close) {
      depth -= 1;
      if (depth === 0) return text.slice(openIndex + 1, i);
    }
  }
  return null;
}

/** 把引号字符串内容抹成空格（等长，保持偏移），便于按结构扫描字面量。 */
function maskQuotedStrings(text) {
  let out = "";
  let quote = null;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      if (ch === "\\" && quote !== "`") {
        out += "  ";
        i += 1;
        continue;
      }
      if (ch === quote) {
        quote = null;
        out += ch;
        continue;
      }
      out += " ";
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      out += ch;
      continue;
    }
    out += ch;
  }
  return out;
}

/** runtime-metrics.ts → RUNTIME_GAUGES 的顶层键（= runtime gauge 名）。 */
export function collectRuntimeGaugeNames(text) {
  const source = String(text ?? "");
  const anchor = source.indexOf("export const RUNTIME_GAUGES");
  if (anchor < 0) return [];
  const equal = source.indexOf("=", anchor);
  if (equal < 0) return [];
  const open = source.indexOf("{", equal);
  if (open < 0) return [];
  const raw = sliceBalanced(source, open, "{", "}");
  if (raw === null) return [];
  const masked = maskQuotedStrings(raw);
  const names = [];
  let depth = 0;
  for (let i = 0; i < masked.length; i += 1) {
    const ch = masked[i];
    if (ch === "{" || ch === "(" || ch === "[") depth += 1;
    else if (ch === "}" || ch === ")" || ch === "]") depth -= 1;
    else if (depth === 0) {
      const match = masked.slice(i).match(/^([A-Za-z_][A-Za-z0-9_]*)\s*:/);
      if (match) {
        names.push(match[1]);
        i += match[0].length - 1;
      }
    }
  }
  return [...new Set(names)];
}

/** prometheus-metrics.service.ts → 所有 `new Gauge({ name: "…" })` 的指标名。 */
export function collectServiceGaugeNames(text) {
  const source = String(text ?? "");
  const names = [];
  const re = /new\s+Gauge\s*\(/g;
  let match;
  while ((match = re.exec(source)) !== null) {
    const open = match.index + match[0].length - 1;
    const inner = sliceBalanced(source, open);
    if (!inner) continue;
    const nameMatch = inner.match(/name\s*:\s*["'`]([A-Za-z_][A-Za-z0-9_:]*)["'`]/);
    if (nameMatch) names.push(nameMatch[1]);
  }
  return [...new Set(names)];
}

export function buildGaugeInventory({ runtimeMetricsText = "", serviceText = "" } = {}) {
  const gauges = new Map(INFRA_GAUGES);
  for (const name of collectRuntimeGaugeNames(runtimeMetricsText)) {
    gauges.set(name, "runtime-metrics.ts 的 RUNTIME_GAUGES（gauge 声明）");
  }
  for (const name of collectServiceGaugeNames(serviceText)) {
    gauges.set(name, "prometheus-metrics.service.ts 的 new Gauge({ name: … })");
  }
  return gauges;
}

// ── expr 静态体检（审计 T1）──────────────────────────────────────────────────
const OPEN_BRACKETS = { "(": ")", "[": "]", "{": "}" };
const CLOSE_BRACKETS = new Set([")", "]", "}"]);
// 以运算符/连接词结尾 = 表达式被截断（审计形态之一：`up ==`）。
const TRAILING_OPERATOR =
  /(?:[=!<>~+\-*/%^,]+|(?:^|[^A-Za-z0-9_])(?:and|or|unless|by|without|on|ignoring|group_left|group_right|bool|offset))\s*$/;
// 「常量操作数」：数字字面量或 vector(数字)。刻意不认 scalar()/time() 之类，
// 保守优先——判据只抓确定的常数对常数。
const CONST_OPERAND =
  /^-?(?:\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|vector\(\s*-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\s*\))$/;

/**
 * 逐字符扫 expr：引号（含 `\` 转义）内的字符不参与括号配对。
 * 返回不配平的描述列表（空 = 配平）。
 */
export function checkExprBalance(expr) {
  const text = String(expr ?? "").trim();
  const errors = [];
  const stack = [];
  let quote = null;
  let quoteStart = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      if (ch === "\\" && quote !== "`") {
        i += 1;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      quoteStart = i;
      continue;
    }
    if (OPEN_BRACKETS[ch]) {
      stack.push({ ch, index: i });
      continue;
    }
    if (CLOSE_BRACKETS.has(ch)) {
      const top = stack.pop();
      if (!top) {
        errors.push(`第 ${i + 1} 个字符处有多余的右括号 "${ch}"（左侧没有对应的开括号）`);
      } else if (OPEN_BRACKETS[top.ch] !== ch) {
        errors.push(
          `第 ${top.index + 1} 个字符的 "${top.ch}" 与第 ${i + 1} 个字符的 "${ch}" 配错（嵌套不合法）`,
        );
      }
    }
  }
  if (quote) {
    errors.push(`第 ${quoteStart + 1} 个字符起的引号 ${quote} 没有闭合`);
  } else if (stack.length > 0) {
    const top = stack[stack.length - 1];
    errors.push(`第 ${top.index + 1} 个字符的 "${top.ch}" 没有闭合（括号/花括号不配平）`);
  }
  if (errors.length === 0) {
    const tail = text.match(TRAILING_OPERATOR);
    if (tail) {
      errors.push(
        `表达式以运算符/连接词 "${tail[0].trim()}" 结尾——这一行在语法上被截断（PromQL 解析必失败，而告警会静默不生效）`,
      );
    }
  }
  return errors;
}

/**
 * 收集表达式里的比较运算位点。花括号 `{…}`（label selector）与方括号
 * `[5m]`（range）内的 `!=`/`=~` 不是比较运算符，必须排除；圆括号只用于判断
 * 「是否整式就是一次比较」（parenDepth 0）。
 */
function comparisonSites(expr) {
  const text = String(expr ?? "");
  const sites = [];
  let paren = 0;
  let brace = 0;
  let bracket = 0;
  let quote = null;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      if (ch === "\\" && quote !== "`") {
        i += 1;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      continue;
    }
    if (ch === "(") paren += 1;
    else if (ch === ")") paren -= 1;
    else if (ch === "{") brace += 1;
    else if (ch === "}") brace -= 1;
    else if (ch === "[") bracket += 1;
    else if (ch === "]") bracket -= 1;
    if (brace !== 0 || bracket !== 0) continue;
    const two = text.slice(i, i + 2);
    if (two === "==" || two === "!=" || two === ">=" || two === "<=") {
      sites.push({ index: i, op: two, width: 2, parenDepth: paren });
      i += 1;
      continue;
    }
    if (ch === ">" || ch === "<") {
      sites.push({ index: i, op: ch, width: 1, parenDepth: paren });
    }
  }
  return sites;
}

function constValue(operand) {
  const text = String(operand ?? "").trim();
  if (!CONST_OPERAND.test(text)) return null;
  const num = text.match(/-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/);
  return num ? Number(num[0]) : null;
}

/** 恒真/恒假：整式是「常量 比较 常量」（含 vector(N) 与纯 true/false）。 */
export function findConstantComparison(expr) {
  const text = String(expr ?? "").trim();
  if (/^(?:true|false)$/i.test(text)) {
    return `表达式整体是布尔常量 ${JSON.stringify(text)}——它不随任何指标变化，规则要么永远触发要么永远不触发`;
  }
  const site = comparisonSites(text).find((item) => item.parenDepth === 0);
  if (!site) return null;
  const left = text.slice(0, site.index).trim();
  const right = text
    .slice(site.index + site.width)
    .replace(/^\s*bool\s+/i, "")
    .trim();
  const leftValue = constValue(left);
  const rightValue = constValue(right);
  if (leftValue === null || rightValue === null) return null;
  const holds = {
    "==": leftValue === rightValue,
    "!=": leftValue !== rightValue,
    ">": leftValue > rightValue,
    "<": leftValue < rightValue,
    ">=": leftValue >= rightValue,
    "<=": leftValue <= rightValue,
  }[site.op];
  return `常量对常量比较 "${left} ${site.op} ${right}" 恒为${holds ? "真" : "假"}——表达式里没有任何真实指标，这条规则与系统状态无关（永远响或永远不响）`;
}

/** 取 expr 里每个 `fn(` 的配对内容（用于看函数的输入是什么）。 */
function callContents(expr, fnName) {
  const text = String(expr ?? "");
  const contents = [];
  const re = new RegExp(`(?:^|[^A-Za-z0-9_:])${fnName}\\s*\\(`, "g");
  let match;
  while ((match = re.exec(text)) !== null) {
    const open = match.index + match[0].length - 1;
    const inner = sliceBalanced(text, open);
    if (inner !== null) contents.push(inner);
  }
  return contents;
}

const GAUGE_RATE_FUNCS = ["rate", "irate", "increase"];

/** 判据 ③：对 gauge 用 rate/irate/increase；histogram_quantile 输入无 *_bucket。 */
export function findGaugeMisuse(expr, gauges) {
  const text = String(expr ?? "");
  const errors = [];
  const inventory = gauges instanceof Map ? gauges : new Map();
  // 名单为空时「rate 套 gauge」这部分不猜（scanReal 有 GAUGE_INVENTORY_PROBES
  // 兜底，保证真实名单非空）；但 histogram_quantile 的 *_bucket 判据不依赖名单，
  // 无论名单在不在都跑——否则「gauge 名单坏了」会把这条判据一起拖成静默。
  if (inventory.size > 0) {
    for (const fn of GAUGE_RATE_FUNCS) {
      for (const inner of callContents(text, fn)) {
        for (const metric of extractMetricNames(inner)) {
          if (!inventory.has(metric)) continue;
          errors.push(
            `对 gauge 指标 "${metric}" 用了 ${fn}()（gauge 事实源：${inventory.get(metric)}）——gauge 可任意增减、没有「累计速率」语义，${fn}() 套在它上面通常意味着抄错了指标（应换成对应的 _total 计数器，或直接对 gauge 取值做比较）`,
          );
        }
      }
    }
  }
  for (const inner of callContents(text, "histogram_quantile")) {
    const metrics = extractMetricNames(inner);
    if (inventory.size > 0) {
      for (const metric of metrics) {
        if (!inventory.has(metric)) continue;
        errors.push(
          `histogram_quantile 的输入里出现 gauge 指标 "${metric}"（gauge 事实源：${inventory.get(metric)}）——分位数只能取自直方图的 *_bucket 序列`,
        );
      }
    }
    if (!metrics.some((metric) => /_bucket$/.test(metric))) {
      errors.push(
        `histogram_quantile 的输入里没有任何 *_bucket 直方图指标（实际引用：${metrics.length > 0 ? metrics.map((m) => `"${m}"`).join("、") : "无"}）——对 gauge/普通计数器求分位数得不到有意义的 P99`,
      );
    }
  }
  return errors;
}

/** 判据 ④：必须含比较运算符（absent / absent_over_time 例外）。 */
export function findMissingThreshold(expr) {
  const text = String(expr ?? "");
  if (comparisonSites(text).length > 0) return null;
  if (/\babsent(?:_over_time)?\s*\(/.test(text)) return null;
  return `表达式里没有任何比较运算符（> < >= <= == !=）——比较就是告警的阈值面；没有它，规则要么「有样本就响」要么只在值恰为 0 时才有意义（裸 up 即是这种形态），都不是可运维的告警条件。若本意是缺席检测请用 absent()/absent_over_time()`;
}

/**
 * expr 体检总入口：① 配平/截断 → ② 恒真恒假 → ③ gauge 误用 → ④ 缺阈值面。
 * 配平不过时只报配平错误（语法先修，后续词法判据的报错只会是噪声）。
 */
export function inspectAlertExpr(expr, { gauges = new Map() } = {}) {
  const text = String(expr ?? "");
  const balance = checkExprBalance(text);
  if (balance.length > 0) return balance;
  const errors = [];
  const constant = findConstantComparison(text);
  if (constant) errors.push(constant);
  errors.push(...findGaugeMisuse(text, gauges));
  // 已经判定「整式是常量」时不再叠一条「缺阈值面」：同一个缺陷报两遍只会稀释
  // 第一条的指向性。
  if (!constant) {
    const missing = findMissingThreshold(text);
    if (missing) errors.push(missing);
  }
  return errors;
}

// ── for 与抓取间隔的定量关系（判据 ⑤，warn）────────────────────────────────
const DURATION_UNITS_SECONDS = { ms: 0.001, s: 1, m: 60, h: 3600, d: 86400 };

export function durationToSeconds(text) {
  const match = String(text ?? "")
    .trim()
    .match(/^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/);
  if (!match) return null;
  return Number(match[1]) * DURATION_UNITS_SECONDS[match[2]];
}

/** 从 prometheus.yml 的 `global.scrape_interval` 读秒数；读不到返回 null。 */
export function readScrapeIntervalSeconds(text) {
  const match = String(text ?? "").match(/^\s*scrape_interval:\s*(\S+)\s*$/m);
  if (!match) return null;
  return durationToSeconds(match[1]);
}

// ── 告警名 → 关键字段行号（报错要点名 ALERTNAME:line）───────────────────────
/**
 * 从 alerts.yml 原文扫出每条规则的 alert/expr/for 行号（1 基）。
 * 不依赖受限 YAML 解析器的返回值（它不保留行号），独立的逐行扫描；行内
 * 注释/注释行不会命中（`#` 在前，正则要求行首缩进后直接是字段名）。
 */
export function mapAlertFieldLines(text) {
  const map = new Map();
  let current = null;
  String(text ?? "")
    .split(/\r?\n/)
    .forEach((line, index) => {
      const alertMatch = line.match(/^\s*-\s+alert:\s*(\S+)/);
      if (alertMatch) {
        current = { alertLine: index + 1, exprLine: null, forLine: null };
        map.set(alertMatch[1], current);
        return;
      }
      if (!current) return;
      if (current.exprLine === null && /^\s+expr:\s*\S/.test(line)) {
        current.exprLine = index + 1;
      }
      if (current.forLine === null && /^\s+for:\s*\S/.test(line)) {
        current.forLine = index + 1;
      }
    });
  return map;
}

// ── 规则校验 ────────────────────────────────────────────────────────────────
const FOR_DURATION = /^\d+(ms|s|m|h|d)$/;
const ALERT_NAME = /^[A-Za-z][A-Za-z0-9_]*$/;
// 绝对 URL：必须带 scheme（相对路径在企微/钉钉/邮件客户端里点不开，OBS3-06）
const ABSOLUTE_HTTP_URL = /^https?:\/\/[^\s/]+(:\d+)?(\/[^\s]*)?$/;

/**
 * Markdown 标题 → GitHub 风格锚点（slug）。
 *
 * 与 GitHub 渲染口径对齐到「够用」：小写、去标点（保留字母/数字/空白/`_`/`-`，
 * 中文字符属于 `\p{L}` 会保留）、空白折成 `-`。本仓 runbook 锚点一律是
 * ASCII 的告警名小写（`autoflow_scheduler_down` / `instance_down`），所以
 * 这个实现即使对 CJK 标题略有偏差，也不影响判据的有效性。
 */
export function headingSlug(heading) {
  return String(heading ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/\s+/g, "-");
}

/** 收集若干 Markdown 文档里全部标题的锚点集合（用于校验 runbook_url 不死链）。 */
export function collectDocAnchors(texts) {
  const anchors = new Set();
  for (const text of texts) {
    for (const line of String(text ?? "").split(/\r?\n/)) {
      const match = line.match(/^#{1,6}\s+(.+?)\s*$/);
      if (match) anchors.add(headingSlug(match[1]));
    }
  }
  return anchors;
}

/**
 * 结构 + 指标名 + expr 静态体检。
 *
 * opts：
 *   · metricNames：指标清单（必填）；
 *   · runbookAnchors：runbook 锚点集合（null = 不校验锚点存在性）；
 *   · gauges：gauge 清单 Map(name → 事实源)，判据 ③ 用；默认空 Map（空 =
 *     该判据不猜，scanReal 有探针保证真实名单非空）；
 *   · scrapeIntervalSeconds：判据 ⑤ 的定量基准（默认 15s）；
 *   · alertLines：mapAlertFieldLines 的产物（报错点名 ALERTNAME:line）；
 *   · onWarn：warn 通道（判据 ⑤ 与「短 for」这类不改变退出码的提示）。
 */
export function validateAlertsDocument(
  doc,
  {
    metricNames,
    runbookAnchors = null,
    gauges = new Map(),
    scrapeIntervalSeconds = DEFAULT_SCRAPE_INTERVAL_SECONDS,
    alertLines = null,
    onWarn = null,
  } = {},
) {
  const errors = [];
  const warn = (message) => {
    if (typeof onWarn === "function") onWarn(message);
  };
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
    return ["根节点必须是映射（groups: ...）"];
  }
  const groups = doc.groups;
  if (!Array.isArray(groups) || groups.length === 0) {
    return ["groups 必须是非空列表"];
  }
  const seenAlerts = new Set();
  groups.forEach((group, gi) => {
    const groupName = typeof group?.name === "string" ? group.name : `#${gi}`;
    const at = `groups[${groupName}]`;
    if (typeof group?.name !== "string" || group.name === "") {
      errors.push(`${at}: 缺少 group name`);
    }
    if (!Array.isArray(group?.rules) || group.rules.length === 0) {
      errors.push(`${at}: rules 必须是非空列表`);
      return;
    }
    group.rules.forEach((rule, ri) => {
      const where = `${at}.rules[${ri}]`;
      const alert = rule?.alert;
      if (typeof alert !== "string" || !ALERT_NAME.test(alert)) {
        errors.push(`${where}: alert 名缺失或非法（${JSON.stringify(alert ?? null)}）`);
        return;
      }
      if (seenAlerts.has(alert)) {
        errors.push(`${where}: alert 名重复（${alert}）`);
      }
      seenAlerts.add(alert);

      if (typeof rule.expr !== "string" || rule.expr.trim() === "") {
        errors.push(`${where}(${alert}): 缺少 expr`);
      }
      if (typeof rule.for !== "string" || !FOR_DURATION.test(rule.for)) {
        errors.push(
          `${where}(${alert}): 缺少合法的 for 时长（如 5m；当前 ${JSON.stringify(rule?.for ?? null)}）`,
        );
      }
      const severity = rule?.labels?.severity;
      if (severity !== "critical" && severity !== "warning") {
        errors.push(
          `${where}(${alert}): labels.severity 必须是 critical|warning（当前 ${JSON.stringify(severity ?? null)}）`,
        );
      }
      for (const field of ["summary", "description"]) {
        const value = rule?.annotations?.[field];
        if (typeof value !== "string" || value.trim() === "") {
          errors.push(`${where}(${alert}): annotations.${field} 必须是非空字符串`);
        }
      }
      // OBS3-06：runbook 通道不能是空转的——每条规则必须带可点击的绝对 URL
      const runbookUrl = rule?.annotations?.runbook_url;
      if (typeof runbookUrl !== "string" || runbookUrl.trim() === "") {
        errors.push(
          `${where}(${alert}): annotations.runbook_url 缺失（OBS3-06：告警必须带排障链接；锚点索引见 docs/observability/README.md §3.6，规范锚点 = 告警名小写）`,
        );
      } else if (!ABSOLUTE_HTTP_URL.test(runbookUrl.trim())) {
        errors.push(
          `${where}(${alert}): annotations.runbook_url 必须是 http(s) 绝对 URL（当前 ${JSON.stringify(runbookUrl)}）——相对路径在被 Alertmanager 转成通知正文后点不开，值班场景等于没有链接`,
        );
      } else if (runbookAnchors !== null) {
        const fragment = runbookUrl.trim().split("#")[1] ?? "";
        if (fragment === "") {
          errors.push(
            `${where}(${alert}): annotations.runbook_url 必须带 #锚点（当前 ${JSON.stringify(runbookUrl)}）——落到 README §3.6 对应小节，别只链到文件开头`,
          );
        } else if (!runbookAnchors.has(fragment)) {
          errors.push(
            `${where}(${alert}): annotations.runbook_url 的锚点 "#${fragment}" 在 ${RUNBOOK_DOC_FILES.join(" / ")} 的标题里不存在（死链 = 值班人点进去看不到处置口径；先补小节再接线）`,
          );
        }
      }
      // ── expr 层判据：定位串一律带行号（mapAlertFieldLines）→ ALERTNAME:line，
      //    报错可直接跳文件。指标名存在性（既有判据）与静态体检（审计 T1）共用。
      const fieldLines = alertLines instanceof Map ? alertLines.get(alert) : null;
      const exprAt = fieldLines?.exprLine ? `${alert}:${fieldLines.exprLine}` : alert;
      // 指标名判据：配平失败时 extractMetricNames 的「剥引号/剥花括号」全部失真
      // （例如 `up{job="a` 会提出伪指标 "a"），此时只报配平错误，不叠噪声。
      if (typeof rule.expr === "string" && checkExprBalance(rule.expr).length === 0) {
        for (const metric of extractMetricNames(rule.expr)) {
          if (!metricNames.has(metric)) {
            errors.push(
              `${where}(${exprAt}): 表达式引用了清单外的指标 "${metric}"（先在 metrics 源文件/METRIC_SOURCES 或 INFRA_METRICS 登记）`,
            );
          }
        }
      }
      // ── expr 静态体检（审计 T1）：① ~ ④ 为红，⑤ 为 warn ──────────────
      if (typeof rule.expr === "string") {
        for (const problem of inspectAlertExpr(rule.expr, { gauges })) {
          errors.push(`${exprAt}: ${problem}`);
        }
      }
      // 判据 ⑤：for < 2×抓取间隔 → warn（短 for 合法，但不足两个抓取周期时
      // 单次抓取抖动就能把告警打出去，通常是笔误或抖动告警）。
      const forSeconds = durationToSeconds(rule.for);
      const forWindow = 2 * scrapeIntervalSeconds;
      if (forSeconds !== null && forSeconds < forWindow) {
        const forAt = fieldLines?.forLine ? `${alert}:${fieldLines.forLine}` : alert;
        warn(
          `${forAt}: for: ${rule.for}（= ${forSeconds}s）小于 2×抓取间隔（scrape_interval ${scrapeIntervalSeconds}s → 下限 ${forWindow}s）——短 for 合法，但不足两个抓取周期时一次抓取抖动就足以触发，确认不是笔误/抖动告警`,
        );
      }
    });
  });
  return errors;
}

// ── dashboard 校验（审计批次 A）─────────────────────────────────────────────
// 面板 target expr + Prometheus 类型模板变量定义 → 同一份指标清单。row 面板
// 本身无 expr，但其嵌套 panels 要下钻；报错一律带面板标题（坏图直查）。
export function validateDashboardDocument(doc, { metricNames }) {
  const errors = [];
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
    return ["根节点必须是对象（Grafana dashboard JSON）"];
  }
  if (!Array.isArray(doc.panels) || doc.panels.length === 0) {
    return ["panels 必须是非空列表（dashboard 被清空 = 守卫先红）"];
  }
  const checkExpr = (expr, where) => {
    for (const metric of extractMetricNames(expr)) {
      if (!metricNames.has(metric)) {
        errors.push(
          `${where}: 表达式引用了清单外的指标 "${metric}"（metrics 模块改名了吗？面板会静默坏图；新指标先在 METRIC_SOURCES 或 INFRA_METRICS 登记）`,
        );
      }
    }
  };
  const walkPanels = (panels) => {
    for (const panel of panels) {
      if (!panel || typeof panel !== "object") {
        errors.push(`dashboard 含非法面板项（${JSON.stringify(panel ?? null)}）`);
        continue;
      }
      const title =
        typeof panel.title === "string" && panel.title !== ""
          ? panel.title
          : `#${errors.length}(无标题)`;
      if (panel.type === "row") {
        if (Array.isArray(panel.panels)) walkPanels(panel.panels);
        continue;
      }
      for (const [ti, target] of (panel.targets ?? []).entries()) {
        if (target && typeof target.expr === "string") {
          checkExpr(target.expr, `dashboard[${title}].targets[${ti}]`);
        }
      }
    }
  };
  walkPanels(doc.panels);
  // 模板变量：只扫 Prometheus 取数型（type=query）——datasource 型变量的
  // query 是数据源类型名（"prometheus"），不是指标，不能进清单比对。
  for (const variable of doc.templating?.list ?? []) {
    if (!variable || variable.type !== "query") continue;
    const name = typeof variable.name === "string" ? variable.name : "?";
    const exprs = [];
    if (typeof variable.definition === "string") exprs.push(variable.definition);
    if (typeof variable.query === "string") exprs.push(variable.query);
    else if (variable.query && typeof variable.query.query === "string") {
      exprs.push(variable.query.query);
    }
    for (const expr of exprs) {
      checkExpr(expr, `dashboard[变量 ${name}]`);
    }
  }
  return errors;
}

// ── 阅读版告警对账（审计批次 A 轻量版 → 2026-10-07 语义级升级）─────────────
// alerting-rules.yml 大量使用块标量（expr: | / description: >-），不在受限
// 解析器射程内，也不必为阅读版实现完整 YAML——分层对账：
//   ① 存在性：注释剥离后至少还有一条 `- alert:`（文件被清空/误删即红）；
//   ② 指标名对账：剥注释行（含块标量内的 PromQL `#` 注释行）后出现的每个
//      autoflow_* 字面量必须在清单内。runbook annotation 的 URL 锚点
//      （README.md#autoflow_scheduler_down）与指标同名，按前导 `#` 排除。
//   ③ 语义级对账（2026-10-07 升级，战役遗留 #6）：wiringRules（接线版解析
//      出的规则数组）在位时，阅读版每条告警必须与同名接线规则在
//      for / labels.severity / expr（空白归一后）三项上逐字一致——教学载体
//      教的必须是**真实生效的语义**。实扫曾借此抓出两条真漂移：阅读版
//      SCHEDULER_DOWN 仍是单实例 expr（接线版已是多实例 sum 形态）、
//      METRICS_TARGET_DOWN 的 absent 指标不同（见该文件 2026-10-07 修正注）。
//      规则集不要求全等（阅读版允许子集）；接线版解析失败时 ③ 自动跳过
//      （退回 ①②，不给「对账缺席=放行」以外的口子——接线版自身的红已独立上报）。
export function normalizeExpr(expr) {
  return String(expr ?? "").replace(/\s+/g, " ").trim();
}

/** 阅读版规则提取器：块标量感知的受限遍历（非完整 YAML）。 */
export function extractReadingRules(text) {
  const lines = String(text ?? "")
    .split(/\r?\n/)
    .filter((line) => !/^\s*#/.test(line));
  const rules = [];
  let current = null;
  let blockState = null; // { indent, parts } — expr 块标量收集态
  const unquote = (v) => {
    const s = String(v ?? "").trim();
    if (
      (s.startsWith("'") && s.endsWith("'") && s.length >= 2) ||
      (s.startsWith('"') && s.endsWith('"') && s.length >= 2)
    ) {
      return s.slice(1, -1);
    }
    return s;
  };
  const ALERT_RE = /^(\s*)-\s+alert:\s*(\S+)/;
  const EXPR_RE = /^(\s*)expr:\s*(.*)$/;
  const FOR_RE = /^\s+for:\s*(\S+)/;
  const SEVERITY_RE = /^\s+severity:\s*(\S+)/;
  for (const line of lines) {
    if (blockState) {
      // 块标量内容行：比 expr: 键更深缩进即收；退回同深/更浅缩进 = 块结束
      const indent = line.length - line.trimStart().length;
      if (line.trim() !== "" && indent > blockState.indent) {
        blockState.parts.push(line.trim());
        continue;
      }
      current.expr = blockState.parts.join(" ");
      blockState = null;
      // 不 continue——当前行可能是下一条 alert，落到下方判据
    }
    const alertMatch = line.match(ALERT_RE);
    if (alertMatch) {
      current = { alert: alertMatch[2], expr: null, for: null, severity: null };
      rules.push(current);
      continue;
    }
    if (!current) continue;
    const exprMatch = line.match(EXPR_RE);
    if (exprMatch && current.expr === null) {
      const value = exprMatch[2].trim();
      if (/^[|>][+-]?$/.test(value)) {
        // 块标量：后续更深缩进行收集为单行（> 折叠语义在 PromQL 空白归一下等价）
        blockState = { indent: exprMatch[1].length, parts: [] };
      } else if (value !== "") {
        current.expr = unquote(value);
      }
      continue;
    }
    const forMatch = line.match(FOR_RE);
    if (forMatch && current.for === null) {
      current.for = unquote(forMatch[1]);
      continue;
    }
    const sevMatch = line.match(SEVERITY_RE);
    if (sevMatch && current.severity === null) {
      current.severity = unquote(sevMatch[1]);
    }
  }
  if (blockState && current) {
    current.expr = blockState.parts.join(" ");
  }
  return rules;
}

export function validateReadingRulesText(text, { metricNames, wiringRules }) {
  const errors = [];
  if (typeof text !== "string" || text.trim() === "") {
    return ["文件为空"];
  }
  const code = text
    .split(/\r?\n/)
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");
  const alertCount = (code.match(/^\s*-\s+alert:\s*\S+/gm) ?? []).length;
  if (alertCount === 0) {
    return ["未找到任何 `- alert:` 条目（阅读版告警被清空？）"];
  }
  for (const match of code.matchAll(/autoflow_[a-z0-9_]+/g)) {
    if (match.index > 0 && code[match.index - 1] === "#") continue; // URL 锚点
    if (!metricNames.has(match[0])) {
      errors.push(
        `阅读版告警引用了清单外的指标 "${match[0]}"（与源码 metrics 清单对不上；阅读版也要能对图索骥）`,
      );
    }
  }
  // ④ runbook_url 必须是绝对 http(s) URL（OBS3-06）：阅读版是教学载体，教的
  //    必须是能点开的写法；相对路径在本机 IDE 里像链接，进了 IM 客户端就不是。
  for (const match of code.matchAll(/^\s*runbook_url:\s*(.+)$/gm)) {
    const raw = match[1].trim().replace(/^['"]/, "").replace(/['"]$/, "");
    if (!ABSOLUTE_HTTP_URL.test(raw)) {
      errors.push(
        `阅读版告警的 annotations.runbook_url 必须是 http(s) 绝对 URL（当前 ${JSON.stringify(raw)}）——教学载体教的就是真实生效的写法，相对路径点不开`,
      );
    }
  }
  // ③ 语义级对账（wiringRules 在位才启用；接线版解析失败=null 时退回轻量对账）
  if (Array.isArray(wiringRules) && wiringRules.length > 0) {
    const byName = new Map(wiringRules.map((r) => [r.alert, r]));
    for (const rule of extractReadingRules(text)) {
      const wiring = byName.get(rule.alert);
      if (!wiring) {
        errors.push(
          `阅读版告警 "${rule.alert}" 在接线版 ${ALERTS_FILE} 中不存在（接线版改名/删除后阅读版必须同步——教学载体教的必须是真实生效的告警）`,
        );
        continue;
      }
      const norm = (v) => (v === null || v === undefined ? "" : String(v).trim());
      if (norm(rule.for) !== norm(wiring.for)) {
        errors.push(
          `阅读版告警 "${rule.alert}" 的 for 与接线版不一致：阅读版 ${JSON.stringify(rule.for)} vs 接线版 ${JSON.stringify(wiring.for ?? null)}`,
        );
      }
      if (norm(rule.severity) !== norm(wiring.severity)) {
        errors.push(
          `阅读版告警 "${rule.alert}" 的 severity 与接线版不一致：阅读版 ${JSON.stringify(rule.severity)} vs 接线版 ${JSON.stringify(wiring.severity ?? null)}`,
        );
      }
      if (rule.expr !== null && wiring.expr !== undefined) {
        const a = normalizeExpr(rule.expr);
        const b = normalizeExpr(wiring.expr);
        if (a !== b) {
          errors.push(
            `阅读版告警 "${rule.alert}" 的 expr 与接线版语义不一致（空白归一后仍不同）：阅读版 "${a.slice(0, 120)}" vs 接线版 "${b.slice(0, 120)}"`,
          );
        }
      }
    }
  }
  return errors;
}

// ── 实扫 ────────────────────────────────────────────────────────────────────
// 探针：两个源文件若被改名/拆分导致清单空转，这里先炸，不给静默放行的机会。
const INVENTORY_PROBES = [
  "autoflow_execution_result_total",
  "autoflow_scheduler_ticks_total",
];

// 探针：runbook 锚点索引（README §3.6）必须仍有这两条——否则「锚点存在」判据
// 会退化成永远命中或永远不命中，两种都是静默失效。
const RUNBOOK_ANCHOR_PROBES = ["autoflow_scheduler_down", "instance_down"];

// 探针：gauge 清单必须仍能从**两个源**各抽到至少一个（runtime-metrics.ts 的
// RUNTIME_GAUGES 与 service 的 new Gauge）。判据 ③ 的整个有效性挂在名单上：
// 名单空 → findGaugeMisuse 直接返回（见其注释），那就成了「永远不命中」的假绿。
const GAUGE_INVENTORY_PROBES = [
  "autoflow_sse_streams_active", // runtime-metrics.ts RUNTIME_GAUGES
  "autoflow_db_pool_waiting_requests", // prometheus-metrics.service.ts new Gauge
];

function scanReal(root) {
  // 三个受卫面彼此独立：一处解析失败不挡其余两处的对账，最后统一判退出码。
  const failures = [];
  // warn 通道：不改变退出码，但必须打印（判据 ⑤ 只有打印才有价值）。
  const warnings = [];
  const warn = (message) => warnings.push(message);

  // ① 指标清单 + gauge 清单（共享）
  const sourceTexts = [];
  const sourceByFile = new Map();
  for (const rel of METRIC_SOURCES) {
    try {
      const text = readFileSync(join(root, rel), "utf8");
      sourceTexts.push(text);
      sourceByFile.set(rel, text);
    } catch {
      console.error(`✗ 指标清单源不可读：${rel}（metrics 源文件挪动了吗？同步 METRIC_SOURCES）`);
      return 1;
    }
  }
  const inventory = buildMetricInventory(sourceTexts);
  for (const probe of INVENTORY_PROBES) {
    if (!inventory.has(probe)) {
      console.error(
        `✗ 指标清单缺探针 ${probe}——metrics 源文件改名/重构后请同步 METRIC_SOURCES`,
      );
      return 1;
    }
  }
  // gauge 事实源（判据 ③）：runtime-metrics.ts 的 RUNTIME_GAUGES +
  // prometheus-metrics.service.ts 的 new Gauge + INFRA_GAUGES 白名单。
  const gauges = buildGaugeInventory({
    runtimeMetricsText: sourceByFile.get(METRIC_SOURCES[1]) ?? "",
    serviceText: sourceByFile.get(METRIC_SOURCES[0]) ?? "",
  });
  for (const probe of GAUGE_INVENTORY_PROBES) {
    if (!gauges.has(probe)) {
      console.error(
        `✗ gauge 清单缺探针 ${probe}——RUNTIME_GAUGES 或 new Gauge 的抽取出问题了？修好再跑（否则「对 gauge 用 rate」判据会静默失效）`,
      );
      return 1;
    }
  }
  // 判据 ⑤ 的定量基准：抓取间隔。读不到就用默认 15s 并明示（不静默）。
  let scrapeIntervalSeconds = DEFAULT_SCRAPE_INTERVAL_SECONDS;
  try {
    const parsed = readScrapeIntervalSeconds(
      readFileSync(join(root, SCRAPE_CONFIG_FILE), "utf8"),
    );
    if (parsed !== null && parsed > 0) {
      scrapeIntervalSeconds = parsed;
    } else {
      warn(
        `${SCRAPE_CONFIG_FILE} 里读不到 global.scrape_interval，判据 ⑤（for vs 抓取间隔）退回默认 ${DEFAULT_SCRAPE_INTERVAL_SECONDS}s`,
      );
    }
  } catch {
    warn(
      `${SCRAPE_CONFIG_FILE} 不可读，判据 ⑤（for vs 抓取间隔）退回默认 ${DEFAULT_SCRAPE_INTERVAL_SECONDS}s`,
    );
  }

  // ② 接线版 alerts.yml：结构 + 指标名 + runbook_url + expr 静态体检
  let doc;
  let alertsText = null;
  try {
    alertsText = readFileSync(join(root, ALERTS_FILE), "utf8");
    doc = parseYamlSubset(alertsText);
  } catch (err) {
    failures.push(`${ALERTS_FILE} 解析失败：${err.message}`);
    doc = null;
  }
  // runbook_url 的锚点面：两个文档的标题 slug 合集。文档被移走/锚点被删时
  // 立刻红（否则「链接都在、全是死链」这种形态没人看得见）。
  const runbookDocTexts = [];
  for (const rel of RUNBOOK_DOC_FILES) {
    try {
      runbookDocTexts.push(readFileSync(join(root, rel), "utf8"));
    } catch {
      failures.push(
        `${rel} 不可读（runbook_url 的锚点落点被移走/改名了吗？同步 RUNBOOK_DOC_FILES）`,
      );
    }
  }
  const runbookAnchors = collectDocAnchors(runbookDocTexts);
  // 探针：runbook 索引真的在（否则整批判据会退化成「只要 URL 有 http 前缀就放行」）
  for (const probe of RUNBOOK_ANCHOR_PROBES) {
    if (!runbookAnchors.has(probe)) {
      failures.push(
        `runbook 锚点面缺探针 "#${probe}"——${RUNBOOK_DOC_FILES.join(" / ")} 的标题结构变了？修好再跑（否则死链判据空转）`,
      );
    }
  }
  let ruleCount = 0;
  let exprChecked = 0;
  // 语义级对账的数据源：接线版规则的 (alert, expr, for, severity) 四元组。
  // 仅在接线版自身守卫通过时构建——接线版红时语义对账退回轻量模式（它自己的
  // 违规已在上报队列里，不叠加噪声）。
  let wiringRules = null;
  if (doc) {
    const errors = validateAlertsDocument(doc, {
      metricNames: inventory,
      runbookAnchors,
      gauges,
      scrapeIntervalSeconds,
      alertLines: alertsText === null ? null : mapAlertFieldLines(alertsText),
      onWarn: warn,
    });
    if (errors.length > 0) {
      failures.push(`${ALERTS_FILE}：${errors.length} 处违规\n  - ${errors.join("\n  - ")}`);
    } else {
      wiringRules = (doc.groups ?? []).flatMap((group) =>
        (Array.isArray(group?.rules) ? group.rules : []).map((rule) => ({
          alert: rule?.alert,
          expr: rule?.expr,
          for: rule?.for ?? null,
          severity: rule?.labels?.severity ?? null,
        })),
      );
      ruleCount = doc.groups.reduce(
        (n, group) => n + (Array.isArray(group?.rules) ? group.rules.length : 0),
        0,
      );
      exprChecked = wiringRules.filter((rule) => typeof rule.expr === "string").length;
      console.log(
        `✓ ${ALERTS_FILE}：${doc.groups.length} 个 group / ${ruleCount} 条规则全部通过结构、指标名、runbook_url（绝对 URL + 锚点存在）与 expr 静态体检（配平/恒真恒假/gauge 误用/阈值面；gauge 事实源 ${gauges.size} 个，抓取间隔 ${scrapeIntervalSeconds}s）`,
      );
    }
  }

  // ③ dashboard：面板 expr + 模板变量 → 同一清单（审计批次 A）
  let dashboard;
  try {
    dashboard = JSON.parse(readFileSync(join(root, DASHBOARD_FILE), "utf8"));
  } catch (err) {
    failures.push(`${DASHBOARD_FILE} 解析失败：${err.message}`);
    dashboard = null;
  }
  if (dashboard) {
    const errors = validateDashboardDocument(dashboard, { metricNames: inventory });
    if (errors.length > 0) {
      failures.push(`${DASHBOARD_FILE}：${errors.length} 处违规\n  - ${errors.join("\n  - ")}`);
    } else {
      console.log(
        `✓ ${DASHBOARD_FILE}：面板与模板变量引用的指标全部在清单内（指标清单 ${inventory.size} 个）`,
      );
    }
  }

  // ④ 阅读版 alerting-rules.yml：存在性 + 指标名对账（审计批次 A）
  let readingRules;
  try {
    readingRules = readFileSync(join(root, READING_RULES_FILE), "utf8");
  } catch {
    failures.push(`${READING_RULES_FILE} 不可读（阅读版告警被移走/改名了吗？）`);
    readingRules = null;
  }
  if (readingRules !== null) {
    const errors = validateReadingRulesText(readingRules, {
      metricNames: inventory,
      wiringRules,
    });
    if (errors.length > 0) {
      failures.push(`${READING_RULES_FILE}：${errors.length} 处违规\n  - ${errors.join("\n  - ")}`);
    } else {
      console.log(
        `✓ ${READING_RULES_FILE}：指标名对账通过 + ${wiringRules ? `语义级对账通过（for/severity/expr 归一，对 ${wiringRules.length} 条接线规则）` : "语义对账跳过（接线版未过守卫）"}`,
      );
    }
  }

  // warn 通道：判据 ⑤（for vs 抓取间隔）与「配置读不到」这类提示。刻意不改变
  // 退出码（短 for 合法），但必须打印——不打印的判据等于不存在。
  for (const message of warnings) console.warn(`⚠ ${message}`);

  if (failures.length > 0) {
    for (const failure of failures) console.error(`✗ ${failure}`);
    return 1;
  }
  console.log(
    `✓ 告警/看板同源守卫全绿（指标清单 ${inventory.size} 个含 INFRA 白名单；gauge 清单 ${gauges.size} 个；expr 体检覆盖 ${exprChecked} 条规则；warn ${warnings.length} 条）`,
  );
  return 0;
}

// ── selftest ────────────────────────────────────────────────────────────────
// 内置 fixture 验证解析器与判据本身：好样例零报错、每类坏样例必须被拦截且
// 报错信息命中预期关键词。
const GOOD_FIXTURE_YAML = `groups:
  - name: demo
    rules:
      - alert: TEST_UP
        expr: up == 0
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: '实例不可达'
          description: '排查指引：先看进程存活。'
          runbook_url: "https://example.com/runbooks#test_up"
      - alert: TEST_QUEUE_RATE
        expr: sum(rate(autoflow_queue_up[5m])) == 0
        for: 10m
        labels:
          severity: critical
        annotations:
          summary: '队列不可读'
          description: '排查指引：看 Redis。'
          runbook_url: "https://example.com/runbooks#test_queue_rate"
`;

// 死链判据用的陪跑锚点集（= collectDocAnchors 的产物形态）
const FIXTURE_ANCHORS = new Set(["test_up", "test_queue_rate", "test-down"]);

const SELFTEST_FIXTURES = [
  {
    name: "好样例（结构完整 + 指标在清单）应零报错",
    yaml: GOOD_FIXTURE_YAML,
    sources: ['const x = "autoflow_queue_up";'],
    expected: [],
  },
  {
    name: "缺 for 应被拦截",
    yaml: GOOD_FIXTURE_YAML.replace("        for: 5m\n", ""),
    sources: [],
    expected: ["缺少合法的 for"],
  },
  {
    name: "severity 非法应被拦截",
    yaml: GOOD_FIXTURE_YAML.replace("severity: warning", "severity: info"),
    sources: [],
    expected: ["labels.severity"],
  },
  {
    name: "缺 annotations.summary 应被拦截",
    yaml: GOOD_FIXTURE_YAML.replace("          summary: '实例不可达'\n", ""),
    sources: [],
    expected: ["annotations.summary"],
  },
  {
    name: "缺 annotations.description 应被拦截",
    yaml: GOOD_FIXTURE_YAML.replace("          description: '排查指引：先看进程存活。'\n", ""),
    sources: [],
    expected: ["annotations.description"],
  },
  // ── OBS3-06：runbook 通道（绝对 URL + 锚点存在）──
  {
    name: "缺 annotations.runbook_url 应被拦截（通道空转的形态）",
    yaml: GOOD_FIXTURE_YAML.replace(
      '          runbook_url: "https://example.com/runbooks#test_up"\n',
      "",
    ),
    sources: [],
    expected: ["runbook_url 缺失"],
  },
  {
    name: "runbook_url 是相对路径应被拦截",
    yaml: GOOD_FIXTURE_YAML.replace(
      "https://example.com/runbooks#test_up",
      "docs/observability/README.md#test_up",
    ),
    sources: [],
    expected: ["绝对 URL"],
  },
  {
    name: "runbook_url 不带锚点应被拦截",
    yaml: GOOD_FIXTURE_YAML.replace(
      "https://example.com/runbooks#test_up",
      "https://example.com/runbooks",
    ),
    sources: [],
    expected: ["必须带 #锚点"],
  },
  {
    name: "runbook_url 的锚点不存在（死链）应被拦截",
    yaml: GOOD_FIXTURE_YAML.replace(
      "https://example.com/runbooks#test_up",
      "https://example.com/runbooks#test_up_typo",
    ),
    sources: [],
    expected: ["死链"],
  },
  {
    name: "臆造指标名应被拦截",
    yaml: GOOD_FIXTURE_YAML.replace(
      "sum(rate(autoflow_queue_up[5m])) == 0",
      "sum(rate(autoflow_definitely_not_exist_total[5m])) == 0",
    ),
    sources: ['const x = "autoflow_queue_up";'],
    expected: ["清单外的指标"],
  },
  {
    name: "alert 名重复应被拦截",
    yaml: GOOD_FIXTURE_YAML.replace("TEST_QUEUE_RATE", "TEST_UP"),
    sources: [],
    expected: ["alert 名重复"],
  },
  {
    name: "无法解析的 YAML 应报解析错误",
    yaml: "groups:\n  - name: demo\n    rules:\n      just free text\n",
    sources: [],
    expected: ["无法解析的行"],
  },
  {
    name: "块标量应报不支持",
    yaml: GOOD_FIXTURE_YAML.replace("expr: up == 0", "expr: |\n          up == 0"),
    sources: [],
    expected: ["不支持块标量"],
  },
  // ── expr 静态体检（审计 T1）：① 配平/截断 · ② 恒真恒假 · ③ gauge 误用 ·
  //    ④ 阈值面 · ⑤ for vs 抓取间隔（warn）──────────────────────────────
  {
    name: "体检①：expr 以 == 结尾（截断形态）应被拦截",
    yaml: GOOD_FIXTURE_YAML.replace("expr: up == 0", "expr: up =="),
    sources: [],
    expected: ["以运算符"],
  },
  {
    name: "体检①：花括号未闭合应被拦截（审计形态 up{job=\"a\"）",
    yaml: GOOD_FIXTURE_YAML.replace("expr: up == 0", 'expr: up{job="a"'),
    sources: [],
    expected: ["没有闭合", "花括号不配平"],
  },
  {
    name: "体检①：圆括号未闭合应被拦截",
    yaml: GOOD_FIXTURE_YAML.replace("expr: up == 0", "expr: (up == 0"),
    sources: [],
    expected: ["没有闭合"],
  },
  {
    name: "体检①：多余右括号应被拦截",
    yaml: GOOD_FIXTURE_YAML.replace("expr: up == 0", "expr: up == 0)"),
    sources: [],
    expected: ["多余的右括号"],
  },
  {
    name: "体检①：括号配错（嵌套不合法）应被拦截",
    yaml: GOOD_FIXTURE_YAML.replace("expr: up == 0", "expr: sum(up[5m) > 0"),
    sources: [],
    expected: ["配错"],
  },
  {
    name: "体检①：引号未闭合应被拦截",
    yaml: GOOD_FIXTURE_YAML.replace("expr: up == 0", 'expr: up{job="a} == 0'),
    sources: [],
    expected: ["引号", "没有闭合"],
  },
  {
    name: "体检①：转义引号不应误报（\\\" 是合法转义）",
    yaml: GOOD_FIXTURE_YAML.replace("expr: up == 0", 'expr: up{job="a\\"b"} == 0'),
    sources: ['const x = "autoflow_queue_up";'],
    expected: [],
  },
  {
    name: "体检②：0 == 0（恒真）应被拦截",
    yaml: GOOD_FIXTURE_YAML.replace("expr: up == 0", "expr: 0 == 0"),
    sources: [],
    expected: ["常量对常量", "恒为真"],
  },
  {
    name: "体检②：1 == 1（恒真）应被拦截",
    yaml: GOOD_FIXTURE_YAML.replace("expr: up == 0", "expr: 1 == 1"),
    sources: [],
    expected: ["恒为真"],
  },
  {
    name: "体检②：vector(1) > 2（恒假）应被拦截",
    yaml: GOOD_FIXTURE_YAML.replace("expr: up == 0", "expr: vector(1) > 2"),
    sources: [],
    expected: ["恒为假"],
  },
  {
    name: "体检②：纯布尔常量 true 应被拦截",
    yaml: GOOD_FIXTURE_YAML.replace("expr: up == 0", "expr: true"),
    sources: [],
    expected: ["布尔常量"],
  },
  {
    name: "体检③：对 gauge 用 rate 应被拦截（事实源写进报错）",
    yaml: GOOD_FIXTURE_YAML.replace(
      "sum(rate(autoflow_queue_up[5m])) == 0",
      "sum(rate(autoflow_demo_gauge[5m])) == 0",
    ),
    sources: ['const x = "autoflow_queue_up";', 'const y = "autoflow_demo_gauge";'],
    gauges: new Map([["autoflow_demo_gauge", "fixture：new Gauge({ name: … })"]]),
    expected: ["对 gauge 指标", "rate()", "fixture：new Gauge"],
  },
  {
    name: "体检③：对 gauge 用 increase 应被拦截",
    yaml: GOOD_FIXTURE_YAML.replace(
      "sum(rate(autoflow_queue_up[5m])) == 0",
      "sum(increase(autoflow_demo_gauge[5m])) > 0",
    ),
    sources: ['const x = "autoflow_queue_up";', 'const y = "autoflow_demo_gauge";'],
    gauges: new Map([["autoflow_demo_gauge", "fixture：RUNTIME_GAUGES"]]),
    expected: ["increase()", "RUNTIME_GAUGES"],
  },
  {
    name: "体检③：histogram_quantile 输入里没有 *_bucket 应被拦截",
    yaml: GOOD_FIXTURE_YAML.replace(
      "sum(rate(autoflow_queue_up[5m])) == 0",
      "histogram_quantile(0.99, sum(rate(autoflow_http_requests_total[5m]))) > 2",
    ),
    sources: [
      'const x = "autoflow_queue_up";',
      'const y = "autoflow_http_requests_total";',
    ],
    expected: ["histogram_quantile", "*_bucket"],
  },
  {
    name: "体检③：histogram_quantile 的 *_bucket 形态应放行（不误伤真实规则）",
    yaml: GOOD_FIXTURE_YAML.replace(
      "sum(rate(autoflow_queue_up[5m])) == 0",
      "histogram_quantile(0.99, sum by (le) (rate(autoflow_http_duration_bucket[5m]))) > 2000",
    ),
    sources: [
      'const x = "autoflow_queue_up";',
      'const y = "autoflow_http_duration_bucket";',
    ],
    gauges: new Map([["autoflow_queue_up", "fixture"]]),
    expected: [],
  },
  {
    name: "体检④：裸指标（无比较运算符）应被拦截",
    yaml: GOOD_FIXTURE_YAML.replace("expr: up == 0", "expr: up"),
    sources: [],
    expected: ["没有任何比较运算符"],
  },
  {
    name: "体检④：absent() 是豁免形态（缺席检测不需要比较）",
    yaml: GOOD_FIXTURE_YAML.replace("expr: up == 0", "expr: absent(autoflow_queue_up)"),
    sources: ['const x = "autoflow_queue_up";'],
    expected: [],
  },
  {
    name: "体检④：label selector 里的 != 不算比较（裸指标仍应被拦截）",
    yaml: GOOD_FIXTURE_YAML.replace('expr: up == 0', 'expr: autoflow_queue_up{state!="x"}'),
    sources: ['const x = "autoflow_queue_up";'],
    expected: ["没有任何比较运算符"],
  },
  {
    name: "体检⑤：for 小于 2×抓取间隔应 warn（不红）",
    yaml: GOOD_FIXTURE_YAML.replace("for: 5m", "for: 20s"),
    sources: ['const x = "autoflow_queue_up";'],
    expected: [],
    expectedWarnings: ["小于 2×抓取间隔", "TEST_UP"],
  },
  {
    name: "体检⑤：for = 2×抓取间隔（30s）是边界，不 warn",
    yaml: GOOD_FIXTURE_YAML.replace("for: 5m", "for: 30s"),
    sources: ['const x = "autoflow_queue_up";'],
    expected: [],
    expectedWarnings: [],
  },
];

function runSelftest() {
  let failed = false;
  for (const fixture of SELFTEST_FIXTURES) {
    let doc;
    try {
      doc = parseYamlSubset(fixture.yaml);
    } catch (err) {
      if (fixture.expected.some((keyword) => err.message.includes(keyword))) {
        continue;
      }
      console.error(`✗ selftest「${fixture.name}」解析抛错但不合预期：${err.message}`);
      failed = true;
      continue;
    }
    const warnings = [];
    const errors = validateAlertsDocument(doc, {
      metricNames: buildMetricInventory(fixture.sources),
      runbookAnchors: fixture.runbookAnchors ?? FIXTURE_ANCHORS,
      gauges: fixture.gauges ?? new Map(),
      alertLines: mapAlertFieldLines(fixture.yaml),
      onWarn: (message) => warnings.push(message),
    });
    const missing = fixture.expected.filter(
      (keyword) => !errors.some((error) => error.includes(keyword)),
    );
    if (fixture.expected.length === 0 && errors.length > 0) {
      console.error(`✗ selftest「${fixture.name}」出现意外报错：\n  - ${errors.join("\n  - ")}`);
      failed = true;
    } else if (missing.length > 0) {
      console.error(
        `✗ selftest「${fixture.name}」未命中预期关键词 ${JSON.stringify(missing)}；实际报错：\n  - ${errors.join("\n  - ") || "（无）"}`,
      );
      failed = true;
    }
    // warn 通道断言：判据 ⑤ 只有「打印出来」才有价值，所以既断言命中，也断言
    // 「不该有时没有」（expectedWarnings: [] 表示必须一条都没有）。
    if (Array.isArray(fixture.expectedWarnings)) {
      if (fixture.expectedWarnings.length === 0) {
        if (warnings.length > 0) {
          console.error(
            `✗ selftest「${fixture.name}」不该有 warn，实际：\n  - ${warnings.join("\n  - ")}`,
          );
          failed = true;
        }
      } else {
        const missingWarnings = fixture.expectedWarnings.filter(
          (keyword) => !warnings.some((warning) => warning.includes(keyword)),
        );
        if (missingWarnings.length > 0) {
          console.error(
            `✗ selftest「${fixture.name}」warn 未命中 ${JSON.stringify(missingWarnings)}；实际 warn：\n  - ${warnings.join("\n  - ") || "（无）"}`,
          );
          failed = true;
        }
      }
    }
  }
  // extractMetricNames 的单元断言：stopword 不漏进指标名、selector 被剥净
  const unit = [
    [
      'sum by (channel) (increase(autoflow_notification_delivery_total{result="failure"}[15m])) > 3',
      ["autoflow_notification_delivery_total"],
    ],
    [
      "redis_memory_used_bytes / redis_memory_max_bytes > 0.9 and redis_memory_max_bytes > 0",
      ["redis_memory_used_bytes", "redis_memory_max_bytes"],
    ],
    ["absent(autoflow_scheduler_ticks_total)", ["autoflow_scheduler_ticks_total"]],
  ];
  for (const [expr, wanted] of unit) {
    const got = extractMetricNames(expr);
    for (const name of wanted) {
      if (!got.includes(name)) {
        console.error(`✗ selftest extractMetricNames("${expr}") 缺 ${name}：${JSON.stringify(got)}`);
        failed = true;
      }
    }
    if (got.length !== wanted.length) {
      console.error(
        `✗ selftest extractMetricNames("${expr}") 提取面不净（混入 stopword/selector 残渣）：${JSON.stringify(got)}`,
      );
      failed = true;
    }
  }
  // OBS3-06：锚点 slug 化的单元断言（判据本身不许空转）
  const slugCases = [
    ["#### autoflow_scheduler_down", "autoflow_scheduler_down"],
    ["### instance_down", "instance_down"],
    ["### http-red", "http-red"],
    ["## 3.6 Runbook：逐条告警的锚点", "36-runbook逐条告警的锚点"],
  ];
  for (const [heading, wanted] of slugCases) {
    const got = headingSlug(heading.replace(/^#+\s*/, ""));
    if (got !== wanted) {
      console.error(`✗ selftest headingSlug("${heading}") = "${got}"，期望 "${wanted}"`);
      failed = true;
    }
  }
  const anchorSet = collectDocAnchors([
    "# 标题\n## 3.6 Runbook：逐条告警的锚点\n#### autoflow_scheduler_down\n",
  ]);
  if (!anchorSet.has("autoflow_scheduler_down") || anchorSet.has("autoflow_scheduler_down_typo")) {
    console.error(`✗ selftest collectDocAnchors 抽取面不对：${JSON.stringify([...anchorSet])}`);
    failed = true;
  }
  // 审计批次 A：dashboard 校验与阅读版对账的正反例（同一套判据语义）。
  const dashboardChecks = [
    {
      name: "dashboard 好样例（面板 expr + query 变量均在清单）应零报错",
      doc: {
        panels: [
          { type: "row", title: "row", panels: [] },
          {
            title: "面板一",
            targets: [{ expr: "sum(rate(autoflow_queue_up[$__rate_interval]))" }],
          },
          { title: "进程资源", targets: [{ expr: "process_cpu_seconds_total" }] },
        ],
        templating: {
          list: [
            { type: "datasource", name: "datasource", query: "prometheus" },
            {
              type: "query",
              name: "instance",
              definition: "label_values(autoflow_queue_up, instance)",
              query: { query: "label_values(autoflow_queue_up, instance)" },
            },
          ],
        },
      },
      sources: ['const x = "autoflow_queue_up";'],
      expected: [],
    },
    {
      name: "dashboard 面板臆造指标应被拦截且报错带面板标题",
      doc: { panels: [{ title: "坏板", targets: [{ expr: "autoflow_never_declared_total" }] }] },
      sources: [],
      expected: ["坏板", "清单外的指标"],
    },
    {
      name: "dashboard 模板变量臆造指标应被拦截且报错带变量名",
      doc: {
        panels: [{ title: "p", targets: [] }],
        templating: {
          list: [
            { type: "query", name: "inst", definition: "label_values(autoflow_variable_ghost, instance)" },
          ],
        },
      },
      sources: [],
      expected: ["变量 inst", "清单外的指标"],
    },
    {
      name: "dashboard 空 panels 应被拦截",
      doc: { panels: [] },
      sources: [],
      expected: ["panels 必须是非空列表"],
    },
    {
      name: "科学计数 1e-9 不得提取出假指标 e",
      doc: {
        panels: [
          {
            title: "avg",
            targets: [
              {
                expr:
                  "rate(autoflow_queue_up[5m]) / clamp_min(rate(autoflow_scheduler_ticks_total[5m]), 1e-9)",
              },
            ],
          },
        ],
      },
      sources: ['const x = "autoflow_queue_up";', 'const y = "autoflow_scheduler_ticks_total";'],
      expected: [],
    },
  ];
  for (const check of dashboardChecks) {
    const errors = validateDashboardDocument(check.doc, {
      metricNames: buildMetricInventory(check.sources),
    });
    const missing = check.expected.filter(
      (keyword) => !errors.some((error) => error.includes(keyword)),
    );
    if (check.expected.length === 0 && errors.length > 0) {
      console.error(`✗ selftest「${check.name}」出现意外报错：\n  - ${errors.join("\n  - ")}`);
      failed = true;
    } else if (missing.length > 0) {
      console.error(
        `✗ selftest「${check.name}」未命中预期关键词 ${JSON.stringify(missing)}；实际报错：\n  - ${errors.join("\n  - ") || "（无）"}`,
      );
      failed = true;
    }
  }
  const readingChecks = [
    {
      name: "阅读版好样例应零报错（runbook 锚点不算指标、块标量 expr 可对账）",
      text: [
        "# 头注释：README.md#autoflow_anything_only_in_comment",
        "groups:",
        "  - name: g",
        "    rules:",
        "      - alert: A_DOWN",
        "        expr: |",
        "          autoflow_queue_up == 0",
        "        annotations:",
        '          runbook: "docs/observability/README.md#autoflow_never_a_metric"',
      ].join("\n"),
      sources: ['const x = "autoflow_queue_up";'],
      expected: [],
    },
    {
      name: "阅读版臆造指标应被拦截",
      text: ["groups:", "  - name: g", "    rules:", "      - alert: A_DOWN", "        expr: autoflow_ghost_metric_total > 0"].join("\n"),
      sources: [],
      expected: ["清单外的指标"],
    },
    {
      name: "阅读版 runbook_url 是相对路径应被拦截（OBS3-06）",
      text: [
        "groups:",
        "  - name: g",
        "    rules:",
        "      - alert: A_DOWN",
        "        expr: autoflow_queue_up == 0",
        "        annotations:",
        '          runbook_url: "docs/observability/README.md#a_down"',
      ].join("\n"),
      sources: ['const x = "autoflow_queue_up";'],
      expected: ["绝对 URL"],
    },
    {
      name: "阅读版 runbook_url 是绝对 URL 应放行",
      text: [
        "groups:",
        "  - name: g",
        "    rules:",
        "      - alert: A_DOWN",
        "        expr: autoflow_queue_up == 0",
        "        annotations:",
        '          runbook_url: "https://example.com/runbooks#a_down"',
      ].join("\n"),
      sources: ['const x = "autoflow_queue_up";'],
      expected: [],
    },
    {
      name: "阅读版全被注释（无 alert 条目）应被拦截",
      text: "# - alert: GONE\n#   expr: autoflow_queue_up == 0",
      sources: [],
      expected: ["未找到任何"],
    },
    {
      name: "阅读版为空应被拦截",
      text: "",
      sources: [],
      expected: ["文件为空"],
    },
    // ── 语义级对账（2026-10-07 升级）：wiringRules 在位时的正反例 ──
    {
      name: "语义对账好样例应零报错（块标量 expr 空白归一后与接线版一致）",
      text: [
        "groups:",
        "  - name: g",
        "    rules:",
        "      - alert: A_DOWN",
        "        expr: |",
        "          (autoflow_queue_up == 0)",
        "          or",
        "          (rate(autoflow_scheduler_ticks_total[5m]) == 0)",
        "        for: 5m",
        "        labels:",
        "          severity: critical",
      ].join("\n"),
      sources: ['const x = "autoflow_queue_up";', 'const y = "autoflow_scheduler_ticks_total";'],
      wiringRules: [
        {
          alert: "A_DOWN",
          expr: "(autoflow_queue_up == 0) or\n  (rate(autoflow_scheduler_ticks_total[5m]) == 0)",
          for: "5m",
          severity: "critical",
        },
      ],
      expected: [],
    },
    {
      name: "语义对账：阅读版告警不在接线版应被拦截",
      text: "groups:\n  - name: g\n    rules:\n      - alert: GHOST_ALERT\n        expr: autoflow_queue_up == 0\n        for: 5m\n        labels:\n          severity: critical",
      sources: ['const x = "autoflow_queue_up";'],
      wiringRules: [{ alert: "OTHER", expr: "up", for: "5m", severity: "warning" }],
      expected: ["在接线版"],
    },
    {
      name: "语义对账：for 漂移应被拦截",
      text: "groups:\n  - name: g\n    rules:\n      - alert: A_DOWN\n        expr: autoflow_queue_up == 0\n        for: 10m\n        labels:\n          severity: critical",
      sources: ['const x = "autoflow_queue_up";'],
      wiringRules: [{ alert: "A_DOWN", expr: "autoflow_queue_up == 0", for: "5m", severity: "critical" }],
      expected: ["for 与接线版不一致"],
    },
    {
      name: "语义对账：severity 漂移应被拦截",
      text: "groups:\n  - name: g\n    rules:\n      - alert: A_DOWN\n        expr: autoflow_queue_up == 0\n        for: 5m\n        labels:\n          severity: warning",
      sources: ['const x = "autoflow_queue_up";'],
      wiringRules: [{ alert: "A_DOWN", expr: "autoflow_queue_up == 0", for: "5m", severity: "critical" }],
      expected: ["severity 与接线版不一致"],
    },
    {
      name: "语义对账：expr 漂移应被拦截（实扫抓出的单实例→多实例形态）",
      text: "groups:\n  - name: g\n    rules:\n      - alert: A_DOWN\n        expr: rate(autoflow_scheduler_ticks_total[5m]) == 0\n        for: 5m\n        labels:\n          severity: critical",
      sources: ['const x = "autoflow_scheduler_ticks_total";'],
      wiringRules: [{ alert: "A_DOWN", expr: "sum(rate(autoflow_scheduler_ticks_total[10m])) == 0", for: "5m", severity: "critical" }],
      expected: ["expr 与接线版语义不一致"],
    },
  ];
  for (const check of readingChecks) {
    const errors = validateReadingRulesText(check.text, {
      metricNames: buildMetricInventory(check.sources),
      wiringRules: check.wiringRules ?? null,
    });
    const missing = check.expected.filter(
      (keyword) => !errors.some((error) => error.includes(keyword)),
    );
    if (check.expected.length === 0 && errors.length > 0) {
      console.error(`✗ selftest「${check.name}」出现意外报错：\n  - ${errors.join("\n  - ")}`);
      failed = true;
    } else if (missing.length > 0) {
      console.error(
        `✗ selftest「${check.name}」未命中预期关键词 ${JSON.stringify(missing)}；实际报错：\n  - ${errors.join("\n  - ") || "（无）"}`,
      );
      failed = true;
    }
  }
  // ── expr 体检的单元断言（判据本体，不经 YAML 层）─────────────────────────
  const exprCases = [
    ["up ==", ["以运算符"]],
    ['up{job="a"', ["没有闭合"]],
    ["rate(up[5m]) > 0", ["对 gauge 指标", "rate()"]],
    ["0 == 0", ["恒为真"]],
    ["1 == 1", ["恒为真"]],
    ["vector(1) > 2", ["恒为假"]],
    ["true", ["布尔常量"]],
    ["autoflow_queue_depth", ["没有任何比较运算符"]],
    ["absent(autoflow_x)", []],
    ["(up == 0) or (up == 1)", []],
    ['sum by (channel) (increase(autoflow_notification_delivery_total{result="failure"}[15m])) > 3', []],
    ["histogram_quantile(0.99, sum by (le) (rate(autoflow_http_request_duration_ms_bucket[5m]))) > 2000", []],
  ];
  const unitGauges = new Map([
    ["up", "fixture：Prometheus 内置"],
    ["autoflow_sse_streams_active", "fixture：RUNTIME_GAUGES"],
  ]);
  for (const [expr, wanted] of exprCases) {
    const got = inspectAlertExpr(expr, { gauges: unitGauges });
    const missingKeywords = wanted.filter(
      (keyword) => !got.some((message) => message.includes(keyword)),
    );
    if (missingKeywords.length > 0) {
      console.error(
        `✗ selftest inspectAlertExpr(${JSON.stringify(expr)}) 未命中 ${JSON.stringify(missingKeywords)}：${JSON.stringify(got)}`,
      );
      failed = true;
    } else if (wanted.length === 0 && got.length > 0) {
      console.error(
        `✗ selftest inspectAlertExpr(${JSON.stringify(expr)}) 不应报错，实际：${JSON.stringify(got)}`,
      );
      failed = true;
    }
  }
  // gauge 事实源抽取器：两个源各抽各的，引号里的花括号/括号不得干扰。
  const runtimeFixture = [
    "export type RuntimeGaugeName = keyof typeof RUNTIME_GAUGES;",
    "export const RUNTIME_GAUGES: Record<RuntimeGaugeName, Spec> = {",
    "  autoflow_demo_runtime_a: {",
    '    help: "含花括号 { 与括号 ( 的 help 文案，不能干扰抽取",',
    "  },",
    "  autoflow_demo_runtime_b: {",
    '    help: "b",',
    "  },",
    "};",
  ].join("\n");
  const serviceFixture = [
    "this.a = new Gauge({",
    '  name: "autoflow_demo_service_a",',
    '  help: "help 里有 } 与 )",',
    "});",
    "this.b = new Gauge({ name: \"autoflow_demo_service_b\" });",
    "this.counter = new Counter({ name: \"autoflow_demo_counter_total\" });",
  ].join("\n");
  const runtimeGauges = collectRuntimeGaugeNames(runtimeFixture);
  const serviceGauges = collectServiceGaugeNames(serviceFixture);
  if (
    runtimeGauges.length !== 2 ||
    !runtimeGauges.includes("autoflow_demo_runtime_a") ||
    !runtimeGauges.includes("autoflow_demo_runtime_b")
  ) {
    console.error(`✗ selftest collectRuntimeGaugeNames 抽取面不对：${JSON.stringify(runtimeGauges)}`);
    failed = true;
  }
  if (
    serviceGauges.length !== 2 ||
    !serviceGauges.includes("autoflow_demo_service_a") ||
    !serviceGauges.includes("autoflow_demo_service_b")
  ) {
    console.error(`✗ selftest collectServiceGaugeNames 抽取面不对：${JSON.stringify(serviceGauges)}`);
    failed = true;
  }
  const gaugeInventory = buildGaugeInventory({
    runtimeMetricsText: runtimeFixture,
    serviceText: serviceFixture,
  });
  for (const name of [
    "up",
    "autoflow_demo_runtime_a",
    "autoflow_demo_service_a",
  ]) {
    if (!gaugeInventory.has(name)) {
      console.error(`✗ selftest buildGaugeInventory 漏了 ${name}`);
      failed = true;
    }
  }
  if (gaugeInventory.has("autoflow_demo_counter_total")) {
    console.error("✗ selftest buildGaugeInventory 把 Counter 当成了 gauge");
    failed = true;
  }
  // 时长解析与抓取间隔读取（判据 ⑤ 的定量基准）
  const durationCases = [
    ["15s", 15],
    ["1m", 60],
    ["2m", 120],
    ["500ms", 0.5],
    ["1h", 3600],
    ["5", null],
    ["1x", null],
  ];
  for (const [text, wanted] of durationCases) {
    const got = durationToSeconds(text);
    if (got !== wanted) {
      console.error(`✗ selftest durationToSeconds(${JSON.stringify(text)}) = ${got}，期望 ${wanted}`);
      failed = true;
    }
  }
  if (readScrapeIntervalSeconds("global:\n  scrape_interval: 15s\n") !== 15) {
    console.error("✗ selftest readScrapeIntervalSeconds 读不出 global.scrape_interval");
    failed = true;
  }
  // 行号映射：报错点名 ALERTNAME:line 的依据本身要有反证。
  const lineFixture = [
    "groups:",
    "  - name: g",
    "    rules:",
    "      - alert: A_ONE",
    "        expr: up == 0",
    "        for: 5m",
    "        annotations:",
    "          summary: 'x'",
    "      - alert: A_TWO",
    "        expr: up == 1",
    "        for: 10m",
  ].join("\n");
  const lineMap = mapAlertFieldLines(lineFixture);
  if (lineMap.get("A_ONE")?.exprLine !== 5 || lineMap.get("A_ONE")?.forLine !== 6) {
    console.error(`✗ selftest mapAlertFieldLines A_ONE 行号不对：${JSON.stringify(lineMap.get("A_ONE"))}`);
    failed = true;
  }
  if (lineMap.get("A_TWO")?.exprLine !== 10 || lineMap.get("A_TWO")?.forLine !== 11) {
    console.error(`✗ selftest mapAlertFieldLines A_TWO 行号不对：${JSON.stringify(lineMap.get("A_TWO"))}`);
    failed = true;
  }
  // ── 退出码级反证（照 check-metric-docs 的模板）──────────────────────────
  // 上面所有 fixture 都只断言「errors 数组里含某关键词」——实扫路径与退出码仍
  // 是自检盲区。这一段把**真实规则**拷进临时树，用审计实证的坏形态逐条改写，
  // spawn 本脚本断言**退出码** + 关键报错文本 + `ALERTNAME:line` 点名。
  const exitCodeFailed = runExitCodeChecks();
  if (exitCodeFailed) failed = true;
  if (failed) {
    console.error("✗ check-alerts-rules selftest 未全绿");
    return 1;
  }
  console.log(
    `✓ check-alerts-rules selftest 全绿（${SELFTEST_FIXTURES.length} 个 alerts fixture + ${unit.length} 个提取断言 + ${exprCases.length} 个 expr 体检断言 + ${dashboardChecks.length} 个 dashboard fixture + ${readingChecks.length} 个阅读版 fixture + ${EXIT_CODE_CASES.length} 个退出码反证）`,
  );
  return 0;
}

// ── 退出码反证：临时树 + spawn 自身 ─────────────────────────────────────────
// 用例形态：把 alerts.yml 里某条规则的 expr/for 换成坏形态，跑一遍**真实**入口，
// 断言退出码与报错文本。行号用这里独立实现的 fieldLine 计算（不复用被测代码），
// 这样「报错点名 ALERTNAME:line」这条要求在 selftest 里也是可反证的。
const EXIT_CODE_CASES = [
  { name: "基线（真实规则原样）应 exit 0", status: 0, contains: ["告警/看板同源守卫全绿"] },
  {
    name: "坏形态①：expr 以 == 结尾（up ==）",
    alert: "InstanceDown",
    field: "expr",
    value: "up ==",
    status: 1,
    contains: ["以运算符", "InstanceDown:${expr}"],
  },
  {
    name: '坏形态②：花括号/引号不配平（up{job="a）',
    alert: "InstanceDown",
    field: "expr",
    value: 'up{job="a',
    status: 1,
    contains: ["没有闭合", "InstanceDown:${expr}"],
  },
  {
    name: "坏形态③：对 gauge 用 rate（rate(up[5m])）",
    alert: "InstanceDown",
    field: "expr",
    value: "rate(up[5m]) > 0",
    status: 1,
    contains: ["对 gauge 指标", "rate()", "InstanceDown:${expr}"],
  },
  {
    name: "坏形态④：恒真（0 == 0）",
    alert: "InstanceDown",
    field: "expr",
    value: "0 == 0",
    status: 1,
    contains: ["恒为真", "InstanceDown:${expr}"],
  },
  {
    name: "坏形态⑤：恒假（vector(1) > 2）",
    alert: "InstanceDown",
    field: "expr",
    value: "vector(1) > 2",
    status: 1,
    contains: ["恒为假", "InstanceDown:${expr}"],
  },
  {
    name: "判据④：裸指标没有阈值面（autoflow_queue_depth）",
    alert: "AUTOFLOW_QUEUE_BACKLOG",
    field: "expr",
    value: "autoflow_queue_depth",
    status: 1,
    contains: ["没有任何比较运算符", "AUTOFLOW_QUEUE_BACKLOG:${expr}"],
  },
  {
    name: "判据①：纯布尔常量（false）",
    alert: "InstanceDown",
    field: "expr",
    value: "false",
    status: 1,
    contains: ["布尔常量", "InstanceDown:${expr}"],
  },
  {
    name: "判据③：RUNTIME_GAUGES 里的 gauge 也不许 rate（事实源点名）",
    alert: "AUTOFLOW_SSE_STREAM_CAPACITY_HIGH",
    field: "expr",
    value: "rate(autoflow_sse_streams_active[5m]) > 0",
    status: 1,
    contains: ["RUNTIME_GAUGES", "AUTOFLOW_SSE_STREAM_CAPACITY_HIGH:${expr}"],
  },
  {
    name: "判据③：service 的 new Gauge 也不许 increase（事实源点名）",
    alert: "AUTOFLOW_DB_POOL_WAITING",
    field: "expr",
    value: "increase(autoflow_db_pool_waiting_requests[10m]) > 0",
    status: 1,
    contains: ["new Gauge", "increase()", "AUTOFLOW_DB_POOL_WAITING:${expr}"],
  },
  {
    name: "判据③：histogram_quantile 输入里没有 *_bucket",
    alert: "AUTOFLOW_HTTP_LATENCY_P99_HIGH",
    field: "expr",
    value: "histogram_quantile(0.99, autoflow_http_requests_total) > 2000",
    status: 1,
    contains: ["histogram_quantile", "*_bucket", "AUTOFLOW_HTTP_LATENCY_P99_HIGH:${expr}"],
  },
  {
    name: "判据④未退化：臆造指标名仍被拦截",
    alert: "InstanceDown",
    field: "expr",
    value: "up_ghost_metric == 0",
    status: 1,
    contains: ["清单外的指标", "InstanceDown:${expr}"],
  },
  {
    name: "判据⑤：for 过短只 warn 不改退出码（for: 20s）",
    alert: "InstanceDown",
    field: "for",
    value: "20s",
    status: 0,
    contains: ["⚠", "小于 2×抓取间隔", "InstanceDown:${for}"],
  },
  // 下界反证：判据 ③ 的整个有效性挂在 gauge 名单上，所以「名单空转」本身必须红
  // （对应 GAUGE_INVENTORY_PROBES）。没有这两条，把探针循环删掉自检照样全绿。
  {
    name: "下界：service 的 new Gauge 全部消失 → gauge 名单空转即红",
    sourceFile: METRIC_SOURCES[0],
    sourceFind: "new Gauge(",
    sourceReplace: "new Counter(",
    status: 1,
    contains: ["gauge 清单缺探针", "autoflow_db_pool_waiting_requests"],
  },
  {
    name: "下界：RUNTIME_GAUGES 被改名 → gauge 名单空转即红",
    sourceFile: METRIC_SOURCES[1],
    sourceFind: "export const RUNTIME_GAUGES",
    sourceReplace: "export const RUNTIME_GAUGE_SPECS",
    status: 1,
    contains: ["gauge 清单缺探针", "autoflow_sse_streams_active"],
  },
];

/** 按 alert 名替换某字段的行内容（找不到就返回 null，绝不静默跳过）。 */
function mutateAlertField(text, alertName, field, value) {
  const rows = String(text).split(/\r?\n/);
  const start = rows.findIndex((row) =>
    new RegExp(`^\\s*-\\s+alert:\\s*${alertName}\\s*$`).test(row),
  );
  if (start < 0) return null;
  for (let i = start + 1; i < rows.length; i += 1) {
    if (/^\s*-\s+alert:/.test(rows[i])) break;
    const match = rows[i].match(new RegExp(`^(\\s*)${field}:\\s*\\S`));
    if (match) {
      rows[i] = `${match[1]}${field}: ${value}`;
      return rows.join("\n");
    }
  }
  return null;
}

/** 独立实现的行号查找（1 基）：不复用 mapAlertFieldLines，避免自证。 */
function fieldLine(text, alertName, field) {
  const rows = String(text).split(/\r?\n/);
  const start = rows.findIndex((row) =>
    new RegExp(`^\\s*-\\s+alert:\\s*${alertName}\\s*$`).test(row),
  );
  if (start < 0) return null;
  for (let i = start + 1; i < rows.length; i += 1) {
    if (/^\s*-\s+alert:/.test(rows[i])) break;
    if (new RegExp(`^\\s*${field}:\\s*\\S`).test(rows[i])) return i + 1;
  }
  return null;
}

function runExitCodeChecks() {
  let failed = false;
  const dir = mkdtempSync(join(tmpdir(), "alerts-guard-selftest-"));
  try {
    const copied = [
      ALERTS_FILE,
      DASHBOARD_FILE,
      READING_RULES_FILE,
      SCRAPE_CONFIG_FILE,
      ...METRIC_SOURCES,
      ...RUNBOOK_DOC_FILES,
    ];
    for (const rel of copied) {
      const destination = join(dir, rel);
      mkdirSync(dirname(destination), { recursive: true });
      copyFileSync(join(SCRIPT_ROOT, rel), destination);
    }
    const alertsPath = join(dir, ALERTS_FILE);
    const original = readFileSync(alertsPath, "utf8");
    for (const check of EXIT_CODE_CASES) {
      let content = original;
      let sourcePath = null;
      let sourceOriginal = null;
      if (check.sourceFile) {
        sourcePath = join(dir, check.sourceFile);
        sourceOriginal = readFileSync(sourcePath, "utf8");
        if (!sourceOriginal.includes(check.sourceFind)) {
          console.error(
            `✗ selftest「${check.name}」变异未生效：${check.sourceFile} 里找不到 ${JSON.stringify(check.sourceFind)}`,
          );
          failed = true;
          continue;
        }
        writeFileSync(
          sourcePath,
          sourceOriginal.replaceAll(check.sourceFind, check.sourceReplace),
        );
      }
      if (check.field) {
        content = mutateAlertField(original, check.alert, check.field, check.value);
        if (content === null) {
          console.error(
            `✗ selftest「${check.name}」变异未生效：${ALERTS_FILE} 里找不到 ${check.alert} 的 ${check.field}`,
          );
          failed = true;
          continue;
        }
        writeFileSync(alertsPath, content);
      }
      const result = spawnSync(process.execPath, [SELF_PATH, "--root", dir], {
        encoding: "utf8",
      });
      if (check.field) writeFileSync(alertsPath, original);
      if (sourcePath !== null) writeFileSync(sourcePath, sourceOriginal);
      const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
      const line =
        check.field && check.alert
          ? fieldLine(original, check.alert, check.field)
          : null;
      const wanted = check.contains.map((keyword) =>
        keyword.replace(/\$\{expr\}/g, String(line)).replace(/\$\{for\}/g, String(line)),
      );
      if (result.status !== check.status) {
        console.error(
          `✗ selftest「${check.name}」退出码 ${result.status}，期望 ${check.status}。输出：\n${output}`,
        );
        failed = true;
        continue;
      }
      const missing = wanted.filter((keyword) => !output.includes(keyword));
      if (missing.length > 0) {
        console.error(
          `✗ selftest「${check.name}」输出未命中 ${JSON.stringify(missing)}。输出：\n${output}`,
        );
        failed = true;
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return failed;
}

// ── 入口 ────────────────────────────────────────────────────────────────────
// 只有**直接执行**时才跑（import 不再触发实扫并 process.exit——审计 §2.1 ④
// 记录过这个副作用：判据函数不可 import，任何新自检都写不了）。
const invokedDirectly =
  typeof process.argv[1] === "string" &&
  resolve(process.argv[1]) === resolve(SELF_PATH);

function resolveRootArg(argv) {
  const index = argv.indexOf("--root");
  if (index >= 0 && typeof argv[index + 1] === "string" && argv[index + 1] !== "") {
    return resolve(argv[index + 1]);
  }
  return SCRIPT_ROOT;
}

if (invokedDirectly) {
  if (process.argv.includes("--selftest")) {
    process.exit(runSelftest());
  }
  process.exit(scanReal(resolveRootArg(process.argv)));
}
