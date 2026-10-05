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
//     教学载体，块标量/`>-` 写法不在受限解析器射程内），只做轻量对账：
//     文件存在、至少含一条 alert、注释剥离后引用的每个 autoflow_* 指标名
//     都在清单内（runbook 注释里的 `#锚点` 同名串不算指标）。语义一致性
//     仍以 alerts.yml 为准（文件头已声明），此处不要求规则集全等。
//
// 退出码：0 = 全绿；1 = 解析失败 / 结构违规 / 指标名不在清单。
//
// 用法：node scripts/check-alerts-rules.mjs [--selftest]
//   （根 package.json 的 test:alerts = --selftest + 实扫）
//   --selftest：用内置 fixture 验证解析器与判据本身（不扫真实代码库）。

import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const ALERTS_FILE = "config/monitoring/alerts.yml";
const DASHBOARD_FILE = "docs/observability/grafana-dashboard.json";
const READING_RULES_FILE = "docs/observability/alerting-rules.yml";

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

// ── 规则校验 ────────────────────────────────────────────────────────────────
const FOR_DURATION = /^\d+(ms|s|m|h|d)$/;
const ALERT_NAME = /^[A-Za-z][A-Za-z0-9_]*$/;

export function validateAlertsDocument(doc, { metricNames }) {
  const errors = [];
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
      if (typeof rule.expr === "string") {
        for (const metric of extractMetricNames(rule.expr)) {
          if (!metricNames.has(metric)) {
            errors.push(
              `${where}(${alert}): 表达式引用了清单外的指标 "${metric}"（先在 metrics 源文件/METRIC_SOURCES 或 INFRA_METRICS 登记）`,
            );
          }
        }
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

// ── 阅读版告警轻量对账（审计批次 A）─────────────────────────────────────────
// alerting-rules.yml 大量使用块标量（expr: | / description: >-），不在受限
// 解析器射程内，也不必为阅读版实现完整 YAML——只做两件事：
//   ① 存在性：注释剥离后至少还有一条 `- alert:`（文件被清空/误删即红）；
//   ② 指标名对账：剥注释行（含块标量内的 PromQL `#` 注释行）后出现的每个
//      autoflow_* 字面量必须在清单内。runbook annotation 的 URL 锚点
//      （README.md#autoflow_scheduler_down）与指标同名，按前导 `#` 排除。
// 语义一致性（阈值/for/severity）不在对账范围——以接线版 alerts.yml 为准。
export function validateReadingRulesText(text, { metricNames }) {
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
  return errors;
}

// ── 实扫 ────────────────────────────────────────────────────────────────────
// 探针：两个源文件若被改名/拆分导致清单空转，这里先炸，不给静默放行的机会。
const INVENTORY_PROBES = [
  "autoflow_execution_result_total",
  "autoflow_scheduler_ticks_total",
];

function scanReal() {
  // 三个受卫面彼此独立：一处解析失败不挡其余两处的对账，最后统一判退出码。
  const failures = [];

  // ① 指标清单（共享）
  const sourceTexts = [];
  for (const rel of METRIC_SOURCES) {
    try {
      sourceTexts.push(readFileSync(join(ROOT, rel), "utf8"));
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

  // ② 接线版 alerts.yml：结构 + 指标名
  let doc;
  try {
    doc = parseYamlSubset(readFileSync(join(ROOT, ALERTS_FILE), "utf8"));
  } catch (err) {
    failures.push(`${ALERTS_FILE} 解析失败：${err.message}`);
    doc = null;
  }
  let ruleCount = 0;
  if (doc) {
    const errors = validateAlertsDocument(doc, { metricNames: inventory });
    if (errors.length > 0) {
      failures.push(`${ALERTS_FILE}：${errors.length} 处违规\n  - ${errors.join("\n  - ")}`);
    } else {
      ruleCount = doc.groups.reduce(
        (n, group) => n + (Array.isArray(group?.rules) ? group.rules.length : 0),
        0,
      );
      console.log(
        `✓ ${ALERTS_FILE}：${doc.groups.length} 个 group / ${ruleCount} 条规则全部通过结构与指标名守卫`,
      );
    }
  }

  // ③ dashboard：面板 expr + 模板变量 → 同一清单（审计批次 A）
  let dashboard;
  try {
    dashboard = JSON.parse(readFileSync(join(ROOT, DASHBOARD_FILE), "utf8"));
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
    readingRules = readFileSync(join(ROOT, READING_RULES_FILE), "utf8");
  } catch {
    failures.push(`${READING_RULES_FILE} 不可读（阅读版告警被移走/改名了吗？）`);
    readingRules = null;
  }
  if (readingRules !== null) {
    const errors = validateReadingRulesText(readingRules, { metricNames: inventory });
    if (errors.length > 0) {
      failures.push(`${READING_RULES_FILE}：${errors.length} 处违规\n  - ${errors.join("\n  - ")}`);
    } else {
      console.log(
        `✓ ${READING_RULES_FILE}：存在且引用指标与清单对账通过（语义以 alerts.yml 为准）`,
      );
    }
  }

  if (failures.length > 0) {
    for (const failure of failures) console.error(`✗ ${failure}`);
    return 1;
  }
  console.log(`✓ 告警/看板同源守卫全绿（指标清单 ${inventory.size} 个，含 INFRA 白名单）`);
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
      - alert: TEST_QUEUE_RATE
        expr: sum(rate(autoflow_queue_up[5m])) == 0
        for: 10m
        labels:
          severity: critical
        annotations:
          summary: '队列不可读'
          description: '排查指引：看 Redis。'
`;

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
    const errors = validateAlertsDocument(doc, {
      metricNames: buildMetricInventory(fixture.sources),
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
  ];
  for (const check of readingChecks) {
    const errors = validateReadingRulesText(check.text, {
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
  if (failed) {
    console.error("✗ check-alerts-rules selftest 未全绿");
    return 1;
  }
  console.log(
    `✓ check-alerts-rules selftest 全绿（${SELFTEST_FIXTURES.length} 个 alerts fixture + ${unit.length} 个提取断言 + ${dashboardChecks.length} 个 dashboard fixture + ${readingChecks.length} 个阅读版 fixture）`,
  );
  return 0;
}

// ── 入口 ────────────────────────────────────────────────────────────────────
if (process.argv.includes("--selftest")) {
  process.exit(runSelftest());
}
process.exit(scanReal());
