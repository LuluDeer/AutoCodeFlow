/**
 * MCP tool registrations for AutoCodeFlow.
 * Each `register*Tools(server, call)` keeps HTTP concerns in the injected
 * `call` function so routes/params/responses can be unit-tested with a mock.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

export type ApiCall = <T = unknown>(
  method: string,
  path: string,
  body?: unknown,
  timeoutMs?: number,
) => Promise<T>;

/**
 * NETOPT-6④：analyze/suggest 类工具的 per-call 超时预算。
 *
 * admin 侧同步 AI 预算是 60s×2（两次 LLM 往返），而 apiRequest 默认
 * REQUEST_TIMEOUT_MS=30s 结构性小于服务端预算——AI 恰好跑满预算成功返回时，
 * 客户端早已放弃。analyze_execution / suggest_schedule / analyze_application
 * 这三个同步 AI 端点用 120s 覆盖（> 服务端 60s×2），其余端点维持 30s 默认。
 */
export const ANALYZE_TIMEOUT_MS = 120_000;

const JSON_CONTENT = (data: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
});

/**
 * 错误面统一口径：HTTP 失败由 apiRequest 抛错、MCP SDK 转成
 * isError:true + error.message；而「参数可解析但语义无效」的用法错误
 * （未知模板/未知应用名/缺二选一 id）发生在 handler 内部——也必须带
 * isError:true，否则 MCP 客户端会把失败当成功。结构化 JSON 负载保留
 * （如 available 列表），让 agent 同时拿到失败信号与下一步可用的取值。
 */
const JSON_ERROR = (data: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
  isError: true as const,
});

/**
 * D1-P2-2: 路径插值 id 的入站白名单。后端 task/task-version/task-execution/
 * application/app-deployment/executor/project 主键均为 @PrimaryGeneratedColumn("uuid")。
 * 此前裸 z.string() 直接拼进 /tasks/:id 路径，畸形值（../、斜杠、编码穿越）可造成
 * 路径穿越；统一收窄为 UUID，非法值在 MCP SDK 入站校验层即拒（不到网络层）。
 */
const UUID_PATH_ID = z.string().uuid();

// ---------------------------------------------------------------------------
// Task templates (ECO-03: create_task_from_template)
// ---------------------------------------------------------------------------
/** Task field payloads must stay within CreateTaskDto (forbidNonWhitelisted
 * would 400 on stray fields). Templates omit name — supplied per call. */
export const TASK_TEMPLATES: Record<
  string,
  { description: string; config: Record<string, unknown> }
> = {
  scheduled_backup: {
    description:
      "Periodic backup job: runs on a cron schedule with retries on transient failure",
    config: {
      triggerType: "cron",
      cronExpression: "0 2 * * *",
      runtime: "shell",
      entrypoint: "backup.sh",
      timeoutSeconds: 3600,
      maxRetry: 3,
      retryDelay: 60,
      blockStrategy: "discard",
    },
  },
  health_check: {
    description:
      "Endpoint/service health probe every minute, low timeout, no retry (fail fast)",
    config: {
      triggerType: "fixed_rate",
      fixedRate: 60,
      runtime: "shell",
      entrypoint: "check.sh",
      timeoutSeconds: 30,
      maxRetry: 0,
    },
  },
  data_sync: {
    description:
      "Data sync pipeline: longer timeout, serial execution (no overlap), retries with backoff",
    config: {
      triggerType: "fixed_rate",
      fixedRate: 1800,
      runtime: "python",
      entrypoint: "sync.py",
      timeoutSeconds: 7200,
      maxRetry: 2,
      retryDelay: 300,
      blockStrategy: "discard",
    },
  },
  log_cleanup: {
    description:
      "Daily housekeeping: prune old files/logs on the executor host",
    config: {
      triggerType: "cron",
      cronExpression: "30 3 * * *",
      runtime: "shell",
      entrypoint: "cleanup.sh",
      timeoutSeconds: 600,
      maxRetry: 1,
    },
  },
  webhook_ping: {
    description:
      "Manual/API-triggered outbound webhook notifier (typically chained as a downstream dependency)",
    config: {
      triggerType: "manual",
      runtime: "node",
      entrypoint: "ping.js",
      timeoutSeconds: 60,
      maxRetry: 1,
    },
  },
};

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------
export function registerTaskTools(server: McpServer, call: ApiCall): void {
  // ---- list_tasks ----------------------------------------------------------
  server.tool(
    "list_tasks",
    "List tasks defined in AutoCodeFlow with optional status/name filtering. Returns the backend paginated envelope { list, items, total, page, pageSize, totalPages } (list and items carry the same rows); each row has id, name, status, trigger config (cron or fixed rate), and last trigger time.",
    {
      page: z
        .number()
        .int()
        .min(1)
        .default(1)
        .describe("Page number (default 1)"),
      pageSize: z
        .number()
        .int()
        .min(1)
        .max(100)
        .default(20)
        .describe("Items per page (default 20)"),
      status: z
        .string()
        .optional()
        .describe("Filter by task status: active | paused"),
      name: z
        .string()
        .optional()
        .describe(
          "Filter by task name (fuzzy match, backend ListTasksQueryDto field)",
        ),
    },
    async ({ page, pageSize, status, name }) => {
      const params = new URLSearchParams({
        page: String(page),
        pageSize: String(pageSize),
        ...(status ? { status } : {}),
        ...(name ? { name } : {}),
      });
      const data = await call<unknown>("GET", `/tasks?${params}`);
      return JSON_CONTENT(data);
    },
  );

  // ---- get_task ------------------------------------------------------------
  server.tool(
    "get_task",
    "Get full details of a specific task by its ID, including script source, cron, timeout, and dependencies.",
    {
      taskId: UUID_PATH_ID.describe("Task ID"),
    },
    async ({ taskId }) => {
      const data = await call<unknown>("GET", `/tasks/${taskId}`);
      return JSON_CONTENT(data);
    },
  );

  // ---- trigger_task --------------------------------------------------------
  server.tool(
    "trigger_task",
    "Manually trigger a task to run immediately. Returns the execution ID that can be polled with get_execution.",
    {
      taskId: UUID_PATH_ID.describe("Task ID to trigger"),
      params: z
        .record(z.string(), z.unknown())
        .optional()
        .describe("Optional runtime parameters to pass to the task"),
      // NOTE: no executorId parameter here — TriggerTaskDto only accepts
      // `params`, and the backend's global ValidationPipe runs with
      // forbidNonWhitelisted, so a per-trigger pin would be rejected with 400.
      // Executor pinning IS supported by the backend, but as a task-level
      // field (tasks.executorId, set via create/update — see the update_task
      // tool), not a per-run override.
    },
    async ({ taskId, params }) => {
      const data = await call<unknown>("POST", `/tasks/${taskId}/trigger`, {
        ...(params ? { params } : {}),
      });
      return JSON_CONTENT(data);
    },
  );

  // ---- update_task ---------------------------------------------------------
  server.tool(
    "update_task",
    'Update an existing task via PATCH (only the fields you pass are changed). Supports executor pinning: set executorId to pin the task to one executor (fails fast if it is offline), or pass executorId: null to clear the pin. executorId is mutually exclusive with executeMode="broadcast" — the backend rejects that combination with 400.',
    {
      taskId: UUID_PATH_ID.describe("Task ID to update"),
      name: z.string().optional().describe("New task name"),
      description: z.string().optional().describe("New task description"),
      status: z.string().optional().describe("Task status: active | paused"),
      triggerType: z
        .string()
        .optional()
        .describe("Trigger type: cron | fixed_rate | api | manual"),
      cronExpression: z
        .string()
        .optional()
        .describe("Cron expression (5 fields) for cron triggers"),
      timezone: z
        .string()
        .optional()
        .describe("IANA timezone for cron schedules, e.g. Asia/Shanghai"),
      fixedRate: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe("Fixed interval in seconds for fixed_rate triggers"),
      runtime: z
        .string()
        .optional()
        .describe("Runtime type: node | python | shell (backend enum — other values are rejected with 400)"),
      entrypoint: z
        .string()
        .optional()
        .describe("Entry point file path relative to the repo root"),
      timeoutSeconds: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe(
          "Execution timeout in seconds (0 = no limit; backend accepts 0-86400)",
        ),
      maxRetry: z
        .number()
        .int()
        .min(0)
        .max(10)
        .optional()
        .describe("Max retry attempts (0-10)"),
      executeMode: z
        .string()
        .optional()
        .describe(
          "Dispatch mode: single | broadcast. broadcast fans out to all online executors and cannot be combined with executorId.",
        ),
      executorId: z
        .string()
        .nullable()
        .optional()
        .describe(
          "Pin the task to this executor ID (uuid). Pass null to remove an existing pin. Mutually exclusive with executeMode=broadcast.",
        ),
      executorGroup: z
        .string()
        .optional()
        .describe("Restrict auto-dispatch to executors in this group"),
      executorTags: z
        .array(z.string())
        .optional()
        .describe(
          "Restrict auto-dispatch to executors carrying all these tags",
        ),
      params: z
        .record(z.string(), z.unknown())
        .optional()
        .describe("Default runtime parameters"),
      applicationId: z
        .string()
        .optional()
        .describe("Associated application ID"),
    },
    async ({ taskId, ...fields }) => {
      // Drop undefined fields so PATCH only touches what the caller supplied;
      // keep explicit nulls (e.g. executorId: null) so a pin can be cleared.
      const body = Object.fromEntries(
        Object.entries(fields).filter(([, v]) => v !== undefined),
      );
      const data = await call<unknown>("PATCH", `/tasks/${taskId}`, body);
      return JSON_CONTENT(data);
    },
  );

  // ---- list_task_versions --------------------------------------------------
  server.tool(
    "list_task_versions",
    "List the historical configuration versions of a task (newest first). Use with rollback_task_version / compare_task_versions.",
    {
      taskId: UUID_PATH_ID.describe("Task ID"),
    },
    async ({ taskId }) => {
      const data = await call<unknown>("GET", `/tasks/${taskId}/versions`);
      return JSON_CONTENT(data);
    },
  );

  // ---- rollback_task_version ----------------------------------------------
  server.tool(
    "rollback_task_version",
    "Roll a task back to a specific historical version snapshot. Returns the updated task.",
    {
      taskId: UUID_PATH_ID.describe("Task ID"),
      versionId: UUID_PATH_ID.describe("Version ID to roll back to (from list_task_versions)"),
    },
    async ({ taskId, versionId }) => {
      const data = await call<unknown>(
        "POST",
        `/tasks/${taskId}/versions/${versionId}/rollback`,
      );
      return JSON_CONTENT(data);
    },
  );

  // ---- compare_task_versions ----------------------------------------------
  server.tool(
    "compare_task_versions",
    "Diff two task versions. Returns a map of changed fields with their old and new values.",
    {
      taskId: UUID_PATH_ID.describe("Task ID"),
      versionId1: UUID_PATH_ID.describe("First version ID"),
      versionId2: UUID_PATH_ID.describe("Second version ID"),
    },
    async ({ taskId, versionId1, versionId2 }) => {
      const data = await call<unknown>(
        "GET",
        `/tasks/${taskId}/versions/${versionId1}/compare/${versionId2}`,
      );
      return JSON_CONTENT(data);
    },
  );

  // ---- list_executions ------------------------------------------------------
  // 分页参数与其余 list_* 工具统一口径（default 20 / max 100，对齐后端
  // PageQueryDto 契约）；此前 default 10 / max 50 是无出处的独头部形状。
  server.tool(
    "list_executions",
    "List recent task executions (newest first). Optionally filter by taskId and status.",
    {
      taskId: UUID_PATH_ID.optional().describe("Filter by task ID"),
      status: z
        .string()
        .optional()
        .describe(
          "Filter by status: pending | running | waiting | success | failed | timeout | killed | cancelled",
        ),
      page: z
        .number()
        .int()
        .min(1)
        .default(1)
        .describe("Page number (default 1)"),
      pageSize: z
        .number()
        .int()
        .min(1)
        .max(100)
        .default(20)
        .describe("Items per page, max 100 (default 20)"),
    },
    async ({ taskId, status, page, pageSize }) => {
      const params = new URLSearchParams({
        page: String(page),
        pageSize: String(pageSize),
        ...(taskId ? { taskId } : {}),
        ...(status ? { status } : {}),
      });
      const data = await call<unknown>(
        "GET",
        `/tasks/executions/all?${params}`,
      );
      return JSON_CONTENT(data);
    },
  );

  // ---- get_execution --------------------------------------------------------
  // 大输出治理（对齐 admin-api PERF-03 的同一决策）：GET /tasks/executions/:id
  // 的 compat alias 原样回传实体行，其中 logs 是 text 列、单条上限 512_000
  // 字符——后端已把列表/详情/统计读面的日志全部迁到独立分页端点
  // GET .../logs（本包的 get_execution_logs 工具）。这里如实剥离并在响应里
  // 说明去向（而不是静默丢弃或把 512KB 塞进 agent 上下文）。
  server.tool(
    "get_execution",
    "Get the details of a specific execution by ID: status, duration, result, runtime params, error info, and AI analysis if available. The full log payload is stripped from this response (single rows can reach 512 KB) — page through logs with get_execution_logs.",
    {
      executionId: UUID_PATH_ID.describe("Execution ID"),
    },
    async ({ executionId }) => {
      const data = await call<Record<string, unknown>>(
        "GET",
        `/tasks/executions/${executionId}`,
      );
      if (data && typeof data === "object" && "logs" in data) {
        const { logs: _logs, ...rest } = data;
        return JSON_CONTENT({
          ...rest,
          logsStripped: true,
          note: "The full log payload was stripped from this response (it can reach 512 KB). Page through it with get_execution_logs (fromLine/limit).",
        });
      }
      return JSON_CONTENT(data);
    },
  );

  // ---- analyze_execution ----------------------------------------------------
  server.tool(
    "analyze_execution",
    "Trigger AI analysis on a failed execution. Returns the AI-generated root cause and fix suggestion.",
    {
      taskId: UUID_PATH_ID.describe("Task ID"),
      // 后端 analyzeExecution 不按 status 硬闸（任何执行都可分析），只是
      // failed/timeout 之外的分析没有输入也没有意义——按「预期用途」表述，
      // 不谎称前置校验。
      executionId: UUID_PATH_ID.describe(
        "Execution ID (intended for failed/timeout executions)",
      ),
    },
    async ({ taskId, executionId }) => {
      const data = await call<unknown>(
        "POST",
        `/tasks/${taskId}/executions/${executionId}/analyze`,
        undefined,
        ANALYZE_TIMEOUT_MS,
      );
      return JSON_CONTENT(data);
    },
  );

  // ---- get_execution_stats --------------------------------------------------
  server.tool(
    "get_execution_stats",
    "Get execution statistics for a task: success rate, average duration, and last 20 executions.",
    {
      taskId: UUID_PATH_ID.describe("Task ID"),
    },
    async ({ taskId }) => {
      const data = await call<unknown>("GET", `/tasks/${taskId}/stats`);
      return JSON_CONTENT(data);
    },
  );

  // ---- suggest_schedule -----------------------------------------------------
  server.tool(
    "suggest_schedule",
    "Ask AI to suggest an optimal cron schedule for a task based on its execution history (success rate, avg duration, failure patterns).",
    {
      taskId: UUID_PATH_ID.describe("Task ID"),
    },
    async ({ taskId }) => {
      const data = await call<unknown>(
        "POST",
        `/tasks/${taskId}/suggest-schedule`,
        undefined,
        ANALYZE_TIMEOUT_MS,
      );
      return JSON_CONTENT(data);
    },
  );

  // ---- get_execution_logs --------------------------------------------------
  server.tool(
    "get_execution_logs",
    "Fetch paginated execution logs for a given execution ID. Use fromLine + limit to page through large outputs.",
    {
      executionId: UUID_PATH_ID.describe("Execution ID"),
      fromLine: z
        .number()
        .int()
        .min(0)
        .default(0)
        .describe("Start line (0-based, default 0)"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(2000)
        .default(500)
        .describe("Lines to return (max 2000, default 500)"),
    },
    async ({ executionId, fromLine, limit }) => {
      const params = new URLSearchParams({
        fromLine: String(fromLine),
        limit: String(limit),
      });
      const data = await call<unknown>(
        "GET",
        `/tasks/executions/${executionId}/logs?${params}`,
      );
      return JSON_CONTENT(data);
    },
  );

  // ---- kill_execution ------------------------------------------------------
  server.tool(
    "kill_execution",
    "Force-cancel a running or pending execution by ID. Requires task ID because the underlying route is task-scoped.",
    {
      taskId: UUID_PATH_ID.describe("Task ID that owns the execution"),
      executionId: UUID_PATH_ID.describe("Execution ID to cancel"),
    },
    async ({ taskId, executionId }) => {
      const data = await call<unknown>(
        "POST",
        `/tasks/${taskId}/executions/${executionId}/kill`,
      );
      return JSON_CONTENT(data);
    },
  );

  // ---- retry_execution ------------------------------------------------------
  // NF-06: the admin API has NO native retry endpoint (grep task.controller/
  // task.service/docs — only BullMQ-side auto retry exists). Re-running a past
  // execution therefore goes through the ordinary manual-trigger path, which
  // creates a NEW execution row; the original row's params are replayed here
  // (fetched via the by-execId compat alias) so the rerun matches what the
  // failed run actually received, not today's task defaults.
  server.tool(
    "retry_execution",
    "Re-run a past execution: creates a NEW execution of the same task via the manual-trigger path (the admin API has no native retry endpoint — this is a fresh run, not a continuation of the original attempt counter). The original execution's runtime params are replayed automatically; pass params to override them. Returns the new execution (id) — poll it with get_execution.",
    {
      taskId: UUID_PATH_ID.describe("Task ID that owns the execution"),
      executionId: UUID_PATH_ID.describe("Execution ID to re-run (from list_executions / get_execution)"),
      params: z
        .record(z.string(), z.unknown())
        .optional()
        .describe(
          "Override the replayed runtime parameters (when absent, the original execution's params are reused; if it had none, the task's current defaults apply)",
        ),
    },
    async ({ taskId, executionId, params }) => {
      let body: Record<string, unknown> = {};
      if (params) {
        body = { params };
      } else {
        const prev = await call<{ params?: Record<string, unknown> | null }>(
          "GET",
          `/tasks/executions/${executionId}`,
        );
        if (prev?.params) body = { params: prev.params };
      }
      const data = await call<Record<string, unknown>>(
        "POST",
        `/tasks/${taskId}/trigger`,
        body,
      );
      return JSON_CONTENT({ retriedFrom: executionId, ...data });
    },
  );

  // ---- pause_task -----------------------------------------------------------
  server.tool(
    "pause_task",
    "Pause a task — stops scheduled triggers. In-progress executions are not affected.",
    {
      taskId: UUID_PATH_ID.describe("Task ID to pause"),
    },
    async ({ taskId }) => {
      const data = await call<unknown>("POST", `/tasks/${taskId}/pause`);
      return JSON_CONTENT(data);
    },
  );

  // ---- resume_task ----------------------------------------------------------
  server.tool(
    "resume_task",
    "Resume a previously paused task.",
    {
      taskId: UUID_PATH_ID.describe("Task ID to resume"),
    },
    async ({ taskId }) => {
      const data = await call<unknown>("POST", `/tasks/${taskId}/resume`);
      return JSON_CONTENT(data);
    },
  );

  // ---- create_task_from_template ---------------------------------------------
  server.tool(
    "create_task_from_template",
    "Create a runnable task from one of the built-in templates (scheduled_backup, health_check, data_sync, log_cleanup, webhook_ping). Template defaults (trigger, runtime, timeout, retry policy) can be overridden per field; name is always required. Returns the created task — trigger it with trigger_task.",
    {
      template: z
        .string()
        .describe(
          "Template key: scheduled_backup | health_check | data_sync | log_cleanup | webhook_ping",
        ),
      name: z.string().describe("Unique task name for the new task"),
      description: z
        .string()
        .optional()
        .describe("Task description (defaults to the template blurb)"),
      overrides: z
        .record(z.string(), z.unknown())
        .optional()
        .describe(
          "Field overrides applied on top of the template (any CreateTaskDto field, e.g. cronExpression, fixedRate, timeoutSeconds, params, requirements, executorGroup)",
        ),
    },
    async ({ template, name, description, overrides }) => {
      const tpl = TASK_TEMPLATES[template];
      if (!tpl) {
        return JSON_ERROR({
          error: `Unknown template "${template}"`,
          available: Object.keys(TASK_TEMPLATES),
        });
      }
      const body = {
        ...tpl.config,
        ...(description ? { description } : { description: tpl.description }),
        ...(overrides ?? {}),
        name,
      };
      const data = await call<unknown>("POST", "/tasks", body);
      return JSON_CONTENT(data);
    },
  );
}

// ---------------------------------------------------------------------------
// Applications
// ---------------------------------------------------------------------------
export function registerApplicationTools(
  server: McpServer,
  call: ApiCall,
): void {
  // ---- list_applications ----------------------------------------------------
  server.tool(
    "list_applications",
    "List all registered applications in AutoCodeFlow.",
    {},
    async () => {
      const data = await call<unknown>("GET", "/applications");
      return JSON_CONTENT(data);
    },
  );

  // ---- get_application ------------------------------------------------------
  server.tool(
    "get_application",
    "Get full details of a registered application by ID, including version, git repo info, and runtime config.",
    {
      applicationId: UUID_PATH_ID.describe("Application ID"),
    },
    async ({ applicationId }) => {
      const data = await call<unknown>("GET", `/applications/${applicationId}`);
      return JSON_CONTENT(data);
    },
  );

  // ---- create_application ---------------------------------------------------
  server.tool(
    "create_application",
    "Register a new application. Required fields: name (unique, max 100 chars), version (e.g. 1.0.0), runtime (e.g. node/python).",
    {
      name: z.string().max(100).describe("Unique application name"),
      version: z.string().describe("Application version number, e.g. 1.0.0"),
      runtime: z.string().describe("Runtime type, e.g. node or python"),
      description: z
        .string()
        .optional()
        .describe("Application description (max 500 chars)"),
      gitRepo: z.string().optional().describe("Git repository URL"),
      gitBranch: z.string().optional().describe("Git branch"),
      gitCommit: z.string().optional().describe("Git commit SHA"),
      manifest: z
        .record(z.string(), z.unknown())
        .optional()
        .describe("Application manifest object"),
      env: z.record(z.string(), z.string()).optional().describe("Environment variables"),
      entrypoint: z.string().optional().describe("Entry point command"),
      packageUrl: z.string().optional().describe("Package download URL"),
    },
    async (args) => {
      const data = await call<unknown>("POST", "/applications", args);
      return JSON_CONTENT(data);
    },
  );

  // ---- update_application ---------------------------------------------------
  server.tool(
    "update_application",
    "Update an existing application. NOTE: the backend UpdateApplicationDto has no `name` field — renaming is not supported.",
    {
      applicationId: UUID_PATH_ID.describe("Application ID"),
      description: z.string().optional().describe("Application description"),
      version: z.string().optional().describe("Application version number"),
      runtime: z.string().optional().describe("Runtime type"),
      status: z
        .string()
        .optional()
        .describe(
          "Application status: active | deploying | failed (ApplicationStatus enum)",
        ),
      gitRepo: z.string().optional().describe("Git repository URL"),
      gitBranch: z.string().optional().describe("Git branch"),
      gitCommit: z.string().optional().describe("Git commit SHA"),
      manifest: z
        .record(z.string(), z.unknown())
        .optional()
        .describe("Application manifest object"),
      env: z.record(z.string(), z.string()).optional().describe("Environment variables"),
      entrypoint: z.string().optional().describe("Entry point command"),
      packageUrl: z.string().optional().describe("Package download URL"),
      webhookSecret: z
        .string()
        .optional()
        .describe(
          "HMAC-SHA256 webhook secret (empty string disables webhook auth)",
        ),
    },
    async ({ applicationId, ...fields }) => {
      // Drop undefined fields — the global ValidationPipe with
      // forbidNonWhitelisted rejects unknown/extra properties, and explicit
      // undefined keys can serialize differently across transports.
      const body = Object.fromEntries(
        Object.entries(fields).filter(([, v]) => v !== undefined),
      );
      const data = await call<unknown>(
        "PUT",
        `/applications/${applicationId}`,
        body,
      );
      return JSON_CONTENT(data);
    },
  );

  // ---- delete_application ---------------------------------------------------
  server.tool(
    "delete_application",
    "Delete an application by ID.",
    {
      applicationId: UUID_PATH_ID.describe("Application ID"),
    },
    async ({ applicationId }) => {
      const data = await call<unknown>(
        "DELETE",
        `/applications/${applicationId}`,
      );
      return JSON_CONTENT(data);
    },
  );

  // ---- analyze_application --------------------------------------------------
  server.tool(
    "analyze_application",
    "Run AI health analysis on an application. Aggregates recent execution stats across all tasks and returns LLM-generated health assessment and recommendations.",
    {
      applicationId: UUID_PATH_ID.describe("Application ID"),
    },
    async ({ applicationId }) => {
      const data = await call<unknown>(
        "POST",
        `/applications/${applicationId}/analyze`,
        undefined,
        ANALYZE_TIMEOUT_MS,
      );
      return JSON_CONTENT(data);
    },
  );
}

// ---------------------------------------------------------------------------
// Deployments
// ---------------------------------------------------------------------------
export function registerDeploymentTools(
  server: McpServer,
  call: ApiCall,
): void {
  // ---- list_deployments ----------------------------------------------------
  server.tool(
    "list_deployments",
    "List application deployments with optional filtering by application ID and pagination.",
    {
      applicationId: UUID_PATH_ID.optional().describe("Filter by application ID"),
      page: z
        .number()
        .int()
        .min(1)
        .default(1)
        .describe("Page number (default 1)"),
      pageSize: z
        .number()
        .int()
        .min(1)
        .max(100)
        .default(20)
        .describe("Items per page (default 20)"),
    },
    async ({ applicationId, page, pageSize }) => {
      const params = new URLSearchParams({
        page: String(page),
        pageSize: String(pageSize),
        ...(applicationId ? { applicationId } : {}),
      });
      const data = await call<unknown>("GET", `/app-deployments?${params}`);
      return JSON_CONTENT(data);
    },
  );

  // ---- deploy_application --------------------------------------------------
  // DEP-04: applications with approvalRequired=true return a frozen
  // pending_approval row (no dispatch) — the response's approvalStatus field
  // surfaces that; polling/next steps live in the tool description.
  server.tool(
    "deploy_application",
    "Deploy an application to an executor. Leave executorId empty to auto-select the online executor with lowest load. Optionally override run mode, env vars, and start command. NOTE (DEP-04): if the application has deployment approval enabled, the response returns approvalStatus=pending_approval and NOTHING is dispatched — the deployment waits for a second-person approval (POST /app-deployments/:id/approval/approve|reject, or /approval/cancel by the requester). A 409 means the application already has an in-progress deployment.",
    {
      applicationId: UUID_PATH_ID.describe("Application ID"),
      executorId: z
        .string()
        .optional()
        .describe(
          "Target executor ID (optional — auto-selects the lowest-load online executor)",
        ),
      runMode: z
        .string()
        .optional()
        .describe("Run mode: once | daemon | scheduled (default daemon)"),
      env: z
        .record(z.string(), z.string())
        .optional()
        .describe("Environment variable overrides"),
      startCommand: z.string().optional().describe("Startup command override"),
    },
    async ({ applicationId, executorId, runMode, env, startCommand }) => {
      const body = Object.fromEntries(
        Object.entries({ executorId, runMode, env, startCommand }).filter(
          ([, v]) => v !== undefined,
        ),
      );
      const data = await call<Record<string, unknown>>(
        "POST",
        `/app-deployments/applications/${applicationId}/deploy`,
        body,
      );
      // DEP-04: pending_approval rows are frozen (not dispatched) — make that
      // state impossible to miss instead of returning a look-alike 200 payload.
      if (data?.approvalStatus === "pending_approval") {
        return JSON_CONTENT({
          ...data,
          dispatched: false,
          note: "Deployment is frozen pending approval (DEP-04): nothing was dispatched to the executor. A second person must approve POST /app-deployments/" +
            String(data.id ?? ":id") +
            "/approval/approve (or the requester cancels via /approval/cancel).",
        });
      }
      return JSON_CONTENT(data);
    },
  );

  // ---- deploy_app (NF-06) ---------------------------------------------------
  // Thin variant over the same POST /app-deployments/applications/:id/deploy
  // route for users who identify the application by name: resolves
  // name → applicationId via GET /applications first. The backend accepts the
  // appName+version form of the brief only through the application record
  // itself (CreateDeploymentDto carries executorId/runMode/env/startCommand —
  // no appName/version fields, forbidNonWhitelisted would 400 on them).
  server.tool(
    "deploy_app",
    "Deploy an application by NAME (resolved via GET /applications). Shares the deploy_application route and DEP-04 approval semantics: applications with approval enabled return approvalStatus=pending_approval and are not dispatched until a second person approves.",
    {
      appName: z.string().describe("Application name (unique)"),
      executorId: z
        .string()
        .optional()
        .describe(
          "Target executor ID (optional — auto-selects the lowest-load online executor)",
        ),
      runMode: z
        .string()
        .optional()
        .describe("Run mode: once | daemon | scheduled (default daemon)"),
      env: z
        .record(z.string(), z.string())
        .optional()
        .describe("Environment variable overrides"),
      startCommand: z.string().optional().describe("Startup command override"),
    },
    async ({ appName, executorId, runMode, env, startCommand }) => {
      const apps = await call<
        | Array<{ id?: string; name?: string; version?: string }>
        | { list?: Array<{ id?: string; name?: string; version?: string }> }
      >("GET", "/applications");
      const rows = Array.isArray(apps) ? apps : (apps?.list ?? []);
      const app = rows.find((a) => a?.name === appName);
      if (!app?.id) {
        return JSON_ERROR({
          error: `Application "${appName}" not found`,
          available: rows.map((a) => a?.name).filter(Boolean),
        });
      }
      const body = Object.fromEntries(
        Object.entries({ executorId, runMode, env, startCommand }).filter(
          ([, v]) => v !== undefined,
        ),
      );
      const data = await call<Record<string, unknown>>(
        "POST",
        `/app-deployments/applications/${app.id}/deploy`,
        body,
      );
      if (data?.approvalStatus === "pending_approval") {
        return JSON_CONTENT({
          ...data,
          dispatched: false,
          note: "Deployment is frozen pending approval (DEP-04): nothing was dispatched to the executor. A second person must approve POST /app-deployments/" +
            String(data.id ?? ":id") +
            "/approval/approve (or the requester cancels via /approval/cancel).",
        });
      }
      return JSON_CONTENT(data);
    },
  );

  // ---- upgrade_deployment --------------------------------------------------
  server.tool(
    "upgrade_deployment",
    "Trigger an overlay upgrade for a running deployment so it pulls the latest application version.",
    {
      deploymentId: UUID_PATH_ID.describe("Deployment ID to upgrade"),
    },
    async ({ deploymentId }) => {
      const data = await call<unknown>(
        "POST",
        `/app-deployments/${deploymentId}/upgrade`,
      );
      return JSON_CONTENT(data);
    },
  );

  // ---- stop_deployment -----------------------------------------------------
  server.tool(
    "stop_deployment",
    "Stop a running application deployment.",
    {
      deploymentId: UUID_PATH_ID.describe("Deployment ID to stop"),
    },
    async ({ deploymentId }) => {
      const data = await call<unknown>(
        "POST",
        `/app-deployments/${deploymentId}/stop`,
      );
      return JSON_CONTENT(data);
    },
  );

  // ---- DEP-04 approval workflow --------------------------------------------
  // deploy_application/deploy_app can freeze a deployment at
  // approvalStatus=pending_approval (nothing dispatched). These tools close
  // the loop so an MCP user can list the queue and act on a pending row
  // without leaving the agent (second-person rule enforced server-side).

  server.tool(
    "list_pending_approvals",
    "List deployments awaiting approval (DEP-04 queue, ADMIN only). Returns rows with approvalStatus=pending_approval; each row's id feeds approve_deployment / reject_deployment / cancel_deployment.",
    {
      applicationId: UUID_PATH_ID.optional().describe("Filter by application ID"),
      page: z
        .number()
        .int()
        .min(1)
        .default(1)
        .describe("Page number (default 1)"),
      pageSize: z
        .number()
        .int()
        .min(1)
        .max(100)
        .default(20)
        .describe("Items per page (default 20)"),
    },
    async ({ applicationId, page, pageSize }) => {
      const params = new URLSearchParams({
        page: String(page),
        pageSize: String(pageSize),
        ...(applicationId ? { applicationId } : {}),
      });
      const data = await call<unknown>(
        "GET",
        `/app-deployments/approvals/pending?${params}`,
      );
      return JSON_CONTENT(data);
    },
  );

  server.tool(
    "approve_deployment",
    "Approve a pending deployment (DEP-04). Approving dispatches it to the executor. Second-person rule: the approver must differ from the requester, otherwise the API returns an error. ADMIN only.",
    {
      deploymentId: UUID_PATH_ID.describe("Pending deployment ID to approve"),
      reason: z
        .string()
        .max(200)
        .optional()
        .describe("Optional decision reason (≤200 chars), recorded in audit"),
    },
    async ({ deploymentId, reason }) => {
      const body = reason !== undefined ? { reason } : undefined;
      const data = await call<unknown>(
        "POST",
        `/app-deployments/${deploymentId}/approval/approve`,
        body,
      );
      return JSON_CONTENT(data);
    },
  );

  server.tool(
    "reject_deployment",
    "Reject a pending deployment (DEP-04). The deployment is never dispatched. Second-person rule applies; ADMIN only.",
    {
      deploymentId: UUID_PATH_ID.describe("Pending deployment ID to reject"),
      reason: z
        .string()
        .max(200)
        .optional()
        .describe("Optional decision reason (≤200 chars), recorded in audit"),
    },
    async ({ deploymentId, reason }) => {
      const body = reason !== undefined ? { reason } : undefined;
      const data = await call<unknown>(
        "POST",
        `/app-deployments/${deploymentId}/approval/reject`,
        body,
      );
      return JSON_CONTENT(data);
    },
  );

  server.tool(
    "cancel_deployment",
    "Cancel own pending deployment request (DEP-04). Requester-only exit: the user who triggered the deployment may withdraw it before anyone approves.",
    {
      deploymentId: UUID_PATH_ID.describe("Pending deployment ID to cancel"),
    },
    async ({ deploymentId }) => {
      const data = await call<unknown>(
        "POST",
        `/app-deployments/${deploymentId}/approval/cancel`,
      );
      return JSON_CONTENT(data);
    },
  );
}

// ---------------------------------------------------------------------------
// Executors
// ---------------------------------------------------------------------------
export function registerExecutorTools(server: McpServer, call: ApiCall): void {
  // ---- list_executors -------------------------------------------------------
  server.tool(
    "list_executors",
    "List all registered executors and their status (online/offline, last heartbeat, current load).",
    {},
    async () => {
      const data = await call<unknown>("GET", "/executors");
      return JSON_CONTENT(data);
    },
  );

  // ---- get_executor ---------------------------------------------------------
  server.tool(
    "get_executor",
    // U12: the old description promised "performance metrics" but this only
    // hits GET /executors/:id (entity fields: config, status, resource
    // usage, heartbeat-reported running executions). Metrics live on
    // GET /executors/:id/metrics — exposed as get_executor_metrics below.
    "Get detailed info for a single executor by ID: config, status, group/tags, CPU & memory usage, task counters, and the execution ids it reported running on its last heartbeat. Does NOT include 7-day statistics — use get_executor_metrics for those.",
    {
      executorId: UUID_PATH_ID.describe("Executor ID"),
    },
    async ({ executorId }) => {
      const data = await call<unknown>("GET", `/executors/${executorId}`);
      return JSON_CONTENT(data);
    },
  );

  // ---- get_executor_metrics -------------------------------------------------
  server.tool(
    "get_executor_metrics",
    // FEAT-04: 响应还带 history——最近 24h 的 executor_metrics_history 采样,
    // 聚合为 15 分钟 AVG 桶（≤96 个点,升序;每点 {timestamp, cpuUsage,
    // memUsage, runningTaskCount},无上报值的桶 cpu/mem 为 null）。
    "Get performance metrics for a single executor: { executor, sevenDayStats (totalExecutions/successful/failed/successRate/averageDurationMs over the last 7 days), current (runningTaskCount/cpuUsage/memUsage), history (last 24h of resource samples in 15-minute average buckets, <=96 ascending points; empty when no samples) }. Backed by GET /executors/:id/metrics.",
    {
      executorId: UUID_PATH_ID.describe("Executor ID"),
    },
    async ({ executorId }) => {
      const data = await call<unknown>(
        "GET",
        `/executors/${executorId}/metrics`,
      );
      return JSON_CONTENT(data);
    },
  );
}

// ---------------------------------------------------------------------------
// Observability (ECO-03): execution timeline / scheduler health
// ---------------------------------------------------------------------------

/** failureReason → first troubleshooting action (mirrors BUG-10 taxonomy). */
export const FAILURE_RUNBOOK: Record<string, string> = {
  package_fetch_failed:
    "Check package URL / registry availability; verify the private registry token if requirements point at it.",
  dependency_install_failed:
    "Inspect install logs (pip/uv/npm); pin versions and re-run. Offline executors need a reachable index.",
  git_fetch_failed:
    "Check gitRepo URL, branch and credentials; private-network git needs EXECUTOR_ALLOW_PRIVATE_NETWORK on the executor.",
  runtime_missing:
    "The executor lacks the runtime binary (node/python/shell). Install it or dispatch to another executor.",
  sandbox_unavailable:
    "The executor has TASK_SANDBOX=bwrap enabled but the sandbox is unusable (bwrap not installed / user namespaces disabled / enabled on Windows). Install bubblewrap and restart the executor, or unset TASK_SANDBOX. The executor deliberately refuses to run tasks unsandboxed — retrying will not help.",
  script_error:
    "Read the log tail around the first stack frame; run analyze_execution for an AI root cause.",
  timeout:
    "Raise timeoutSeconds, split the workload, or check for blocking I/O; repeated timeouts hint at a hung dependency.",
  executor_offline:
    "Check executor connectivity/registration; see list_dead_letters for callback backlog while it was gone.",
  executor_restart:
    "Transient — the sweep re-enqueued the run. Watch the retry chain; no action if the retry succeeded.",
  stale_recovered:
    "Worker crash or lost worker — the sweep terminated and re-enqueued. Inspect the executor host logs.",
  killed:
    "Manually killed (or block-strategy kill). Verify with the operator / audit log.",
  interpreter_unavailable:
    "The executor could not obtain the Python version the task declares. Verify uv is installed and the Python download source is reachable; 3.7 cannot be downloaded online and needs the operator to pre-provision the interpreter cache volume (or declare 3.8+ and re-trigger). The host interpreter is deliberately NOT used as a fallback — retrying without fixing the environment will not help.",
  unknown: "No reason reported — read the full logs and run analyze_execution.",
};

interface RawExecution {
  id?: string;
  taskId?: string;
  taskName?: string;
  status?: string;
  triggerType?: string;
  retryCount?: number;
  failureReason?: string | null;
  errorMessage?: string | null;
  exitCode?: number | null;
  startTime?: string | null;
  endTime?: string | null;
  createdAt?: string;
  duration?: number | null;
  aiAnalysis?: string | null;
  executorAddress?: string | null;
  [k: string]: unknown;
}

/**
 * Pure mapper: execution row → OBS-04 timeline. Kept exported (no fetch) so
 * the timestamps-vs-DB-consistency contract is unit-testable.
 */
export function buildExecutionTimeline(e: RawExecution): {
  executionId: string;
  taskId?: string;
  taskName?: string;
  status?: string;
  triggerType?: string;
  retryCount?: number;
  timeline: Array<{ at: string | null; phase: string; detail?: string }>;
  duration?: number | null;
  failure?: {
    reason: string;
    suggestion: string;
    errorMessage?: string;
    exitCode?: number | null;
  };
  aiAnalysis?: string;
} {
  const timeline: Array<{ at: string | null; phase: string; detail?: string }> =
    [
      {
        at: e.createdAt ?? null,
        phase: "created",
        detail: `trigger=${e.triggerType ?? "unknown"}`,
      },
      {
        at: e.startTime ?? null,
        phase: "started",
        detail: e.executorAddress ? `executor=${e.executorAddress}` : undefined,
      },
      {
        at: e.endTime ?? null,
        phase: "finished",
        detail: `status=${e.status ?? "unknown"}`,
      },
    ];
  const failure =
    e.status === "failed" || e.status === "timeout"
      ? {
          reason: e.failureReason ?? "unknown",
          suggestion:
            FAILURE_RUNBOOK[e.failureReason ?? ""] ?? FAILURE_RUNBOOK.unknown,
          ...(e.errorMessage ? { errorMessage: e.errorMessage } : {}),
          exitCode: e.exitCode ?? null,
        }
      : undefined;
  return {
    executionId: String(e.id ?? ""),
    taskId: e.taskId,
    taskName: e.taskName,
    status: e.status,
    triggerType: e.triggerType,
    retryCount: e.retryCount,
    timeline,
    duration: e.duration,
    ...(failure ? { failure } : {}),
    ...(e.aiAnalysis ? { aiAnalysis: e.aiAnalysis } : {}),
  };
}

export function registerObservabilityTools(
  server: McpServer,
  call: ApiCall,
): void {
  // ---- get_execution_timeline ----------------------------------------------
  server.tool(
    "get_execution_timeline",
    'OBS-04 timeline for one execution: created → started → finished timestamps plus a failure triage card (reason → suggested first action, from the failureReason taxonomy) and the AI analysis when present. Use it to answer "where did this run stall and why".',
    {
      executionId: UUID_PATH_ID.describe("Execution ID"),
    },
    async ({ executionId }) => {
      const data = await call<unknown>(
        "GET",
        `/tasks/executions/${executionId}`,
      );
      return JSON_CONTENT(buildExecutionTimeline((data ?? {}) as RawExecution));
    },
  );

  // ---- list_dead_letters ----------------------------------------------------
  server.tool(
    "list_dead_letters",
    "Callback dead-letter backlog per executor: each executor reports how many failed callback payloads sit in its local dead-letter directory (replayed with backoff; moved to dead-letter after 5 rounds). A persistently high count means the executor could not reach admin-api for a while — inspect the executor host and replay/inspect its dead-letter files.",
    {},
    async () => {
      const data = await call<
        | { data?: Array<Record<string, unknown>> }
        | Array<Record<string, unknown>>
      >("GET", "/executors");
      const rows = Array.isArray(data) ? data : (data?.data ?? []);
      const summary = rows
        .map((r) => {
          const deadLetterCount = r["deadLetterCount"];
          return {
            executorId: String(r["id"] ?? ""),
            // PK-18: 执行器实体字段是 appName（无 name），旧代码读
            // r["name"] 恒为 undefined——工具输出 name 永远为空。
            name: r["appName"],
            address: r["address"],
            status: r["status"],
            deadLetterCount:
              typeof deadLetterCount === "number" ? deadLetterCount : null,
          };
        })
        .sort((a, b) => (b.deadLetterCount ?? 0) - (a.deadLetterCount ?? 0));
      return JSON_CONTENT({
        totalDeadLetters: summary.reduce(
          (acc, s) => acc + (s.deadLetterCount ?? 0),
          0,
        ),
        executors: summary,
        note: "Counts are executor-side callback payloads awaiting replay (last heartbeat value). Files live in <work_dir>/callbacks/dead-letter on each executor host.",
      });
    },
  );

  // ---- get_scheduler_health -------------------------------------------------
  server.tool(
    "get_scheduler_health",
    "Scheduler health snapshot: leader identity + election state, BullMQ queue depths (waiting/active/delayed/failed — null means Redis unreachable, in which case healthy=false and a degraded note explains why), tick rate, trigger counters and the P99 trigger latency distribution. First stop when triggers stop firing or pile up.",
    {},
    async () => {
      const data = await call<Record<string, unknown>>(
        "GET",
        "/metrics/scheduler",
      );
      const m = (data ?? {}) as Record<string, unknown>;
      const counters = (m.counters ?? {}) as Record<string, unknown>;
      const derived = (m.derived ?? {}) as Record<string, unknown>;
      const queue = (m.queue ?? {}) as Record<string, unknown>;
      // PK-05: 缺数值（null/undefined，即 Redis 不可达）不能默认健康——
      // 显式判 false 并带 degraded 说明；failed<100 才算健康。
      const failedDepth =
        typeof queue.failed === "number" ? queue.failed : null;
      const healthy = failedDepth !== null && failedDepth < 100;
      return JSON_CONTENT({
        healthy,
        ...(failedDepth === null
          ? {
              degraded:
                "queue metrics unavailable (Redis unreachable?) — cannot assess queue depth health",
            }
          : {}),
        leader: m.scheduler ?? null,
        instance: m.instance ?? null,
        queue,
        triggerLatency: {
          count: counters.triggerLatencyCount ?? 0,
          avgMs: derived.avgTriggerLatencyMs ?? 0,
          p99Ms: derived.p99TriggerLatencyMs ?? 0,
          lastMs: counters.lastTriggerLatencyMs ?? 0,
        },
        counters,
        derived,
      });
    },
  );
}

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------
export function registerAuditTools(server: McpServer, call: ApiCall): void {
  // ---- list_audit_logs ------------------------------------------------------
  server.tool(
    "list_audit_logs",
    "Query the audit log with pagination and optional filters. Returns { data, total }. Filters use the backend AuditQueryDto whitelist — any other query field is rejected with 400.",
    {
      page: z
        .number()
        .int()
        .min(1)
        .default(1)
        .describe("Page number (default 1)"),
      pageSize: z
        .number()
        .int()
        .min(1)
        .max(100)
        .default(20)
        .describe("Items per page, max 100 (default 20)"),
      action: z
        .string()
        .optional()
        .describe("Filter by action, fuzzy match (e.g. task.trigger)"),
      resource: z
        .string()
        .optional()
        .describe("Filter by exact resource type (e.g. task)"),
      userId: z
        .number()
        .int()
        .optional()
        .describe("Filter by operator user id"),
      username: z
        .string()
        .optional()
        .describe("Filter by operator username (fuzzy match)"),
      startTime: z
        .string()
        .optional()
        .describe("Only entries created at/after this ISO 8601 time"),
      endTime: z
        .string()
        .optional()
        .describe("Only entries created at/before this ISO 8601 time"),
    },
    async ({
      page,
      pageSize,
      action,
      resource,
      userId,
      username,
      startTime,
      endTime,
    }) => {
      const params = new URLSearchParams({
        page: String(page),
        pageSize: String(pageSize),
        ...(action ? { action } : {}),
        ...(resource ? { resource } : {}),
        ...(userId !== undefined ? { userId: String(userId) } : {}),
        ...(username ? { username } : {}),
        ...(startTime ? { startTime } : {}),
        ...(endTime ? { endTime } : {}),
      });
      const data = await call<unknown>("GET", `/audit?${params}`);
      return JSON_CONTENT(data);
    },
  );
}

// ---------------------------------------------------------------------------
// Projects (AUTH-02-B read-side): list/members/my-roles
// ---------------------------------------------------------------------------

/**
 * AUTH-02-B（R18）：项目域只读工具组。GET /projects 为按主体过滤的读面
 * （ADMIN 全量；普通用户「默认项目 ∪ 成员项目」，每行带 myRole）；成员
 * 读面要求成员身份；成员写面为 ADMIN-only 且不在自动化工具面暴露——
 * 避免自动化链路误改授权（需要时走管理台/REST 显式操作）。
 */
export function registerProjectTools(server: McpServer, call: ApiCall): void {
  // ---- list_projects --------------------------------------------------------
  server.tool(
    "list_projects",
    "List projects visible to the current credential. Admins see all projects; other credentials see the default project plus projects they are a member of. Each row carries myRole (viewer/editor/admin or null) for capability checks before writes.",
    {},
    async () => {
      const data = await call<unknown>("GET", "/projects");
      return JSON_CONTENT(data);
    },
  );

  // ---- get_project_members --------------------------------------------------
  server.tool(
    "get_project_members",
    "List members (userId + role) of one project. Admins can read any project; other credentials only projects they belong to (the default project is always readable).",
    {
      projectId: UUID_PATH_ID.describe("Project ID (UUID); use list_projects to resolve"),
    },
    async ({ projectId }) => {
      const data = await call<unknown>("GET", `/projects/${projectId}/members`);
      return JSON_CONTENT(data);
    },
  );

  // ---- get_my_project_roles -------------------------------------------------
  server.tool(
    "get_my_project_roles",
    "Return the caller's project memberships: { userId, isAdmin, memberships: [{ projectId, role }] }. Use it to plan capability-aware automation (e.g. skip writes on projects where myRole is viewer).",
    {},
    async () => {
      const data = await call<unknown>("GET", "/projects/me/roles");
      return JSON_CONTENT(data);
    },
  );
}

// ---------------------------------------------------------------------------
// SOP / Agent sessions (P5/P6 admin-side minimal loop: browse SOPs, see
// pending assignments + escalations, watch agent sessions, reply to
// clarifications — all over the existing ADMIN-only sop/agent endpoints)
// ---------------------------------------------------------------------------

/** 非终态指派（「待办」口径）；completed/failed/cancelled 为终态不入列。 */
export const SOP_PENDING_STATUSES = [
  "assigned",
  "in_progress",
  "blocked",
  "stalled",
] as const;

export function registerSopTools(server: McpServer, call: ApiCall): void {
  // ---- sop_list -------------------------------------------------------------
  server.tool(
    "sop_list",
    "List SOP definitions (versioned procedure documents: front-matter capabilities/acceptance + markdown body). Returns { items, total }.",
    {
      status: z
        .string()
        .optional()
        .describe("Filter by SOP status (e.g. draft | published)"),
      page: z
        .number()
        .int()
        .min(1)
        .default(1)
        .describe("Page number (default 1)"),
      pageSize: z
        .number()
        .int()
        .min(1)
        .max(100)
        .default(20)
        .describe("Items per page (default 20)"),
    },
    async ({ status, page, pageSize }) => {
      const params = new URLSearchParams({
        page: String(page),
        pageSize: String(pageSize),
        ...(status ? { status } : {}),
      });
      const data = await call<unknown>("GET", `/sop?${params}`);
      return JSON_CONTENT(data);
    },
  );

  // ---- sop_get --------------------------------------------------------------
  server.tool(
    "sop_get",
    "Get one SOP by ID: metadata, current version, front-matter and markdown body. Use sop_list to resolve IDs.",
    {
      sopId: UUID_PATH_ID.describe("SOP ID (UUID)"),
    },
    async ({ sopId }) => {
      const data = await call<unknown>("GET", `/sop/${sopId}`);
      return JSON_CONTENT(data);
    },
  );

  // ---- sop_assignments_pending ----------------------------------------------
  // 两种读形态对齐既有端点：sopId → GET /sop/:id/assignments（客户端按非终态
  // 过滤）；assignmentId → GET /sop/assignments/:id（含澄清对话全量，供
  // sop_clarification_reply 拿 clarificationId）。
  server.tool(
    "sop_assignments_pending",
    "Inspect pending SOP work. Pass sopId to list that SOP's non-terminal assignments (assigned/in_progress/blocked/stalled — completed/failed/cancelled are excluded), or pass assignmentId to fetch one assignment's full detail including its clarification conversation (the clarification ids feed sop_clarification_reply).",
    {
      sopId: UUID_PATH_ID.optional().describe(
        "List non-terminal assignments of this SOP",
      ),
      assignmentId: UUID_PATH_ID.optional().describe(
        "Return this assignment's full detail (includes clarifications)",
      ),
    },
    async ({ sopId, assignmentId }) => {
      if (assignmentId) {
        const data = await call<unknown>(
          "GET",
          `/sop/assignments/${assignmentId}`,
        );
        return JSON_CONTENT(data);
      }
      if (sopId) {
        const rows = await call<Array<{ status?: string }>>(
          "GET",
          `/sop/${sopId}/assignments`,
        );
        const items = (Array.isArray(rows) ? rows : []).filter((r) =>
          (SOP_PENDING_STATUSES as readonly string[]).includes(r?.status ?? ""),
        );
        return JSON_CONTENT({
          sopId,
          pendingCount: items.length,
          items,
          note: "Terminal statuses (completed/failed/cancelled) are filtered out. Pass assignmentId to see one assignment's clarifications.",
        });
      }
      return JSON_ERROR({
        error: "Provide sopId (list pending assignments) or assignmentId (full detail)",
      });
    },
  );

  // ---- agent_session_list ----------------------------------------------------
  // kind/status 取值枚举对齐后端 AGENT_SESSION_KINDS / AGENT_SESSION_STATUSES
  // （此前漏了 sop_review / app_scaffold / chat 与 budget_exceeded——agent 传
  // 后端合法的值会因描述漂移被劝退）。
  server.tool(
    "agent_session_list",
    "List agent sessions (ops_watch / incident / sop_authoring / sop_review / app_scaffold / chat runs) newest first. Sessions in waiting_input are paused waiting on a human decision (approval or SOP clarification) — use agent_session_get for their reasoning steps and tool calls.",
    {
      kind: z
        .string()
        .optional()
        .describe(
          "Filter by kind: ops_watch | incident | sop_authoring | sop_review | app_scaffold | chat",
        ),
      status: z
        .string()
        .optional()
        .describe(
          "Filter by status: pending | running | waiting_input | succeeded | failed | aborted | budget_exceeded",
        ),
      page: z
        .number()
        .int()
        .min(1)
        .default(1)
        .describe("Page number (default 1)"),
      pageSize: z
        .number()
        .int()
        .min(1)
        .max(100)
        .default(20)
        .describe("Items per page (default 20)"),
    },
    async ({ kind, status, page, pageSize }) => {
      const params = new URLSearchParams({
        page: String(page),
        pageSize: String(pageSize),
        ...(kind ? { kind } : {}),
        ...(status ? { status } : {}),
      });
      const data = await call<unknown>("GET", `/agent/sessions?${params}`);
      return JSON_CONTENT(data);
    },
  );

  // ---- agent_session_get ------------------------------------------------------
  server.tool(
    "agent_session_get",
    "Get one agent session with its full reasoning steps, tool calls and child sessions — the audit trail for what the agent did and why.",
    {
      sessionId: UUID_PATH_ID.describe("Agent session ID (UUID)"),
    },
    async ({ sessionId }) => {
      const data = await call<unknown>("GET", `/agent/sessions/${sessionId}`);
      return JSON_CONTENT(data);
    },
  );

  // ---- sop_clarification_reply ------------------------------------------------
  server.tool(
    "sop_clarification_reply",
    "Answer an escalated SOP clarification (human-in-the-loop). resolution=answered replies with text; resolution=sop_amended additionally ships an amended SOP (front-matter YAML / body markdown) that the executor continues against (contentHash rebases on the amended version). Find pending clarifications via sop_assignments_pending with assignmentId.",
    {
      assignmentId: UUID_PATH_ID.describe(
        "SOP assignment that raised the clarification",
      ),
      clarificationId: UUID_PATH_ID.describe("Clarification to answer"),
      resolution: z
        .enum(["answered", "sop_amended"])
        .describe("answered = text reply; sop_amended = reply + amended SOP"),
      answer: z
        .string()
        .max(8000)
        .describe("Reply text shown to the executor (max 8000 chars)"),
      amendedFrontMatterYaml: z
        .string()
        .max(100_000)
        .optional()
        .describe("Amended front-matter YAML (sop_amended only)"),
      amendedBodyMarkdown: z
        .string()
        .max(500_000)
        .optional()
        .describe("Amended markdown body (sop_amended only)"),
      changelog: z
        .string()
        .max(2000)
        .optional()
        .describe("Short amendment changelog (max 2000 chars)"),
    },
    async ({ assignmentId, clarificationId, ...fields }) => {
      // HumanReplyDto 白名单：未提供的修订字段不能带 undefined 键。
      const body = Object.fromEntries(
        Object.entries(fields).filter(([, v]) => v !== undefined),
      );
      const data = await call<unknown>(
        "POST",
        `/sop/assignments/${assignmentId}/clarifications/${clarificationId}/reply`,
        body,
      );
      return JSON_CONTENT(data);
    },
  );
}
