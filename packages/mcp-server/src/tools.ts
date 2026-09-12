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
) => Promise<T>;

const JSON_CONTENT = (data: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
});

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
    "List all tasks defined in AutoCodeFlow. Returns id, name, status, cron, and last execution info.",
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
      taskId: z.string().describe("Task ID"),
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
      taskId: z.string().describe("Task ID to trigger"),
      params: z
        .record(z.unknown())
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
      taskId: z.string().describe("Task ID to update"),
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
        .describe("Runtime type, e.g. node | python | shell"),
      entrypoint: z
        .string()
        .optional()
        .describe("Entry point file path relative to the repo root"),
      timeoutSeconds: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe("Execution timeout in seconds"),
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
        .record(z.unknown())
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
      taskId: z.string().describe("Task ID"),
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
      taskId: z.string().describe("Task ID"),
      versionId: z
        .string()
        .describe("Version ID to roll back to (from list_task_versions)"),
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
      taskId: z.string().describe("Task ID"),
      versionId1: z.string().describe("First version ID"),
      versionId2: z.string().describe("Second version ID"),
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
  server.tool(
    "list_executions",
    "List recent task executions. Optionally filter by taskId and status.",
    {
      taskId: z.string().optional().describe("Filter by task ID"),
      status: z
        .string()
        .optional()
        .describe(
          "Filter by status: pending | running | success | failed | timeout | killed | cancelled",
        ),
      page: z.number().int().min(1).default(1),
      pageSize: z.number().int().min(1).max(50).default(10),
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
  server.tool(
    "get_execution",
    "Get the details and logs of a specific execution by ID. Includes status, duration, output, logs, and AI analysis if available.",
    {
      executionId: z.string().describe("Execution ID"),
    },
    async ({ executionId }) => {
      const data = await call<unknown>(
        "GET",
        `/tasks/executions/${executionId}`,
      );
      return JSON_CONTENT(data);
    },
  );

  // ---- analyze_execution ----------------------------------------------------
  server.tool(
    "analyze_execution",
    "Trigger AI analysis on a failed execution. Returns the AI-generated root cause and fix suggestion.",
    {
      taskId: z.string().describe("Task ID"),
      executionId: z
        .string()
        .describe("Execution ID (must be a failed/timeout execution)"),
    },
    async ({ taskId, executionId }) => {
      const data = await call<unknown>(
        "POST",
        `/tasks/${taskId}/executions/${executionId}/analyze`,
      );
      return JSON_CONTENT(data);
    },
  );

  // ---- get_execution_stats --------------------------------------------------
  server.tool(
    "get_execution_stats",
    "Get execution statistics for a task: success rate, average duration, and last 20 executions.",
    {
      taskId: z.string().describe("Task ID"),
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
      taskId: z.string().describe("Task ID"),
    },
    async ({ taskId }) => {
      const data = await call<unknown>(
        "POST",
        `/tasks/${taskId}/suggest-schedule`,
      );
      return JSON_CONTENT(data);
    },
  );

  // ---- get_execution_logs --------------------------------------------------
  server.tool(
    "get_execution_logs",
    "Fetch paginated execution logs for a given execution ID. Use fromLine + limit to page through large outputs.",
    {
      executionId: z.string().describe("Execution ID"),
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
      taskId: z.string().describe("Task ID that owns the execution"),
      executionId: z.string().describe("Execution ID to cancel"),
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
      taskId: z.string().describe("Task ID that owns the execution"),
      executionId: z
        .string()
        .describe("Execution ID to re-run (from list_executions / get_execution)"),
      params: z
        .record(z.unknown())
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
      taskId: z.string().describe("Task ID to pause"),
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
      taskId: z.string().describe("Task ID to resume"),
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
        .record(z.unknown())
        .optional()
        .describe(
          "Field overrides applied on top of the template (any CreateTaskDto field, e.g. cronExpression, fixedRate, timeoutSeconds, params, requirements, executorGroup)",
        ),
    },
    async ({ template, name, description, overrides }) => {
      const tpl = TASK_TEMPLATES[template];
      if (!tpl) {
        return JSON_CONTENT({
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
      applicationId: z.string().describe("Application ID"),
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
        .record(z.unknown())
        .optional()
        .describe("Application manifest object"),
      env: z.record(z.string()).optional().describe("Environment variables"),
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
      applicationId: z.string().describe("Application ID"),
      description: z.string().optional().describe("Application description"),
      version: z.string().optional().describe("Application version number"),
      runtime: z.string().optional().describe("Runtime type"),
      status: z
        .string()
        .optional()
        .describe("Application status (ApplicationStatus enum value)"),
      gitRepo: z.string().optional().describe("Git repository URL"),
      gitBranch: z.string().optional().describe("Git branch"),
      gitCommit: z.string().optional().describe("Git commit SHA"),
      manifest: z
        .record(z.unknown())
        .optional()
        .describe("Application manifest object"),
      env: z.record(z.string()).optional().describe("Environment variables"),
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
      applicationId: z.string().describe("Application ID"),
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
      applicationId: z.string().describe("Application ID"),
    },
    async ({ applicationId }) => {
      const data = await call<unknown>(
        "POST",
        `/applications/${applicationId}/analyze`,
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
      applicationId: z.string().optional().describe("Filter by application ID"),
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
      applicationId: z.string().describe("Application ID"),
      executorId: z
        .string()
        .optional()
        .describe(
          "Target executor ID (optional — auto-selects the lowest-load online executor)",
        ),
      runMode: z
        .string()
        .optional()
        .describe("Run mode override (see RunMode enum, e.g. daemon)"),
      env: z
        .record(z.string())
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
        .describe("Run mode override (see RunMode enum, e.g. daemon)"),
      env: z
        .record(z.string())
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
        return JSON_CONTENT({
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
      deploymentId: z.string().describe("Deployment ID to upgrade"),
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
      deploymentId: z.string().describe("Deployment ID to stop"),
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
      applicationId: z.string().optional().describe("Filter by application ID"),
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
      deploymentId: z.string().describe("Pending deployment ID to approve"),
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
      deploymentId: z.string().describe("Pending deployment ID to reject"),
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
      deploymentId: z.string().describe("Pending deployment ID to cancel"),
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
      executorId: z.string().describe("Executor ID"),
    },
    async ({ executorId }) => {
      const data = await call<unknown>("GET", `/executors/${executorId}`);
      return JSON_CONTENT(data);
    },
  );

  // ---- get_executor_metrics -------------------------------------------------
  server.tool(
    "get_executor_metrics",
    "Get performance metrics for a single executor: { executor, sevenDayStats (totalExecutions/successful/failed/successRate/averageDurationMs over the last 7 days), current (runningTaskCount/cpuUsage/memUsage) }. Backed by GET /executors/:id/metrics.",
    {
      executorId: z.string().describe("Executor ID"),
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
      executionId: z.string().describe("Execution ID"),
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
            name: r["name"],
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
    "Scheduler health snapshot: leader identity + election state, BullMQ queue depths (waiting/active/delayed/failed — null means Redis unreachable), tick rate, trigger counters and the P99 trigger latency distribution. First stop when triggers stop firing or pile up.",
    {},
    async () => {
      const data = await call<Record<string, unknown>>(
        "GET",
        "/metrics/scheduler",
      );
      const m = (data ?? {}) as Record<string, any>;
      const counters = m.counters ?? {};
      const derived = m.derived ?? {};
      const queue = m.queue ?? {};
      return JSON_CONTENT({
        healthy:
          queue.failed === 0 || typeof queue.failed !== "number"
            ? true
            : queue.failed < 100,
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
