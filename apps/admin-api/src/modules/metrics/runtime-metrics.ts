import { ExecutionStatus } from "../task/entities/task-execution.entity";

/**
 * 可观测性补齐（指标盲区轮）：4 个新增 Prometheus 计数器的纯声明。
 *
 * 与 scheduler / callback-auth 两条既有链路（SchedulerMetricsService /
 * ExecutionCallbackMetricsService → PrometheusMetricsService snapshot→render）
 * 语义一致：进程内单调计数、零新依赖、series 集合稳定（渲染时所有已知标签
 * 显式 inc(0) 保基线，rate() 自首次计数前即可计算）。差异仅在埋点交接：
 * 本组计数器的记录方是 TaskService / NotificationService，而
 * "无任何模块反向依赖 MetricsModule"（见 metrics.module.ts 注释）且本轮
 * 不动各模块 wiring，因此通过 PrometheusMetricsService 的静态 record 入口
 * 交接（构造即安装为当前实例），不引入模块环。
 */

/**
 * autoflow_execution_result_total 的 status 标签全集。
 *
 * 第二轮审计（A4）：记录点已从「回调 winner」下沉到 transitionToTerminal
 * 统一终态入口，因此标签全集 = 该入口可写出的全部终态——除回调三态外补
 * KILLED（手动终止）与 CANCELLED（COVER_EARLY 新触发覆盖旧执行）。入队
 * 补偿/执行器重启/watchdog 超时等服务端失败复用 FAILED，无需新标签。
 */
export const RUNTIME_EXECUTION_RESULT_LABELS = [
  ExecutionStatus.SUCCESS,
  ExecutionStatus.FAILED,
  ExecutionStatus.TIMEOUT,
  ExecutionStatus.KILLED,
  ExecutionStatus.CANCELLED,
] as const;

/** autoflow_notification_delivery_total 的 channel 标签全集（与 NotificationService.sendToChannels 的渠道名一致；NF-05 起 feishu 加入） */
export const RUNTIME_NOTIFICATION_CHANNELS = [
  "email",
  "slack",
  "dingtalk",
  "wecom",
  "webhook",
  "feishu",
] as const;

/**
 * autoflow_notification_delivery_total 的 result 标签全集。
 *
 * R33-A1: 从 {success, failure} 扩到四值，与 NotificationService 导出的
 * `mapDeliveryResultLabel` 映射表一一对应（漂移由两侧 spec 各自钉住）：
 *  - success — 渠道真的投出去了（'sent'；legacy/mock 渠道返回 undefined 同义）；
 *  - failure — 传输/API 故障（渠道自报 'failed'，或 promise rejected）；
 *  - blocked — 被 SSRF 策略拦截（assertSafeHttpUrl 拒绝）：**策略决定**，
 *              不是传输故障，也不代表目标不可达；
 *  - skipped — 渠道未配置（无 URL/凭据，零次尝试）：既非成功也非失败，
 *              计入 failure 会伪造一条渠道故障。
 *
 * 为什么必须**登记**（而不是只依赖渲染侧「快照里出现才画」的兜底）：未登记的
 * 组合在首次命中前根本不存在，rate()/increase() 与看板呈现的是「无数据」而
 * 不是 0 —— 对告警表达式来说「无数据」与「0」语义完全不同（尤其是
 * `result="blocked"` 这类要新加告警的值，无基线时告警在首次拦截前是黑的）。
 *
 * 基数影响：labelValueSets = 渠道 × 值，6 × 4 = **24 条 0 值 series**
 * （R33-A1 之前是 12 条）。24 条全零整数 series 的抓取/存储成本可忽略，
 * 换取的是「已知标签组合全部有基线」这条既有不变量的完整性。
 */
export const RUNTIME_NOTIFICATION_RESULTS = [
  "success",
  "failure",
  "blocked",
  "skipped",
] as const;

/**
 * autoflow_callback_business_total 的 result 标签全集——与 handleCallback
 * 的返回分类一一对应：
 * - accepted：终态条件 UPDATE 命中（winner，含 SUCCESS/FAILED/TIMEOUT 落库）
 * - duplicate：affected=0（已是终态的重复回调 / 与 worker 收尾竞态），补写日志后按成功上报
 * - not_found：executionId 不存在
 * - address_mismatch[_missing_address]：回调地址与派发地址不符 / 回调缺地址
 * - error：其余 per-item 失败（异常兜底分支，如日志持久化抛错）
 */
export const RUNTIME_CALLBACK_BUSINESS_LABELS = [
  "accepted",
  "duplicate",
  "not_found",
  "address_mismatch",
  "address_mismatch_missing_address",
  "error",
] as const;

export type RuntimeCounterName =
  | "autoflow_execution_result_total"
  | "autoflow_sse_streams_rejected_total"
  | "autoflow_notification_delivery_total"
  | "autoflow_callback_business_total"
  | "autoflow_push_auth_retry_total"
  // PLAN-SECURITY-HARDENING §2.2：SSE 票据被拒分类——wrong_path 是核心
  // 安全信号（票据被拿去打非 stream 路由 = 泄漏票据被试探复用）。
  | "autoflow_sse_ticket_rejected_total"
  // ARCH-30: AI 分析服务化——aiAnalysis 落库率三分类（ok=有分析落库 /
  // fail=重试耗尽 fail-open / skipped=provider 未配置或返回空）。
  | "autoflow_ai_analysis_total"
  // P2（agent-and-deployment）：中台 Agent 运行时五项观测。
  | "autoflow_agent_sessions_total"
  | "autoflow_agent_tokens_total"
  | "autoflow_agent_tool_calls_total"
  | "autoflow_agent_denied_total"
  | "autoflow_agent_budget_exceeded_total"
  // N6（R6-b / DA §4.2）：注定失败的上下文调用提前收敛计数——「已超窗且折叠
  // 0 条」，请求在发出去之前就被判定必然 400（写点见 agent-runtime.service.ts
  // 的「注定失败的调用提前收敛」段）。
  | "autoflow_agent_context_unrecoverable_total"
  // S2-A2（R5/R18）：折叠**折了但不收敛**的收敛计数——折完仍超窗连续 ≥2 轮的
  // 会话被收敛为 failed + `context_not_converging`（写点见
  // agent-runtime.service.ts 的「折叠派生账本 + 连续不收敛熔断」段）。
  // 与上面 N6 的 unrecoverable 互补（折不动 vs 折了没用），两者不得混为一谈。
  | "autoflow_agent_context_not_converging_total"
  // 推理质量轮：LLM 调用的重试结局（分类判据见 agent-llm-retry.ts）
  | "autoflow_agent_llm_retry_total"
  // S7-G1 补丁（取证面缺口必须可查询）：`tryAppendEvent` 的**旁路失败**计数。
  // fail-open 是纪律（事件写失败不得拖垮主链），但「日志静默变短」必须是一条
  // 可查询、可告警的信号——见 RUNTIME_COUNTERS 内该条目的长注释。
  | "autoflow_agent_event_append_failed_total"
  // 推理质量轮：AI 调用的**前缀缓存命中率**（hit/miss 计数，比值即命中率）
  | "autoflow_ai_cache_lookup_total"
  // OBS3-05（P2 观测审计）：指标**渲染期取数失败**自监控——每 +1 一次
  // = 一次「本轮 /api/metrics 里某个 gauge 保留了旧值」。
  | "autoflow_metrics_render_error_total"
  // S3-C5（P0 · 数据丢失档）：stale sweep 的「不得覆盖更新工作」门禁拒绝次数。
  // 护栏把「存在更新 run / 被别的在跑执行占用 / 有活跃租约」的僵尸行挡在终态
  // 之外，代价是这条行继续占着执行器槽位（槽位只随终态释放）⇒ runningTaskCount
  // 虚高。本计数器是「护栏是否在造成运维积压」的**唯一监控信号**（warn 日志会
  // 随轮转消失，见 docs/operations.md「僵尸执行被门禁挡住」）。
  | "autoflow_stale_finalization_deferred_total";

/**
 * S3-C5：`autoflow_stale_finalization_deferred_total` 的 `reason` 标签全集。
 *
 * 与 `apps/admin-api/src/modules/scheduler/scheduler.service.ts` 的 deferral
 * 原因分类**逐字一致**（三条门禁 + 一条兜底），由
 * `scheduler.service.finalization-guard.spec.ts` 断言两侧不漂移——同
 * `AGENT_KINDS` / `agent-metrics-labels.spec.ts` 的手工收口纪律（metrics 模块
 * 位于依赖链上游，不能反向 import scheduler 的常量）。
 *
 * 为什么必须登记 0 值基线：告警表达式是 `increase(...[1h]) > 0`，未铺基线的
 * 组合在首次命中前是「无数据」而不是 0，而这条指标的价值恰恰在于
 * 「**一直是 0** = 门禁没在造成积压」——无数据与 0 对告警语义完全不同。
 */
export const RUNTIME_STALE_FINALIZATION_DEFERRED_REASONS = [
  /** 同任务存在 createdAt >= 本行的更新执行（G-NEWER 拒绝）。 */
  "newer_execution_exists",
  /** 同任务还有另一条打开态执行（pending/running/waiting，G-OCCUPIED 拒绝）。 */
  "task_occupied_by_another_run",
  /** 别的收尾者持有未过期租约（G-LEASE 拒绝）。 */
  "lease_held",
  /** 兜底：仍在打开态却没有命中任何已知判据（正常为 0；非 0 说明判据面漏了一条）。 */
  "unknown_guard",
] as const;

/**
 * 收尾门禁拒绝原因的类型（= 上面登记表的取值联合）。
 *
 * `scheduler.service.ts` 用 `import type` 把产出侧钉在这个联合上：新增一条门禁
 * 分支而忘记登记标签，会先在编译期红，而不是让新取值变成「无数据」（告警漏报）
 * 或未登记的裸 label（series 面漂移）。
 */
export type RuntimeStaleFinalizationDeferredReason =
  (typeof RUNTIME_STALE_FINALIZATION_DEFERRED_REASONS)[number];

/**
 * OBS3-05：`autoflow_metrics_render_error_total` 的 `query` 标签全集
 * ——**固定枚举**，不是错误对象里的任意字符串。
 *
 * 取值来自 `prometheus-metrics.service.ts` 里**真实存在的 catch 落点**（每个
 * 值都必须有生产者，否则就是一条永远 0 的假 series，见下）：
 *  · `executor_disk`  — `renderExecutorDiskWaterLevel` 的 find() 抛错；
 *  · `executor_fleet` — `renderExecutorFleetGauges` 的 count() 抛错。
 *
 * 为什么不收 `pg_pool`：池水位的取数函数 `readPgPoolSnapshot` **不抛错**——
 * 句柄不可读时返回 null，渲染侧以 `max=0` 表达（见该函数注释与 README §4.2
 * "max_connections == 0 表示池句柄不可读"）。给它一个永远 0 的 series 会让
 * `increase(...) > 0` 的告警看起来「有覆盖」而实际不可能触发，属于制造假安全感。
 * 将来若池水位改成会抛错的取数路径，再往这个数组里加值（连带 0 值基线）。
 *
 * 为什么必须登记进 RUNTIME_COUNTERS 的 labelValueSets：告警表达式是
 * `increase(autoflow_metrics_render_error_total[10m]) > 0`——未铺基线的组合在
 * 首次命中前是「无数据」而不是 0，而这条指标的**价值恰恰在于「一直是 0」**。
 */
export const RUNTIME_METRICS_RENDER_QUERIES = [
  "executor_disk",
  "executor_fleet",
] as const;

/** `query` 标签的取值类型（渲染侧 recordRuntime 只接受这两个之一） */
export type RuntimeMetricsRenderQuery =
  (typeof RUNTIME_METRICS_RENDER_QUERIES)[number];

/** 计数器标签集（无标签计数器传空对象） */
export type RuntimeCounterLabels = Readonly<Record<string, string>>;

/**
 * P2: Agent 指标用的标签取值集合。
 *
 * 为什么在这里**本地重复**而不是从 agent 模块 import：metrics 模块位于
 * 依赖链上游（见 metrics.module.ts 的既有约束——TaskModule 在上游，
 * 接入 DI 会引入模块环）。引入 agent 模块的常量会造出
 * metrics → agent 的编译期依赖，而 agent 又依赖 metrics 的 recordRuntime
 * （运行时值导入，无环）。故此处保持字面量，并由
 * `agent-metrics-labels.spec.ts` 断言两侧一致——这正是项目
 * `check-enum-drift` 精神的手工收口（漂移即测试变红）。
 */
export const AGENT_KINDS = [
  "ops_watch",
  "incident",
  "sop_authoring",
  "sop_review",
  "app_scaffold",
  "chat",
] as const;

export const AGENT_TERMINAL_STATUSES = [
  "succeeded",
  "failed",
  "aborted",
  "budget_exceeded",
] as const;

/**
 * `autoflow_agent_event_append_failed_total{kind}` 的 `kind` 标签取值集合
 * ——与 `agent/entities/agent-event.entity.ts` 的 `AGENT_EVENT_KINDS` **逐字一致**。
 *
 * ## 为什么这个维度可以进标签（基数收敛的证明，而不是「先用了再说」）
 *
 * 任务里点名警惕过「`kind` 的取值会随事件类型增长」。若它是**模型/用户可写**的
 * 字符串（像 `autoflow_agent_tool_calls_total` 的 `tool` 曾经那样），label 面
 * 就无界——OBS3-02 正是为此把未知工具名钳成 `"unknown"`。事件 `kind` 不同，
 * 它的生产者是**代码常量**，且被三重合围成**闭集**：
 *   ① 写入侧 `AgentEventInput.kind` 的类型就是 `AgentEventKind`
 *      （= `(typeof AGENT_EVENT_KINDS)[number]`），不是 `string`；
 *   ② 每种 kind 必须在 `AGENT_EVENT_CAUSATION_RULES`（`Record<AgentEventKind, …>`）
 *      登记一条因果规则，否则新增 kind 先在**编译期**红；
 *   ③ `agent-event-causation.spec.ts` 断言规则表的键集 == `AGENT_EVENT_KINDS`。
 * 因此取值数恒为 7，随「事件类型有几种」增长，而不随流量/会话/输入增长。
 *
 * 为什么在这里**本地重复**而不 import 实体常量：metrics 模块位于依赖链上游
 * （见 metrics.module.ts 的既有约束），反向 import agent 会造出编译期环——
 * 与 `AGENT_KINDS` 完全同一处理。漂移由 `agent-metrics-labels.spec.ts` 双向
 * 断言（集合相等 + 基线覆盖闭集），忘登记即红。
 */
export const AGENT_EVENT_KINDS = [
  "session_context_recorded",
  "step_appended",
  "tool_call_recorded",
  "tool_call_status_changed",
  "prompt_fingerprint",
  "session_finished",
  "approval_decided",
] as const;

export interface RuntimeCounterSpec {
  help: string;
  /** 无标签计数器为空数组 */
  labelNames: readonly string[];
  /** 已知标签组合——渲染时全部显式 inc 保 0 值基线（series 集合稳定） */
  labelValueSets: ReadonlyArray<Readonly<Record<string, string>>>;
}

/** 已知渠道 × {success, failure, blocked, skipped} 的全部组合（R33-A1 起 6×4=24） */
const notificationLabelValueSets: Array<Record<string, string>> = [];
for (const channel of RUNTIME_NOTIFICATION_CHANNELS) {
  for (const result of RUNTIME_NOTIFICATION_RESULTS) {
    notificationLabelValueSets.push({ channel, result });
  }
}

export const RUNTIME_COUNTERS: Record<RuntimeCounterName, RuntimeCounterSpec> =
  {
    autoflow_execution_result_total: {
      help: "Execution terminal outcomes recorded at the unified terminal-transition entry (unique-winner update only), by final status",
      labelNames: ["status"],
      labelValueSets: RUNTIME_EXECUTION_RESULT_LABELS.map((status) => ({
        status,
      })),
    },
    autoflow_sse_streams_rejected_total: {
      help: "SSE stream slot acquisitions rejected by the concurrency limits (log streams, /metrics/stream and /executions/stream share the same slot service)",
      labelNames: [],
      labelValueSets: [{}],
    },
    // PLAN-SECURITY-HARDENING §2.2（2026-10-17 优化计划轮）：SSE 票据被拒
    // 分类。埋点在 JwtStrategy.assertTicketOnlyOnStreamPath 的拒绝分支。
    //
    // 为什么需要：A5 把 SSE 凭据从「15 分钟 access token 进 URL」改成
    // 「30 秒、路径受限的 ticket」，SEC-SSE-TICKET（P1-2）又补上了「票据
    // 只在三条 stream 路径有效」。但**修复本身没有可观测性**——票据被拿去
    // 打 REST 端点（= 泄漏的票据正被试探复用，典型攻击形态）时，系统只是
    // 静默返回 401，没有任何计数器、没有审计、没有告警，安全事件完全不可见。
    //
    // 单值 reason（而非标签矩阵）：当前唯一的拒绝原因是路径不符；保留
    // reason 标签是为了将来加「票据类型错配」「票据已用过」时不必改指标名。
    autoflow_sse_ticket_rejected_total: {
      help: "SSE tickets rejected by the path-binding guard, by reason (wrong_path = a ticket was presented on a non-stream route, i.e. a leaked ticket being replayed)",
      labelNames: ["reason"],
      labelValueSets: [{ reason: "wrong_path" }],
    },
    autoflow_notification_delivery_total: {
      help: "Notification fan-out deliveries by channel and result (success / failure / blocked = SSRF policy block / skipped = channel not configured)",
      labelNames: ["channel", "result"],
      labelValueSets: notificationLabelValueSets,
    },
    autoflow_callback_business_total: {
      help: "Execution callback business outcomes by result (accepted / duplicate / not_found / address_mismatch / error)",
      labelNames: ["result"],
      labelValueSets: RUNTIME_CALLBACK_BUSINESS_LABELS.map((result) => ({
        result,
      })),
    },
    // BUG-01（N51 收口）：reload-config 推送遇 401 后的重签重试可观测性。
    // result 标签区分两条路径：reissued_success（重签后重试 2xx，执行器一个
    // 心跳内自愈的过渡态）与 still_unauthorized（重试后仍 401，执行器顽固
    // 失配，需人工 rotate-token）。埋点在 ExecutorController.reloadConfig，
    // 与本文件其余计数器同走 recordRuntime → render 快照模式。
    autoflow_push_auth_retry_total: {
      help: "Reload-config push 401 re-issue retries by result (reissued_success / still_unauthorized)",
      labelNames: ["result"],
      labelValueSets: [
        { result: "reissued_success" },
        { result: "still_unauthorized" },
      ],
    },
    // ARCH-30: AI 分析结果分类——埋点在 AiAnalysisService.analyzeFailure
    // （task.processor / task.service.analyzeExecution 统一经服务调用），
    // 与本文件其余计数器同走 recordRuntime → render 快照模式。
    autoflow_ai_analysis_total: {
      help: "AI failure-analysis outcomes by result (ok / fail / skipped)",
      labelNames: ["result"],
      labelValueSets: [
        { result: "ok" },
        { result: "fail" },
        { result: "skipped" },
      ],
    },
    // ═══ P2（agent-and-deployment）：中台 Agent 运行时 ═══
    // 会话终态分布。status 覆盖面与 AgentSessionStatus 对齐——含
    // budget_exceeded（预算触顶）与 aborted（人工中止），二者是运维关注重点。
    autoflow_agent_sessions_total: {
      help: "Agent sessions reaching a terminal status, by kind and status",
      labelNames: ["kind", "status"],
      labelValueSets: AGENT_KINDS.flatMap((kind) =>
        AGENT_TERMINAL_STATUSES.map((status) => ({ kind, status })),
      ),
    },
    // 成本核心指标：令牌消耗（in/out 分开，因为定价通常不同）。
    // 这是**唯一**能回答「这功能一个月花多少」的数据源。
    autoflow_agent_tokens_total: {
      help: "Agent LLM token consumption by provider, model and direction (cost attribution source of truth)",
      labelNames: ["provider", "model", "direction"],
      labelValueSets: [
        { provider: "qwen", model: "qwen-vl-max", direction: "in" },
        { provider: "qwen", model: "qwen-vl-max", direction: "out" },
        { provider: "openai", model: "gpt-4o-mini", direction: "in" },
        { provider: "openai", model: "gpt-4o-mini", direction: "out" },
        { provider: "ollama", model: "llama3", direction: "in" },
        { provider: "ollama", model: "llama3", direction: "out" },
      ],
    },
    // 工具调用分布。status 含 denied（边界拦截）与 circuit_open（熔断）——
    // 这两个是**安全信号**：denied 激增说明 Agent 在尝试越界或被 scope 卡住。
    autoflow_agent_tool_calls_total: {
      help: 'Agent tool invocations by tool, tier and status (denied/circuit_open are security signals; unknown tool names are clamped to "unknown")',
      labelNames: ["tool", "tier", "status"],
      // OBS3-02（第 3 轮观测审计）：`tool` 曾经直接取模型返回的
      // `call.function.name` 就进 label——模型可以每次编一个新名字，label 面
      // 无界（Prometheus 基数爆炸 + 渲染内存随会话线性增长）。现在写入侧
      // （agent-session.service.metricToolLabel）把**不在工具注册表里的名字
      // 一律归并为 "unknown"**，tool 取值因此被真实工具集钳死。
      //
      // 下面这几条只是**常见组合的 0 值基线**，不是全集（真实工具 50+ ×
      // 6 种状态）。此前的注释声称「已知标签组合全部 inc(0)」与事实不符：
      // 0 值基线只服务「面板在首次事件前就有 series」，完整覆盖由
      // 「tool 有界 + 其余标签是枚举」保证，不靠穷举。
      labelValueSets: [
        { tool: "list_tasks", tier: "read", status: "ok" },
        { tool: "get_execution", tier: "read", status: "ok" },
        { tool: "trigger_task", tier: "write", status: "ok" },
        {
          tool: "deploy_application",
          tier: "write",
          status: "awaiting_approval",
        },
        { tool: "approve_deployment", tier: "dangerous", status: "denied" },
      ],
    },
    // 边界闸门拦截计数——按原因区分（设计文档 03 §5.1 的七道检查；
    // ⑦ = 自动化会话引入可执行代码源，C1，2026-10-31）。
    autoflow_agent_denied_total: {
      help: "Agent tool calls denied by the boundary gate, by reason (allowlist / approval / params / scope / rate / code-source-in-automation)",
      labelNames: ["reason"],
      labelValueSets: [
        { reason: "not_in_toolset" },
        { reason: "needs_approval" },
        { reason: "invalid_params" },
        { reason: "out_of_scope" },
        { reason: "rate_limited" },
        { reason: "circuit_open" },
        { reason: "hard_disabled" },
        // ⑦：自动化会话经 overrides/patch 引入 glueSource 等代码源。
        // 必须登记 0 值基线：它的价值恰恰在于「一直是 0」——首次命中前若
        // 是「无数据」而不是 0，`increase(...) > 0` 的告警就形同虚设。
        { reason: "executable_source_in_automation" },
      ],
    },
    // 预算触顶计数。与令牌指标同属**防成本事故**的双保险：令牌回答
    // 「已花多少」，本项回答「有多少次差点失控」。
    autoflow_agent_budget_exceeded_total: {
      help: "Agent sessions that hit a budget gate, by reason (max_steps / max_tokens / wall_clock / max_tool_calls)",
      labelNames: ["reason"],
      labelValueSets: [
        { reason: "max_steps" },
        { reason: "max_tokens" },
        { reason: "wall_clock" },
        { reason: "max_tool_calls" },
      ],
    },
    // N6（R6-b / DA §4.2）：注定失败的上下文调用提前收敛。**无标签**：它的
    // 价值在于「有没有发生」与时间序列，而不是按维度拆分（provider/model 是
    // 用户自定义维度，登记成标签会让 series 爆炸——同 autoflow_ai_cache_lookup_total
    // 的既有理由）。**默认关**（`agent.context.preemptUnrecoverable`，缺省 false）：
    // 关时这条 series 恒 0，0 值基线仍登记（series 集合稳定）。开时非 0 = 有会话的
    // 上下文已经无法靠折叠救回：值班动作是清历史/换大窗口/调
    // agent.context.maxTokens，而不是查 provider。
    autoflow_agent_context_unrecoverable_total: {
      help: "Agent turns converged as context_unrecoverable without calling the provider — feature-gated by agent.context.preemptUnrecoverable (default off, so this series stays 0 unless explicitly enabled). Enabled: measured prompt tokens + output reserve already exceeded agent.context.maxTokens and folding changed nothing, i.e. the turn was over the configured window budget and could no longer be folded back into it",
      labelNames: [],
      labelValueSets: [{}],
    },
    // S2-A2（R5/R18）：**折了但不收敛**的收敛计数（`context_not_converging`）。
    // 与上一行的 unrecoverable 是互补信号，不是同一条：那一行回答「折不动」，
    // 本行回答「折了没用」——连续 ≥2 轮 `foldedMessages > 0 && tokensAfter >
    // maxTokens` 后会话收敛为 failed。**无标签**（同上一行的 series 爆炸理由）；
    // 本项**没有开关**（判据量的是折叠的实际效果，不是「估算略超窗口」）。
    autoflow_agent_context_not_converging_total: {
      help: "Agent sessions converged as context_not_converging — folding did run (foldedMessages > 0) but the folded prompt was still over agent.context.maxTokens for CONTEXT_FOLD_STREAK_LIMIT (2) consecutive turns, so the session was failed without another provider call. Complementary to autoflow_agent_context_unrecoverable_total (folding could not run at all)",
      labelNames: [],
      labelValueSets: [{}],
    },
    // 推理质量轮：LLM 重试结局。为什么单独一个计数器而不是只看 failed：
    // 「重试后成功」（recovered）与「重试耗尽」（exhausted）在会话终态上
    // **长得一样**（都是 succeeded / failed），只能靠这里区分"provider 在抖"
    // 与"provider 真的坏了"；fatal 占比高则是配置问题（密钥/参数），根本
    // 不该去调重试次数。
    // 前缀缓存命中率：只回答一个运营问题——「给这家厂商开着视频对话，
    // 缓存到底有没有省到钱」。没有 provider 维度：registry 的 labelValueSets
    // 需要**固定枚举**，而 provider 是用户自定义的（动态维度会让 series 爆炸）；
    // 需要按厂商看时，看日志里的 `cachedTokens` 更直接。
    autoflow_ai_cache_lookup_total: {
      help: "AI calls by prompt-cache lookup result (hit / miss) — ratio is the cache hit rate",
      labelNames: ["result"],
      labelValueSets: [{ result: "hit" }, { result: "miss" }],
    },
    autoflow_agent_llm_retry_total: {
      help: "Agent LLM call retry and recovery outcomes (scheduled / recovered / exhausted / fatal / deadline / approved_replay / resume_queued / resume_enqueue_failed)",
      labelNames: ["result"],
      // OBS3-08（第 3 轮观测审计）：写入侧实际会产出 approved_replay（已批准
      // 调用的确定性重放）、resume_queued（瞬态耗尽排自动续跑）、
      // resume_enqueue_failed（排续跑失败）——这三条此前没有登记，既无 0 值
      // 基线，也与 help 声明的「LLM 重试结局」语义不同源（它们属于恢复面）。
      // 登记后 help 与 series 集合才与真实写入一致。
      labelValueSets: [
        { result: "scheduled" },
        { result: "recovered" },
        { result: "exhausted" },
        { result: "fatal" },
        { result: "deadline" },
        { result: "approved_replay" },
        { result: "resume_queued" },
        { result: "resume_enqueue_failed" },
      ],
    },
    // S7-G1 补丁（取证面缺口必须可查询）：旁路事件写入的失败计数。
    //
    // ## 为什么这条必须有（而不是「已经有一条 warn 了」）
    //
    // `tryAppendEvent` 的 fail-open 是**有意纪律**（事件写失败绝不把会话拖成
    // failed），代价写在它的注释里：**事件可能缺失，且缺口不会自我修补**。
    // 但此前失败只有一条 `logger.warn`：日志随轮转消失，而 `agent_events` 里剩下
    // 的事件**仍然 seq 连续、投影照常渲染**——它看起来是全的。取证日志被信任却
    // 已经不完整，比没有日志更危险：S7-G1 的整个理由是回答「第 N 轮模型看到
    // 什么」，一次 prompt_fingerprint 丢失就会让这个问题得到**看似确定的错答案**。
    // 所以缺口必须变成一条**可查询、可告警、可算 rate** 的序列，与 warn 同源
    // （写点在同一 catch 里，先计数后 warn）。
    //
    // 语义边界：
    //   · 恒为 0 = 取证序列完整（健康态）；
    //   · `increase(...[10m]) > 0` = 这 10 分钟里有事件被丢弃，且**会话本身多半
    //     仍是 succeeded**（这正是它需要独立告警的原因——会话终态指标看不出来）；
    //   · 它不是「写入慢」的指标：只记**最终失败**（重试耗尽/批量误用/FK 违例/
    //     连续性断言失败），`appendEvents` 内部的 23505 重试成功不计。
    //
    // kind 标签为何不炸基数：取值 = `AGENT_EVENT_KINDS` 闭集 7 值（证明见上方
    // 该常量的注释），不是模型/用户可写维度。
    autoflow_agent_event_append_failed_total: {
      help: "Agent forensic event-log (agent_events) appends DROPPED by the tryAppendEvent bypass, by event kind. The fail-open is deliberate (an event-write failure must never fail the session), so this counter is the ONLY queryable signal that the S7-G1 forensic trail is incomplete — the warn line dies with log rotation while the surviving events still look contiguous. Stays 0 when the trail is whole; increase(...[10m]) > 0 means events were lost (DB blip / pool exhaustion / seq contention / FK violation / batch misuse) on sessions that still report success.",
      labelNames: ["kind"],
      labelValueSets: AGENT_EVENT_KINDS.map((kind) => ({ kind })),
    },
    // OBS3-05：渲染期取数失败的一等指标（kube-state-metrics / node_exporter
    // 的 textfile-collector 同一姿态——「这轮没读到」必须自己是一条 series，
    // 而不是让业务 gauge 静默陈旧）。埋点在 PrometheusMetricsService 的两个
    // catch 里（同一个 logRenderFailure：先 recordRuntime 再限流 warn），
    // 因此「日志里有一条 warn」与「计数器 +1」永远同源。
    autoflow_metrics_render_error_total: {
      help: "Metrics render-time data-fetch failures by query (executor_disk / executor_fleet) — non-zero means /api/metrics exposed a stale value for that query's target on that scrape",
      labelNames: ["query"],
      labelValueSets: RUNTIME_METRICS_RENDER_QUERIES.map((query) => ({
        query,
      })),
    },
    // S3-C5：stale sweep 的「不得覆盖更新工作」门禁**新记录**一条 deferral 证据
    // 时 +1（同一 reason+successor 的重复拒绝不重复计数——计数器与
    // recoveryHistory 的证据条数永远同源，见 scheduler 的 reportDeferredFinalizations）。
    //
    // 语义边界（写进 help 与文档，避免值班误读）：
    //   · 恒为 0 = 门禁没有拒绝过任何收尾（健康态）；
    //   · `increase[1h] > 0` = 这一小时里**新出现**了「有更新工作在先、故不清扫」
    //     的僵尸行 ⇒ 执行器槽位开始被这类行占住（容量泄漏的起点）；
    //   · 稳定的存量积压（同一批行持续被挡、successor 未变）**不会**让本计数继续
    //     增长——存量积压的例行巡检走 SQL（docs/operations.md 给出语句），
    //     不看 increase。
    autoflow_stale_finalization_deferred_total: {
      help: "Stale executions whose finalization was REFUSED by the 'never overwrite newer work' guard, by reason (newer_execution_exists / task_occupied_by_another_run / lease_held / unknown_guard). Each newly persisted deferral evidence counts once (same reason+successor is deduplicated). Stays 0 when the guard never refuses; increase(...[1h]) > 0 means new zombie rows are now holding executor slots (capacity leak start).",
      labelNames: ["reason"],
      labelValueSets: RUNTIME_STALE_FINALIZATION_DEFERRED_REASONS.map(
        (reason) => ({ reason }),
      ),
    },
  };

/**
 * BUG-05（SSE 多实例容量可观测）：运行时 Gauge 声明。
 *
 * 与 RUNTIME_COUNTERS 的差异：gauge 是瞬时值（不是单调累计），渲染侧
 * set() 绝对值重建而非 reset+inc。交接通道与计数器相同——
 * runtime-metrics-entry.ts 的模块级注册表（TaskService 埋点、
 * PrometheusMetricsService 渲染，无模块环）。
 * 多实例部署语义：每个实例暴露自己的进程内活跃流数，容量上限 =
 * 实例数 × SSE_MAX_STREAMS_GLOBAL（线性叠加），由抓取方按 instance 聚合。
 */
export type RuntimeGaugeName =
  | "autoflow_sse_streams_active"
  | "autoflow_sse_streams_limit"
  | "autoflow_metrics_streams_active"
  | "autoflow_metrics_streams_limit";

export interface RuntimeGaugeSpec {
  help: string;
}

export const RUNTIME_GAUGES: Record<RuntimeGaugeName, RuntimeGaugeSpec> = {
  autoflow_sse_streams_active: {
    help: "Currently active SSE log-stream connections held by this process (TASK-008 slot registry) — stream water level; alert when sum(active)/sum(limit) > 0.8 sustained 10m",
  },
  autoflow_sse_streams_limit: {
    help: "Configured global SSE log-stream concurrency limit of this instance (SSE_MAX_STREAMS_GLOBAL) — denominator of the stream utilization water level",
  },
  // UI-14 第一阶段：Dashboard 汇总流（GET /metrics/stream）水位——与日志流
  // 分开计数（容量画像不同，见 metrics-stream-slot.service.ts 头注）。
  autoflow_metrics_streams_active: {
    help: "Currently active metrics summary SSE streams held by this process (UI-14 /metrics/stream slot registry)",
  },
  autoflow_metrics_streams_limit: {
    help: "Configured global metrics summary SSE stream concurrency limit of this instance (METRICS_STREAM_MAX_GLOBAL)",
  },
};
