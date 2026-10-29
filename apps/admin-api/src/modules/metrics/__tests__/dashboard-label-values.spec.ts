/**
 * OBS3-01 守卫：看板/告警里的 label **取值** 必须落在指标契约内。
 *
 * 背景（docs/archive/audits/2026-10-29-round3/observability.md 的 OBS3-01）：
 * `docs/observability/grafana-dashboard.json` 的面板 702/705 曾用**大写**
 * `status="SUCCESS"` / `status!="SUCCESS"` 过滤，而 `autoflow_execution_result_total`
 * 的 status 取值是小写枚举（`ExecutionStatus`）。后果不是「颜色不对」而是：
 *   · 面板 702（成功率）分子匹配空集 → PromQL 返回空 vector → 面板恒「No data」；
 *   · 面板 705（异常结果绝对值）`status!="SUCCESS"` 对小写五态**全命中**，
 *     success 曲线被画进「异常」面板 —— 语义反转，直接误导发版判断。
 *
 * 为什么必须用 spec 而不是靠人眼：`scripts/check-alerts-rules.mjs` 的 dashboard
 * 校验只比对**指标名**（`validateDashboardDocument` 走 `extractMetricNames`），
 * 取值写错时守卫全绿、Grafana 静默空图。这类「静默出错数据」正是本轮审计里
 * 反复出现的一类缺陷（OBS3-01/02/08 同源）。
 *
 * 判据（零新增事实源）：
 *   抽出 `指标名{label="value"}` / `{label!="value"}` / `{label=~"a|b"}` 形态的
 *   **全部** matcher，断言 `value ∈ RUNTIME_COUNTERS[指标名].labelValueSets[label]`。
 *   —— 注册表本来就是「渲染时按已知标签组合铺 0 值基线」的权威来源，看板/告警
 *   只能消费它，不能自作主张。
 *
 * 三类必须变红的输入：
 *   1. **未知指标名**：有 matcher 但指标不在契约表里 → 红（fail-closed：否则
 *      任何人都能靠换一个名字绕过本守卫；新增契约要显式登记）。
 *   2. **未知 label**：指标在契约里，但 label 名不在 `labelNames` 里 → 红。
 *   3. **非法取值**：取值不在合法集合里 → 红。**取反也算**（`!=` / `!~`）：
 *      排除一个不存在的取值等于放行全部 series，正是 OBS3-01 的第二半。
 *
 * 白名单（两类，都是「不是指标契约能决定的东西」）：
 *   · Prometheus 抓取注入的 label：`instance` / `job`（代码里从不 set）；
 *   · Grafana 模板变量取值（含 `$` / `{{`）：如 `instance=~"$instance"`。
 * 推论（很重要，否则会误伤）：**一个 selector 若只按上面两类过滤，就没有
 * 可校验的取值**（`nodejs_heap_size_used_bytes{instance=~"$instance"}` 是
 * 20+ 个面板的形态），不要求登记契约；一旦写出字面量取值，该指标就必须先
 * 登记契约，否则变红——这正是「未知指标名要红」的落点，也保证没人能靠换
 * 一个未登记的名字绕过守卫。
 *
 * 非 runtime 计数器（`prometheus-metrics.service.ts` 里 new Counter/Gauge 的
 * 那些，如 `autoflow_queue_depth{state}`）没有 `labelValueSets`，其取值集合在
 * `NON_RUNTIME_LABEL_CONTRACTS` 里逐项登记并注明源码出处——**只登记当前
 * 真实被 matcher 引用到的**，新增引用时守卫会红，届时按同一个口径补登。
 *
 * 先例（同为「fs 读仓库文件做静态断言」）：`common/middleware/__tests__/
 * observability-hygiene.guard.spec.ts`、`src/__tests__/main-env-preload.spec.ts`。
 * 注：本仓 admin-api 跑 Jest，`expect` 只接受单参数，断言说明一律走注释。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { RUNTIME_COUNTERS } from "../runtime-metrics";
import { EXECUTION_CALLBACK_AUTH_RESULTS } from "../../task/execution-callback-metrics.service";

// __dirname = apps/admin-api/src/modules/metrics/__tests__
//   ..            → metrics
//   ../..         → modules
//   ../../..      → src
//   ../../../..   → admin-api
//   ../../../../..→ apps
//   ../../../../../.. → 仓库根
const REPO_ROOT = join(__dirname, "..", "..", "..", "..", "..", "..");
const DASHBOARD_REL = "docs/observability/grafana-dashboard.json";
const ALERTS_REL = "config/monitoring/alerts.yml";

/** Prometheus 抓取注入的 label：代码里从不 set，取值由部署决定，不属指标契约。 */
const INJECTED_LABELS = new Set(["instance", "job"]);

/** 契约里的「取值由运行时决定」标记（路由模板、执行器名、直方图桶上界等）。 */
const DYNAMIC = "*";

/**
 * HTTP RED 的 status_class 取值：`classifyHttpStatus`
 * （apps/admin-api/src/modules/metrics/prometheus-metrics.service.ts:726-742）
 * —— 非标准状态码归 "other"，不造 2xx/5xx 假象。
 */
const HTTP_STATUS_CLASSES = ["2xx", "3xx", "4xx", "5xx", "other"] as const;

interface LabelContractSpec {
  /** label 名 → 合法取值集合（`[DYNAMIC]` 表示不枚举） */
  labels: Record<string, readonly string[]>;
  /** 取值集合的事实来源（文件:行 / 常量名）——报错时透出，守卫不自己造事实 */
  source: string;
}

/**
 * 非 runtime 计数器的 label 契约。
 *
 * 只登记「当前真的被 dashboard/alerts 的 matcher 引用到」的指标；漏登记会让
 * 本 spec 变红并提示登记口径（fail-closed），而不是静默放过。
 * 取值逐字来自源码，不是猜的：
 */
const NON_RUNTIME_LABEL_CONTRACTS: Record<string, LabelContractSpec> = {
  // QUEUE_STATES（prometheus-metrics.service.ts:28-34）
  autoflow_queue_depth: {
    labels: { state: ["waiting", "active", "delayed", "failed", "completed"] },
    source: "prometheus-metrics.service.ts:28 QUEUE_STATES",
  },
  // doRender 的 triggers.reset()+inc({result:"claimed"|"failed"})（:385-386）
  autoflow_scheduler_triggers_total: {
    labels: { result: ["claimed", "failed"] },
    source:
      "prometheus-metrics.service.ts:385-386（help 亦写明 claimed / failed）",
  },
  // EXECUTION_CALLBACK_AUTH_RESULTS（task/execution-callback-metrics.service.ts:25）
  autoflow_execution_callback_auth_total: {
    labels: { result: EXECUTION_CALLBACK_AUTH_RESULTS },
    source:
      "task/execution-callback-metrics.service.ts:25 EXECUTION_CALLBACK_AUTH_RESULTS",
  },
  // HttpMetricsInterceptor 三件套：method/route/status_class（+ bucket 的 le）。
  // route 是 Express 路由模板（/tasks/:id，还有 unmatched 兜底），基数有界但
  // 取值集合不是常量表，故标 DYNAMIC。
  autoflow_http_requests_total: {
    labels: {
      method: [DYNAMIC],
      route: [DYNAMIC],
      status_class: HTTP_STATUS_CLASSES,
    },
    source: "prometheus-metrics.service.ts:307-309 + classifyHttpStatus(:726)",
  },
  autoflow_http_request_duration_ms_bucket: {
    labels: {
      method: [DYNAMIC],
      route: [DYNAMIC],
      status_class: HTTP_STATUS_CLASSES,
      le: [DYNAMIC],
    },
    source: "prometheus-metrics.service.ts:313-316 + classifyHttpStatus(:726)",
  },
  autoflow_http_request_duration_ms_sum: {
    labels: {
      method: [DYNAMIC],
      route: [DYNAMIC],
      status_class: HTTP_STATUS_CLASSES,
    },
    source: "prometheus-metrics.service.ts:319-322 + classifyHttpStatus(:726)",
  },
  autoflow_http_request_duration_ms_count: {
    labels: {
      method: [DYNAMIC],
      route: [DYNAMIC],
      status_class: HTTP_STATUS_CLASSES,
    },
    source: "prometheus-metrics.service.ts:325-328 + classifyHttpStatus(:726)",
  },
};

type LabelContract = Record<string, LabelContractSpec>;

/** 契约表 = RUNTIME_COUNTERS（唯一事实源）∪ 非 runtime 登记表。 */
function buildLabelContract(): LabelContract {
  const contract: LabelContract = {};
  for (const [name, spec] of Object.entries(RUNTIME_COUNTERS)) {
    const labels: Record<string, string[]> = {};
    for (const label of spec.labelNames) labels[label] = [];
    for (const combination of spec.labelValueSets) {
      for (const [label, value] of Object.entries(combination)) {
        const values = labels[label] ?? (labels[label] = []);
        if (!values.includes(value)) values.push(value);
      }
    }
    contract[name] = {
      labels,
      source: `RUNTIME_COUNTERS["${name}"].labelValueSets（apps/admin-api/src/modules/metrics/runtime-metrics.ts）`,
    };
  }
  for (const [name, spec] of Object.entries(NON_RUNTIME_LABEL_CONTRACTS)) {
    contract[name] = spec;
  }
  return contract;
}

type MatcherOp = "=" | "!=" | "=~" | "!~";

interface LabelMatcher {
  metric: string;
  label: string;
  op: MatcherOp;
  /** 引号内的原文（未去 ^$ / 未拆 |） */
  raw: string;
}

// `指标名{...}`：PromQL selector 内部不会再嵌套花括号
const SELECTOR_RE = /([a-zA-Z_:][a-zA-Z0-9_:]*)\s*\{([^{}]*)\}/g;
// label 匹配器：= / != / =~ / !~ 后必须紧跟带引号的字符串
const MATCHER_RE =
  /([a-zA-Z_][a-zA-Z0-9_]*)\s*(=~|!~|=|!=)\s*"((?:[^"\\]|\\.)*)"/g;

/** 抽出一条 PromQL 表达式里的全部 label matcher（含取反形态）。 */
function extractMatchers(expr: string): LabelMatcher[] {
  const matchers: LabelMatcher[] = [];
  for (const selector of expr.matchAll(SELECTOR_RE)) {
    const metric = selector[1];
    const body = selector[2];
    // Grafana 模板占位（legendFormat / label_format 里的 {{status}}）不是 PromQL
    if (body.includes("{{")) continue;
    for (const matcher of body.matchAll(MATCHER_RE)) {
      matchers.push({
        metric,
        label: matcher[1],
        op: matcher[2] as MatcherOp,
        raw: matcher[3],
      });
    }
  }
  return matchers;
}

/**
 * 一个 matcher 需要校验的**字面量**取值；`null` = 通配（跳过校验）。
 *
 * - 含 `$` / `{{` = Grafana 模板变量（`$instance`、`$__rate_interval`）；
 * - `=~` / `!~` 按 `|` 拆alternatives，去掉 `^`/`$` 锚点；纯 `.*` / `.+` 是全通配；
 * - 其余（`=` / `!=`）就是一个字面量。
 */
function literalCandidates(op: MatcherOp, raw: string): string[] | null {
  const value = raw.trim();
  if (value === "" || value.includes("$") || value.includes("{{")) return null;
  if (op === "=~" || op === "!~") {
    const parts = value
      .split("|")
      .map((part) => part.trim().replace(/^\^/, "").replace(/\$$/, ""));
    const literals = parts.filter(
      (part) => part !== "" && part !== ".*" && part !== ".+" && part !== ".*?",
    );
    return literals.length > 0 ? literals : null;
  }
  return [value];
}

/** 校验一条表达式；返回空数组表示全绿。`context` = `文件:面板id` / `文件:告警名`。 */
function collectViolations(
  expr: string,
  context: string,
  contract: LabelContract,
): string[] {
  const violations: string[] = [];
  // 按 selector 分组：**只有存在「可校验 matcher」的 selector 才要求登记契约**。
  // 否则 `nodejs_heap_size_used_bytes{instance=~"$instance"}` 这类「只按注入
  // label 过滤」的写法会被误判——它压根没有 label 取值契约可言（本仓 20+ 个
  // 面板都是这个形态）。反过来说，一旦写出字面量取值，就必须先登记契约。
  const byMetric = new Map<string, LabelMatcher[]>();
  for (const matcher of extractMatchers(expr)) {
    const bucket = byMetric.get(matcher.metric) ?? [];
    bucket.push(matcher);
    byMetric.set(matcher.metric, bucket);
  }
  for (const [metric, matchers] of byMetric) {
    const checkable = matchers
      .filter((matcher) => !INJECTED_LABELS.has(matcher.label))
      .filter((matcher) => literalCandidates(matcher.op, matcher.raw) !== null);
    if (checkable.length === 0) continue;
    const metricSpec = contract[metric];
    if (!metricSpec) {
      violations.push(
        `${context}: 指标 "${metric}" 没有 label 取值契约（既不在 RUNTIME_COUNTERS，也不在 NON_RUNTIME_LABEL_CONTRACTS）。` +
          `带字面量 label matcher 的指标必须先登记取值集合，否则这个 filter 写错时守卫看不见（OBS3-01 的复发面）。`,
      );
      continue;
    }
    for (const matcher of checkable) {
      const allowed = metricSpec.labels[matcher.label];
      if (allowed === undefined) {
        violations.push(
          `${context}: ${metric} 没有 label "${matcher.label}"（契约 labels: [${Object.keys(metricSpec.labels).join(", ")}]；取值来源 ${metricSpec.source}）`,
        );
        continue;
      }
      if (allowed.length === 1 && allowed[0] === DYNAMIC) continue;
      const candidates = literalCandidates(matcher.op, matcher.raw);
      if (candidates === null) continue;
      if (allowed.length === 0) {
        violations.push(
          `${context}: ${metric} 的 label "${matcher.label}" 在契约里没有任何合法取值（labelValueSets 未登记），无法校验 ${matcher.label}${matcher.op}"${matcher.raw}"——先在 ${metricSpec.source} 登记取值集合`,
        );
        continue;
      }
      for (const candidate of candidates) {
        if (allowed.includes(candidate)) continue;
        const negated = matcher.op === "!=" || matcher.op === "!~";
        violations.push(
          `${context}: ${metric}{${matcher.label}${matcher.op}"${matcher.raw}"} 的取值 "${candidate}" 不合法；` +
            `合法取值只有 [${allowed.join(", ")}]（来自 ${metricSpec.source}）。` +
            (negated
              ? `注意**取反 filter 的取值同样必须存在**：排除一个不存在的取值等于放行全部 series（OBS3-01：status!="SUCCESS" 把 success 画进了「异常」面板）。`
              : ""),
        );
      }
    }
  }
  return violations;
}

// ── 受卫文件抽取 ────────────────────────────────────────────────────────────

interface ExprEntry {
  /** `文件:面板id` 或 `文件:告警名`——报错直接可定位 */
  context: string;
  expr: string;
}

interface DashboardPanel {
  id?: number;
  title?: string;
  type?: string;
  panels?: DashboardPanel[];
  targets?: Array<{ expr?: string }>;
  fieldConfig?: { defaults?: { noValue?: unknown } };
}

interface DashboardDoc {
  panels?: DashboardPanel[];
}

/** 展平所有面板（row 面板可以嵌套子面板，不能只看顶层）。 */
function allPanels(doc: DashboardDoc): DashboardPanel[] {
  const flat: DashboardPanel[] = [];
  const walk = (panels: DashboardPanel[] | undefined): void => {
    for (const panel of panels ?? []) {
      flat.push(panel);
      if (Array.isArray(panel.panels)) walk(panel.panels);
    }
  };
  walk(doc.panels);
  return flat;
}

function dashboardEntries(doc: DashboardDoc): ExprEntry[] {
  const entries: ExprEntry[] = [];
  for (const panel of allPanels(doc)) {
    const id = panel.id === undefined ? (panel.title ?? "?") : panel.id;
    for (const target of panel.targets ?? []) {
      if (typeof target?.expr === "string") {
        entries.push({ context: `${DASHBOARD_REL}:${id}`, expr: target.expr });
      }
    }
  }
  return entries;
}

/**
 * 从接线版告警里抽 `(告警名, expr)`。
 *
 * 行级抽取是**精确**的（不是近似）：`check-alerts-rules.mjs` 的受限 YAML 解析器
 * 禁止块标量，所以 alerts.yml 的 expr 只能是单行标量；按 `- alert:` 切块后
 * 每块里最多一条 `expr:`。
 */
function alertsEntries(text: string): ExprEntry[] {
  const entries: ExprEntry[] = [];
  const chunks = text.split(/^\s*-\s+alert:\s*(\S+)\s*$/m);
  for (let index = 1; index < chunks.length; index += 2) {
    const alert = chunks[index];
    const body = chunks[index + 1] ?? "";
    const exprLine = body.match(/^\s*expr:\s*(.+)$/m);
    if (!exprLine) continue;
    const expr = exprLine[1].trim().replace(/^['"]/, "").replace(/['"]$/, "");
    entries.push({ context: `${ALERTS_REL}:${alert}`, expr });
  }
  return entries;
}

// ── 真实文件（模块加载时读一次）─────────────────────────────────────────────

const CONTRACT = buildLabelContract();
const dashboardDoc = JSON.parse(
  readFileSync(join(REPO_ROOT, DASHBOARD_REL), "utf8"),
) as DashboardDoc;
const alertsText = readFileSync(join(REPO_ROOT, ALERTS_REL), "utf8");
const DASHBOARD_ENTRIES = dashboardEntries(dashboardDoc);
const ALERTS_ENTRIES = alertsEntries(alertsText);

function sweep(entries: ExprEntry[]): string[] {
  return entries.flatMap((entry) =>
    collectViolations(entry.expr, entry.context, CONTRACT),
  );
}

describe("OBS3-01 守卫 · 看板/告警的 label 取值必须落在指标契约内", () => {
  it("探针：确实抽到了 matcher（受卫面不得静默空转）", () => {
    // 只数「真正要校验」的 matcher（排除 instance/job 与 Grafana 模板变量）：
    // 这个数字归零 = 抽取器坏了，三条全绿断言会变成永真的空转。
    const checkable = [...DASHBOARD_ENTRIES, ...ALERTS_ENTRIES]
      .flatMap((entry) => extractMatchers(entry.expr))
      .filter((matcher) => !INJECTED_LABELS.has(matcher.label))
      .filter((matcher) => literalCandidates(matcher.op, matcher.raw) !== null);
    expect(checkable.length).toBeGreaterThanOrEqual(10);
    // 接线版 31 条规则都必须被抽到（切块器失效 = 守卫看不见告警侧）
    expect(ALERTS_ENTRIES.length).toBeGreaterThanOrEqual(31);
    expect(DASHBOARD_ENTRIES.length).toBeGreaterThanOrEqual(20);
  });

  it("grafana-dashboard.json 的全部 label matcher 取值合法", () => {
    expect(sweep(DASHBOARD_ENTRIES)).toEqual([]);
  });

  it("config/monitoring/alerts.yml 的全部 label matcher 取值合法", () => {
    expect(sweep(ALERTS_ENTRIES)).toEqual([]);
  });

  it("面板 702（成功率 stat）配了 noValue，空白不再等于「无数据」", () => {
    const panel702 = allPanels(dashboardDoc).find((panel) => panel.id === 702);
    expect(panel702).toBeDefined();
    const noValue = panel702?.fieldConfig?.defaults?.noValue;
    expect(typeof noValue).toBe("string");
    expect((noValue as string).trim().length).toBeGreaterThan(0);
  });
});

describe("OBS3-01 守卫 · 判据自身的反证（坏输入必须红）", () => {
  it("大写 SUCCESS 必须红，且报错给出合法取值", () => {
    const violations = collectViolations(
      'sum(increase(autoflow_execution_result_total{status="SUCCESS"}[5m]))',
      `${DASHBOARD_REL}:702`,
      CONTRACT,
    );
    expect(violations.length).toBe(1);
    expect(violations[0]).toContain(`${DASHBOARD_REL}:702`);
    expect(violations[0]).toContain('"SUCCESS"');
    expect(violations[0]).toContain("success");
    expect(violations[0]).toContain("不合法");
  });

  it('取反的大写 status!="SUCCESS" 也必须红（把 success 画进异常面板的那个写法）', () => {
    const violations = collectViolations(
      'autoflow_execution_result_total{status!="SUCCESS"}',
      `${DASHBOARD_REL}:705`,
      CONTRACT,
    );
    expect(violations.length).toBe(1);
    expect(violations[0]).toContain("取反 filter 的取值同样必须存在");
  });

  it("未知指标名必须红（fail-closed，防止换个名字绕过守卫）", () => {
    const violations = collectViolations(
      'autoflow_definitely_not_registered_total{status="success"}',
      `${ALERTS_REL}:GHOST`,
      CONTRACT,
    );
    expect(violations.length).toBe(1);
    expect(violations[0]).toContain("没有 label 取值契约");
  });

  it("未知 label 必须红，并列出该指标真实有的 label", () => {
    const violations = collectViolations(
      'autoflow_execution_result_total{mood="happy"}',
      `${DASHBOARD_REL}:999`,
      CONTRACT,
    );
    expect(violations.length).toBe(1);
    expect(violations[0]).toContain('没有 label "mood"');
    expect(violations[0]).toContain("status");
  });

  it("无 label 的计数器被塞了 matcher 必须红", () => {
    const violations = collectViolations(
      'autoflow_sse_streams_rejected_total{status="failed"}',
      `${DASHBOARD_REL}:998`,
      CONTRACT,
    );
    expect(violations.length).toBe(1);
    expect(violations[0]).toContain('没有 label "status"');
  });

  it('正则里混进大写分支必须红（=~"failed|SUCCESS"）', () => {
    const violations = collectViolations(
      'sum(increase(autoflow_execution_result_total{status=~"failed|SUCCESS"}[5m]))',
      `${ALERTS_REL}:MIXED`,
      CONTRACT,
    );
    expect(violations.length).toBe(1);
    expect(violations[0]).toContain('"SUCCESS"');
  });

  it("小写正则 / 模板变量 / 注入 label 一律放行（不误伤）", () => {
    const allow: Array<[string, string]> = [
      [
        'sum(rate(autoflow_execution_result_total{status=~"failed|timeout"}[5m])) > 0.01',
        "正则多分支，两支都合法",
      ],
      [
        'autoflow_execution_result_total{instance=~"$instance", status="success"}',
        "Grafana 模板变量 + 合法小写取值",
      ],
      [
        "sum(autoflow_sse_streams_active) / sum(autoflow_sse_streams_limit) > 0.8",
        "无 matcher 的表达式不参与校验",
      ],
      [
        'sum by (channel) (increase(autoflow_notification_delivery_total{result="blocked"}[15m])) > 0',
        "runtime 计数器 + 已登记取值",
      ],
      [
        'sum by (job) (rate(autoflow_execution_callback_auth_total{result=~"v1_bad_signature|legacy_shared_invalid"}[5m])) > 0.01',
        "非 runtime 计数器，取值来自 EXECUTION_CALLBACK_AUTH_RESULTS",
      ],
      [
        'autoflow_queue_depth{state="waiting"} > 100',
        "非 runtime 计数器，取值来自 QUEUE_STATES",
      ],
      [
        'nodejs_heap_size_used_bytes{instance=~"$instance"}',
        "只按注入 label 过滤 = 没有可校验取值，不要求契约（20+ 面板的形态）",
      ],
    ];
    for (const [expr, why] of allow) {
      // 断言消息走 why（本仓 expect 只接受单参数，说明塞进对象里）
      expect({
        why,
        violations: collectViolations(expr, "允许样例", CONTRACT),
      }).toEqual({
        why,
        violations: [],
      });
    }
  });

  it("真实文件的回归路径通着：把真看板的 success 改回 SUCCESS 立刻红", () => {
    const panel702 = DASHBOARD_ENTRIES.find((entry) =>
      entry.context.endsWith(":702"),
    );
    expect(panel702).toBeDefined();
    const regressed = panel702!.expr.replace(
      'status="success"',
      'status="SUCCESS"',
    );
    expect(regressed).not.toBe(panel702!.expr);
    const violations = collectViolations(
      regressed,
      panel702!.context,
      CONTRACT,
    );
    expect(violations.length).toBe(1);
    expect(violations[0]).toContain(`${DASHBOARD_REL}:702`);
  });
});
