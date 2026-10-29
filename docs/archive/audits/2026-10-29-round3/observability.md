# observability 审计（2026-10-29 · 第 3 轮）

> 域：可观测性真实性（指标 / 日志 / 追踪 / 告警）。
> 只读审计。**未修改任何源码**，工作区审计时干净（`git status --short` 空，HEAD `cb9b75ec`）。
> 12 条 finding（P1×1 / P2×6 / P3×5）。每条都给出逐字代码 + 触发路径 + 最小修法。

---

## 1 范围与方法

### 1.1 审计面

| 面 | 落点 |
|---|---|
| 指标声明与渲染 | `apps/admin-api/src/modules/metrics/{prometheus-metrics.service.ts,runtime-metrics.ts,runtime-metrics-entry.ts,metrics-stream-slot.service.ts}` |
| HTTP RED 埋点 | `apps/admin-api/src/common/interceptors/http-metrics.interceptor.ts` |
| 计数器埋点方 | `execution-terminal.ts`、`task.service.ts`、`notification.service.ts`、`ai*.service.ts`、`executor.controller.ts`、`agent/**`（只读引用） |
| 抓取与告警规则 | `config/monitoring/{prometheus.yml,alerts.yml,alertmanager.yml,promtail.yml,loki.yml}`、`docs/observability/{alerting-rules.yml,grafana-dashboard.json,README.md}` |
| 告警落地链路 | `apps/admin-api/src/modules/notification/{alerts.controller.ts,alert-webhook.mapping.ts}` |
| 日志管道 | `apps/admin-api/src/main.ts`（JSON ConsoleLogger）、`common/filters/http-exception.filter.ts`、`common/middleware/trace-id.middleware.ts` |
| 追踪 | `common/tracing/*`、`common/services/trace.service.ts`、`common/trace/trace.module.ts`、`executor-node/src/{logger.ts,routes/execute.ts}`、`executor-python/scheduler.py` |

### 1.2 方法（遵守 AGENTS.md 的 CodeGraph 优先）

1. `codegraph explore "PrometheusMetricsService metrics recording recordRuntime"` →
   拿到 `recordRuntime` 的 31 个 caller 清单与逐字源码；`codegraph node ExecutionStatus`
   确认终态枚举字面量；`codegraph callers TraceService` 确认其只有 spec/module 两个引用。
2. 仅当 CodeGraph 覆盖不到（YAML/JSON 配置、PromQL、文档承诺）时才 grep/read：
   `config/monitoring/*.yml`、`docs/observability/*`、`package.json` 守卫脚本。
3. 每条的**判据**都落到「渲染口径 × 实际埋点字面量」两侧对读，而不是只看一侧：
   - 指标侧：`RUNTIME_COUNTERS[x].labelValueSets` / `labelNames` ↔ 埋点处传入的字面量；
   - 告警侧：`expr` 的 label matcher 取值 ↔ 埋点字面量；
   - 看板侧：面板 `expr` ↔ 同上；
   - 日志侧：告警 runbook 里写明的排障步骤 ↔ 该步骤依赖的日志字段是否真的存在。
4. 未跑全量测试、未改源码（并发约束）。本报告不含任何需要写操作才能取得的结论；
   拿不准的地方在 §2 明写「未验证」并给验证方式。

### 1.3 去重基线（已读，本文不重复）

- `docs/AGENT-SWARM-PLAYBOOK.md` §7（当前未修 backlog：data-3 / desktop-budget / TOOLS-04 /
  TOOLS-06 / desktop-resend / doc-guard）。其中 **obs-1（令牌指标记步数）、obs-2（Admin Web
  对话入口）、obs-3（budget_exceeded 文案）、obs-4（`agent-metrics-labels.spec.ts`）已修**，
  本文不再重复；`doc-guard`（`scripts/check-metric-docs.mjs`）已存在，本文不重复其静态
  一致性面。
- `docs/archive/audits/*.md`、`docs/audit-playbook.md`、`docs/PLAN-CLAIMS.md`、
  `docs/OPEN-DECISIONS.md`、`docs/archive/plans/observability.md`（§「仍然待办」四条：
  OTLP exporter / Alertmanager 接收端 / APM·Profiling / TraceMiddleware 死代码——均已落地或
  已驳回，本文不重复）。
- `docs/CAPACITY-WHITEPAPER.md`、`docs/QA-05-capacity-boundaries.md`：**容量结论不复述**。
  本文 OBS3-03 只谈「容量**告警**的分母算法与其文档承诺不一致」，不谈容量本身。
- `scripts/check-alerts-rules.mjs` / `scripts/check-metric-docs.mjs` 的既有静态一致性面
  （指标名存在性、for/severity/expr 对账、看板指标名）**已被守卫覆盖，本文不重复**；
  OBS3-01/07/08 报的是这些守卫**看不见的维度**（label *取值*、annotations、渲染静默失败），
  并在修法里说明如何补进守卫而不是新起一套。

---

## 2 未覆盖 / 未实测（如实）

| # | 未覆盖项 | 原因 | 建议验证方式 |
|---|---|---|---|
| 1 | `promtool check rules` / `promtool check config` | 本机无 promtool（`alerts.yml` 头注同样注明） | 真机/CI 加一步 `promtool check rules config/monitoring/alerts.yml` |
| 2 | 真实 Prometheus 抓取 → 告警触发链路 | 只读约束，不起 compose monitoring profile | `docker compose --profile monitoring up -d` 后用 `promtool query instant` 对照本报告 4.1/4.3 的表达式 |
| 3 | Grafana 面板实际渲染结果 | 结论来自 PromQL 语义 + 面板配置（无 `noValue`）推断，未目视 | 起 Grafana 后打开 uid `autoflow-obs-v1` 面板 702/705；或 `promtool query instant '100 * sum(increase(autoflow_execution_result_total{status="SUCCESS"}[1h]))'` 期望返回空 |
| 4 | admin-api 单测/集成（含 `metrics` 模块 spec） | 并发约束：禁止跑全量套件 | `cd apps/admin-api && npx --node-options=--experimental-vm-modules jest src/modules/metrics --silent` |
| 5 | `apps/executor-desktop/src/main/agent/**`、`modules/agent/**`、`modules/agent/tools/**` 的**行为**面 | 另一 agent 正在改这三个区（审计时工作区干净，但落点行号可能随后漂移） | OBS3-02/08 落点已是 `agent/**`，修前请先 `git log -1 --stat` 确认行号 |
| 6 | `redis_exporter` 的实际指标名（`redis_memory_max_bytes` / `redis_up`） | 外部镜像契约，未在本仓可验证 | 起 monitoring profile 后 `curl -s redis-exporter:9121/metrics \| grep -E 'redis_(up\|memory_max_bytes)'` |
| 7 | Alertmanager 抑制规则对告警量的实际削减幅度 | 未起 Alertmanager，无法量化风暴日志量 | 起 profile 后查 `alertmanager_notifications_total` 与 `alertmanager_alerts_invalid_total`，对比 OBS3-10 修前/修后 |
| 8 | Loki 侧真实日志可查性（`\| json` 解析开销、7 天保留下的查询延迟） | 未起 Loki | 起 profile 后 `{container="autoflow-admin-api"} \| json \| level="error"` 与仅 `\|= "Unhandled exception"` 的耗時对比 |
| 9 | desktop 端日志管道（`executor-process.ts` 的 JSON 日志落盘/上报） | 属另一 agent 的写域 | 单独一轮 |
| 10 | `docs/api-reference.md:760` 宣称的「跨三端 trace 贯穿」在 `OTEL_ENABLED=true` 下的真机验证 | 需要真跑三端 + 双执行器 | 计划书里已登记的「真机轮留验」，本文不重复 |

---

## 3 发现总表

| id | 优先级 | 一句话 | 落点 |
|---|---|---|---|
| OBS3-01 | **P1** | 看板「任务执行成功率」面板用 `status="SUCCESS"`（大写），指标实际只发小写，面板永远「No data」；配套「异常结果绝对值」面板的 `status!="SUCCESS"` 反而把**成功也算成异常** | `docs/observability/grafana-dashboard.json:2485`、`:2781` |
| OBS3-02 | P2 | `autoflow_agent_tool_calls_total{tool}` 的取值直接来自**模型返回的工具名**（未与工具集比对），label 无界；且注册表只铺了 5 条 0 值基线（真实工具 40+、status 6 种），"已知标签组合全部 inc(0)" 的承诺不成立 | `apps/admin-api/src/modules/agent/runtime/agent-runtime.service.ts:515`、`apps/admin-api/src/modules/agent/runtime/agent-session.service.ts:710`、`apps/admin-api/src/modules/metrics/runtime-metrics.ts:250` |
| OBS3-03 | P2 | `autoflow_sse_streams_limit` 只在**成功抢占槽位时**才写；从未开过日志流的副本没有 limit series → `Σ(active)/Σ(limit)` 分母缺副本，容量告警把占用率放大最多「副本数」倍，且与 README「per-instance 线性叠加」相反 | `apps/admin-api/src/modules/task/task.service.ts:4007`、`apps/admin-api/src/modules/metrics/prometheus-metrics.service.ts:459`、`config/monitoring/alerts.yml:203` |
| OBS3-04 | P2 | 5xx 的日志行不含 method/route/errorCode/traceId，而 `AUTOFLOW_HTTP_5XX_RATE_HIGH` 的 runbook 明写「按该 route 过滤日志 context 字段」——该步骤物理上做不到 | `apps/admin-api/src/common/filters/http-exception.filter.ts:181`、`config/monitoring/alerts.yml:370` |
| OBS3-05 | P2 | 指标渲染里两处 DB 查询失败被 `catch { return; }` 静默吞掉（该类**连 Logger 都没有**），水位保留旧值但没有任何「陈旧/失败」信号；告警描述却让值班人「先确认 DB 是否真的可查」 | `apps/admin-api/src/modules/metrics/prometheus-metrics.service.ts:657`、`:698` |
| OBS3-06 | P2 | 生效的 31 条告警规则**全部**没有 `annotations.runbook_url`（阅读版有 14 条 `runbook:` 相对链接，但映射层只认 `runbook_url` 且要求绝对 URL）→ OBS-02 宣称的「runbook 兑现」在通知里永远不出现 | `config/monitoring/alerts.yml`（0/31）、`apps/admin-api/src/modules/notification/alert-webhook.mapping.ts:106` |
| OBS3-07 | P2 | `X-Trace-Id`（OPS-03）只写入 `req.traceId` 与响应头，**全仓无人读**；配套的 `TraceService`/`TraceModule` 从未被任何模块 import（死代码）。「cross-service request tracing」的注释与 `main.ts:335` 自述不成立 | `apps/admin-api/src/common/middleware/trace-id.middleware.ts:13`、`apps/admin-api/src/common/trace/trace.module.ts:1`、`apps/admin-api/src/main.ts:335` |
| OBS3-08 | P3 | `autoflow_agent_llm_retry_total` 实际会写出 3 个未登记的 `result` 值（`approved_replay` / `resume_queued` / `resume_enqueue_failed`），既无 0 值基线，也与 help 声明的「LLM 重试结局」语义不同源 | `apps/admin-api/src/modules/agent/runtime/agent-runtime.service.ts:305`、`:442`、`:458`；`apps/admin-api/src/modules/metrics/runtime-metrics.ts:305` |
| OBS3-09 | P3 | `AUTOFLOW_ALL_EXECUTORS_OFFLINE` 的 description 用了聚合表达式上不存在的 `{{ $labels.instance }}`，且 `{{ $value }}` 取的是 `and` 左侧（online=0）→ 通知里写成「共 0 台执行器，在线数为 0」，与本条 `total > 0` 的触发条件自相矛盾 | `config/monitoring/alerts.yml:399`、`:405` |
| OBS3-10 | P3 | `alertmanager.yml` 没有任何 `inhibit_rules`，而规则集里有 4 组同源分级对（失败率/风暴、磁盘 85/95、Redis 0.9/0.95、回调认证三档）+ 基础可达性三条 —— 一次根因故障按 `group_by: ['alertname']` 至少发 2~3 条通知 | `config/monitoring/alertmanager.yml:24`、`config/monitoring/alerts.yml:101`/`:112` |
| OBS3-11 | P3 | promtail 无任何 `pipeline_stages`：admin-api 发出的结构化 JSON 日志在 Loki 里是一整行裸文本，没有 `level`/`context` label，按级别过滤必须对全流做 `\| json`；python 执行器的纯文本日志完全不可解析 | `config/monitoring/promtail.yml:20-25`、`apps/admin-api/src/main.ts:393` |
| OBS3-12 | P3 | 执行失败的主日志行只带 `task.id`，不带 `executionId` / 尝试序号 / failureReason，而同一函数里其它分支是带 `executionId` 的 —— 排障时无法把日志行对到具体那次执行（重试会产出多条同文案） | `apps/admin-api/src/modules/task/task.processor.ts:379` |

---

## 4 逐条证据

### 4.0 文档承诺 → 代码实际 对照表（先给结论，逐条证据在后）

| # | 文档/注释承诺（出处） | 代码实际 | 判定 |
|---|---|---|---|
| 1 | 面板「任务执行成功率 = SUCCESS/(全五态)×100%，<95% 黄 <80% 红」（`grafana-dashboard.json:2422`） | `autoflow_execution_result_total{status="SUCCESS"}` 匹配不到任何 series（埋点只发小写）；分子空 → 整条表达式空 → 面板恒「No data」 | ❌ OBS3-01 |
| 2 | 「异常结果绝对值…SUCCESS 曲线刻意排除」（`:2696`） | `status!="SUCCESS"` 对小写五态**全命中**（含 success）→ 成功曲线被画进「异常」面板 | ❌ OBS3-01 |
| 3 | 「占用率 = Σ(active)/Σ(limit)（per-instance 线性叠加）」（`docs/observability/README.md:366`、`docs/operations.md:428`） | `limit` gauge 仅在 `acquireSseSlot` 成功路径写；未开过流的副本 `limit`=0 或缺席 | ❌ OBS3-03 |
| 4 | 「已知标签组合——渲染时全部显式 inc 保 0 值基线（series 集合稳定）」（`runtime-metrics.ts:145`） | `autoflow_agent_tool_calls_total` 只登记 5 条（工具集 56 个名字、`AGENT_TOOL_CALL_STATUSES` 6 种里只登记了 3 种）；`tool` 取值来自模型 | ❌ OBS3-02 |
| 5 | 「按该 route 过滤 admin-api 结构化日志的 context 字段」（`alerts.yml:370`） | 5xx 日志行只有 `Unhandled exception: <msg>` + stack，无 route/method/path/errorCode；`context` 恒为 `HttpExceptionFilter` | ❌ OBS3-04 |
| 6 | 「OPS-03: Cross-service request tracing middleware…」（`main.ts:335`、`trace-id.middleware.ts:6`） | `req.traceId` 全仓零读取；`TraceService.attachToAxiosConfig` 所在模块从未 import | ❌ OBS3-07 |
| 7 | OBS-02「runbook 兑现 = annotations.runbook_url 优先…」（`docs/AGENT_HANDOFF.md:689`） | `config/monitoring/alerts.yml` 31 条规则 0 条 `runbook_url`；阅读版 14 条 `runbook:`（非 `_url`）不被映射层消费 | ❌ OBS3-06 |
| 8 | 「旧版执行器未上报（null）不造 0，series 缺席」（`prometheus-metrics.service.ts:234`） | 查询失败同样「保留旧值」，与「未上报」在抓取面上**不可区分**，且无日志 | ⚠️ OBS3-05 |
| 9 | 「for/severity/expr 空白归一后逐字一致」三层对账（`docs/observability/alerting-rules.yml:9-11`） | `annotations` 不在对账面 → runbook 的 14 vs 0 漂移守卫看不见 | ⚠️ OBS3-06 |
| 10 | 令牌/工具/预算三类 Agent 指标的「标签值本地重复 + spec 断言一致」（`runtime-metrics.ts:117-123`） | `agent-metrics-labels.spec.ts` 只守 `kind`/`status` 两个维度，`result`/`tool`/`reason` 未守 | ⚠️ OBS3-02/08 |

结论：**指标的「名字」被守住了，指标的「取值」几乎没被守。** 上一轮的 obs-1（令牌指标记步数）
正是同一类缺陷；本轮 OBS3-01 是它在「看板 → 埋点」方向上的复发，OBS3-08 是它在 `result`
维度上的残留。

---

### OBS3-01（P1）看板成功率面板 label 取值大小写不匹配：面板永远无数据，且「异常」面板含成功

**现象**

`docs/observability/grafana-dashboard.json` 的面板 702 / 705 用大写 `SUCCESS` 过滤，而
`autoflow_execution_result_total` 的 `status` 标签值是小写（`ExecutionStatus` 枚举字面量）。
不止「没颜色」，是**表达式匹配不到任何 series**。

**逐字代码**

看板（`:2485`，面板 702「任务执行成功率」）：

```
"expr": "100 * sum(increase(autoflow_execution_result_total{instance=~\"$instance\", status=\"SUCCESS\"}[$__range])) / clamp_min(sum(increase(autoflow_execution_result_total{instance=~\"$instance\"}[$__range])), 1)",
```

看板（`:2781`，面板 705「异常结果绝对值」）：

```
"expr": "autoflow_execution_result_total{instance=~\"$instance\", status!=\"SUCCESS\"}",
```

指标侧（`apps/admin-api/src/modules/task/entities/task-execution.entity.ts:14-32`）：

```ts
export enum ExecutionStatus {
  PENDING = "pending",
  ...
  SUCCESS = "success",
  FAILED = "failed",
```

埋点侧（`apps/admin-api/src/modules/task/execution-terminal.ts:201-203`）：

```ts
  for (let i = 0; i < rows.length; i++) {
    recordRuntime("autoflow_execution_result_total", { status: patch.status });
  }
```

基线注册（`apps/admin-api/src/modules/metrics/runtime-metrics.ts:24-30, 162-164`）同样是
`ExecutionStatus.SUCCESS` → 小写。既有单测把这条钉死成小写
（`apps/admin-api/src/modules/metrics/__tests__/prometheus-metrics.service.spec.ts:352-355`
断言 `autoflow_execution_result_total{status="failed"} 2`）。

**触发路径**

任何一次抓取 → 面板渲染：

1. `TaskService/ExecutorService/watchdog/kill` 任一路径调用 `transitionToTerminal` →
   `recordRuntime(..., {status: "success"|"failed"|...})` → 快照里只有小写键；
2. `/api/metrics` → `PrometheusMetricsService.doRender()`（`:431-454`）按
   `labelValueSets`（小写）铺基线并输出；
3. Grafana 面板 702 的分子 `sum(increase(...{status="SUCCESS"}[range]))` 匹配空集 →
   PromQL 返回**空 vector** → `100 * <empty> / ...` 仍为空 → stat 面板显示 **No data**
   （该面板没有配 `noValue`，`:2462-2480` 只配了 `reduceOptions`）；
4. 面板 705 的 `status!="SUCCESS"` 在只有小写值时等价于「全部 status」，于是
   `success` 曲线进入标题为「异常结果绝对值」的面板。

**影响与量级**

- 平台**唯一**回答「任务执行成功率」的面板（README 把它算进「业务指标」行）自发布起就没
  出过数；面板描述还写着「新部署无数据时显示 0%」，把「永远无数据」伪装成正常态。
- 面板 705 语义反转：运维看到「异常」曲线在涨，其实那是成功量。两者叠加会直接误导一次
  发版判断（成功率看起来归零 / 异常看起来暴涨）。
- 量级：**100% 复现**，与流量无关；不需要任何异常输入。
- 与既有条目关系：与 §7 已修的 obs-1 同源（指标语义与承诺不一致），但形态不同——那次是
  **埋点值错**，这次是**消费端 filter 值错**，埋在模板/看板里，`check-alerts-rules.mjs` 的
  dashboard 校验只比对**指标名**（`:722` `validateDashboardDocument(dashboard, { metricNames })`），
  所以连看板被整体改坏都不会红。

**最小修法**

1. `grafana-dashboard.json`：`:2485` `status=\"SUCCESS\"` → `status=\"success\"`；`:2781`
   `status!=\"SUCCESS\"` → `status!=\"success\"`；同步 `:2333`/`:2519` 的 value mapping
   `"options": "SUCCESS"` → `"success"`（否则饼图/阈值着色仍然错色）；描述文案里的
   `SUCCESS/FAILED/...` 改为「小写字面量」并点明来源是 `ExecutionStatus`。
2. 面板 702 补 `"noValue": "no data"`（或 `"0"`）以区分「真无数据」与「算错」。
3. 加守卫（防止再犯，且能覆盖所有未来的 label filter）：在 admin-api 落一个
   `src/modules/metrics/__tests__/metric-label-values.match-dashboards.spec.ts`，
   用 `fs` 读 `docs/observability/grafana-dashboard.json` + `config/monitoring/alerts.yml`，
   抽出所有 `metric{label="value"}` 形态的 matcher，断言其 `value` ∈
   `RUNTIME_COUNTERS[metric].labelValueSets` 的对应 label 取值集合（注册表已经是权威来源，
   零新增事实源）。仓库已有同型先例：`common/middleware/__tests__/observability-hygiene.guard.spec.ts`
   就是 `fs` 读源码断言。

**可借鉴的 OSS 做法**

kube-prometheus / kubernetes-mixin 的告警与看板用**生成器**（jsonnet/mixin）从同一份
「指标契约」同时产出 rules 与 dashboard，label 取值只能来自契约常量；Grafana 侧不手写
matcher。本仓不需要引入 jsonnet——用上面那条 spec 把「看板 matcher → 注册表」这一跳钉住，
就等价取得同一保障。

---

### OBS3-02（P2）`tool` 标签取值来自模型输出（无界），且 0 值基线只覆盖 5 条假想组合

**现象**

`autoflow_agent_tool_calls_total{tool,tier,status}` 的 `tool` 直接取自
`call.function?.name`（LLM 响应），**未经工具集比对**就进了指标 label 与 DB 列；
同时 `labelValueSets` 只硬编码了 5 条组合，与真实工具集（`grep -rho 'name: "[a-z_]*"' apps/admin-api/src/modules/agent/tools/ | sort -u | wc -l` = 56）
和真实 status（6 种）都对不上，「已知标签组合全部 inc(0)」的承诺不成立。

**逐字代码**

来源（`apps/admin-api/src/modules/agent/runtime/agent-runtime.service.ts:515`，同型 `:557`、`:692`）：

```ts
const toolName = call.function?.name ?? "unknown";
await this.sessionService.recordToolCall({
  sessionId, stepId: step.id, toolCallId: call.id, toolName,
```

进指标（`apps/admin-api/src/modules/agent/runtime/agent-session.service.ts:710-714`）：

```ts
recordRuntime("autoflow_agent_tool_calls_total", {
  tool: patch.toolName,
  tier: patch.tier,
  status: patch.status,
});
```

注册表（`apps/admin-api/src/modules/metrics/runtime-metrics.ts:250-263`，只 5 条）：

```ts
labelValueSets: [
  { tool: "list_tasks", tier: "read", status: "ok" },
  { tool: "get_execution", tier: "read", status: "ok" },
  { tool: "trigger_task", tier: "write", status: "ok" },
  { tool: "deploy_application", tier: "write", status: "awaiting_approval" },
  { tool: "approve_deployment", tier: "dangerous", status: "denied" },
],
```

无界累积（`apps/admin-api/src/modules/metrics/runtime-metrics-entry.ts:45-48`）：

```ts
const byLabel = counters.get(name) ?? new Map<string, number>();
const key = JSON.stringify(labels);
byLabel.set(key, (byLabel.get(key) ?? 0) + inc);
```

渲染侧把**快照里出现过的任何键**都写成 series（`prometheus-metrics.service.ts:447-453`）：

```ts
if (byLabel) {
  for (const [key, value] of byLabel) {
    if (!rendered.has(key)) {
      counter.inc(JSON.parse(key) as Record<string, string>, value);
```

**触发路径**

1. 模型在 `tool_calls` 里给出任意名字（幻觉、被 prompt 注入、旧工具名残留）→
   `agent-runtime.service.ts:515` 原样取用；
2. `"no toolset wired"` 分支（`:516`）与「批次内跳过」分支（`:561`）都会
   `recordToolCall(... status: "denied")`，于是**被拒绝的名字也进了指标**；
3. `recordRuntime` 按 `JSON.stringify({tool,tier,status})` 建永久键（进程生命周期内不淘汰）；
4. 每次抓取 `doRender` 把这些键全部 `inc` 成 series → 抓取体积与注册表内存随
   「模型历史上编过的名字数」单调增长；同时真实工具（如 `delete_application`）在首次使用前
   没有 0 值基线，`rate()`/`increase()` 在面板上是「无数据」而不是 0。

**影响与量级**

- 基数：单进程无上限。一个会话里模型编 5 个名字，一个月 1e3 量级的会话就可能积累 1e3~1e4
  条永久 series（`/api/metrics` 输出体积与 Prometheus 内存同比例增长）。
- 语义：`tool` 维度本应回答「哪个工具失败率高」，现在混入「模型编出来的名字」，且
  `denied` 的计数里既有「越界」也有「根本没这个工具」——两者处置完全不同（安全事件 vs 模型
  质量），现在只能靠 `errorMessage` 字符串区分。
- 基线：面板「某个工具失败率」在首次失败前无数据；`error`/`timeout`/`circuit_open` 三种
  status（`agent-tool-call.entity.ts:44-51`）**一条基线都没有**。
- 与既有条目关系：`agent-metrics-labels.spec.ts`（上轮 obs-4 的产物）只断言
  `kind`/`status` 两个维度一致，不覆盖本条的 `tool`/`status(tool_call)`。

**最小修法**

1. 在边界闸门之前把 `toolName` 归一：命中工具集 → 原名；未命中 →
   固定值 `"__unknown__"`（把原值放进 `errorMessage`/日志，**不要**放进 label）。
   `agent-runtime.service.ts:515/557/692` 三处共用一个小函数 `normalizeToolNameForMetric(tools, raw)`。
2. `labelValueSets` 改为从工具注册表**生成**（`TOOLSET.map(t => ({tool: t.name, tier: t.tier, status: "ok"}))`
   plus 6 个 status × 关键工具），或至少补 `{tool:"__unknown__", tier:"read", status:"denied"}` 等
   真实组合；生成物仍写在 `runtime-metrics.ts`（保持 metrics 模块不依赖 agent 模块的既有约束，
   在构建期/测试期比对即可）。
3. 加一条 spec：`RUNTIME_COUNTERS.autoflow_agent_tool_calls_total` 的 `tool` 取值集合 ⊇
   工具注册表名字集合（与 `agent-metrics-labels.spec.ts` 同型，补第三个 describe）。

**可借鉴的 OSS 做法**

`/home/yongsheng/project/langgraph/libs/prebuilt/langgraph/prebuilt/tool_node.py:117`：

```python
"Error: {requested_tool} is not a valid tool, try one of [{available_tools}]."
```

LangGraph 在 `_validate_tool_call`（同文件 `:1302`）里先比对工具集，未注册的名字**短路成一条
错误 ToolMessage**，永远不会变成「被执行的工具实体」，自然也不会成为指标维度。这正是本条
需要的姿态：不合法名字进日志/消息，不进 label。

---

### OBS3-03（P2）`autoflow_sse_streams_limit` 只在实际开流时发布 → 容量告警分母缺副本

**现象**

`autoflow_sse_streams_limit`（本实例并发上限）只在 `acquireSseSlot()` **抢到槽位之后**才写
gauge；从未开过日志流的副本（新 pod、只跑 API 的副本、灰度副本）在抓取面上 `limit=0`。
`AUTOFLOW_SSE_STREAM_CAPACITY_HIGH` 用 `sum(active)/sum(limit)`，分母于是只统计「开过流的
副本」，而 README / operations.md 都写着「per-instance 线性叠加」。

**逐字代码**

唯一写点（`apps/admin-api/src/modules/task/task.service.ts:4006-4007`）：

```ts
setRuntimeGauge("autoflow_sse_streams_active", this.sseStreamsGlobal);
setRuntimeGauge("autoflow_sse_streams_limit", global);
```

释放路径只写 active（`:4017`），且**全仓无其他 `setRuntimeGauge("autoflow_sse_streams_limit")`**
（`grep` 唯一命中即上面这行）。渲染侧缺席即 0（`prometheus-metrics.service.ts:458-460`）：

```ts
for (const name of Object.keys(this.runtimeGauges) as RuntimeGaugeName[]) {
  this.runtimeGauges[name].set(gaugesSnapshot.get(name) ?? 0);
}
```

告警（`config/monitoring/alerts.yml:203`）：

```
expr: sum(autoflow_sse_streams_active) / sum(autoflow_sse_streams_limit) > 0.8
```

文档承诺（`docs/observability/README.md:366`）：「占用率 = Σ(active)/Σ(limit)（per-instance
线性叠加）；建议 > 0.8 持续 10m 关注」；`docs/operations.md:428` 同口径。

**触发路径**

1. `--scale admin-api=3` 起三个副本，`SSE_MAX_STREAMS_GLOBAL=64`（线性容量 192）；
2. 负载均衡把日志流都压在副本 A：A `active=55, limit=64`；B、C 从未开过流 → 无 limit series
   → 渲染为 0；
3. 表达式 `55/64 = 0.859 > 0.8` 持续 10m → **warning 误报**；真实占用率 `55/192 = 0.286`。
4. 反向场景同样坏：A 刚滚动重启（`limit` 未发布、`active=0`），B 有 40 条流 → 分母只有 64，
   占用率虚高；若恰好 B 也重启过，`sum(limit)=0` → `NaN`，告警**静默不触发**。

**影响与量级**

- 放大倍数 = 副本数 / 「开过流的副本数」。3 副本典型部署下 2~3 倍，阈值 0.8 实际等价于
  真实 0.27~0.4 —— 头部告警噪声（warning 级），同时把「真的到 80%」掩盖在后面。
- 修法成本极低（见下），收益是让 `AUTOFLOW_SSE_STREAM_CAPACITY_HIGH` 与
  `AUTOFLOW_SSE_STREAMS_REJECTED` 的因果链重新可信。
- 与既有条目关系：`docs/CAPACITY-WHITEPAPER.md:123`、`docs/QA-05-capacity-boundaries.md`
  讨论的是**容量数值**（不重复）；本条只谈**告警分母算法与文档承诺不一致**。

**最小修法**

在 `TaskService` 实现 `OnModuleInit`（该类已在用 `configService`；`MetricsStreamSlotService`
同型问题一并处理）里调用一次 `publishSseCapacity()`：

```ts
onModuleInit() {
  setRuntimeGauge("autoflow_sse_streams_active", 0);
  setRuntimeGauge("autoflow_sse_streams_limit", this.sseMaxGlobal);
}
```

并把 `acquireSseSlot` 里的 limit 写入改成 `this.sseMaxGlobal` 的幂等刷新（配置热更新后也能
跟上）。`autoflow_metrics_streams_limit`（`metrics-stream-slot.service.ts:54`）同因同治。
验证：单实例断言 `GET /api/metrics` 在**零流**状态下就包含
`autoflow_sse_streams_limit 64`。

---

### OBS3-04（P2）5xx 日志缺 method/route/errorCode/traceId，告警 runbook 的排障步骤做不到

**现象**

`AUTOFLOW_HTTP_5XX_RATE_HIGH` 的 description 给值班人的第一步是「先按 route 分行定位是哪个
路由在报 5xx，**再按该 route 过滤 admin-api 结构化日志的 context 字段**」。而全局异常过滤器
记 5xx 时只写 `Unhandled exception: <message>` + stack：没有 method、没有 path、没有 errorCode、
没有 traceId；`context` 字段是固定类名 `HttpExceptionFilter`，与 route 无关。

**逐字代码**

`apps/admin-api/src/common/filters/http-exception.filter.ts:178-184`：

```ts
    } else if (exception instanceof Error) {
      // Do not leak internal error details to clients
      this.logger.error(
        `Unhandled exception: ${exception.message}`,
        exception.stack,
      );
    }
```

同一个类里 `request.url` 只进**响应体**，不进日志（`:187-196`）：

```ts
    response.status(status).json({
      code: status, errorCode, message, params, data: errors,
      timestamp: new Date().toISOString(),
      path: request.url,
    });
```

告警文案（`config/monitoring/alerts.yml:370`）：

> 「…再按该 route 过滤 admin-api 结构化日志的 context 字段；HTTP 异常过滤器只在未捕获
> 异常时产出 5xx，栈里通常就是根因…」

**触发路径**

任一路由抛出未捕获异常（例：`GET /api/tasks/:id` 里 DB 连接抖动）→ 过滤器 `logger.error`
写一行 JSON（`level=error, context="HttpExceptionFilter", message="Unhandled exception: ..."`）
→ 值班人从 5xx 告警拿到「某个路由 5xx 占比 6%」→ 想按 route 过滤日志 → **日志里没有 route**，
只能靠时间戳在同一秒内的大量 error 行里肉眼匹配（并发场景下无法区分是哪个请求）。

**影响与量级**

- 5xx 三分之一的定位时间花在「这是哪个接口」上；`route="unmatched"` 的 5xx（全局中间件/过滤器
  自身出错）与具体控制器的 5xx 在日志里完全无法区分。
- 与告警文案的承诺直接冲突（属于「运维误导」而非「缺功能」），且这是 30 条规则里**唯一**一条
  把「查日志」写进第一步的规则，误导面最大。
- 已排除的解释：不是「另有请求日志能补上」——`TraceMiddleware` 已被有意删除（每请求 info 日志会
  淹掉 JSON 流，见 `common/middleware/__tests__/observability-hygiene.guard.spec.ts:8-14`）。

**最小修法**

在 `catch()` 里对 `status >= 500` 的出口统一带上可定位字段（**path 去 query**，避免把
SSE 票据等敏感 query 写进日志）：

```ts
this.logger.error(
  `Unhandled exception: ${request.method} ${request.url.split("?")[0]} ` +
    `[${errorCode ?? "NO_CODE"}] trace=${request.traceId ?? "-"}: ${exception.message}`,
  exception.stack,
);
```

顺带把 `errorCode` 一起写（前端/告警都按码聚合，日志里没有码就无法与 `route` 交叉验证）。
`QueryFailedError` 的两个分支（`:169`/`:174`）同样补 method+path。
验证：新增一条 spec 断言日志消息包含 `request.method` 与去 query 的 path；并顺手把
`alerts.yml:370` 的文案改成与实现一致（「按 route 过滤日志的 `route=` 字段」）。

---

### OBS3-05（P2）指标渲染的 DB 查询失败被静默吞掉：水位陈旧与「真的没数据」不可区分

**现象**

`PrometheusMetricsService` **本身没有 Logger**（该类从 `:74` 到 `:705` 无任何日志语句），
两处 DB 取数失败都是 `catch { return; }`：executor 磁盘水位与 fleet 水位保留上一轮值后直接
返回。抓取面上没有任何「本轮取数失败」的信号，值班人无法判断 `autoflow_executors_online 3`
是「现在有 3 台」还是「三小时前的快照」。

**逐字代码**

`apps/admin-api/src/modules/metrics/prometheus-metrics.service.ts:649-669`（磁盘水位）：

```ts
    try {
      rows = await this.executorRepository.find({
        where: { status: ExecutorStatus.ONLINE },
        select: { address: true, diskUsage: true },
      });
    } catch {
      return;
    }
```

`:689-704`（fleet 水位）：

```ts
    try {
      total = await this.executorRepository.count();
      online = await this.executorRepository.count({
        where: { status: ExecutorStatus.ONLINE },
      });
    } catch {
      // 刻意 return（保留旧值）：见上方注释。
      return;
    }
```

告警描述自己也知道这是个盲区（`alerts.yml:405`）：

> 「注意 autoflow_executors_online 在 DB 查询失败时保留旧值，若本条与 PG 告警同时出现，
> 先确认 DB 是否真的可查。」

**触发路径**

1. PG 短暂不可用（连接池耗尽 / 主备切换 / 慢查询占满）→ 这两次 `count()` 抛错；
2. `catch { return; }` → gauge 保持上次值，`/api/metrics` **200 正常返回**；
3. Prometheus 侧 `up=1`、`autoflow_executors_online` 有值 → `AUTOFLOW_ALL_EXECUTORS_OFFLINE`
   与 `AUTOFLOW_EXECUTOR_DISK_USAGE_*` 都按陈旧值评估；
4. 值班人没有任何信号知道「本轮取数失败」——注释里那条「保留旧值好过整组 series 消失」的
   权衡是对的，但缺了配套的**可见性**。

**影响与量级**

- 故障窗口内所有依赖这两个 gauge 的判断都建立在陈旧数据上；`AUTOFLOW_DB_POOL_WAITING`
  也可能因为读不到池句柄而 `max=0`（`renderPgPoolWaterLevel` 的 `?? 0`），此时 402 面板的
  `active/clamp_min(max,1)` 会算出离谱的百分比（如 2000%），进一步误导。
- 量级：与 PG 抖动频率同阶，`catch` 分支本身是「设计内」的，问题在于**不可观测**。
- 与既有条目关系：不重复 `docs/observability/README.md` 里对 `AUTOFLOW_METRICS_TARGET_DOWN`
  的讨论（那条只在**整体**抓取失败时触发，本条的失败是**局部**且被抓取成功掩盖）。

**最小修法**

1. 给该类注入 `Logger`；
2. 两个 `catch` 改成 `catch (err) { this.logFail("executor_fleet", err); return; }`，
   `logFail` 内部做**限流**（例如每 5 分钟最多 1 条 warn，其余丢弃并计数），避免 DB 长时间
   不可用时把日志打爆；
3. 新增计数器 `autoflow_metrics_render_error_total{query="executor_fleet"|"executor_disk"|"pg_pool"}`
   （走既有 `recordRuntime` 通道，加进 `RUNTIME_COUNTERS` 并补 `labelValueSets`），
   再在 `alerts.yml` 加一条 `increase(autoflow_metrics_render_error_total[10m]) > 0` 的 warning；
4. 面板 402/403/404 加 `noValue` 并在描述里注明「max=0 表示池句柄不可读」。

**可借鉴的 OSS 做法**

kube-state-metrics 对自身取数链路单列 `kube_state_metrics_*` 自监控指标（配置重载成功/时间戳
等），而不是让业务 gauge 静默陈旧；node_exporter 的 textfile collector 用
`node_textfile_scrape_error` 表达「这轮没读到」。共同点：**取数失败本身是一等指标**。

---

### OBS3-06（P2）31 条生效告警 0 条 `runbook_url`：OBS-02 的 runbook 通道是空转的

**现象**

`alert-webhook.mapping.ts` 实现了 `annotations.runbook_url` → 通知正文 `Runbook: <url>` 段，
并有单测；但**生效的规则文件里一条都没有**。阅读版 `alerting-rules.yml` 有 14 条 `runbook:`
（相对路径，非 `_url`），映射层不认，且对账守卫不比 annotations。

**逐字代码**

映射层（`apps/admin-api/src/modules/notification/alert-webhook.mapping.ts:106-113`）：

```ts
export function extractRunbookUrl(alert: AlertmanagerAlert): string | null {
  const raw = alert.annotations?.runbook_url;
  if (typeof raw === "string" && raw.trim() !== "") {
    return raw.trim();
  }
  return null;
}
```

阅读版（`docs/observability/alerting-rules.yml:63`，共 14 处同型）：

```yaml
          runbook: "docs/observability/README.md#autoflow_scheduler_down"
```

阅读版自己的注记（同文件 `:16-19`）：「消息中的 runbook 段取自 `annotations.runbook_url`…
值班场景建议把 `runbook:` 换成/加一行 `runbook_url:`（绝对 URL）」——**建议从未执行**。

生效版计数（`config/monitoring/alerts.yml`）：`- alert:` 31 条，`runbook_url` **0** 条。

**触发路径**

任一告警 firing → Alertmanager → `alertmanager-hmac-proxy` → `POST /api/alerts/webhook` →
`mapAlertmanagerPayload()` → `extractRunbookUrl()` 恒 `null` → 通知正文里永远没有
`Runbook:` 段。值班人拿到的是 `summary` + `description`（描述里塞了大段处置文字，但没有任何
可点击/可跳转的锚点，也没有「按 alertname 定位到 operations.md 那一行」的机械映射）。

**影响与量级**

- 31/31 条告警缺可执行链接；`docs/operations.md:885-917` 其实已有「告警 → 判据 → 处置」
  的逐条表格（天然就是 runbook 目标），只是没接上。
- 与既有条目关系：`docs/AGENT_HANDOFF.md:689` 把 OBS-02 记为「runbook 兑现=annotations.runbook_url
  优先…」——本条指出兑现只完成了一半（通道有、数据没有），属于**同源但形态不同**，需登记。
- 守卫面：`check-alerts-rules.mjs` 的三层对账只比 `for/severity/expr`（`alerting-rules.yml:9-11`
  自述），annotations 完全不在对账面，所以 14 vs 0 的漂移永远不红。

**最小修法**

1. 给 `config/monitoring/alerts.yml` 31 条规则各加一行
   `runbook_url: https://<docs-host>/operations.html#<alertname 小写>`（或用仓库 raw URL；
   主机名走 compose 环境变量注入不现实，规则文件是静态的——建议用相对稳定的文档站前缀，
   并在 `.env.example` 之外单列一个 `docs/observability/README.md` 说明「改域名要同步本文件」）。
2. `extractRunbookUrl` 增加回退：`annotations.runbook_url ?? annotations.runbook`，
   并在 `runbook` 是相对路径时按可配置 base 拼接——这样阅读版的 14 条立即生效。
3. 把 annotations 纳入对账：守卫升级为「同名规则必须同时具备 `summary`/`description`，且
   **接线版必须有 `runbook_url` 且是 http(s) 绝对 URL**」。这是纯增量断言，不会误伤。
4. 顺带修 OBS3-09 的模板变量（同文件）。

**可借鉴的 OSS 做法**

kube-prometheus / kubernetes-mixin 的每条规则都带
`runbook_url: https://runbooks.prometheus-operator.dev/runbooks/...`，Alertmanager UI 直接把它
渲染成可点链接；规则生成器强制该字段存在。通道与数据同源生成，才不会出现本仓这种
「通道建好、数据没填」的半成品。

---

### OBS3-07（P2）`X-Trace-Id` 只写不读 + `TraceService` 从未接线：跨进程关联实际不存在

**现象**

两个「trace id」机制都在，但都不产生可关联的日志：

1. `TraceIdMiddleware`（已接线）：读/生成 `X-Trace-Id` → 写 `req.traceId` → 回写响应头。
   **`req.traceId` 全仓零读取**（`grep -rn "req\.traceId"` 只有它自己那一行赋值）。
2. `TraceService` + `TraceModule`：给 axios 出站请求加 `X-Trace-Id` 头 —— 但
   `TraceModule` 从未被任何模块 `imports`，`TraceService` 在运行期根本不存在。

结果是 `main.ts:335` 自述的「Cross-service request tracing middleware」实际只是
「把调用方给的/自己编的 UUID 原样回显到响应头」。

**逐字代码**

`apps/admin-api/src/common/middleware/trace-id.middleware.ts:10-17`：

```ts
export class TraceIdMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction) {
    const traceId = (req.headers["x-trace-id"] as string) || randomUUID();
    req.traceId = traceId;
    res.setHeader("X-Trace-Id", traceId);
    next();
  }
}
```

`apps/admin-api/src/common/trace/trace.module.ts`（全文 8 行，`grep -rn "TraceModule"` 除定义外
**零引用**）：

```ts
@Module({
  providers: [TraceService],
  exports: [TraceService],
})
export class TraceModule {}
```

自述（`apps/admin-api/src/main.ts:335`）：
`// OPS-03: Cross-service request tracing middleware is configured in AppModule`
（中间件注释同款：「Downstream services and logs can use this ID to correlate a full request flow」）。

**触发路径**

1. 用户报 500：前端 toast/浏览器 devtools 里只有响应头 `X-Trace-Id: 4f2c...`；
2. 值班人 `grep 4f2c...` admin-api 日志 → **零命中**（日志里从没有这个 id）；
3. 想改用 OBS-01 的 `task_executions.traceId` → 是另一套 32-hex id，且
   `OTEL_ENABLED` 默认 `false`，历史行的 `traceId` 为 `null`；
4. 于是「一次 HTTP 请求 ↔ 一次执行 ↔ 执行器日志」三者之间没有任何可机械关联的键：
   执行器侧（`executor-node/src/logger.ts:21` 的 AsyncLocalStorage、`execute.ts:3061` 的
   `runWithTrace`）只认 `traceparent`，与 `X-Trace-Id` 是不同 id 空间。

**影响与量级**

- 跨进程 correlation 缺口的代价：一次「用户说刚才失败了」的排障，从「按 id 精确检索」退回
  「按时间窗口 + 用户名 + taskId 猜」，多副本部署下（每副本独立日志流）尤其不可靠。
- 代码里存在**三套并存**的 id 概念（`X-Trace-Id` / W3C `traceparent` 的 trace-id /
  `executor-node` 的 traceId），没有一套是端到端的，新人排障会先撞一次墙。
- 与既有条目关系：`docs/archive/plans/observability.md` §「仍然待办 1」只讨论 exporter 与
  `parentSpanId` 恒 null，**未涵盖本条**（X-Trace-Id 的消费缺口与 TraceService 死代码）。

**最小修法**（按代价从低到高，建议 1+2）

1. **顺手删死代码**：`common/services/trace.service.ts` + `common/trace/trace.module.ts` + 其 spec
   （零引用，删掉不影响任何行为），并在 `observability-hygiene.guard.spec.ts` 里加一条
   「TraceService/TraceModule 不得复活」，与已删的 `TraceMiddleware` 同一道防线。
2. **让 `req.traceId` 真的有消费者**：在 `HttpExceptionFilter` 的 5xx 日志行（OBS3-04 同一处）
   与 `HttpMetricsInterceptor` 的慢请求日志里带上 `trace=`；再把 `X-Trace-Id` 回写到
   `/api/metrics` 之外的**所有**响应头（现在已有）并在 4xx/5xx 响应体 `path` 旁加
   `traceId`，前端错误弹窗即可展示「把这串给运维」。
3. **可选**：把 `req.traceId` 作为出站 `traceparent` 的 trace-id 参与 OBS-01（需
   `OTEL_ENABLED=true`），让 HTTP 请求与执行行共用同一 id；否则至少在
   `docs/api-reference.md:760` 明说「两套 id 不互通」。

**可借鉴的 OSS 做法**

`nestjs-pino` 的 `genReqId` + `pino-http` 把 request id 注入**每一条**日志（AsyncLocalStorage /
child logger），并默认回写响应头——id 从「响应头里的装饰」变成「日志的检索键」，正是本条缺的
那一跳。同类做法在本仓执行器侧已经存在（`executor-node/src/logger.ts:39-53` 用
`AsyncLocalStorage` 给每条日志加 `traceId`），admin-api 侧照抄即可。

---

### OBS3-08（P3）`autoflow_agent_llm_retry_total` 写出 3 个未登记的 `result` 值

**现象**

注册表只声明 5 个 `result`（`scheduled/recovered/exhausted/fatal/deadline`），实际埋点还会写
`approved_replay`、`resume_queued`、`resume_enqueue_failed` 三个值；后两者的语义（自动续跑入队
成功/失败）与「LLM 重试结局」根本不是一件事。

**逐字代码**

`apps/admin-api/src/modules/agent/runtime/agent-runtime.service.ts:305`（审批重放）：

```ts
recordRuntime(LLM_RETRY_METRIC, { result: "approved_replay" });
```

`:442` / `:458`（自动续跑）：

```ts
recordRuntime(LLM_RETRY_METRIC, { result: "resume_queued" });
...
recordRuntime(LLM_RETRY_METRIC, { result: "resume_enqueue_failed" });
```

注册表（`apps/admin-api/src/modules/metrics/runtime-metrics.ts:305-315`）：

```ts
autoflow_agent_llm_retry_total: {
  help: "Agent LLM call retry outcomes (scheduled / recovered / exhausted / fatal / deadline)",
  labelValueSets: [
    { result: "scheduled" }, { result: "recovered" },
    { result: "exhausted" }, { result: "fatal" }, { result: "deadline" },
```

**触发路径**

会话里出现「已批准但未执行」的工具调用 → `replayApprovedToolCalls` 返回 >0 →
`approved_replay` 计数；LLM 瞬态失败且 `enqueueLlmResume` 成功 → `resume_queued`。
这两个值没有 0 值基线，面板/告警在首次命中前是「无数据」；而任何按
`sum by (result)(increase(...))` 观察「provider 在抖 vs provider 真坏」的人会看到两类完全
无关的业务事件混进同一张图。

**影响与量级**：语义污染 + 缺基线（与 `runtime-metrics.ts:54-61` 自己论证 `blocked` 必须登记
的理由完全同型）；量级低（不影响任何现有告警，因为没有告警引用该指标）。

**最小修法**：三选一，建议 (a)：
(a) 把 `approved_replay`/`resume_queued`/`resume_enqueue_failed` 迁到新计数器
`autoflow_agent_resume_total{result}`（并登记 labelValueSets）；
(b) 若坚持复用，把三个值补进 `labelValueSets` 并改 help 文案为「LLM 往返结局（含审批重放与
自动续跑）」；
(c) 在 `agent-metrics-labels.spec.ts` 里加一条「埋点字面量 ⊆ 注册表取值」的源码扫描
（读 `agent-runtime.service.ts` 抽 `result: "..."`），防止第四个值再悄悄出现。

---

### OBS3-09（P3）`AUTOFLOW_ALL_EXECUTORS_OFFLINE` 的注释模板与判据自相矛盾

**现象**

表达式是两个聚合向量的 `and`，结果集**没有任何 label**；`{{ $value }}` 取的是 `and` 左侧
（`sum(autoflow_executors_online)` = 0）。而 description 写的是「已注册 … 共 {{ $value }} 台
执行器，但在线数为 0」——通知里会渲染成「共 0 台执行器」，与「本条要求 total > 0 才触发」
直接矛盾；`{{ $labels.instance }}` 更是空串。

**逐字代码**（`config/monitoring/alerts.yml:398-405`）

```yaml
      - alert: AUTOFLOW_ALL_EXECUTORS_OFFLINE
        expr: sum(autoflow_executors_online) == 0 and sum(autoflow_executors_total) > 0
        for: 10m
        ...
          description: 'executors 表中已注册 {{ $labels.instance }} 所在 fleet 共 {{ $value }} 台执行器，但在线数为 0 持续 10 分钟——…'
```

**触发路径**：全部执行器离线（total=5, online=0）→ 告警 firing → Alertmanager 模板渲染
`$value=0`、`$labels.instance=""` → 通知正文「已注册  所在 fleet 共 0 台执行器，但在线数为 0」。
值班人第一眼看到「0 台执行器」会先怀疑「是不是压根没注册」（那是另一条判据、也是刻意不告警的
场景），把处置方向带偏。

**影响与量级**：critical 级通知里的关键数量写错；语义误导（P3，但因为出现在 critical 通知里，
建议与 OBS3-06 一起改，同一文件同一批提交）。

**最小修法**：交换 `and` 两侧，让 `$value` 变成**总数**，并删掉无意义的 `$labels.instance`：

```yaml
expr: sum(autoflow_executors_total) > 0 and sum(autoflow_executors_online) == 0
description: 'executors 表中共 {{ $value }} 台已注册执行器，在线数为 0 持续 10 分钟——…'
```

（PromQL 的 `and` 返回左侧样本，交换后 `$value` = total。）若想同时打印 online 与 total，
用两条 annotation（`{{ $value }}` 只能取一个值）或在正文里写「见面板 604」。

---

### OBS3-10（P3）Alertmanager 无 `inhibit_rules`：4 组同源分级对 + 3 条可达性规则会重复轰炸

**现象**：规则集里有多组「同一根因、分档告警」，Alertmanager 侧没有任何抑制规则，且
`group_by: ['alertname']` 会把不同 alertname 拆成不同通知组，一次根因故障发 2~3 条。

**逐字代码**

`config/monitoring/alertmanager.yml:24-29`（全文无 `inhibit_rules`）：

```yaml
route:
  group_by: ['alertname']
  group_wait: 30s
  group_interval: 5m
  repeat_interval: 4h
  receiver: 'hmac-proxy'
```

同源分级对（`config/monitoring/alerts.yml`）：`:101` `AUTOFLOW_EXECUTION_FAILURE_RATE_HIGH`
(warning) / `:112` `_STORM` (critical)；`:241` 磁盘 85 / `:250` 磁盘 95；`:278` Redis 0.9 /
`:287` Redis 0.95；`:322`/`:332`/`:342` 回调认证三档。另外 admin-api 挂掉会同时点
`InstanceDown`（`:28`）、`AUTOFLOW_METRICS_TARGET_DOWN`（`:41`）、`AUTOFLOW_QUEUE_UNREADABLE`
（`:67`）——三条同一根因。

**触发路径**：一次执行风暴（下游依赖整体挂）→ 失败率 0.06/s 同时越过 0.01 与 0.05 两条线 →
两个 alertname 各自成组 → 5 分钟内 2 条通知（外加 `AUTOFLOW_EXECUTION_KILLED_SPIKE` 若伴随
批量止损）。Redis 内存爬到 96% 时 high+critical 双发。

**影响与量级**：告警噪声约 2 倍（4 组对 × 每次故障 1 条冗余），是「值班人开始静音 critical
频道」的典型诱因；量级不大但正好落在「可行动性」这个域上，且修复是纯配置、零代码风险。

**最小修法**：给分级对加 `family` 标签（`execution` / `disk` / `redis` / `callback_auth`），
Alertmanager 加：

```yaml
inhibit_rules:
  - source_matchers: [severity="critical"]
    target_matchers: [severity="warning"]
    equal: ['family']
  - source_matchers: [alertname="AUTOFLOW_METRICS_TARGET_DOWN"]
    target_matchers: [alertname=~"AUTOFLOW_SCHEDULER_DOWN|AUTOFLOW_QUEUE_UNREADABLE|AUTOFLOW_SSE_STREAM_CAPACITY_HIGH"]
    equal: []
```

注意 `family` 必须同时加进阅读版 `alerting-rules.yml`（否则 `for/severity/expr` 对账不受影响，
但两份文档会漂移）并补 `check-alerts-rules.mjs` 的 labels 白名单（现在它只允许
`severity`，`:803` `expected: ["labels.severity"]`）。

**可借鉴的 OSS 做法**：kube-prometheus 的 Alertmanager 配置自带 `InfoInhibitor`
（severity=info 被同 namespace 的更高等级告警抑制）以及「critical 抑制同族 warning」的惯例。

---

### OBS3-11（P3）promtail 无 `pipeline_stages`：结构化 JSON 日志在 Loki 里退化成裸文本

**现象**：admin-api 用 `ConsoleLogger(..., { json: true })` 输出单行 JSON（`main.ts:393`），
但采集侧只打 `container`/`stream` 两个标签，没有任何解析阶段——`level`、`context`、
`traceId` 都不可作为 label 过滤。

**逐字代码**（`config/monitoring/promtail.yml:20-25`，全文件无 `pipeline_stages`）

```yaml
    relabel_configs:
      - source_labels: ['__meta_docker_container_name']
        regex: '/(.*)'
        target_label: 'container'
      - source_labels: ['__meta_docker_container_log_stream']
        target_label: 'stream'
```

**触发路径**：想查「近 1 小时所有 error」→ 只能 `{container="autoflow-admin-api"} |= "\"level\":\"error\""`
（字符串匹配，误伤 message 里含该子串的行）或 `| json` 对**全流**解析（7 天保留 + 高流量下
显著变慢）；`alerts.yml:370` 让值班人「按 context 字段过滤」，实际只能全文匹配
`"context":"HttpExceptionFilter"`。python 执行器的纯文本日志（`uvicorn` 默认格式）连
`| json` 都解析不出结构化字段。

**影响与量级**：排障从「按字段过滤」退化为「全文匹配 + 肉眼筛」，7 天保留窗口下查询延迟明显；
结构化日志的投入（`main.ts` 的 JSON ConsoleLogger）+ 结构化日志的收益（Loki 字段过滤）之间
断了一环。量级：体验/效率问题（P3），无数据错误。

**最小修法**（不改应用，只改采集）：

```yaml
    pipeline_stages:
      - json:
          expressions:
            level: level
            context: context
            msg: message
            trace: traceId
      - labels:
          level:
          context:
      # traceId 刻意不做 label（无界，见 OBS3-02 同类风险），查询时用 | json | trace="..."
      - match:
          selector: '{container="autoflow-admin-api"}'
          stages:
            - json:
                expressions: {level: level}
```

注意 ① `level` 需要归一（Nest JSON 用的是数字或字符串，先确认实际形态再决定是否 `template`）；
② `context` 基数有界（类名集合），可安全做 label；③ 别把 `traceId`/`executionId` 做成 label。
验证：`{container="autoflow-admin-api", level="error"}` 能直接出结果，且与
`|= "\"level\":\"error\""` 的行数一致。

---

### OBS3-12（P3）执行失败主日志行缺 `executionId` / 尝试序号 / failureReason

**现象**：`task.processor` 的 catch 分支对**每一次**尝试都打一行 `Task <taskId> failed: <msg>`，
不含 `executionId`、不含「第几次/共几次」、不含分类后的 `failureReason`。同一函数里另一条分支
（回 WAITING）反而带了 `executionId`。

**逐字代码**（`apps/admin-api/src/modules/task/task.processor.ts:379`）

```ts
this.logger.error(`Task ${task.id} failed: ${errMsg}`);
```

对照同函数 `:265` 的写法：

```ts
this.logger.log(
  `Execution ${executionId} queued (no executor available): task "${task.name}" ...`,
);
```

**触发路径**：一个 task 配 `attempts=3` → 三次失败产生三行**文案完全相同**的 error（只有消息
体不同），重试场景下 `executionId` 相同但无法从日志确认「这是最后一次」；`isLastAttempt`
（`:369`）这个已经算好的布尔量也没进日志，于是「最后一次失败才发通知/AI 分析」这条关键语义
在日志里看不出来。值守按 taskId 搜日志时会拿到多条无法区分的行。

**影响与量级**：单次排障多花几分钟做时间对齐；不影响数据（P3）。但与 OBS3-04 同一主题
（日志缺可定位 id），建议同批改。

**最小修法**

```ts
this.logger.error(
  `Task ${task.id} execution ${executionId} failed ` +
    `(attempt ${(job.attemptsMade ?? 0) + 1}/${job.opts?.attempts ?? 1}` +
    `${isLastAttempt ? ", final" : ""}; reason=${exec.failureReason ?? "unclassified"}): ${errMsg}`,
);
```

---

## 5 建议实施顺序（收益 ÷ 风险）

| 序 | 项 | 收益 | 风险/成本 | 建议批次 |
|---|---|---|---|---|
| 1 | **OBS3-01** 看板 `SUCCESS`→`success`（含 value mapping）+ 面板 702 `noValue` | 立刻恢复「执行成功率」与「异常绝对值」两个面板；P1，零代码风险 | 纯 JSON 字面量替换，改完起 Grafana 目视一次 | 单独一个提交（可与 OBS3-09 同批，同为「文案/字面量」） |
| 2 | **OBS3-01 的守卫**：`metric-label-values.match-dashboards.spec.ts`（fs 读看板/告警 + 比 `labelValueSets`） | 把「label 取值」这一整类复发面封死（本轮 3 条 finding 都在这类里） | 新 spec 50 行左右；需处理 `{instance=~"$instance"}` 等模板变量白名单 | 紧随 1 |
| 3 | **OBS3-04** 5xx 日志补 method/path/errorCode/traceId + 改 `alerts.yml:370` 文案 | 让唯一「查日志」型 runbook 真正可执行；同时为 OBS3-07 提供落点 | 触碰全局过滤器（影响所有路由的日志形态）→ 需跑 `jest src/common` + 一条新 spec 断言日志格式 | 单独提交 |
| 4 | **OBS3-05** 渲染失败可见化（Logger 限流 + `autoflow_metrics_render_error_total` + 一条 warning 告警） | 消除「水位陈旧不可辨」这个盲区；与 3 共用「可定位 id」主题 | 新指标需登记 `RUNTIME_COUNTERS` + `labelValueSets` + help 文案，`check-metric-docs.mjs` 会要求文档同步 | 与 3 相邻 |
| 5 | **OBS3-03** SSE/metrics 流 limit gauge 在 `onModuleInit` 发布 | 让容量告警与文档承诺一致，消除 2~3 倍虚高 | 两行代码 + 一条单测；注意 `TaskService` 已有 `onModuleInit` 钩子需确认未重复实现 | 可并入 3/4 的批次 |
| 6 | **OBS3-06** 31 条规则补 `runbook_url` + mapping 支持 `runbook` 回退 + 守卫加「必须有 runbook_url」 | 31 条告警从「有文字描述」升级为「有可跳转处置」；OBS-02 才算真兑现 | 机械改动但量大（31×1 行）；需定一个文档站前缀并写进 README | 单独提交（文档型） |
| 7 | **OBS3-09** `ALL_EXECUTORS_OFFLINE` 模板交换 `and` 两侧 | critical 通知里数量正确 | 1 行 + 与阅读版同步 | 并入 6 |
| 8 | **OBS3-07** 删 `TraceService`/`TraceModule` 死代码 + 给 `req.traceId` 加两个消费者 | 消除三套 id 的困惑；让「用户给出的 id」可检索 | 删文件需同步删 spec；`@types/express` 的 `traceId?` 声明保留（中间件仍在用） | 与 3 同批（同一处日志行） |
| 9 | **OBS3-02** `toolName` 归一到工具集 + 基线从工具注册表生成 | 关掉无界 label（内存/抓取体积）+ 让「工具失败率」可信 | **落在另一 agent 的写域**（`modules/agent/**`、`tools/**`）→ 必须等该 agent 收工后按当前行号重做，且改 `labelValueSets` 会牵动 `agent-metrics-labels.spec.ts` | 延后到并发窗口结束 |
| 10 | **OBS3-08** llm_retry 的 3 个值迁出/登记 + spec 加「埋点字面量 ⊆ 注册表」 | 同 9 的守卫收益，风险更低 | 同样在 `agent/**` 写域 | 与 9 同批 |
| 11 | **OBS3-10** `family` label + `inhibit_rules` | 削减约一半重复通知 | 需同步阅读版 + 扩 `check-alerts-rules.mjs` 的 labels 白名单（`:803`），否则守卫红 | 单独提交（告警拓扑） |
| 12 | **OBS3-11** promtail `pipeline_stages` | Loki 可字段过滤，排障效率 | 采集侧改动需真机验证（未起 Loki 时无法自证） | 最后，配真机验证 |
| 13 | **OBS3-12** `task.processor` 失败日志补 id | 排障对齐成本下降 | 1 行，但会改变既有日志断言（若有 spec 匹配该文案需同步） | 与 3 同批 |

**一条贯穿建议**：本轮的 12 条里有 3 条（OBS3-01/02/08）本质是同一个元问题——**指标契约的
「名字」有守卫（`check-alerts-rules.mjs` / `check-metric-docs.mjs`），「取值」没有**。
把第 2 项那条 spec 做出来之后，再补一条「埋点字面量 ⊆ 注册表 `labelValueSets`」的源码扫描，
就能同时封住这三条以及它们的未来变体，成本远低于逐条修。
